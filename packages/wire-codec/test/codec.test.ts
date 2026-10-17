import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeIndex, decodeIndex, assertLossless, tvEnc, tvDec, zig, unzig, dictEnc, dictDec,
  type ColumnIndex,
} from '../src/index.ts';

/**
 * 這個檔案的重點不是「壓縮有沒有變小」，而是「壓縮有沒有偷偷改掉數字」。
 *
 * 獨立審查在原型上實測出 16 種未來可能出現的資料形狀，其中 **13 種是安靜地把數字改掉
 * 而不是報錯**（null→0、72000.5→77999、rent=−1→null、area=−0.01→null、3e9→852516352…）。
 * 那正是本專案最高原則要防的事，只是發生位置從解析器換成了編碼器。
 * 下面每一條 `assert.throws` 都對應一個那樣的形狀。
 */

/** 一棟兩間的最小索引；用 over 覆蓋單一欄位來製造危險形狀。 */
function makeIndex(over: Partial<Record<string, unknown[]>> = {}): ColumnIndex {
  const u: Record<string, unknown[]> = {
    bid: [0, 0], room: ['101', null], layout: [0, 1], area: [20.5, 33], floor: [1, 2],
    rent: [80000, 120000], admin: [5000, 8000], util: [null, null], utilBasis: [2, 2],
    key: [80000, 0], dep: [160000, null], depNR: [null, null],
    gender: [1, 1], foreigner: [-1, 1], vacant: [1, 1],
    monthlyLower: [85000, 128000], monthlyTier: [0, 0],
    initCash: [240000, 0], initCashTier: [0, 1],
    initSunk: [80000, 0], effMonthly12: [91667, 128000],
    missing: [0, 3], flags: [0, 4], ads: [1, 2],
    ...over,
  };
  return {
    meta: { units: 2, buildings: 1, provBucket: 400 },
    dict: { wards: ['文京区'], stations: ['本郷三丁目', '春日'], sources: ['suumo'], kinds: ['unknown', 'apartment'], layouts: ['1K', '1LDK'], lines: ['丸ノ内線'], pairs: [[0, 0]] },
    b: {
      // name／url 自 C3 起不在索引裡，改由 names.json.gz 供應（見 names.test.ts）
      ward: [0], src: [0],
      stn: [0, 1], stw: [5, null], stc: [2], total: [10], fetchedAt: ['2026-09-06'],
      kind: [1], yearBuilt: [2015], also: [0], btype: [0],
    },
    u,
  };
}

const roundTrip = (idx: ColumnIndex): ColumnIndex => decodeIndex(JSON.parse(JSON.stringify(encodeIndex(idx))));

/**
 * 多棟、多区、站數不一（含 0 站）的索引。C4 的兩個新手法——站名存「区內名次」、
 * 每棟第一間與其餘各間分兩串——只有在棟與区都不只一個時才會真的被走到。
 */
function makeMulti(bid: number[] = [0, 0, 0, 1, 2, 2, 3]): ColumnIndex {
  const n = bid.length;
  const pick = <T>(xs: readonly T[]): T[] => Array.from({ length: n }, (_, i) => xs[i % xs.length] as T);
  const rent = pick([80000, 80000, 81000, null, 120000, 118000, 55000]);
  const admin = pick([5000, 5000, 5000, 0, null, 8000, 3000]);
  const key = rent.map((r, i) => (i % 3 === 0 ? r : 0));
  const dep = rent.map((r, i) => (i % 2 === 0 ? r : null));
  const z = (v: number | null): number => v ?? 0;
  const monthlyLower = rent.map((r, i) => z(r) + z(admin[i] as number | null));
  const initCash = key.map((k, i) => z(k) + z(dep[i] as number | null));
  const initSunk = key.map((k) => z(k));
  return {
    meta: { units: n, buildings: 4, provBucket: 400 },
    dict: { wards: ['文京区', '港区', '新宿区'], stations: ['A', 'B', 'C', 'D', 'E'], sources: ['suumo'], kinds: ['unknown', 'apartment'], layouts: ['1K', '1LDK', 'ドミトリー'], lines: [], pairs: [] },
    b: {
      ward: [0, 1, 0, 2], src: [0, 0, 0, 0],
      // 第 0 棟 3 站、第 1 棟 0 站、第 2 棟 2 站、第 3 棟 1 站；站 3 在文京区出現 2 次、港区 0 次
      stc: [3, 0, 2, 1], stn: [3, 0, 1, 3, 4, 2], stw: [5, 12, null, 7, 3, 20],
      total: [10, null, 4, 30], fetchedAt: ['2026-10-17', '2026-10-17', '2026-08-16', '2026-10-17'],
      kind: [1, 1, 1, 1], yearBuilt: [2015, null, 1999, 2024], also: [0, 0, 0, 0], btype: [0, -1, 0, 0],
    },
    u: {
      bid, room: pick(['101', null, '203']), layout: pick([0, 0, 1, 2, 0]), area: pick([20.5, 20.5, 21.37, null, 33, 9.66746, 25]),
      floor: pick([1, 1, 2, -1, 3]), rent, admin, util: pick([null]), utilBasis: pick([2]),
      key, dep, depNR: pick([null]), gender: pick([1]), foreigner: pick([-1, 1]), vacant: pick([1]),
      monthlyLower, monthlyTier: pick([0, 1]), initCash, initCashTier: pick([0]),
      initSunk, effMonthly12: monthlyLower.map((m, i) => m + Math.round((initSunk[i] as number) / 12)),
      missing: pick([0, 0, 3, 8]), flags: pick([0, 4]), ads: pick([1, 1, 2]),
    },
  };
}

describe('無損往返', () => {
  test('每一格都用 Object.is 比對（分得出 0 與 −0）', () => {
    const idx = makeIndex();
    const { cells } = assertLossless(idx, roundTrip(idx));
    assert.ok(cells > 30, `應該比對到所有格，實際 ${cells}`);
  });

  test('null 與 0 是兩件事，不可互換', () => {
    const idx = makeIndex({
      rent: [80000, null], admin: [0, null], key: [0, null], dep: [null, 0],
      area: [null, 0.5], floor: [null, 0],
      monthlyLower: [80000, 0], initCash: [0, 0], initSunk: [0, 0], effMonthly12: [80000, 0],
    });
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.equal(back.u['rent']?.[1], null);
    assert.equal(back.u['admin']?.[0], 0);
    assert.equal(back.u['area']?.[0], null);
    assert.equal(back.u['dep']?.[1], 0);
  });

  test('C4：多棟多区（含 0 站的棟）——区內名次與每棟第一間分串都原樣還原', () => {
    const idx = makeMulti();
    const back = roundTrip(idx);
    const { cells } = assertLossless(idx, back);
    assert.ok(cells > 100, `cells ${cells}`);
    assert.deepEqual(back.b['stn'], [3, 0, 1, 3, 4, 2]);
    assert.deepEqual(back.u['area'], idx.u['area']);
  });

  test('C4：bid 不遞增（不存 uc、改存 bid）時分串照樣對得上', () => {
    const idx = makeMulti([0, 1, 0, 2, 2, 3, 0]);
    assertLossless(idx, roundTrip(idx));
  });

  test('C4：同一份資料編兩次結果完全相同（排序是全序，不受 Map 插入順序影響）', () => {
    assert.equal(JSON.stringify(encodeIndex(makeMulti())), JSON.stringify(encodeIndex(makeMulti())));
  });

  test('C4：站序號不是非負整數 → 拒絕編碼', () => {
    const idx = makeMulti();
    idx.b['stn'] = [3, 0, 1.5, 3, 4, 2];
    assert.throws(() => encodeIndex(idx), /b\.stn\[2\]/);
    idx.b['stn'] = [3, 0, null, 3, 4, 2];
    assert.throws(() => encodeIndex(idx), /b\.stn\[2\]/);
  });

  test('C4：站數合計與站欄長度不符 → 拒絕編碼', () => {
    const idx = makeMulti();
    idx.b['stc'] = [3, 0, 2, 2];
    assert.throws(() => encodeIndex(idx), /b\.stc 合計 7，b\.stn 有 6 格/);
  });

  test('C4：区內名次被竄改成超出站表 → 拒絕解碼，不回一個 undefined 當站名', () => {
    const e = encodeIndex(makeMulti());
    const bad = structuredClone(e);
    bad.stn.c = tvEnc([0, 0, 0, 0, 0, 99]);
    assert.throws(() => decodeIndex(bad), /区內名次 99 超出該区站表/);
  });

  test('C4：分串欄位的「與前一間相同」碼——同棟連續相同、不同、null 交錯都原樣還原', () => {
    const idx = makeMulti();
    idx.u['admin'] = [5000, 5000, null, 0, null, null, 3000];
    idx.u['monthlyLower'] = (idx.u['rent'] as Array<number | null>).map((r, i) => (r ?? 0) + ((idx.u['admin'] as Array<number | null>)[i] ?? 0));
    idx.u['effMonthly12'] = (idx.u['monthlyLower'] as number[]).map((m, i) => m + Math.round(((idx.u['initSunk'] as number[])[i] as number) / 12));
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.deepEqual(back.u['admin'], [5000, 5000, null, 0, null, null, 3000]);
  });

  test('C4：分串欄位的字典碼被竄改成超出字典 → 拒絕解碼', () => {
    const e = encodeIndex(makeMulti());
    const bad = structuredClone(e);
    const blk = bad.split['u.admin'] as { r: { d: unknown[]; c: string } };
    blk.r.c = tvEnc(new Array(3).fill(99));
    assert.throws(() => decodeIndex(bad), /字典碼 98 超出字典/);
  });

  test('賃料非半整數倍的敷金／礼金走例外表，值原樣保留', () => {
    const idx = makeIndex({ key: [33333, 1], dep: [7, 99999], initCash: [33340, 100000], initSunk: [33333, 1] });
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.deepEqual(back.u['key'], [33333, 1]);
    assert.deepEqual(back.u['dep'], [7, 99999]);
  });

  test('面積小數位超過 2 位時走例外表而不是四捨五入', () => {
    const idx = makeIndex({ area: [9.66746, 20.005] });
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.equal(back.u['area']?.[0], 9.66746, '不可被 ×100 四捨五入成 9.67');
    assert.equal(back.u['area']?.[1], 20.005);
  });

  test('派生欄位不符合預測公式時，殘差把它救回原值', () => {
    // monthlyLower 故意不等於 rent+admin+util
    const idx = makeIndex({ monthlyLower: [999999, 1] });
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.deepEqual(back.u['monthlyLower'], [999999, 1]);
  });

  test('bid 非遞增時退回原樣存整欄', () => {
    const idx = makeIndex({ bid: [1, 0] });
    idx.b['ward'] = [0, 0]; idx.b['src'] = [0, 0];
    idx.b['stn'] = [0, 1]; idx.b['stw'] = [5, 5]; idx.b['stc'] = [1, 1];
    idx.b['total'] = [1, 1]; idx.b['fetchedAt'] = ['2026-09-06', '2026-09-06'];
    idx.b['kind'] = [1, 1]; idx.b['yearBuilt'] = [2015, 2016]; idx.b['also'] = [0, 0];
    idx.b['btype'] = [0, 0];
    const back = roundTrip(idx);
    assertLossless(idx, back);
    assert.deepEqual(back.u['bid'], [1, 0]);
  });
});

describe('危險形狀一律大聲失敗，絕不靜默改值', () => {
  const cases: Array<[string, Partial<Record<string, unknown[]>>, RegExp]> = [
    ['賃料是小數（原型會變成 77999）', { rent: [72000.5, 120000] }, /tvEnc|整數/],
    ['管理費是小數（會污染 monthlyLower）', { admin: [3000.5, 8000] }, /整數|tvEnc/],
    ['賃料剛好等於 null 哨兵 −1', { rent: [-1, 120000] }, /哨兵相撞/],
    ['面積 −0.01（×100 後撞上 null 哨兵）', { area: [-0.01, 33] }, /哨兵/],
    ['面積 −0.02（×100 後撞上例外哨兵）', { area: [-0.02, 33] }, /哨兵/],
    ['派生欄位是 null（原型會變成 0）', { monthlyLower: [null, 128000] }, /派生欄位必須是有限數字/],
    ['派生欄位是 undefined', { initCash: [undefined, 0] }, /派生欄位必須是有限數字/],
    ['派生欄位是 NaN', { initSunk: [Number.NaN, 0] }, /派生欄位必須是有限數字/],
    ['賃料是字串', { rent: ['80000', 120000] }, /應為數字或 null/],
    ['賃料是 Infinity', { rent: [Number.POSITIVE_INFINITY, 120000] }, /應為數字或 null/],
    ['殘差大到超過 2^32（原型會 mod 迴繞）', { monthlyLower: [3e9, 128000] }, /tvEnc/],
  ];
  for (const [name, over, re] of cases) {
    test(name, () => {
      assert.throws(() => encodeIndex(makeIndex(over)), re, `${name} 應該丟例外而不是靜默改值`);
    });
  }

  test('敷金／礼金大量不合半整數倍時，倍數編碼要放棄而不是硬撐', () => {
    const n = 100;
    const arr = <T>(f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
    const idx = makeIndex();
    idx.u['bid'] = arr(() => 0);
    for (const k of ['room', 'layout', 'floor', 'admin', 'util', 'utilBasis', 'depNR', 'gender',
      'foreigner', 'vacant', 'monthlyTier', 'initCashTier', 'missing', 'flags', 'ads']) {
      const v = idx.u[k]?.[0] ?? null;
      idx.u[k] = arr(() => v);
    }
    idx.u['rent'] = arr(() => 80000);
    idx.u['area'] = arr(() => 20);
    idx.u['key'] = arr((i) => 1 + i);          // 全部都不是 80000 的半整數倍
    idx.u['dep'] = arr(() => 0);
    idx.u['monthlyLower'] = arr(() => 80000);
    idx.u['initCash'] = arr((i) => 1 + i);
    idx.u['initSunk'] = arr((i) => 1 + i);
    idx.u['effMonthly12'] = arr((i) => 80000 + Math.round((1 + i) / 12));
    idx.meta['units'] = n;
    assert.throws(() => encodeIndex(idx), /已失去意義/);
  });

  test('把 name／url 塞回索引 → 拒絕編碼（它們自 C3 起屬於 names.json.gz）', () => {
    const idx = makeIndex();
    idx.b['name'] = ['テスト荘'];
    assert.throws(() => encodeIndex(idx), /自 C3 起不進索引/);
  });

  test('棟層欄位長度不一致 → 拒絕編碼（那是序號錯位的源頭）', () => {
    const idx = makeIndex();
    idx.b['ward'] = [0, 0];
    assert.throws(() => encodeIndex(idx), /棟層欄位必須等長/);
  });

  test('解碼器只讀 C4，認不得的版本要停下來而不是解出半個索引', () => {
    const e = encodeIndex(makeIndex());
    assert.throws(() => decodeIndex({ ...e, v: 'C3' as 'C4' }), /只讀 C4/);
  });

  test('assertLossless 抓得到被竄改的一格', () => {
    const idx = makeIndex();
    const back = roundTrip(idx);
    (back.u['rent'] as unknown[])[0] = 80001;
    assert.throws(() => assertLossless(idx, back), /u\.rent\[0\]/);
  });

  test('assertLossless 分得出 0 與 −0', () => {
    const idx = makeIndex({ admin: [0, 8000] });
    const back = roundTrip(idx);
    (back.u['admin'] as unknown[])[0] = -0;
    assert.throws(() => assertLossless(idx, back), /u\.admin\[0\]/);
  });
});

describe('底層編碼器', () => {
  test('tvEnc/tvDec 往返涵蓋邊界值', () => {
    const vals = [0, 1, 31, 32, 1023, 1024, 65535, 16777215, 4294967295];
    assert.deepEqual(tvDec(tvEnc(vals), vals.length), vals);
  });
  test('tvEnc 拒絕小數、負數、≥2^32', () => {
    assert.throws(() => tvEnc([1.5]), /整數/);
    assert.throws(() => tvEnc([-1]), /整數/);
    assert.throws(() => tvEnc([4294967296]), /整數/);
  });
  test('zigzag 往返', () => {
    for (const v of [0, 1, -1, 2, -2, 1000, -1000, 2147483647, -2147483648]) {
      assert.equal(unzig(zig(v)), v, `zigzag ${v}`);
    }
    assert.throws(() => zig(1.5), /整數/);
  });
  test('dictEnc 保留值的型別（null、字串、數字混用）', () => {
    const vals = [null, 'a', 3, null, 'a', 0];
    const back = dictDec(dictEnc(vals), vals.length);
    for (let i = 0; i < vals.length; i++) assert.ok(Object.is(back[i], vals[i]), `第 ${i} 格 ${String(vals[i])}`);
  });

  test('−0 存不住，但那是 JSON 的限制、且 assertLossless 會擋下來', () => {
    // JSON.stringify(-0) === '0'，所以 index.json 從來就不可能帶著 −0 出去；
    // 真正重要的是「萬一記憶體裡有 −0，不能默默變成 0」——assertLossless 用 Object.is 就是為此。
    assert.equal(JSON.stringify(-0), '0');
    assert.ok(!Object.is(JSON.parse(JSON.stringify([-0]))[0], -0));
    const idx = makeIndex({ admin: [-0, 8000] });
    assert.throws(() => assertLossless(idx, roundTrip(idx)), /u\.admin\[0\]/,
      '−0 進到索引時要讓建置失敗，不可默默寫成 0');
  });
});
