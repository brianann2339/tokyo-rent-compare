import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Wire, Names } from '../src/data.ts';
import { rowsToCsv, csvFileName } from '../src/csv.ts';
import { floorLabel, availLabel } from '../src/data.ts';

/**
 * 最小 Names：建物名與原站 URL 走第二個檔案，以建物序號對齊。
 * CSV 匯出在型別上就要求它——一份沒有物件名與原站連結的 CSV
 * 每列都有數字、看起來完整，使用者不會發現少了什麼。
 */
const makeNames = (name = '測試ハウス'): Names => ({ name: [name], url: ['https://example.test/1'] });
const NAMES = makeNames();

/** 最小 Wire：一棟一間。預設這一間賃料未知（rent=null），其餘可用 over 覆蓋。 */
function makeWire(over: Partial<Wire['u']> = {}): Wire {
  const u: Wire['u'] = {
    bid: [0], room: [null], layout: [-1], area: [null], floor: [null], rent: [null], admin: [null],
    util: [null], utilBasis: [0], key: [null], dep: [null], depNR: [null],
    gender: [0], foreigner: [-1], vacant: [-1],
    monthlyLower: [0], monthlyTier: [2], initCash: [0], initCashTier: [2],
    initSunk: [0], effMonthly12: [0], missing: [1023], flags: [0], ads: [1],
    ...over,
  };
  return {
    meta: {
      generatedAt: '2026-08-23T00:00:00Z', buildId: 'testbuild0000001', buildings: 1, units: 1, provBucket: 500, provDir: 'testbuild0000001',
      sources: [{ id: 'testsrc' }],
      missingBits: ['rent', 'adminFee', 'utilities', 'keyMoney', 'deposit', 'depositNonRefundable',
        'agencyFee', 'guarantorInitialFee', 'fireInsurance', 'renewalFee'],
      violations: 0, flagBits: {},
      dedup: {
        suumoWithin: { before: 1, after: 1, groups: 0, removed: 0, suspectOnly: 0 },
        crossSource: { groups: 0, removedUnits: 0, buildingOnlyCandidates: 0 },
      },
    },
    dict: {
      wards: ['新宿区'], stations: ['新宿', '代々木'], sources: ['testsrc'],
      sourceMeta: { testsrc: { nameZh: '測試來源', homepage: 'https://example.test' } },
      kinds: ['unknown', 'apartment', 'sharehouse', 'social', 'dormitory'],
      layouts: ['1K'], lines: ['JR山手線'], buildingTypes: ['マンション'], pairs: [[0, 0], [0, 1]],
    },
    b: {
      ward: [0], src: [0],
      stn: [0, 1], stw: [5, null], stc: [2], total: [1], fetchedAt: ['2026-08-22'], kind: [1],
      yearBuilt: [2010], also: [0], btype: [0],
    },
    u,
  };
}

const HEADER = [
  '來源', '物件名', '物件名為原站自動生成', '区', '種類', '房型', '面積㎡', '樓層（地下為負數）', '築年',
  '車站1', '徒歩1', '車站2', '徒歩2', '車站3', '徒歩3',
  '賃料', '管理費', '水電', '水電基準',
  '禮金', '敷金', '敷引', '月額下限', '月額區', '初期現金', '初期現金區', '沉沒成本',
  '實質月成本12', '每㎡單價', '缺項', '原站數值可疑', '外國人可租', '性別', '空室', '仲介數', '確認日', '原站URL',
];

/** 每欄都被 " 包住、內部 " 加倍；這個解析只給測試用。 */
function parseLine(line: string): string[] {
  assert.ok(line.startsWith('"') && line.endsWith('"'), `line not fully quoted: ${line}`);
  return line.slice(1, -1).split('","').map((c) => c.replace(/""/g, '"'));
}

function parseCsv(text: string): string[][] {
  assert.equal(text.charCodeAt(0), 0xfeff, 'BOM 開頭');
  const body = text.slice(1);
  assert.ok(body.endsWith('\r\n'), '列尾 CRLF');
  assert.ok(!/[^\r]\n/.test(body), '不可有孤立 LF');
  return body.slice(0, -2).split('\r\n').map(parseLine);
}

function rec(cols: string[]): Record<string, string> {
  assert.equal(cols.length, HEADER.length);
  return Object.fromEntries(HEADER.map((h, k) => [h, cols[k] as string]));
}

describe('rowsToCsv', () => {
  test('BOM 開頭、CRLF、表頭欄序正確', () => {
    const text = rowsToCsv(makeWire(), NAMES, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null });
    const lines = parseCsv(text);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], HEADER);
  });

  test('rent=null：所有金額欄空字串，不是 0', () => {
    const text = rowsToCsv(makeWire(), NAMES, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: 5000 });
    const r = rec(parseCsv(text)[1] as string[]);
    for (const k of ['面積㎡', '樓層（地下為負數）', '賃料', '管理費', '水電', '水電基準', '禮金', '敷金', '敷引', '月額下限',
      '初期現金', '沉沒成本', '實質月成本12', '每㎡單價', '外國人可租', '性別', '空室', '房型', '車站3', '徒歩3', '徒歩2']) {
      assert.equal(r[k], '', `${k} 應為空`);
    }
    assert.equal(r['來源'], '測試來源');
    assert.equal(r['物件名'], '測試ハウス');
    assert.equal(r['区'], '新宿区');
    assert.equal(r['種類'], '一般賃貸');
    assert.equal(r['築年'], '2010');
    assert.equal(r['車站1'], '新宿'); assert.equal(r['徒歩1'], '5');
    assert.equal(r['車站2'], '代々木');
    assert.equal(r['仲介數'], '1');
    assert.equal(r['缺項'], '賃料/管理費/水電/禮金/敷金/敷引/仲介/保證公司/火災保險/更新料');
    assert.equal(r['月額區'], 'C');
    assert.equal(r['初期現金區'], 'C');
    assert.equal(r['確認日'], '2026-08-22');
    assert.equal(r['原站URL'], 'https://example.test/1');
    assert.ok(!text.includes('"0"'), '不可出現 "0" 欄位');
  });

  test('已知值：數字原樣、代碼轉中文、每㎡單價四捨五入', () => {
    const w = makeWire({
      layout: [0], area: [20.5], floor: [3], rent: [80000], admin: [5000], util: [null], utilBasis: [2],
      key: [0], dep: [80000], depNR: [null], gender: [2], foreigner: [1], vacant: [0],
      monthlyLower: [85000], monthlyTier: [0], initCash: [165000], initCashTier: [0],
      initSunk: [0], effMonthly12: [85000], missing: [0], ads: [3],
    });
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 0, key: 85000 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['房型'], '1K');
    assert.equal(r['樓層（地下為負數）'], '3');
    assert.equal(r['仲介數'], '3');
    assert.equal(r['缺項'], '');
    assert.equal(r['面積㎡'], '20.5');
    assert.equal(r['賃料'], '80000');
    assert.equal(r['管理費'], '5000');
    assert.equal(r['水電'], '');
    assert.equal(r['水電基準'], '另計');
    assert.equal(r['禮金'], '0');
    assert.equal(r['敷金'], '80000');
    assert.equal(r['敷引'], '');
    assert.equal(r['月額下限'], '85000');
    assert.equal(r['月額區'], 'A');
    assert.equal(r['初期現金'], '165000');
    assert.equal(r['初期現金區'], 'A');
    assert.equal(r['沉沒成本'], '0');
    assert.equal(r['實質月成本12'], '85000');
    assert.equal(r['每㎡單價'], String(Math.round(85000 / 20.5)));
    assert.equal(r['外國人可租'], '是');
    assert.equal(r['性別'], '女性專用');
    assert.equal(r['空室'], '否');
  });

  test('assumeUtil：水電另計且未知時加進月額下限與每㎡單價；含水電者不加', () => {
    const w = makeWire({
      area: [20], rent: [80000], admin: [5000], util: [null], utilBasis: [2],
      monthlyLower: [85000], monthlyTier: [0], initCash: [85000], initCashTier: [0],
      initSunk: [0], effMonthly12: [85000],
    });
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 0, key: 0 }], { assumeUtil: 10000 }))[1] as string[]);
    assert.equal(r['月額下限'], '95000');
    assert.equal(r['每㎡單價'], '4750');
    const incl = makeWire({
      area: [20], rent: [80000], admin: [5000], util: [null], utilBasis: [1],
      monthlyLower: [85000], monthlyTier: [0], initCash: [85000], initCashTier: [0],
      initSunk: [0], effMonthly12: [85000],
    });
    const r2 = rec(parseCsv(rowsToCsv(incl, NAMES, [{ i: 0, tier: 0, key: 0 }], { assumeUtil: 10000 }))[1] as string[]);
    assert.equal(r2['月額下限'], '85000');
    assert.equal(r2['水電基準'], '含');
  });

  test('B 區（費用不全）：月額有值但每㎡單價留空', () => {
    const w = makeWire({
      area: [20], rent: [80000], admin: [null], utilBasis: [0],
      monthlyLower: [80000], monthlyTier: [1], initCash: [80000], initCashTier: [1],
      initSunk: [0], effMonthly12: [80000],
    });
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 1, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['月額下限'], '80000');
    assert.equal(r['月額區'], 'B');
    assert.equal(r['每㎡單價'], '');
    assert.equal(r['管理費'], '');
  });

  test('欄內 " 加倍、逗號與換行被引號包住', () => {
    const w = makeWire();
    const text = rowsToCsv(w, makeNames('He said "hi", ok\nnext'), [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null });
    assert.ok(text.includes('"He said ""hi"", ok\nnext"'));
    const r = rec(parseCsv(text.replace('ok\nnext', 'ok next'))[1] as string[]);
    assert.equal(r['物件名'], 'He said "hi", ok next');
  });

  test('rows 為空：只有表頭', () => {
    const lines = parseCsv(rowsToCsv(makeWire(), NAMES, [], { assumeUtil: null }));
    assert.equal(lines.length, 1);
  });
});

describe('csvFileName', () => {
  test('tokyo-rent-YYYYMMDD-n.csv，月日補零', () => {
    assert.equal(csvFileName(123, new Date(2026, 7, 23)), 'tokyo-rent-20260823-123.csv');
    assert.equal(csvFileName(0, new Date(2026, 0, 5)), 'tokyo-rent-20260105-0.csv');
  });
  test('不給日期時用今天', () => {
    assert.match(csvFileName(42), /^tokyo-rent-\d{8}-42\.csv$/);
  });
});

describe('樓層顯示', () => {
  test('地上照印，地下還原成 BNF', () => {
    assert.equal(floorLabel(1), '1F');
    assert.equal(floorLabel(14), '14F');
    assert.equal(floorLabel(-1), 'B1F');
    assert.equal(floorLabel(-2), 'B2F');
  });
  test('0 不會變成 B0F', () => {
    assert.equal(floorLabel(0), '0F');
  });
});

describe('可入住時間顯示', () => {
  test('随時／ISO 日期／Couverture 不寫年份的 --MM-DD', () => {
    assert.equal(availLabel('随時'), '隨時可入住');
    assert.equal(availLabel('2026-11-05'), '2026-11-05 起');
    assert.equal(availLabel('--11-12'), '11 月 12 日起（原站未寫年份）');
  });
  test('未知不顯示——不可以把「沒資料」說成任何時間', () => {
    assert.equal(availLabel(null), null);
    assert.equal(availLabel(undefined), null);
    assert.equal(availLabel(''), null);
  });
});

describe('SUUMO 的樣板名稱在 CSV 裡要標出來', () => {
  test('樣板名：原文照留，另一欄標 Y', () => {
    const w = makeWire();
    const n = makeNames('東急田園都市線 二子玉川駅 地下1地上3階建 築21年');
    const r = rec(parseCsv(rowsToCsv(w, n, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['物件名'], '東急田園都市線 二子玉川駅 地下1地上3階建 築21年', '原文不可以被改寫');
    assert.equal(r['物件名為原站自動生成'], 'Y');
  });

  test('真名：那一欄留空', () => {
    const r = rec(parseCsv(rowsToCsv(makeWire(), makeNames('レオパレス翔'), [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['物件名'], 'レオパレス翔');
    assert.equal(r['物件名為原站自動生成'], '');
  });
});

describe('站名／路線用比對鍵找序號（2026-10-17）', () => {
  test('使用者打的寫法與字典顯示名不同仍找得到；完全不同的站找不到', async () => {
    const { stationIndexOf, lineIndexOf } = await import('../src/data.ts');
    const st = ['阿佐ケ谷', '大塚', '浅草橋'];
    assert.equal(stationIndexOf(st, '阿佐ヶ谷'), 0);
    assert.equal(stationIndexOf(st, '大塚(東京)'), 1);
    assert.equal(stationIndexOf(st, '浅草'), -1, '浅草 ≠ 浅草橋');
    const ln = ['JR山手線', '東京メトロ丸ノ内線'];
    assert.equal(lineIndexOf(ln, 'ＪＲ山手線'), 0, '舊分享連結帶全形 ＪＲ');
    assert.equal(lineIndexOf(ln, '東京地下鉄丸ノ内線'), 1);
    assert.equal(lineIndexOf(ln, '西武新宿線'), -1);
  });
});

describe('rowsToCsv：原站自己寫錯的值', () => {
  /** build-data 的 FLAG（只放這裡用得到的位元） */
  const FLAG_BITS = {
    invariantViolation: 1024, rentSuspect: 2048, areaSuspect: 4096, initialSuspect: 8192,
    adminSuspect: 16384, sunkSuspect: 32768, walkYearSuspect: 65536,
  };
  const withFlags = (w: Wire): Wire => ({ ...w, meta: { ...w.meta, flagBits: FLAG_BITS } });

  test('賃料 ￥1（ひつじ REVE 吉祥寺 203）：賃料欄照原文，月額等加總欄留空，標出「賃料」', () => {
    const w = withFlags(makeWire({
      area: [8.6], rent: [1], admin: [0], key: [0], dep: [0],
      monthlyLower: [1], monthlyTier: [2], initCash: [0], initCashTier: [2], effMonthly12: [1],
      missing: [0], flags: [1024 | 2048],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 2, key: 1 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['賃料'], '1', '原站寫的數字照原文保留');
    assert.equal(r['月額下限'], '', '由不可信的賃料加總出來的月額不寫');
    assert.equal(r['實質月成本12'], '');
    assert.equal(r['每㎡單價'], '');
    assert.equal(r['月額區'], 'C');
    assert.equal(r['原站數值可疑'], '賃料');
  });

  test('面積 60000㎡：面積欄照原文、不算每㎡單價、標出「面積」', () => {
    const w = withFlags(makeWire({
      area: [60000], rent: [80000], admin: [5000], key: [0], dep: [0],
      monthlyLower: [85000], monthlyTier: [0], initCash: [0], initCashTier: [0], effMonthly12: [85000],
      missing: [0], flags: [1024 | 4096],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 0, key: 85000 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['面積㎡'], '60000');
    assert.equal(r['每㎡單價'], '');
    assert.equal(r['月額下限'], '85000', '賃料可信時月額照常');
    assert.equal(r['原站數值可疑'], '面積');
  });

  test('只有棟層的徒歩分違反：標「徒歩／築年」，其餘欄照常', () => {
    const w = withFlags(makeWire({
      area: [20], rent: [80000], admin: [0], monthlyLower: [80000], monthlyTier: [0], initCashTier: [0],
      effMonthly12: [80000], missing: [0], flags: [1024 | 65536],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 0, key: 80000 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['原站數值可疑'], '徒歩／築年');
    assert.equal(r['每㎡單價'], String(Math.round(80000 / 20)));
  });

  test('賃料與徒歩分同時違反：兩個都標，不會只剩賃料', () => {
    const w = withFlags(makeWire({
      area: [20], rent: [1], admin: [0], monthlyLower: [1], monthlyTier: [2], initCashTier: [2],
      effMonthly12: [1], missing: [0], flags: [1024 | 2048 | 65536],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 2, key: 1 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['原站數值可疑'], '賃料/徒歩／築年');
  });

  test('舊索引沒有細分位元：只說「有」，不猜是哪一欄', () => {
    const w: Wire = { ...makeWire({ rent: [1], monthlyLower: [1], flags: [1024] }), meta: { ...makeWire().meta, flagBits: { invariantViolation: 1024 } } };
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 2, key: 1 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['原站數值可疑'], '有（細目見網站費用拆解）');
  });

  test('只有管理費可疑（同棟另一列是十分之一）：月額留空，初期現金照寫——初期費用不含管理費', () => {
    const w = withFlags(makeWire({
      area: [21.45], rent: [113500], admin: [75000], key: [113500], dep: [113500], depNR: [0],
      monthlyLower: [188500], monthlyTier: [2], initCash: [340500], initCashTier: [1], initSunk: [227000],
      effMonthly12: [207417], missing: [0], flags: [1024 | 16384],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['管理費'], '75000', '原文照留');
    assert.equal(r['月額下限'], '');
    assert.equal(r['實質月成本12'], '');
    assert.equal(r['初期現金'], '340500');
    assert.equal(r['初期現金區'], 'B');
    assert.equal(r['沉沒成本'], '227000');
    assert.equal(r['原站數值可疑'], '管理費');
  });

  test('礼金可疑（279 万＝10 個月）：初期費用與實質月成本留空、區寫 C，月額照寫', () => {
    const w = withFlags(makeWire({
      area: [60], rent: [279000], admin: [0], key: [2790000], dep: [279000], depNR: [0],
      monthlyLower: [279000], monthlyTier: [0], initCash: [3069000], initCashTier: [2], initSunk: [2790000],
      effMonthly12: [511500], missing: [0], flags: [1024 | 8192 | 32768],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['禮金'], '2790000', '原文照留');
    assert.equal(r['初期現金'], '');
    assert.equal(r['初期現金區'], 'C');
    assert.equal(r['沉沒成本'], '');
    assert.equal(r['實質月成本12'], '', '實質月成本攤進了可疑的礼金');
    assert.equal(r['月額下限'], '279000');
    assert.equal(r['原站數值可疑'], '初期費用');
  });

  test('只有敷金可疑：初期現金留空，實質月成本照寫——敷金可退，沒攤進實質月成本', () => {
    const w = withFlags(makeWire({
      area: [60], rent: [290000], admin: [0], key: [0], dep: [8410000], depNR: [0],
      monthlyLower: [290000], monthlyTier: [0], initCash: [8410000], initCashTier: [2], initSunk: [0],
      effMonthly12: [290000], missing: [0], flags: [1024 | 8192],
    }));
    const r = rec(parseCsv(rowsToCsv(w, NAMES, [{ i: 0, tier: 0, key: 290000 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['初期現金'], '');
    assert.equal(r['實質月成本12'], '290000');
  });

  test('沒有任何旗標：欄位空白', () => {
    const r = rec(parseCsv(rowsToCsv(withFlags(makeWire()), NAMES, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['原站數值可疑'], '');
  });
});
