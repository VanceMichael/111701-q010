/**
 * 商品名称归一化与相似度计算。
 *
 * 供应商通知和门店目录往往在大小写、全角/半角、标点、繁体字、
 * 包装规格写法（500ml / 500毫升 / 500mL×24瓶）上不一致，这里把这些
 * 表面差异收敛掉，同时保留可能区分商品的规格（容量、重量）。
 */

// 常用的繁→简一对一映射。只收常见商品名用字，避免引入整本转换表。
const SIMPLIFY_PAIRS = [
  ['樂', '乐'], ['飲', '饮'], ['廠', '厂'], ['鮮', '鲜'], ['濃', '浓'], ['縮', '缩'], ['檸', '柠'],
  ['蘋', '苹'], ['綠', '绿'], ['紅', '红'], ['藍', '蓝'], ['黃', '黄'], ['雞', '鸡'], ['豬', '猪'],
  ['麵', '面'], ['飯', '饭'], ['醬', '酱'], ['鹽', '盐'], ['餅', '饼'], ['乾', '干'], ['凍', '冻'],
  ['衛', '卫'], ['龍', '龙'], ['鳳', '凤'], ['萬', '万'], ['奧', '奥'], ['純', '纯'], ['淨', '净'],
  ['寶', '宝'], ['礦', '矿'], ['麥', '麦'], ['當', '当'], ['勞', '劳'], ['營', '营'], ['養', '养'],
  ['維', '维'], ['質', '质'], ['纖', '纤'], ['絲', '丝'], ['藥', '药'], ['鐵', '铁'], ['鈣', '钙'],
  ['鋅', '锌'], ['發', '发'], ['臺', '台'], ['灣', '湾'], ['農', '农'], ['產', '产'], ['裝', '装'],
  ['優', '优'], ['選', '选'], ['級', '级'], ['東', '东'], ['場', '场'], ['園', '园'], ['葉', '叶'],
  ['蘿', '萝'], ['蔔', '卜'], ['馬', '马'], ['鈴', '铃'], ['堅', '坚'], ['貝', '贝'], ['殼', '壳'],
  ['魚', '鱼'], ['蝦', '虾'], ['壽', '寿'], ['齊', '齐'], ['億', '亿'], ['喬', '乔'], ['賦', '赋'],
  ['豐', '丰'], ['滷', '卤'], ['燻', '熏'], ['醃', '腌'], ['釀', '酿'], ['麴', '曲'], ['蔥', '葱'],
  ['薑', '姜'], ['鹹', '咸'], ['統', '统'], ['師', '师'], ['燒', '烧'], ['魯', '鲁'], ['粵', '粤'],
  ['蘇', '苏'], ['寧', '宁'], ['陝', '陕'], ['貴', '贵'], ['雲', '云'], ['廣', '广'], ['壯', '壮'],
  ['滿', '满'], ['遼', '辽'], ['興', '兴'], ['業', '业'], ['團', '团'], ['購', '购'], ['網', '网'],
  ['線', '线'], ['門', '门'], ['舖', '铺'], ['倉', '仓'], ['貯', '贮'], ['運', '运'], ['輸', '输'],
  ['溫', '温'], ['濕', '湿'], ['蟲', '虫'], ['蠅', '蝇'], ['劑', '剂'], ['標', '标'], ['識', '识'],
  ['編', '编'], ['碼', '码'], ['號', '号'], ['檢', '检'], ['驗', '验'], ['證', '证'], ['報', '报'],
  ['單', '单'], ['據', '据'], ['時', '时'], ['間', '间'], ['週', '周'], ['價', '价'], ['個', '个'],
  ['隻', '只'], ['條', '条'], ['噸', '吨'], ['種', '种'], ['類', '类'], ['測', '测'], ['試', '试'],
  ['糰', '团'], ['餃', '饺'], ['饅', '馒'], ['頭', '头'], ['湯', '汤'], ['圓', '圆'], ['鍋', '锅'],
  ['蓋', '盖'], ['贈', '赠'], ['換', '换'], ['點', '点'], ['剝', '剥'], ['濾', '滤'],
];

const TRADITIONAL_TO_SIMPLIFIED = new Map(SIMPLIFY_PAIRS);

const GENERIC_TERMS = [
  '整箱装',
  '家庭装',
  '分享装',
  '礼盒装',
  '组合装',
  '箱装',
  '瓶装',
  '袋装',
  '盒装',
  '罐装',
  '桶装',
  '听装',
  '包装',
  '风味',
  '口味',
  '饮品',
  '饮料',
  '产品',
  '新品',
  '系列',
  '规格',
  '净含量',
].sort((a, b) => b.length - a.length);

// 规格：容量/重量 + 可选的整箱数量。单位按长度降序，避免“毫升”被“升”截断。
const SPEC_PATTERN =
  /(\d+(?:\.\d+)?)\s*(毫升|ml|升|l|毫克|mg|千克|kg|克|g)(?:\s*(?:[×x*]\s*(\d+))\s*(?:瓶|包|袋|盒|罐|支|听|桶|个|枚)?)?/i;

const UNIT_ALIASES = new Map([
  ['毫升', 'ml'],
  ['ml', 'ml'],
  ['升', 'l'],
  ['l', 'l'],
  ['毫克', 'mg'],
  ['mg', 'mg'],
  ['千克', 'kg'],
  ['kg', 'kg'],
  ['克', 'g'],
  ['g', 'g'],
]);

const VOLUME_UNITS = new Set(['ml', 'l']);
const MASS_UNITS = new Set(['mg', 'g', 'kg']);

function toSimplified(value) {
  let result = '';
  for (const character of value) {
    result += TRADITIONAL_TO_SIMPLIFIED.get(character) ?? character;
  }
  return result;
}

// 目录商品会与每个通知条目反复比较，缓存归一化结果避免重复扫描长名称。
const baseCache = new Map();
const cleanCache = new Map();
const CACHE_LIMIT = 5000;

function cached(cache, key, compute) {
  const cachedValue = cache.get(key);
  if (cachedValue !== undefined) {
    return cachedValue;
  }
  const value = compute(key);
  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

function baseText(value) {
  const text = String(value ?? '');
  return cached(baseCache, text, (input) => toSimplified(input.normalize('NFKC').toLowerCase()));
}

/** 用于精确比较的归一化：统一大小写、字宽、标点、空白和单位写法。 */
export function normalizeText(value) {
  return baseText(value)
    .replace(/毫升/g, 'ml')
    .replace(/[×✕✖]/g, '*')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 用于名称比较的核心词。会去掉规格和“五连包”“整箱装”等包装/营销词，
 * 但保留容量、重量之外的口味、品类等区分信息。
 */
export function cleanProductName(value) {
  const text = String(value ?? '');
  return cached(cleanCache, text, (input) => {
    let cleaned = baseText(input).replace(SPEC_PATTERN, ' ');
    cleaned = cleaned.replace(/[0-9一二三四五六七八九十]+(?:连包|包组合|组合装)/g, ' ');
    for (const term of GENERIC_TERMS) {
      cleaned = cleaned.split(term).join(' ');
    }
    cleaned = cleaned.replace(/[\s\p{P}\p{S}]+/gu, '');
    return cleaned || normalizeText(input);
  });
}

/** 读取名称中的容量/重量规格，用于发现“1L 冒充 500ml”这类冲突。 */
export function extractSpec(value) {
  const match = SPEC_PATTERN.exec(baseText(value));
  if (!match) {
    return null;
  }
  const unit = UNIT_ALIASES.get(match[2]);
  if (!unit) {
    return null;
  }
  const dimension = VOLUME_UNITS.has(unit) ? 'volume' : MASS_UNITS.has(unit) ? 'mass' : 'other';
  return {
    amount: Number(match[1]),
    unit,
    dimension,
    pack: match[3] ? Number(match[3]) : null,
    key: `${dimension}:${Number(match[1])}${unit}`,
  };
}

export function specsConflict(left, right) {
  if (!left || !right || left.dimension !== right.dimension) {
    return false;
  }
  return left.key !== right.key;
}

function characterBigrams(value) {
  const characters = [...value];
  if (characters.length < 2) {
    return characters;
  }
  const grams = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    grams.push(`${characters[index]}${characters[index + 1]}`);
  }
  return grams;
}

function bigramDice(left, right) {
  if (!left || !right) {
    return 0;
  }
  const leftGrams = characterBigrams(left);
  const rightGrams = characterBigrams(right);
  if (leftGrams.length === 0 || rightGrams.length === 0) {
    return left === right ? 1 : 0;
  }
  const counts = new Map();
  for (const gram of leftGrams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of rightGrams) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

/**
 * 0~1 的原始名称相似度。包含关系只在较短名称至少 4 个字符时加分，
 * 避免“牛肉面”这类过于宽泛的词直接命中所有目录商品。
 */
export function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let score = bigramDice(a, b);
  if ([...shorter].length >= 4 && longer.includes(shorter)) {
    const ratio = [...shorter].length / [...longer].length;
    if (ratio >= 0.5) {
      score = Math.max(score, Math.min(0.98, 0.78 + 0.2 * ratio));
    }
  }
  return Math.min(1, score);
}

/**
 * 比较不含规格的核心词。包含关系按核心词长度加权，避免“可乐”命中
 * “可口可乐”这类过短名称；但核心词完全不同的商品不会被算成同一商品。
 */
export function nameSimilarity(left, right) {
  const a = cleanProductName(left);
  const b = cleanProductName(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let score = bigramDice(a, b);
  const length = [...shorter].length;
  if (length >= 3 && longer.includes(shorter)) {
    const ratio = length / [...longer].length;
    score = Math.max(score, Math.min(0.96, 0.72 + 0.2 * ratio));
  }
  // 原始名称可能因为品牌词顺序不同而更长，取两者较大值但不越过 0.95，
  // 只有归一化后完全一致才算 1。
  return Math.max(score, Math.min(similarity(left, right), 0.95));
}
