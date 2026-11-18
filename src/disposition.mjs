/**
 * 由召回通知和门店目录生成门店处置清单。
 *
 * 输出按“通知修订 × 门店”组织。每个修订都从该版本的完整条目重新计算，
 * 因此范围扩展/收窄时，处置清单会跟随对应修订：新纳入的批次出现在新修订里，
 * 被移出的批次不会凭旧修订残留。
 *
 * 只有 confirmed（已确认召回）和 uncertain（需人工核对）进入门店行动清单；
 * 商品身份已确认但批次不在范围内的记录单独放在 outOfScope，保留可追溯性，
 * 不会被误当成需要处置的商品。
 *
 * 同时提供纯函数 buildDisposition* 供其他流程复用，CLI 只负责读写文件。
 */

import { normalizeCatalog } from './catalog.mjs';
import { normalizeNotice, selectNoticeRevision } from './notice.mjs';
import { DEFAULT_REVIEW_THRESHOLD, DEFAULT_THRESHOLD, matchNoticeItem } from './matcher.mjs';
import { normalizeText } from './text.mjs';

const ACTION_BUCKETS = ['confirmed', 'uncertain'];

/**
 * 通知条目的稳定标识。用 SKU/条码/归一化名称而不是条目下标，
 * 这样供应商只是调整条目顺序时，差异报告不会把同一件事同时记成新增和移出。
 */
function noticeItemKey(entry) {
  const signal = entry.noticeItem;
  if (signal.sku) {
    return `sku:${signal.sku}`;
  }
  if (signal.barcodes.length > 0) {
    return `barcode:${[...signal.barcodes].sort()[0]}`;
  }
  return `name:${normalizeText(signal.name ?? signal.names[0] ?? '')}`;
}

function sortEntries(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return left.product.id.localeCompare(right.product.id);
}

function makeEntry(result, chosen) {
  return {
    noticeItemIndex: result.itemIndex,
    noticeItem: {
      name: chosen.match.noticeSignal.name,
      names: chosen.match.noticeSignal.names,
      sku: chosen.match.noticeSignal.sku,
      barcodes: chosen.match.noticeSignal.barcodes,
      batches: result.item.scope.raw,
      unlimitedBatches: result.item.scope.unlimited,
    },
    product: {
      id: chosen.product.id,
      name: chosen.product.name,
      sku: chosen.product.sku,
      barcodes: chosen.product.barcodes,
      lots: chosen.product.lots,
    },
    score: chosen.match.score,
    reasons: chosen.match.reasons,
    ambiguous: Boolean(chosen.match.ambiguous),
    requiresManualReview: chosen.match.status !== 'confirmed',
    lotStatus: chosen.match.lotStatus,
    matchedLots: chosen.match.matchedLots,
    otherLots: chosen.match.otherLots,
    noticeSpec: chosen.match.noticeSpec,
    productSpec: chosen.match.productSpec,
  };
}

/**
 * @param {object} notice 单个召回通知（可含 revisions）
 * @param {object} catalog 门店商品目录
 * @param {object} [options]
 * @param {number|null} [options.revision] 指定修订号，默认最新
 * @returns 按门店聚合的处置清单
 */
export function buildDisposition(notice, catalog, options = {}) {
  const { threshold = DEFAULT_THRESHOLD, reviewThreshold = DEFAULT_REVIEW_THRESHOLD } = options;
  const normalizedCatalog = normalizeCatalog(catalog);
  const { notice: normalizedNotice, revision } = selectNoticeRevision(notice, options.revision ?? null);
  const matchOptions = {
    threshold,
    reviewThreshold,
    tieTolerance: options.tieTolerance,
    includeMargin: options.includeMargin,
  };

  const storeById = new Map(normalizedCatalog.stores.map((store) => [store.id, store]));
  const stores = new Map();
  const ensureStore = (store) => {
    if (!stores.has(store.id)) {
      stores.set(store.id, {
        storeId: store.id,
        storeName: store.name,
        confirmed: [],
        uncertain: [],
      });
    }
    return stores.get(store.id);
  };

  const outOfScope = [];
  const results = revision.items.map((item, itemIndex) => ({
    ...matchNoticeItem(item, normalizedCatalog.products, matchOptions),
    itemIndex,
  }));

  for (const result of results) {
    for (const candidate of result.candidates) {
      const entry = makeEntry(result, candidate);
      if (candidate.match.status === 'confirmed') {
        ensureStore(storeById.get(candidate.product.storeId)).confirmed.push(entry);
      } else if (candidate.match.status === 'uncertain') {
        ensureStore(storeById.get(candidate.product.storeId)).uncertain.push(entry);
      } else if (candidate.match.status === 'excluded') {
        outOfScope.push({
          storeId: candidate.product.storeId,
          storeName: storeById.get(candidate.product.storeId)?.name ?? null,
          ...entry,
        });
      }
    }
  }

  const unmatchedItems = results
    .filter((result) => result.candidates.length === 0)
    .map((result) => ({
      noticeItemIndex: result.itemIndex,
      names: result.item.names,
      sku: result.item.sku,
      barcodes: result.item.barcodes,
      batches: result.item.scope.raw,
      nearMisses: result.nearMisses.map((entry) => ({
        storeId: entry.product.storeId,
        productId: entry.product.id,
        productName: entry.product.name,
        status: entry.match.status,
        score: entry.match.score,
        reasons: entry.match.reasons,
      })),
    }));

  return {
    noticeId: normalizedNotice.id,
    noticeTitle: normalizedNotice.title,
    supplier: normalizedNotice.supplier,
    revision: revision.revision,
    publishedAt: revision.publishedAt,
    availableRevisions: normalizedNotice.revisions.map((entry) => entry.revision),
    stores: [...stores.values()]
      .map((store) => ({
        ...store,
        confirmed: store.confirmed.sort(sortEntries),
        uncertain: store.uncertain.sort(sortEntries),
      }))
      .sort((left, right) => left.storeId.localeCompare(right.storeId)),
    outOfScope: outOfScope.sort(
      (left, right) => left.storeId.localeCompare(right.storeId) || left.product.id.localeCompare(right.product.id),
    ),
    unmatchedItems,
  };
}

/**
 * 对比两个修订的门店处置清单。
 *
 * - added：新修订才出现的门店/商品（范围扩展、此前无法确认的商品被确认等）
 * - removed：新修订里已经不需要处置的门店/商品（范围收窄或门店被整体移出）
 * - updated：商品仍在清单里，但处置状态或命中的批次发生变化
 *
 * updated 是“范围扩展后不能遗漏新纳入批次”的关键：门店和商品都没变时，
 * 仅凭 added/removed 会漏掉新增的批次。
 */
export function diffDisposition(earlier, later) {
  const index = (disposition) => {
    const map = new Map();
    for (const store of disposition.stores) {
      for (const status of ACTION_BUCKETS) {
        for (const entry of store[status]) {
          const key = `${store.storeId}:${entry.product.id}:${noticeItemKey(entry)}`;
          map.set(key, {
            storeId: store.storeId,
            storeName: store.storeName,
            productId: entry.product.id,
            noticeItemKey: noticeItemKey(entry),
            noticeItemIndex: entry.noticeItemIndex,
            status,
            entry,
          });
        }
      }
    }
    return map;
  };
  const before = index(earlier);
  const after = index(later);

  const added = [];
  const removed = [];
  const updated = [];
  for (const [key, value] of after) {
    const previous = before.get(key);
    if (!previous) {
      added.push(value);
      continue;
    }
    const lotsChanged = !sameLots(previous.entry.matchedLots, value.entry.matchedLots);
    if (previous.status !== value.status || lotsChanged) {
      updated.push({
        ...value,
        previousStatus: previous.status,
        previousMatchedLots: previous.entry.matchedLots,
        addedLots: value.entry.matchedLots.filter((lot) => !previous.entry.matchedLots.includes(lot)),
        removedLots: previous.entry.matchedLots.filter((lot) => !value.entry.matchedLots.includes(lot)),
      });
    }
  }
  for (const [key, value] of before) {
    if (!after.has(key)) {
      removed.push(value);
    }
  }

  const byStoreThenProduct = (left, right) => {
    const storeOrder = left.storeId.localeCompare(right.storeId);
    if (storeOrder !== 0) {
      return storeOrder;
    }
    const productOrder = left.productId.localeCompare(right.productId);
    if (productOrder !== 0) {
      return productOrder;
    }
    return left.noticeItemIndex - right.noticeItemIndex;
  };

  return {
    fromRevision: earlier.revision,
    toRevision: later.revision,
    added: added.sort(byStoreThenProduct),
    removed: removed.sort(byStoreThenProduct),
    updated: updated.sort(byStoreThenProduct),
    addedLots: updated.flatMap((change) =>
      change.addedLots.map((lot) => ({
        storeId: change.storeId,
        productId: change.productId,
        lot,
        noticeItemIndex: change.noticeItemIndex,
      })),
    ),
  };
}

function sameLots(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((lot, index) => lot === right[index]);
}

/**
 * 按通知列出所有修订及其处置清单，并给出相邻修订之间的差异。
 * 这是“范围扩展或收窄时清单跟随通知版本”的直接依据。
 */
export function buildDispositionHistory(notice, catalog, options = {}) {
  const normalizedNotice = normalizeNotice(notice);
  if (options.revision !== null && options.revision !== undefined) {
    const disposition = buildDisposition(notice, catalog, options);
    return { noticeId: normalizedNotice.id, revisions: [disposition], changes: [] };
  }
  const dispositions = normalizedNotice.revisions.map((entry) =>
    buildDisposition(notice, catalog, { ...options, revision: entry.revision }),
  );
  const changes = dispositions.slice(1).map((later, index) => diffDisposition(dispositions[index], later));
  return { noticeId: normalizedNotice.id, revisions: dispositions, changes };
}

/**
 * 汇总多条通知（默认各自最新修订）的门店处置清单，便于按门店下发。
 * 同一门店的不同通知分开列出，不做跨通知去重，避免掩盖来源。
 */
export function buildDispositionBoard(notices, catalog, options = {}) {
  if (!Array.isArray(notices)) {
    throw new TypeError('notices 必须是数组');
  }
  const dispositions = notices.map((notice) => buildDisposition(notice, catalog, options));
  const byStore = new Map();
  for (const disposition of dispositions) {
    for (const store of disposition.stores) {
      if (!byStore.has(store.storeId)) {
        byStore.set(store.storeId, {
          storeId: store.storeId,
          storeName: store.storeName,
          alerts: [],
          counts: { confirmed: 0, uncertain: 0 },
        });
      }
      const target = byStore.get(store.storeId);
      target.alerts.push({
        noticeId: disposition.noticeId,
        revision: disposition.revision,
        confirmed: store.confirmed,
        uncertain: store.uncertain,
      });
      target.counts.confirmed += store.confirmed.length;
      target.counts.uncertain += store.uncertain.length;
    }
  }
  return {
    dispositions,
    stores: [...byStore.values()].sort((left, right) => left.storeId.localeCompare(right.storeId)),
  };
}
