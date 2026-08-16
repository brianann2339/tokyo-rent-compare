/**
 * Social Apartment adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * 這裡測的重點是「填充率看不出來的錯」：
 *   - 初期費用不可以憑 FAQ 通則或活動banner 生出金額
 *   - 満室物件不可以生出房間
 *   - 非東京物件必須被排除
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, manifest, text, saRow, saOverview, parseSaStations, parseSaRooms, parseSaFloors,
} from '../sources/socialapartment/index.ts';
import type { Listing } from '../../packages/schema/src/model.ts';
import { monthlyCost } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/socialapartment/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

const listHtml = fixture('list-builds.html.gz');
const kasaiHtml = fixture('detail-tokyo-view77.html.gz');
const harajukuHtml = fixture('detail-tokyo-view19-full.html.gz');
const ebisuHtml = fixture('detail-tokyo-view5.html.gz');
const chibaHtml = fixture('detail-chiba-view28.html.gz');

const NOW = new Date('2026-08-16T00:00:00Z');

function extract(html: string, url: string): Listing | null {
  return adapter.extract(
    { url, body: html, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url },
    { manifest, now: NOW },
  );
}

const KASAI_URL = 'https://www.social-apartment.com/builds/tokyo/edogawa-ku/view/77';

describe('列表頁列舉（discover）', () => {
  test('/builds 一頁列完全國 49 棟，其中東京 31 棟', async () => {
    const all = new Set(
      [...listHtml.matchAll(/href="\/builds\/[A-Za-z-]+\/[A-Za-z0-9-]+\/view\/(\d+)"/g)].map((m) => m[1]),
    );
    assert.equal(all.size, 49);

    const refs: string[] = [];
    for await (const r of adapter.discover(
      { manifest, now: NOW },
      {
        get: async () => ({
          url: 'https://www.social-apartment.com/builds',
          body: listHtml,
          fetchedAt: '2026-08-16T00:00:00Z',
          sha256: 'x',
          status: 200,
          notModified: false,
        }),
      },
    )) refs.push(r.url);

    assert.equal(refs.length, 31);
    assert.ok(refs.every((u) => u.includes('/builds/tokyo/')), '列舉結果混進了非東京物件');
    assert.ok(refs.includes(KASAI_URL));
  });

  test('列表頁解析不到任何連結時要大聲失敗，不可默默回 0 筆', async () => {
    await assert.rejects(async () => {
      for await (const _ of adapter.discover(
        { manifest, now: NOW },
        {
          get: async () => ({
            url: 'x', body: '<html><body>改版了</body></html>',
            fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false,
          }),
        },
      )) { /* 不該走到這裡 */ }
    }, /改版/);
  });
});

describe('物件概要表格', () => {
  const seg = saOverview(text(kasaiHtml));

  test('找得到物件概要區段', () => {
    assert.ok(seg !== null);
  });

  test('欄位與原站逐項相符（ネイバーズ葛西）', () => {
    assert.ok(seg);
    assert.equal(saRow(seg, '物件名'), 'ネイバーズ葛西');
    assert.equal(saRow(seg, '所在地'), '東京都江戸川区東葛西4丁目37番7号');
    assert.equal(saRow(seg, '築年'), '1991年');
    assert.equal(saRow(seg, '構造'), '鉄筋コンクリート造陸屋根5階建');
    assert.equal(saRow(seg, '世帯数'), '72世帯');
    assert.equal(saRow(seg, '取引形態'), '貸主');
  });

  test('「2人入居 相談可 賃料 +30,000円」不會被誤讀成賃料列', () => {
    assert.ok(seg);
    assert.equal(saRow(seg, '賃料'), '56,000円 〜 80,000円 （最多賃料帯：68,000円）');
    assert.equal(saRow(seg, '2人入居'), '相談可 賃料 +30,000円');
  });
});

describe('樓層數解析（構造欄的三種寫法）', () => {
  test('「鉄筋コンクリート造陸屋根5階建」→ 5', () => {
    assert.equal(parseSaFloors('鉄筋コンクリート造陸屋根5階建'), 5);
  });
  test('「RC造地下1階地上4階建　(陸屋根)」→ 4（地上優先，不可讀到地下1階）', () => {
    assert.equal(parseSaFloors('RC造地下1階地上4階建　(陸屋根)'), 4);
  });
  test('「鉄筋コンクリート地上4階」（沒有「建」字）→ 4', () => {
    assert.equal(parseSaFloors('鉄筋コンクリート地上4階'), 4);
  });
  test('沒有樓層資訊 → null，不猜', () => {
    assert.equal(parseSaFloors('鉄骨造'), null);
  });
});

describe('車站解析', () => {
  test('單站', () => {
    const s = parseSaStations(text(kasaiHtml).slice(text(kasaiHtml).indexOf('物件概要')));
    assert.equal(s.length, 1);
    assert.equal(s[0]?.line, '東京メトロ東西線');
    assert.equal(s[0]?.station, '葛西');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 15);
  });

  test('多站，且含「・」的複合路線不可被切半', () => {
    const s = parseSaStations('｜ JR山手線 「原宿」駅 徒歩6分 ｜ ｜ JR山手線・東京メトロ副都心線 「北参道」駅 徒歩4分 ｜');
    assert.equal(s.length, 2);
    assert.equal(s[0]?.line, 'JR山手線');
    assert.equal(s[1]?.line, 'JR山手線・東京メトロ副都心線');
    assert.equal(s[1]?.station, '北参道');
  });

  test('完全相同的路線＋站名才去重', () => {
    const s = parseSaStations('｜ JR山手線 「目黒」駅 徒歩15分 ｜ ｜ JR山手線 「目黒」駅 徒歩15分 ｜ ｜ 東京メトロ南北線 「目黒」駅 徒歩15分 ｜');
    assert.equal(s.length, 2);
  });

  test('沒有車站資訊 → 空陣列，不丟例外', () => {
    assert.deepEqual(parseSaStations('｜ 徒歩圏内にスーパーあり ｜'), []);
  });
});

describe('空室情報解析', () => {
  test('ネイバーズ葛西：1 間空房，欄位與原站逐項相符', () => {
    const rooms = parseSaRooms(kasaiHtml);
    assert.equal(rooms.length, 1);
    const r = rooms[0];
    assert.ok(r);
    assert.equal(r.number, '413');
    assert.equal(r.rentRaw, '64,000円');
    assert.equal(r.adminRaw, '管理費 8,000円');
    assert.equal(r.layoutRaw, '1BR');
    assert.equal(r.areaRaw, '12.18㎡');
    assert.equal(r.availabilityRaw, '8月中旬入居可能');
  });

  test('満室物件（原宿）→ 0 間，不可生出房間', () => {
    assert.ok(harajukuHtml.includes('現在満室です'));
    assert.equal(parseSaRooms(harajukuHtml).length, 0);
    assert.equal(extract(harajukuHtml, 'https://www.social-apartment.com/builds/tokyo/shibuya-ku/view/19')?.units.length, 0);
  });

  test('多房物件（新検見川，3 間）房號、賃料各自獨立', () => {
    const rooms = parseSaRooms(chibaHtml);
    assert.deepEqual(rooms.map((r) => r.number), ['116', '121', '321']);
    assert.deepEqual(rooms.map((r) => r.rentRaw), ['42,000円', '40,000円', '42,000円']);
  });

  test('面積與間取り靠內容判定，不靠出現順序', () => {
    const r = parseSaRooms(ebisuHtml)[0];
    assert.ok(r);
    assert.equal(r.layoutRaw, '1BR');
    assert.equal(r.areaRaw, '13.52㎡');
  });
});

describe('端到端：extract 產出可比價的 Listing', () => {
  const listing = extract(kasaiHtml, KASAI_URL);

  test('building 欄位與原站相符', () => {
    assert.ok(listing);
    const b = listing.building;
    assert.equal(b.sourceId, 'socialapartment');
    assert.equal(b.id, 'socialapartment:77');
    assert.equal(b.name, 'ネイバーズ葛西');
    assert.equal(b.kind, 'social');
    assert.equal(b.prefecture, '東京都');
    assert.equal(b.ward, '江戸川区');
    assert.equal(b.yearBuilt.known && b.yearBuilt.v, 1991);
    assert.equal(b.floorsAboveGround.known && b.floorsAboveGround.v, 5);
    assert.equal(b.totalUnits.known && b.totalUnits.v, 72);
  });

  test('月額 = 賃料 64,000 + 管理費 8,000', () => {
    const u = listing?.units[0];
    assert.ok(u);
    assert.equal(u.monthly.rent.known && u.monthly.rent.v.jpy, 64_000);
    assert.equal(u.monthly.adminFee.known && u.monthly.adminFee.v.jpy, 8_000);
    assert.equal(monthlyCost(u).lower.jpy, 72_000);
    assert.equal(u.areaM2.known && u.areaM2.v, 12.18);
    assert.equal(u.layout.known && u.layout.v, '1BR');
    assert.equal(u.availableFrom.known && u.availableFrom.v, '8月中旬入居可能');
  });

  test('非東京物件（千葉）→ null', () => {
    assert.equal(extract(chibaHtml, 'https://www.social-apartment.com/builds/chiba/chiba-shi/view/28'), null);
  });
});

describe('嚴禁虛構：初期費用一個都不能生出來', () => {
  const u = extract(kasaiHtml, KASAI_URL)?.units[0];

  test('敷金／礼金／仲介手数料／保証料全部是 not_offered_by_source，不是 0', () => {
    assert.ok(u);
    for (const [id, f] of [
      ['keyMoney', u.initial.keyMoney], ['deposit', u.initial.deposit],
      ['agencyFee', u.initial.agencyFee], ['guarantorInitialFee', u.initial.guarantorInitialFee],
      ['fireInsurance', u.initial.fireInsurance], ['contractFee', u.initial.contractFee],
    ] as const) {
      assert.equal(f.known, false, `${id} 不該有值`);
      if (!f.known) assert.equal(f.why, 'not_offered_by_source', id);
    }
  });

  test('頁面上的「礼金無料」活動 banner 不可變成 礼金 = 0', () => {
    assert.ok(kasaiHtml.includes('礼金無料'), 'fixture 應含活動 banner，否則這個測試沒在測東西');
    assert.ok(u);
    assert.equal(u.initial.keyMoney.known, false);
    assert.ok(u.notes.some((n) => n.includes('礼金無料')), '活動條件應原文留在 notes 供使用者判讀');
  });

  test('「賃料1か月」是月數不是金額 → 違約金不換算成日圓', () => {
    assert.ok(u);
    assert.equal(u.deferred.earlyTerminationPenalty.known, false);
    assert.ok(u.deferred.earlyTerminationPenalty.srcText.includes('賃料1か月'));
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
      u.roomNo, u.layout, u.areaM2, u.monthly.rent, u.monthly.adminFee,
      u.isVacant, u.availableFrom,
    ];
    for (const f of fields) {
      if (f.known) assert.notEqual(f.srcText.trim(), '');
    }
  });
});

describe('capabilities 宣告與實際產出一致', () => {
  test('provides 與 neverProvides 沒有交集', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    for (const n of manifest.capabilities.neverProvides) assert.ok(!p.has(n), `${n} 同時出現在兩份清單`);
  });

  test('宣告 measured 的金額欄位都在 provides 裡（建置期閘門 3 的前置條件）', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    const u = extract(kasaiHtml, KASAI_URL)?.units[0];
    assert.ok(u);
    for (const [id, f] of [
      ['rent', u.monthly.rent], ['adminFee', u.monthly.adminFee],
    ] as const) {
      assert.ok(f.known && f.basis === 'measured');
      assert.ok(p.has(id), `${id} 有值卻沒宣告在 provides`);
    }
  });

  test('外國人條件全站不刊登（FAQ 通則不是物件屬性）', () => {
    const u = extract(kasaiHtml, KASAI_URL)?.units[0];
    assert.ok(u);
    for (const f of [
      u.foreigner.welcomed, u.foreigner.residenceCardRequired, u.foreigner.japaneseRequired,
      u.foreigner.guarantorCompanyRequired, u.foreigner.guarantorPersonRequired,
    ]) {
      assert.equal(f.known, false);
      if (!f.known) assert.equal(f.why, 'not_offered_by_source');
    }
  });
});
