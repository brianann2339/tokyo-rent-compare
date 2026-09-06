import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkRentRange, checkAgencyFeeCap, checkAreaRange, checkAreaVsJo,
  checkWalkMinutes, checkYearBuilt, checkMonthlyAtLeastRent, checkDepositNonRefundable,
  WALK_MIN, WALK_MAX, RENT_MIN_JPY, RENT_MAX_JPY,
} from '../src/invariants.ts';

/**
 * 邊界值測試。這些界線全部有法源或實測依據（見 invariants.ts 檔頭），
 * 所以「剛好等於界線」是合法值還是違反，是有正確答案的，不能憑感覺。
 */

describe('徒歩分', () => {
  test('界線內含端點', () => {
    assert.equal(checkWalkMinutes(WALK_MIN), null);
    assert.equal(checkWalkMinutes(WALK_MAX), null);
    assert.equal(checkWalkMinutes(7), null);
  });
  test('0 分、61 分、220 分都是違反', () => {
    for (const v of [0, WALK_MAX + 1, 220]) {
      assert.notEqual(checkWalkMinutes(v), null, `${v} 分應該是違反`);
    }
  });
  test('非整數是違反——徒歩分在日本一律是整數，小數代表解析把別的數字讀進來了', () => {
    assert.notEqual(checkWalkMinutes(7.5), null);
  });
  test('負數與 NaN 不會靜默通過', () => {
    assert.notEqual(checkWalkMinutes(-3), null);
    assert.notEqual(checkWalkMinutes(Number.NaN), null);
  });
  test('違反訊息帶得出原值，才回得去原頁核對', () => {
    assert.match(checkWalkMinutes(220)?.detail ?? '', /220/);
  });
});

describe('面積 vs 帖（1帖 = 1.62㎡「以上」）', () => {
  test('剛好等於下限合法', () => {
    assert.equal(checkAreaVsJo(8 * 1.62, 8), null);
  });
  test('高於下限合法——帖只給下界，實際㎡可以更大', () => {
    assert.equal(checkAreaVsJo(20, 8), null);
  });
  test('2% 容差內合法（原站的帖數常是四捨五入後的展示值）', () => {
    assert.equal(checkAreaVsJo(8 * 1.62 * 0.99, 8), null);
  });
  test('明顯低於下限是違反', () => {
    const v = checkAreaVsJo(9, 8);
    assert.notEqual(v, null);
    assert.match(v?.detail ?? '', /12\.96/);
  });
});

describe('賃料範圍', () => {
  test('港区 300 萬/月的真實豪宅盤不可被當成錯誤', () => {
    assert.equal(checkRentRange(3_000_000), null);
  });
  test('端點是開區間：剛好 1 萬 / 1000 萬都算違反', () => {
    assert.notEqual(checkRentRange(RENT_MIN_JPY), null);
    assert.notEqual(checkRentRange(RENT_MAX_JPY), null);
  });
});

describe('仲介手数料法定上限', () => {
  test('賃料 1.1 倍以內合法（宅建業法46条＋昭和45年告示1552号）', () => {
    assert.equal(checkAgencyFeeCap(88_000, 80_000), null);
  });
  test('容差 1% 內不誤判', () => {
    assert.equal(checkAgencyFeeCap(88_800, 80_000), null);
  });
  test('賃料 2 個月的仲介費是違反', () => {
    assert.notEqual(checkAgencyFeeCap(160_000, 80_000), null);
  });
});

describe('其餘', () => {
  test('面積範圍 [3, 500]', () => {
    assert.equal(checkAreaRange(3), null);
    assert.equal(checkAreaRange(500), null);
    assert.notEqual(checkAreaRange(2.5), null);
    assert.notEqual(checkAreaRange(14000), null);
  });
  test('築年不可晚於當年', () => {
    const now = new Date('2026-09-06T00:00:00Z');
    assert.equal(checkYearBuilt(2026, now), null);
    assert.notEqual(checkYearBuilt(2027, now), null);
    assert.notEqual(checkYearBuilt(1899, now), null);
  });
  test('月額下限不可小於賃料', () => {
    assert.equal(checkMonthlyAtLeastRent(85_000, 80_000), null);
    assert.equal(checkMonthlyAtLeastRent(80_000, 80_000), null);
    assert.notEqual(checkMonthlyAtLeastRent(79_999, 80_000), null);
  });
  test('敷引不可大於敷金', () => {
    assert.equal(checkDepositNonRefundable(80_000, 160_000), null);
    assert.equal(checkDepositNonRefundable(160_000, 160_000), null);
    assert.notEqual(checkDepositNonRefundable(160_001, 160_000), null);
  });
});
