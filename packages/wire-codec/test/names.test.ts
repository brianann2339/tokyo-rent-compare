import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeNames, decodeNames, assertNamesLossless,
  type NamesTable, type EncodedNames,
} from '../src/names.ts';

/**
 * 這個檔案要防的不是「壓縮有沒有變小」，是**序號錯位**與**字串被改寫**。
 *
 * 錯開一格，全站每張卡片都會掛上另一棟的名字、「前往原站」連到另一棟的頁面，
 * 而且完全沒有錯誤訊息——那比解析錯誤更糟，因為結果看起來完全合理。
 */

const BID = 'abc123def4567890';
const rt = (t: NamesTable): NamesTable => decodeNames(JSON.parse(JSON.stringify(encodeNames(t, BID))) as EncodedNames);

/** SUUMO 樣板句與真名交錯——錯位一定會在這種排列上現形 */
const MIXED: NamesTable = {
  name: [
    '東急田園都市線 二子玉川駅 地下1地上3階建 築21年',
    'パークアベニュー桜丘',
    '京王線 笹塚駅 2階建 築22年',
    'レオパレス翔',
    'ＪＲ中央線 高円寺駅 2階建 新築',
    '東京都台東区清川１ 10階建 築2年',
    'クランテラス 品川',
    '京成押上線 四ツ木駅 2階建 築99年以上',
  ],
  url: [
    'https://suumo.jp/chintai/jnc_000109401145/',
    'https://www.oakhouse.jp/apartment/14493',
    'https://suumo.jp/chintai/jnc_000000000001/',
    'https://www.leopalace21.com/properties/common/tokyo/x/y',
    'https://suumo.jp/chintai/jnc_000109207432/',
    'https://suumo.jp/chintai/jnc_000107626130/',
    'https://tokyosharehouse.com/jpn/house/detail/2745/',
    'https://suumo.jp/chintai/jnc_000109999999/',
  ],
};

describe('無損往返', () => {
  test('樣板與真名交錯時，每一格都回到原位', () => {
    const back = rt(MIXED);
    const { cells } = assertNamesLossless(MIXED, back);
    assert.equal(cells, 16, '8 棟 × 2 欄');
    assert.deepEqual(back.name, MIXED.name);
    assert.deepEqual(back.url, MIXED.url);
  });

  test('「築99年以上」原封不動——壓成「築99年」等於替原站斷言一個它沒說的屋齡', () => {
    const t: NamesTable = { name: ['京成押上線 四ツ木駅 2階建 築99年以上'], url: ['u'] };
    assert.equal(rt(t).name[0], '京成押上線 四ツ木駅 2階建 築99年以上');
  });

  test('「地上」這兩個字不會在往返中消失', () => {
    const t: NamesTable = {
      name: ['西武池袋線 大泉学園駅 地上2階建 新築', '西武池袋線 大泉学園駅 2階建 新築'],
      url: ['a', 'b'],
    };
    const back = rt(t);
    assert.equal(back.name[0], '西武池袋線 大泉学園駅 地上2階建 新築');
    assert.equal(back.name[1], '西武池袋線 大泉学園駅 2階建 新築');
    assert.notEqual(back.name[0], back.name[1], '兩種寫法不可以被壓成同一個');
  });

  test('URL 的前導零一格都不能少（實測 86,755 筆裡 84,159 筆帶前導零）', () => {
    const t: NamesTable = { name: ['x'], url: ['https://suumo.jp/chintai/jnc_000000000001/'] };
    assert.equal(rt(t).url[0], 'https://suumo.jp/chintai/jnc_000000000001/');
  });

  test('空表', () => {
    const back = rt({ name: [], url: [] });
    assert.deepEqual(back, { name: [], url: [] });
  });

  test('全部是樣板 / 全部是真名，兩個極端都不會錯位', () => {
    const allTpl: NamesTable = { name: ['A線 B駅 3階建 新築', 'C線 D駅 4階建 築5年'], url: ['1', '2'] };
    const allLit: NamesTable = { name: ['メゾンA', 'メゾンB'], url: ['1', '2'] };
    assert.deepEqual(rt(allTpl).name, allTpl.name);
    assert.deepEqual(rt(allLit).name, allLit.name);
  });
});

describe('還原不回去的形狀一律退回字面值，不硬套結構', () => {
  const cases: Array<[string, string]> = [
    ['前後有空白', ' A線 B駅 3階建 新築 '],
    ['連續兩個空白', 'A線  B駅 3階建 新築'],
    ['第 3 段不是階建', 'エスト・フォンティーヌ　ＳＲＣ造１０階建て賃貸マンション'],
    ['只有 2 段', 'A線 B駅'],
    ['有 5 段', 'A線 B駅 3階建 新築 おまけ'],
    ['全形空白不是分隔符', 'A線　B駅　3階建　新築'],
    ['空字串', ''],
    ['只有空白', '   '],
  ];
  for (const [label, name] of cases) {
    test(`${label}：${JSON.stringify(name)} 原樣保留`, () => {
      const t: NamesTable = { name: [name], url: ['u'] };
      const back = rt(t);
      assert.ok(Object.is(back.name[0], name), `應原樣保留，實際 ${JSON.stringify(back.name[0])}`);
    });
  }

  test('非字串的名稱不會被當成樣板', () => {
    // undefined 過不了 JSON（陣列裡會變 null），所以只測 JSON 能表達的型別
    const t: NamesTable = { name: [null, 123, ''], url: ['a', 'b', 'c'] };
    const back = rt(t);
    assert.ok(Object.is(back.name[0], null));
    assert.ok(Object.is(back.name[1], 123));
    assert.ok(Object.is(back.name[2], ''));
  });
});

describe('對不上就大聲失敗，絕不安靜地錯位', () => {
  test('name 與 url 不等長 → 編碼就拒絕', () => {
    assert.throws(() => encodeNames({ name: ['a', 'b'], url: ['a'] }, BID), /必須等長/);
  });

  test('buildId 是空的 → 拒絕（沒有它就證明不了兩檔同源）', () => {
    assert.throws(() => encodeNames({ name: [], url: [] }, ''), /buildId 不可為空/);
  });

  test('版本不對 → 拒絕解碼', () => {
    const e = encodeNames(MIXED, BID);
    assert.throws(() => decodeNames({ ...e, v: 'N2' as 'N1' }), /認不得的版本/);
  });

  test('n 與 k／url 長度不符 → 拒絕解碼', () => {
    const e = encodeNames(MIXED, BID);
    assert.throws(() => decodeNames({ ...e, n: 7 }), /k 有 8 格，應為 7/);
    assert.throws(() => decodeNames({ ...e, url: e.url.slice(0, 7) }), /url 有 7 格，應為 8/);
  });

  test('字典索引越界 → 拒絕解碼（不會回一個 undefined 當名字）', () => {
    const e = encodeNames(MIXED, BID);
    const bad = structuredClone(e);
    (bad.c[0] as number[])[0] = 999;
    assert.throws(() => decodeNames(bad), /字典索引 999 超出字典/);
  });

  test('lit 沒被讀完 → 拒絕解碼（k 與資料對不上的前兆）', () => {
    const e = encodeNames(MIXED, BID);
    const bad = structuredClone(e);
    bad.lit.push('多出來的');
    assert.throws(() => decodeNames(bad), /lit 有 4 格，但只用掉 3 格/);
  });

  test('lit 不夠讀 → 拒絕解碼', () => {
    const e = encodeNames(MIXED, BID);
    const bad = structuredClone(e);
    bad.lit.pop();
    assert.throws(() => decodeNames(bad), /lit 只有 2 格/);
  });

  test('四個段欄不等長 → 拒絕解碼', () => {
    const e = encodeNames(MIXED, BID);
    const bad = structuredClone(e);
    (bad.c[1] as number[]).push(0);
    assert.throws(() => decodeNames(bad), /四欄必須等長/);
  });

  test('k 多了一格樣板但樣板欄沒跟上 → 拒絕解碼', () => {
    const e = encodeNames(MIXED, BID);
    const bad = structuredClone(e);
    bad.k = bad.k.map(() => 1); // 全部宣稱是樣板
    assert.throws(() => decodeNames(bad), /但該欄只有 \d+ 格|超出字典/);
  });

  test('assertNamesLossless 抓得到被竄改的一格', () => {
    const back = rt(MIXED);
    back.name[3] = 'レオパレス翔（被改過）';
    assert.throws(() => assertNamesLossless(MIXED, back), /name\[3\]/);
  });

  test('assertNamesLossless 抓得到整欄位移一格', () => {
    const back = rt(MIXED);
    back.url = [...(back.url.slice(1)), 'https://extra/'];
    assert.throws(() => assertNamesLossless(MIXED, back), /url\[0\]/);
  });

  test('assertNamesLossless 抓得到長度不同', () => {
    const back = rt(MIXED);
    back.name = back.name.slice(0, 7);
    assert.throws(() => assertNamesLossless(MIXED, back), /name 長度 8 ≠ 7/);
  });
});

describe('buildId 是兩檔同源的唯一證明', () => {
  test('編碼時原樣帶進輸出', () => {
    assert.equal(encodeNames(MIXED, BID).buildId, BID);
  });

  test('不同 buildId 產出不同的檔案內容（呼叫端才有辦法比對）', () => {
    const a = encodeNames(MIXED, 'aaaa');
    const b = encodeNames(MIXED, 'bbbb');
    assert.notEqual(a.buildId, b.buildId);
    assert.deepEqual(a.k, b.k, 'buildId 不影響資料本身');
  });
});
