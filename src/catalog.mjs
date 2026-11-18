/**
 * 门店商品目录规整。
 *
 * 目录来源可能把门店和商品放在两个数组里，也可能直接挂在门店下。
 * 这里统一成门店 + 商品两份索引，并拒绝缺少身份信息的记录，
 * 避免匹配阶段把无法追溯的商品默默丢掉。
 */

function toArray(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeBarcode(value) {
  return String(value ?? '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

export function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stores)) {
    throw new TypeError('商品目录缺少 stores 数组');
  }

  const stores = new Map();
  const storeOrder = [];
  const addStore = (store) => {
    const id = String(store?.id ?? '').trim();
    if (!id) {
      throw new Error('门店目录存在缺少 id 的记录');
    }
    if (stores.has(id)) {
      return stores.get(id);
    }
    const normalized = {
      id,
      name: String(store.name ?? store.label ?? id).trim(),
      products: [],
    };
    stores.set(id, normalized);
    storeOrder.push(id);
    return normalized;
  };

  const rawProducts = [];
  for (const store of raw.stores) {
    const normalizedStore = addStore(store);
    for (const product of toArray(store.products)) {
      rawProducts.push({ ...product, storeId: product.storeId ?? normalizedStore.id });
    }
  }
  for (const product of toArray(raw.products)) {
    rawProducts.push(product);
  }

  const products = new Map();
  for (const product of rawProducts) {
    if (!product || typeof product !== 'object') {
      throw new Error('商品目录存在非对象商品记录');
    }
    const storeId = String(product.storeId ?? product.store ?? '').trim();
    if (!storeId || !stores.has(storeId)) {
      throw new Error(`商品 ${product.id ?? '(无 id)'} 引用了不存在的门店 ${storeId || '(空)'}`);
    }
    const id = String(product.id ?? product.sku ?? '').trim();
    if (!id) {
      throw new Error(`门店 ${storeId} 存在缺少 id 的商品`);
    }
    const name = String(product.name ?? product.label ?? '').trim();
    if (!name) {
      throw new Error(`门店 ${storeId} 的商品 ${id} 缺少名称`);
    }
    const names = uniqueStrings([name, ...toArray(product.names), ...toArray(product.aliases)]);
    const barcodes = uniqueStrings(
      [product.barcode, ...toArray(product.barcodes)].map(normalizeBarcode),
    );
    const sku = product.sku === null || product.sku === undefined ? null : String(product.sku).trim();
    const lots = uniqueStrings(
      [product.lots, product.batches, product.lotNumbers, product.lot, product.batch].flatMap((value) =>
        toArray(value),
      ),
    );
    const key = `${storeId}:${id}`;
    if (products.has(key)) {
      throw new Error(`商品目录存在重复商品 ${key}`);
    }
    const normalized = {
      key,
      storeId,
      id,
      name,
      names,
      barcodes,
      sku,
      lots,
      lotScopeKnown: lots.length > 0,
    };
    products.set(key, normalized);
    stores.get(storeId).products.push(normalized);
  }

  return { stores: storeOrder.map((id) => stores.get(id)), products: [...products.values()] };
}
