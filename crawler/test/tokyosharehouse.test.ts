/**
 * 東京シェアハウス adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * fixture 是刻意挑過的：每一支都帶著一個實際踩到的坑
 *   detail-1889  房號黏著性別（`302男性専用`）／保証金＝家賃1カ月分＋退去時¥25,000償却
 *   detail-350   面積欄寫「0 ㎡」的佔位符／同時有空室與兩筆空室予定／保証金欄空白
 *   detail-24    アクセス沒寫「徒歩」／退去時100％返却（敷引為 0）／房內無床
 *   detail-2062  地址省略「東京都」／保証金是純金額無括號／年齡限制「30代まで」
 *   detail-3939  アクセス沒寫「駅」／退去時100％償却（敷引＝保証金全額）
 *   detail-384   神奈川県的物件——必須被排除
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, manifest,
  parseListItemIds, parseLastPage, parseAreaIds, parseTshAddress,
  parseTshStations, parseTshRooms, parseConditionBlocks, parseDeposit,
  parseAgeLimit, summaryCell, yenBackslash, decodeEntities,
} from '../sources/tokyosharehouse/index.ts';
import { known, notListed, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit } from '../../packages/schema/src/model.ts';
import { monthlyCost, initialCash } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/tokyosharehouse/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

function extract(id: string): Listing | null {
  const url = `https://tokyosharehouse.com/jpn/house/detail/${id}/`;
  return adapter.extract(
    {
      url, body: fixture(`detail-${id}.html.gz`), fetchedAt: '2026-08-16T00:00:00Z',
      sha256: 'sha-test', status: 200, notModified: false,
    },
    { url },
    { manifest, now: new Date('2026-08-16T00:00:00Z') },
  );
}

function unitOf(l: Listing | null, key: string): Unit {
  assert.ok(l, '應該解析出 Listing');
  const u = l.units.find((x) => x.unitKey === key);
  assert.ok(u, `找不到房號 ${key}（實際有：${l.units.map((x) => x.unitKey).join(', ')}）`);
  return u;
}

describe('文字前處理', () => {
  test('JIS 的反斜線就是日圓符號（建物層賃料寫成 \\56,000）', () => {
    assert.equal(yenBackslash('\\56,000 ~ \\69,000'), '¥56,000 ~ ¥69,000');
    // 後面不是數字的反斜線不動
    assert.equal(yenBackslash('a\\b'), 'a\\b');
  });

  test('共益費用的是 &#165; 實體', () => {
    assert.equal(decodeEntities('&#165;14,000'), '¥14,000');
  });
});

describe('列表頁與分頁', () => {
  const page1 = fixture('list-area6-page1.html.gz');
  const page3 = fixture('list-area6-page3.html.gz');

  test('只掃 #listContentArea：area 6 第 1 頁恰好 10 筆', () => {
    assert.deepEqual(parseListItemIds(page1),
      ['1889', '862', '3012', '863', '1486', '2444', '350', '2947', '1365', '901']);
  });

  test('整頁 grep 會多撈到右欄推薦——這正是不能用整頁 grep 的理由', () => {
    const whole = new Set([...page1.matchAll(/\/jpn\/house\/detail\/(\d+)/g)].map((m) => m[1]));
    assert.equal(whole.size, 30);              // 整頁 30 筆
    assert.equal(parseListItemIds(page1).length, 10); // 實際列表只有 10 筆
  });

  test('第 1 頁的 rel="last" 給出最後一頁；最後一頁本身沒有這個連結', () => {
    assert.equal(parseLastPage(page1), 3);
    assert.equal(parseLastPage(page3), 1);
  });

  test('最後一頁是未滿的一頁（10+10+5 = 25 棟）', () => {
    assert.equal(parseListItemIds(page3).length, 5);
  });

  test('首頁列出 52 個相異 area id', () => {
    assert.equal(parseAreaIds(fixture('home.html.gz')).length, 52);
  });
});

describe('地址判定：只收東京都', () => {
  test('有都名', () => {
    assert.deepEqual(parseTshAddress('東京都港区西新橋一丁目'),
      { kind: 'tokyo', addressRaw: '東京都港区西新橋一丁目', ward: '港区' });
  });

  test('省略都名，但区名是 23 特別区之一', () => {
    assert.deepEqual(parseTshAddress('杉並区下井草1丁目'),
      { kind: 'tokyo', addressRaw: '東京都杉並区下井草1丁目', ward: '杉並区' });
  });

  test('他県一律排除', () => {
    assert.equal(parseTshAddress('神奈川県 川崎市 中原区 新城1019').kind, 'other');
    assert.equal(parseTshAddress('埼玉県さいたま市浦和区').kind, 'other');
  });

  test('省略県名的他市（川崎市中原区）不可誤判成東京——含「市」就不採用', () => {
    assert.equal(parseTshAddress('川崎市中原区新城1019').kind, 'other');
  });

  test('東京都的市部（非特別区）也要收', () => {
    assert.deepEqual(parseTshAddress('東京都三鷹市下連雀'),
      { kind: 'tokyo', addressRaw: '東京都三鷹市下連雀', ward: '三鷹市' });
  });

  test('空字串是解析失敗，不是「非東京」', () => {
    assert.equal(parseTshAddress('').kind, 'unparsed');
  });
});

describe('アクセス欄的三種寫法', () => {
  test('標準寫法：路線＋駅＋徒歩N分', () => {
    const s = parseTshStations('<div>都営三田線 内幸町駅 徒歩3分</div>');
    assert.equal(s.length, 1);
    assert.equal(s[0]?.line, '都営三田線');
    assert.equal(s[0]?.station, '内幸町');
    assert.deepEqual(s[0]?.walkMinutes, known(3, 'measured', '都営三田線 内幸町駅 徒歩3分'));
  });

  test('沒寫「徒歩」時不可當成步行時間（可能是公車）', () => {
    const s = parseTshStations('<div>JR総武線 荻窪駅 16分</div>');
    assert.equal(s[0]?.station, '荻窪');
    assert.equal(s[0]?.walkMinutes.known, false);
    assert.equal(s[0]?.rawText, 'JR総武線 荻窪駅 16分');
  });

  test('沒寫「駅」也要抓得到站名', () => {
    const s = parseTshStations('<div>JR山手線 大崎 徒歩10分</div>');
    assert.equal(s[0]?.line, 'JR山手線');
    assert.equal(s[0]?.station, '大崎');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 10);
  });

  test('バス不可當步行時間', () => {
    const s = parseTshStations('<div>京王線 調布駅 バス12分</div>');
    assert.equal(s[0]?.walkMinutes.known, false);
  });
});

describe('保証金：月數／金額／償却／返却', () => {
  const rent69k: Field<Yen> = known({ jpy: 69000 }, 'measured', '賃料 ￥69,000');

  test('「家賃1カ月分」是倍數，乘上賃料才成金額，且算式要留在出處', () => {
    const d = parseDeposit('家賃1カ月分 （退去時¥25,000償却）', rent69k);
    assert.equal(d.deposit.known && d.deposit.v.jpy, 69000);
    assert.match(d.deposit.known ? d.deposit.srcText : '', /家賃1カ月分 × 賃料 69000円/);
    assert.equal(d.nonRefundable.known && d.nonRefundable.v.jpy, 25000);
  });

  test('賃料未知時絕不換算月數', () => {
    const d = parseDeposit('家賃1カ月分', notListed(''));
    assert.equal(d.deposit.known, false);
  });

  test('「退去時100％返却」＝敷引 0，這個 0 有原文依據', () => {
    const d = parseDeposit('家賃1カ月分 （退去時100％返却）', rent69k);
    assert.equal(d.nonRefundable.known && d.nonRefundable.v.jpy, 0);
    assert.equal(d.nonRefundable.known && d.nonRefundable.basis, 'measured');
    assert.notEqual(d.nonRefundable.known && d.nonRefundable.srcText, '');
  });

  test('「退去時100％償却」＝敷引等於保証金全額', () => {
    const d = parseDeposit('¥50,000 （退去時100％償却）', rent69k);
    assert.equal(d.deposit.known && d.deposit.v.jpy, 50000);
    assert.equal(d.nonRefundable.known && d.nonRefundable.v.jpy, 50000);
  });

  test('括號給的是「退還額」時，敷引 = 保証金 − 退還額（兩個數字都在原文裡）', () => {
    // 2026-08-16 實測 AzabuGardenia：`\80,000 （退去時\47,000返却）`
    const d = parseDeposit('¥80,000 （退去時¥47,000返却）', rent69k);
    assert.equal(d.deposit.known && d.deposit.v.jpy, 80000);
    assert.equal(d.nonRefundable.known && d.nonRefundable.v.jpy, 33000);
    assert.match(d.nonRefundable.known ? d.nonRefundable.srcText : '', /80000円 −/);
  });

  test('保証金未知時不做減法（沒有被減數就不生值）', () => {
    const d = parseDeposit('家賃1カ月分 （退去時¥47,000返却）', notListed(''));
    assert.equal(d.deposit.known, false);
    assert.equal(d.nonRefundable.known, false);
  });

  test('純金額、無括號 → 敷引未知（不是 0）', () => {
    const d = parseDeposit('¥44,000', rent69k);
    assert.equal(d.deposit.known && d.deposit.v.jpy, 44000);
    assert.equal(d.nonRefundable.known, false);
  });

  test('欄位空白 → 兩者都未知', () => {
    const d = parseDeposit('', rent69k);
    assert.equal(d.deposit.known, false);
    assert.equal(d.nonRefundable.known, false);
  });
});

describe('入居条件的年齡限制', () => {
  test('只有男女標籤時代表沒寫年齡限制', () => {
    assert.equal(parseAgeLimit('男性, 女性').known, false);
  });

  test('第三段才是年齡限制', () => {
    const f = parseAgeLimit('男性, 女性, 30代まで');
    assert.equal(f.known && f.v, '30代まで');
  });
});

describe('EAST TORANOMON（detail-1889）逐欄對照原站', () => {
  const l = extract('1889');

  test('建物層', () => {
    assert.ok(l);
    assert.equal(l.building.name, 'EAST TORANOMON');
    assert.equal(l.building.sourceId, 'tokyosharehouse');
    assert.equal(l.building.kind, 'sharehouse');
    assert.equal(l.building.addressRaw, '東京都港区西新橋一丁目');
    assert.equal(l.building.ward, '港区');
    assert.equal(l.building.totalUnits.known && l.building.totalUnits.v, 7);
    // 鮮度：這一棟的資料是 2021 年更新的，必須讓使用者看得到
    assert.equal(l.building.sourceUpdatedAt.known && l.building.sourceUpdatedAt.v, '2021-02-02');
    assert.deepEqual(l.building.stations.map((s) => s.station), ['内幸町', '虎ノ門']);
  });

  test('詳情頁的「部屋情報」只列空室與空室予定——這一棟 7 室只有 302 空著', () => {
    assert.ok(l);
    assert.deepEqual(l.units.map((u) => u.unitKey), ['302']);
  });

  test('房間層逐欄', () => {
    const u = unitOf(l, '302');
    assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 69000);
    assert.equal(u.monthly.adminFee.known && u.monthly.adminFee.v.jpy, 14000);
    assert.equal(u.areaM2.known && u.areaM2.v, 8.68);
    assert.equal(u.floor.known && u.floor.v, 3);
    assert.equal(u.layout.known && u.layout.v, '個室');
    assert.equal(u.isVacant.known && u.isVacant.v, true);
    assert.equal(u.availableFrom.known && u.availableFrom.v, '随時');
    assert.equal(u.minStayMonths.known && u.minStayMonths.v, 3);
    assert.equal(u.petsAllowed.known && u.petsAllowed.v, false);
  });

  test('房號黏著的「男性専用」要拆成性別欄位，不留在房號裡', () => {
    const u = unitOf(l, '302');
    assert.equal(u.roomNo.known && u.roomNo.v, '302');
    assert.match(u.roomNo.known ? u.roomNo.srcText : '', /302男性専用/);
    assert.equal(u.genderRestriction, 'male_only');
  });

  test('外國人條件是這個來源的賣點：逐物件列出所需文件', () => {
    const u = unitOf(l, '302');
    assert.equal(u.foreigner.residenceCardRequired.known && u.foreigner.residenceCardRequired.v, true);
    assert.match(u.foreigner.rawText, /パスポート/);
    assert.match(u.foreigner.rawText, /外国人登録書/);
  });

  test('月額 = 賃料 + 共益費；水電基準不明就是不明，不臆測', () => {
    const u = unitOf(l, '302');
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 69000 + 14000);
    assert.equal(u.utilitiesBasis, 'unknown');
    const c = initialCash(u);
    assert.equal(c.lower.jpy, 69000); // 保証金 = 家賃1カ月分
  });
});

describe('タイガーハウス 芝公園（detail-350）', () => {
  const l = extract('350');

  test('三間房：一間空室 + 兩間空室予定', () => {
    assert.ok(l);
    assert.deepEqual(l.units.map((u) => u.unitKey), ['408', '302', '307']);
    const now = unitOf(l, '408');
    const soon = unitOf(l, '302');
    const later = unitOf(l, '307');
    assert.equal(now.isVacant.known && now.isVacant.v, true);
    assert.equal(soon.isVacant.known && soon.isVacant.v, false);
    assert.equal(soon.availableFrom.known && soon.availableFrom.v, '2026-09-02');
    assert.equal(later.availableFrom.known && later.availableFrom.v, '2026-10-03');
  });

  test('面積欄的「0 ㎡」是佔位符，不是 0 平米', () => {
    for (const u of l?.units ?? []) {
      assert.equal(u.areaM2.known, false, `${u.unitKey} 的 0 ㎡ 不該被當成面積`);
      assert.equal(u.areaM2.known === false && u.areaM2.why, 'not_listed_on_page');
    }
  });

  test('保証金欄空白 → 未知，不可寫成 0', () => {
    const u = unitOf(l, '408');
    assert.equal(u.initial.deposit.known, false);
    assert.equal(u.initial.depositNonRefundable.known, false);
  });

  test('說明欄的「契約手数料（通常80000円）50% OFF」是帶條件的活動價，不得抓成金額', () => {
    const u = unitOf(l, '408');
    assert.equal(u.initial.contractFee.known, false);
    assert.equal(u.initial.contractFee.known === false && u.initial.contractFee.why, 'not_offered_by_source');
  });

  test('沒有「データ更新日」的物件就是未寫', () => {
    assert.equal(l?.building.sourceUpdatedAt.known, false);
  });
});

describe('Come on UP 荻窪（detail-24）', () => {
  const l = extract('24');

  test('アクセス沒寫「徒歩」→ 步行分鐘留未知', () => {
    assert.ok(l);
    assert.equal(l.building.stations.length, 2);
    for (const s of l.building.stations) {
      assert.equal(s.walkMinutes.known, false);
      assert.match(s.rawText, /16分$/);
    }
  });

  test('退去時100％返却 → 敷引 0（有依據的 0）', () => {
    const u = unitOf(l, '104');
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 70000);
    assert.equal(u.initial.depositNonRefundable.known && u.initial.depositNonRefundable.v.jpy, 0);
  });

  test('房內沒有床的房間不宣稱附傢俱', () => {
    const u = unitOf(l, '104');
    assert.equal(u.furnished.known, false);
  });

  test('最低契約期間 12カ月以上', () => {
    const u = unitOf(l, '104');
    assert.equal(u.minStayMonths.known && u.minStayMonths.v, 12);
  });
});

describe('省略都名與其他寫法（detail-2062 / detail-3939）', () => {
  test('2062：地址只寫「杉並区下井草1丁目」也要收，並補回都名', () => {
    const l = extract('2062');
    assert.ok(l);
    assert.equal(l.building.prefecture, '東京都');
    assert.equal(l.building.ward, '杉並区');
    assert.equal(l.building.addressRaw, '東京都杉並区下井草1丁目');
  });

  test('2062：保証金是純金額 ¥44,000，敷引未知', () => {
    const l = extract('2062');
    const u = unitOf(l, '102');
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 44000);
    assert.equal(u.initial.depositNonRefundable.known, false);
    assert.equal(u.ageLimitRaw.known && u.ageLimitRaw.v, '30代まで');
  });

  test('3939：アクセス沒寫「駅」；保証金 100％償却 → 敷引 = 保証金', () => {
    const l = extract('3939');
    assert.ok(l);
    assert.deepEqual(l.building.stations.map((s) => s.station), ['大崎', '大井町']);
    assert.equal(l.building.stations[0]?.walkMinutes.known, true);
    const u = unitOf(l, '308');
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 50000);
    assert.equal(u.initial.depositNonRefundable.known && u.initial.depositNonRefundable.v.jpy, 50000);
    assert.equal(u.ageLimitRaw.known && u.ageLimitRaw.v, '35歳まで');
  });
});

describe('只收東京都（detail-384 是神奈川県）', () => {
  test('非東京回 null（跳過），不是丟例外', () => {
    assert.equal(extract('384'), null);
  });
});

describe('版面改動要大聲失敗', () => {
  test('少了摘要表就丟例外，不默默產出空資料', () => {
    assert.throws(() => adapter.extract(
      {
        url: 'https://tokyosharehouse.com/jpn/house/detail/1/', body: '<html><body>maintenance</body></html>',
        fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false,
      },
      { url: 'https://tokyosharehouse.com/jpn/house/detail/1/' },
      { manifest, now: new Date() },
    ), /エリア/);
  });

  test('房間區塊本身不在就是 0 間，不會亂抓', () => {
    assert.equal(parseTshRooms('<html><body>nothing</body></html>').length, 0);
  });
});

describe('條件區塊的 icon 名稱是固定的 8 個', () => {
  test('六個 fixture 的 icon 集合完全一致', () => {
    const expected = ['manage', 'min_contract', 'japanese', 'clean', 'deposit', 'foreigner', 'rule', 'event'];
    for (const id of ['1889', '350', '24', '2062', '3939', '384']) {
      const keys = [...parseConditionBlocks(fixture(`detail-${id}.html.gz`)).keys()];
      assert.deepEqual(keys, expected, `detail-${id} 的條件 icon 與預期不符`);
    }
  });

  test('摘要表的每一格都抓得到', () => {
    const html = fixture('detail-1889.html.gz');
    for (const label of ['エリア', '賃料', '共益費', 'アクセス', '入居条件', '世帯数']) {
      assert.notEqual(summaryCell(html, label), null, `抓不到「${label}」`);
    }
  });
});

describe('建置閘門的規則在這裡就先擋住', () => {
  const listings = ['1889', '350', '24', '2062', '3939']
    .map(extract)
    .filter((l): l is Listing => l !== null);

  const moneyOf = (u: Unit): ReadonlyArray<readonly [string, Field<Yen>]> => [
    ['rent', u.monthly.rent], ['adminFee', u.monthly.adminFee], ['utilities', u.monthly.utilities],
    ['internet', u.monthly.internet], ['otherMonthly', u.monthly.otherMonthly],
    ['keyMoney', u.initial.keyMoney], ['deposit', u.initial.deposit],
    ['depositNonRefundable', u.initial.depositNonRefundable], ['agencyFee', u.initial.agencyFee],
    ['guarantorInitialFee', u.initial.guarantorInitialFee], ['fireInsurance', u.initial.fireInsurance],
    ['keyExchangeFee', u.initial.keyExchangeFee], ['contractFee', u.initial.contractFee],
    ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront], ['otherInitial', u.initial.otherInitial],
    ['renewalFee', u.deferred.renewalFee], ['renewalAdminFee', u.deferred.renewalAdminFee],
    ['cleaningFeeOnExit', u.deferred.cleaningFeeOnExit],
    ['earlyTerminationPenalty', u.deferred.earlyTerminationPenalty],
  ];

  test('至少解析出 5 棟、9 間房（有東西可測）', () => {
    assert.equal(listings.length, 5);
    assert.ok(listings.reduce((n, l) => n + l.units.length, 0) >= 9);
  });

  test('閘門1：金額 0 一律要有 measured 依據與非空原文', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const [id, f] of moneyOf(u)) {
          if (!f.known || f.v.jpy !== 0) continue;
          assert.ok(f.basis === 'included_stated' || (f.basis === 'measured' && f.srcText.trim() !== ''),
            `${u.id} 的 ${id} 是無依據的 0`);
        }
      }
    }
  });

  test('閘門2：measured 一定指得出原文出處', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const [id, f] of [...moneyOf(u), ['areaM2', u.areaM2] as const, ['layout', u.layout] as const]) {
          if (f.known && f.basis === 'measured') {
            assert.notEqual((f as { srcText: string }).srcText.trim(), '', `${u.id} 的 ${id} 沒有出處`);
          }
        }
      }
    }
  });

  test('閘門3：不產出 capabilities.provides 之外的金額欄位', () => {
    const provides = new Set<string>(manifest.capabilities.provides);
    for (const l of listings) {
      for (const u of l.units) {
        for (const [id, f] of moneyOf(u)) {
          if (f.known && f.basis === 'measured') {
            assert.ok(provides.has(id), `${u.id} 產出了未宣告的欄位 ${id}`);
          }
        }
      }
    }
  });

  test('neverProvides 宣告的欄位一律是 not_offered_by_source，不是解析失敗', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const f of [u.initial.keyMoney, u.initial.agencyFee, u.initial.contractFee,
          u.monthly.utilities, u.deferred.renewalFee, u.foreigner.guarantorCompanyRequired]) {
          assert.equal(f.known, false);
          assert.equal(f.known === false && f.why, 'not_offered_by_source');
        }
      }
    }
  });

  test('沒有任何欄位是 unparsed（解析器故障訊號）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const [id, f] of moneyOf(u)) {
          assert.notEqual(f.known === false && f.why, 'unparsed', `${u.id} 的 ${id} 解析失敗`);
        }
      }
    }
  });

  test('月額下限恆 ≥ 賃料（跨欄位不變式）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        if (!u.monthly.rent.known) continue;
        assert.ok(monthlyCost(u).lower.jpy >= u.monthly.rent.v.jpy, u.id);
      }
    }
  });

  test('敷引不可能超過保証金本身', () => {
    for (const l of listings) {
      for (const u of l.units) {
        if (!u.initial.deposit.known || !u.initial.depositNonRefundable.known) continue;
        assert.ok(u.initial.depositNonRefundable.v.jpy <= u.initial.deposit.v.jpy, u.id);
      }
    }
  });
});
