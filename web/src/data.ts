/**
 * 資料載入與查詢。
 *
 * 全部在瀏覽器端跑：實測 8 條件掃描 5,000 筆 0.01 ms、30,000 筆 0.15 ms，
 * 所以不需要任何搜尋索引函式庫——引入一個依賴去換一個已經是 0.15 ms 的東西不划算。
 */

import { decodeIndex, type EncodedIndex, type ColumnIndex } from '../../packages/wire-codec/src/index.ts';
import { decodeNames, type EncodedNames } from '../../packages/wire-codec/src/names.ts';

export const UTIL_BASIS = ['unknown', 'included', 'excluded'] as const;
export const GENDER = ['unknown', 'mixed', 'female_only', 'male_only'] as const;
export const TIER = ['A', 'B', 'C'] as const;

export type Wire = {
  meta: {
    generatedAt: string;
    /**
     * 這次建置的資料指紋。index.json 與 names.json.gz 以建物序號互相對齊，
     * 這個字串是「兩個檔案來自同一次建置」的唯一證明——見 loadNames()。
     */
    buildId: string;
    buildings: number; units: number;
    provBucket: number;
    /** provenance 桶所在的子目錄（＝buildId）。舊索引要的目錄在新部署裡不存在 → 404。 */
    provDir: string;
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
    kinds: string[]; layouts: string[]; lines: string[]; buildingTypes: string[];
    /** [路線索引, 車站索引]，供「選線 → 列站」與路線篩選 */
    pairs: Array<[number, number]>;
  };
  b: {
    // name／url 不在索引裡：它們佔了 46% 的位元組卻不參與篩選排序，
    // 改由 names.json.gz 依建物序號供應（Names 型別）。
    ward: number[]; src: number[];
    /** 車站扁平化：stn／stw 連續存所有站，stc 是每棟站數；offset 由前綴和算 */
    stn: number[]; stw: (number | null)[]; stc: number[];
    total: (number | null)[]; fetchedAt: string[]; kind: number[];
    yearBuilt: (number | null)[];
    /** 位元遮罩：同一間房也刊登在哪些來源（位元＝dict.sources 索引） */
    also: number[];
    /** 原站標的建物種別索引（-1 = 來源不標或這頁沒寫） */
    btype: number[];
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

/** 下載進度。`total` 在伺服器沒給 content-length 時是 null，此時只有已下載量可報。 */
/** 顯示用字串，以建物序號與索引對齊。 */
export type Names = { name: string[]; url: string[] };

export type LoadProgress = { loaded: number; total: number | null; phase: 'download' | 'parse' };

/**
 * 索引是一個大檔（10 区時 1.5 MB gzip，23 区會到數 MB）。
 * 用 stream 讀而不是 `res.json()`，是為了能報進度——不然使用者在慢網路上
 * 會盯著一片「載入中…」十幾秒，分不出是在下載還是壞掉了。
 */
export async function loadWire(onProgress?: (p: LoadProgress) => void): Promise<Wire> {
  const res = await fetch(`${base()}data/index.json`);
  if (!res.ok) throw new Error(`載入資料失敗：HTTP ${res.status}`);

  // content-length 在 gzip 傳輸時是「壓縮後」的位元組數，而 reader 讀到的是解壓後的——
  // 兩者不同單位，混在一起算百分比會得到 >100%。所以只在沒有 content-encoding 時才用它當分母。
  const encoded = res.headers.get('content-encoding');
  const lenHeader = res.headers.get('content-length');
  const total = encoded === null && lenHeader !== null && Number.isFinite(Number(lenHeader))
    ? Number(lenHeader) : null;

  if (res.body === null || onProgress === undefined) return hydrate(await res.json());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) { chunks.push(value); loaded += value.byteLength; onProgress({ loaded, total, phase: 'download' }); }
  }
  onProgress({ loaded, total, phase: 'parse' });
  // 讓瀏覽器把進度畫出來再進 JSON.parse——parse 是同步的，會把主執行緒鎖住一段時間
  await new Promise((r) => setTimeout(r, 0));
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  return hydrate(JSON.parse(new TextDecoder().decode(buf)));
}

/**
 * 索引是壓縮編碼格式，目前是 `v: 'C3'`（C3 起 name／url 不在索引裡）。
 *
 * 認不得的版本一律**丟例外**，不再像 C2 時代那樣「沒有 v 就原樣回傳」——
 * 拿一個舊格式當新格式用，會得到一個少了兩整欄的索引然後在畫面上到處是空白，
 * 那比直接顯示「請重新整理」更難懂。GitHub Pages 的 10 分鐘快取窗口內
 * 舊 JS 可能拿到新資料檔，這時停下來報錯是正確行為。
 */
function hydrate(parsed: unknown): Wire {
  const o = parsed as { v?: string };
  if (o.v !== 'C3') {
    throw new Error(`資料檔版本是 ${JSON.stringify(o.v ?? '(無)')}，這個版本的網站讀不懂（請重新整理頁面取得新版）`);
  }
  return decodeIndex(parsed as EncodedIndex) as unknown as Wire;
}

/**
 * 建物名與原站 URL。首屏**不等它**——篩選、排序、行情分佈都不需要名字，
 * 索引少載 46% 就能先用起來。
 *
 * ⚠️ 這個檔案以建物序號與索引對齊，錯開一格就是「每張卡片掛上別棟的名字、
 * 前往原站連到別棟」。GitHub Pages 的 `max-age=600` 不可調、檔名又固定，
 * 瀏覽器完全可能一新一舊。兩道防線：
 *   1. 網址帶 `?v=<buildId>`：索引一換，names 的 URL 就跟著換，繞開舊快取。
 *   2. 載回來再比一次 buildId 與筆數，對不上就丟例外——
 *      **寧可沒有名字，也不可以有錯的名字**。
 */
export async function loadNames(w: Wire): Promise<Names> {
  const res = await fetch(`${base()}data/names.json.gz?v=${encodeURIComponent(w.meta.buildId)}`);
  if (!res.ok) throw new Error(`載入建物名稱失敗：HTTP ${res.status}`);
  const enc = await readMaybeGzipped<EncodedNames>(res);
  if (enc.buildId !== w.meta.buildId) {
    throw new Error(`建物名稱檔與索引不是同一次建置（索引 ${w.meta.buildId}／名稱 ${enc.buildId}）——`
      + '若顯示名稱就會張冠李戴，所以停在這裡。請重新整理頁面。');
  }
  const t = decodeNames(enc);
  if (t.name.length !== w.meta.buildings) {
    throw new Error(`建物名稱有 ${t.name.length} 筆，索引有 ${w.meta.buildings} 棟——序號對不上，不顯示名稱`);
  }
  return { name: t.name as string[], url: t.url as string[] };
}

const provCache = new Map<string, Record<string, Prov>>();

/**
 * 桶位由 unit 序號直算——不需要下載一個數萬鍵的對照表。
 *
 * 桶檔是**預先 gzip** 的（未壓縮 507 MB vs 壓縮後 12 MB，部署 artifact 差 42 倍）。
 * GitHub Pages 對 `.json.gz` 送 `content-type: application/gzip` 而**不**加 content-encoding
 * （2026-09-06 實測），所以要自己解。若哪天伺服器改成自動解（帶 content-encoding），
 * 這裡的 header 判斷會走 res.json() 那條，不會雙重解壓炸掉。
 */
export async function loadProv(w: Wire, unitIdx: number): Promise<Prov | null> {
  const bucket = `p${Math.floor(unitIdx / w.meta.provBucket)}`;
  const cacheKey = `${w.meta.provDir}/${bucket}`;
  let obj = provCache.get(cacheKey);
  if (obj === undefined) {
    // 桶在 prov/<buildId>/ 底下。查詢字串只換瀏覽器的快取鍵、換不掉伺服器上的檔案，
    // 所以「分頁停在舊建置、伺服器已換新」時 `?v=舊` 反而一定回源、拿到**新**建置的桶，
    // 費用明細與「前往原站查看」就接到別間房上了。放進路徑之後，舊索引要的目錄
    // 在新部署裡不存在 → 404 → 這裡回 null → 面板顯示載入失敗。錯的資料變成沒有資料。
    const res = await fetch(`${base()}data/prov/${encodeURIComponent(w.meta.provDir)}/${bucket}.json.gz`);
    if (!res.ok) return null;
    try {
      obj = await readMaybeGzipped<Record<string, Prov>>(res);
    } catch {
      // 桶不存在時，靜態主機不一定回 404——有些設定（含 Vite 的 dev server）
      // 會回 200 加一份 HTML。那份 HTML 解不成 JSON，這裡必須收斂成「沒有明細」，
      // 而不是讓 promise 未處理地 reject、把面板卡在「載入中…」。
      return null;
    }
    provCache.set(cacheKey, obj);
  }
  return obj[String(unitIdx)] ?? null;
}

/** 伺服器已經解過（有 content-encoding）就直接讀；否則自己用 DecompressionStream 解。 */
async function readMaybeGzipped<T>(res: Response): Promise<T> {
  const alreadyDecoded = res.headers.get('content-encoding') !== null;
  if (alreadyDecoded || res.body === null || typeof DecompressionStream === 'undefined') {
    if (!alreadyDecoded && typeof DecompressionStream === 'undefined') {
      // 這條路徑現在同時服務費用明細與**建物名稱**，訊息不可以只講其中一個
      throw new Error('這個瀏覽器不支援 DecompressionStream，無法讀取建物名稱與費用明細（需要 Chrome 80+／Safari 16.4+／Firefox 113+）');
    }
    return (await res.json()) as T;
  }
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as T;
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
  buildingTypes: string[];
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
  q: '', wards: [], sources: [], kind: '', layouts: [], buildingTypes: [], line: '', st: '',
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
  if (f.buildingTypes.length > 0) p.set('btype', f.buildingTypes.join(','));
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
    layouts: list('layout'), buildingTypes: list('btype'),
    line: p.get('line') ?? '', st: p.get('st') ?? '',
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
  /**
   * 關鍵字有填、但名稱檔還沒到。
   *
   * 這時**不可以**直接跳過名稱比對——那會回一個「只比了区與車站」的結果集，
   * 筆數與行情數字看起來都很正常，卻少了所有靠物件名命中的房。
   * 使用者無從得知答案是錯的。所以整個結果標成待定，由 UI 說明原因。
   */
  pendingNames: boolean;
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

/**
 * 每㎡單價算不算得出來。
 *
 * 多人房（ドミトリー／棟層 kind=dormitory）的「面積」是整間共用房、「賃料」是一個床位——
 * 兩者不是同一個基準，相除得到的數字沒有意義。2026-08-23 實測 39 間多人房的每㎡單價
 * 中位數 ¥2,788，個室是 ¥7,767；混在一起排序會讓多人房佔滿「單價最低」的前幾頁，
 * 出租方看到的行情會被系統性拉低。與「面積未知就算不出單價」是同一種處置：不算，不是算成 0。
 */
export function perM2Comparable(w: Wire, i: number): boolean {
  const area = w.u.area[i];
  if (area === null || area === undefined || area <= 0) return false;
  const li = w.u.layout[i] as number;
  if (li >= 0 && w.dict.layouts[li] === 'ドミトリー') return false;
  return w.dict.kinds[w.b.kind[w.u.bid[i] as number] as number] !== 'dormitory';
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
export function query(w: Wire, f: Filters, now: Date = new Date(), names: Names | null = null): QueryResult {
  if (f.q.trim() !== '' && names === null) {
    return { pendingNames: true, rows: [], counts: [0, 0, 0], excluded: { kindUnknown: 0, ageUnknown: 0, floorUnknown: 0 } };
  }
  const { u, b, dict } = w;
  const n = u.bid.length;
  // 「有沒有選」與「選到的值在不在字典裡」是兩件事。
  // 舊寫法把不存在的值過濾掉後 set 變空，於是條件被當成「沒選」——篩選器靜默失效，
  // 使用者會看到全部結果卻以為篩過了。書籤存了舊 URL、資料更新後那個值消失就會踩到。
  // 車站篩選器本來就是嚴格的（選了不存在的站回空結果），這裡統一其餘四個。
  const toIdxSet = (vals: readonly string[], d: readonly string[]): Set<number> | null =>
    (vals.length === 0 ? null : new Set(vals.map((x) => d.indexOf(x))));
  const wardIdx = toIdxSet(f.wards, dict.wards);
  const srcIdx = toIdxSet(f.sources, dict.sources);
  const layoutIdx = toIdxSet(f.layouts, dict.layouts);
  const btypeIdx = toIdxSet(f.buildingTypes, dict.buildingTypes);
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
    if (wardIdx !== null && !wardIdx.has(b.ward[bi] as number)) ok = false;
    if (ok && srcIdx !== null && !srcIdx.has(b.src[bi] as number)) ok = false;
    if (ok && f.kind !== '') {
      const kg = kindGroup(w, b.kind[bi] as number);
      if (kg === 'unknown') { ok = false; bPass.set(bi, false); excluded.kindUnknown += -1; /* 以房間數計，下面補 */ return false; }
      if (kg !== f.kind) ok = false;
    }
    if (ok && btypeIdx !== null && !btypeIdx.has(b.btype[bi] as number)) ok = false;
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
      // names === null 時上面已經整個回 pendingNames，走不到這裡
      const name = (names?.name[bi] ?? '').toLowerCase();
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
    if (layoutIdx !== null && !layoutIdx.has(u.layout[i] as number)) continue;

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
        // 算不出單價的（面積未知、或多人房的面積與賃料基準不同）落入資料不足區，
        // 缺值不給排序位置。
        if (!perM2Comparable(w, i)) { tier = 2; key = 0; }
        else key = monthly / (area as number);
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
  return { pendingNames: false, rows, counts, excluded };
}

/** 顯示金額。undefined 與 null 都代表「未提供」——刻意不提供預設值參數。 */
export const yen = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `¥${n.toLocaleString('ja-JP')}`;

/**
 * 樓層顯示。地下樓層在索引裡是負數（B1階 = −1，見 suumo/index.ts 的 parseFloorLabel
 * 與 sakurahouse 的 parseFloor），直接印會變成「-1F」——日本沒有這種寫法，
 * 使用者看到會以為資料壞了。
 */
export function floorLabel(floor: number): string {
  return floor < 0 ? `B${-floor}F` : `${floor}F`;
}
