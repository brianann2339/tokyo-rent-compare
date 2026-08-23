/**
 * 站內重複刊登的合併（純函式，做在 build-data，真相層不動）。
 *
 * SUUMO 一棟建物底下，同一間房常被多家仲介各自刊登一列——每家有自己的 `jnc_` 頁、
 * 自己的 bukkenCode（unitKey），而 SUUMO 的部屋番号 100% 缺失，所以沒有任何
 * 識別碼能直接告訴我們「這兩列是同一間」。能用的只有欄位本身：
 *
 *   (階 原文, 間取, 面積, 賃料, 管理費, 敷金, 礼金)  — 7 元組
 *
 * 全同才合併。寧可少併（同棟同層同規格的兩間真實房會被視為兩間），
 * 也不要把「敷金不同」的兩列硬當一間——那是不同的條件，不是同一筆刊登。
 *
 * 為什麼做在 build-data 而不是 adapter：真相層要忠實等於頁面（一列刊登＝一列），
 * 合併是推導；放這裡才能改規則不重抓，且閘門能對合併前後下斷言。
 * 被併掉的列不會消失：主列的 prov 記 `mergedFrom`，可追回每一個 URL。
 */

import type { Unit } from '../../packages/schema/src/model.ts';
import type { Field, Yen } from '../../packages/schema/src/field.ts';

const SEP = '|';

function yenKey(f: Field<Yen>): string {
  return f.known ? String(f.v.jpy) : `?${f.why}`;
}
function numKey(f: Field<number>): string {
  return f.known ? String(f.v) : `?${f.why}`;
}
function strKey(f: Field<string>): string {
  return f.known ? f.v : `?${f.why}`;
}
/**
 * 樓層用**原文**比對而不是解析值：`B1階`／`1-2階`（メゾネット）解析後都是 null，
 * 用解析值會把不同樓層誤併成一組。原文為空才退回 why。
 */
function floorKey(f: Field<number>): string {
  const t = f.srcText.trim();
  return t !== '' ? t : `?${f.known ? 'known' : f.why}`;
}

/** 7 元組合併鍵。 */
export function adMergeKey(u: Unit): string {
  return [
    floorKey(u.floor),
    strKey(u.layout),
    numKey(u.areaM2),
    yenKey(u.monthly.rent),
    yenKey(u.monthly.adminFee),
    yenKey(u.initial.deposit),
    yenKey(u.initial.keyMoney),
  ].join(SEP);
}

/** 5 元組（不含敷金／礼金）——只用來回報「疑似但保守不併」的數量。 */
export function looseMergeKey(u: Unit): string {
  return [
    floorKey(u.floor), strKey(u.layout), numKey(u.areaM2),
    yenKey(u.monthly.rent), yenKey(u.monthly.adminFee),
  ].join(SEP);
}

export type MergeInfo = {
  readonly adCount: number;
  readonly mergedFrom: ReadonlyArray<{ unitKey: string; url: string }>;
};

export type DedupResult = {
  /** 保留的 unit，維持輸入順序 */
  readonly kept: Unit[];
  /** 主列 unitKey → 合併資訊（只有被合併過的主列才有） */
  readonly info: Map<string, MergeInfo>;
  readonly groups: number;
  readonly removed: number;
  /** 5 元組相同但 7 元組不同的列數——保守不併，列入稽核檔「疑似」 */
  readonly suspectOnly: number;
};

/** bukkenCode 皆為數字字串，比數值；非數字退回字串序。主列取最小者，結果才確定。 */
function unitKeyLess(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return a.length !== b.length ? a.length < b.length : a < b;
  }
  return a < b;
}

export function mergeDuplicateAds(units: readonly Unit[]): DedupResult {
  const byKey = new Map<string, Unit[]>();
  for (const u of units) {
    const k = adMergeKey(u);
    const arr = byKey.get(k);
    if (arr === undefined) byKey.set(k, [u]); else arr.push(u);
  }

  const dropped = new Set<string>();
  const info = new Map<string, MergeInfo>();
  let groups = 0;
  let removed = 0;
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue;
    groups += 1;
    let primary = arr[0] as Unit;
    for (const u of arr) if (unitKeyLess(u.unitKey, primary.unitKey)) primary = u;
    const mergedFrom = arr
      .filter((u) => u !== primary)
      .map((u) => ({ unitKey: u.unitKey, url: u.sourceUrl }));
    for (const m of mergedFrom) dropped.add(m.unitKey);
    removed += mergedFrom.length;
    info.set(primary.unitKey, { adCount: arr.length, mergedFrom });
  }

  // 疑似：5 元組同組但 7 元組拆成多組——只計數，不併
  const byLoose = new Map<string, Map<string, number>>();
  for (const u of units) {
    const lk = looseMergeKey(u);
    const inner = byLoose.get(lk) ?? new Map<string, number>();
    const sk = adMergeKey(u);
    inner.set(sk, (inner.get(sk) ?? 0) + 1);
    byLoose.set(lk, inner);
  }
  let suspectOnly = 0;
  for (const inner of byLoose.values()) {
    if (inner.size < 2) continue;
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    const largest = Math.max(...inner.values());
    suspectOnly += total - largest;
  }

  return {
    kept: units.filter((u) => !dropped.has(u.unitKey)),
    info, groups, removed, suspectOnly,
  };
}
