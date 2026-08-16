/**
 * Village House adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * 這裡測的重點是「零初期費用宣傳底下的真實成本」有沒有抓到：
 *   退去時クリーニング費用、短期解約違約金、火災保険——漏一個，這個來源在比價表上就假性最便宜。
 * 以及反向的：管理費不在靜態頁裡，**不可以**因為模擬器顯示 0 就填 0。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { adapter, manifest, vhCell, parseVhStations, parseVhRooms } from '../sources/villagehouse/index.ts';
import type { Listing } from '../../packages/schema/src/model.ts';
import { monthlyCost, initialCash } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/villagehouse/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

const sitemapIndex = fixture('sitemap-index.xml.gz');
const propertySitemap = fixture('sitemap-property-jp.xml.gz');
const gouchiHtml = fixture('detail-tokyo-gouchi-3057.html.gz');
const shibauraHtml = fixture('detail-tokyo-shibaura-3018.html.gz');
const hokkaidoHtml = fixture('detail-hokkaido-kawazoe-1043.html.gz');

const NOW = new Date('2026-08-16T00:00:00Z');
const GOUCHI_URL = 'https://www.villagehouse.jp/chintai/kanto/tokyo/akishima-shi-132071/gouchi-3057/';

function extract(html: string, url: string): Listing | null {
  return adapter.extract(
    { url, body: html, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url },
    { manifest, now: NOW },
  );
}

function fakeFetcher(bodies: Record<string, string>) {
  return {
    get: async (url: string) => {
      const key = Object.keys(bodies).find((k) => url.includes(k));
      if (key === undefined) throw new Error(`測試沒有準備這個 URL 的回應：${url}`);
      return {
        url, body: bodies[key] as string, fetchedAt: '2026-08-16T00:00:00Z',
        sha256: 'x', status: 200, notModified: false,
      };
    },
  };
}

describe('sitemap 列舉（discover）', () => {
  test('全國 1,064 筆，只取東京 7 筆', async () => {
    assert.equal([...propertySitemap.matchAll(/<loc>/g)].length, 1064);

    const refs: string[] = [];
    for await (const r of adapter.discover(
      { manifest, now: NOW },
      fakeFetcher({ '/sitemap.xml': sitemapIndex, 'sitemap_property_page_map_jp.xml': propertySitemap }),
    )) refs.push(r.url);

    assert.equal(refs.length, 7);
    assert.ok(refs.every((u) => u.includes('/chintai/kanto/tokyo/')), '列舉結果混進了非東京物件');
    assert.ok(refs.includes(GOUCHI_URL));
  });

  test('robots.txt 禁 /api/ → discover 只碰 sitemap，不打任何 /api/ 路徑', async () => {
    const asked: string[] = [];
    const f = fakeFetcher({ '/sitemap.xml': sitemapIndex, 'sitemap_property_page_map_jp.xml': propertySitemap });
    for await (const _ of adapter.discover(
      { manifest, now: NOW },
      { get: async (u: string) => { asked.push(u); return f.get(u); } },
    )) { /* 只是要收集請求過的 URL */ }
    assert.ok(asked.length > 0);
    assert.ok(asked.every((u) => !u.includes('/api/') && !u.includes('/ajax/')), asked.join(', '));
  });

  test('sitemap 結構改版時要大聲失敗，不可默默回 0 筆', async () => {
    await assert.rejects(async () => {
      for await (const _ of adapter.discover(
        { manifest, now: NOW },
        fakeFetcher({ '/sitemap.xml': '<sitemapindex></sitemapindex>' }),
      )) { /* 不該走到這裡 */ }
    }, /改版/);
  });
});

describe('物件情報表格', () => {
  test('欄位與原站逐項相符（ビレッジハウス郷地）', () => {
    assert.equal(vhCell(gouchiHtml, '所在地'), '東京都昭島市郷地町3-10');
    assert.equal(vhCell(gouchiHtml, '構造•階建て'), '鉄筋コンクリート造 / 4 階建');
    assert.equal(vhCell(gouchiHtml, '棟/戸数'), '全11棟 / 総戸数348戸');
    assert.equal(vhCell(gouchiHtml, '築年月'), '1968/01');
    assert.equal(vhCell(gouchiHtml, '火災保険'), '要加入 10,000 円～（2年）');
    assert.equal(
      vhCell(gouchiHtml, '短期解約違約金'),
      '1年未満の解約は3ヵ月分、2年未満の解約は2ヵ月分の解約違約金が発生します',
    );
    assert.equal(
      vhCell(gouchiHtml, '敷金/保証人'),
      '契約条件や審査の結果、敷金や連帯保証人を必要とする場合があります',
    );
  });

  test('不存在的欄位 → null，不回空字串混過去', () => {
    assert.equal(vhCell(gouchiHtml, '礼金'), null);
  });
});

describe('交通機關解析', () => {
  const stations = parseVhStations(gouchiHtml);

  test('站名在前、路線在後，不可對調', () => {
    assert.equal(stations[0]?.station, '西立川');
    assert.equal(stations[0]?.line, 'JR青梅線');
    assert.equal(stations[2]?.station, '小宮');
    assert.equal(stations[2]?.line, 'JR八高線(八王子～高麗川)');
  });

  test('「徒歩 23.0～26.0 分」是範圍 → 取下界 23，並在 srcText 標明', () => {
    assert.equal(stations[0]?.walkMinutes.known && stations[0].walkMinutes.v, 23);
    assert.ok(stations[0]?.walkMinutes.srcText.includes('範圍取下界'));
  });

  test('公車站不算車站——否則「離最近車站幾分鐘」會失真', () => {
    assert.equal(stations.length, 3);
    assert.ok(!stations.some((s) => s.station.includes('バス停留所')));
    assert.ok(gouchiHtml.includes('昭島団地入口バス停留所'), 'fixture 應含公車站，否則這個測試沒在測東西');
  });

  test('單一值（非範圍）的寫法也要解得出來', () => {
    const s = parseVhStations(shibauraHtml);
    assert.equal(s[0]?.station, '芝浦ふ頭');
    assert.equal(s[0]?.line, 'ゆりかもめ');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 6);
    assert.ok(!s[0]?.walkMinutes.srcText.includes('範圍'));
  });
});

describe('房間解析', () => {
  const rooms = parseVhRooms(gouchiHtml);

  test('5 間空房，房號與原站「内見予約」下拉選單一致', () => {
    assert.deepEqual(rooms.map((r) => r.roomNo), ['3-306', '3-207', '7-107', '2-301', '6-204']);
  });

  test('頁尾的內見／申込表單重複列出同一批房間，不可被重複收錄', () => {
    // 表單區在 container-company-profile 之後，切邊界沒切好會變成 10 間
    assert.equal(rooms.length, 5);
    assert.ok(gouchiHtml.includes('内見予約フォーム'));
  });

  test('房間欄位與原站逐項相符（3-306）', () => {
    const r = rooms[0];
    assert.ok(r);
    assert.equal(r.layout, '2K');
    assert.equal(r.areaRaw, '28.98m²');
    assert.equal(r.rentRaw, '¥52,300');
    assert.equal(r.depositRaw, '¥0');
    assert.equal(r.keyMoneyRaw, '¥0');
    assert.equal(r.floorRaw, '3');
    assert.equal(r.availableFromRaw, '2026-09-06');
    assert.equal(r.cleaningOnExitRaw, '35,065円（税込）、物件・間取り毎に異なる（1,210円/m² x 専有面積）');
  });

  test('退去時クリーニング費用逐間不同（依専有面積），不可全部套第一間的值', () => {
    assert.ok(rooms[0]?.cleaningOnExitRaw.startsWith('35,065円'), '2K');
    assert.ok(rooms[3]?.cleaningOnExitRaw.startsWith('70,131円'), '3DK');
  });

  test('フリーレント特典只掛在有的房間上', () => {
    assert.deepEqual(rooms[0]?.benefits, []);
    assert.deepEqual(rooms[3]?.benefits, ['フリーレント：賃料3ヵ月目フリーレント']);
  });

  test('空室なし（芝浦タワー）→ 0 間', () => {
    assert.equal(parseVhRooms(shibauraHtml).length, 0);
    assert.equal(extract(shibauraHtml, 'https://www.villagehouse.jp/chintai/kanto/tokyo/tokyo-wards-131032/shibaura-tower-3018/')?.units.length, 0);
  });
});

describe('端到端：extract 產出可比價的 Listing', () => {
  const listing = extract(gouchiHtml, GOUCHI_URL);

  test('building 欄位與原站相符', () => {
    assert.ok(listing);
    const b = listing.building;
    assert.equal(b.sourceId, 'villagehouse');
    assert.equal(b.id, 'villagehouse:gouchi-3057');
    assert.equal(b.name, 'ビレッジハウス郷地');
    assert.equal(b.kind, 'apartment');
    assert.equal(b.prefecture, '東京都');
    assert.equal(b.ward, '昭島市');
    assert.equal(b.structure.known && b.structure.v, '鉄筋コンクリート造');
    assert.equal(b.yearBuilt.known && b.yearBuilt.v, 1968);
    assert.equal(b.floorsAboveGround.known && b.floorsAboveGround.v, 4);
    assert.equal(b.totalUnits.known && b.totalUnits.v, 348);
  });

  test('賃料 ¥52,300；敷金・礼金是原站在這間房上明寫的 ¥0', () => {
    const u = listing?.units[0];
    assert.ok(u);
    assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 52_300);
    assert.equal(u.initial.deposit.known && u.initial.deposit.v.jpy, 0);
    assert.equal(u.initial.deposit.known && u.initial.deposit.srcText, '敷金: ¥0');
    assert.equal(u.initial.keyMoney.known && u.initial.keyMoney.v.jpy, 0);
    assert.equal(u.initial.keyMoney.known && u.initial.keyMoney.srcText, '礼金: ¥0');
  });

  test('非東京物件（北海道）→ null', () => {
    assert.equal(extract(hokkaidoHtml, 'https://www.villagehouse.jp/chintai/hokkaido/hokkaido/sapporo-shi-011002/kawazoe-1043/'), null);
  });
});

describe('反向成本：零初期費用宣傳底下的真實支出', () => {
  const units = extract(gouchiHtml, GOUCHI_URL)?.units ?? [];

  test('退去時クリーニング費用進 deferred，且逐間不同', () => {
    assert.equal(units[0]?.deferred.cleaningFeeOnExit.known && units[0].deferred.cleaningFeeOnExit.v.jpy, 35_065);
    assert.equal(units[3]?.deferred.cleaningFeeOnExit.known && units[3].deferred.cleaningFeeOnExit.v.jpy, 70_131);
  });

  test('短期解約違約金：3ヵ月分 × 該間房的賃料，且原文留在 srcText', () => {
    const u = units[0];
    assert.ok(u);
    const p = u.deferred.earlyTerminationPenalty;
    assert.equal(p.known && p.v.jpy, 3 * 52_300);
    assert.ok(p.known && p.srcText.includes('1年未満の解約は3ヵ月分'));
    assert.ok(p.known && p.srcText.includes('最高檔'));
    // 賃料不同的房間必須算出不同的違約金——套同一個數字就是抄錯房
    assert.equal(units[4]?.deferred.earlyTerminationPenalty.known && units[4].deferred.earlyTerminationPenalty.v.jpy, 3 * 83_400);
  });

  test('火災保険 10,000 円～ 取下限，且 notes 標明那是下限', () => {
    const u = units[0];
    assert.ok(u);
    assert.equal(u.initial.fireInsurance.known && u.initial.fireInsurance.v.jpy, 10_000);
    assert.ok(u.initial.fireInsurance.known && u.initial.fireInsurance.srcText.includes('～'));
    assert.ok(u.notes.some((n) => n.includes('下限')));
  });

  test('初期現金 = 敷金 0 + 礼金 0 + 火災保険 10,000，且仲介手数料等未知項要被列為缺項', () => {
    const u = units[0];
    assert.ok(u);
    const c = initialCash(u);
    assert.equal(c.lower.jpy, 10_000);
    assert.ok(c.missing.includes('agencyFee'), '仲介手数料未刊登，必須列為缺項而不是 0');
    assert.equal(c.completeness, 'LOWER_BOUND');
  });
});

describe('嚴禁虛構：管理費不可因為模擬器顯示 0 就填 0', () => {
  const u = extract(gouchiHtml, GOUCHI_URL)?.units[0];

  test('模擬器裡確實有「② 管理費 … 0 円」，但那是欄位預設值', () => {
    assert.ok(gouchiHtml.includes('管理費'), 'fixture 應含模擬器欄位，否則這個測試沒在測東西');
    assert.ok(u);
    assert.equal(u.monthly.adminFee.known, false);
    if (!u.monthly.adminFee.known) assert.equal(u.monthly.adminFee.why, 'not_listed_on_page');
    assert.ok(u.notes.some((n) => n.includes('管理費')), '缺這一項要在 notes 揭露');
  });

  test('月額只算得出賃料，管理費要出現在 missing 裡', () => {
    assert.ok(u);
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 52_300);
    assert.ok(m.missing.includes('adminFee'));
  });

  test('取引態様「貸主」不足以推出仲介手数料 = 0', () => {
    assert.ok(u);
    assert.equal(u.initial.agencyFee.known, false);
  });

  test('沒有任何金額欄位是「值為 0 但沒有依據」', () => {
    assert.ok(u);
    const money = [
      u.monthly.rent, u.monthly.adminFee, u.monthly.utilities, u.monthly.internet, u.monthly.otherMonthly,
      u.initial.keyMoney, u.initial.deposit, u.initial.depositNonRefundable, u.initial.agencyFee,
      u.initial.guarantorInitialFee, u.initial.fireInsurance, u.initial.keyExchangeFee,
      u.initial.contractFee, u.initial.cleaningFeeUpfront, u.initial.otherInitial,
      u.deferred.renewalFee, u.deferred.renewalAdminFee, u.deferred.cleaningFeeOnExit,
      u.deferred.earlyTerminationPenalty,
    ];
    for (const f of money) {
      if (f.known && f.v.jpy === 0) {
        assert.ok(f.basis === 'included_stated' || (f.basis === 'measured' && f.srcText.trim() !== ''),
          `金額 0 但沒有依據：basis=${f.basis} srcText=${JSON.stringify(f.srcText)}`);
      }
    }
  });

  test('每個 known 都帶非空 srcText', () => {
    assert.ok(u);
    const fields = [
      u.roomNo, u.layout, u.areaM2, u.floor, u.monthly.rent, u.initial.deposit, u.initial.keyMoney,
      u.initial.fireInsurance, u.deferred.cleaningFeeOnExit, u.deferred.earlyTerminationPenalty,
      u.isVacant, u.availableFrom, u.furnished,
    ];
    for (const f of fields) {
      if (f.known) assert.notEqual(f.srcText.trim(), '');
    }
  });
});

describe('capabilities 與法務宣告', () => {
  test('provides 與 neverProvides 沒有交集', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    for (const n of manifest.capabilities.neverProvides) assert.ok(!p.has(n), `${n} 同時出現在兩份清單`);
  });

  test('宣告 measured 的金額欄位都在 provides 裡（建置期閘門 3 的前置條件）', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    const u = extract(gouchiHtml, GOUCHI_URL)?.units[0];
    assert.ok(u);
    for (const [id, f] of [
      ['rent', u.monthly.rent], ['deposit', u.initial.deposit], ['keyMoney', u.initial.keyMoney],
      ['fireInsurance', u.initial.fireInsurance], ['cleaningFeeOnExit', u.deferred.cleaningFeeOnExit],
      ['earlyTerminationPenalty', u.deferred.earlyTerminationPenalty],
    ] as const) {
      assert.ok(f.known && f.basis === 'measured', id);
      assert.ok(p.has(id), `${id} 有值卻沒宣告在 provides`);
    }
  });

  test('legal.notes 逐字保留頁尾的著作權主張', () => {
    assert.ok(manifest.legal.notes.includes('©VILLAGE HOUSE. All rights reserved. （不許複製・禁無断転載）'));
    assert.ok(gouchiHtml.includes('（不許複製・禁無断転載）'), '原站頁尾確實有這句');
  });

  test('家具：原站明寫「※家具は含まれません」→ furnished = false（不是未知）', () => {
    const u = extract(gouchiHtml, GOUCHI_URL)?.units[0];
    assert.ok(u);
    assert.equal(u.furnished.known && u.furnished.v, false);
  });
});
