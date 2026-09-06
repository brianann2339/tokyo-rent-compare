/**
 * 首屏索引的無損壓縮編碼。
 *
 * 為什麼需要它：東京 23 区全量是 175,312 間房，未編碼的欄式索引是 4,073 KB gzip。
 * GitHub Pages 只供 gzip（不供 brotli/zstd），首屏一次載入這麼大會讓站台不能用。
 * 實測這個編碼在 70,531 間的資料上是 1,484.8 → 863.0 KB（−41.9%），
 * 而且解碼後要 `JSON.parse` 的位元組少了一半，**載入端反而更快**
 * （parse+decode 14.6 ms vs 原本 parse 17.7 ms）。
 *
 * ── 最高原則：壓縮不得改變任何一個數字 ──────────────────────────
 * 這個專案禁止虛構數值。一個會靜默截位的編碼器，跟一個會瞎猜的解析器一樣壞——
 * 而且更難發現，因為它產生的錯誤數字看起來完全合理。
 * 所以這裡的每一個編碼函式在遇到「表示不了的值」時都**丟例外**，絕不靜默轉換：
 *   - `tvEnc` 只吃非負整數且 < 2^32；小數、負數、超界一律 throw（原型用 `v>>>0` 會靜默截斷）
 *   - `sparse` 遇到 null 就 throw（`null - pred` 在 JS 是數字，會無聲產生殘差）
 *   - 哨兵值（rent 的 −1、area 的 −1/−2）在編碼時檢查真實資料不會撞上
 * 再加上 build-data 的 encode→decode→全量比對閘門，任何漏網都會變成建置失敗。
 */

/** 索引的結構型別。刻意不 import web 的 `Wire`——那會讓 crawler 依賴 web。 */
export type ColumnIndex = {
  meta: Record<string, unknown>;
  dict: Record<string, unknown>;
  b: Record<string, Array<unknown>>;
  u: Record<string, Array<unknown>>;
};

export type EncodedIndex = {
  v: 'C2';
  meta: Record<string, unknown>;
  dict: Record<string, unknown>;
  nB: number;
  nU: number;
  b: { name: unknown[]; url: unknown[]; fetchedAt: unknown[]; uc: string };
  u: { room: unknown[]; bid?: number[] };
  enc: Record<string, DictBlock>;
  rent: DictBlock;
  area: { d: string; i: number[]; v: number[] };
  key: RatioBlock;
  dep: RatioBlock;
  resid: Record<string, ResidBlock>;
};

type DictBlock = { d: unknown[]; c: string };
type RatioBlock = { c: DictBlock; i: string; v: number[] };
type ResidBlock = { n: number; i: string; v: string };

const A64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const DEC = new Uint8Array(128);
for (let i = 0; i < 64; i++) DEC[A64.charCodeAt(i)] = i;

/** 5 bit/字元的 varint，續接位在第 6 bit。只接受 [0, 2^32) 的整數。 */
export function tvEnc(arr: readonly number[]): string {
  const parts: string[] = [];
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i] as number;
    // 靜默截位是這個專案最不能忍的錯誤類型：寧可讓建置炸掉
    if (!Number.isInteger(v) || v < 0 || v >= 4294967296) {
      throw new Error(`[wire-codec] tvEnc 第 ${i} 項是 ${v}，不是 [0, 2^32) 的整數——編碼會失真，拒絕編碼`);
    }
    do {
      const c = v % 32;
      v = (v - c) / 32;
      s += A64[v !== 0 ? (c | 32) : c] as string;
    } while (v !== 0);
    if (s.length > 8192) { parts.push(s); s = ''; }
  }
  parts.push(s);
  return parts.join('');
}

export function tvDec(s: string, n: number): number[] {
  const out = new Array<number>(n);
  let i = 0;
  for (let k = 0; k < n; k++) {
    let c = DEC[s.charCodeAt(i++)] as number;
    let v = c & 31;
    if ((c & 32) !== 0) {
      let m = 32;
      do {
        c = DEC[s.charCodeAt(i++)] as number;
        v += (c & 31) * m;
        m *= 32;
      } while ((c & 32) !== 0);
    }
    out[k] = v;
  }
  return out;
}

/** zigzag：把有號數映到非負數，小的負數也只佔一個字元。 */
export const zig = (v: number): number => {
  if (!Number.isInteger(v)) throw new Error(`[wire-codec] zig 只吃整數，收到 ${v}`);
  return v < 0 ? -v * 2 - 1 : v * 2;
};
export const unzig = (v: number): number => ((v & 1) !== 0 ? -((v + 1) / 2) : v / 2);

/** 頻率字典：出現最多的值拿最短的碼。值本身原樣存在 `d` 裡，所以任何型別都無損。 */
export function dictEnc(arr: readonly unknown[]): DictBlock {
  const m = new Map<unknown, number>();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  const d = [...m.keys()].sort((a, b) => (m.get(b) as number) - (m.get(a) as number));
  const ix = new Map<unknown, number>();
  for (let i = 0; i < d.length; i++) ix.set(d[i], i);
  const codes = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) codes[i] = ix.get(arr[i]) as number;
  return { d, c: tvEnc(codes) };
}

export function dictDec(o: DictBlock, n: number): unknown[] {
  const { c: s, d } = o;
  const out = new Array<unknown>(n);
  let i = 0;
  for (let k = 0; k < n; k++) {
    let ch = DEC[s.charCodeAt(i++)] as number;
    let v = ch & 31;
    if ((ch & 32) !== 0) {
      let m = 32;
      do {
        ch = DEC[s.charCodeAt(i++)] as number;
        v += (ch & 31) * m;
        m *= 32;
      } while ((ch & 32) !== 0);
    }
    out[k] = d[v];
  }
  return out;
}

/** 這些欄位走頻率字典（值域小、重複度高）。 */
const DICT_B = ['ward', 'src', 'kind', 'also', 'stc', 'total', 'yearBuilt', 'stn', 'stw'] as const;
const DICT_U = ['layout', 'floor', 'admin', 'util', 'utilBasis', 'depNR', 'gender', 'foreigner',
  'vacant', 'monthlyTier', 'initCashTier', 'missing', 'flags', 'ads'] as const;
/** 原樣保留（字串為主，gzip 自己處理得很好）。 */
const RAW_B = ['name', 'url', 'fetchedAt'] as const;

/** rent 用 −1 當 null 的哨兵、area 用 −1/−2——真實資料撞上就必須改設計，不能默默共用。 */
const RENT_NULL = -1;
const AREA_NULL = -1;
const AREA_EXCEPTION = -2;

const numAt = (a: readonly unknown[], i: number): number | null => {
  const v = a[i];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`[wire-codec] 第 ${i} 項應為數字或 null，收到 ${JSON.stringify(v)}`);
  }
  return v;
};

export function encodeIndex(idx: ColumnIndex): EncodedIndex {
  const B = idx.b;
  const U = idx.u;
  const nB = (B['name'] as unknown[]).length;
  const nU = (U['bid'] as unknown[]).length;
  const zeroIfNull = (a: readonly unknown[], i: number): number => numAt(a, i) ?? 0;

  const rentArr = U['rent'] as unknown[];
  const areaArr = U['area'] as unknown[];

  // ── bid：遞增就存成「每棟房間數」，省掉一整欄 ──
  const bidRaw = U['bid'] as number[];
  let monotone = true;
  for (let i = 1; i < nU; i++) if ((bidRaw[i] as number) < (bidRaw[i - 1] as number)) { monotone = false; break; }
  const uc = new Array<number>(nB).fill(0);
  if (monotone) for (let i = 0; i < nU; i++) uc[bidRaw[i] as number] = (uc[bidRaw[i] as number] as number) + 1;

  // ── rent：建物內 delta。哨兵 −1 代表 null ──
  const RS = new Array<number>(nU);
  for (let i = 0; i < nU; i++) {
    const v = numAt(rentArr, i);
    if (v === RENT_NULL) throw new Error(`[wire-codec] rent 第 ${i} 項是 ${RENT_NULL}，與 null 哨兵相撞——哨兵要改值`);
    RS[i] = v ?? RENT_NULL;
  }
  const rentD = new Array<number>(nU);
  for (let i = 0; i < nU; i++) {
    const same = i > 0 && (bidRaw[i] as number) === (bidRaw[i - 1] as number);
    rentD[i] = zig(same ? (RS[i] as number) - (RS[i - 1] as number) : (RS[i] as number));
  }

  // ── key/dep：日本慣例是賃料的 0/0.5/1/2… 倍，存倍數比存金額省得多；不整除的存例外表 ──
  const ratioEnc = (arr: readonly unknown[], label: string): RatioBlock => {
    const codes = new Array<number>(nU);
    const exI: number[] = [];
    const exV: number[] = [];
    for (let i = 0; i < nU; i++) {
      const v = numAt(arr, i);
      if (v === null) { codes[i] = 0; continue; }
      const r = numAt(rentArr, i);
      if (r !== null && r > 0) {
        const q2 = (v * 2) / r;
        // `r * q2 / 2 === v` 這一步是真正的無損保證：浮點算回來必須完全相等
        if (Number.isInteger(q2) && q2 >= 0 && q2 <= 48 && (r * q2) / 2 === v) { codes[i] = 1 + q2; continue; }
      }
      codes[i] = 50;
      exI.push(i);
      exV.push(v);
    }
    // 例外比一半還多代表這個假設在新資料上不成立了，該重新檢視而不是硬編。
    // 加小樣本護欄（比照 health.ts 的 n ≥ 30 告警門檻）：幾筆資料的比例沒有意義，
    // 而且會讓小型 fixture 誤觸發。編碼本身在任何比例下都是無損的，這只是「該回頭看設計」的訊號。
    const RATIO_GUARD_MIN_N = 50;
    if (nU >= RATIO_GUARD_MIN_N && exV.length > nU / 2) {
      throw new Error(`[wire-codec] ${label} 有 ${exV.length}/${nU} 筆不是賃料的半整數倍，倍數編碼已失去意義`);
    }
    return { c: dictEnc(codes), i: tvEnc(exI.map((v, j) => (j !== 0 ? v - (exI[j - 1] as number) : v))), v: exV };
  };

  // ── 派生欄位：用公式預測，只存「預測錯的地方」 ──
  // 不假設公式一定成立：殘差由實資料算出，公式改了也只是殘差變多，不會產生錯值。
  const sparse = (actual: readonly unknown[], pred: (i: number) => number, label: string): ResidBlock => {
    const ki: number[] = [];
    const kv: number[] = [];
    for (let i = 0; i < nU; i++) {
      const a = actual[i];
      if (typeof a !== 'number' || !Number.isFinite(a)) {
        // 原型直接算 `null - pred`，在 JS 會得到數字而不是報錯——那正是靜默改值
        throw new Error(`[wire-codec] ${label} 第 ${i} 項是 ${JSON.stringify(a)}，派生欄位必須是有限數字`);
      }
      const p = pred(i);
      if (p !== a) { ki.push(i); kv.push(a - p); }
    }
    return {
      n: ki.length,
      i: tvEnc(ki.map((v, j) => (j !== 0 ? v - (ki[j - 1] as number) : v))),
      v: tvEnc(kv.map(zig)),
    };
  };

  // ── area：×100 轉整數（幾乎全是 2 位小數）；轉不回來的原值進例外表 ──
  const AS = new Array<number>(nU);
  const aexI: number[] = [];
  const aexV: number[] = [];
  for (let i = 0; i < nU; i++) {
    const v = numAt(areaArr, i);
    if (v === null) { AS[i] = AREA_NULL; continue; }
    const s = Math.round(v * 100);
    // 要檢查的是**放大後**的值：area = −0.01 會變成 −1，正好撞上 null 哨兵，
    // 解碼時會變成 null——一個「原站有寫、我們卻說沒寫」的靜默改值。
    if (s === AREA_NULL || s === AREA_EXCEPTION || v === AREA_NULL || v === AREA_EXCEPTION) {
      throw new Error(`[wire-codec] area 第 ${i} 項是 ${v}（×100 = ${s}），與哨兵 ${AREA_NULL}/${AREA_EXCEPTION} 相撞——哨兵要改值`);
    }
    if (s / 100 === v && Number.isSafeInteger(s)) AS[i] = s;
    else { AS[i] = AREA_EXCEPTION; aexI.push(i); aexV.push(v); }
  }
  const areaD = new Array<number>(nU);
  for (let i = 0; i < nU; i++) areaD[i] = zig(i !== 0 ? (AS[i] as number) - (AS[i - 1] as number) : (AS[i] as number));

  const enc: Record<string, DictBlock> = {};
  for (const k of DICT_B) enc[`b.${k}`] = dictEnc(B[k] as unknown[]);
  for (const k of DICT_U) enc[`u.${k}`] = dictEnc(U[k] as unknown[]);

  const out: EncodedIndex = {
    v: 'C2',
    meta: idx.meta,
    dict: idx.dict,
    nB,
    nU,
    b: {
      name: B['name'] as unknown[], url: B['url'] as unknown[], fetchedAt: B['fetchedAt'] as unknown[],
      uc: monotone ? tvEnc(uc) : '',
    },
    u: { room: U['room'] as unknown[] },
    enc,
    rent: dictEnc(rentD),
    area: { d: tvEnc(areaD), i: aexI, v: aexV },
    key: ratioEnc(U['key'] as unknown[], 'key'),
    dep: ratioEnc(U['dep'] as unknown[], 'dep'),
    resid: {
      monthlyLower: sparse(U['monthlyLower'] as unknown[],
        (i) => zeroIfNull(rentArr, i) + zeroIfNull(U['admin'] as unknown[], i) + zeroIfNull(U['util'] as unknown[], i), 'monthlyLower'),
      initCash: sparse(U['initCash'] as unknown[],
        (i) => zeroIfNull(U['key'] as unknown[], i) + zeroIfNull(U['dep'] as unknown[], i), 'initCash'),
      initSunk: sparse(U['initSunk'] as unknown[],
        (i) => zeroIfNull(U['key'] as unknown[], i) + zeroIfNull(U['depNR'] as unknown[], i), 'initSunk'),
      effMonthly12: sparse(U['effMonthly12'] as unknown[],
        (i) => (U['monthlyLower'] as number[])[i] as number + Math.round((U['initSunk'] as number[])[i] as number / 12), 'effMonthly12'),
    },
  };
  if (!monotone) out.u.bid = bidRaw;
  return out;
}

export function decodeIndex(o: EncodedIndex): ColumnIndex {
  const { nU, nB } = o;
  const B: Record<string, Array<unknown>> = {
    name: o.b.name, url: o.b.url, fetchedAt: o.b.fetchedAt,
  };
  const U: Record<string, Array<unknown>> = { room: o.u.room };

  for (const k of DICT_B) {
    if (k === 'stn' || k === 'stw') continue; // 長度是扁平站數，要先有 stc
    B[k] = dictDec(o.enc[`b.${k}`] as DictBlock, nB);
  }
  for (const k of DICT_U) U[k] = dictDec(o.enc[`u.${k}`] as DictBlock, nU);

  let flat = 0;
  for (let i = 0; i < nB; i++) flat += (B['stc'] as number[])[i] as number;
  B['stn'] = dictDec(o.enc['b.stn'] as DictBlock, flat);
  B['stw'] = dictDec(o.enc['b.stw'] as DictBlock, flat);

  // bid
  let bid: number[];
  if (o.u.bid !== undefined) bid = o.u.bid;
  else {
    const uc = tvDec(o.b.uc, nB);
    bid = new Array<number>(nU);
    let p = 0;
    for (let i = 0; i < nB; i++) for (let j = 0; j < (uc[i] as number); j++) bid[p++] = i;
  }
  U['bid'] = bid;

  // rent
  const rd = dictDec(o.rent, nU) as number[];
  const RS = new Array<number>(nU);
  const rent = new Array<number | null>(nU);
  for (let i = 0; i < nU; i++) {
    const d = unzig(rd[i] as number);
    RS[i] = i > 0 && bid[i] === bid[i - 1] ? (RS[i - 1] as number) + d : d;
    rent[i] = RS[i] === RENT_NULL ? null : (RS[i] as number);
  }
  U['rent'] = rent;

  const ratioDec = (e: RatioBlock): Array<number | null> => {
    const codes = dictDec(e.c, nU) as number[];
    const out = new Array<number | null>(nU);
    const di = tvDec(e.i, e.v.length);
    const ex = new Map<number, number>();
    let acc = 0;
    for (let j = 0; j < e.v.length; j++) { acc += di[j] as number; ex.set(acc, e.v[j] as number); }
    for (let i = 0; i < nU; i++) {
      const c = codes[i] as number;
      if (c === 0) out[i] = null;
      else if (c === 50) out[i] = ex.get(i) as number;
      else out[i] = ((rent[i] as number) * (c - 1)) / 2;
    }
    return out;
  };
  U['key'] = ratioDec(o.key);
  U['dep'] = ratioDec(o.dep);

  // area
  {
    const d = tvDec(o.area.d, nU);
    const ex = new Map<number, number>();
    for (let j = 0; j < o.area.i.length; j++) ex.set(o.area.i[j] as number, o.area.v[j] as number);
    const area = new Array<number | null>(nU);
    let prev = 0;
    for (let i = 0; i < nU; i++) {
      prev = i !== 0 ? prev + unzig(d[i] as number) : unzig(d[i] as number);
      area[i] = prev === AREA_NULL ? null : prev === AREA_EXCEPTION ? (ex.get(i) as number) : prev / 100;
    }
    U['area'] = area;
  }

  // 派生欄位
  const z = (a: readonly unknown[], i: number): number => {
    const v = a[i];
    return v === null || v === undefined ? 0 : (v as number);
  };
  const applyResid = (r: ResidBlock, base: number[]): number[] => {
    const di = tvDec(r.i, r.n);
    const dv = tvDec(r.v, r.n);
    let acc = 0;
    for (let j = 0; j < r.n; j++) { acc += di[j] as number; base[acc] = (base[acc] as number) + unzig(dv[j] as number); }
    return base;
  };
  const mL = new Array<number>(nU);
  for (let i = 0; i < nU; i++) mL[i] = z(rent, i) + z(U['admin'] as unknown[], i) + z(U['util'] as unknown[], i);
  U['monthlyLower'] = applyResid(o.resid['monthlyLower'] as ResidBlock, mL);
  const iC = new Array<number>(nU);
  for (let i = 0; i < nU; i++) iC[i] = z(U['key'] as unknown[], i) + z(U['dep'] as unknown[], i);
  U['initCash'] = applyResid(o.resid['initCash'] as ResidBlock, iC);
  const iS = new Array<number>(nU);
  for (let i = 0; i < nU; i++) iS[i] = z(U['key'] as unknown[], i) + z(U['depNR'] as unknown[], i);
  U['initSunk'] = applyResid(o.resid['initSunk'] as ResidBlock, iS);
  const eF = new Array<number>(nU);
  for (let i = 0; i < nU; i++) {
    eF[i] = ((U['monthlyLower'] as number[])[i] as number) + Math.round(((U['initSunk'] as number[])[i] as number) / 12);
  }
  U['effMonthly12'] = applyResid(o.resid['effMonthly12'] as ResidBlock, eF);

  return { meta: o.meta, dict: o.dict, b: B, u: U };
}

/**
 * 全量逐格比對 encode→decode 的結果。
 *
 * 用 `Object.is` 而不是 `===`：後者分不出 `0` 與 `-0`，也認為 `NaN !== NaN`。
 * 這是接在 build-data 寫檔前的閘門——任何一格對不上就讓建置失敗，
 * 這樣「解碼後的數字跟原值不一樣而且沒人會知道」在結構上就不可能發生。
 */
export function assertLossless(orig: ColumnIndex, back: ColumnIndex): { cells: number } {
  let cells = 0;
  const cmpArr = (g: string, k: string, a: readonly unknown[], b: readonly unknown[]): void => {
    if (a.length !== b.length) throw new Error(`[wire-codec] ${g}.${k} 長度 ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < a.length; i++) {
      cells += 1;
      if (!Object.is(a[i], b[i])) {
        throw new Error(`[wire-codec] ${g}.${k}[${i}] 原值 ${JSON.stringify(a[i])} → 解碼 ${JSON.stringify(b[i])}`);
      }
    }
  };
  for (const [g, src, dst] of [['b', orig.b, back.b], ['u', orig.u, back.u]] as const) {
    const keys = new Set([...Object.keys(src), ...Object.keys(dst)]);
    for (const k of keys) {
      const a = src[k];
      const b = dst[k];
      if (a === undefined || b === undefined) throw new Error(`[wire-codec] ${g}.${k} 只存在於一邊`);
      cmpArr(g, k, a, b);
    }
  }
  if (JSON.stringify(orig.dict) !== JSON.stringify(back.dict)) throw new Error('[wire-codec] dict 不一致');
  if (JSON.stringify(orig.meta) !== JSON.stringify(back.meta)) throw new Error('[wire-codec] meta 不一致');
  return { cells };
}
