/**
 * Leopalace21 adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 *
 * 這個來源最需要被測住的是「マンスリー的 price 是日額」——
 * 填充率監控看到的是 rent 100% 有值，完全抓不到「把 7,846 當成月租」這種錯，
 * 所以測試直接拿 fixture 的可見文字當證人：
 *   每一筆賃貸 price 都要能在頁面找到對應的「N.N万円」
 *   每一筆マンスリー price 都要能在頁面找到對應的「1日あたりN円」
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, manifest,
  parseLdNodes, pickLdType, parseOffers, parseLeaseMonths,
  parseLeoStations, parseBuildingSummary, kindOf, keyFromUrl,
  sitemapIndexUrls, tokyoPropertyUrls, feeField, monthsOrAmountField,
} from '../sources/leopalace21/index.ts';
import type { Listing, Unit } from '../../packages/schema/src/model.ts';
import type { Field, Yen } from '../../packages/schema/src/field.ts';
import { monthlyCost, initialCash, initialSunk, tierOf } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/leopalace21/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

/** 頁面可見文字。標籤換成 ｜，數字與單位被標籤切開的情形保留原樣。 */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/[ \t\r\n]+/g, ' ');
}

function comma(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 78000 → '7.8'（頁面上寫「7.8｜万円」） */
function manDisplay(jpy: number): string {
  return (jpy / 10_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

const CASES = [
  {
    file: 'detail-nakano-minamidai-dai3.html.gz',
    url: 'https://www.leopalace21.com/properties/common/tokyo/nakano-ku-13114/minamidai-dai3-00118',
    tokyo: true,
  },
  {
    file: 'detail-shibuya-sasazuka-nanzan.html.gz',
    url: 'https://www.leopalace21.com/properties/common/tokyo/shibuya-ku-13113/sasazuka-nanzan-56441',
    tokyo: true,
  },
  {
    file: 'detail-hachioji-green-glass.html.gz',
    url: 'https://www.leopalace21.com/properties/common/tokyo/hachioji-shi-13201/green-glass-07233',
    tokyo: true,
  },
  {
    file: 'detail-kodaira-cynthia-duke.html.gz',
    url: 'https://www.leopalace21.com/properties/common/tokyo/kodaira-shi-13211/cynthia-duke-39200',
    tokyo: true,
  },
  {
    file: 'detail-kanagawa-kinugasa-dai1.html.gz',
    url: 'https://www.leopalace21.com/properties/common/kanagawa/yokosuka-shi-14201/kinugasa-dai1-00908',
    tokyo: false,
  },
] as const;

const RAW = {
  url: '', body: '', fetchedAt: '2026-08-16T01:33:00Z', sha256: 'sha-for-test',
  status: 200, notModified: false,
};

function extract(file: string, url: string): Listing | null {
  return adapter.extract(
    { ...RAW, url, body: fixture(file) },
    { url },
    { manifest, now: new Date('2026-08-16T01:33:00Z') },
  );
}

const nakano = extract(CASES[0].file, CASES[0].url);
const kodaira = extract(CASES[3].file, CASES[3].url);

describe('JSON-LD 是這個來源的對外契約', () => {
  test('每個 fixture 都取得到 RealEstateListing 與 ApartmentComplex', () => {
    for (const c of CASES) {
      const nodes = parseLdNodes(fixture(c.file));
      assert.ok(nodes.length >= 4, `${c.file} 只有 ${nodes.length} 個 JSON-LD 節點`);
      assert.ok(pickLdType(nodes, 'RealEstateListing') !== null, c.file);
      assert.ok(pickLdType(nodes, 'ApartmentComplex') !== null, c.file);
    }
  });

  test('沒有 JSON-LD 就大聲失敗，不默默回空資料', () => {
    assert.throws(
      () => adapter.extract({ ...RAW, url: 'https://x/', body: '<html><body>改版了</body></html>' },
        { url: 'https://x/' }, { manifest, now: new Date() }),
      /找不到任何 JSON-LD/,
    );
  });

  test('JSON-LD 壞掉也大聲失敗', () => {
    assert.throws(
      () => parseLdNodes('<script type="application/ld+json">{ 壞掉 }</script>'),
      /JSON-LD 解析失敗/,
    );
  });
});

describe('leaseLength：賃貸與マンスリー必須分得開', () => {
  test('"24 months" → 24；"1 month" → 1', () => {
    assert.equal(parseLeaseMonths('24 months'), 24);
    assert.equal(parseLeaseMonths('1 month'), 1);
    assert.equal(parseLeaseMonths(' 6 Months '), 6);
  });

  test('看不懂就回 null，不猜', () => {
    assert.equal(parseLeaseMonths('2 years'), null);
    assert.equal(parseLeaseMonths(''), null);
    assert.equal(parseLeaseMonths(null), null);
    assert.equal(parseLeaseMonths('0 months'), null);
  });

  test('fixture 的 Offer 都被正確分到兩堆，沒有一筆是看不懂的', () => {
    for (const c of CASES) {
      const listing = pickLdType(parseLdNodes(fixture(c.file)), 'RealEstateListing');
      assert.ok(listing);
      const split = parseOffers(listing);
      assert.equal(split.unparseableLease, 0, `${c.file} 有看不懂的 leaseLength`);
      assert.ok(split.lease.length > 0, c.file);
      for (const o of split.lease) assert.ok(o.leaseMonths >= 2, `${c.file} ${o.roomLabel}`);
      for (const o of split.monthlyPlan) assert.equal(o.leaseMonths, 1, `${c.file} ${o.roomLabel}`);
    }
  });
});

/**
 * 這一組是本 adapter 的核心防呆。
 * 把「1日あたり7,846円」當成月租，填充率仍是 100%，只有對答案才抓得到。
 */
describe('マンスリーの price 是日額，絕不可變成月租', () => {
  test('每一筆賃貸 price 都能在頁面找到對應的「N.N万円」', () => {
    for (const c of CASES) {
      const html = fixture(c.file);
      const t = visibleText(html);
      const listing = pickLdType(parseLdNodes(html), 'RealEstateListing');
      assert.ok(listing);
      for (const o of parseOffers(listing).lease) {
        assert.ok(
          t.includes(`${manDisplay(o.priceJpy)}｜万円`),
          `${c.file} ${o.roomLabel}：price ${o.priceJpy} 在頁面上找不到「${manDisplay(o.priceJpy)}万円」`,
        );
      }
    }
  });

  test('每一筆マンスリー price 在頁面上寫的是「1日あたりN円」', () => {
    let checked = 0;
    for (const c of CASES) {
      const html = fixture(c.file);
      const t = visibleText(html);
      const listing = pickLdType(parseLdNodes(html), 'RealEstateListing');
      assert.ok(listing);
      for (const o of parseOffers(listing).monthlyPlan) {
        assert.ok(
          t.includes(`1日あたり${comma(o.priceJpy)}円`),
          `${c.file} ${o.roomLabel}：${o.priceJpy} 不是頁面上的日額`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 10, `只驗到 ${checked} 筆マンスリー`);
  });

  test('產出的 unit 沒有任何一筆把日額當成賃料', () => {
    for (const c of CASES) {
      const listing = extract(c.file, c.url);
      if (listing === null) continue;
      const ld = pickLdType(parseLdNodes(fixture(c.file)), 'RealEstateListing');
      assert.ok(ld);
      const daily = new Set(parseOffers(ld).monthlyPlan.map((o) => o.priceJpy));
      for (const u of listing.units) {
        assert.equal(u.monthly.rent.known, true);
        if (u.monthly.rent.known) {
          assert.ok(!daily.has(u.monthly.rent.v.jpy), `${c.file} ${u.unitKey}：賃料 ${u.monthly.rent.v.jpy} 是日額`);
          assert.ok(u.monthly.rent.v.jpy >= 10_000, `${c.file} ${u.unitKey}：賃料 ${u.monthly.rent.v.jpy} 低到不像月租`);
        }
      }
    }
  });

  test('マンスリー的存在有被揭露在 notes，而不是悄悄丟掉', () => {
    assert.ok(nakano);
    const u = nakano.units[0];
    assert.ok(u);
    assert.ok(u.notes.some((n) => n.includes('マンスリー') && n.includes('日額')), u.notes.join('|'));
  });
});

describe('車站解析', () => {
  test('多站、路線與站名分得開', () => {
    const s = parseLeoStations(
      '京王電鉄京王線「幡ヶ谷駅」徒歩13分、京王電鉄京王線「笹塚駅」徒歩16分、東京地下鉄方南支線「中野富士見町駅」徒歩18分',
    );
    assert.equal(s.length, 3);
    assert.equal(s[0]?.line, '京王電鉄京王線');
    assert.equal(s[0]?.station, '幡ヶ谷');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 13);
    assert.equal(s[2]?.station, '中野富士見町');
    assert.equal(s[2]?.walkMinutes.known && s[2].walkMinutes.v, 18);
  });

  test('路線名不以「線」結尾也要抓得到（北総鉄道）', () => {
    const s = parseLeoStations('北総鉄道「新柴又駅」徒歩8分、京成電鉄本線「京成小岩駅」徒歩15分');
    assert.equal(s[0]?.line, '北総鉄道');
    assert.equal(s[0]?.station, '新柴又');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 8);
    assert.equal(s[1]?.station, '京成小岩');
  });

  test('需搭公車時，徒歩分不可當成從車站走過去的時間', () => {
    const s = parseLeoStations('中央本線「八王子駅」バス15分 市民体育館下車 徒歩3分');
    assert.equal(s[0]?.station, '八王子');
    assert.equal(s[0]?.walkMinutes.known, false);
    assert.ok(s[0]?.walkMinutes.srcText.includes('公車'));
  });

  test('完全相同的路線＋站名才去重', () => {
    const s = parseLeoStations('山手線「渋谷駅」徒歩5分、東急東横線「渋谷駅」徒歩6分、山手線「渋谷駅」徒歩5分');
    assert.equal(s.length, 2);
  });

  test('空字串 → 空陣列，不丟例外', () => {
    assert.deepEqual(parseLeoStations(''), []);
  });

  test('fixture 的公車物件：站名有、步行時間留未知', () => {
    const l = extract(CASES[2].file, CASES[2].url);
    assert.ok(l);
    const bus = l.building.stations.find((s) => s.station === '八王子');
    assert.ok(bus, l.building.stations.map((s) => s.station).join(','));
    assert.equal(bus.walkMinutes.known, false);
    // 同一頁其他站是純步行，要照抓
    assert.equal(l.building.stations.find((s) => s.station === '山田')?.walkMinutes.known, true);
  });
});

describe('建物概要與 URL 鍵', () => {
  test('description 拆出樓層／建物種別／築年', () => {
    const s = parseBuildingSummary(
      '東京都中野区南台２−７−１ | 2階建てアパート | 1985年11月築 | 京王電鉄京王線「幡ヶ谷駅」徒歩13分',
    );
    assert.equal(s.floors, 2);
    assert.equal(s.buildingType, 'アパート');
    assert.equal(s.yearBuilt, 1985);
    assert.equal(s.builtRaw, '1985年11月築');
    assert.equal(s.floorsRaw, '2階建てアパート');
  });

  test('アパート與マンション都是一般賃貸住宅；不認得的種別不硬猜', () => {
    assert.equal(kindOf('アパート'), 'apartment');
    assert.equal(kindOf('マンション'), 'apartment');
    assert.equal(kindOf(''), 'unknown');
    assert.equal(kindOf('テラスハウス'), 'unknown');
  });

  test('URL 尾碼就是アパート番号（全國 25,387 筆實測唯一）', () => {
    assert.equal(
      keyFromUrl('https://www.leopalace21.com/properties/common/tokyo/nakano-ku-13114/minamidai-dai3-00118'),
      '00118',
    );
    assert.equal(
      keyFromUrl('https://www.leopalace21.com/properties/common/tokyo/shinagawa-ku-13109/5-and-5-04910'),
      '04910',
    );
    assert.equal(keyFromUrl('https://www.leopalace21.com/guide'), null);
  });
});

describe('sitemap 過濾', () => {
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex><sitemap><loc>https://www.leopalace21.com/sitemap_general_site_map_ja.xml</loc></sitemap>
<sitemap><loc>https://www.leopalace21.com/sitemap_image_map_ja_1.xml</loc></sitemap>
<sitemap><loc>https://www.leopalace21.com/sitemap_image_map_ja_13.xml</loc></sitemap>
<sitemap><loc>https://www.leopalace21.com/sitemap_image_map_en_1.xml</loc></sitemap></sitemapindex>`;

  test('只取日文版房源 sitemap（en/kr/cn/vn 是同一批物件的翻譯頁）', () => {
    assert.deepEqual(sitemapIndexUrls(index), [
      'https://www.leopalace21.com/sitemap_image_map_ja_1.xml',
      'https://www.leopalace21.com/sitemap_image_map_ja_13.xml',
    ]);
  });

  test('只取東京都的房源 URL，且不會誤抓 <image:loc>', () => {
    const xml = `<urlset>
<url><loc>https://www.leopalace21.com/properties/common/tokyo/nakano-ku-13114/minamidai-dai3-00118</loc>
<image:image><image:loc>https://prd-leopalace21.imagewave.pictures/ABC</image:loc></image:image></url>
<url><loc>https://www.leopalace21.com/properties/common/kanagawa/yokosuka-shi-14201/kinugasa-dai1-00908</loc></url>
</urlset>`;
    assert.deepEqual(tokyoPropertyUrls(xml), [
      'https://www.leopalace21.com/properties/common/tokyo/nakano-ku-13114/minamidai-dai3-00118',
    ]);
  });
});

describe('費用欄位：0 必須有依據，月數必須乘上賃料', () => {
  test('「不要」是有依據的 0', () => {
    const f = feeField('敷金', '不要');
    assert.equal(f.known, true);
    if (f.known) {
      assert.equal(f.v.jpy, 0);
      assert.equal(f.basis, 'measured');
      assert.equal(f.srcText, '敷金 不要');
    }
  });

  test('「応相談」是未知，不是 0', () => {
    const f = feeField('礼金', '応相談');
    assert.equal(f.known, false);
    if (!f.known) assert.equal(f.why, 'not_listed_on_page');
  });

  test('「礼金 1ヶ月」乘上賃料才是金額', () => {
    const f = monthsOrAmountField('礼金', '1ヶ月', 78_000);
    assert.equal(f.known, true);
    if (f.known) {
      assert.equal(f.v.jpy, 78_000);
      assert.equal(f.srcText, '礼金 1ヶ月 × 賃料 78,000円 = 78,000円');
    }
    const half = monthsOrAmountField('礼金', '0.5ヶ月', 80_000);
    assert.equal(half.known && half.v.jpy, 40_000);
  });

  test('賃料未知時絕不換算——寧可標成解析失敗', () => {
    const f = monthsOrAmountField('礼金', '1ヶ月', null);
    assert.equal(f.known, false);
    if (!f.known) {
      assert.equal(f.why, 'unparsed');
      assert.ok(f.srcText.includes('賃料未知'));
    }
  });

  test('明寫金額時直接採用', () => {
    const f = monthsOrAmountField('敷金', '50,000円', 78_000);
    assert.equal(f.known && f.v.jpy, 50_000);
  });
});

describe('端到端：レオパレス南台第３（中野区）逐欄對原站', () => {
  test('建物欄位與原站相符', () => {
    assert.ok(nakano);
    const b = nakano.building;
    assert.equal(b.id, 'leopalace21:00118');
    assert.equal(b.sourceId, 'leopalace21');
    assert.equal(b.sourceKey, '00118');
    assert.equal(b.name, 'レオパレス南台第３');
    assert.equal(b.kind, 'apartment');
    assert.equal(b.prefecture, '東京都');
    assert.equal(b.ward, '中野区');
    assert.equal(b.addressRaw, '東京都中野区南台２−７−１');
    assert.equal(b.yearBuilt.known && b.yearBuilt.v, 1985);
    assert.equal(b.floorsAboveGround.known && b.floorsAboveGround.v, 2);
    assert.equal(b.sourceUpdatedAt.known && b.sourceUpdatedAt.v, '2026-08-16');
    assert.ok(b.imageUrls.length > 0);
    assert.equal(b.htmlSha256, 'sha-for-test');
  });

  test('房間欄位與原站「7.8万円（共益費 6,500円）／仲介手数料 不要／敷金 不要／礼金 1ヶ月／1K／12.83㎡／105号室」相符', () => {
    assert.ok(nakano);
    assert.equal(nakano.units.length, 1);
    const u = nakano.units[0];
    assert.ok(u);
    assert.equal(u.id, 'leopalace21:00118#105');
    assert.equal(u.unitKey, '105');
    assert.equal(u.roomNo.known && u.roomNo.v, '105');
    assert.equal(u.layout.known && u.layout.v, '1K');
    assert.equal(u.areaM2.known && u.areaM2.v, 12.83);
    assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 78_000);
    assert.equal(u.monthly.adminFee.known && u.monthly.adminFee.v.jpy, 6_500);
    assert.equal(u.initial.agencyFee.known && u.initial.agencyFee.v.jpy, 0);
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 0);
    // 礼金 1ヶ月 = 賃料 78,000 × 1
    assert.equal(u.initial.keyMoney.known && u.initial.keyMoney.v.jpy, 78_000);
    assert.equal(u.contractMonths.known && u.contractMonths.v, 24);
    assert.equal(u.isVacant.known && u.isVacant.v, true);
    assert.equal(u.sourceUrl,
      'https://www.leopalace21.com/properties/chintai/tokyo/nakano-ku-13114/minamidai-dai3-00118/105');
  });

  test('月額＝賃料＋共益費；初期現金＝礼金（敷金與仲介都是有依據的 0）', () => {
    assert.ok(nakano);
    const u = nakano.units[0];
    assert.ok(u);
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 78_000 + 6_500);
    assert.equal(m.completeness, 'COMPLETE');
    assert.equal(tierOf(u, m), 'A');
    assert.equal(initialCash(u).lower.jpy, 78_000);
    assert.equal(initialSunk(u).lower.jpy, 78_000);
    // 建物頁沒有的欄位以警語承擔，不是憑空補值
    assert.ok(m.caveats.some((c) => c.includes('本來源不公開')));
  });

  test('一棟多房：小平市 10 間全部產出，房號各異', () => {
    assert.ok(kodaira);
    assert.equal(kodaira.units.length, 10);
    assert.equal(kodaira.building.name, 'レオパレスシンシア　デューク');
    assert.equal(kodaira.building.ward, '小平市');
    assert.equal(kodaira.building.floorsAboveGround.known && kodaira.building.floorsAboveGround.v, 4);
    const keys = kodaira.units.map((u) => u.unitKey);
    assert.deepEqual(keys, ['201', '202', '203', '205', '301', '302', '303', '304', '401', '403']);
    assert.equal(new Set(kodaira.units.map((u) => u.id)).size, 10);
    // 同棟不同房價格不同——不可被任何「取第一間」的邏輯抹平
    assert.deepEqual(
      kodaira.units.map((u) => (u.monthly.rent.known ? u.monthly.rent.v.jpy : null)),
      [84_000, 83_000, 83_000, 84_000, 86_000, 85_000, 85_000, 85_000, 87_000, 86_000],
    );
  });
});

describe('只收東京都', () => {
  test('神奈川的物件回 null（不是丟例外，那是「不在收錄範圍」）', () => {
    assert.equal(extract(CASES[4].file, CASES[4].url), null);
  });

  test('用結構化 addressRegion 判斷，不是掃整頁找「東京都」', () => {
    // 神奈川那一頁的導覽選單同樣出現「東京都」，掃全頁必然誤判
    assert.ok(fixture(CASES[4].file).includes('東京都'));
  });

  test('四個東京 fixture 全部收錄', () => {
    for (const c of CASES.filter((x) => x.tokyo)) {
      const l = extract(c.file, c.url);
      assert.ok(l, c.file);
      assert.equal(l.building.prefecture, '東京都');
    }
  });
});

describe('建置期閘門相容性', () => {
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

  const allUnits: Array<{ file: string; unit: Unit }> = [];
  for (const c of CASES) {
    const l = extract(c.file, c.url);
    if (l === null) continue;
    for (const u of l.units) allUnits.push({ file: c.file, unit: u });
  }

  test('抽到了 15 間房可驗（4 個東京 fixture）', () => {
    assert.equal(allUnits.length, 15);
  });

  test('[閘門1] 金額為 0 一律有依據（measured+原文 或 included_stated）', () => {
    for (const { file, unit } of allUnits) {
      for (const [id, f] of moneyOf(unit)) {
        if (!f.known || f.v.jpy !== 0) continue;
        assert.ok(
          f.basis === 'included_stated' || (f.basis === 'measured' && f.srcText.trim() !== ''),
          `${file} ${unit.id} 的 ${id}：0 但 basis=${f.basis} srcText=${JSON.stringify(f.srcText)}`,
        );
      }
    }
  });

  test('[閘門2] 每個 measured 都指得出原文出處', () => {
    for (const { file, unit } of allUnits) {
      const fields: ReadonlyArray<readonly [string, Field<unknown>]> = [
        ...moneyOf(unit),
        ['areaM2', unit.areaM2], ['layout', unit.layout], ['roomNo', unit.roomNo],
        ['isVacant', unit.isVacant], ['contractMonths', unit.contractMonths],
      ];
      for (const [id, f] of fields) {
        if (f.known && f.basis === 'measured') {
          assert.notEqual(f.srcText.trim(), '', `${file} ${unit.id} 的 ${id} srcText 為空`);
        }
      }
    }
    for (const c of CASES) {
      const l = extract(c.file, c.url);
      if (l === null) continue;
      const b = l.building;
      for (const [id, f] of [['yearBuilt', b.yearBuilt], ['floorsAboveGround', b.floorsAboveGround],
        ['sourceUpdatedAt', b.sourceUpdatedAt]] as const) {
        if (f.known && f.basis === 'measured') assert.notEqual(f.srcText.trim(), '', `${c.file} ${id}`);
      }
      for (const s of b.stations) {
        if (s.walkMinutes.known) assert.notEqual(s.walkMinutes.srcText.trim(), '', `${c.file} ${s.station}`);
      }
    }
  });

  test('[閘門3] 產出 measured 金額的欄位都在 capabilities.provides 內', () => {
    const provided = new Set<string>(manifest.capabilities.provides);
    for (const { file, unit } of allUnits) {
      for (const [id, f] of moneyOf(unit)) {
        if (f.known && f.basis === 'measured') {
          assert.ok(provided.has(id), `${file} ${unit.id} 產出了 provides 之外的 ${id}`);
        }
      }
    }
  });

  test('沒有任何欄位掉進 unparsed／conflicting（那是解析器壞掉的訊號）', () => {
    for (const { file, unit } of allUnits) {
      const fields: ReadonlyArray<readonly [string, Field<unknown>]> = [
        ...moneyOf(unit),
        ['areaM2', unit.areaM2], ['layout', unit.layout], ['roomNo', unit.roomNo],
      ];
      for (const [id, f] of fields) {
        if (!f.known) {
          assert.ok(f.why !== 'unparsed' && f.why !== 'conflicting',
            `${file} ${unit.id} 的 ${id} = ${f.why}：${f.srcText}`);
        }
      }
    }
  });
});

describe('capabilities 宣告與實際產出一致', () => {
  test('neverProvides 的欄位一律 not_offered_by_source，不是解析失敗', () => {
    assert.ok(nakano);
    const u = nakano.units[0];
    assert.ok(u);
    const never: ReadonlyArray<readonly [string, Field<unknown>]> = [
      ['utilities', u.monthly.utilities], ['internet', u.monthly.internet],
      ['otherMonthly', u.monthly.otherMonthly],
      ['depositNonRefundable', u.initial.depositNonRefundable],
      ['guarantorInitialFee', u.initial.guarantorInitialFee],
      ['fireInsurance', u.initial.fireInsurance], ['keyExchangeFee', u.initial.keyExchangeFee],
      ['contractFee', u.initial.contractFee], ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront],
      ['otherInitial', u.initial.otherInitial],
      ['renewalFee', u.deferred.renewalFee], ['renewalAdminFee', u.deferred.renewalAdminFee],
      ['cleaningFeeOnExit', u.deferred.cleaningFeeOnExit],
      ['earlyTerminationPenalty', u.deferred.earlyTerminationPenalty],
      ['floor', u.floor], ['furnished', u.furnished], ['availableFrom', u.availableFrom],
      ['minStayMonths', u.minStayMonths], ['ageLimitRaw', u.ageLimitRaw], ['petsAllowed', u.petsAllowed],
      ['structure', nakano.building.structure], ['totalUnits', nakano.building.totalUnits],
    ];
    for (const [id, f] of never) {
      assert.equal(f.known, false, id);
      if (!f.known) assert.equal(f.why, 'not_offered_by_source', id);
    }
  });

  test('provides 與 neverProvides 不重疊', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    for (const n of manifest.capabilities.neverProvides) {
      assert.ok(!p.has(n), `${n} 同時出現在 provides 與 neverProvides`);
    }
  });

  test('legal 存證有留下 robots 與利用規約原文', () => {
    assert.equal(manifest.legal.enabled, true);
    assert.equal(manifest.legal.robotsCheckedAt, '2026-08-16');
    assert.ok(manifest.legal.notes.includes('/estimate/*'));
    assert.ok(manifest.legal.notes.includes('私的利用'));
    assert.ok(manifest.crawlDelayMs >= 3000);
  });
});
