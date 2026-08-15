/**
 * ひつじ不動産 adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * 填充率監控抓不到「把 1ヶ月 解析成 1 円」這種值全錯但填充率 100% 的故障，
 * 只有這種對答案的測試抓得到——兩者互補，缺一不可。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  parseSummaries, parseRooms, keysFromUrl, adapter, parseComretCount, pageForCount,
} from '../sources/hituji/index.ts';
import { reassembleFlight, sliceBalanced } from '../src/rsc.ts';
import { monthlyCost, initialCash, tierOf } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/hituji/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

const listHtml = fixture('list-tokyo-page1.html.gz');
const akasakaHtml = fixture('detail-tokyo-sync-akasaka.html.gz');

describe('RSC payload 重組', () => {
  test('重組出可掃描的 buffer', () => {
    const buf = reassembleFlight(listHtml);
    assert.ok(buf.length > 100_000, `buffer 長度 ${buf.length}`);
    assert.ok(buf.includes('comretsInfo'));
  });

  test('大括號配對掃描能正確處理字串內的括號', () => {
    const s = '{"a":"}{","b":{"c":1}}rest';
    assert.equal(sliceBalanced(s, 0), '{"a":"}{","b":{"c":1}}');
  });

  test('跳脫字元不會弄亂配對', () => {
    const s = '{"a":"say \\"}\\"","b":2}tail';
    assert.equal(sliceBalanced(s, 0), '{"a":"say \\"}\\"","b":2}');
  });
});

describe('列表頁解析', () => {
  const summaries = parseSummaries(listHtml);

  test('HTML 版 page=1 解析出 30 筆卡片', () => {
    assert.equal(summaries.length, 30);
  });

  test('RSC 版與 HTML 版解析結果一致（同一頁、兩種回應格式）', () => {
    const rsc = parseSummaries(fixture('list-tokyo-rsc-page1.txt.gz'));
    assert.equal(rsc.length, 30);
    assert.deepEqual(rsc.map((s) => s.webUrl).sort(), summaries.map((s) => s.webUrl).sort());
  });

  test('站方自報總筆數，並據此反推需要的頁碼', () => {
    const count = parseComretCount(fixture('list-tokyo-rsc-page1.txt.gz'));
    assert.equal(count, 1244);
    // 30 + 26×(N-1) ≥ 1244 → N = 48（2026-08-16 實測 page=48 確實回傳 1,244 筆）
    assert.equal(pageForCount(1244), 48);
    assert.equal(pageForCount(30), 1);
    assert.equal(pageForCount(56), 2);
  });

  test('每筆都有 webUrl 與 name', () => {
    for (const s of summaries) {
      assert.equal(typeof s.webUrl, 'string');
      assert.ok(s.webUrl.startsWith('https://www.hituji.jp/comret/info/'));
      assert.ok(s.name.length > 0);
    }
  });

  test('外國人可租是結構化布林欄位，不是自由文字', () => {
    const withFlag = summaries.filter((s) => typeof s.hasAvailableRoomForForeigner === 'boolean');
    assert.ok(withFlag.length / summaries.length > 0.9,
      `只有 ${withFlag.length}/${summaries.length} 筆有 hasAvailableRoomForForeigner`);
  });

  test('租金範圍欄位存在且合理', () => {
    const withRent = summaries.filter((s) => typeof s.minRent === 'number' && s.minRent > 0);
    assert.ok(withRent.length / summaries.length > 0.8);
    for (const s of withRent) {
      assert.ok((s.minRent as number) >= 10_000 && (s.minRent as number) <= 500_000, `${s.name}: ${s.minRent}`);
    }
  });

  test('URL 可拆出 ward 與 slug', () => {
    const k = keysFromUrl('https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka');
    assert.deepEqual(k, { ward: 'minato', slug: 'tokyo-sync-akasaka' });
  });
});

describe('詳情頁房間解析 — TOKYO SYNC 赤坂', () => {
  const rooms = parseRooms(akasakaHtml);

  test('解析出 1 間空房（該棟 23 室、空室 1）', () => {
    assert.equal(rooms.length, 1);
  });

  test('房間欄位與原站頁面逐項相符', () => {
    const r = rooms[0];
    assert.ok(r);
    assert.equal(r.number, '409');
    assert.equal(r.rent, 95000);
    assert.equal(r.commonServiceFee, 20000);
    assert.equal(r.deposit, 50000);
    assert.equal(r.keyMoney, 95000);
    assert.equal(r.sizeSquareMeter, '9.8');
    assert.equal(r.sizeJou, '6');
    assert.equal(r.availabilityLabel, '空室予定');
  });
});

describe('端到端：extract 產出可比價的 Listing', () => {
  const summaries = parseSummaries(listHtml);
  const target = summaries.find((s) => s.webUrl.includes('/minato/tokyo-sync-akasaka'))
    ?? summaries[0];

  test('可組出 building + units', () => {
    assert.ok(target);
    const listing = adapter.extract(
      { url: target.webUrl, body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: target.webUrl, hint: target as unknown as Record<string, unknown> },
      { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
    );
    assert.ok(listing);
    assert.equal(listing.building.sourceId, 'hituji');
    assert.equal(listing.building.prefecture, '東京都');
    assert.ok(listing.units.length >= 1);
  });

  test('月額 = 賃料 + 共益費，且水電未知時標為 LOWER_BOUND', () => {
    const listing = adapter.extract(
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      {
        url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka',
        hint: { id: 596, name: 'TOKYO SYNC 赤坂', webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', hasAvailableRoomForForeigner: true, tenancyConditionDescription: '男性 女性 外国人歓迎' } as Record<string, unknown>,
      },
      { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
    );
    assert.ok(listing);
    const u = listing.units[0];
    assert.ok(u);
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 95000 + 20000);
    // 站上沒說水電含不含 → 不可宣稱含，必須是下界
    assert.equal(m.completeness, 'LOWER_BOUND');
    assert.equal(u.utilitiesBasis, 'unknown');

    // 初期現金 = 敷金 50,000 + 礼金 95,000（其餘欄位站上不提供）
    const c = initialCash(u);
    assert.equal(c.lower.jpy, 145000);
    assert.equal(tierOf(u, m), 'B');
  });

  test('性別條件由標籤列解析', () => {
    const listing = adapter.extract(
      { url: 'https://x/', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', hint: { id: 1, name: 'x', webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', tenancyConditionDescription: '女性 外国人歓迎' } as Record<string, unknown> },
      { manifest: adapter.manifest, now: new Date() },
    );
    assert.equal(listing?.units[0]?.genderRestriction, 'female_only');
  });
});

describe('水電基準判定（抽樣 7 個物件所得的規則）', () => {
  test('variableCommonServiceFee 為「実費」時 → excluded', () => {
    const html = fixture('detail-sample3.html.gz');
    const rooms = parseRooms(html);
    assert.ok(rooms.length > 0);
    assert.equal(rooms[0]?.variableCommonServiceFee, '実費');
    assert.equal(rooms[0]?.utilities, '6000実費');
    assert.equal(rooms[0]?.commonServiceFee, 6000);
  });

  test('utilities 欄位是 common + variable 的顯示串接，不是獨立金額', () => {
    for (const n of ['detail-sample1', 'detail-sample2', 'detail-sample4', 'detail-sample5', 'detail-sample6']) {
      for (const r of parseRooms(fixture(`${n}.html.gz`))) {
        assert.equal(r.utilities, `${r.commonServiceFee}${r.variableCommonServiceFee}`,
          `${n} 号${r.number}`);
      }
    }
  });
});

describe('capabilities 宣告與實際產出一致', () => {
  test('neverProvides 的欄位一律是 not_offered_by_source，不是解析失敗', () => {
    const listing = adapter.extract(
      { url: 'https://x/', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', hint: { id: 1, name: 'x', webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka' } as Record<string, unknown> },
      { manifest: adapter.manifest, now: new Date() },
    );
    const u = listing?.units[0];
    assert.ok(u);
    for (const f of [u.initial.agencyFee, u.initial.fireInsurance, u.deferred.renewalFee]) {
      assert.equal(f.known, false);
      if (!f.known) assert.equal(f.why, 'not_offered_by_source');
    }
  });
});
