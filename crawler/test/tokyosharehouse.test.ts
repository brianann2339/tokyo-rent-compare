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
  parseListItemIds, parseLastPage, parseAreaIds, parseTshAddress, depositFloorRule,
  parseTshStations, parseTshRooms, parseConditionBlocks, parseDeposit,
  parseAgeLimit, summaryCell, yenBackslash, decodeEntities, tokyoMunicipality, parseTshFloor, proseConfirmsWalk, proseWalkOnly, roomDepositNote,
} from '../sources/tokyosharehouse/index.ts';
import { known, notListed, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit } from '../../packages/schema/src/model.ts';
import { monthlyCost, initialCash } from '../../packages/cost-model/src/index.ts';
import {
  proseZeroFees, proseYearBuilt, proseFloorsAboveGround, proseForeignerWelcomed, proseUtilities, proseFeeAmounts, proseZeroDeposit,
  proseDepositAmounts, proseSentences, roomTypesOf, scopeToRoomTypes,
} from '../../packages/jp-parse/src/prose.ts';

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

  test('「退去時N％返却」：不退 (100−N)％；超過 100％ 是誤植不換算（第二十九輪 3056、4225、4220）', () => {
    const p20 = parseDeposit('￥20,000 （退去時0％返却）', rent69k);
    assert.equal(p20.nonRefundable.known && p20.nonRefundable.v.jpy, 20000);
    const p50 = parseDeposit('￥51,000 （退去時50％返却）', rent69k);
    assert.equal(p50.nonRefundable.known && p50.nonRefundable.v.jpy, 25500);
    const bad = parseDeposit('￥20,000 （退去時10000％返却）', rent69k);
    assert.equal(bad.nonRefundable.known, false);
    assert.equal(bad.nonRefundable.known ? '' : bad.nonRefundable.why, 'unparsed');
  });

  test('「退去時N％償却」超過 100％ 也是誤植不換算（190「（退去時22000％償却）」，第三十一輪建置期不變式抓到）', () => {
    const bad = parseDeposit('\\30,000 （退去時22000％償却）', rent69k);
    assert.equal(bad.deposit.known && bad.deposit.v.jpy, 30000);
    assert.equal(bad.nonRefundable.known ? '' : bad.nonRefundable.why, 'unparsed');
    const ok = parseDeposit('\\30,000 （退去時50％償却）', rent69k);
    assert.equal(ok.nonRefundable.known && ok.nonRefundable.v.jpy, 15000);
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

  // 2026-09-06 稽核：原站逐字寫「保証金 家賃44000カ月分」（顯然想寫 ¥44,000），
  // 舊版照乘賃料生出 ¥2,420,000,000 並標成 measured——那是原站從未主張過的數字。
  test('倍率大到不像話時是原站寫壞了，標 unparsed 保留原文，不硬乘', () => {
    const d = parseDeposit('家賃44000カ月分 （退去時¥0返却）', rent69k);
    assert.equal(d.deposit.known, false);
    assert.equal(d.deposit.known === false && d.deposit.why, 'unparsed');
    assert.match(d.deposit.srcText, /家賃44000カ月分/);
    // 敷引是從保証金減出來的，保証金都讀不出來就不可能算得出敷引
    assert.equal(d.nonRefundable.known, false);
  });

  test('12 個月以內照常換算（上界不可以誤傷正常值）', () => {
    const d = parseDeposit('家賃2カ月分', rent69k);
    assert.equal(d.deposit.known && d.deposit.v.jpy, 138000);
  });
});

describe('アクセス欄：切點與「讀不出來」的處理（2026-09-06 稽核）', () => {
  test('全形數字的步行分鐘——舊版讓 61 棟建物一個車站都沒有', () => {
    const s = parseTshStations('<div>京急本線 平和島駅 徒歩８分</div><div>京急本線 大森町 徒歩８分</div>');
    assert.deepEqual(
      s.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]),
      [['京急本線', '平和島', 8], ['京急本線', '大森町', 8]],
    );
  });

  test('「徒歩約8分」的「約」不可以讓整串左移一格', () => {
    const s = parseTshStations('<div>JR京浜東北線 蒲田駅 徒歩約8分</div>');
    assert.equal(s[0]?.line, 'JR京浜東北線');
    assert.equal(s[0]?.station, '蒲田');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 8);
  });

  test('站名寫在路線前面時不可以把兩欄對調', () => {
    const s = parseTshStations('<div>鷹の台駅 西武国分寺線 徒歩10分</div>');
    assert.equal(s[0]?.line, '西武国分寺線');
    assert.equal(s[0]?.station, '鷹の台');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 10);
  });

  test('交通方式碎片不可以進站名欄', () => {
    const s = parseTshStations('<div>都営地下鉄浅草線/東京メトロ銀座線 浅草駅 バス5分+徒歩1分・自転車6分・徒歩18分</div>');
    assert.equal(s.length, 1);
    assert.equal(s[0]?.station, '浅草');
    assert.equal(s[0]?.line, '都営地下鉄浅草線/東京メトロ銀座線');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 18);
  });

  test('一格塞兩站要切成兩筆，較近的那站不可以被吃掉', () => {
    const s = parseTshStations('<div>東急東横線「都立大学」駅 徒歩8分、「学芸大学」駅 徒歩16分</div>');
    assert.deepEqual(
      s.map((x) => [x.station, x.walkMinutes.known ? x.walkMinutes.v : null]),
      [['都立大学', 8], ['学芸大学', 16]],
    );
  });

  test('同一線同一站被寫成兩列時，留分鐘已知的那一列', () => {
    const s = parseTshStations(
      '<div>山手線 目黒駅 バス4分（バス停まで徒歩3分）</div><div>山手線 目黒駅 徒歩18分</div>',
    );
    assert.equal(s.length, 1);
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 18);
  });

  test('原站沒寫分鐘＝這頁沒寫；有數字卻讀不出來＝解析失敗（要告警）', () => {
    const none = parseTshStations('<div>日比谷線 八丁堀駅</div>');
    assert.equal(none[0]?.station, '八丁堀');
    assert.equal(none[0]?.walkMinutes.known === false && none[0].walkMinutes.why, 'not_listed_on_page');
    const secs = parseTshStations('<div>西武池袋線 桜台駅 徒歩30秒</div>');
    assert.equal(secs[0]?.station, '桜台');
    assert.equal(secs[0]?.walkMinutes.known === false && secs[0].walkMinutes.why, 'unparsed');
  });

  test('公車站牌不是鐵路車站，切得出來也不收', () => {
    assert.deepEqual(parseTshStations('<div>バス 下田橋・丸山営業所 徒歩3分</div>'), []);
    assert.deepEqual(parseTshStations('<div>国際興業バス 中丸町 バス停 徒歩1分</div>'), []);
  });
});

describe('行政區：不可以切出不存在的市区町村（2026-09-06 稽核）', () => {
  test('地名中途的「町」「村」不可以讓切點提前收尾', () => {
    assert.equal(tokyoMunicipality('東村山市萩山町'), '東村山市');
    assert.equal(tokyoMunicipality('武蔵村山市学園'), '武蔵村山市');
    assert.equal(tokyoMunicipality('千代田区神田小川町1'), '千代田区');
    assert.equal(tokyoMunicipality('西多摩郡瑞穂町箱根ケ崎'), '西多摩郡瑞穂町');
  });

  test('原站自己漏寫「市」時回空字串，不硬切出假行政區', () => {
    assert.equal(tokyoMunicipality('国分寺光町1丁目'), '');
    assert.deepEqual(parseTshAddress('東京都国分寺光町1丁目'),
      { kind: 'tokyo', addressRaw: '東京都国分寺光町1丁目', ward: '' });
  });

  test('地址混入 U+200E 不可見字元要剝掉，否則字典會出現兩個「世田谷区」', () => {
    assert.deepEqual(parseTshAddress('東京都\u200e世田谷区経堂1丁目'),
      { kind: 'tokyo', addressRaw: '東京都世田谷区経堂1丁目', ward: '世田谷区' });
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

  test('說明欄的「契約手数料（通常80000円）50% OFF」是帶條件的活動價，不得抓成金額——但原站明寫有這筆費用', () => {
    const u = unitOf(l, '408');
    assert.equal(u.initial.contractFee.known, false);
    // 2026-10-17 第十一輪起：說明文直接寫了金額＝「明寫要付、金額未採用」，不是「此來源不公開」
    assert.equal(u.initial.contractFee.basis, 'excluded_stated');
    assert.match(u.initial.contractFee.srcText, /通常80000円.*說明文的金額不自動採用/);
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
        for (const f of [u.deferred.earlyTerminationPenalty, u.foreigner.guarantorCompanyRequired]) {
          assert.equal(f.known, false);
          assert.equal(f.known === false && f.why, 'not_offered_by_source');
        }
      }
    }
  });

  test('礼金／仲介／契約手数料：說明文明寫免收的 0、明寫要付但金額不採用、或 not_offered（都附原句）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const f of [u.initial.keyMoney, u.initial.agencyFee, u.initial.contractFee]) {
          if (f.known) {
            assert.equal(f.v.jpy, 0, `${u.id} 說明文只收免收，不收金額`);
            assert.match(f.srcText, /^物件說明「/);
          } else if (f.basis === 'excluded_stated') {
            // 說明文直接寫了金額：明寫要付，金額不採用
            assert.match(f.srcText, /^物件說明「.*（說明文的金額不自動採用，見原文）$/);
          } else {
            assert.equal(f.why, 'not_offered_by_source');
          }
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

describe('房間樓層', () => {
  test('地下記成負數，與 SUUMO 的 B1階 同一表示法', () => {
    const b = parseTshFloor('地下 1階');
    assert.equal(b.known && b.v, -1);
    const b2 = parseTshFloor('地下1階');
    assert.equal(b2.known && b2.v, -1, '中間有沒有空白都要收');
  });

  test('一般樓層', () => {
    const f = parseTshFloor('2階');
    assert.equal(f.known && f.v, 2);
  });

  test('英文的「Ground floor」標 unparsed，不替原站決定它是幾樓', () => {
    // 站方自己有 434 筆寫「1階」，所以 Ground floor 極可能就是 1 階——
    // 但那是推測不是原文，猜一個數字就是虛構。
    const f = parseTshFloor('Ground floor');
    assert.equal(f.known, false);
    assert.equal(f.known === false && f.why, 'unparsed');
    assert.match(f.srcText, /Ground floor/);
  });

  test('空字串才是「這頁沒寫」', () => {
    const f = parseTshFloor('');
    assert.equal(f.known, false);
    assert.equal(f.known === false && f.why, 'not_listed_on_page');
  });
});

describe('姊妹站的頁不收錄', () => {
  test('detail/3825 以本站網址回應、內容卻是 sharehouse.in 的關西物件：不可補成東京都北区', () => {
    // og:url=https://sharehouse.in/…、麵包屑「関西」、エリア「北区出雲路立テ本町50-2」（2026-10-17 實抓）
    assert.throws(() => extract('3825'), /sharehouse\.in/);
    // 地址函式本身仍會把它當省略都名的東京北区——所以擋在 extract 的 og:url 是必要的
    assert.equal(parseTshAddress('北区出雲路立テ本町50-2').kind, 'tokyo');
  });

  test('本站自己的頁（og:url 是 tokyosharehouse.com）照常解析', () => {
    assert.ok(extract('1889'));
  });
});

describe('說明文明寫的免收／築年／樓數／外國人（2026-10-17）', () => {
  test('1889：「仲介手数料はかかりません」→ 仲介 0；礼金沒寫 → 仍是 not_offered', () => {
    const l = extract('1889');
    assert.ok(l && l.units.length > 0);
    for (const u of l.units) {
      assert.ok(u.initial.agencyFee.known && u.initial.agencyFee.v.jpy === 0);
      assert.match(u.initial.agencyFee.srcText, /仲介手数料はかかりません/);
      assert.equal(u.initial.keyMoney.known === false && u.initial.keyMoney.why, 'not_offered_by_source');
    }
    // 同一棟寫「5階建て建物の3～5階部分」與「フルリフォーム実施の全7居室」：樓數取前句，改裝句不用
    assert.ok(l.building.floorsAboveGround.known && l.building.floorsAboveGround.v === 5);
    assert.ok(l.units.every((u) => u.foreigner.welcomed.known && u.foreigner.welcomed.v === true));
  });

  test('2062（絆家，2026-10-17 實抓；8 月版還沒有這句）：「敷金・礼金・仲介料・更新料全て【０円】」→ 礼金 0、仲介 0', () => {
    const l = extract('2062-2026-10-17');
    assert.ok(l && l.units.length > 0);
    for (const u of l.units) {
      assert.ok(u.initial.keyMoney.known && u.initial.keyMoney.v.jpy === 0);
      assert.ok(u.initial.agencyFee.known && u.initial.agencyFee.v.jpy === 0);
      assert.equal(u.initial.contractFee.known, false, '契約手数料沒被提到，不可順手補 0');
    }
  });

  test('活動區塊裡的「敷金、礼金不要」不採用（前文有「キャンペーン 割引中」）', () => {
    const text = '↓↓↓割引情報\n☆★キャンペーン 割引中☆★\n初月賃料は10,000円のみ！\n6ヶ月から入居可能です。\n敷金、礼金不要！';
    assert.deepEqual(proseZeroFees(text), {});
    assert.deepEqual(proseZeroFees('敷金、礼金不要！'), { keyMoney: '敷金、礼金不要' });
  });

  test('條件寫在兩句之後也要擋：「…保証金無料! 事務手数料、保険義務もなし！(３カ月以上入居条件)」', () => {
    assert.deepEqual(proseZeroFees('敷金、礼金、保証金無料! 事務手数料、保険義務もなし！(３カ月以上入居条件)'), {});
  });

  test('同一項費用另有帶金額的說法時不替原站挑：「仲介手数料 賃料の0.5か月」', () => {
    assert.deepEqual(proseZeroFees('仲介手数料はかかりません。\n仲介手数料 賃料の0.5か月（税別）'), {});
  });

  test('「それ以上」「新宿まで電車8分」不是條件', () => {
    const t = '新宿まで電車8分。全国28拠点700室運営・敷金・礼金・仲介料・更新料全て【無料】。コンセプトは「ともに、暮らす、それ以上」';
    const r = proseZeroFees(t);
    assert.ok(r.keyMoney !== undefined && r.agencyFee !== undefined);
  });

  test('築年：開幕日不是築年、改裝句不用、兩個年份不挑', () => {
    assert.equal(proseYearBuilt('2014年8月 新築オープンしたシェアハウスです', 2026), null);
    assert.equal(proseYearBuilt('2016年3月新築で誕生するシェアハウスです', 2026), null);
    assert.equal(proseYearBuilt('2002年建築・2016年リノベーション', 2026), null);
    assert.equal(proseYearBuilt('2015年築。2016年築。', 2026), null);
    assert.equal(proseYearBuilt('ARDEN東十条は、2017年8月に新築したシェアハウスです', 2026)?.year, 2017);
    assert.equal(proseYearBuilt('鉄筋コンクリート造・築2015年という好立地', 2026)?.year, 2015);
    assert.equal(proseYearBuilt('2015年の築浅で大手ハウスメーカーの施工', 2026), null);
    // ひつじ i-be-house：日也寫出來的竣工日
    assert.equal(proseYearBuilt('2012年2月3日竣工しました。', 2026)?.year, 2012);
    assert.equal(proseYearBuilt('2019年3月10日に新築', 2026)?.year, 2019);
  });

  test('樓數：地上層、地下不算、増築／建て替え與メゾネット句不用', () => {
    assert.equal(proseFloorsAboveGround('ハウス内はエレベーター完備の地下1階～5階建て')?.floors, 5);
    assert.equal(proseFloorsAboveGround('地下1階、地上3階建ての豪華な建物')?.floors, 3);
    assert.equal(proseFloorsAboveGround('ご近所はコンビニへは徒歩2分をはじめ、大型スーパー5店、6階建て100均ダイソー、ヤマダ電機'), null, '周邊設施的樓數');
    assert.equal(proseFloorsAboveGround('周辺にたくさんの商業施設があり、素敵なエリアにある2階建て一軒家タイプの少人数女性専用シェアハウスです')?.floors, 2);
    assert.equal(proseFloorsAboveGround('5F建てになりますが、エレベーターもあります')?.floors, 5);
    // 第十四輪起：リフォーム是內裝，樓數照收（原本整句丟掉）；改前改後兩個樓數並存仍不挑
    assert.equal(proseFloorsAboveGround('3階建ての邸宅をリフォームしたこちらのハウス')?.floors, 3);
    assert.equal(proseFloorsAboveGround('2階建てを3階建てにリフォーム'), null);
  });

  test('外國人：明寫才算；條件附帶的不採用；兩種說法並存是 conflict', () => {
    assert.equal((proseForeignerWelcomed('外国人の方も大歓迎です') as { welcomed: boolean }).welcomed, true);
    assert.equal((proseForeignerWelcomed('Sorry Japanease only. Foreigner NG') as { welcomed: boolean }).welcomed, false);
    assert.equal((proseForeignerWelcomed('コミュニティバランスの兼ね合いから、日本人限定募集とさせていただきます') as { welcomed: boolean }).welcomed, false);
    assert.equal(proseForeignerWelcomed('外国人：女性のみ可'), null);
    assert.equal(proseForeignerWelcomed('・外国人対応不可(英語サポートなし)'), null);
    assert.equal(proseForeignerWelcomed('全体の7割以上のお客様は外国籍の方です'), null, '暗示不算明寫');
    assert.equal(proseForeignerWelcomed('外国人歓迎。\n備考：日本人のみ'), 'conflict');
  });
});

describe('note 欄的保証金門檻', () => {
  test('解析「※賃料44,000円以下の場合は、保証金44,000円」', () => {
    assert.deepEqual(depositFloorRule('最低入居期間：6ヶ月\n※賃料44,000円以下の場合は、保証金44,000円'),
      { maxRent: 44000, amount: 44000, text: '賃料44,000円以下の場合は、保証金44,000円' });
    assert.equal(depositFloorRule('最低入居期間：6ヶ月'), null);
  });
});

describe('2026-10-17 第四輪驗證抓到的（全部用當天實抓頁）', () => {
  test('1214：「徒歩で10分」是步行 10 分', () => {
    const l = extract('1214-2026-10-17');
    assert.ok(l);
    const st = l.building.stations.find((x) => x.station === '小田急永山');
    assert.ok(st?.walkMinutes.known && st.walkMinutes.v === 10);
  });

  test('1214：建物層「ただいま満室です」而房間層標空室 → 空房狀態 conflicting，不替原站挑', () => {
    const l = extract('1214-2026-10-17');
    assert.ok(l && l.units.length > 0);
    for (const u of l.units) {
      assert.equal(u.isVacant.known === false && u.isVacant.why, 'conflicting');
      assert.equal(u.availableFrom.known === false && u.availableFrom.why, 'conflicting');
    }
  });

  test('3470：「つくばエクスプレス 浅草 徒歩9分」路線不可留空', () => {
    const l = extract('3470-2026-10-17');
    const st = l?.building.stations.find((x) => x.station === '浅草');
    assert.equal(st?.line, 'つくばエクスプレス');
  });

  test('4018：公車接駁說明不可多切出一個無路線的「小岩」', () => {
    const l = extract('4018-2026-10-17');
    assert.ok(l);
    const koiwa = l.building.stations.filter((x) => x.station === '小岩');
    assert.equal(koiwa.length, 1);
    assert.equal(koiwa[0]?.line, 'JR総武線');
    assert.match(koiwa[0]?.walkMinutes.srcText ?? '', /公車接駁/);
  });

  test('3986：介紹區巢狀的キャンペーン塊要讀到（外國人可否），但費用不從活動塊讀', () => {
    const l = extract('3986-2026-10-17');
    assert.ok(l && l.units.length > 0);
    for (const u of l.units) {
      assert.ok(u.foreigner.welcomed.known && u.foreigner.welcomed.v === true);
      assert.match(u.foreigner.welcomed.srcText, /外国人の方大歓迎/);
      // 活動塊寫「事務手数料半額」：不可變成任何費用值
      assert.equal(u.initial.contractFee.known, false);
    }
  });

  test('1697：「契約時の事務手数料、再契約事務手数料はかかりません」→ 契約手数料 0；水電明寫含在共益費', () => {
    const l = extract('1697-2026-10-17');
    assert.ok(l && l.units.length > 0);
    for (const u of l.units) {
      assert.ok(u.initial.contractFee.known && u.initial.contractFee.v.jpy === 0);
      assert.ok(u.monthly.utilities.known && u.monthly.utilities.v.jpy === 0);
      assert.equal(u.monthly.utilities.basis, 'included_stated');
      assert.equal(u.utilitiesBasis, 'included');
    }
  });

  test('「再契約事務手数料はかかりません」不是入居時的契約手續費', () => {
    assert.deepEqual(proseZeroFees('再契約事務手数料はかかりません。'), {});
    assert.deepEqual(proseZeroFees('解約事務手数料はかかりません。'), {});
  });

  test('水電：涵蓋水道才算全含；部分含回 partial；帶條件的含不採用', () => {
    assert.equal(proseUtilities('共益費にライフライン費用を含む。')?.basis, 'included');
    assert.equal(proseUtilities('共益費（水光熱費・wi-fi・保険含む）')?.basis, 'included');
    assert.equal(proseUtilities('共益費には光熱費、WIFI費用込み'), null, '光熱費不含水費');
    // 3880：一句含、一句另計＝部分含，存「明寫另計但沒金額」而不是「來源沒提」
    assert.equal(proseUtilities('共益費にライフライン費用を含む。別途居室内電気使用料がかかります。')?.basis, 'partial');
    assert.equal(proseUtilities('光熱費は各室50KWまでは定額に含まれ、超過分は実費請求。')?.basis, 'partial');
    assert.equal(proseUtilities('水光熱費は実費請求です')?.basis, 'excluded');
    assert.equal(proseUtilities('キャンペーン中は水光熱費込み'), null, '帶條件的「含」不採用');
    // 2493／2699：「条件付き」講的是房租折扣，不在「水光熱費実費」同一分句，另計照收
    assert.equal(proseUtilities('備考: 水光熱費実費　条件付きで23,800円。通常33,800円。')?.basis, 'excluded');
    assert.equal(proseUtilities('6ヶ月以上の場合は水光熱費実費'), null, '同一分句帶條件的另計不採用');
    // 376：只講房內電費＝部分另計
    assert.equal(proseUtilities('個室内電気代は実費請求')?.basis, 'partial');
    assert.equal(proseUtilities('電気代は各室使用分実費精算')?.basis, 'partial');
    assert.equal(proseUtilities('光熱費は個人契約')?.basis, 'excluded');
    assert.equal(proseUtilities('共益費にライフライン費用を含む。別途居室内電気使用料がかかります。')?.sentence,
      '共益費にライフライン費用を含む／別途居室内電気使用料がかかります');
  });
});

describe('段內明寫徒歩的分鐘', () => {
  const walk = (cell: string) => parseTshStations(`<div class="labelDesc"><div>${cell}</div></div>`)
    .map((x) => (x.walkMinutes.known ? x.walkMinutes.v : x.walkMinutes.why));
  test('句尾是別的交通方式時，取段內明寫的徒歩', () => {
    assert.deepEqual(walk('都営地下鉄三田線 高島平駅 徒歩24分 自転車8分'), [24]);
  });
  test('「徒歩1分半」仍是讀不出來（故障訊號），不可截成 1', () => {
    assert.deepEqual(walk('京王線 桜上水駅 徒歩1分半'), ['unparsed']);
  });
  test('提到公車時不取段內的徒歩（那是走到公車站）', () => {
    const r = walk('山手線 目黒駅 バス4分（バス停まで徒歩3分）');
    assert.equal(r.length, 1);
    assert.notEqual(r[0], 3, '徒歩3分是走到公車站，不是到目黒駅');
    assert.equal(typeof r[0], 'string', '步行分鐘必須是未知');
  });
});

describe('2026-10-17 第六輪驗證補的車站規則', () => {
  test('「急行で2駅12分」是搭車到轉乘站的車程，不是這棟的車站（3456 舊版把「急行で2」存成站名）', () => {
    const st = parseTshStations('<div>西武新宿線 上石神井駅 徒歩8分</div><div>JR山手線 高田馬場駅 急行で2駅12分</div>');
    assert.deepEqual(st.map((x) => x.station), ['上石神井']);
  });
  test('アクセス只寫「N分」、說明文對同站明寫「徒歩N分」才算步行', () => {
    const prose = '「COZY HOUSE 高砂」は、京成電鉄本・空港線「京成高砂駅」徒歩6分のシェアハウスです。';
    const [a] = parseTshStations('<div>京成本線・成田空港線 京成高砂駅 6分</div>', prose);
    assert.ok(a?.walkMinutes.known && a.walkMinutes.v === 6);
    assert.match(a.walkMinutes.srcText, /物件說明「/);
    // 分鐘不同、沒給說明文、更長站名的尾巴、句內提到公車：都維持未知
    const [b] = parseTshStations('<div>京成本線・成田空港線 京成高砂駅 7分</div>', prose);
    assert.equal(b?.walkMinutes.known, false);
    const [c] = parseTshStations('<div>京成本線・成田空港線 京成高砂駅 6分</div>');
    assert.equal(c?.walkMinutes.known, false);
    assert.equal(proseConfirmsWalk('新高砂駅から徒歩6分', '高砂', 6), null);
    assert.equal(proseConfirmsWalk('赤羽駅からバス、降りて徒歩6分', '赤羽', 6), null);
    // 4515：一句寫兩站
    assert.ok(proseConfirmsWalk('奥沢駅から徒歩4分、自由が丘駅から徒歩6分', '自由が丘', 6) !== null);
    assert.equal(proseConfirmsWalk('奥沢駅から徒歩4分、自由が丘駅から徒歩6分', '自由が丘', 4), null);
    // 4340：說明文寫的是 JR 的飯田橋，這一列是大江戸線——同名不同站體，不挪用
    assert.equal(proseConfirmsWalk('JR中央・総武線飯田橋駅から徒歩8分にある女性専用ハウスです', '飯田橋', 8, '都営大江戸線'), null);
    assert.ok(proseConfirmsWalk('東急東横線多摩川駅徒歩8分、田園調布駅徒歩11分', '多摩川', 8, '東急東横,目黒,多摩川線') !== null);
    assert.ok(proseConfirmsWalk('東京メトロ丸の内線「中野新橋駅」まで徒歩8分', '中野新橋', 8, '東京メトロ丸ノ内分岐線') !== null);
    // 3073：路線前面黏著房名與助詞（「ルチアハウス築地は日比谷線築地駅」）
    assert.ok(proseConfirmsWalk('ルチアハウス築地は日比谷線築地駅より徒歩2分', '築地', 2, '日比谷線') !== null);
    // 3456：站名在括號裡、全形數字
    assert.ok(proseConfirmsWalk('西武新宿線「上石神井」駅から徒歩８分', '上石神井', 8) !== null);
  });
});

describe('2026-10-17 第七輪驗證補的規則', () => {
  test('免收：條件字眼分活動（大窗口）與附帶條件（前 40／後 60 字）', () => {
    // 2142：清單含消費税與『』；「月末までの日割り」不是活動期限；講デポジット的＊註腳不是礼金的條件
    assert.equal(proseZeroFees('『敷金・礼金・更新料・保険料・消費税等』は不要です。最初にお支払い頂く費用は、「デポジット＋入居される日から月末までの日割り賃料」のみでございます。\n＊ デポジット＝一時預かり金的な性質です。').keyMoney,
      '『敷金・礼金・更新料・保険料・消費税等』は不要です');
    // 4310：「その他入居条件」是標題
    assert.ok(proseZeroFees('敷金・礼金・手数料無し 2024年3月中旬オープン\nその他入居条件：日本語で日常会話程度できる方').keyMoney !== undefined);
    // 舊例照樣擋：兩句之後的「(３カ月以上入居条件)」、四行前的活動標題、註腳講契約條件
    assert.deepEqual(proseZeroFees('敷金、礼金、保証金無料! 事務手数料、保険義務もなし！(３カ月以上入居条件)'), {});
    assert.deepEqual(proseZeroFees('☆★キャンペーン 割引中☆★\n↓↓↓\n初月賃料は10,000円のみ！\n6ヶ月から入居可能です。\n敷金、礼金不要！'), {});
    assert.deepEqual(proseZeroFees('礼金0円※\n※2年契約の場合'), {});
    // 4472：緊接的「最短契約期間は6ヶ月以上」講租期、沒提費用，不是免收的條件
    assert.ok(proseZeroFees('敷金礼金保証金一切なし、初期費用の心配も無く、安心で経済的です。最短契約期間は6ヶ月以上となります。').keyMoney !== undefined);
    assert.deepEqual(proseZeroFees('礼金なし。最短契約期間6ヶ月以上の場合、礼金・敷金は不要です。').keyMoney === undefined ? {} : { x: 1 }, {}, '講租期的句子同時提到費用時照樣算條件');
    // 「女性限定」是招募對象，不是活動
    assert.ok(proseZeroFees('女性限定シェアハウスです。礼金なし。').keyMoney !== undefined);
  });
  test('水電全含的另兩種寫法；「申し込み」的込不算', () => {
    assert.equal(proseUtilities('電気・ガス・水道・インターネット（Wi-Fi対応）も全て込みなので')?.basis, 'included');
    assert.equal(proseUtilities('■共益費電気・ガス・水道・インターネット料/16,000円')?.basis, 'included');
    assert.equal(proseUtilities('水道・ガス・電気のお申し込みは入居後にお願いします'), null);
    assert.equal(proseUtilities('光熱費・インターネット代込'), null, '光熱費不含水費');
    // 1409：水光熱費是容器（網路費含在水電費裡），不是水電含在共益費
    assert.equal(proseUtilities('※水光熱費にインターネット使用料が含まれます'), null);
    assert.equal(proseUtilities('水道光熱費に関しては共益費に含まれます')?.basis, 'included');
  });
  test('外國人：入居条件把外國人列為資格內、明寫外籍可安心入住', () => {
    const a = proseForeignerWelcomed('45歳未満の日本人、外国人男女であること');
    assert.ok(a !== null && a !== 'conflict' && a.welcomed);
    const b = proseForeignerWelcomed('4か国語対応可能で外国籍の方も安心してお住まい頂けます');
    assert.ok(b !== null && b !== 'conflict' && b.welcomed);
    assert.equal(proseForeignerWelcomed('外国人の方は日本語での会話が可能な方のみ'), null);
  });
  test('步行確認：「駅にも徒歩」、營運商名就是路線名（京王線）', () => {
    assert.ok(proseConfirmsWalk('JR赤羽駅にも徒歩15分ほどで行ける', '赤羽', 15, 'JR埼京線') !== null);
    assert.ok(proseConfirmsWalk('丸の内線「方南町駅」から徒歩10分・京王線「代田橋駅」から徒歩15分', '代田橋', 15, '京王線') !== null);
    assert.deepEqual(parseTshStations('<div>北総鉄道 新柴又駅 徒歩14分</div>').map((x) => x.line), ['北総鉄道']);
  });
});

describe('2026-10-17 第八輪驗證補的規則', () => {
  test('和暦的完工年換成西元', () => {
    assert.equal(proseYearBuilt('複数路線利用可能の安心・快適物件（平成２４年１０月新築）全室ロフト付き', 2026)?.year, 2012);
    assert.equal(proseYearBuilt('令和元年竣工', 2026)?.year, 2019);
    assert.equal(proseYearBuilt('昭和63年築', 2026)?.year, 1988);
    // 3432：「昭和３０年代」是十年區間
    assert.equal(proseYearBuilt('元々が昭和３０年代に建てられた母屋には、当時の梁や壁', 2026), null);
    assert.equal(proseYearBuilt('1950年代に建てられた', 2026), null);
  });
  test('站名後夾路線括號再接「から徒歩」', () => {
    assert.ok(proseConfirmsWalk('最寄り駅の地下鉄赤塚駅（有楽町線・副都心線）から徒歩６分、東武線下赤塚駅も徒歩８分', '地下鉄赤塚', 6, '東京メトロ有楽町線') !== null);
  });
  test('只含共用部的電＝部分含', () => {
    assert.equal(proseUtilities('家賃＋共益費：10,000円（水道,共有部分電気,ガス,音楽スタジオ,Wi-Fi代などを含む)')?.basis, 'partial');
    assert.equal(proseUtilities('共益費1万円には水道光熱費(個室電気代以外)、Wi-Fiが含まれます')?.basis, 'partial');
    assert.equal(proseUtilities('共益費には水道光熱費が含まれます')?.basis, 'included');
  });
  test('「光熱費15,000円」固定另收＝另計（3145）；0 円或句內寫含不算', () => {
    assert.equal(proseUtilities('備考: 光熱費15,000円　有線インターネット有')?.basis, 'excluded');
    assert.equal(proseUtilities('光熱費0円'), null);
    assert.equal(proseUtilities('水道光熱費10,000円は共益費に含まれます')?.basis, 'included');
  });
});

describe('2026-10-17 第九輪驗證補的車站規則', () => {
  const st = (cell: string) => parseTshStations(cell).map((x) => `${x.line}/${x.station}`);
  test('鐵道公司＋路線簡稱可以當路線；公車開頭不行', () => {
    assert.deepEqual(st('<div>東武東上 上板橋駅 徒歩13分</div>'), ['東武東上/上板橋']);
    assert.deepEqual(st('<div>京浜急行 平和島駅 徒歩3分</div>'), ['京浜急行/平和島']);
  });
  test('公車列、補充車程列不當車站', () => {
    assert.deepEqual(st('<div>東急東横線 都立大学駅 徒歩12分</div><div>東急バス 柿の木坂交番（恵比寿駅行き） 徒歩３分恵比寿駅まで21分</div>'), ['東急東横線/都立大学']);
    assert.deepEqual(st('<div>京王線 西調布駅 徒歩2分</div><div> 新宿駅 25分</div>'), ['京王線/西調布']);
    assert.deepEqual(st('<div>都営新宿線 西大島駅 10分</div><div>都営バス 北砂３丁目駅 3分</div>'), ['都営新宿線/西大島']);
    // 同棟只有沒路線的列時照留（沒有可以錨定的車站，不替原站刪）
    assert.deepEqual(st('<div>東武スカイツリー 竹の塚</div>'), ['東武スカイツリー/竹の塚']);
  });
});

describe('2026-10-17 第十輪驗證後的修正', () => {
  test('路線寫在駅後面的括號裡（30）：多條線照原文存成一個字串', () => {
    const rows = parseTshStations('<div>豊洲駅まで自転車15分<br />住吉駅（都営新宿線、半蔵門線）まで徒歩12分<br />東陽町駅（東京メトロ東西線）まで徒歩18分</div>');
    assert.deepEqual(rows.map((x) => `${x.line}/${x.station}/${x.walkMinutes.known ? x.walkMinutes.v : '?'}`),
      ['都営新宿線、半蔵門線/住吉/12', '東京メトロ東西線/東陽町/18']);
  });

  test('前面已有路線時不被括號蓋掉；括號裡不是路線就不收', () => {
    const st = (cell: string) => parseTshStations(cell).map((x) => `${x.line}/${x.station}`);
    assert.deepEqual(st('<div>JR中央線 中野駅（北口）徒歩5分</div>'), ['JR中央線/中野']);
    assert.deepEqual(st('<div>中野駅（北口）徒歩5分</div>'), ['/中野']);
  });

  test('「水道・光熱費…込み」「光熱費・水道代…含まれています」：光熱＋水道＝全含（282／3399）', () => {
    assert.equal(proseUtilities('全室新品エアコン・家具家電付きで水道・光熱費・インターネット代込みです。')?.basis, 'included');
    assert.equal(proseUtilities('光熱費・水道代・Wi-Fi などの生活に必要な費用は含まれています。')?.basis, 'included');
  });

  test('水電詞緊接「に」是容器：「光熱費に水道代も含まれます」不算含在房租裡', () => {
    assert.equal(proseUtilities('光熱費に水道代も含まれます。'), null);
    assert.equal(proseUtilities('水道代に電気代が含まれます。'), null);
  });

  // 第十輪曾刻意保守：附近有活動字眼就不採用「含」。第三十輪驗證 332 的網路（前面同段是房租回饋活動）判為真錯——
  //「含在共益費」講的是月費涵蓋什麼，活動只減免費用；改成只看這句本身的活動字眼與水電那一段的條件
  test('前面講房租的活動不作廢「含在共益費」（3399）；活動寫在同一句的照舊不採用', () => {
    const text = '🎉 初月50％割引中 🎉\n6ヶ月以上のご入居で、初月賃料が半額になります（条件あり）\n👉 毎月のお支払いは、「賃料＋共益費」のみ。\n光熱費・水道代・Wi-Fi などの生活に必要な費用は含まれています。';
    assert.equal(proseUtilities(text)?.basis, 'included');
    assert.equal(proseUtilities('キャンペーン期間中は水道光熱費込み'), null);
    assert.equal(proseUtilities('6ヶ月以上の場合、水道光熱費込み'), null);
  });
});

describe('2026-10-17 第十一輪驗證後的修正', () => {
  // 4027 Room 203 的備考原文（同一行兩個 ※ 條列，後面接原狀回復的但書）
  const r4027 = '※水道光熱費、インターネット代込みです。\n※入居時、初期費用として家賃1ヶ月分かかります（返還なし） ※敷金、礼金、更新料、事務手数料などはありません\n※ただし、壁に穴を開けた、タバコを吸った等の場合は修復にかかる実費を請求';

  test('同一行「空白＋※」是下一個條列；句首 ※ 不是自己的條件；原狀回復但書的「場合」不作廢免收（4027）', () => {
    // 第十七輪起：與敷金並列的「事務手数料」也算入居時的契約手数料 → 一起免收
    assert.deepEqual(proseZeroFees(r4027), {
      keyMoney: '※敷金、礼金、更新料、事務手数料などはありません', contractFee: '※敷金、礼金、更新料、事務手数料などはありません',
    });
    assert.equal(proseUtilities(r4027)?.basis, 'included');
    assert.equal(proseZeroDeposit(r4027), '※敷金、礼金、更新料、事務手数料などはありません');
  });

  test('貼在字後面的 ※ 仍是註腳；帶期間數字的退租句仍算條件', () => {
    assert.deepEqual(proseZeroFees('礼金0円※\n※6ヶ月以上の契約の場合'), {});
    assert.deepEqual(proseZeroFees('礼金なし\n※6ヶ月以内の退去・破損の場合は違約金'), {});
  });

  test('只講房內用量的另計＝部分（4028「※個室内で使う電気、ガスは別途要契約」）', () => {
    const t = '※共用部の水道光熱水費インターネット含む\n※個室内で使う電気、ガスは別途要契約';
    assert.equal(proseUtilities(t)?.basis, 'partial');
  });

  test('保証金：說明文另處帶金額提到敷金／保証金就不採用免收', () => {
    assert.equal(proseZeroDeposit('敷金・礼金なし！\n保証金30,000円（退去時返金）'), null);
    assert.equal(proseZeroDeposit('敷金・礼金・仲介手数料なしで、初期費用を削減できます。'), '敷金・礼金・仲介手数料なしで、初期費用を削減できます');
  });

  test('說明文直接寫了費用金額＝明寫要付（金額不採用）；別項的金額與 0 不算', () => {
    assert.deepEqual(Object.keys(proseFeeAmounts('・契約手数料賃料0.5ヵ月\n・礼金：賃料1ヶ月分\n仲介手数料 賃料の0.5か月（税別）')).sort(),
      ['agencyFee', 'contractFee', 'keyMoney']);
    assert.ok(proseFeeAmounts('新規申込で契約手数料（通常80000円）が50% OFF 40,000円に').contractFee !== undefined);
    // ￥700 是火災保険料，不是仲介費；方案條件夾在中間的不認；0 不是金額
    assert.deepEqual(proseFeeAmounts('・初期費用：敷金・礼金・仲介手数料0円 初月・翌月分の賃料、火災保険料（月額￥700）'), {});
    // 「契約事務手数料 初回6ヶ月契約の場合 ¥11,000」第十二輪起改認（見下一個 describe）
    assert.deepEqual(proseFeeAmounts('礼金：0ヶ月'), {});
  });

  test('小標寫法：「契約手数料」單獨一行，兩行內接金額（2800）；金額行講的是別的費用就不算', () => {
    assert.equal(proseFeeAmounts('契約手数料\n※事務手数料や個室清掃費などを含む契約時のみお支払い頂く料金です。\n個室・相部屋：40,000円').contractFee,
      '契約手数料／個室・相部屋：40,000円');
    assert.deepEqual(proseFeeAmounts('契約手数料\n保証金：30,000円'), {});
  });

  test('2800 整頁（實抓）：契約手数料存「原站明寫要付、金額未採用」，不是「此來源不公開」', () => {
    const f = unitOf(extract('2800-2026-10-17'), '504').initial.contractFee;
    assert.equal(f.known, false);
    assert.equal(f.basis, 'excluded_stated');
    assert.match(f.srcText, /契約手数料／個室・相部屋：40,000円.*說明文的金額不自動採用/);
  });

  test('4027 整頁（實抓）：Room 203 礼金 0、保証金 0（保証金欄空白）、水電含', () => {
    const u = unitOf(extract('4027-2026-10-17'), '203');
    assert.deepEqual([u.initial.keyMoney.known && u.initial.keyMoney.v.jpy, u.initial.deposit.known && u.initial.deposit.v.jpy], [0, 0]);
    assert.match(u.initial.deposit.srcText, /保証金欄空白/);
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.basis, 'included_stated');
    assert.equal(u.utilitiesBasis, 'included');
  });

  test('外國人：「国籍問いません」「外国籍の方、留学生も大歓迎」；只附日語能力的照收（1428／282）', () => {
    assert.equal((proseForeignerWelcomed('ハウスルールを守り、日常会話程度の日本語が話せれば、国籍問いません。') as { welcomed: boolean }).welcomed, true);
    assert.equal((proseForeignerWelcomed('外国籍の方、留学生も大歓迎です。') as { welcomed: boolean }).welcomed, true);
    assert.equal(proseForeignerWelcomed('外国人の方は日本語での会話が可能な方のみ'), null);
  });

  test('「12分ほど歩けば品川駅と白金高輪駅にも行けます」＝品川步行 12 分（3155）；「北品川駅」不是品川', () => {
    const s = 'オフィス街と住宅街のちょうど中心にある泉岳寺駅から、わずか徒歩3分の場所にあるクロス品川1物件。12分ほど歩けば品川駅と白金高輪駅にも行けます。';
    assert.ok(proseConfirmsWalk(s, '品川', 12, 'JR山手線') !== null);
    assert.equal(proseConfirmsWalk(s, '品川', 9, 'JR山手線'), null);
    assert.equal(proseConfirmsWalk('12分ほど歩けば北品川駅にも行けます。', '品川', 12), null);
  });
});

describe('2026-10-17 第十二輪驗證後的修正', () => {
  test('契約費的寫法變體：契約時事務手数料（沒有の）、契約料；再契約料／再契約時事務手数料不是入居時的', () => {
    assert.ok(proseFeeAmounts('・契約時事務手数料¥22,000（税込）').contractFee !== undefined);
    assert.ok(proseFeeAmounts('契約料:¥16,500').contractFee !== undefined);
    assert.ok(proseFeeAmounts('初回契約時に契約料30,000円が必要となります').contractFee !== undefined);
    assert.deepEqual(proseFeeAmounts('・再契約料¥6000'), {});
    assert.deepEqual(proseFeeAmounts('再契約時事務手数料5,000円＋税'), {});
  });

  test('「契約金」分不出是手續費還是初期費用總額：只歸到其他初期費用；全形逗號也是金額（288）', () => {
    assert.deepEqual(Object.keys(proseFeeAmounts('契約金５５，０００円（税込）')), ['otherInitial']);
    assert.deepEqual(Object.keys(proseFeeAmounts('初回契約時に契約金として40,000円必要')), ['otherInitial']);
  });

  test('費用名詞與金額之間隔著方案條件也算明寫要付（1927）；中間夾別項費用、句中有免收字眼、對比一般賃貸都不算', () => {
    assert.ok(proseFeeAmounts('初期費用： 保証金＋賃料＋共益費＋契約事務手数料 初回6ヶ月契約の場合 ¥11,000（税込）・初回3ヶ月契約の場合¥33,000（税込）＋火災保険料').contractFee !== undefined);
    assert.deepEqual(proseFeeAmounts('初回契約事務手数料：33,000円・ クリーニング代：22,000円（初回契約時のみ・返金なし）礼金：無（礼1の場合賃料-4,000円）'), { contractFee: '初回契約事務手数料：33,000円・ クリーニング代：22,000円（初回契約時のみ・返金なし）礼金：無（礼1の場合賃料-4,000円）' });
    assert.deepEqual(proseFeeAmounts('仲介手数料は6ヶ月以上の入居で無料'), {});
    assert.deepEqual(proseFeeAmounts('一般的な賃貸では仲介手数料など家賃の4〜5ヶ月分の初期費用がかかります'), {});
  });

  test('3249 整頁（實抓）：運營者 FAQ「共益費には、水道光熱費…が含まれます」＝水電含，出處標運営者FAQ', () => {
    const u = unitOf(extract('3249-2026-10-17'), '103');
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.basis, 'included_stated');
    assert.match(u.monthly.utilities.srcText, /^運営者FAQ「共益費には、水道光熱費/);
    assert.equal(u.utilitiesBasis, 'included');
  });

  test('3033 整頁（實抓）：アクセス欄只寫「竹ノ塚駅」沒分鐘，說明文「徒歩7分の…「竹ノ塚」駅」→ 步行 7 分', () => {
    const l = extract('3033-2026-10-17');
    const st = l?.building.stations.find((x) => x.station === '竹ノ塚');
    assert.equal(st?.walkMinutes.known && st.walkMinutes.v, 7);
    assert.match(st?.walkMinutes.srcText ?? '', /アクセス欄沒寫分鐘/);
  });

  test('說明文對同一站寫了兩種步行分鐘就不採用；中間夾「から」的不是同一段路', () => {
    assert.equal(proseWalkOnly('竹ノ塚駅から徒歩7分。竹ノ塚駅まで徒歩9分です。', '竹ノ塚'), null);
    assert.equal(proseWalkOnly('徒歩7分の公園から竹ノ塚駅まではバスです。', '竹ノ塚'), null);
    assert.deepEqual(proseWalkOnly('日比谷線八丁堀駅徒歩3分・有楽町線新富町徒歩6分など5路線利用可', '新富町', '有楽町線')?.minutes, 6);
  });
});

describe('2026-10-17 第十三輪驗證後的修正', () => {
  test('前後帶空白的半形「 / 」是條列分隔；列舉「外国籍(要保証会社)・学生・…・ペット可」算收（3481）', () => {
    const note = '保証会社・家財保険必須 / 外国籍(要保証会社)・学生・一部2人入居(カップル夫婦)・ペット可 / 子供・生活保護不可';
    assert.equal((proseForeignerWelcomed(note) as { welcomed: boolean }).welcomed, true);
    // 「9/30まで」這種不帶空白的斜線不切
    assert.deepEqual(proseZeroFees('礼金0円（9/30まで）'), {});
    assert.equal(proseForeignerWelcomed('外国人(女性のみ)・学生可'), null);
  });

  test('金額寫在費用名詞前面的總額括號：「3万円（契約事務手数料/退去クリーニング費/…）」＝明寫要付（3179）', () => {
    assert.ok(proseFeeAmounts('初期費用：家賃1ヶ月分＋3万円（契約事務手数料/退去クリーニング費/鍵発行手数料/ベッドパット）').contractFee !== undefined);
    assert.ok(proseFeeAmounts('初期費用:25,000円（礼金1万、初回保証料1.5万）').keyMoney !== undefined);
    assert.deepEqual(proseFeeAmounts('初期費用：3万円（礼金なし）'), {});
  });

  test('說明文指定房號的押金：「敷金40,000円(301号室)」；「(301号室以外)」不算', () => {
    const t = '・敷金40,000円(301号室)　30,000円(301号室以外)';
    assert.deepEqual(roomDepositNote(t, '301'), { amount: 40000, text: '敷金40,000円(301号室)' });
    assert.equal(roomDepositNote(t, '412'), null);
  });

  test('2807 整頁（實抓）：301 的押金與入居条件表不一致→矛盾（附兩邊原文）；其他房照表', () => {
    const l = extract('2807-2026-10-17');
    const d301 = unitOf(l, '301').initial.deposit;
    assert.equal(d301.known === false && d301.why, 'conflicting');
    assert.match(d301.srcText, /保証金 ¥30,000（入居条件表）／物件說明「敷金40,000円\(301号室\)」/);
    const d412 = unitOf(l, '412').initial.deposit;
    assert.equal(d412.known && d412.v.jpy, 30000);
  });
});

describe('2026-10-17 第十四輪驗證後的修正', () => {
  test('括號只列共益費組成也算全含（3879「共益費（水道光熱費インターネット等）」）；括號裡寫別／除就不算；預收後精算＝部分（43）', () => {
    assert.equal(proseUtilities('・共益費（水道光熱費インターネット等）：12,000円/月')?.basis, 'included');
    assert.equal(proseUtilities('共益費（水道光熱費別）：12,000円'), null);
    assert.equal(proseUtilities('共益費（水道光熱費）は￥10000/月を前預かり後、年2回精算(住人で折半)')?.basis, 'partial');
  });

  test('外國人：「45歳未満の日本人女性、外国人女性であること」（1333）', () => {
    assert.equal((proseForeignerWelcomed('◆45歳未満の日本人女性、外国人女性であること') as { welcomed: boolean }).welcomed, true);
  });

  test('沒寫「契約」的事務手数料只在入居時脈絡才算契約手數料（228、2580）；再契約／更新的不算', () => {
    assert.ok(proseFeeAmounts('③事務手数料（初回）22,000円（税込）').contractFee !== undefined);
    assert.ok(proseFeeAmounts('初期費用は家賃と共益費、保証金(3万円)、事務手数料（1万円プラス税）になります。').contractFee !== undefined);
    assert.deepEqual(proseFeeAmounts('再契約時は事務手数料11,000円'), {});
    assert.deepEqual(proseFeeAmounts('更新事務手数料：11,000円'), {});
    assert.deepEqual(proseFeeAmounts('事務手数料：11,000円'), {});
  });

  test('樓數：內裝改修（リノベ／リフォーム）不影響樓數；増築／建て替え才排除（3052）', () => {
    assert.equal(proseFloorsAboveGround('物件は地下1階、地上3階建てのリノベーション物件です。')?.floors, 3);
    assert.equal(proseFloorsAboveGround('2階建てを増築して3階建てにしました。'), null);
  });
});

describe('2026-10-17 第十五輪驗證後的修正', () => {
  test('入居資格條列（「■18歳以上の方」）不是旁邊費用／水電句的條件；帶費用或活動字眼的年齡句照舊算（3921）', () => {
    const t = '■共益費電気・ガス・水道・インターネット料/16,000円■家賃のお支払いはエポスカード払いご利用必須■契約期間2年■18歳以上の方。館内禁煙';
    assert.equal(proseUtilities(t)?.basis, 'included');
    assert.ok(proseZeroFees('■礼金なし■20歳以上の方').keyMoney !== undefined);
    assert.deepEqual(proseZeroFees('■礼金なし■25歳以下の方は割引'), {});
  });

  test('說明文直接寫出的押金金額；帶條件、退租扣款、活動的不算', () => {
    assert.deepEqual(proseDepositAmounts('・保証金：10,000円(退去時50%＋消費税を媒介手数料として償却)').map((a) => a.jpy), [10000]);
    assert.deepEqual(proseDepositAmounts('【初期費用】初月賃料・共益費・保証金(60000円)・火災保険(6100円)').map((a) => a.jpy), [60000]);
    assert.deepEqual(proseDepositAmounts('初期費用はデポジット￥20,000と共益費￥15,000がかかります').map((a) => a.jpy), [20000]);
    assert.deepEqual(proseDepositAmounts('(2) デポジット（保証金）20,000円').map((a) => a.jpy), [20000]);
    assert.deepEqual(proseDepositAmounts('初期費用は家賃と共益費、保証金(3万円)、事務手数料').map((a) => a.jpy), [30000]);
    assert.deepEqual(proseDepositAmounts('デポジット １５，０００円').map((a) => a.jpy), [15000]);
    assert.deepEqual(proseDepositAmounts('・保証金 家賃１ヶ月分(退去時100%返却予定)').map((a) => a.months), [1]);
    for (const t of [
      '外国籍の方は保証金５００００円となります',
      '1F・２Fのアパートメントタイプのみ保証金は50,000円（全償却）となります',
      'デポジット ドミトリー20,000円 個室30,000円',
      '敷金=家賃1ヶ月分(または30,000円)',
      '※ペット飼育の場合は保証金2ヶ月分',
      'デポジット2万円→今なら無料',
      '退去時、保証金より設備補修費20,000円を精算',
      '保証金は清掃費として￥20000償却',
      '[103] 保証金：月2,000円',
      '敷金・礼金・仲介料・更新料全て【０円】',
    ]) assert.deepEqual(proseDepositAmounts(t), [], t);
  });

  test('357 整頁（實抓）：入居条件表「家賃1カ月分」與 note「保証金：10,000円」不一致→矛盾，附兩邊原文', () => {
    const l = extract('357-2026-10-17');
    for (const k of ['K2', 'D1']) {
      const d = unitOf(l, k).initial.deposit;
      assert.equal(d.known === false && d.why, 'conflicting');
      assert.match(d.srcText, /保証金 家賃1カ月分 × 賃料 \d+円（入居条件表）／物件說明「・保証金：10,000円/);
    }
  });

  test('4043 整頁（實抓）：入居条件表「保証金無し」與說明「デポジット￥20,000」不一致→矛盾（前一句的「１年以上…フリーレント」不是押金的條件）', () => {
    const d = unitOf(extract('4043-2026-10-17'), '204').initial.deposit;
    assert.equal(d.known === false && d.why, 'conflicting');
  });

  test('2664 整頁（實抓）：保証金欄空白、說明寫「デポジット（保証金）20,000円」→原站明寫要付，金額不採用', () => {
    const d = unitOf(extract('2664-2026-10-17'), '316').initial.deposit;
    assert.equal(d.known, false);
    assert.equal(d.known === false && d.basis, 'excluded_stated');
    assert.match(d.srcText, /デポジット（保証金）20,000円/);
  });

  test('srcText 只放頁面原文：和暦築年回傳原句（3328）；空室予定不加自己的說明（2851）', () => {
    const r = proseYearBuilt('複数路線利用可能の安心・快適物件（平成２４年１０月新築）全室ロフト付き', 2026);
    assert.equal(r?.year, 2012);
    assert.equal(r?.sentence, '複数路線利用可能の安心・快適物件（平成２４年１０月新築）全室ロフト付き');
    const soon = unitOf(extract('350'), '302').isVacant;
    assert.equal(soon.known && soon.v, false);
    assert.equal(soon.srcText, '空室予定 2026-09-02');
  });

  test('3921 整頁（實抓）：「共益費電気・ガス・水道・インターネット料/16,000円」＝水電全含；押金照表', () => {
    const u = unitOf(extract('3921-2026-10-17'), '307');
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.v.jpy, 0);
    assert.equal(u.utilitiesBasis, 'included');
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 30000);
  });
});

describe('2026-10-17 第十六輪驗證後的修正', () => {
  test('3081 整頁（實抓）：一列寫五條路線（30 字）照原文存，不當散文殘句丟掉', () => {
    const l = extract('3081-2026-10-17');
    assert.ok(l);
    const s = l.building.stations.find((x) => x.station === '飯田橋');
    assert.equal(s?.line, '東京メトロ東西線・南北線・有楽町線・JR総武線・都営大江戸線');
    assert.equal(s?.walkMinutes.known && s.walkMinutes.v, 10);
  });

  test('「バスと徒歩15分」（2664）「バス14分、バス停徒歩5分」（1627）：徒歩是公車那段，不是到車站的步行', () => {
    const l = extract('2664-2026-10-17');
    assert.ok(l);
    const s = l.building.stations.find((x) => x.station === '葛西臨海公園');
    assert.equal(s?.line, '京葉線');
    assert.equal(s?.walkMinutes.known, false);
    assert.match(s?.walkMinutes.srcText ?? '', /原文是公車接駁/);
    const y = extract('1627-2026-10-17')?.building.stations.find((x) => x.station === '用賀');
    assert.equal(y?.walkMinutes.known, false);
    // 「バス5分+徒歩1分・自転車6分・徒歩18分」最後的徒歩18分是另一種走法
    const r = parseTshStations('<div>東京メトロ日比谷線 南千住駅 バス8分+徒歩1分・自転車6分・徒歩18分</div>');
    assert.equal(r[0]?.walkMinutes.known && r[0].walkMinutes.v, 18);
  });

  test('2906 整頁（實抓）：「電気代・ガス代・水道代・インターネット無料」＝水電全含；「全部オーナー様の<br>ご負担」＝礼金 0', () => {
    const u = unitOf(extract('2906-2026-10-17'), '105');
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.v.jpy, 0);
    assert.equal(u.utilitiesBasis, 'included');
    assert.equal(u.initial.keyMoney.known && u.initial.keyMoney.v.jpy, 0);
    assert.match(u.initial.keyMoney.srcText, /全部オーナー様のご負担/);
  });

  test('屋主負擔只認緊接在前的那一段；無料要有水道＋電／瓦斯；句中斷行接回、條列不接', () => {
    // 鍵交換代是屋主出（0），礼金不受影響
    assert.deepEqual(proseZeroFees('礼金1ヶ月、鍵交換代はオーナー負担'), { keyExchangeFee: '礼金1ヶ月、鍵交換代はオーナー負担' });
    assert.deepEqual(proseZeroFees('礼金はオーナー負担です（6ヶ月以上の場合）'), {});
    assert.equal(proseUtilities('電気、水道、ガス代もすべて無料です')?.basis, 'included');
    assert.equal(proseUtilities('洗濯機・ガス乾燥機、テレビ貸出なども無料で利用可能です'), null);
    assert.equal(proseUtilities('水光熱費実費 インターネット無料')?.basis, 'excluded');
    assert.deepEqual(proseSentences('全部オーナー様の\n\r\nご負担ですよ☆'), ['全部オーナー様のご負担ですよ']);
    assert.deepEqual(proseSentences('礼金なしの\n・敷金1ヶ月'), ['礼金なしの', '・敷金1ヶ月']);
  });
});

describe('2026-10-17 火災保険／鍵交換也從說明文讀', () => {
  test('明寫金額＝原站明寫要付；明寫屋主出／不要＝0；月費、選配不標', () => {
    assert.ok(proseFeeAmounts('・住宅保険料 8,000円（1年）').fireInsurance !== undefined);
    assert.ok(proseFeeAmounts('火災保険加入必須： 1年間¥10,000（当社紹介可能な保険会社の場合）').fireInsurance !== undefined);
    assert.ok(proseFeeAmounts('・鍵発行手数料 5,000円（税別）').keyExchangeFee !== undefined);
    const both = proseFeeAmounts('・住宅保険料（1年）+鍵発行手数料 13,500円');
    assert.ok(both.fireInsurance !== undefined && both.keyExchangeFee !== undefined);
    assert.equal(proseFeeAmounts('火災保険料（月額￥700）').fireInsurance, undefined);
    assert.equal(proseFeeAmounts('初回契約手数料33,000円家財保険料500円\n■家財保険加入/月額500円').fireInsurance, undefined);
    assert.equal(proseFeeAmounts('鍵交換費用(20000円/任意)').keyExchangeFee, undefined);
    assert.ok(proseZeroFees('・火災保険はオーナー負担').fireInsurance !== undefined);
    assert.ok(proseZeroFees('『敷金・礼金・更新料・保険料・消費税等』は不要です').fireInsurance !== undefined);
    assert.equal(proseZeroFees('保証料は不要です').fireInsurance, undefined);
  });

  test('營運方出（ハウス負担）也算 0；必須加保險沒寫金額＝明寫要付；選配與附在保證公司的不算', () => {
    assert.ok(proseZeroFees('なんと通常は賃料とは別に発生する高額な「家財保険」と「借家人賠償保険」もハウス負担').fireInsurance !== undefined);
    assert.ok(proseFeeAmounts('・要家財保険加入').fireInsurance !== undefined);
    assert.ok(proseFeeAmounts('保険加入必須（12,400円/2年）').fireInsurance !== undefined);
    assert.equal(proseFeeAmounts('(4)火災保険任意加入').fireInsurance, undefined);
    assert.equal(proseFeeAmounts('要火災保険加入（保証会社に付帯）').fireInsurance, undefined);
  });

  test('鍵交換代後面別項的「保証人なし」不擋（282）；鍵設定費（862）', () => {
    assert.ok(proseFeeAmounts('入館料30,000円、家財保険料20,000円(2年間)、鍵交換代18,000円（税抜）、保証人なしの場合保証会社加入要').keyExchangeFee !== undefined);
    assert.ok(proseFeeAmounts('鍵設定:¥ 6,600').keyExchangeFee !== undefined);
  });

  test('「２親等以内」是親屬範圍不是條件；水電費金額下一行的 ※ 註腳是那筆費用的組成，不是含在房租', () => {
    const z = proseZeroFees('・住宅保険料：不要 ・鍵発行手数料：不要 ・家賃保証会社：不要（緊急連絡先に２親等以内の方を指定）');
    assert.ok(z.fireInsurance !== undefined && z.keyExchangeFee !== undefined);
    const t = '・管理費10,000円 ・光熱水等費16,000円\n※電気・ガス・水道・共用部消耗品・インターネット使用料・家財保険が含まれています';
    assert.equal(proseUtilities(t), null);
    assert.equal(proseUtilities(`${t}\n別途 光熱水等費 月額16,000円※電気・ガス・水道が含まれています`)?.basis, 'excluded');
  });

  test('2906 整頁（實抓）：「鍵交換代も保険の費用も全部オーナー様のご負担」＝鍵交換 0、火災保險 0', () => {
    const u = unitOf(extract('2906-2026-10-17'), '105');
    assert.equal(u.initial.keyExchangeFee.known && u.initial.keyExchangeFee.v.jpy, 0);
    assert.equal(u.initial.fireInsurance.known && u.initial.fireInsurance.v.jpy, 0);
  });

  test('3921 整頁（實抓）：家財保険是月費（月額500円）→ 不標入居時明寫要付', () => {
    const f = unitOf(extract('3921-2026-10-17'), '307').initial.fireInsurance;
    assert.equal(f.known === false && f.why, 'not_offered_by_source');
  });
});

describe('2026-10-17 第十七輪驗證後的修正', () => {
  test('沒寫「契約」的事務手数料：「入居時」寫在後面（3599）、與敷金／保険並列（3989）也算；月費（3477）不算', () => {
    assert.ok(proseFeeAmounts('事務手数料：11,000円/入居時（税込）').contractFee !== undefined);
    assert.ok(proseFeeAmounts('備考: 敷金30000円、火災保険11000円、事務手数料賃料1ヶ月').contractFee !== undefined);
    assert.equal(proseFeeAmounts('事務手数料：990円/月（税込）、清掃費：36,300 円（税込）、火災保険20,000円/2年').contractFee, undefined);
  });

  test('入居金／入館料／施設利用料歸其他初期費用（明寫要付，金額不採用）', () => {
    assert.ok(proseFeeAmounts('初回に入居金16,500円／人').otherInitial !== undefined);
    assert.ok(proseFeeAmounts('施設利用料 35,000円（新規契約時のみ)').otherInitial !== undefined);
    assert.ok(proseFeeAmounts('入館料3万円').otherInitial !== undefined);
    assert.equal(proseFeeAmounts('ベッドパッド・シーツ 3,300円(ベッド利用の場合)').otherInitial, undefined);
  });

  test('①② 只有後面緊接費用／優惠字眼才是方案編號；品牌條列「①管理力」不擋（2427）', () => {
    const t = '鍵付き個室で電気ガス水道インターネットも料金内に含まれておりますので、お気軽にお問合せください！ ★★BeGoodを表す3つの単語★★ ①管理力 各物件に管理担当がついており';
    assert.equal(proseUtilities(t)?.basis, 'included');
    assert.deepEqual(proseZeroFees('①敷金・礼金なしの共益費込みで38,750円~'), {});
  });
});

describe('2026-10-17 第十八輪驗證後的修正', () => {
  test('漢字樓數「二階建て一戸建て」（4526／4527）；srcText 留原句', () => {
    assert.deepEqual(proseFloorsAboveGround('東京都板橋区常盤台エリアに位置する、二階建て一戸建てのシェアハウスです。'),
      { floors: 2, sentence: '東京都板橋区常盤台エリアに位置する、二階建て一戸建てのシェアハウスです' });
    assert.equal(proseFloorsAboveGround('地下一階、地上三階建て')?.floors, 3);
    assert.equal(proseFloorsAboveGround('十二階建てのマンション')?.floors, 12);
    assert.equal(proseFloorsAboveGround('閑静な住宅街の一戸建て'), null);
    assert.equal(proseFloorsAboveGround('ＲＣ４階建てのハウス')?.sentence, 'ＲＣ４階建てのハウス');
  });

  test('「〜号室は」範圍主題下的費用不套到整棟（2746）；別項括號裡的号室不算（2807、2301）', () => {
    assert.deepEqual(proseFeeAmounts('※A～D号室は部屋はシャワー、トイレ、洗面付き\n　保険加入必須（12,400円/2年）'), {});
    assert.ok(proseFeeAmounts('・敷金40,000円(301号室) 30,000円(301号室以外)\n・火災保険¥7,500～').fireInsurance !== undefined);
    assert.ok(proseFeeAmounts('※（201～204号室）2名入居の場合 28,700 円 火災保険 20,000円/2年').fireInsurance !== undefined);
  });
});

describe('2026-10-17 第十九輪驗證後的修正', () => {
  test('「つつじヶ丘駅からSHIFT調布までは徒歩7分」：から／まで之間夾房子名字也算同站步行（3235）；夾別的駅不算', () => {
    assert.match(proseConfirmsWalk('つつじヶ丘駅からSHIFT調布までは徒歩7分。閑静な住宅街に佇みます。', 'つつじヶ丘', 7, '京王線') ?? '', /徒歩7分/);
    assert.equal(proseConfirmsWalk('つつじヶ丘駅から調布駅までは徒歩7分', 'つつじヶ丘', 7, '京王線'), null);
  });

  test('「家財保険に加入。2年￥5,000。」句號切開名詞與金額也算明寫要付（2021）；下一句是月費不算', () => {
    assert.equal(proseFeeAmounts('備考: 家財保険に加入。2年￥5,000。').fireInsurance, '備考: 家財保険に加入／2年￥5,000');
    assert.equal(proseFeeAmounts('家財保険に加入。月額500円').fireInsurance, undefined);
  });

  test('免收條列夾著非費用名詞（「WI-FI、火災保険、管理費共用費すべて無料」）也照讀；管理費本身不因此變 0', () => {
    assert.deepEqual(proseZeroFees('WI-FI、火災保険、管理費共用費すべて無料'), { fireInsurance: 'WI-FI、火災保険、管理費共用費すべて無料' });
  });
});

describe('2026-10-17 第二十輪驗證後的修正', () => {
  test('「(マンションタイプ)敷金礼金1か月ずつ」只套用到備考寫マンションタイプ的房：押金＝原站明寫要付，礼金引對房型那一行（3985）', () => {
    const l = extract('3985-2026-10-17');
    const room = (no: string) => l?.units.find((u) => u.roomNo.known && u.roomNo.v === no);
    const r203 = room('203');
    assert.ok(r203 !== undefined);
    assert.equal(r203.initial.deposit.known, false);
    assert.equal(!r203.initial.deposit.known && r203.initial.deposit.basis, 'excluded_stated');
    assert.match(r203.initial.deposit.srcText, /\(マンションタイプ\)敷金礼金1か月ずつ/);
    assert.match(r203.initial.keyMoney.srcText, /\(マンションタイプ\)敷金礼金1か月ずつ/);
    assert.doesNotMatch(r203.initial.keyMoney.srcText, /シェアハウスタイプ/);
    // シェアハウスタイプ的房：押金那行不是它的，表空白＝頁面沒寫；礼金只引自己那行
    const r206 = room('206B');
    assert.ok(r206 !== undefined);
    assert.equal(!r206.initial.deposit.known && r206.initial.deposit.basis, 'unstated');
    assert.match(r206.initial.keyMoney.srcText, /\(シェアハウスタイプ\)礼金1か月/);
    assert.doesNotMatch(r206.initial.keyMoney.srcText, /マンションタイプ/);
  });

  test('備考沒寫房型就不拿掉任何一行（判不出來）；押金遇到房型字眼照舊算附條件', () => {
    const note = '・(シェアハウスタイプ)礼金1か月\n・(マンションタイプ)敷金礼金1か月ずつ';
    assert.equal(scopeToRoomTypes(note, []), note);
    assert.deepEqual(proseDepositAmounts(note), []);
    assert.deepEqual(roomTypesOf('マンションタイプ、キッチン/トイレ/浴室/洗濯機置き場室内設置'), ['マンションタイプ']);
  });

  test('「敷金礼金1か月ずつ」「敷金・礼金各1ヶ月」：押金與礼金合寫一個金額', () => {
    assert.deepEqual(proseDepositAmounts('敷金礼金1か月ずつ').map((a) => a.months), [1]);
    assert.deepEqual(proseDepositAmounts('・敷金・礼金各1ヶ月').map((a) => a.months), [1]);
  });

  test('同一項費用好幾句都明寫要付 → 全部列出；活動句不當佐證', () => {
    assert.equal(proseFeeAmounts('家財保険20,000円（2年間）。家財保険2万円').fireInsurance, '家財保険20,000円（2年間）／家財保険2万円');
    assert.equal(
      proseFeeAmounts('③事務手数料（初回）22,000円（税込）。内見当日申し込みで初回契約事務手数料：22,000円、保険料：9,600円が無料').contractFee,
      '③事務手数料（初回）22,000円（税込）',
    );
  });

  test('「オンオフを分けて」「ご契約プランは1年または2年からお選び」不是活動 → 「敷金・礼金・仲介手数料0円」照讀（4394）', () => {
    const l = extract('4394-2026-10-17');
    const u = l?.units[0];
    assert.ok(u?.initial.keyMoney.known && u.initial.keyMoney.v.jpy === 0, JSON.stringify(u?.initial.keyMoney));
    assert.ok(u.initial.agencyFee.known && u.initial.agencyFee.v.jpy === 0);
    assert.ok(u.initial.deposit.known && u.initial.deposit.v.jpy === 0, '保証金欄空白、說明文明寫敷金 0');
    // 同一句的「火災保険料（月額￥700）」是月費，不標
    assert.equal(!u.initial.fireInsurance.known && u.initial.fireInsurance.why, 'not_offered_by_source');
  });

  test('活動的「オフ」只認接在金額後面；「プラン」排除合約年限、格局與別的字', () => {
    assert.deepEqual(proseZeroFees('通常家賃より5,000円オフ。敷金・礼金なし'), {});
    // 只講房租的活動自成一行也照舊算條件（2531「★期間限定フリーレント1ヶ月★」下一行「★うれしい敷金・礼金０★」，第三十二輪複查）
    assert.deepEqual(proseZeroFees('★期間限定フリーレント1ヶ月★\n★うれしい敷金・礼金０★'), {});
    assert.deepEqual(proseZeroFees('初月賃料が50%オフ!! 礼金なし'), {});
    assert.deepEqual(proseZeroFees('オフの日はカフェ巡り。礼金なし'), { keyMoney: '礼金なし' });
    assert.deepEqual(proseZeroFees('ブックオフ 徒歩5分。礼金なし'), { keyMoney: '礼金なし' });
    assert.deepEqual(proseZeroFees('プランドール池尻大橋。礼金なし'), { keyMoney: '礼金なし' });
    assert.deepEqual(proseZeroFees('住戸プランは2タイプから選べます。礼金なし'), { keyMoney: '礼金なし' });
    assert.deepEqual(proseZeroFees('短期3ヶ月間の入居プラン始めました！礼金なし'), {});
    assert.deepEqual(proseZeroFees('2年契約プランなら礼金なし'), {});
  });
});

describe('2026-10-17 第二十五輪驗證後的修正：保証料、更新、清掃費、網路不再一律「來源不公開」', () => {
  test('「※保証会社加入必須（初回保証料が別途発生します）」→ 初回保証料＝原站明寫要付（1695#202）', () => {
    const f = unitOf(extract('1695-2026-10-17'), '202').initial.guarantorInitialFee;
    assert.equal(f.known, false);
    assert.equal(f.known === false && f.basis, 'excluded_stated');
    assert.match(f.srcText, /初回保証料が別途発生します/);
  });
  test('「再契約手数料：1年おきに3万円」→ 更新事務手数料明寫要付；「退去後クリーニング費20,000円(入居時前払い)」→ 入居時清掃費（3448#306）', () => {
    const u = unitOf(extract('3448-2026-10-17'), '306');
    assert.equal(u.deferred.renewalAdminFee.known === false && u.deferred.renewalAdminFee.basis, 'excluded_stated');
    assert.match(u.deferred.renewalAdminFee.srcText, /再契約手数料：1年おきに3万円/);
    assert.equal(u.initial.cleaningFeeUpfront.known === false && u.initial.cleaningFeeUpfront.basis, 'excluded_stated');
    assert.match(u.initial.cleaningFeeUpfront.srcText, /入居時前払い/);
    // 同一筆錢不在退去時再算一次
    assert.equal(u.deferred.cleaningFeeOnExit.known === false && u.deferred.cleaningFeeOnExit.why, 'not_offered_by_source');
    // 「保証会社利用必須」只說要用保證公司，沒寫初回多少 → 這頁沒寫（不是來源不公開）
    assert.equal(u.initial.guarantorInitialFee.known === false && u.initial.guarantorInitialFee.why, 'not_listed_on_page');
  });
  test('房間備考「共益費（水光熱費・wi-fi・保険含む）」→ 網路含在共益費（3513#31）', () => {
    const f = unitOf(extract('3513-2026-10-17'), '31').monthly.internet;
    assert.ok(f.known);
    assert.equal(f.v.jpy, 0);
    assert.equal(f.basis, 'included_stated');
  });
  test('「家賃保証会社：不要」→ 0；同一行後面的「更新料または再契約料 20,000円」照讀成明寫要付（4201）', () => {
    const u = unitOf(extract('4201-2026-10-17'), '205');
    assert.ok(u.initial.guarantorInitialFee.known);
    assert.equal(u.initial.guarantorInitialFee.v.jpy, 0);
    assert.equal(u.deferred.renewalFee.known === false && u.deferred.renewalFee.basis, 'excluded_stated');
  });
  test('「保証会社初期費用20000円」是要付不是 0（1748）', () => {
    const f = unitOf(extract('1748-2026-10-17'), '309').initial.guarantorInitialFee;
    assert.equal(f.known === false && f.basis, 'excluded_stated');
  });
  test('退去清掃費的房型變體併入同一筆，不另立入居時清掃費（700）', () => {
    const u = unitOf(extract('700-2026-10-17'), '409');
    assert.equal(u.initial.cleaningFeeUpfront.known === false && u.initial.cleaningFeeUpfront.why, 'not_offered_by_source');
    assert.match(u.deferred.cleaningFeeOnExit.srcText, /39,000円/);
  });
  test('「＜更新料、退去時のクリーニング費用等＞」下一行「・なし」→ 更新料與退去清掃費 0；網路含在共益費（4027）', () => {
    const u = unitOf(extract('4027-2026-10-17'), '203');
    for (const f of [u.deferred.renewalFee, u.deferred.cleaningFeeOnExit]) {
      assert.ok(f.known);
      assert.equal(f.v.jpy, 0);
    }
    // 第二十七輪：那句只講退去時，入居時清掃費頁面沒寫——不能存 0；引句不帶「もっと見る」摺疊連結字
    assert.equal(u.initial.cleaningFeeUpfront.known, false);
    assert.ok(!/もっと見る|\.\.\.more/.test(u.deferred.cleaningFeeOnExit.srcText ?? ''));
    // 「※入居時、初期費用として家賃1ヶ月分かかります（返還なし）」：有一筆入居時要付的錢
    assert.equal(u.initial.otherInitial.known, false);
    assert.equal(u.initial.otherInitial.basis, 'excluded_stated');
    assert.ok(u.monthly.internet.known);
  });
});

describe('2026-10-17 第三十一輪驗證後的修正（全部用當天實抓頁）', () => {
  const zero = (f: Unit['initial']['keyMoney']): boolean => f.known && f.v.jpy === 0;
  test('3163：「【初期費用】は…のみ（その他の手数料等はナシ）」→ 入居時各欄 0；「【毎月かかる費用】は…のみ」→ 其他月費 0', () => {
    const u = unitOf(extract('3163-2026-10-17'), '101');
    for (const k of ['keyMoney', 'agencyFee', 'contractFee', 'keyExchangeFee', 'guarantorInitialFee', 'cleaningFeeUpfront', 'otherInitial'] as const) {
      assert.ok(zero(u.initial[k]), `${k}: ${JSON.stringify(u.initial[k])}`);
      assert.match(u.initial[k].srcText, /のみ（その他の手数料等はナシ）/);
    }
    assert.ok(zero(u.monthly.otherMonthly));
    assert.match(u.monthly.otherMonthly.srcText, /【毎月かかる費用】/);
  });
  test('2493：「火災保険、家財保険、賠償保険は高額になる為、ハウス負担」→ 0；初期費用例後「それ以外にかかる費用は一切ございません」→ 入居時各欄 0', () => {
    const u = unitOf(extract('2493-2026-10-17'), 'F');
    assert.ok(zero(u.initial.fireInsurance));
    assert.match(u.initial.fireInsurance.srcText, /ハウス負担/);
    for (const k of ['keyMoney', 'agencyFee', 'contractFee', 'keyExchangeFee', 'guarantorInitialFee', 'cleaningFeeUpfront', 'otherInitial'] as const) {
      assert.ok(zero(u.initial[k]), k);
    }
    assert.equal(u.deferred.renewalFee.known, false, '總括句只講入居時，不補更新料');
  });
  test('2314：介紹文那次緊接家賃半額キャンペーン，但 note 另寫一次 → 火災保険 0', () => {
    const u = unitOf(extract('2314-2026-10-17'), '302');
    assert.ok(zero(u.initial.fireInsurance));
  });
  test('1319：表「退去時¥20,000返却」與房間備考「※退室時、保証金返金はなし」→ 不退金額 conflicting', () => {
    const f = unitOf(extract('1319-2026-10-17'), '202').initial.depositNonRefundable;
    assert.equal(f.known === false && f.why, 'conflicting');
    assert.match(f.srcText, /返金はなし/);
  });
  test('3249：「保証金：月2,000円」→ 其他月費明寫要付', () => {
    const f = unitOf(extract('3249-2026-10-17'), '103').monthly.otherMonthly;
    assert.equal(f.known === false && f.basis, 'excluded_stated');
  });
  test('113：note「入館料2万」→ 其他初期費用明寫要付；介紹文的活動免收句 → 頁面有提到、未採用（不是此來源不公開）', () => {
    const u = unitOf(extract('113-2026-10-17'), '個室Private Room');
    assert.equal(u.initial.otherInitial.known === false && u.initial.otherInitial.basis, 'excluded_stated');
    assert.match(u.initial.otherInitial.srcText, /入館料2万/);
    for (const f of [u.initial.keyMoney, u.initial.agencyFee]) {
      assert.equal(f.known === false && f.why, 'not_listed_on_page');
      assert.match(f.srcText, /全てなしなし/);
    }
  });
});

describe('房租 ￥0 是站方沒填（第三十一輪建置期不變式抓到 2030#102、2829#E）', () => {
  test('2030#102「賃料 ￥0」→ 頁面未載明，不存 0', () => {
    const l = extract('2030-2026-10-17');
    const u = unitOf(l, '102');
    assert.equal(u.monthly.rent.known === false && u.monthly.rent.why, 'not_listed_on_page');
    assert.match(u.monthly.rent.srcText, /￥0/);
  });
});


describe('第三十三輪驗證後的修正（全部用當天實抓頁）', () => {
  test('3235#0205：活動區的「契約費30,000円⇒10,000円引き」→ 頁面有提到（不是此來源不公開）；房間備考「家具の設置はありません」與圖示亮床 → conflicting', () => {
    const u = unitOf(extract('3235-2026-10-17'), '0205');
    const c = u.initial.contractFee;
    assert.equal(c.known === false && c.why, 'not_listed_on_page');
    assert.match(c.srcText, /活動區塊「[^」]*契約費/);
    assert.equal(u.furnished.known === false && u.furnished.why, 'conflicting');
    assert.match(u.furnished.srcText, /家具の設置はありません/);
    // 同頁 0213 的備考寫「ベット、カーテン」：照圖示附家具
    assert.equal(unitOf(extract('3235-2026-10-17'), '0213').furnished.known, true);
  });
  test('3119#102：活動區的「契約費28,000円→18,000円」與「水道光熱費15,000円」→ 頁面有提到', () => {
    const u = unitOf(extract('3119-2026-10-17'), '102');
    assert.equal(u.initial.contractFee.known === false && u.initial.contractFee.why, 'not_listed_on_page');
    assert.match(u.initial.contractFee.srcText, /契約費/);
    assert.equal(u.monthly.utilities.known === false && u.monthly.utilities.why, 'not_listed_on_page');
    assert.match(u.monthly.utilities.srcText, /活動區塊「水道光熱費15,000円」/);
  });
  test('3481：note「保証会社・家財保険必須」→ 火災保険明寫要付', () => {
    const f = unitOf(extract('3481-2026-10-17'), 'B-2').initial.fireInsurance;
    assert.equal(f.known === false && f.basis, 'excluded_stated');
    assert.match(f.srcText, /家財保険必須/);
  });
  test('228：【初回契約時費用】「④携行品保証料（初回）9,600円」→ 其他初期費用明寫要付；活動區的「保険料 9,600円 → 0円」是同一筆，不當火災保険', () => {
    const u = unitOf(extract('228-2026-10-17'), '301');
    assert.equal(u.initial.otherInitial.known === false && u.initial.otherInitial.basis, 'excluded_stated');
    assert.match(u.initial.otherInitial.srcText, /携行品保証料（初回）9,600円/);
    assert.doesNotMatch(u.initial.otherInitial.srcText, /再契約/);
    assert.equal(u.initial.fireInsurance.known === false && u.initial.fireInsurance.why, 'not_offered_by_source');
  });
  test('2195#105：圖示沒亮床、房間備考「家具なしのため…値引」→ 明寫沒附家具', () => {
    const f = unitOf(extract('2195-2026-10-17'), '105').furnished;
    assert.equal(f.known && f.v, false);
    assert.match(f.srcText, /家具なしのため/);
  });
});

describe('第三十四輪驗證後的修正（全部用當天實抓頁）', () => {
  test('841：note「共益費12000円で、ガス、電気、水道、無線LAN、スカパー（リビングのみ）」→ 水電與網路含在共益費；備考「家具はありません」與圖示亮床 → conflicting', () => {
    const u = unitOf(extract('841-2026-10-17'), '205');
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.basis, 'included_stated');
    assert.equal(u.monthly.internet.known && u.monthly.internet.basis, 'included_stated');
    assert.match(u.monthly.utilities.srcText, /共益費12000円で/);
    assert.equal(u.furnished.known === false && u.furnished.why, 'conflicting');
  });
  test('3289#101：房間備考「…保険料：9,600円が無料」＝note 的「携行品保証料（初回）9,600円」→ 不當火災保険', () => {
    const u = unitOf(extract('3289-2026-10-17'), '101');
    assert.equal(u.initial.fireInsurance.known === false && u.initial.fireInsurance.why, 'not_offered_by_source');
    assert.match(u.initial.otherInitial.srcText, /携行品保証料（初回）/);
  });
});

