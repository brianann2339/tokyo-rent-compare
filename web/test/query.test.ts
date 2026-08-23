import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  query, queryToFilters, filtersToQuery, DEFAULT_FILTERS, buildingStations, lineBuildingCounts,
  type Wire, type Filters,
} from '../src/data.ts';

/**
 * 兩棟三間：
 *   棟 0「甲」新宿区 apartment 2015 年築，站 [新宿 10 分, 代々木 3 分]；間 0（1K 20㎡ 3F ¥80,000 A 區）、間 1（1LDK 40㎡ 樓層未知 ¥150,000 A 區）
 *   棟 1「乙」渋谷区 kind 未知 築年未知，站 [渋谷 5 分]；間 2（個室 ¥70,000 A 區）
 */
function makeWire(): Wire {
  return {
    meta: {
      generatedAt: '2026-08-23T00:00:00Z', buildings: 2, units: 3, provBucket: 400,
      sources: [{ id: 's1' }, { id: 's2' }], missingBits: [], violations: 0, flagBits: {},
      dedup: { suumoWithin: { before: 3, after: 3, groups: 0, removed: 0, suspectOnly: 0 }, crossSource: { groups: 0, removedUnits: 0, buildingOnlyCandidates: 0 } },
    },
    dict: {
      wards: ['新宿区', '渋谷区'], stations: ['新宿', '代々木', '渋谷'], sources: ['s1', 's2'],
      sourceMeta: { s1: { nameZh: '來源一', homepage: '' }, s2: { nameZh: '來源二', homepage: '' } },
      kinds: ['unknown', 'apartment', 'sharehouse', 'social', 'dormitory'],
      layouts: ['1K', '1LDK', '個室'], lines: ['JR山手線', '小田急線'],
      pairs: [[0, 0], [0, 1], [0, 2], [1, 0]],
    },
    b: {
      name: ['甲', '乙'], url: ['u0', 'u1'], ward: [0, 1], src: [0, 1],
      stn: [0, 1, 2], stw: [10, 3, 5], stc: [2, 1], total: [null, null], fetchedAt: ['2026-08-22', '2026-08-22'],
      kind: [1, 0], yearBuilt: [2015, null], also: [0, 0],
    },
    u: {
      bid: [0, 0, 1], room: [null, null, null], layout: [0, 1, 2], area: [20, 40, null], floor: [3, null, null],
      rent: [80000, 150000, 70000], admin: [0, 0, 0], util: [null, null, null], utilBasis: [2, 2, 1],
      key: [0, 0, 0], dep: [0, 0, 0], depNR: [null, null, null], gender: [1, 1, 1], foreigner: [-1, -1, 1], vacant: [1, 1, 1],
      monthlyLower: [80000, 150000, 70000], monthlyTier: [0, 0, 0], initCash: [0, 0, 0], initCashTier: [0, 0, 0],
      initSunk: [0, 0, 0], effMonthly12: [80000, 150000, 70000], missing: [0, 0, 0], flags: [0, 0, 0], ads: [1, 2, 1],
    },
  };
}

const F = (over: Partial<Filters>): Filters => ({ ...DEFAULT_FILTERS, ...over });
const ids = (w: Wire, f: Filters): number[] => query(w, f, new Date(2026, 7, 23)).rows.map((r) => r.i).sort();

describe('query：車站新語意', () => {
  test('未選站：任一站 ≤ N 分即命中（第二站較近的棟可見）', () => {
    const w = makeWire();
    assert.deepEqual(ids(w, F({ maxWalk: 5 })), [0, 1, 2]);   // 甲靠代々木 3 分、乙靠渋谷 5 分
    assert.deepEqual(ids(w, F({ maxWalk: 4 })), [0, 1]);      // 乙 5 分被擋
  });
  test('選站後：只看該站的步行', () => {
    const w = makeWire();
    assert.deepEqual(ids(w, F({ st: '新宿', maxWalk: 5 })), []);      // 甲到新宿 10 分
    assert.deepEqual(ids(w, F({ st: '新宿', maxWalk: 10 })), [0, 1]);
    assert.deepEqual(ids(w, F({ st: '不存在的站' })), []);
  });
  test('路線：任一站在該線上', () => {
    const w = makeWire();
    assert.deepEqual(ids(w, F({ line: '小田急線' })), [0, 1]);
    assert.deepEqual(ids(w, F({ line: 'JR山手線' })), [0, 1, 2]);
    assert.deepEqual(ids(w, F({ line: '沒這條線' })), []);
  });
  test('buildingStations／lineBuildingCounts', () => {
    const w = makeWire();
    assert.deepEqual(buildingStations(w, 0), [{ name: '新宿', walk: 10 }, { name: '代々木', walk: 3 }]);
    assert.deepEqual(buildingStations(w, 1), [{ name: '渋谷', walk: 5 }]);
    assert.deepEqual(lineBuildingCounts(w), [2, 1]);
  });
});

describe('query：種類／房型／樓層／屋齡', () => {
  test('kind=apt 排除未知並計數；kind=share 只剩共居', () => {
    const w = makeWire();
    const r = query(w, F({ kind: 'apt' }));
    assert.deepEqual(r.rows.map((x) => x.i).sort(), [0, 1]);
    assert.equal(r.excluded.kindUnknown, 1);
    assert.deepEqual(ids(w, F({ kind: 'share' })), []);
  });
  test('房型複選', () => {
    const w = makeWire();
    assert.deepEqual(ids(w, F({ layouts: ['1K', '個室'] })), [0, 2]);
  });
  test('樓層下限：未知者排除並計數', () => {
    const w = makeWire();
    const r = query(w, F({ minFloor: 2 }));
    assert.deepEqual(r.rows.map((x) => x.i), [0]);
    assert.equal(r.excluded.floorUnknown, 2);
  });
  test('屋齡上限：以傳入年份計；築年未知者排除並計數', () => {
    const w = makeWire();
    const r = query(w, F({ maxAge: 11 }), new Date(2026, 7, 23)); // 2026−2015=11
    assert.deepEqual(r.rows.map((x) => x.i).sort(), [0, 1]);
    assert.equal(r.excluded.ageUnknown, 1);
    assert.deepEqual(ids(w, F({ maxAge: 10 })), []);
  });
});

describe('URL 往返', () => {
  test('新欄位全部進 URL 並能還原', () => {
    const f = F({
      kind: 'share', layouts: ['1K', '1LDK'], line: 'JR山手線', st: '新宿', minFloor: 2, maxAge: 15,
      my: { rent: 120000, area: 25.5, layout: '1K', ward: '新宿区' },
    });
    const back = queryToFilters(filtersToQuery(f));
    assert.deepEqual(back, f);
  });
  test('my 欄位部分缺值也能還原；壞值不會炸', () => {
    const back = queryToFilters('my=%7C25%7C%7C%E6%96%B0%E5%AE%BF%E5%8C%BA&kind=bogus&sort=nope');
    assert.deepEqual(back.my, { rent: null, area: 25, layout: '', ward: '新宿区' });
    assert.equal(back.kind, '');
    assert.equal(back.sort, 'eff12');
  });
});
