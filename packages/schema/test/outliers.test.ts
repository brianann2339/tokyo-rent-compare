import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  marketBaseline, checkPerM2Outlier, checkAdminVsRent, checkMultiRoomArea, checkDepositKeyMonths, checkSiblingSlips,
  PER_M2_HIGH_RATIO, PER_M2_LOW_RATIO, ADMIN_RATIO_APT, ADMIN_RATIO_SHARE, DEPOSIT_KEY_MONTHS_MAX, ADMIN_SLIP_MIN_RATIO,
  type MarketRow,
} from '../src/outliers.ts';

const row = (over: Partial<MarketRow>): MarketRow => ({
  ward: '品川区', group: 'apt', layout: '1K', rentJpy: 100_000, adminJpy: 10_000, areaM2: 22,
  perM2Comparable: true, rooms: 1, ...over,
});

/** 品川区 1K 40 間：賃料 100,000、管理費 10,000、22㎡ → 每㎡ 5,000 */
const market = (): MarketRow[] => Array.from({ length: 40 }, () => row({}));

describe('marketBaseline', () => {
  test('同区同種類群夠多就用它；不夠就退回種類群；再不夠回 null', () => {
    const base = marketBaseline([...market(), row({ ward: '港区' })]);
    assert.equal(base.perM2('品川区', 'apt'), 5000);
    assert.equal(base.perM2('港区', 'apt'), 5000, '港区只有一間，退回全體一般賃貸');
    assert.equal(base.perM2('品川区', 'share'), null, '沒有任何共居，不可以拿一般賃貸頂替');
  });
  test('多人房不算每㎡（面積是整間共用房）', () => {
    const base = marketBaseline(Array.from({ length: 40 }, () => row({ perM2Comparable: false })));
    assert.equal(base.perM2('品川区', 'apt'), null);
  });
});

describe('每㎡離群', () => {
  const base = marketBaseline(market());

  test('1K 22㎡「119.5万円」（ザ・プレミアムキューブジー大崎）→ 怪賃料', () => {
    const v = checkPerM2Outlier(row({ rentJpy: 1_195_000, adminJpy: 15_000, areaM2: 22.05 }), base);
    assert.deepEqual(v?.fieldIds, ['rent']);
    assert.equal(v?.rule, 'per_m2_outlier');
  });

  test('1K「238m2」賃料正常（ソルクレスト北烏山）→ 怪面積', () => {
    const v = checkPerM2Outlier(row({ rentJpy: 76_000, adminJpy: 3_000, areaM2: 238 }), base);
    assert.deepEqual(v?.fieldIds, ['areaM2']);
  });

  test('界線：剛好 6 倍、剛好 0.15 倍算可疑；略內側不算', () => {
    const at = (ratio: number): MarketRow => row({ rentJpy: ratio * 5000 * 22, adminJpy: 0, areaM2: 22 });
    assert.notEqual(checkPerM2Outlier(at(PER_M2_HIGH_RATIO), base), null);
    assert.equal(checkPerM2Outlier(at(PER_M2_HIGH_RATIO - 0.01), base), null);
    assert.notEqual(checkPerM2Outlier(at(PER_M2_LOW_RATIO), base), null);
    assert.equal(checkPerM2Outlier(at(PER_M2_LOW_RATIO + 0.01), base), null);
  });

  test('房型未知（沒有賃料、面積行情可比）：分不出怪誰，兩個都標', () => {
    const v = checkPerM2Outlier(row({ layout: null, rentJpy: 76_000, adminJpy: 3_000, areaM2: 238 }), base);
    assert.deepEqual(v?.fieldIds, ['rent', 'areaM2']);
    assert.match(v?.detail ?? '', /分不出是賃料還是面積/);
  });

  test('沒有行情（該種類群不到門檻筆數）就不判，不可以亂比', () => {
    const v = checkPerM2Outlier(row({ group: 'share', rentJpy: 1_195_000 }), base);
    assert.equal(v, null);
  });

  test('明細帶得出原值與倍數，回原頁查得到', () => {
    const v = checkPerM2Outlier(row({ rentJpy: 1_195_000, adminJpy: 15_000, areaM2: 22.05 }), base);
    assert.match(v?.detail ?? '', /54,875 円/);
    assert.match(v?.detail ?? '', /賃料可疑/);
  });
});

describe('管理費對賃料', () => {
  test('一般賃貸：9.1万円＋90000円 可疑；剛好 0.8 倍可疑、0.79 倍不判', () => {
    assert.notEqual(checkAdminVsRent(row({ rentJpy: 91_000, adminJpy: 90_000 })), null);
    assert.notEqual(checkAdminVsRent(row({ rentJpy: 100_000, adminJpy: ADMIN_RATIO_APT * 100_000 })), null);
    assert.equal(checkAdminVsRent(row({ rentJpy: 100_000, adminJpy: 79_000 })), null);
  });
  test('共居：ドミトリー 23,000＋22,000（共益費含水電）不判；Couverture「共益費 150000」可疑', () => {
    assert.equal(checkAdminVsRent(row({ group: 'share', rentJpy: 23_000, adminJpy: 22_000 })), null);
    assert.equal(checkAdminVsRent(row({ group: 'share', rentJpy: 60_000, adminJpy: ADMIN_RATIO_SHARE * 60_000 })), null);
    assert.deepEqual(checkAdminVsRent(row({ group: 'share', rentJpy: 60_000, adminJpy: 150_000 }))?.fieldIds, ['adminFee']);
  });
  test('管理費未知不判', () => {
    assert.equal(checkAdminVsRent(row({ adminJpy: null })), null);
  });
});

describe('兩房以上的面積', () => {
  const base = marketBaseline(Array.from({ length: 40 }, () => row({ layout: '2DK', rooms: 2, areaM2: 40.6 })));
  test('2DK「10.57m2」可疑；1K 3.5㎡ 不判（超小套房是真的）', () => {
    assert.deepEqual(checkMultiRoomArea(row({ layout: '2DK', rooms: 2, areaM2: 10.57 }), base)?.fieldIds, ['areaM2']);
    assert.equal(checkMultiRoomArea(row({ layout: '1K', rooms: 1, areaM2: 3.5 }), base), null);
  });
  test('略高於四成不判', () => {
    assert.equal(checkMultiRoomArea(row({ layout: '2DK', rooms: 2, areaM2: 16.3 }), base), null);
  });
});

describe('敷金・礼金月數', () => {
  test('「29万円」寫「敷金 841万円・礼金 841万円」→ 兩欄都可疑', () => {
    const v = checkDepositKeyMonths(8_410_000, 8_410_000, 290_000);
    assert.deepEqual(v.map((x) => x.fieldIds[0]), ['deposit', 'keyMoney']);
  });
  test('港区高級物件 敷金 7.27 個月不判；剛好 8 個月不判', () => {
    assert.deepEqual(checkDepositKeyMonths(17_601_600, 2_420_300, 2_420_300), []);
    assert.deepEqual(checkDepositKeyMonths(DEPOSIT_KEY_MONTHS_MAX * 100_000, null, 100_000), []);
  });
  test('未知與賃料 0 不判', () => {
    assert.deepEqual(checkDepositKeyMonths(null, null, 100_000), []);
    assert.deepEqual(checkDepositKeyMonths(1_000_000, null, 0), []);
  });
});

describe('同棟十倍差', () => {
  const base = marketBaseline(market());

  test('管理費 7,500 與 75,000（スカイコート本郷東大前第3，0.66 倍）→ 怪 75,000 那列，對的那列不動', () => {
    const out = checkSiblingSlips([
      row({ rentJpy: 113_500, adminJpy: 7_500, areaM2: 21.45 }),
      row({ rentJpy: 113_500, adminJpy: 75_000, areaM2: 21.45 }),
    ], base);
    assert.deepEqual(out[0], []);
    assert.deepEqual(out[1]?.map((v) => [v.rule, v.fieldIds]), [['sibling_admin_x10', ['adminFee']]]);
  });

  test('管理費十倍差但大的那個不到賃料三成（6,000 與 600）→ 分不出哪個錯，不判', () => {
    const out = checkSiblingSlips([
      row({ rentJpy: 220_000, adminJpy: 600, areaM2: 36.38 }),
      row({ rentJpy: 220_000, adminJpy: 6_000, areaM2: 36.38 }),
    ], base);
    assert.equal(out.flat().length, 0);
    assert.ok(6_000 / 220_000 < ADMIN_SLIP_MIN_RATIO);
  });

  test('賃料差超過 5%、或房型不同：不算同一種房，不判', () => {
    assert.equal(checkSiblingSlips([
      row({ rentJpy: 100_000, adminJpy: 5_000 }), row({ rentJpy: 120_000, adminJpy: 50_000 }),
    ], base).flat().length, 0);
    assert.equal(checkSiblingSlips([
      row({ rentJpy: 100_000, adminJpy: 5_000 }), row({ layout: '1LDK', rentJpy: 100_000, adminJpy: 50_000 }),
    ], base).flat().length, 0);
  });

  test('賃料 119.5 万與 11.95 万、面積相同 → 怪每㎡離行情遠的大的那列；1.48 万與 14.8 万 → 怪小的', () => {
    const hi = checkSiblingSlips([
      row({ rentJpy: 119_500, adminJpy: 0, areaM2: 22.05 }), row({ rentJpy: 1_195_000, adminJpy: 0, areaM2: 22.05 }),
    ], base);
    assert.deepEqual(hi[0], []);
    assert.equal(hi[1]?.[0]?.rule, 'sibling_rent_x10');
    assert.match(hi[1]?.[0]?.detail ?? '', /多打一個 0/);
    const lo = checkSiblingSlips([
      row({ rentJpy: 148_000, adminJpy: 0, areaM2: 22 }), row({ rentJpy: 14_800, adminJpy: 0, areaM2: 22 }),
    ], base);
    assert.deepEqual(lo[0], []);
    assert.match(lo[1]?.[0]?.detail ?? '', /少打一個 0/);
  });

  test('同一列被好幾個兄弟列作證，只記一次', () => {
    const out = checkSiblingSlips([
      row({ rentJpy: 113_500, adminJpy: 7_500, areaM2: 21.45 }),
      row({ rentJpy: 114_500, adminJpy: 7_500, areaM2: 21.45 }),
      row({ rentJpy: 113_500, adminJpy: 75_000, areaM2: 21.45 }),
    ], base);
    assert.equal(out[2]?.length, 1);
  });
});
