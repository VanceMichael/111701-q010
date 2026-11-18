/**
 * 召回通知与批次范围的解析。
 *
 * 通知可以带多个修订版本；每个版本是一份完整快照（门店处置清单不应
 * 依赖增量拼装）。批次范围支持单个批次、批次列表以及区间写法，
 * 例如 A001-A010、2026-10-01 至 2026-10-15。
 */

const WILDCARD_TERMS = new Set([
  '*',
  'all',
  'any',
  '全部',
  '全部批次',
  '所有',
  '所有批次',
  '不限批次',
  '全批次',
]);

const DATE_RANGE = /^(\d{4}-\d{2}-\d{2})\s*(?:~|～|至|—|–|--|\.\.)\s*(\d{4}-\d{2}-\d{2})$/;
const DATE_HYPHEN_RANGE = /^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/;
const EXPLICIT_RANGE = /^(.+?)\s*(?:~|～|至|—|–|\.\.\.|\.\.)\s*(.+)$/;
const HYPHEN_RANGE = /^([^-]+)-([^-]+)$/;

function prefixWithoutDigits(value) {
  return String(value).replace(/[0-9]/g, '');
}

/**
 * 单短横线既可能是区间（A001-A010），也可能是日期或批号的一部分
 * （2026-10、LOT-2026-01）。只有两侧结构相同、确实在表达“从…到…”时
 * 才按区间处理：字母前缀一致，或两侧同为等长纯数字。
 */
function isPlausibleHyphenRange(left, right) {
  if (!/\d/.test(left) || !/\d/.test(right)) {
    return false;
  }
  const leftPrefix = prefixWithoutDigits(left);
  const rightPrefix = prefixWithoutDigits(right);
  if (leftPrefix && leftPrefix === rightPrefix) {
    return true;
  }
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return left.length === right.length;
  }
  return false;
}

export function normalizeLot(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function naturalParts(value) {
  return String(value).match(/\d+|\D+/g) ?? [];
}

/** 批号自然排序，保证 A2 < A10、2026-10-09 < 2026-10-15。 */
export function compareLots(left, right) {
  const a = naturalParts(left);
  const b = naturalParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const partA = a[index];
    const partB = b[index];
    if (partA === undefined) {
      return -1;
    }
    if (partB === undefined) {
      return 1;
    }
    const numeric = /^\d+$/.test(partA) && /^\d+$/.test(partB);
    if (numeric) {
      const difference = Number(partA) - Number(partB);
      if (difference !== 0) {
        return Math.sign(difference);
      }
    } else {
      const difference = partA.localeCompare(partB, 'zh-Hans-CN', { sensitivity: 'base' });
      if (difference !== 0) {
        return Math.sign(difference);
      }
    }
  }
  return 0;
}

function splitToken(token) {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const dateRange = DATE_RANGE.exec(trimmed) ?? DATE_HYPHEN_RANGE.exec(trimmed);
  if (dateRange) {
    return { start: normalizeLot(dateRange[1]), end: normalizeLot(dateRange[2]) };
  }

  const separators = EXPLICIT_RANGE.exec(trimmed);
  if (separators && separators[1].trim() && separators[2].trim()) {
    return { start: normalizeLot(separators[1]), end: normalizeLot(separators[2]) };
  }

  const hyphen = HYPHEN_RANGE.exec(trimmed);
  if (hyphen && isPlausibleHyphenRange(hyphen[1], hyphen[2])) {
    return { start: normalizeLot(hyphen[1]), end: normalizeLot(hyphen[2]) };
  }

  return null;
}

function pushRange(scope, start, end) {
  const normalizedStart = normalizeLot(start);
  const normalizedEnd = normalizeLot(end);
  if (!normalizedStart || !normalizedEnd) {
    throw new Error(`批次区间缺少端点: ${JSON.stringify([start, end])}`);
  }
  scope.ranges.push(
    compareLots(normalizedStart, normalizedEnd) > 0
      ? { start: normalizedEnd, end: normalizedStart }
      : { start: normalizedStart, end: normalizedEnd },
  );
}

function addToScope(scope, value) {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      addToScope(scope, entry);
    }
    return;
  }
  if (typeof value === 'object') {
    const start = value.from ?? value.start ?? value.begin;
    const end = value.to ?? value.end ?? value.finish;
    if (start !== undefined && end !== undefined) {
      pushRange(scope, start, end);
      return;
    }
    const nested = value.lots ?? value.batches ?? value.codes;
    if (nested !== undefined) {
      addToScope(scope, nested);
      return;
    }
    const single = value.lot ?? value.code ?? value.batch;
    if (single !== undefined) {
      scope.exact.add(normalizeLot(single));
      return;
    }
    throw new TypeError('无法识别的批次范围对象');
  }

  const text = String(value).trim();
  if (!text) {
    return;
  }
  if (WILDCARD_TERMS.has(text.toLowerCase())) {
    scope.unlimited = true;
    return;
  }

  for (const token of text.split(/[,，、;；\n\r]+/)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    if (WILDCARD_TERMS.has(trimmed.toLowerCase())) {
      scope.unlimited = true;
      continue;
    }
    const range = splitToken(trimmed);
    if (range) {
      pushRange(scope, range.start, range.end);
    } else if (looksLikeRange(trimmed)) {
      // 写坏的区间不能退化成“单个批号”，否则 A001~ 会被当成恰好等于 A001，
      // 收窄清单时可能漏掉真正受影响的批次。
      throw new Error(`批次区间无法解析: ${trimmed}`);
    } else {
      scope.exact.add(normalizeLot(trimmed));
    }
  }
}

function looksLikeRange(token) {
  return /[~～至—–]|\.\./.test(token) || /^-|-$/.test(token);
}

/**
 * @returns {{ unlimited: boolean, exact: string[], ranges: {start:string,end:string}[], raw: unknown }}
 * raw 为 null / undefined 时视为“通知未限定批次”，即整批商品；显式空字符串
 * 视为写坏的批次范围，直接报错，不能悄悄当作不限批次。
 */
export function parseBatchScope(raw) {
  const scope = { unlimited: false, exact: new Set(), ranges: [], raw: raw ?? null };
  if (raw === null || raw === undefined) {
    scope.unlimited = true;
  } else if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error('批次范围为空字符串，无法确认召回范围');
  } else {
    addToScope(scope, raw);
  }
  if (!scope.unlimited && scope.exact.size === 0 && scope.ranges.length === 0) {
    throw new Error(`批次范围无法解析: ${JSON.stringify(raw)}`);
  }
  return {
    unlimited: scope.unlimited,
    exact: [...scope.exact].sort(compareLots),
    ranges: scope.ranges.map((range) => ({ ...range })),
    raw: scope.raw,
  };
}

export function batchScopeContains(scope, lot) {
  if (!scope) {
    return false;
  }
  if (scope.unlimited) {
    return true;
  }
  const normalized = normalizeLot(lot);
  if (!normalized) {
    return false;
  }
  if (scope.exact.includes(normalized)) {
    return true;
  }
  return scope.ranges.some(
    (range) => compareLots(normalized, range.start) >= 0 && compareLots(normalized, range.end) <= 0,
  );
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function stringList(values) {
  return unique(
    values.flatMap((value) => (Array.isArray(value) ? value : [value])).map((value) =>
      String(value ?? '').trim(),
    ),
  );
}

export function normalizeNoticeItem(item, index = 0) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('召回通知条目必须是对象');
  }
  const names = stringList([item.name, item.label, item.names, item.aliases]);
  const barcodes = unique(
    [item.barcode, ...(Array.isArray(item.barcodes) ? item.barcodes : [item.barcodes])].map((value) =>
      String(value ?? '')
        .replace(/[^0-9A-Za-z]/g, '')
        .toUpperCase(),
    ),
  );
  const sku = item.sku === null || item.sku === undefined ? null : String(item.sku).trim();
  if (names.length === 0 && !sku && barcodes.length === 0) {
    throw new Error('召回通知条目缺少名称、SKU 或条码');
  }
  const batches = item.batches ?? item.lots ?? item.batch ?? item.lotScope ?? item.lot ?? null;
  return {
    index,
    name: names[0] ?? null,
    names,
    sku,
    barcodes,
    batches,
    scope: parseBatchScope(batches),
  };
}

export function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('召回通知必须是对象');
  }
  const id = String(raw.id ?? '').trim();
  if (!id) {
    throw new Error('召回通知缺少 id');
  }

  // 顶层 items 是“只有一个修订”的简写；带 revisions 时以各修订自身的
  // 完整条目为准。快照里缺 items 的修订直接报错，不能偷偷继承顶层或
  // 上一个修订的条目——那会把范围收窄误读成维持原状。
  const revisionInputs = Array.isArray(raw.revisions) ? raw.revisions : [raw];
  if (revisionInputs.length === 0) {
    throw new Error(`召回通知 ${id} 没有修订版本`);
  }
  if (Array.isArray(raw.revisions) && raw.revisions.length > 1 && raw.items !== undefined) {
    throw new Error(`召回通知 ${id} 同时提供了 revisions 和顶层 items，无法判断条目归属`);
  }

  const revisions = revisionInputs.map((entry, revisionIndex) => {
    const revision = Number(Array.isArray(raw.revisions) ? entry.revision ?? revisionIndex + 1 : raw.revision ?? 1);
    if (!Number.isFinite(revision)) {
      throw new Error(`召回通知 ${id} 的修订号无效`);
    }
    const items = Array.isArray(raw.revisions)
      ? entry.items
      : raw.items ?? entry.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`召回通知 ${id} 的修订 ${revision} 没有条目`);
    }
    return {
      revision,
      publishedAt: entry.publishedAt ?? raw.publishedAt ?? null,
      items: items.map((item, index) => normalizeNoticeItem(item, index)),
    };
  });

  revisions.sort((left, right) => left.revision - right.revision);
  for (let index = 1; index < revisions.length; index += 1) {
    if (revisions[index].revision === revisions[index - 1].revision) {
      throw new Error(`召回通知 ${id} 存在重复修订号 ${revisions[index].revision}`);
    }
  }

  return {
    id,
    title: String(raw.title ?? raw.name ?? id).trim(),
    supplier: raw.supplier ? String(raw.supplier).trim() : null,
    revisions,
  };
}

/** 取指定修订（默认最新）；修订号不存在时抛错，避免静默使用错误版本。 */
export function selectNoticeRevision(notice, revision) {
  const normalized = normalizeNotice(notice);
  if (revision === null || revision === undefined) {
    return { notice: normalized, revision: normalized.revisions.at(-1) };
  }
  const target = Number(revision);
  const found = normalized.revisions.find((entry) => entry.revision === target);
  if (!found) {
    throw new Error(`召回通知 ${normalized.id} 不存在修订 ${revision}`);
  }
  return { notice: normalized, revision: found };
}
