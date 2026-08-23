import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sortedAsc, quantile, percentileRank, summary, histogram } from '../src/stats.ts';

/** 固定種子的 LCG，測試資料每次相同、不是隨機。 */
function lcg(seed: number, n: number): number[] {
  const out: number[] = [];
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(50000 + (s % 100000));
  }
  return out;
}

describe('quantile', () => {
  test('空陣列 → null', () => {
    assert.equal(quantile([], 0.5), null);
  });
  test('n=1 任何 p 都回那個值', () => {
    assert.equal(quantile([7], 0), 7);
    assert.equal(quantile([7], 0.5), 7);
    assert.equal(quantile([7], 1), 7);
  });
  test('n=2 線性內插', () => {
    assert.equal(quantile([10, 20], 0.5), 15);
    assert.equal(quantile([10, 20], 0.25), 12.5);
    assert.equal(quantile([10, 20], 0), 10);
    assert.equal(quantile([10, 20], 1), 20);
  });
  test('全同值：每個分位都等於該值', () => {
    const s = [5, 5, 5, 5, 5];
    for (const p of [0, 0.1, 0.5, 0.9, 1]) assert.equal(quantile(s, p), 5);
  });
  test('p 超出 [0,1] 夾回邊界', () => {
    assert.equal(quantile([1, 2, 3], -1), 1);
    assert.equal(quantile([1, 2, 3], 2), 3);
  });
  test('n=5 的中位數是中間那個', () => {
    assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  });
});

describe('percentileRank', () => {
  const s = sortedAsc([3, 1, 5, 2, 4]);
  test('空 → null', () => {
    assert.equal(percentileRank([], 1), null);
  });
  test('最小值之下 0、最大值之上 100', () => {
    assert.equal(percentileRank(s, 0), 0);
    assert.equal(percentileRank(s, 6), 100);
  });
  test('midrank：等於 x 的算一半', () => {
    assert.equal(percentileRank(s, 3), 50);  // 2 個小於 + 0.5 × 1 個等於 = 2.5 / 5
    assert.equal(percentileRank(s, 1), 10);
    assert.equal(percentileRank(s, 5), 90);
    assert.equal(percentileRank([2, 2, 2, 2], 2), 50);
  });
  test('單調不減', () => {
    const vals = lcg(42, 200);
    const sorted = sortedAsc(vals);
    let prev = -1;
    for (let x = 40000; x <= 160000; x += 997) {
      const r = percentileRank(sorted, x) as number;
      assert.ok(r >= prev, `x=${x}: ${r} < ${prev}`);
      assert.ok(r >= 0 && r <= 100);
      prev = r;
    }
  });
});

describe('summary', () => {
  test('n 正確、分位數順序正確', () => {
    const vals = lcg(7, 123);
    const sm = summary(vals);
    assert.equal(sm.n, 123);
    assert.ok((sm.p10 as number) <= (sm.p25 as number));
    assert.ok((sm.p25 as number) <= (sm.p50 as number));
    assert.ok((sm.p50 as number) <= (sm.p75 as number));
    assert.ok((sm.p75 as number) <= (sm.p90 as number));
  });
  test('空 → n=0 且全 null', () => {
    const sm = summary([]);
    assert.equal(sm.n, 0);
    assert.equal(sm.p50, null);
    assert.equal(sm.p90, null);
  });
});

describe('histogram', () => {
  test('counts 總和 = n、桶數在 [10,30]、edges 比 counts 多一', () => {
    for (const [seed, n] of [[1, 5], [2, 50], [3, 500], [4, 5000]] as const) {
      const h = histogram(lcg(seed, n));
      assert.equal(h.n, n);
      assert.equal(h.counts.reduce((a, b) => a + b, 0), n, `seed=${seed}`);
      assert.ok(h.counts.length >= 10 && h.counts.length <= 30, `seed=${seed} bins=${h.counts.length}`);
      assert.equal(h.edges.length, h.counts.length + 1);
    }
  });
  test('最後一桶右閉：最大值計入最後一桶', () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 });
    assert.deepEqual(h.counts, [2, 2, 2, 2, 3]);
    assert.equal(h.edges[0], 0);
    assert.equal(h.edges[5], 10);
  });
  test('IQR=0 退回 10 桶', () => {
    const h = histogram([1, 1, 1, 1, 1, 1, 1, 1, 1, 100]);
    assert.equal(h.counts.length, 10);
    assert.equal(h.counts.reduce((a, b) => a + b, 0), 10);
    assert.equal(h.counts[0], 9);
    assert.equal(h.counts[9], 1);
  });
  test('n<2 退回 10 桶，全同值全進第一桶', () => {
    assert.equal(histogram([42]).counts.length, 10);
    assert.equal(histogram([42]).counts[0], 1);
    const same = histogram([3, 3, 3, 3]);
    assert.equal(same.counts.length, 10);
    assert.equal(same.counts[0], 4);
  });
  test('空 → n=0、無桶', () => {
    assert.deepEqual(histogram([]), { edges: [], counts: [], n: 0 });
  });
  test('FD 桶數被夾住：極寬分佈不超過 30、極集中不少於 10', () => {
    const wide = [...lcg(9, 100), 10_000_000];     // 一個極端值把 range 拉大
    assert.equal(histogram(wide).counts.length, 30);
    const tight = [1, 2, 3, 4, 5];
    assert.equal(histogram(tight).counts.length, 10);
  });
});
