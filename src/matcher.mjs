/**
 * 召回通知条目与门店商品的匹配。
 *
 * 结论只有三种，模糊匹配永远不会被当成“已确认召回”：
 * - confirmed：条码/SKU 等唯一标识一致，或名称高度一致且规格不冲突，
 *   同时批次能落到具体商品批次（或通知本身就是不限批次）。
 * - uncertain：名称相近但证据不足（规格冲突、批次未知、多个候选并列）。
 * - excluded：商品身份已确认，但本修订的批次范围不含门店记录的批次。
 *
 * 条码/SKU 只说明商品身份，不能替门店证明库存批次在范围内，所以批次未知时
 * 仍然进入 uncertain，由人工核对实物批次。
 *
 * 一个通知条目通常会影响多个门店，因此匹配按目录商品逐条计算，同一门店内
 * 出现多个不同商品并列时才算歧义；跨门店的同名商品属于正常的连锁铺货。
 */

import { extractSpec, nameSimilarity, specsConflict } from './text.mjs';
import { batchScopeContains } from './notice.mjs';

export const DEFAULT_THRESHOLD = 0.86;
export const DEFAULT_REVIEW_THRESHOLD = 0.45;
export const DEFAULT_TIE_TOLERANCE = 0.02;
export const DEFAULT_INCLUDE_MARGIN = 0.15;

const STATUS_PRIORITY = { confirmed: 3, uncertain: 2, excluded: 1, none: 0 };

function normalizeBarcode(value) {
  return String(value ?? '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

function bestNameSimilarity(item, product) {
  let best = { score: 0, noticeName: item.name, catalogName: product.name };
  for (const noticeName of item.names) {
    for (const catalogName of product.names) {
      const score = nameSimilarity(noticeName, catalogName);
      if (score > best.score) {
        best = { score, noticeName, catalogName };
      }
    }
  }
  return best;
}

function lotEvidence(item, product) {
  if (item.scope.unlimited) {
    return { status: 'in-scope', matchedLots: product.lots, otherLots: [] };
  }
  if (!product.lotScopeKnown) {
    return { status: 'unknown', matchedLots: [], otherLots: [] };
  }
  const matchedLots = product.lots.filter((lot) => batchScopeContains(item.scope, lot));
  const otherLots = product.lots.filter((lot) => !batchScopeContains(item.scope, lot));
  return matchedLots.length > 0
    ? { status: 'in-scope', matchedLots, otherLots }
    : { status: 'out-of-scope', matchedLots: [], otherLots };
}

function describeSpec(spec) {
  if (!spec) {
    return '未标注';
  }
  const unit = spec.unit === 'l' ? 'L' : spec.unit;
  return `${spec.amount}${unit}${spec.pack ? `×${spec.pack}` : ''}`;
}

function collectReasons({
  barcodeHit,
  skuHit,
  similarity,
  specConflict,
  identityConflict,
  lots,
  threshold,
  noticeSpec,
  productSpec,
}) {
  const reasons = [];
  if (barcodeHit) {
    reasons.push('条码一致');
  }
  if (skuHit) {
    reasons.push('SKU 一致');
  }
  if (similarity.score === 1) {
    reasons.push('名称归一化后一致');
  } else if (similarity.score > 0) {
    reasons.push(`名称相近（${similarity.score.toFixed(2)}）`);
  }
  if (!barcodeHit && !skuHit && similarity.score < threshold) {
    reasons.push('名称相似度未达确认阈值');
  }
  if (identityConflict) {
    reasons.push('条码或 SKU 不一致');
  }
  if (specConflict) {
    reasons.push(`规格冲突（通知 ${describeSpec(noticeSpec)} / 目录 ${describeSpec(productSpec)}）`);
  }
  if (lots.status === 'unknown') {
    reasons.push('门店未登记批次，需核对实物');
  }
  if (lots.status === 'out-of-scope') {
    reasons.push('门店批次不在本次范围');
  }
  return reasons;
}

/**
 * 单个通知条目对一个门店商品的匹配结果。
 * 只要出现规格冲突或批次无法确认，就不会给出 confirmed。
 */
export function matchItemToProduct(
  item,
  product,
  {
    threshold = DEFAULT_THRESHOLD,
    reviewThreshold = DEFAULT_REVIEW_THRESHOLD,
  } = {},
) {
  const barcodeHit = item.barcodes.some((code) => product.barcodes.includes(normalizeBarcode(code)));
  const skuHit = Boolean(item.sku && product.sku && item.sku === product.sku);
  // 双方都登记了唯一标识却完全不重合，说明很可能是同名不同款（不同包装/
  // 不同供应商），名称再像也不能写成已确认。
  const barcodeConflict = item.barcodes.length > 0 && product.barcodes.length > 0 && !barcodeHit;
  const skuConflict = Boolean(item.sku && product.sku && item.sku !== product.sku);
  const identityConflict = barcodeConflict || skuConflict;
  const similarity = bestNameSimilarity(item, product);
  const noticeSpec = extractSpec(similarity.noticeName ?? item.name ?? '');
  const productSpec = extractSpec(similarity.catalogName ?? product.name ?? '');
  const specConflict = specsConflict(noticeSpec, productSpec);
  const lots = lotEvidence(item, product);
  const identityHit = barcodeHit || skuHit;

  let status = 'none';
  if (identityHit) {
    if (lots.status === 'out-of-scope') {
      status = 'excluded';
    } else if (specConflict || lots.status === 'unknown') {
      status = 'uncertain';
    } else {
      status = 'confirmed';
    }
  } else if (similarity.score >= threshold && !specConflict && !identityConflict) {
    status = lots.status === 'out-of-scope' ? 'excluded' : lots.status === 'unknown' ? 'uncertain' : 'confirmed';
  } else if (similarity.score >= reviewThreshold) {
    status = 'uncertain';
  }

  return {
    status,
    score: similarity.score,
    barcodeHit,
    skuHit,
    identityHit,
    identityConflict,
    specConflict,
    lotStatus: lots.status,
    matchedLots: lots.matchedLots ?? [],
    otherLots: lots.otherLots ?? [],
    noticeSignal: {
      name: similarity.noticeName,
      names: item.names,
      sku: item.sku,
      barcodes: item.barcodes,
      scope: item.scope,
    },
    productSignal: {
      name: similarity.catalogName,
      names: product.names,
      sku: product.sku,
      barcodes: product.barcodes,
      lots: product.lots,
    },
    noticeSpec,
    productSpec,
    reasons: collectReasons({
      barcodeHit,
      skuHit,
      similarity,
      specConflict,
      identityConflict,
      lots,
      threshold,
      noticeSpec,
      productSpec,
    }),
  };
}

function groupByStore(candidates) {
  const groups = new Map();
  for (const entry of candidates) {
    const storeId = entry.product.storeId;
    if (!groups.has(storeId)) {
      groups.set(storeId, []);
    }
    groups.get(storeId).push(entry);
  }
  return groups;
}

/**
 * 同一门店内两个不同商品都达到确认条件、分数又并列时，不能擅自挑一个，
 * 否则清单会把不确定的商品写成已确认。
 */
function downgradeStoreAmbiguity(candidates, tieTolerance) {
  for (const group of groupByStore(candidates).values()) {
    const confirmed = group.filter((entry) => entry.match.status === 'confirmed');
    if (confirmed.length < 2) {
      continue;
    }
    if (confirmed.some((entry) => entry.match.identityHit)) {
      continue;
    }
    const best = Math.max(...confirmed.map((entry) => entry.match.score));
    const leaders = confirmed.filter((entry) => best - entry.match.score <= tieTolerance);
    if (leaders.length < 2) {
      continue;
    }
    for (const entry of leaders) {
      entry.match = {
        ...entry.match,
        status: 'uncertain',
        ambiguous: true,
        reasons: [...entry.match.reasons, '门店内多个候选并列'],
      };
    }
  }
}

function sortCandidates(candidates) {
  candidates.sort((left, right) => {
    const priority = STATUS_PRIORITY[right.match.status] - STATUS_PRIORITY[left.match.status];
    if (priority !== 0) {
      return priority;
    }
    if (right.match.score !== left.match.score) {
      return right.match.score - left.match.score;
    }
    return left.product.key.localeCompare(right.product.key);
  });
}

/**
 * 一个通知条目对应整个目录的所有候选。
 *
 * 返回的 candidates 已包含应进入处置清单的全部商品：
 * - 所有 confirmed / excluded；
 * - 与最高分相差不超过 0.15、且超过人工复核阈值的 uncertain，
 *   这样“通知写 1L、目录只有 500ml”之类的近似商品仍会被提醒。
 * 更远的低分相似商品只作为 nearMisses 供人工复核，不进入清单。
 */
export function matchNoticeItem(item, products, options = {}) {
  const tieTolerance = options.tieTolerance ?? DEFAULT_TIE_TOLERANCE;
  const reviewThreshold = options.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const includeMargin = options.includeMargin ?? DEFAULT_INCLUDE_MARGIN;
  const scored = products
    .map((product) => ({ product, match: matchItemToProduct(item, product, options) }))
    .filter((entry) => entry.match.status !== 'none');

  downgradeStoreAmbiguity(scored, tieTolerance);
  sortCandidates(scored);

  const bestScore = scored.length > 0 ? scored[0].match.score : 0;
  const uncertainFloor = Math.max(reviewThreshold, bestScore - includeMargin);
  const included = scored.filter(
    (entry) => entry.match.status !== 'uncertain' || entry.match.score >= uncertainFloor,
  );
  const includedSet = new Set(included);
  const nearMisses = scored.filter((entry) => !includedSet.has(entry)).slice(0, 3);

  return {
    item,
    candidates: included,
    nearMisses,
    ambiguous: included.some((entry) => entry.match.ambiguous),
  };
}
