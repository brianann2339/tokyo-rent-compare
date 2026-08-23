/**
 * 純統計函式——「知己知彼」直方圖與百分位用，不碰 DOM、不認識 Wire。
 * 呼叫端負責只餵 A 區（monthlyTier===0）的值，並在 UI 顯示 n。
 */

export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** 第一個 ≥ x 的索引。 */
function lowerBound(a: readonly number[], x: number): number {
  let lo = 0; let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((a[mid] as number) < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 第一個 > x 的索引。 */
function upperBound(a: readonly number[], x: number): number {
  let lo = 0; let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((a[mid] as number) <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 線性內插分位數。輸入必須已升冪；p 夾在 [0,1]；空陣列 → null。 */
export function quantile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const pos = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sortedAsc[lo] as number;
  const b = sortedAsc[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** x 的百分位（0–100）＝小於 x 的比例 ＋ 等於 x 的一半（midrank）。空 → null。 */
export function percentileRank(sortedAsc: readonly number[], x: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const below = lowerBound(sortedAsc, x);
  const equal = upperBound(sortedAsc, x) - below;
  return ((below + equal / 2) / n) * 100;
}

export function summary(values: readonly number[]): {
  n: number; p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
} {
  const s = sortedAsc(values);
  return {
    n: s.length,
    p10: quantile(s, 0.1), p25: quantile(s, 0.25), p50: quantile(s, 0.5),
    p75: quantile(s, 0.75), p90: quantile(s, 0.9),
  };
}

/** Freedman–Diaconis 桶數（寬 = 2·IQR·n^(-1/3)），夾在 [10,30]；IQR=0 或 n<2 退回 10。 */
function fdBins(s: readonly number[]): number {
  const n = s.length;
  if (n < 2) return 10;
  const iqr = (quantile(s, 0.75) as number) - (quantile(s, 0.25) as number);
  if (iqr <= 0) return 10;
  const width = (2 * iqr) / Math.cbrt(n);
  const range = (s[n - 1] as number) - (s[0] as number);
  return Math.min(30, Math.max(10, Math.ceil(range / width)));
}

/** 等寬直方圖。counts 總和 = n；最後一桶右閉（最大值落在最後一桶）。 */
export function histogram(
  values: readonly number[],
  opts: { bins?: number } = {},
): { edges: number[]; counts: number[]; n: number } {
  const s = sortedAsc(values);
  const n = s.length;
  if (n === 0) return { edges: [], counts: [], n: 0 };
  const min = s[0] as number;
  const max = s[n - 1] as number;
  const bins = opts.bins === undefined ? fdBins(s) : Math.max(1, Math.floor(opts.bins));
  const width = (max - min) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, k) => min + width * k);
  edges[bins] = max;
  const counts: number[] = new Array<number>(bins).fill(0);
  for (const v of s) {
    const k = width === 0 ? 0 : Math.min(bins - 1, Math.floor((v - min) / width));
    counts[k] = (counts[k] as number) + 1;
  }
  return { edges, counts, n };
}
