import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, nameSimilarity, extractSpec, specsConflict } from '../src/text.mjs';
import { normalizeNotice, parseBatchScope, batchScopeContains, compareLots, selectNoticeRevision } from '../src/notice.mjs';
import { normalizeCatalog } from '../src/catalog.mjs';
import { matchItemToProduct, matchNoticeItem } from '../src/matcher.mjs';
import { buildDisposition, buildDispositionBoard, buildDispositionHistory, diffDisposition } from '../src/disposition.mjs';

const catalog = {
  stores: [
    {
      id: 'S1',
      name: '一号店',
      products: [
        { id: 'P1', name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', lots: ['A001', 'A002', 'A011'] },
        { id: 'P2', name: '鲜牛奶 500ml', lots: ['2026-10-01', '2026-10-09'] },
        { id: 'P3', name: '鲜牛奶 1L', lots: ['2026-10-20'] },
      ],
    },
    {
      id: 'S2',
      name: '二号店',
      products: [
        { id: 'P4', name: '農夫山泉 飲用天然水 550mL', barcode: '6921168509256', lots: ['A005'] },
        { id: 'P5', name: '统一鲜橙多 450ml', lots: ['B100'] },
      ],
    },
    {
      id: 'S3',
      name: '三号店',
      products: [{ id: 'P6', name: '香辣牛肉面（五连包）', barcode: '6900000000017' }],
    },
  ],
};

function item(overrides) {
  const notice = normalizeNotice({
    id: 'R',
    revisions: [{ revision: 1, items: [overrides] }],
  });
  return notice.revisions[0].items[0];
}

test('名称归一化收敛繁简、全半角、标点和单位写法', () => {
  assert.equal(
    normalizeText('農夫山泉 飲用天然水 550mL'),
    normalizeText('农夫山泉饮用天然水550毫升'),
  );
  assert.equal(normalizeText('统一鲜橙多 450ml'), normalizeText('統一 鮮橙多 450毫升'));
  assert.ok(nameSimilarity('康師傅 紅燒牛肉麵', '康师傅红烧牛肉面') > 0.95);
  assert.ok(nameSimilarity('香辣牛肉面（五连包）', '香辣牛肉面 五连包') > 0.95);
});

test('规格差异会阻止名称匹配直接确认', () => {
  const oneLiter = extractSpec('鲜牛奶 1L');
  const fiveHundred = extractSpec('鲜牛奶 500ml');
  assert.ok(specsConflict(oneLiter, fiveHundred));
  const match = matchItemToProduct(item({ name: '鲜牛奶 1L', batches: '2026-10-01' }), normalizeCatalog(catalog).products.find((p) => p.id === 'P2'));
  assert.equal(match.status, 'uncertain');
  assert.ok(match.reasons.some((reason) => reason.includes('规格冲突')));
});

test('批次范围支持列表、区间与日期', () => {
  const scope = parseBatchScope('A001-A003, A010');
  assert.ok(batchScopeContains(scope, 'A002'));
  assert.ok(batchScopeContains(scope, 'a010'));
  assert.ok(!batchScopeContains(scope, 'A004'));

  const dates = parseBatchScope('2026-10-01 至 2026-10-15');
  assert.ok(batchScopeContains(dates, '2026-10-09'));
  assert.ok(!batchScopeContains(dates, '2026-10-20'));

  const objects = parseBatchScope([{ from: 'B1', to: 'B9' }]);
  assert.ok(batchScopeContains(objects, 'B5'));

  assert.ok(batchScopeContains(parseBatchScope('全部批次'), '任意批次'));
  assert.ok(batchScopeContains(parseBatchScope(null), '任意批次'));
  assert.ok(batchScopeContains(parseBatchScope(undefined), '任意批次'));
  assert.throws(() => parseBatchScope(''));
  assert.throws(() => parseBatchScope('   '));
  assert.throws(() => parseBatchScope([]));
});

test('批号按自然顺序比较，A2 在 A10 之前', () => {
  assert.ok(compareLots('A2', 'A10') < 0);
  assert.ok(compareLots('2026-10-09', '2026-10-15') < 0);
});

test('通知修订必须唯一且可按版本取用', () => {
  const notice = normalizeNotice({
    id: 'R',
    revisions: [
      { revision: 2, items: [{ name: '甲' }] },
      { revision: 1, items: [{ name: '乙' }] },
    ],
  });
  assert.deepEqual(notice.revisions.map((entry) => entry.revision), [1, 2]);
  assert.equal(selectNoticeRevision(notice, 1).revision.items[0].names[0], '乙');
  assert.equal(selectNoticeRevision(notice).revision.revision, 2);
  assert.throws(() => selectNoticeRevision(notice, 9));
  assert.throws(() =>
    normalizeNotice({ id: 'R', revisions: [{ revision: 1, items: [{ name: '甲' }] }, { revision: 1, items: [{ name: '乙' }] }] }),
  );
});

test('修订缺条目时报错，不会继承上一版本的召回范围', () => {
  assert.throws(
    () =>
      normalizeNotice({
        id: 'R',
        revisions: [
          { revision: 1, items: [{ name: '甲', batches: 'A001' }] },
          { revision: 2 },
        ],
      }),
    /修订 2 没有条目/,
  );
  assert.throws(
    () =>
      normalizeNotice({
        id: 'R',
        items: [{ name: '甲' }],
        revisions: [
          { revision: 1, items: [{ name: '甲' }] },
          { revision: 2, items: [{ name: '乙' }] },
        ],
      }),
    /同时提供了 revisions 和顶层 items/,
  );
});

test('商品目录合并门店内嵌商品并拒绝悬空引用', () => {
  const normalized = normalizeCatalog(catalog);
  assert.equal(normalized.products.length, 6);
  assert.throws(() =>
    normalizeCatalog({ stores: [{ id: 'S1' }], products: [{ id: 'X', name: '甲', storeId: 'NOPE' }] }),
  );
});

test('条码一致但门店未登记批次时只能人工核对，不写进已确认', () => {
  const products = normalizeCatalog(catalog).products;
  const p6 = products.find((product) => product.id === 'P6');
  const match = matchItemToProduct(item({ name: '香辣牛肉面', barcode: '6900000000017', batches: 'C001' }), p6);
  assert.equal(match.barcodeHit, true);
  assert.equal(match.status, 'uncertain');
  assert.ok(match.reasons.some((reason) => reason.includes('未登记批次')));
});

test('条码一致且批次在范围内才算已确认', () => {
  const products = normalizeCatalog(catalog).products;
  const p1 = products.find((product) => product.id === 'P1');
  const match = matchItemToProduct(item({ name: '农夫山泉饮用天然水550ml', barcode: '6921168509256', batches: 'A001-A005' }), p1);
  assert.equal(match.status, 'confirmed');
  assert.deepEqual(match.matchedLots, ['A001', 'A002']);
});

test('同一门店内两个相似候选并列时都不算确认', () => {
  const products = normalizeCatalog({
    stores: [
      {
        id: 'S1',
        products: [
          { id: 'X1', name: '红烧牛肉面 五连包', lots: ['L1'] },
          { id: 'X2', name: '红烧牛肉面 桶装', lots: ['L1'] },
        ],
      },
    ],
  }).products;
  const result = matchNoticeItem(item({ name: '红烧牛肉面 五连包 桶装', batches: 'L1' }), products);
  assert.equal(result.candidates.some((entry) => entry.match.status === 'confirmed'), false);
  assert.equal(result.ambiguous, true);
});

test('跨门店同名商品是正常的连锁铺货，可同时确认', () => {
  const products = normalizeCatalog(catalog).products;
  const result = matchNoticeItem(
    item({ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001-A005' }),
    products,
  );
  const confirmedStores = result.candidates
    .filter((entry) => entry.match.status === 'confirmed')
    .map((entry) => entry.product.storeId);
  assert.deepEqual(confirmedStores.sort(), ['S1', 'S2']);
});

test('范围扩展时新纳入的门店与批次出现在新修订清单里', () => {
  const notice = {
    id: 'R1',
    title: '饮用水召回',
    revisions: [
      { revision: 1, publishedAt: '2026-11-01', items: [{ name: '农夫山泉 饮用天然水 550mL', barcode: '6921168509256', batches: 'A001-A003' }] },
      { revision: 2, publishedAt: '2026-11-05', items: [{ name: '农夫山泉 饮用天然水 550mL', barcode: '6921168509256', batches: 'A001-A012' }] },
    ],
  };
  const history = buildDispositionHistory(notice, catalog);
  const [first, second] = history.revisions;
  const s1First = first.stores.find((store) => store.storeId === 'S1');
  const s1Second = second.stores.find((store) => store.storeId === 'S1');
  assert.deepEqual(s1First.confirmed[0].matchedLots, ['A001', 'A002']);
  assert.deepEqual(s1Second.confirmed[0].matchedLots, ['A001', 'A002', 'A011']);

  const diff = history.changes[0];
  assert.equal(diff.fromRevision, 1);
  assert.equal(diff.toRevision, 2);
  const updated = diff.updated.find(
    (change) => change.storeId === 'S1' && change.productId === 'P1',
  );
  assert.ok(updated);
  assert.deepEqual(updated.entry.matchedLots, ['A001', 'A002', 'A011']);
  assert.deepEqual(updated.addedLots, ['A011']);
  assert.deepEqual(diff.addedLots, [
    { storeId: 'S1', productId: 'P1', lot: 'A011', noticeItemIndex: 0 },
  ]);
});

test('范围收窄时旧修订确认过的批次会从新清单移出', () => {
  const notice = {
    id: 'R2',
    revisions: [
      { revision: 1, items: [{ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: ['A001', 'A002', 'A011'] }] },
      { revision: 2, items: [{ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: ['A001', 'A002'] }] },
    ],
  };
  const revisionOne = buildDisposition(notice, catalog, { revision: 1 });
  const revisionTwo = buildDisposition(notice, catalog, { revision: 2 });
  const s1 = revisionTwo.stores.find((store) => store.storeId === 'S1');
  assert.deepEqual(s1.confirmed[0].matchedLots, ['A001', 'A002']);

  const diff = diffDisposition(revisionOne, revisionTwo);
  const updated = diff.updated.find(
    (change) => change.storeId === 'S1' && change.productId === 'P1',
  );
  assert.ok(updated);
  assert.deepEqual(updated.removedLots, ['A011']);
  assert.deepEqual(updated.addedLots, []);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('范围修订把门店整体移出时清单里不再出现该门店', () => {
  const notice = {
    id: 'R3',
    revisions: [
      { revision: 1, items: [{ name: '统一鲜橙多 450ml', batches: ['B100'] }] },
      { revision: 2, items: [{ name: '统一鲜橙多 450ml', batches: ['B200'] }] },
    ],
  };
  const first = buildDisposition(notice, catalog, { revision: 1 });
  const second = buildDisposition(notice, catalog, { revision: 2 });
  const s2First = first.stores.find((store) => store.storeId === 'S2');
  assert.deepEqual(s2First.confirmed.map((entry) => entry.product.id), ['P5']);
  assert.equal(
    second.stores.some((store) => store.storeId === 'S2'),
    false,
    '新修订下门店没有需要处置的商品，不应继续出现在行动清单中',
  );
  assert.deepEqual(
    second.outOfScope.map((entry) => [entry.storeId, entry.product.id]),
    [['S2', 'P5']],
    '移出范围的商品保留在 outOfScope 中，便于追溯为什么不再处置',
  );
  const diff = diffDisposition(first, second);
  assert.deepEqual(diff.removed.map((change) => [change.storeId, change.productId]), [['S2', 'P5']]);
});

test('未匹配上的通知条目不进入门店清单，只保留供人工复核', () => {
  const notice = {
    id: 'R4',
    items: [{ name: '完全不存在的商品名称', sku: 'SKU-404', batches: 'X1' }],
  };
  const disposition = buildDisposition(notice, catalog);
  assert.equal(disposition.stores.length, 0);
  assert.equal(disposition.unmatchedItems.length, 1);
});

test('双方条码不同时，即使名称一致也不能确认', () => {
  const products = normalizeCatalog(catalog).products;
  const match = matchItemToProduct(
    item({ name: '农夫山泉饮用天然水 550ml', barcode: '6900000000099', batches: 'A001' }),
    products.find((product) => product.id === 'P1'),
  );
  assert.equal(match.identityConflict, true);
  assert.equal(match.status, 'uncertain');
  assert.ok(match.reasons.some((reason) => reason.includes('条码或 SKU 不一致')));
});

test('通知不限批次时，已登记批次的门店商品直接全部确认', () => {
  const disposition = buildDisposition(
    { id: 'R10', items: [{ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256' }] },
    catalog,
  );
  const s1 = disposition.stores.find((store) => store.storeId === 'S1');
  const s2 = disposition.stores.find((store) => store.storeId === 'S2');
  assert.deepEqual(s1.confirmed[0].matchedLots, ['A001', 'A002', 'A011']);
  assert.deepEqual(s2.confirmed[0].matchedLots, ['A005']);
  assert.equal(disposition.outOfScope.length, 0);
});

test('写坏的批次区间会报错，不会静默退化成单个批号', () => {
  assert.throws(() => parseBatchScope('A001~'), /批次区间无法解析/);
  assert.throws(() => parseBatchScope('~A009'), /批次区间无法解析/);
  assert.throws(() => parseBatchScope([{ from: 'B9', to: '' }]), /缺少端点/);
  assert.equal(parseBatchScope('A-001').exact.includes('A-001'), true);
  assert.equal(parseBatchScope('LOT-2026-01').exact.includes('LOT-2026-01'), true);
  assert.deepEqual(parseBatchScope('2026-10-01-2026-10-15').ranges, [
    { start: '2026-10-01', end: '2026-10-15' },
  ]);
});

test('通知条目只是调整顺序时，差异报告不会误报新增或移出', () => {
  const notice = {
    id: 'R11',
    revisions: [
      {
        revision: 1,
        items: [
          { name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001' },
          { name: '鲜牛奶 500ml', batches: '2026-10-01' },
        ],
      },
      {
        revision: 2,
        items: [
          { name: '鲜牛奶 500ml', batches: '2026-10-01' },
          { name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001' },
        ],
      },
    ],
  };
  const history = buildDispositionHistory(notice, catalog);
  const diff = history.changes[0];
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.updated, []);
});

test('指定修订的历史视图只输出该版本，不虚构版本间差异', () => {
  const notice = {
    id: 'R12',
    revisions: [
      { revision: 1, items: [{ name: '统一鲜橙多 450ml', batches: 'B100' }] },
      { revision: 2, items: [{ name: '统一鲜橙多 450ml', batches: 'B200' }] },
    ],
  };
  const history = buildDispositionHistory(notice, catalog, { revision: 1 });
  assert.deepEqual(history.revisions.map((entry) => entry.revision), [1]);
  assert.deepEqual(history.changes, []);
  assert.deepEqual(
    history.revisions[0].stores.flatMap((store) => store.confirmed.map((entry) => entry.product.id)),
    ['P5'],
  );
});

test('新修订删掉条目时，相关门店不再需要处置', () => {
  const notice = {
    id: 'R13',
    revisions: [
      {
        revision: 1,
        items: [
          { name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001' },
          { name: '统一鲜橙多 450ml', batches: 'B100' },
        ],
      },
      { revision: 2, items: [{ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001' }] },
    ],
  };
  const history = buildDispositionHistory(notice, catalog);
  const [, second] = history.revisions;
  assert.deepEqual(
    second.stores.flatMap((store) => store.confirmed.map((entry) => entry.product.id)),
    ['P1'],
  );
  assert.deepEqual(
    history.changes[0].removed.map((change) => [change.storeId, change.productId]),
    [['S2', 'P5']],
  );
});

test('多通知汇总按门店列出各自来源，不做跨通知合并', () => {
  const board = buildDispositionBoard(
    [
      { id: 'R5', items: [{ name: '农夫山泉饮用天然水 550ml', barcode: '6921168509256', batches: 'A001' }] },
      { id: 'R6', items: [{ name: '鲜牛奶 500ml', batches: '2026-10-01' }] },
      { id: 'R7', items: [{ name: '统一鲜橙多 450ml', batches: 'B100' }] },
    ],
    catalog,
  );
  const s1 = board.stores.find((store) => store.storeId === 'S1');
  assert.deepEqual(s1.alerts.map((alert) => alert.noticeId).sort(), ['R5', 'R6']);
  assert.equal(s1.counts.confirmed, 2);
  assert.equal(board.dispositions.length, 3);
});

test('不确定结论不会被计入已确认，处置清单明确标注人工复核', () => {
  const exact = buildDisposition(
    {
      id: 'R8',
      items: [{ name: '农夫山泉饮用天然水 550ml', batches: 'A001-A003' }],
    },
    catalog,
  );
  const s1 = exact.stores.find((store) => store.storeId === 'S1');
  assert.equal(s1.confirmed.length, 1);
  assert.equal(s1.uncertain.length, 0);
  assert.equal(
    exact.stores.some((store) => store.storeId === 'S2'),
    false,
    '批次不在范围内的门店不应进入行动清单',
  );
  assert.deepEqual(
    exact.outOfScope.map((entry) => [entry.storeId, entry.product.id, entry.matchedLots]),
    [['S2', 'P4', []]],
  );

  // 有错字、写法不同的通知名称只能进入人工核对，不能写成已确认
  const fuzzy = buildDisposition(
    {
      id: 'R9',
      items: [{ name: '农妇山泉 天燃水 550ml', batches: 'A001-A003' }],
    },
    catalog,
  );
  const fuzzyStore = fuzzy.stores.find((store) => store.storeId === 'S1');
  assert.equal(fuzzyStore.confirmed.length, 0);
  assert.equal(fuzzyStore.uncertain.length, 1);
  assert.equal(fuzzyStore.uncertain[0].requiresManualReview, true);
  assert.ok(fuzzyStore.uncertain[0].reasons.some((reason) => reason.includes('未达确认阈值')));
});
