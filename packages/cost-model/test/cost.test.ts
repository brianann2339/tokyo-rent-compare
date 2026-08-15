import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  known, notListed, notOffered, includedInOther, yen, type Field, type Yen,
} from '../../schema/src/field.ts';
import type { Unit } from '../../schema/src/model.ts';
import {
  monthlyCost, initialCash, initialSunk, totalOverHorizon, effectiveMonthly,
  proratedRent, tierOf, rankByTier, tierCounts, monthlyWithUserAssumption,
} from '../src/index.ts';

const Y = (n: number, src = `${n}円`): Field<Yen> => known(yen(n), 'measured', src);
const MISSING: Field<Yen> = notListed('');

function makeUnit(over: {
  rent?: Field<Yen>; adminFee?: Field<Yen>; utilities?: Field<Yen>;
  deposit?: Field<Yen>; depositNonRefundable?: Field<Yen>; keyMoney?: Field<Yen>;
  agencyFee?: Field<Yen>; guarantorInitialFee?: Field<Yen>; fireInsurance?: Field<Yen>;
  keyExchangeFee?: Field<Yen>; contractFee?: Field<Yen>; cleaningFeeUpfront?: Field<Yen>;
  renewalFee?: Field<Yen>;
  utilitiesBasis?: Unit['utilitiesBasis'];
} = {}): Unit {
  const zero = Y(0, 'なし');
  return {
    id: 'test:1#a', buildingId: 'test:1', unitKey: 'a', sourceUrl: 'https://example.test/1',
    roomNo: notListed(''), layout: notListed(''), areaM2: notListed(''), floor: notListed(''),
    monthly: {
      rent: over.rent ?? Y(60000),
      adminFee: over.adminFee ?? Y(5000),
      utilities: over.utilities ?? zero,
      internet: zero,
      otherMonthly: zero,
    },
    initial: {
      keyMoney: over.keyMoney ?? zero,
      deposit: over.deposit ?? zero,
      depositNonRefundable: over.depositNonRefundable ?? zero,
      agencyFee: over.agencyFee ?? zero,
      guarantorInitialFee: over.guarantorInitialFee ?? zero,
      fireInsurance: over.fireInsurance ?? zero,
      keyExchangeFee: over.keyExchangeFee ?? zero,
      contractFee: over.contractFee ?? zero,
      cleaningFeeUpfront: over.cleaningFeeUpfront ?? zero,
      otherInitial: zero,
    },
    deferred: {
      renewalFee: over.renewalFee ?? zero,
      renewalAdminFee: zero,
      cleaningFeeOnExit: zero,
      earlyTerminationPenalty: zero,
    },
    utilitiesBasis: over.utilitiesBasis ?? 'excluded',
    furnished: notListed(''), availableFrom: notListed(''), isVacant: notListed(''),
    contractType: 'unknown', contractMonths: notListed(''), minStayMonths: notListed(''),
    genderRestriction: 'unknown', ageLimitRaw: notListed(''), petsAllowed: notListed(''),
    foreigner: {
      welcomed: notListed(''), residenceCardRequired: notListed(''),
      japaneseRequired: notListed(''), guarantorCompanyRequired: notListed(''),
      guarantorPersonRequired: notListed(''), rawText: '',
    },
    notes: [],
  };
}

describe('月額', () => {
  test('全部已知 → COMPLETE', () => {
    const m = monthlyCost(makeUnit());
    assert.equal(m.lower.jpy, 65000);
    assert.equal(m.completeness, 'COMPLETE');
    assert.deepEqual(m.missing, []);
  });

  test('管理費未知 → LOWER_BOUND 且列出缺項', () => {
    const m = monthlyCost(makeUnit({ adminFee: MISSING }));
    assert.equal(m.lower.jpy, 60000);
    assert.equal(m.completeness, 'LOWER_BOUND');
    assert.deepEqual(m.missing, ['adminFee']);
  });

  test('share house 明寫「光熱費込み」→ 水電 0 且視為完整', () => {
    const u = makeUnit({ utilities: includedInOther('水道光熱費込み'), utilitiesBasis: 'included' });
    const m = monthlyCost(u);
    assert.equal(m.completeness, 'COMPLETE');
    assert.deepEqual(m.caveats, []);
  });

  test('水電基準未知 → 附警語，但不算成缺項', () => {
    // 月額的定義是賃料＋管理費（日本房源慣例）。水電幾乎沒有任何網站逐物件報價，
    // 拿它判定完整性會讓每一筆都變成 LOWER_BOUND——一個永遠相同的訊號不帶資訊，
    // 反而淹沒真正該被標示的「缺賃料／缺管理費」。水電的不確定性改由警語與標籤承擔。
    const u = makeUnit({ utilities: MISSING, utilitiesBasis: 'unknown' });
    const m = monthlyCost(u);
    assert.equal(m.completeness, 'COMPLETE');
    assert.ok(!m.missing.includes('utilities'));
    assert.ok(m.caveats.some((c) => c.includes('水電')));
  });

  test('缺管理費仍然是缺項（這才是該被標示的）', () => {
    const u = makeUnit({ adminFee: MISSING, utilities: MISSING, utilitiesBasis: 'unknown' });
    const m = monthlyCost(u);
    assert.equal(m.completeness, 'LOWER_BOUND');
    assert.deepEqual(m.missing, ['adminFee']);
  });
});

describe('初期費用：現金需求 vs 沉沒成本', () => {
  // 這一組是整個模型的重點：兩個物件的排序在兩個指標下會相反
  const 敷2礼0 = makeUnit({ deposit: Y(120000, '敷金2ヶ月'), keyMoney: Y(0, '礼金なし') });
  const 敷0礼1 = makeUnit({ deposit: Y(0, '敷金なし'), keyMoney: Y(60000, '礼金1ヶ月') });

  test('現金需求：敷2礼0 較高', () => {
    assert.equal(initialCash(敷2礼0).lower.jpy, 120000);
    assert.equal(initialCash(敷0礼1).lower.jpy, 60000);
  });

  test('沉沒成本：敷2礼0 反而較低（敷金會退，礼金不會）', () => {
    assert.equal(initialSunk(敷2礼0).lower.jpy, 0);
    assert.equal(initialSunk(敷0礼1).lower.jpy, 60000);
  });

  test('有敷金但敷引未知 → 沉沒成本附警語', () => {
    const u = makeUnit({ deposit: Y(120000), depositNonRefundable: MISSING });
    const s = initialSunk(u);
    assert.equal(s.completeness, 'LOWER_BOUND');
    assert.ok(s.caveats.some((c) => c.includes('敷引')));
  });

  test('無敷金時不出現敷引警語', () => {
    const u = makeUnit({ deposit: Y(0, 'なし'), depositNonRefundable: MISSING });
    assert.equal(initialSunk(u).caveats.length, 0);
  });
});

describe('視野與更新料', () => {
  test('12 個月視野不計更新料', () => {
    const u = makeUnit({ renewalFee: Y(60000, '更新料1ヶ月') });
    const t = totalOverHorizon(u, 12, null);
    assert.equal(t.lower.jpy, 65000 * 12);
  });

  test('24 個月視野計入 1 次更新料', () => {
    const u = makeUnit({ renewalFee: Y(60000, '更新料1ヶ月') });
    const t = totalOverHorizon(u, 24, null);
    assert.equal(t.lower.jpy, 65000 * 24 + 60000);
  });

  test('24 個月視野但更新料未知 → LOWER_BOUND + 警語', () => {
    const u = makeUnit({ renewalFee: MISSING });
    const t = totalOverHorizon(u, 24, null);
    assert.equal(t.completeness, 'LOWER_BOUND');
    assert.ok(t.missing.includes('renewalFee'));
    assert.ok(t.caveats.some((c) => c.includes('更新料')));
  });

  test('未指定入住日 → 不計日割家賃並附註（不假設 1 號入住）', () => {
    const t = totalOverHorizon(makeUnit(), 12, null);
    assert.ok(t.caveats.some((c) => c.includes('入住日')));
  });

  test('實質月成本 = 總支出 / 月數', () => {
    const u = makeUnit({ keyMoney: Y(60000) });
    const e = effectiveMonthly(u, 12, null);
    assert.equal(e.lower.jpy, Math.round((60000 + 65000 * 12) / 12));
  });
});

describe('日割家賃', () => {
  test('8月16日入住，8月有31天，剩16天', () => {
    const r = proratedRent(62000, new Date(2026, 7, 16));
    assert.equal(r.jpy, Math.round((62000 / 31) * 16));
  });
  test('月初1號入住 → 整月', () => {
    assert.equal(proratedRent(62000, new Date(2026, 7, 1)).jpy, 62000);
  });
  test('2月（28天）', () => {
    const r = proratedRent(60000, new Date(2026, 1, 15));
    assert.equal(r.jpy, Math.round((60000 / 28) * 14));
  });
});

describe('A/B/C 分區排序', () => {
  test('缺賃料 → C 區，不參與排序', () => {
    const u = makeUnit({ rent: MISSING });
    assert.equal(tierOf(u, monthlyCost(u)), 'C');
  });
  test('賃料已知但缺管理費 → B 區', () => {
    const u = makeUnit({ adminFee: MISSING });
    assert.equal(tierOf(u, monthlyCost(u)), 'B');
  });
  test('全部已知 → A 區', () => {
    const u = makeUnit();
    assert.equal(tierOf(u, monthlyCost(u)), 'A');
  });

  test('缺值的便宜物件不會排在資料完整物件之前', () => {
    const 完整貴 = makeUnit({ rent: Y(90000) });                    // A 區，95,000
    const 缺值便宜 = makeUnit({ rent: Y(50000), adminFee: MISSING }); // B 區，下限 50,000
    const 缺賃料 = makeUnit({ rent: MISSING });                      // C 區
    const rows = rankByTier([完整貴, 缺值便宜, 缺賃料], (u) => u, monthlyCost);

    assert.equal(rows[0]?.tier, 'A');
    assert.equal(rows[0]?.metric.lower.jpy, 95000);
    assert.equal(rows[1]?.tier, 'B');
    assert.equal(rows[2]?.tier, 'C');
    // 重點：下限 50,000 的 B 區物件排在 95,000 的 A 區物件之後
    assert.ok((rows[0]?.metric.lower.jpy ?? 0) > (rows[1]?.metric.lower.jpy ?? 0));
  });

  test('A 區內部按金額排序', () => {
    const a = makeUnit({ rent: Y(90000) });
    const b = makeUnit({ rent: Y(70000) });
    const c = makeUnit({ rent: Y(80000) });
    const rows = rankByTier([a, b, c], (u) => u, monthlyCost);
    assert.deepEqual(rows.map((r) => r.metric.lower.jpy), [75000, 85000, 95000]);
  });

  test('分區筆數統計', () => {
    const rows = rankByTier(
      [makeUnit(), makeUnit(), makeUnit({ adminFee: MISSING }), makeUnit({ rent: MISSING })],
      (u) => u, monthlyCost,
    );
    assert.deepEqual(tierCounts(rows), { A: 2, B: 1, C: 1 });
  });
});

describe('使用者自填水電假設', () => {
  test('未知水電時加上假設，並標明是使用者的數字', () => {
    const u = makeUnit({ utilities: MISSING, utilitiesBasis: 'unknown' });
    const m = monthlyWithUserAssumption(u, 12000);
    assert.equal(m.lower.jpy, 60000 + 5000 + 12000);
    assert.ok(m.caveats.some((c) => c.includes('你設定')));
  });
  test('已明寫含水電時不套用假設（避免重複計算）', () => {
    const u = makeUnit({ utilities: includedInOther('光熱費込み'), utilitiesBasis: 'included' });
    assert.equal(monthlyWithUserAssumption(u, 12000).lower.jpy, 65000);
  });
});

describe('來源不提供的欄位', () => {
  test('Couverture 無礼金欄位 → not_offered_by_source，仍算缺項但不是解析故障', () => {
    const u = makeUnit({ keyMoney: notOffered<Yen>() });
    const s = initialSunk(u);
    assert.equal(s.completeness, 'LOWER_BOUND');
    assert.ok(s.missing.includes('keyMoney'));
    assert.equal(u.initial.keyMoney.known, false);
    if (!u.initial.keyMoney.known) {
      assert.equal(u.initial.keyMoney.why, 'not_offered_by_source');
    }
  });
});
