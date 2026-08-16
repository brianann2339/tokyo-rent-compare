/**
 * Sakura House adapter 的黃金測試。
 *
 * fixtures 是 2026-08-16 用 adapter 自己的 browser.ts 抓下來的真實頁面產物
 * （渲染後 HTML ＋ 頁面自己載入的 GraphQL 回應 ＋ 房間清單的可見文字），
 * 跑測試不會碰到對方伺服器。
 *
 * 填充率監控抓不到「把 dormitory 的 0 當成免費房間」這種值全錯但填充率 100% 的故障，
 * 只有對答案的測試抓得到。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  parseSlugs, parseSakuraAddress, parseSakuraStations, parseAccessWalkMinutes,
  parseAvailableFrom, parseFloor, buildingKind, genderOf, statesAllInclusive,
  pickBuilding, buildListing, manifest,
  type SakuraHint,
} from '../sources/sakurahouse/index.ts';
import type { Listing } from '../../packages/schema/src/model.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/sakurahouse/fixtures');

function gz(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

function hintOf(slug: string): SakuraHint {
  return JSON.parse(gz(`building-${slug}.json.gz`)) as SakuraHint;
}

const FETCHED_AT = '2026-08-16T00:00:00.000Z';

function listingOf(slug: string): Listing | null {
  return buildListing(hintOf(slug), `https://www.sakura-house.com/building/${slug}`, FETCHED_AT);
}

const ALL_SLUGS = [
  'shinjuku-kagurazaka',
  'komazawa-heights',
  'kyoto-imadegawa',
  'tabata-3-dorm',
  'tabata-2-share-house-for-muslim-women',
  'yukigaya-otsuka',
] as const;

describe('manifest', () => {
  test('走瀏覽器且不再抓詳情頁', () => {
    assert.equal(manifest.transport, 'browser');
    assert.equal(manifest.fetchMode, 'none');
  });

  test('請求間隔至少 5 秒', () => {
    assert.ok(manifest.crawlDelayMs >= 5000, `crawlDelayMs=${manifest.crawlDelayMs}`);
  });

  test('provides 與 neverProvides 不重疊', () => {
    const never = new Set<string>(manifest.capabilities.neverProvides);
    for (const id of manifest.capabilities.provides) {
      assert.ok(!never.has(id), `${id} 同時出現在 provides 與 neverProvides`);
    }
  });

  test('legal.notes 逐字保留利用規約的著作權條與連結條', () => {
    assert.ok(manifest.legal.notes.includes(
      'the unauthorized usage, reproduction, revision, or distribution of all website Content',
    ));
    assert.ok(manifest.legal.notes.includes('the Company may deny the link at its own discretion'));
  });
});

describe('清單頁 slug 解析', () => {
  const html = gz('building-list.html.gz');

  test('渲染後的清單頁抓得到大量 slug', () => {
    const slugs = parseSlugs(html);
    assert.ok(slugs.length > 80, `只抓到 ${slugs.length} 個`);
    assert.ok(slugs.includes('shinjuku-kagurazaka'));
    assert.ok(slugs.includes('kyoto-imadegawa'));
  });

  test('去重', () => {
    const slugs = parseSlugs(html);
    assert.equal(new Set(slugs).size, slugs.length);
  });

  test('原始（未渲染）HTML 抓不到——這就是必須用瀏覽器的理由', () => {
    assert.deepEqual(parseSlugs('<a href="/building/">Building list</a>'), []);
  });
});

describe('住所解析', () => {
  test('東京都 23 区：只取到区，不把町吃進去', () => {
    assert.deepEqual(
      parseSakuraAddress('〒114-0012 東京都北区田端新町3-31-9'),
      { prefecture: '東京都', ward: '北区' },
    );
  });

  test('複合区名（世田谷区）非貪婪但要完整', () => {
    assert.deepEqual(
      parseSakuraAddress('〒154-0012 東京都世田谷区駒沢３丁目12−17 駒沢ハイツアネックス'),
      { prefecture: '東京都', ward: '世田谷区' },
    );
  });

  test('京都：都道府県要能分辨（收錄範圍過濾就靠它）', () => {
    assert.deepEqual(
      parseSakuraAddress('〒602-8449 京都府京都市上京区中筋通大宮西入横大宮町204'),
      { prefecture: '京都府', ward: '京都市' },
    );
  });

  test('東京都下的市', () => {
    assert.deepEqual(
      parseSakuraAddress('〒186-0002 東京都国立市東1-2-3'),
      { prefecture: '東京都', ward: '国立市' },
    );
  });

  test('郡下的町要連郡一起取', () => {
    assert.deepEqual(
      parseSakuraAddress('〒190-1200 東京都西多摩郡瑞穂町むさし野1-2'),
      { prefecture: '東京都', ward: '西多摩郡瑞穂町' },
    );
  });

  test('解析不出來回 null，不猜', () => {
    assert.equal(parseSakuraAddress('お問い合わせください'), null);
    assert.equal(parseSakuraAddress(''), null);
  });
});

describe('access 欄的步行時間', () => {
  test('`Kagurazaka sta. (T05) [Subway Tozai Line] - 3 min. walk`', () => {
    const m = parseAccessWalkMinutes(
      '<p><span><strong>Kagurazaka sta.</strong> (T05) [Subway Tozai Line] </span></p>\n<p><span>- 3 min. walk </span></p>',
    );
    assert.equal(m.get('kagurazaka')?.minutes, 3);
  });

  test('前面的「NEAREST STATIONS」小標不可被吃進站名', () => {
    // 神楽坂的真實 access 欄開頭就是這個小標；不砍掉的話站名會變成
    // 「NEAREST STATIONS Kagurazaka」，跟結構化站名對不上而漏掉步行時間。
    const m = parseAccessWalkMinutes(
      '<p><strong>NEAREST STATIONS</strong></p>'
      + '<p><span><strong>Kagurazaka sta.</strong> (T05) [Subway Tozai Line] </span></p>'
      + '<p><span>- 3 min. walk </span></p>'
      + '<p><span><strong>Ushigome Kagurazaka sta.</strong> (E05) [Subway Oedo Line] </span></p>'
      + '<p><span> -4 min. walk </span></p>',
    );
    assert.equal(m.get('kagurazaka')?.minutes, 3);
    assert.equal(m.get('ushigomekagurazaka')?.minutes, 4);
  });

  test('全大寫、無空格、`STATION` 寫法', () => {
    const m = parseAccessWalkMinutes('<strong>KAGURAZAKA STATION</strong>(T05)<br>[Subway Tozai line] <br>- 2 min. walk');
    assert.equal(m.get('kagurazaka')?.minutes, 2);
  });

  test('原站的錯字 `min. wall` 也要吃得下', () => {
    const m = parseAccessWalkMinutes('<p><strong>Wakamatsu-kawada sta. (E03) [Subway Oedo Line] </strong></p><p><span>- 11 min. wall</span></p>');
    assert.equal(m.get('wakamatsukawada')?.minutes, 11);
  });

  test('「APPROX. TIME TO KEY STATION」是搭車時間，不可當步行時間', () => {
    const m = parseAccessWalkMinutes(
      '<p><span>APPROX. TIME TO KEY STATION (including walking time) </span></p>'
      + '<p><span>Shinjuku - 15 min. | Shibuya - 20 min. | Ikebukuro - 20 min.</span></p>',
    );
    assert.equal(m.size, 0);
  });

  test('空字串 → 空 map，不丟例外', () => {
    assert.equal(parseAccessWalkMinutes('').size, 0);
  });
});

describe('車站解析', () => {
  test('`Kagurazaka(Tozai Line)` 拆成站名與路線，並補上步行時間', () => {
    const s = parseSakuraStations(
      [{ name: 'Kagurazaka(Tozai Line)', lineName: '' }],
      '<p><strong>Kagurazaka sta.</strong> (T05) [Subway Tozai Line]</p><p>- 3 min. walk</p>',
    );
    assert.equal(s.length, 1);
    assert.equal(s[0]?.station, 'Kagurazaka');
    assert.equal(s[0]?.line, 'Tozai Line');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 3);
  });

  test('access 欄拼字對不上時，步行時間留未知而不是硬塞', () => {
    // 原站實例：結構化寫 Ushigome-kagurazaka，access 欄寫 USIGOME（少一個 h）
    const s = parseSakuraStations(
      [{ name: 'Ushigome-kagurazaka(Toei Oedo Line)', lineName: '' }],
      '<strong>USIGOME KAGURAZAKA STATION</strong>(E05)<br>[Subway Oedo line] <br>- 7 min. walk',
    );
    assert.equal(s[0]?.station, 'Ushigome-kagurazaka');
    assert.equal(s[0]?.walkMinutes.known, false);
  });

  test('同名不同線視為兩筆', () => {
    const s = parseSakuraStations(
      [{ name: 'Tabata(Yamanote Line)' }, { name: 'Tabata(Keihin-Tohoku Line)' }],
      '',
    );
    assert.equal(s.length, 2);
  });

  test('沒有車站資料 → 空陣列', () => {
    assert.deepEqual(parseSakuraStations([], ''), []);
    assert.deepEqual(parseSakuraStations(undefined, ''), []);
  });
});

describe('小解析器', () => {
  test('入居可能日', () => {
    assert.equal(parseAvailableFrom('from now'), '随時');
    assert.equal(parseAvailableFrom('from 2026/08/31'), '2026-08-31');
    assert.equal(parseAvailableFrom('from 2027/1/5'), '2027-01-05');
    assert.equal(parseAvailableFrom(''), null);
    assert.equal(parseAvailableFrom('until 2026/10/08'), null);
  });

  test('樓層：地下不硬換算成負數', () => {
    assert.equal(parseFloor('1F'), 1);
    assert.equal(parseFloor('12F'), 12);
    assert.equal(parseFloor('B1F'), null);
    assert.equal(parseFloor('-'), null);
  });

  test('物件種類', () => {
    assert.equal(buildingKind(['ShareHouse']), 'sharehouse');
    assert.equal(buildingKind(['LuxuryApartment', 'Apartment']), 'apartment');
    assert.equal(buildingKind(['GuestHouse']), 'dormitory');
    assert.equal(buildingKind(['ShareHouse', 'GuestHouse']), 'sharehouse');
    assert.equal(buildingKind([]), 'unknown');
    assert.equal(buildingKind(undefined), 'unknown');
  });

  test('性別限制：沒標就是 unknown，不讀成 mixed', () => {
    assert.equal(genderOf(true, false), 'male_only');
    assert.equal(genderOf(false, true), 'female_only');
    assert.equal(genderOf(false, false), 'unknown');
    assert.equal(genderOf(undefined, undefined), 'unknown');
    assert.equal(genderOf(true, true), 'unknown');
  });

  test('「月額全包」必須是可見文字裡逐字出現的那一句', () => {
    assert.equal(statesAllInclusive('・Utility costs such as electricity, water, gas, furniture and regular maintenance are all included in the stated price.'), true);
    // 隱藏徽章「No deposit」不算數
    assert.equal(statesAllInclusive('No deposit\nFurnished\nNo hidden fee'), false);
  });
});

describe('神楽坂（share house，男性專用）', () => {
  const l = listingOf('shinjuku-kagurazaka');

  test('建物基本欄位', () => {
    assert.ok(l !== null);
    assert.equal(l.building.id, 'sakurahouse:shinjuku-kagurazaka');
    assert.equal(l.building.prefecture, '東京都');
    assert.equal(l.building.ward, '新宿区');
    assert.equal(l.building.kind, 'sharehouse');
    assert.equal(l.building.name, 'SAKURA HOUSE SHINJUKU KAGURAZAKA (TOKYO SHARE HOUSE)');
    // 原站不顯示門牌，我們只留到市区層級
    assert.equal(l.building.addressRaw, '東京都新宿区');
    assert.ok(!l.building.addressRaw.includes('神楽坂6-22'));
    assert.equal(l.building.totalUnits.known && l.building.totalUnits.v, 6);
  });

  test('車站：神楽坂駅 徒歩 3 分', () => {
    assert.ok(l !== null);
    const s = l.building.stations.find((x) => x.station === 'Kagurazaka');
    assert.equal(s?.line, 'Tozai Line');
    assert.equal(s?.walkMinutes.known && s.walkMinutes.v, 3);
  });

  test('只收畫面顯示 AVAILABLE 的房間（6 間裡 4 間）', () => {
    assert.ok(l !== null);
    assert.equal(l.units.length, 4);
    assert.deepEqual(l.units.map((u) => u.unitKey).sort(), ['101', '102', '202', '203']);
  });

  test('賃料與面積對得上原站畫面', () => {
    assert.ok(l !== null);
    const u101 = l.units.find((u) => u.unitKey === '101');
    // 原站畫面：ROOM 101 ／ 9.9m² ／ AVAILABLE from 2027/01/20 ／ ¥91,000 / month
    assert.equal(u101?.monthly.rent.known && u101.monthly.rent.v.jpy, 91_000);
    assert.equal(u101?.areaM2.known && u101.areaM2.v, 9.9);
    assert.equal(u101?.availableFrom.known && u101.availableFrom.v, '2027-01-20');
    assert.equal(u101?.floor.known && u101.floor.v, 1);
    assert.equal(u101?.genderRestriction, 'male_only');

    const u202 = l.units.find((u) => u.unitKey === '202');
    assert.equal(u202?.monthly.rent.known && u202.monthly.rent.v.jpy, 92_000);
    assert.equal(u202?.floor.known && u202.floor.v, 2);
  });

  test('OCCUPIED 的 103／201 不進來', () => {
    assert.ok(l !== null);
    assert.equal(l.units.find((u) => u.unitKey === '103'), undefined);
    assert.equal(l.units.find((u) => u.unitKey === '201'), undefined);
  });

  test('水電與管理費：0 且 basis 是 included_stated（有原文依據的 0）', () => {
    assert.ok(l !== null);
    const u = l.units[0];
    assert.ok(u !== undefined);
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.v.jpy, 0);
    assert.equal(u.monthly.utilities.basis, 'included_stated');
    assert.equal(u.monthly.adminFee.known && u.monthly.adminFee.v.jpy, 0);
    assert.equal(u.monthly.adminFee.basis, 'included_stated');
    assert.equal(u.utilitiesBasis, 'included');
    assert.ok(u.monthly.utilities.srcText.includes('are all included in the stated price'));
  });

  test('網路費：原站那句話沒提 internet → 不當成 0', () => {
    assert.ok(l !== null);
    const u = l.units[0];
    assert.equal(u?.monthly.internet.known, false);
  });

  test('附傢俱：依據同一句話裡的 furniture', () => {
    assert.ok(l !== null);
    assert.equal(l.units[0]?.furnished.known && l.units[0].furnished.v, true);
  });

  test('初期費用一律 not_offered_by_source（建物頁根本沒這些欄位）', () => {
    assert.ok(l !== null);
    const u = l.units[0];
    assert.ok(u !== undefined);
    for (const [id, f] of Object.entries(u.initial)) {
      assert.equal(f.known, false, `${id} 不該有值`);
      assert.equal(f.known === false && f.why, 'not_offered_by_source', id);
    }
  });
});

describe('駒沢（apartment，有折扣價）', () => {
  const l = listingOf('komazawa-heights');

  test('世田谷区的 apartment', () => {
    assert.ok(l !== null);
    assert.equal(l.building.ward, '世田谷区');
    assert.equal(l.building.kind, 'apartment');
  });

  test('rent 用原價，折扣價只記在 notes——不用期間限定價當基準', () => {
    assert.ok(l !== null);
    const u103 = l.units.find((u) => u.unitKey === '103');
    // 原站畫面：¥175,000 / month（劃掉）→ ¥155,000 / month「1 MONTH DISCOUNT for New residents only」
    assert.equal(u103?.monthly.rent.known && u103.monthly.rent.v.jpy, 175_000);
    assert.ok(u103?.notes.some((n) => n.includes('155,000')), JSON.stringify(u103?.notes));
    assert.ok(u103?.notes.some((n) => n.includes('1 MONTH DISCOUNT')), JSON.stringify(u103?.notes));
  });

  test('2 人可住的房間，把加人費的原文註記帶上', () => {
    assert.ok(l !== null);
    assert.ok(l.units[0]?.notes.some((n) => n.includes('Up to 2 people')));
  });

  test('沒有結構化車站資料時不硬生一個', () => {
    assert.ok(l !== null);
    assert.deepEqual(l.building.stations, []);
  });
});

describe('京都（收錄範圍外）', () => {
  test('京都府的物件回 null，不進資料', () => {
    assert.equal(listingOf('kyoto-imadegawa'), null);
  });
});

describe('田端 C（dormitory，價錢在床上）', () => {
  const l = listingOf('tabata-3-dorm');

  test('北区的 dormitory', () => {
    assert.ok(l !== null);
    assert.equal(l.building.ward, '北区');
    assert.equal(l.building.kind, 'dormitory');
  });

  test('一張床一個 Unit，房間層的 displayRate=0 絕不變成 ¥0 房間', () => {
    assert.ok(l !== null);
    assert.ok(l.units.length >= 8, `只有 ${l.units.length} 筆`);
    for (const u of l.units) {
      assert.ok(u.unitKey.includes('-'), `${u.unitKey} 應該是「房號-床號」`);
      assert.equal(u.monthly.rent.known, true, u.unitKey);
      assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 60_000);
    }
    // 房間層（101／102）本身不可成為 Unit
    assert.equal(l.units.find((u) => u.unitKey === '101'), undefined);
    assert.equal(l.units.find((u) => u.unitKey === '102'), undefined);
  });

  test('床沒有專有面積：整間 60㎡ 是共用的，不可填給單一張床', () => {
    assert.ok(l !== null);
    for (const u of l.units) {
      assert.equal(u.areaM2.known, false, u.unitKey);
      assert.ok(u.areaM2.srcText.includes('共用'), u.areaM2.srcText);
    }
  });

  test('男女分房：101 男性專用、102 女性專用', () => {
    assert.ok(l !== null);
    const male = l.units.filter((u) => u.unitKey.startsWith('101-'));
    const female = l.units.filter((u) => u.unitKey.startsWith('102-'));
    assert.ok(male.length > 0 && female.length > 0);
    assert.ok(male.every((u) => u.genderRestriction === 'male_only'));
    assert.ok(female.every((u) => u.genderRestriction === 'female_only'));
  });
});

describe('田端 B（女性專用 share house）', () => {
  const l = listingOf('tabata-2-share-house-for-muslim-women');

  test('女性專用會傳到每一間房', () => {
    assert.ok(l !== null);
    assert.ok(l.units.length > 0);
    assert.ok(l.units.every((u) => u.genderRestriction === 'female_only'));
  });

  test('`from now` → 随時', () => {
    assert.ok(l !== null);
    const u102 = l.units.find((u) => u.unitKey === '102');
    assert.equal(u102?.availableFrom.known && u102.availableFrom.v, '随時');
  });
});

describe('雪谷大塚（區域標題含川崎・横浜，但實際在大田区）', () => {
  test('用住所判斷收錄範圍，不用清單頁的區域標題', () => {
    const l = listingOf('yukigaya-otsuka');
    assert.ok(l !== null);
    assert.equal(l.building.prefecture, '東京都');
    assert.equal(l.building.ward, '大田区');
  });
});

describe('全來源的反虛構不變式', () => {
  const listings = ALL_SLUGS
    .map((s) => listingOf(s))
    .filter((l): l is Listing => l !== null);

  test('六個 fixture 有五個是東京都', () => {
    assert.equal(listings.length, 5);
  });

  test('金額 0 只允許出現在 included_stated', () => {
    for (const l of listings) {
      for (const u of l.units) {
        const groups = [u.monthly, u.initial, u.deferred];
        for (const g of groups) {
          for (const [id, f] of Object.entries(g)) {
            if (typeof f === 'string') continue;
            if (f.known && f.v.jpy === 0) {
              assert.equal(f.basis, 'included_stated', `${u.id} ${id} 出現沒有依據的 0`);
            }
          }
        }
      }
    }
  });

  test('每個 known 都帶非空 srcText', () => {
    for (const l of listings) {
      const b = l.building;
      for (const [id, f] of Object.entries(b)) {
        if (typeof f !== 'object' || f === null || !('known' in f)) continue;
        if (f.known) assert.notEqual(f.srcText, '', `building ${b.id} ${id}`);
      }
      for (const u of l.units) {
        for (const g of [u, u.monthly, u.initial, u.deferred]) {
          for (const [id, f] of Object.entries(g)) {
            if (typeof f !== 'object' || f === null || !('known' in f)) continue;
            if (f.known) assert.notEqual(f.srcText, '', `${u.id} ${id}`);
          }
        }
      }
    }
  });

  test('賃料全部是正數', () => {
    for (const l of listings) {
      for (const u of l.units) {
        assert.equal(u.monthly.rent.known, true, `${u.id} 沒有賃料`);
        if (u.monthly.rent.known) assert.ok(u.monthly.rent.v.jpy > 0, `${u.id} 賃料 ${u.monthly.rent.v.jpy}`);
      }
    }
  });

  test('沒有解析故障訊號（unparsed／conflicting）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const g of [u.monthly, u.initial, u.deferred]) {
          for (const [id, f] of Object.entries(g)) {
            if (typeof f === 'string') continue;
            if (!f.known) assert.notEqual(f.why, 'unparsed', `${u.id} ${id}`);
          }
        }
      }
    }
  });

  test('全部收錄的都是東京都，且 sourceUrl 指回原站', () => {
    for (const l of listings) {
      assert.equal(l.building.prefecture, '東京都');
      assert.ok(l.building.sourceUrl.startsWith('https://www.sakura-house.com/building/'));
      for (const u of l.units) assert.equal(u.sourceUrl, l.building.sourceUrl);
    }
  });

  test('全部 Unit 都是可入住的（isVacant）', () => {
    for (const l of listings) {
      for (const u of l.units) assert.equal(u.isVacant.known && u.isVacant.v, true, u.id);
    }
  });
});

describe('改版偵測：解不出來要大聲失敗', () => {
  test('payload 裡沒有 buildingBySiteKey → 丟例外', () => {
    assert.throws(
      () => buildListing({ graphql: ['{"data":{"meta":{}}}'], roomListText: '' }, 'x', FETCHED_AT),
      /找不到 buildingBySiteKey/,
    );
  });

  test('一間房都沒有 → 丟例外，不默默產出空建物', () => {
    const payload = JSON.stringify({
      data: { buildingBySiteKey: { siteKey: 'x', displayName: 'X', address: '〒100-0001 東京都千代田区1-1', houses: [] } },
    });
    assert.throws(
      () => buildListing({ graphql: [payload], roomListText: '' }, 'x', FETCHED_AT),
      /一間房都沒有/,
    );
  });

  test('住所解不出來 → 丟例外，不預設成東京', () => {
    const payload = JSON.stringify({
      data: { buildingBySiteKey: { siteKey: 'x', displayName: 'X', address: 'TBA', houses: [{ units: [{ name: '1F', rooms: [{ name: '1' }] }] }] } },
    });
    assert.throws(() => buildListing({ graphql: [payload], roomListText: '' }, 'x', FETCHED_AT), /解析不出都道府県/);
  });

  test('pickBuilding 對壞掉的 JSON 不丟例外，回 null', () => {
    assert.equal(pickBuilding(['not json at all buildingBySiteKey']), null);
    assert.equal(pickBuilding([]), null);
  });
});
