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
    provBucket: number;
    sources: Array<{ id: string }>; missingBits: string[]; violations: number;
    /** 稀疏屬性位元名 → 位元值（由 build-data 的 FLAG 產生，UI 不另外硬編碼） */
    flagBits: Record<string, number>;
    dedup: {
      suumoWithin: { before: number; after: number; groups: number; removed: number; suspectOnly: number };
      crossSource: { groups: number; removedUnits: number; buildingOnlyCandidates: number };
    };
  };
  dict: {
    wards: string[]; stations: string[]; sources: string[];
    sourceMeta: Record<string, { nameZh: string; homepage: string }>;
    kinds: string[]; layouts: string[]; lines: string[];
    /** [路線索引, 車站索引]，供「選線 → 列站」與路線篩選 */
    pairs: Array<[number, number]>;
  };
  b: {
    name: string[]; url: string[]; ward: number[]; src: number[];
    /** 車站扁平化：stn／stw 連續存所有站，stc 是每棟站數；offset 由前綴和算 */
    stn: number[]; stw: (number | null)[]; stc: number[];
    total: (number | null)[]; fetchedAt: string[]; kind: number[];
    yearBuilt: (number | null)[];
    /** 位元遮罩：同一間房也刊登在哪些來源（位元＝dict.sources 索引） */
    also: number[];
  };
  u: {
    bid: number[]; room: (string | null)[]; layout: number[];
    area: (number | null)[]; floor: (number | null)[];
    rent: (number | null)[]; admin: (number | null)[];
    util: (number | null)[]; utilBasis: number[]; key: (number | null)[];
    dep: (number | null)[]; depNR: (number | null)[];
    gender: number[]; foreigner: number[]; vacant: number[];
    monthlyLower: number[]; monthlyTier: number[];
    initCash: number[]; initCashTier: number[];
    initSunk: number[]; effMonthly12: number[]; missing: number[];
    flags: number[];
    /** 幾家仲介刊登同一間房（SUUMO 去重後的合併數；其他來源恆為 1） */
    ads: number[];
  };
};

export type ProvField =
  | { v: number; basis: string; src: string }
  | { v: null; why: string; basis: string; src: string };

export type Prov = {
  url: string; fetchedAt: string; foreignerRaw: string;
  notes: string[]; caveats: string[]; missing: string[];
  fields: Record<string, ProvField>;
  layoutRaw?: string;
  minStayMonths?: number;
  ageLimitRaw?: string;
  adCount?: number;
  mergedFrom?: Array<{ unitKey: string; url: string }>;
  alsoListed?: Array<{ src: string; url: string }>;
};

/** 延遲讀取：Node 測試環境沒有 import.meta.env，模組載入時就讀會直接炸掉。 */
const base = (): string => (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

export async function loadWire(): Promise<Wire> {
  const res = await fetch(`${base()}data/index.json`);
  if (!res.ok) throw new Error(`載入資料失敗：HTTP ${res.status}`);
  return (await res.json()) as Wire;
}

const provCache = new Map<string, Record<string, Prov>>();

/** 桶位由 unit 序號直算——不需要下載一個數萬鍵的對照表。 */
export async function loadProv(w: Wire, unitIdx: number): Promise<Prov | null> {
  const bucket = `p${Math.floor(unitIdx / w.meta.provBucket)}`;
  let obj = provCache.get(bucket);
  if (obj === undefined) {
    const res = await fetch(`${base()}data/prov/${bucket}.json`);
    if (!res.ok) return null;
    obj = (await res.json()) as Record<string, Prov>;
    provCache.set(bucket, obj);
  }
  return obj[String(unitIdx)] ?? null;
}

// ── 車站扁平陣列的存取 ──────────────────────────────────────────
const offsetCache = new WeakMap<Wire, Int32Array>();

/** 每棟在 stn／stw 裡的起始位置（前綴和），每個 Wire 只算一次。 */
export function stationOffsets(w: Wire): Int32Array {
  let off = offsetCache.get(w);
  if (off === undefined) {
    const n = w.b.stc.length;
    off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = (off[i] as number) + (w.b.stc[i] as number);
    offsetCache.set(w, off);
  }
  return off;
}

export type StationRef = { name: string; walk: number | null };

export function buildingStations(w: Wire, bi: number): StationRef[] {
  const off = stationOffsets(w);
  const out: StationRef[] = [];
  for (let k = off[bi] as number; k < (off[bi + 1] as number); k++) {
    out.push({ name: w.dict.stations[w.b.stn[k] as number] ?? '', walk: w.b.stw[k] ?? null });
  }
  return out;
}

/** 每條路線有幾棟（以「有一站在該線上」計），給路線下拉排序用。 */
export function lineBuildingCounts(w: Wire): number[] {
  const stationLines = new Map<number, number[]>();
  for (const [li, si] of w.dict.pairs) (stationLines.get(si) ?? stationLines.set(si, []).get(si) as number[]).push(li);
  const counts = new Array<number>(w.dict.lines.length).fill(0);
  const off = stationOffsets(w);
  for (let bi = 0; bi < w.b.stc.length; bi++) {
    const seen = new Set<number>();
    for (let k = off[bi] as number; k < (off[bi + 1] as number); k++) {
      for (const li of stationLines.get(w.b.stn[k] as number) ?? []) seen.add(li);
    }
    for (const li of seen) counts[li] = (counts[li] as number) + 1;
  }
  return counts;
}

/** 「我的房子」——出租方要定位的物件。全部都是使用者輸入，永不寫入資料。 */
export type MyProperty = { rent: number | null; area: number | null; layout: string; ward: string };

export type Filters = {
  q: string;
  wards: string[];
  sources: string[];
  /** '' 不限；'apt' 一般賃貸；'share' 共居（sharehouse／social／dormitory） */
  kind: '' | 'apt' | 'share';
  layouts: string[];
  line: string;
  st: string;
  maxMonthly: number | null;
  maxInitCash: number | null;
  minArea: number | null;
  maxArea: number | null;
  maxWalk: number | null;
  minFloor: number | null;
  maxAge: number | null;
  noKeyMoney: boolean;
  noDeposit: boolean;
  utilIncluded: boolean;
  foreignerOnly: boolean;
  vacantOnly: boolean;
  gender: string;
  sort: 'eff12' | 'monthly' | 'initCash' | 'initSunk' | 'area' | 'perM2';
  assumeUtil: number | null;
  my: MyProperty | null;
};

export const DEFAULT_FILTERS: Filters = {
  q: '', wards: [], sources: [], kind: '', layouts: [], line: '', st: '',
  maxMonthly: null, maxInitCash: null, minArea: null, maxArea: null, maxWalk: null,
  minFloor: null, maxAge: null,
  noKeyMoney: false, noDeposit: false, utilIncluded: false, foreignerOnly: false,
  vacantOnly: true, gender: '', sort: 'eff12', assumeUtil: null, my: null,
};

/** 全部篩選狀態都放 URL：可書籤、可分享，debug 時狀態是可見的純文字。 */
export function filtersToQuery(f: Filters): string {
  const p = new URLSearchParams();
  const d = DEFAULT_FILTERS;
  if (f.q !== d.q) p.set('q', f.q);
  if (f.wards.length > 0) p.set('ward', f.wards.join(','));
  if (f.sources.length > 0) p.set('src', f.sources.join(','));
  if (f.kind !== '') p.set('kind', f.kind);
  if (f.layouts.length > 0) p.set('layout', f.layouts.join(','));
  if (f.line !== '') p.set('line', f.line);
  if (f.st !== '') p.set('st', f.st);
  if (f.maxMonthly !== null) p.set('maxMonthly', String(f.maxMonthly));
  if (f.maxInitCash !== null) p.set('maxInit', String(f.maxInitCash));
  if (f.minArea !== null) p.set('minArea', String(f.minArea));
  if (f.maxArea !== null) p.set('maxArea', String(f.maxArea));
  if (f.maxWalk !== null) p.set('maxWalk', String(f.maxWalk));
  if (f.minFloor !== null) p.set('minFloor', String(f.minFloor));
  if (f.maxAge !== null) p.set('maxAge', String(f.maxAge));
  if (f.noKeyMoney) p.set('noKey', '1');
  if (f.noDeposit) p.set('noDep', '1');
  if (f.utilIncluded) p.set('util', '1');
  if (f.foreignerOnly) p.set('fgn', '1');
  if (!f.vacantOnly) p.set('vacant', '0');
  if (f.gender !== '') p.set('gender', f.gender);
  if (f.sort !== d.sort) p.set('sort', f.sort);
  if (f.assumeUtil !== null) p.set('assumeUtil', String(f.assumeUtil));
  if (f.my !== null) {
    p.set('my', [f.my.rent ?? '', f.my.area ?? '', f.my.layout, f.my.ward].join('|'));
  }
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
  const list = (k: string): string[] => (p.get(k) ?? '').split(',').filter((x) => x !== '');
  const kindRaw = p.get('kind');
  const sortRaw = p.get('sort');
  const SORTS: ReadonlyArray<Filters['sort']> = ['eff12', 'monthly', 'initCash', 'initSunk', 'area', 'perM2'];
  let my: MyProperty | null = null;
  const myRaw = p.get('my');
  if (myRaw !== null) {
    const [rent = '', area = '', layout = '', ward = ''] = myRaw.split('|');
    const toNum = (s: string): number | null => (s === '' || !Number.isFinite(Number(s)) ? null : Number(s));
    my = { rent: toNum(rent), area: toNum(area), layout, ward };
  }
  return {
    q: p.get('q') ?? '',
    wards: list('ward'), sources: list('src'),
    kind: kindRaw === 'apt' || kindRaw === 'share' ? kindRaw : '',
    layouts: list('layout'), line: p.get('line') ?? '', st: p.get('st') ?? '',
    maxMonthly: num('maxMonthly'), maxInitCash: num('maxInit'),
    minArea: num('minArea'), maxArea: num('maxArea'), maxWalk: num('maxWalk'),
    minFloor: num('minFloor'), maxAge: num('maxAge'),
    noKeyMoney: p.get('noKey') === '1', noDeposit: p.get('noDep') === '1',
    utilIncluded: p.get('util') === '1', foreignerOnly: p.get('fgn') === '1',
    vacantOnly: p.get('vacant') !== '0', gender: p.get('gender') ?? '',
    sort: SORTS.includes(sortRaw as Filters['sort']) ? (sortRaw as Filters['sort']) : 'eff12',
    assumeUtil: num('assumeUtil'),
    my,
  };
}

export type Row = { i: number; tier: number; key: number };

export type QueryResult = {
  rows: Row[];
  counts: [number, number, number];
  /** 被「種類／屋齡」條件排除、但其實是資料未知而非不符的房間數——UI 必須顯示，否則使用者以為市場上沒有 */
  excluded: { kindUnknown: number; ageUnknown: number; floorUnknown: number };
};

/** 共居＝sharehouse／social／dormitory；一般賃貸＝apartment；unknown 兩邊都不算 */
export function kindGroup(w: Wire, kindIdx: number): 'apt' | 'share' | 'unknown' {
  const k = w.dict.kinds[kindIdx];
  if (k === 'apartment') return 'apt';
  if (k === 'sharehouse' || k === 'social' || k === 'dormitory') return 'share';
  return 'unknown';
}

/** 月額（含使用者的水電假設）。假設只在「水電另計或未知、且原站沒給金額」時才加。 */
export function monthlyWithAssumption(w: Wire, i: number, assumeUtil: number | null): number {
  const { u } = w;
  let m = u.monthlyLower[i] as number;
  if (assumeUtil !== null && u.utilBasis[i] !== 1 && u.util[i] === null) m += assumeUtil;
  return m;
}

/**
 * 篩選 + 分區排序。
 *
 * 排序的核心規則：A/B/C 三區**不混算**。
 * 缺值物件永遠排在資料完整物件之後，缺值是降級而不是取得排序優勢。
 */
export function query(w: Wire, f: Filters, now: Date = new Date()): QueryResult {
  const { u, b, dict } = w;
  const n = u.bid.length;
  const wardIdx = new Set(f.wards.map((x) => dict.wards.indexOf(x)).filter((i) => i >= 0));
  const srcIdx = new Set(f.sources.map((x) => dict.sources.indexOf(x)).filter((i) => i >= 0));
  const layoutIdx = new Set(f.layouts.map((x) => dict.layouts.indexOf(x)).filter((i) => i >= 0));
  const lineIdx = f.line === '' ? -1 : dict.lines.indexOf(f.line);
  const lineStations = new Set<number>();
  if (lineIdx >= 0) for (const [li, si] of dict.pairs) if (li === lineIdx) lineStations.add(si);
  const stIdx = f.st === '' ? -1 : dict.stations.indexOf(f.st);
  const off = stationOffsets(w);
  const thisYear = now.getFullYear();
  const q = f.q.trim().toLowerCase();
  const rows: Row[] = [];
  const counts: [number, number, number] = [0, 0, 0];
  const excluded = { kindUnknown: 0, ageUnknown: 0, floorUnknown: 0 };

  // 棟層條件與房間無關，每棟只算一次
  const bPass = new Map<number, boolean>();
  const buildingPasses = (bi: number): boolean => {
    const cached = bPass.get(bi);
    if (cached !== undefined) return cached;
    let ok = true;
    if (wardIdx.size > 0 && !wardIdx.has(b.ward[bi] as number)) ok = false;
    if (ok && srcIdx.size > 0 && !srcIdx.has(b.src[bi] as number)) ok = false;
    if (ok && f.kind !== '') {
      const kg = kindGroup(w, b.kind[bi] as number);
      if (kg === 'unknown') { ok = false; bPass.set(bi, false); excluded.kindUnknown += -1; /* 以房間數計，下面補 */ return false; }
      if (kg !== f.kind) ok = false;
    }
    if (ok && f.maxAge !== null) {
      const y = b.yearBuilt[bi];
      if (y === null || y === undefined) { bPass.set(bi, false); excluded.ageUnknown += -1; return false; }
      if (thisYear - y > f.maxAge) ok = false;
    }
    if (ok && (lineIdx >= 0 || stIdx >= 0 || f.maxWalk !== null || f.line !== '' || f.st !== '')) {
      // 路線：任一站在該線上；車站：有該站；步行：有 st 時看該站，否則任一站 ≤ N（null 不算命中）
      if (f.line !== '' && lineIdx < 0) ok = false;
      if (f.st !== '' && stIdx < 0) ok = false;
      if (ok) {
        let lineHit = lineIdx < 0;
        let stHit = stIdx < 0;
        let walkHit = f.maxWalk === null;
        for (let k = off[bi] as number; k < (off[bi + 1] as number); k++) {
          const si = b.stn[k] as number;
          const wk = b.stw[k] ?? null;
          if (!lineHit && lineStations.has(si)) lineHit = true;
          if (si === stIdx) {
            stHit = true;
            if (f.maxWalk !== null && wk !== null && wk <= f.maxWalk) walkHit = true;
          } else if (stIdx < 0 && f.maxWalk !== null && wk !== null && wk <= f.maxWalk) {
            walkHit = true;
          }
        }
        ok = lineHit && stHit && walkHit;
      }
    }
    if (ok && q !== '') {
      const name = (b.name[bi] ?? '').toLowerCase();
      const ward = dict.wards[b.ward[bi] as number] ?? '';
      let hit = name.includes(q) || ward.includes(q);
      for (let k = off[bi] as number; !hit && k < (off[bi + 1] as number); k++) {
        if ((dict.stations[b.stn[k] as number] ?? '').toLowerCase().includes(q)) hit = true;
      }
      ok = hit;
    }
    bPass.set(bi, ok);
    return ok;
  };

  // excluded.* 上面先記 −1 做「這棟是因未知被排除」的標記；這裡改成以房間數累計
  const unknownKindB = new Set<number>();
  const unknownAgeB = new Set<number>();

  for (let i = 0; i < n; i++) {
    const bi = u.bid[i] as number;
    if (f.vacantOnly && u.vacant[i] === 0) continue;
    if (!buildingPasses(bi)) {
      if (f.kind !== '' && kindGroup(w, b.kind[bi] as number) === 'unknown') unknownKindB.add(bi);
      else if (f.maxAge !== null && (b.yearBuilt[bi] ?? null) === null) unknownAgeB.add(bi);
      continue;
    }
    if (f.foreignerOnly && u.foreigner[i] !== 1) continue;
    if (f.gender !== '' && GENDER[u.gender[i] as number] !== f.gender) continue;
    if (f.noKeyMoney && u.key[i] !== 0) continue;
    if (f.noDeposit && u.dep[i] !== 0) continue;
    if (f.utilIncluded && u.utilBasis[i] !== 1) continue;
    if (layoutIdx.size > 0 && !layoutIdx.has(u.layout[i] as number)) continue;

    const area = u.area[i];
    if (f.minArea !== null && (area === null || area === undefined || area < f.minArea)) continue;
    // 上限跟下限一樣排除面積未知者：出租方在圈「同量級競品」，
    // 無法確認在區間內的物件混進來只會污染行情。
    if (f.maxArea !== null && (area === null || area === undefined || area > f.maxArea)) continue;
    if (f.minFloor !== null) {
      const fl = u.floor[i];
      if (fl === null || fl === undefined) { excluded.floorUnknown += 1; continue; }
      if (fl < f.minFloor) continue;
    }

    const monthly = monthlyWithAssumption(w, i, f.assumeUtil);
    if (f.maxMonthly !== null && monthly > f.maxMonthly) continue;
    if (f.maxInitCash !== null && (u.initCash[i] as number) > f.maxInitCash) continue;

    let tier = (f.sort === 'initCash' || f.sort === 'initSunk'
      ? u.initCashTier[i]
      : u.monthlyTier[i]) as number;

    let key: number;
    switch (f.sort) {
      case 'monthly': key = monthly; break;
      case 'initCash': key = u.initCash[i] as number; break;
      case 'initSunk': key = u.initSunk[i] as number; break;
      case 'area': key = -(area ?? -1); break;
      case 'perM2':
        // 每㎡單價：比較競品的核心指標——直接比月額會被面積差異騙。
        // 面積未知就算不出單價 → 落入資料不足區，缺值不給排序位置。
        if (area === null || area === undefined || area <= 0) { tier = 2; key = 0; }
        else key = monthly / area;
        break;
      default: key = (u.effMonthly12[i] as number) + (monthly - (u.monthlyLower[i] as number));
    }
    rows.push({ i, tier, key });
    counts[tier as 0 | 1 | 2] += 1;
  }

  // 以房間數回填「因未知被排除」的計數（只算有空房、且其餘棟層條件其實會過的棟——
  // 這裡簡化為該棟全部房間，UI 文案寫「另有 N 間種類未知未計入」已足夠誠實）
  excluded.kindUnknown = 0; excluded.ageUnknown = 0;
  for (let i = 0; i < n; i++) {
    if (f.vacantOnly && u.vacant[i] === 0) continue;
    const bi = u.bid[i] as number;
    if (unknownKindB.has(bi)) excluded.kindUnknown += 1;
    else if (unknownAgeB.has(bi)) excluded.ageUnknown += 1;
  }

  rows.sort((x, y) => (x.tier !== y.tier ? x.tier - y.tier : x.tier === 2 ? 0 : x.key - y.key));
  return { rows, counts, excluded };
}

/** 顯示金額。undefined 與 null 都代表「未提供」——刻意不提供預設值參數。 */
export const yen = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `¥${n.toLocaleString('ja-JP')}`;
