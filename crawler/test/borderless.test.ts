/**
 * BORDERLESS HOUSE adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * fixture 各自帶著一個實際踩到的坑：
 *   detail-roppongi            東京、16 床 3 間可租；含 2 人共用房（桌機版 HTML 會欄位錯位）
 *   detail-ikebukuro           東京、全滿（0 間可租）；最寄駅是另一種語序的英文寫法
 *   detail-osaka-tsuruhashi1   大阪——必須被排除
 *   sitemap.xml                57 個 /jp/sharehouse/ slug（含関西・仙台）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, manifest,
  parseSitemapSlugs, parseRegion, parseHouseCode, parseBhStations, parseBhRooms,
  parseInitialFees, parseAvailableFrom, genderOf,
} from '../sources/borderless/index.ts';
import type { Field, Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit } from '../../packages/schema/src/model.ts';
import { monthlyCost, initialCash } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/borderless/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

function extract(slug: string, file: string): Listing | null {
  const url = `https://www.borderless-house.com/jp/sharehouse/${slug}/`;
  return adapter.extract(
    {
      url, body: fixture(file), fetchedAt: '2026-08-16T00:00:00Z',
      sha256: 'sha-test', status: 200, notModified: false,
    },
    { url },
    { manifest, now: new Date('2026-08-16T00:00:00Z') },
  );
}

function unitOf(l: Listing | null, key: string): Unit {
  assert.ok(l, '應該解析出 Listing');
  const u = l.units.find((x) => x.unitKey === key);
  assert.ok(u, `找不到床號 ${key}（實際有：${l.units.map((x) => x.unitKey).join(', ')}）`);
  return u;
}

const roppongi = extract('roppongi', 'detail-roppongi.html.gz');
const ikebukuro = extract('ikebukuro', 'detail-ikebukuro.html.gz');

describe('sitemap 列舉', () => {
  const slugs = parseSitemapSlugs(fixture('sitemap.xml.gz'));

  test('57 個房源 slug（sitemap 共 58 筆 /jp/sharehouse/，扣掉索引頁）', () => {
    assert.equal(slugs.length, 57);
    assert.ok(slugs.includes('roppongi'));
    assert.ok(slugs.includes('ikebukuro'));
  });

  test('索引頁 /jp/sharehouse/ 本身不是房源', () => {
    assert.ok(!slugs.includes(''));
    for (const s of slugs) assert.notEqual(s.trim(), '');
  });

  test('/jp/tokyo/s-* 是車站導覽頁，不可混進房源清單', () => {
    const xml = fixture('sitemap.xml.gz');
    const stationPages = [...xml.matchAll(/\/jp\/tokyo\/s-[^<\s]*/g)].length;
    assert.ok(stationPages > 0, 'fixture 裡應該有車站導覽頁可以驗');
    for (const s of slugs) assert.ok(!s.startsWith('s-'), `${s} 是車站導覽頁`);
  });

  test('sitemap 不分地區——東京篩選只能在詳情頁做', () => {
    assert.ok(slugs.includes('tsuruhashi1'));                       // 大阪
    assert.ok(slugs.some((s) => s.startsWith('sendai')));           // 仙台
  });
});

describe('地區判定：只收東京', () => {
  test('麵包屑地域段是唯一的地區來源', () => {
    assert.equal(parseRegion(fixture('detail-roppongi.html.gz')), 'tokyo');
    assert.equal(parseRegion(fixture('detail-ikebukuro.html.gz')), 'tokyo');
    assert.equal(parseRegion(fixture('detail-osaka-tsuruhashi1.html.gz')), 'kansai');
  });

  test('大阪物件回 null（跳過），不是丟例外', () => {
    assert.equal(extract('tsuruhashi1', 'detail-osaka-tsuruhashi1.html.gz'), null);
  });

  test('全站不公開街道地址——ward 與 addressRaw 留空，不從站名反推', () => {
    assert.ok(roppongi);
    assert.equal(roppongi.building.addressRaw, '');
    assert.equal(roppongi.building.ward, '');
    assert.equal(roppongi.building.prefecture, '東京都');
    // 佐證：整頁確實沒有任何「東京都」「港区」字樣
    const html = fixture('detail-roppongi.html.gz');
    assert.ok(!html.includes('東京都'));
    assert.ok(!html.includes('港区'));
  });
});

describe('物件名稱與最寄駅', () => {
  test('名稱取自麵包屑的物件代號', () => {
    assert.equal(parseHouseCode(fixture('detail-roppongi.html.gz')), 'ROPPONGI1');
    assert.equal(roppongi?.building.name, 'BORDERLESS HOUSE ROPPONGI1');
  });

  test('語序 A：站名在前（roppongi）', () => {
    assert.ok(roppongi);
    assert.deepEqual(roppongi.building.stations.map((s) => s.station),
      ['Roppongi', 'Nogisaka', 'Azabujuban']);
    assert.equal(roppongi.building.stations[0]?.walkMinutes.known
      && roppongi.building.stations[0].walkMinutes.v, 4);
    assert.equal(roppongi.building.stations[0]?.line, 'Tokyo-Metro Hibiya/ Toei Oedo Line');
  });

  test('語序 B：路線在前（ikebukuro）', () => {
    assert.ok(ikebukuro);
    assert.deepEqual(ikebukuro.building.stations.map((s) => s.station),
      ['Mukaihara', 'Higashi-ikebukuro', 'Otsuka']);
    assert.equal(ikebukuro.building.stations[0]?.line, 'Toden Arakawa Line');
    assert.equal(ikebukuro.building.stations[1]?.walkMinutes.known
      && ikebukuro.building.stations[1].walkMinutes.v, 9);
  });

  test('語序 C：分鐘在最前面（数字開頭必須先於語序 B 比對，否則路線會吃掉數字）', () => {
    const s = parseBhStations(
      'The closest station</p><ul><li>6-minute walk to JR Yamanote Line Komagome Station</li></ul>');
    assert.equal(s.length, 1);
    assert.equal(s[0]?.line, 'JR Yamanote Line');
    assert.equal(s[0]?.station, 'Komagome');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 6);
  });

  test('語序 D：路線＋站名在前、分鐘在後（原文用全形空白分隔）', () => {
    const s = parseBhStations(
      'The closest station</p><ul><li>Toei Shinjuku Line　Kikukawa station 6mins walk</li></ul>');
    assert.equal(s[0]?.line, 'Toei Shinjuku Line');
    assert.equal(s[0]?.station, 'Kikukawa');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 6);
  });

  test('逗號沒有空白也要切得開', () => {
    const s = parseBhStations(
      'The closest station</p><ul><li>Kyodo Station,Odakyu Dentetsu Odawara Line,6mins walk.</li></ul>');
    assert.equal(s[0]?.line, 'Odakyu Dentetsu Odawara Line');
    assert.equal(s[0]?.station, 'Kyodo');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 6);
  });

  test('站方自己打錯的「Line Line」照原文保留，不擅自修改來源', () => {
    const s = parseBhStations(
      'The closest station</p><ul><li>Togoshi Station, Toei Asakusa Line Line 9mins walk</li></ul>');
    assert.equal(s[0]?.line, 'Toei Asakusa Line Line');
    assert.equal(s[0]?.station, 'Togoshi');
  });

  test('格式再變就跳過該行，不硬套', () => {
    assert.deepEqual(parseBhStations('The closest station</p><ul><li>somewhere near the park</li></ul>'), []);
  });

  test('整段沒有最寄駅區塊 → 空陣列（實測 chitose_funabashi 就是這樣）', () => {
    assert.deepEqual(parseBhStations('<html><body>no access section</body></html>'), []);
  });
});

describe('房間表：只能用手機版 HTML', () => {
  test('roppongi 共 16 床（桌機版有兩個面板，去重後不重複計）', () => {
    const rooms = parseBhRooms(fixture('detail-roppongi.html.gz'));
    assert.equal(rooms.length, 16);
    assert.equal(new Set(rooms.map((r) => r.bedNo)).size, 16);
  });

  test('2 人共用房的第 2 床在桌機版會少三欄，手機版才齊全', () => {
    const rooms = parseBhRooms(fixture('detail-roppongi.html.gz'));
    const r = rooms.find((x) => x.bedNo === '3A-2');
    assert.ok(r);
    // 桌機版 <tr class="open"> 那一列從床號直接跳到賃料，Room Type/Size/Gender 全部缺
    assert.equal(r.roomType, 'Room for 2');
    assert.equal(r.sizeRaw, '13.4㎡');
    assert.equal(r.genderRaw, 'Female');
  });

  test('每一床的必填欄位都拿得到', () => {
    for (const r of parseBhRooms(fixture('detail-roppongi.html.gz'))) {
      assert.notEqual(r.bedNo, '');
      assert.notEqual(r.status, '');
      assert.match(r.rentRaw, /^¥[\d,]+$/);
      assert.match(r.utilitiesRaw, /^¥[\d,]+$/);
      assert.match(r.sizeRaw, /㎡$/);
    }
  });

  test('國籍欄要單獨取，不能整格取（會黏成「Foreign nationality-」）', () => {
    const rooms = parseBhRooms(fixture('detail-roppongi.html.gz'));
    const open = rooms.filter((r) => r.nationalityRaw !== '-' && r.nationalityRaw !== '');
    assert.equal(open.length, 3);
    for (const r of open) assert.equal(r.nationalityRaw, 'Foreign nationality');
  });
});

describe('可入住日與性別欄', () => {
  test('Right Now → 随時；2026.09.24 → ISO；- → 未寫', () => {
    const now = parseAvailableFrom('Right Now');
    assert.equal(now.known && now.v, '随時');
    const d = parseAvailableFrom('2026.09.24');
    assert.equal(d.known && d.v, '2026-09-24');
    assert.equal(parseAvailableFrom('-').known, false);
  });

  test('Gender 欄是招募對象：Male/Female 就是限定，Any 是不限', () => {
    assert.equal(genderOf('Male'), 'male_only');
    assert.equal(genderOf('Female'), 'female_only');
    assert.equal(genderOf('Any'), 'mixed');
    assert.equal(genderOf(''), 'unknown');
  });
});

describe('入居費用：必須鎖定日本那一格', () => {
  const fees = parseInitialFees(fixture('detail-roppongi.html.gz'));

  test('礼金 30,000 円、清掃費 15,000 円（合計 45,000 円）', () => {
    assert.equal(fees.keyMoney.known && fees.keyMoney.v.jpy, 30000);
    assert.equal(fees.cleaning.known && fees.cleaning.v.jpy, 15000);
  });

  test('同一頁的韓國 800,000won／500,000won 不可被當成日圓', () => {
    const html = fixture('detail-roppongi.html.gz');
    assert.ok(html.includes('800,000won'), 'fixture 裡應該有韓國段落可以驗');
    assert.ok(!fees.raw.includes('won'));
    for (const f of [fees.keyMoney, fees.cleaning]) {
      assert.ok(f.known && f.v.jpy < 100_000);
    }
  });
});

describe('ROPPONGI1 逐欄對照原站', () => {
  test('建物層', () => {
    assert.ok(roppongi);
    assert.equal(roppongi.building.sourceId, 'borderless');
    assert.equal(roppongi.building.kind, 'sharehouse');
    assert.equal(roppongi.building.sourceKey, 'roppongi');
    assert.equal(roppongi.building.totalUnits.known && roppongi.building.totalUnits.v, 16);
  });

  test('只收 Open 與 Will Open，Occupied 不列（16 床中 3 床）', () => {
    assert.ok(roppongi);
    assert.deepEqual(roppongi.units.map((u) => u.unitKey), ['2D-1', '3A-2', '3C-1']);
  });

  test('3A-2：即入居可的 2 人共用房', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 59000);
    assert.equal(u.monthly.utilities.known && u.monthly.utilities.v.jpy, 11000);
    assert.equal(u.areaM2.known && u.areaM2.v, 13.4);
    assert.equal(u.layout.known && u.layout.v, 'Room for 2');
    assert.equal(u.genderRestriction, 'female_only');
    assert.equal(u.isVacant.known && u.isVacant.v, true);
    assert.equal(u.availableFrom.known && u.availableFrom.v, '随時');
  });

  test('共用房的面積是整間的，要在 notes 講清楚', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.ok(u.notes.some((n) => n.includes('部屋全体')), u.notes.join(' | '));
    // 單人房不該有這條
    assert.ok(!unitOf(roppongi, '2D-1').notes.some((n) => n.includes('部屋全体')));
  });

  test('2D-1 / 3C-1：空室予定，isVacant = false 但有可入住日', () => {
    const a = unitOf(roppongi, '2D-1');
    assert.equal(a.monthly.rent.known && a.monthly.rent.v.jpy, 81000);
    assert.equal(a.monthly.utilities.known && a.monthly.utilities.v.jpy, 14000);
    assert.equal(a.areaM2.known && a.areaM2.v, 7.5);
    assert.equal(a.isVacant.known && a.isVacant.v, false);
    assert.equal(a.availableFrom.known && a.availableFrom.v, '2026-09-24');
    const b = unitOf(roppongi, '3C-1');
    assert.equal(b.availableFrom.known && b.availableFrom.v, '2026-08-25');
  });

  test('最低居住期間 1 個月（英文句子）', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.equal(u.minStayMonths.known && u.minStayMonths.v, 1);
    assert.match(u.minStayMonths.known ? u.minStayMonths.srcText : '', /Minimum of 1 month/);
  });

  test('房內設備清單 → 附傢俱；長文案內不混進出處字串', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.equal(u.furnished.known && u.furnished.v, true);
    assert.match(u.furnished.known ? u.furnished.srcText : '', /Bed/);
    assert.ok(!(u.furnished.known && u.furnished.srcText.includes('bedding set')));
  });

  test('國籍欄是逐床硬條件：Foreign nationality → 外國人明確可租', () => {
    for (const key of ['2D-1', '3A-2', '3C-1']) {
      const u = unitOf(roppongi, key);
      assert.equal(u.foreigner.welcomed.known && u.foreigner.welcomed.v, true);
      assert.match(u.foreigner.welcomed.known ? u.foreigner.welcomed.srcText : '', /Foreign nationality/);
    }
  });
});

describe('這個來源的核心價值：水電網路是已知金額但不含在賃料裡', () => {
  test('utilitiesBasis = excluded 且金額已知', () => {
    for (const u of roppongi?.units ?? []) {
      assert.equal(u.utilitiesBasis, 'excluded');
      assert.equal(u.monthly.utilities.known, true);
    }
  });

  test('同一筆金額涵蓋水電與網路 → 網路費 0，basis 是 included_stated', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.equal(u.monthly.internet.known && u.monthly.internet.v.jpy, 0);
    assert.equal(u.monthly.internet.known && u.monthly.internet.basis, 'included_stated');
  });

  test('月額 = 賃料 + 水電網路，且是 COMPLETE 不是下界', () => {
    const u = unitOf(roppongi, '3A-2');
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 59000 + 11000);
    assert.equal(m.completeness, 'COMPLETE');
  });

  test('初期現金 = 礼金 30,000 + 清掃費 15,000', () => {
    const c = initialCash(unitOf(roppongi, '3A-2'));
    assert.equal(c.lower.jpy, 45000);
  });
});

describe('沒說的事就是沒說', () => {
  test('敷金：日本的說明完全沒提 → not_offered，絕不寫成 0', () => {
    for (const u of roppongi?.units ?? []) {
      assert.equal(u.initial.deposit.known, false);
      assert.equal(u.initial.deposit.known === false && u.initial.deposit.why, 'not_offered_by_source');
      assert.ok(u.notes.some((n) => n.includes('敷金')), '敷金的說明要留在 notes 供使用者判讀');
    }
  });

  test('寝具レンタル 12,000 円是選配，不計入初期費用', () => {
    const u = unitOf(roppongi, '3A-2');
    assert.equal(u.initial.otherInitial.known, false);
    assert.ok(u.notes.some((n) => n.includes('12,000')));
  });

  test('全滿的物件產出 0 間房，但建物本身仍然收錄', () => {
    assert.ok(ikebukuro);
    assert.equal(ikebukuro.units.length, 0);
    assert.equal(ikebukuro.building.totalUnits.known && ikebukuro.building.totalUnits.v, 11);
  });
});

describe('版面改動要大聲失敗', () => {
  test('沒有麵包屑就丟例外', () => {
    assert.throws(() => adapter.extract(
      {
        url: 'https://www.borderless-house.com/jp/sharehouse/x/', body: '<html><body>maintenance</body></html>',
        fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false,
      },
      { url: 'https://www.borderless-house.com/jp/sharehouse/x/' },
      { manifest, now: new Date() },
    ), /麵包屑|breadcrumb/);
  });

  test('東京物件但房間表解析出 0 間 → 丟例外，不默默產出空建物', () => {
    const html = fixture('detail-roppongi.html.gz').replace(/<div class="housegrid /g, '<div class="XXX ');
    assert.throws(() => adapter.extract(
      {
        url: 'https://www.borderless-house.com/jp/sharehouse/roppongi/', body: html,
        fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false,
      },
      { url: 'https://www.borderless-house.com/jp/sharehouse/roppongi/' },
      { manifest, now: new Date() },
    ), /0 間/);
  });
});

describe('建置閘門的規則在這裡就先擋住', () => {
  const listings = [roppongi, ikebukuro].filter((l): l is Listing => l !== null);

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

  test('閘門1：金額 0 一律要有依據（included_stated 或 measured＋原文）', () => {
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

  test('沒有任何欄位是 unparsed（解析器故障訊號）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        for (const [id, f] of moneyOf(u)) {
          assert.notEqual(f.known === false && f.why, 'unparsed', `${u.id} 的 ${id} 解析失敗`);
        }
      }
    }
  });

  test('賃料落在合理範圍（不是把面積或電話當成賃料）', () => {
    for (const l of listings) {
      for (const u of l.units) {
        assert.ok(u.monthly.rent.known);
        assert.ok(u.monthly.rent.known && u.monthly.rent.v.jpy > 10_000 && u.monthly.rent.v.jpy < 3_000_000);
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
});
