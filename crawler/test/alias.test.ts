import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { known, notListed, notOffered, yen, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit, Building } from '../../packages/schema/src/model.ts';
import { findCandidates, crossSourceRoomHits, pickPrimary } from '../src/cli/alias-candidates.ts';

const Y = (n: number): Field<Yen> => known(yen(n), 'measured', `${n}円`);

function unit(bid: string, key: string, rent: number | null, area: number | null): Unit {
  const z = notOffered<Yen>();
  return {
    id: `${bid}#${key}`, buildingId: bid, unitKey: key, sourceUrl: `https://x/${key}`,
    roomNo: notListed(''), layout: known('1K', 'measured', '1K'),
    areaM2: area === null ? notListed('') : known(area, 'measured', `${area}m2`),
    floor: notListed(''),
    monthly: { rent: rent === null ? notListed('') : Y(rent), adminFee: z, utilities: z, internet: z, otherMonthly: z },
    initial: {
      keyMoney: z, deposit: z, depositNonRefundable: z, agencyFee: z, guarantorInitialFee: z,
      fireInsurance: z, keyExchangeFee: z, contractFee: z, cleaningFeeUpfront: z, otherInitial: z,
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

function listing(p: {
  src: Building['sourceId']; id: string; name: string; ward: string; stations: string[];
  rooms: Array<[number | null, number | null]>;
}): Listing {
  const building: Building = {
    id: p.id, sourceId: p.src, sourceUrl: `https://${p.src}/${p.id}`, name: p.name, kind: 'apartment',
    ward: p.ward, addressRaw: '', stations: p.stations.map((s) => ({ line: '', station: s, walkMinutes: notListed('') })),
    structure: notListed(''), yearBuilt: notListed(''), floorsAboveGround: notListed(''), totalUnits: notListed(''),
    fetchedAt: '2026-08-23T00:00:00Z', htmlSha256: '', sourceUpdatedAt: notListed(''),
  } as unknown as Building;
  return { building, units: p.rooms.map(([r, a], k) => unit(p.id, String(k), r, a)) };
}

describe('跨來源同棟候選（閘門 4 的判準）', () => {
  const leo = listing({ src: 'leopalace21', id: 'leopalace21:a', name: 'レオパレス翔', ward: '豊島区', stations: ['大塚', '巣鴨新田'], rooms: [[80000, 20], [90000, 22]] });
  const suumoA = listing({ src: 'suumo', id: 'suumo:a', name: 'レオパレス翔', ward: '豊島区', stations: ['大塚', '西巣鴨'], rooms: [[80000, 20], [100000, 30]] });
  const suumoB = listing({ src: 'suumo', id: 'suumo:b', name: 'レオパレス翔', ward: '豊島区', stations: ['大塚'], rooms: [[80000, 20]] });

  test('同区＋同正規化名＋共站 → 候選；房間層只算不同來源之間', () => {
    const c = findCandidates([leo, suumoA, suumoB]);
    assert.equal(c.size, 1);
    const ls = [...c.values()][0] as Listing[];
    // leo×suumoA 命中 1、leo×suumoB 命中 1；suumoA×suumoB 同來源**不算**
    assert.equal(crossSourceRoomHits(ls), 2);
  });

  test('同名但不同区、或沒有共同站 → 不是候選', () => {
    const otherWard = listing({ src: 'suumo', id: 'suumo:c', name: 'レオパレス翔', ward: '北区', stations: ['大塚'], rooms: [[80000, 20]] });
    const noShared = listing({ src: 'suumo', id: 'suumo:d', name: 'レオパレス翔', ward: '豊島区', stations: ['池袋'], rooms: [[80000, 20]] });
    assert.equal(findCandidates([leo, otherWard]).size, 0);
    assert.equal(findCandidates([leo, noShared]).size, 0);
  });

  test('只有棟層命中（賃料或面積不同／未知）→ 房間層命中 0', () => {
    const s = listing({ src: 'suumo', id: 'suumo:e', name: 'レオパレス翔', ward: '豊島区', stations: ['大塚'], rooms: [[80000, 21], [null, 20], [90000, null]] });
    const c = findCandidates([leo, s]);
    assert.equal(c.size, 1);
    assert.equal(crossSourceRoomHits([...c.values()][0] as Listing[]), 0);
  });

  test('主來源：units 多者優先，同數依自營站優先序', () => {
    assert.equal(pickPrimary([leo, suumoA]).building.id, 'leopalace21:a'); // 2 vs 2 → leopalace21 在 suumo 前
    const big = listing({ src: 'suumo', id: 'suumo:f', name: 'レオパレス翔', ward: '豊島区', stations: ['大塚'], rooms: [[1, 1], [2, 2], [3, 3]] });
    assert.equal(pickPrimary([leo, big]).building.id, 'suumo:f');
  });

  test('全半形・空白・括號差異視為同名（ＬＯＶＩＥ vs LOVIE、クランテラス 品川 vs クランテラス品川）', () => {
    const a = listing({ src: 'hituji', id: 'hituji:x', name: 'クランテラス 品川', ward: '品川区', stations: ['大井町'], rooms: [[70000, 10]] });
    const b = listing({ src: 'tokyosharehouse', id: 'tokyosharehouse:x', name: 'クランテラス品川', ward: '品川区', stations: ['大井町'], rooms: [[70000, 10]] });
    const c2 = listing({ src: 'leopalace21', id: 'leopalace21:y', name: 'ＬＯＶＩＥ麻布十番', ward: '港区', stations: ['麻布十番'], rooms: [[1, 1]] });
    const d = listing({ src: 'suumo', id: 'suumo:y', name: 'LOVIE麻布十番', ward: '港区', stations: ['麻布十番'], rooms: [[1, 1]] });
    assert.equal(findCandidates([a, b, c2, d]).size, 2);
  });
});
