/**
 * 資料載入與查詢。
 *
 * 全部在瀏覽器端跑：實測 8 條件掃描 5,000 筆 0.01 ms、30,000 筆 0.15 ms，
 * 所以不需要任何搜尋索引函式庫——引入一個依賴去換一個已經是 0.15 ms 的東西不划算。
 */

export const UTIL_BASIS = ['unknown', 'included', 'excluded'] as const;
export const GENDER = ['unknown', 'mixed', 'female_only', 'male_only'] as const;
export const TIER = ['A', 'B', 'C'] as const;

export type Wire = {
  meta: {
    generatedAt: string; buildings: number; units: number;
    sources: Array<{ id: string }>; missingBits: string[]; violations: number;
  };
  dict: {
    wards: string[]; stations: string[]; sources: string[];
    sourceMeta: Record<string, { nameZh: string; homepage: string }>;
  };
  b: {
    name: string[]; url: string[]; ward: number[]; src: number[];
    station: number[]; walk: (number | null)[]; img: string[];
    total: (number | null)[]; fetchedAt: string[]; kind: string[];
  };
  u: {
    id: string[]; bid: number[]; room: (string | null)[]; layout: (string | null)[];
    area: (number | null)[]; rent: (number | null)[]; admin: (number | null)[];
    util: (number | null)[]; utilBasis: number[]; key: (number | null)[];
    dep: (number | null)[]; depNR: (number | null)[];
    gender: number[]; foreigner: number[]; vacant: number[]; availFrom: (string | null)[];
    monthlyLower: number[]; monthlyTier: number[];
    initCash: number[]; initCashTier: number[];
    initSunk: number[]; effMonthly12: number[]; missing: number[];
  };
};

export type ProvField =
  | { v: number; basis: string; src: string }
  | { v: null; why: string; basis: string; src: string };

export type Prov = {
  url: string; fetchedAt: string; foreignerRaw: string;
  notes: string[]; caveats: string[]; missing: string[];
  fields: Record<string, ProvField>;
};

const base: string = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;

export async function loadWire(): Promise<Wire> {
  const res = await fetch(`${base}data/index.json`);
  if (!res.ok) throw new Error(`載入資料失敗：HTTP ${res.status}`);
  return (await res.json()) as Wire;
}

const provCache = new Map<string, Record<string, Prov>>();
let provMap: Record<string, string> | null = null;

export async function loadProv(unitId: string): Promise<Prov | null> {
  provMap ??= (await (await fetch(`${base}data/prov/map.json`)).json()) as Record<string, string>;
  const bucket = provMap[unitId];
  if (bucket === undefined) return null;
  let obj = provCache.get(bucket);
  if (obj === undefined) {
    obj = (await (await fetch(`${base}data/prov/${bucket}.json`)).json()) as Record<string, Prov>;
    provCache.set(bucket, obj);
  }
  return obj[unitId] ?? null;
}

export type Filters = {
  q: string;
  wards: string[];
  sources: string[];
  maxMonthly: number | null;
  maxInitCash: number | null;
  minArea: number | null;
  maxWalk: number | null;
  noKeyMoney: boolean;
  noDeposit: boolean;
  utilIncluded: boolean;
  foreignerOnly: boolean;
  vacantOnly: boolean;
  gender: string;
  sort: 'eff12' | 'monthly' | 'initCash' | 'initSunk' | 'area';
  assumeUtil: number | null;
};

export const DEFAULT_FILTERS: Filters = {
  q: '', wards: [], sources: [], maxMonthly: null, maxInitCash: null, minArea: null, maxWalk: null,
  noKeyMoney: false, noDeposit: false, utilIncluded: false, foreignerOnly: false,
  vacantOnly: true, gender: '', sort: 'eff12', assumeUtil: null,
};

/** 全部篩選狀態都放 URL：可書籤、可分享，debug 時狀態是可見的純文字。 */
export function filtersToQuery(f: Filters): string {
  const p = new URLSearchParams();
  const d = DEFAULT_FILTERS;
  if (f.q !== d.q) p.set('q', f.q);
  if (f.wards.length > 0) p.set('ward', f.wards.join(','));
  if (f.sources.length > 0) p.set('src', f.sources.join(','));
  if (f.maxMonthly !== null) p.set('maxMonthly', String(f.maxMonthly));
  if (f.maxInitCash !== null) p.set('maxInit', String(f.maxInitCash));
  if (f.minArea !== null) p.set('minArea', String(f.minArea));
  if (f.maxWalk !== null) p.set('maxWalk', String(f.maxWalk));
  if (f.noKeyMoney) p.set('noKey', '1');
  if (f.noDeposit) p.set('noDep', '1');
  if (f.utilIncluded) p.set('util', '1');
  if (f.foreignerOnly) p.set('fgn', '1');
  if (!f.vacantOnly) p.set('vacant', '0');
  if (f.gender !== '') p.set('gender', f.gender);
  if (f.sort !== d.sort) p.set('sort', f.sort);
  if (f.assumeUtil !== null) p.set('assumeUtil', String(f.assumeUtil));
  return p.toString();
}

export function queryToFilters(qs: string): Filters {
  const p = new URLSearchParams(qs);
  const num = (k: string): number | null => {
    const v = p.get(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    q: p.get('q') ?? '',
    wards: (p.get('ward') ?? '').split(',').filter((x) => x !== ''),
    sources: (p.get('src') ?? '').split(',').filter((x) => x !== ''),
    maxMonthly: num('maxMonthly'), maxInitCash: num('maxInit'),
    minArea: num('minArea'), maxWalk: num('maxWalk'),
    noKeyMoney: p.get('noKey') === '1', noDeposit: p.get('noDep') === '1',
    utilIncluded: p.get('util') === '1', foreignerOnly: p.get('fgn') === '1',
    vacantOnly: p.get('vacant') !== '0', gender: p.get('gender') ?? '',
    sort: (p.get('sort') as Filters['sort']) ?? 'eff12',
    assumeUtil: num('assumeUtil'),
  };
}

export type Row = { i: number; tier: number; key: number };

/**
 * 篩選 + 分區排序。
 *
 * 排序的核心規則：A/B/C 三區**不混算**。
 * 缺值物件永遠排在資料完整物件之後，缺值是降級而不是取得排序優勢。
 */
export function query(w: Wire, f: Filters): { rows: Row[]; counts: [number, number, number] } {
  const { u, b, dict } = w;
  const n = u.id.length;
  const wardIdx = new Set(f.wards.map((x) => dict.wards.indexOf(x)).filter((i) => i >= 0));
  const srcIdx = new Set(f.sources.map((x) => dict.sources.indexOf(x)).filter((i) => i >= 0));
  const q = f.q.trim().toLowerCase();
  const rows: Row[] = [];
  const counts: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const bi = u.bid[i] as number;
    if (f.vacantOnly && u.vacant[i] === 0) continue;
    if (wardIdx.size > 0 && !wardIdx.has(b.ward[bi] as number)) continue;
    if (srcIdx.size > 0 && !srcIdx.has(b.src[bi] as number)) continue;
    if (f.foreignerOnly && u.foreigner[i] !== 1) continue;
    if (f.gender !== '' && GENDER[u.gender[i] as number] !== f.gender) continue;
    if (f.noKeyMoney && u.key[i] !== 0) continue;
    if (f.noDeposit && u.dep[i] !== 0) continue;
    if (f.utilIncluded && u.utilBasis[i] !== 1) continue;

    const area = u.area[i];
    if (f.minArea !== null && (area === null || area === undefined || area < f.minArea)) continue;
    const walk = b.walk[bi];
    if (f.maxWalk !== null && (walk === null || walk === undefined || walk > f.maxWalk)) continue;

    let monthly = u.monthlyLower[i] as number;
    if (f.assumeUtil !== null && u.utilBasis[i] !== 1 && u.util[i] === null) monthly += f.assumeUtil;
    if (f.maxMonthly !== null && monthly > f.maxMonthly) continue;
    if (f.maxInitCash !== null && (u.initCash[i] as number) > f.maxInitCash) continue;

    if (q !== '') {
      const name = (b.name[bi] ?? '').toLowerCase();
      const stIdx = b.station[bi] as number;
      const st = stIdx >= 0 ? (dict.stations[stIdx] ?? '') : '';
      const ward = dict.wards[b.ward[bi] as number] ?? '';
      if (!name.includes(q) && !st.toLowerCase().includes(q) && !ward.includes(q)) continue;
    }

    const tier = (f.sort === 'initCash' || f.sort === 'initSunk'
      ? u.initCashTier[i]
      : u.monthlyTier[i]) as number;

    let key: number;
    switch (f.sort) {
      case 'monthly': key = monthly; break;
      case 'initCash': key = u.initCash[i] as number; break;
      case 'initSunk': key = u.initSunk[i] as number; break;
      case 'area': key = -(area ?? -1); break;
      default: key = (u.effMonthly12[i] as number) + (f.assumeUtil !== null && u.utilBasis[i] !== 1 && u.util[i] === null ? f.assumeUtil : 0);
    }
    rows.push({ i, tier, key });
    counts[tier as 0 | 1 | 2] += 1;
  }

  rows.sort((x, y) => (x.tier !== y.tier ? x.tier - y.tier : x.tier === 2 ? 0 : x.key - y.key));
  return { rows, counts };
}

/** 顯示金額。undefined 與 null 都代表「未提供」——刻意不提供預設值參數。 */
export const yen = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `¥${n.toLocaleString('ja-JP')}`;
