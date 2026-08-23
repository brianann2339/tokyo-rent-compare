import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Wire } from '../src/data.ts';
import { rowsToCsv, csvFileName } from '../src/csv.ts';

/** 最小 Wire：一棟一間。預設這一間賃料未知（rent=null），其餘可用 over 覆蓋。 */
function makeWire(over: Partial<Wire['u']> = {}, name = '測試ハウス'): Wire {
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
      generatedAt: '2026-08-23T00:00:00Z', buildings: 1, units: 1, provBucket: 500,
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
      layouts: ['1K'], lines: ['JR山手線'], pairs: [[0, 0], [0, 1]],
    },
    b: {
      name: [name], url: ['https://example.test/1'], ward: [0], src: [0],
      stn: [0, 1], stw: [5, null], stc: [2], total: [1], fetchedAt: ['2026-08-22'], kind: [1],
      yearBuilt: [2010], also: [0],
    },
    u,
  };
}

const HEADER = [
  '來源', '物件名', '区', '種類', '房型', '面積㎡', '樓層', '築年',
  '車站1', '徒歩1', '車站2', '徒歩2', '車站3', '徒歩3',
  '賃料', '管理費', '水電', '水電基準',
  '禮金', '敷金', '敷引', '月額下限', '月額區', '初期現金', '初期現金區', '沉沒成本',
  '實質月成本12', '每㎡單價', '缺項', '外國人可租', '性別', '空室', '仲介數', '確認日', '原站URL',
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
    const text = rowsToCsv(makeWire(), [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null });
    const lines = parseCsv(text);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], HEADER);
  });

  test('rent=null：所有金額欄空字串，不是 0', () => {
    const text = rowsToCsv(makeWire(), [{ i: 0, tier: 2, key: 0 }], { assumeUtil: 5000 });
    const r = rec(parseCsv(text)[1] as string[]);
    for (const k of ['面積㎡', '樓層', '賃料', '管理費', '水電', '水電基準', '禮金', '敷金', '敷引', '月額下限',
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
    const r = rec(parseCsv(rowsToCsv(w, [{ i: 0, tier: 0, key: 85000 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['房型'], '1K');
    assert.equal(r['樓層'], '3');
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
    const r = rec(parseCsv(rowsToCsv(w, [{ i: 0, tier: 0, key: 0 }], { assumeUtil: 10000 }))[1] as string[]);
    assert.equal(r['月額下限'], '95000');
    assert.equal(r['每㎡單價'], '4750');
    const incl = makeWire({
      area: [20], rent: [80000], admin: [5000], util: [null], utilBasis: [1],
      monthlyLower: [85000], monthlyTier: [0], initCash: [85000], initCashTier: [0],
      initSunk: [0], effMonthly12: [85000],
    });
    const r2 = rec(parseCsv(rowsToCsv(incl, [{ i: 0, tier: 0, key: 0 }], { assumeUtil: 10000 }))[1] as string[]);
    assert.equal(r2['月額下限'], '85000');
    assert.equal(r2['水電基準'], '含');
  });

  test('B 區（費用不全）：月額有值但每㎡單價留空', () => {
    const w = makeWire({
      area: [20], rent: [80000], admin: [null], utilBasis: [0],
      monthlyLower: [80000], monthlyTier: [1], initCash: [80000], initCashTier: [1],
      initSunk: [0], effMonthly12: [80000],
    });
    const r = rec(parseCsv(rowsToCsv(w, [{ i: 0, tier: 1, key: 0 }], { assumeUtil: null }))[1] as string[]);
    assert.equal(r['月額下限'], '80000');
    assert.equal(r['月額區'], 'B');
    assert.equal(r['每㎡單價'], '');
    assert.equal(r['管理費'], '');
  });

  test('欄內 " 加倍、逗號與換行被引號包住', () => {
    const w = makeWire({}, 'He said "hi", ok\nnext');
    const text = rowsToCsv(w, [{ i: 0, tier: 2, key: 0 }], { assumeUtil: null });
    assert.ok(text.includes('"He said ""hi"", ok\nnext"'));
    const r = rec(parseCsv(text.replace('ok\nnext', 'ok next'))[1] as string[]);
    assert.equal(r['物件名'], 'He said "hi", ok next');
  });

  test('rows 為空：只有表頭', () => {
    const lines = parseCsv(rowsToCsv(makeWire(), [], { assumeUtil: null }));
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
