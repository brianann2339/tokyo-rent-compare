import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { known, notListed, notOffered, yen, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Unit } from '../../packages/schema/src/model.ts';
import { mergeDuplicateAds, adMergeKey } from '../src/dedup.ts';

const Y = (n: number): Field<Yen> => known(yen(n), 'measured', `${n}円`);
const NL: Field<Yen> = notListed('敷金 -');

function unit(p: {
  key: string; floorSrc: string; floor?: number | null; layout: string; area: number;
  rent: number; admin: number; dep?: Field<Yen>; keyMoney?: Field<Yen>;
}): Unit {
  const z = notOffered<Yen>();
  return {
    id: `suumo:x#${p.key}`, buildingId: 'suumo:x', unitKey: p.key,
    sourceUrl: `https://suumo.jp/chintai/jnc_${p.key}/`,
    roomNo: notListed(''), layout: known(p.layout, 'measured', `間取り ${p.layout}`),
    areaM2: known(p.area, 'measured', `専有面積 ${p.area}m2`),
    floor: p.floor === null || p.floor === undefined
      ? { known: false, why: 'unparsed', basis: 'unstated', srcText: p.floorSrc }
      : known(p.floor, 'measured', p.floorSrc),
    monthly: { rent: Y(p.rent), adminFee: Y(p.admin), utilities: z, internet: z, otherMonthly: z },
    initial: {
      keyMoney: p.keyMoney ?? NL, deposit: p.dep ?? NL, depositNonRefundable: z, agencyFee: z,
      guarantorInitialFee: z, fireInsurance: z, keyExchangeFee: z, contractFee: z,
      cleaningFeeUpfront: z, otherInitial: z,
    },
    deferred: { renewalFee: z, renewalAdminFee: z, cleaningFeeOnExit: z, earlyTerminationPenalty: z },
    utilitiesBasis: 'unknown', furnished: notListed(''), availableFrom: notListed(''),
    isVacant: known(true, 'measured', 'x'), contractType: 'unknown',
    contractMonths: notListed(''), minStayMonths: notListed(''), genderRestriction: 'unknown',
    ageLimitRaw: notListed(''), petsAllowed: notListed(''),
    foreigner: {
      welcomed: notListed(''), residenceCardRequired: notListed(''), japaneseRequired: notListed(''),
      guarantorCompanyRequired: notListed(''), guarantorPersonRequired: notListed(''), rawText: '',
    },
    notes: [],
  };
}

describe('同棟重複刊登合併（7 元組）', () => {
  // 2026-08-16 真實案例：ルミーク文京千石 4階 2LDK 42.9㎡ ¥254,000 管理費 ¥20,000
  // 兩個 bukkenCode、兩個 jnc_ 頁 → 兩家仲介刊同一間房
  const a = unit({ key: '100521794213', floorSrc: '階 4階', floor: 4, layout: '2LDK', area: 42.9, rent: 254000, admin: 20000 });
  const b = unit({ key: '100520611717', floorSrc: '階 4階', floor: 4, layout: '2LDK', area: 42.9, rent: 254000, admin: 20000 });
  const c = unit({ key: '100513173140', floorSrc: '階 4階', floor: 4, layout: '2LDK', area: 51.2, rent: 255000, admin: 20000 });
  // 5 元組同 a/b，但敷金不同 → 不可併
  const d = unit({ key: '100599999999', floorSrc: '階 4階', floor: 4, layout: '2LDK', area: 42.9, rent: 254000, admin: 20000, dep: Y(254000) });
  const e = unit({ key: '100500000001', floorSrc: '階 1階', floor: 1, layout: '1K', area: 20, rent: 90000, admin: 5000 });

  test('3 同 7 元組留 1、主列為最小 bukkenCode、mergedFrom 正確', () => {
    const a2 = unit({ key: '100530000000', floorSrc: '階 4階', floor: 4, layout: '2LDK', area: 42.9, rent: 254000, admin: 20000 });
    const r = mergeDuplicateAds([a, a2, b, c, e]);
    assert.equal(r.kept.length, 3);
    assert.equal(r.groups, 1);
    assert.equal(r.removed, 2);
    assert.equal(r.kept.length + r.removed, 5);
    const primary = r.kept.find((u) => adMergeKey(u) === adMergeKey(a));
    assert.equal(primary?.unitKey, '100520611717'); // 最小者
    const info = r.info.get('100520611717');
    assert.equal(info?.adCount, 3);
    assert.deepEqual(info?.mergedFrom.map((m) => m.unitKey).sort(), ['100521794213', '100530000000']);
    assert.ok(info?.mergedFrom.every((m) => m.url.startsWith('https://suumo.jp/chintai/jnc_')));
  });

  test('敷金不同 → 不併，但計入「疑似」', () => {
    const r = mergeDuplicateAds([a, b, d]);
    assert.equal(r.kept.length, 2);
    assert.equal(r.suspectOnly, 1);
  });

  test('樓層用原文比：B1階 與 1-2階 解析皆 null 但不可併', () => {
    const x = unit({ key: '1', floorSrc: '階 B1階', floor: null, layout: '1K', area: 20, rent: 90000, admin: 5000 });
    const y = unit({ key: '2', floorSrc: '階 1-2階', floor: null, layout: '1K', area: 20, rent: 90000, admin: 5000 });
    const r = mergeDuplicateAds([x, y]);
    assert.equal(r.kept.length, 2);
    assert.equal(r.removed, 0);
  });

  test('保留順序＝輸入順序', () => {
    const r = mergeDuplicateAds([e, a, b, c]);
    assert.deepEqual(r.kept.map((u) => u.unitKey), ['100500000001', '100520611717', '100513173140']);
  });

  test('無重複時原樣回傳', () => {
    const r = mergeDuplicateAds([c, e]);
    assert.equal(r.kept.length, 2); assert.equal(r.groups, 0); assert.equal(r.info.size, 0);
  });
});
