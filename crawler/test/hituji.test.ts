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
  parseSummaries, parseRooms, parseDetail, keysFromUrl, adapter, parseComretCount, pageForCount,
} from '../sources/hituji/index.ts';
import { reassembleFlight, sliceBalanced } from '../src/rsc.ts';
import { parseStayBucketsMinMonths } from '../../packages/jp-parse/src/contract.ts';
import { monthlyCost, initialCash, tierOf } from '../../packages/cost-model/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/hituji/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

const listHtml = fixture('list-tokyo-page1.html.gz');
const akasakaHtml = fixture('detail-tokyo-sync-akasaka.html.gz');
// 府中 WILL：介紹文裡「外国人講師…」比入居条件欄更早出現，
// 是 2026-09-06 稽核抓到的「行銷文案劫持入居条件」那一棟。
const willFuchuHtml = fixture('detail-will-fuchu.html.gz');

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

  test('月額 = 賃料 + 共益費；水電未知與來源侷限都以警語承擔', () => {
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
    assert.equal(u.utilitiesBasis, 'unknown');
    // 站上沒說水電含不含 → 不可宣稱含，但這是警語不是缺項
    assert.ok(m.caveats.some((c) => c.includes('水電')));
    assert.equal(m.completeness, 'COMPLETE');
    assert.equal(tierOf(u, m), 'A');

    // 初期現金 = 敷金 50,000 + 礼金 95,000；其餘欄位整個來源都不公開 → 揭露
    const c = initialCash(u);
    assert.equal(c.lower.jpy, 145000);
    assert.ok(c.caveats.some((x) => x.includes('本來源不公開')));
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

describe('個室 vs ドミトリー 必須分得出來', () => {
  test('兩個陣列合併前先標記來源，否則相部屋會被標成個室', () => {
    // 2026-08-16 親自比對 HAKUSAN HOUSE 原站時發現的實際錯誤
    const rooms = parseRooms(akasakaHtml);
    assert.ok(rooms.every((r) => r.__kind === '個室'), '赤坂全為個室');
  });

  test('房間物件本身沒有任何欄位能區分房型', () => {
    const rooms = parseRooms(akasakaHtml);
    const r = rooms[0];
    assert.ok(r);
    const { __kind, ...rawFields } = r;
    assert.ok(__kind !== undefined);
    // 原始 payload 的欄位裡沒有任何一個提到房型 → 只能靠來源陣列判斷
    assert.ok(!Object.keys(rawFields).some((k) => /kind|type|dormitory|single/i.test(k)),
      `原始欄位：${Object.keys(rawFields).join(',')}`);
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

describe('詳情頁結構化欄位（parseDetail）', () => {
  test('建物の建築年來自 payload 的 constructionYear，不是「來源沒有這個欄位」', () => {
    // 原始頁面：<b>建物の建築年</b> <!-- -->1977<!-- -->年
    assert.equal(parseDetail(fixture('detail-sample1.html.gz')).constructionYear, 1977);
    // 赤坂這一頁站方沒填 → null（在 Building 上是 not_listed_on_page，不是 not_offered_by_source）
    assert.equal(parseDetail(akasakaHtml).constructionYear, null);
  });

  test('入居条件的「外国人」欄取結構化欄位，不會被介紹文劫持', () => {
    // 原站入居条件：「外国人｜：パスポート、ビザ、外国人登録証明書。」
    // 舊解析器用整頁第一個「外国人」，抓到的是介紹文「…外国人講師が英会話レッスンを…」
    const d = parseDetail(willFuchuHtml);
    assert.equal(d.qualificationForeigner, 'パスポート、ビザ、外国人登録証明書。');
    assert.ok(!d.qualificationForeigner.includes('英会話'), '抓到的是招租文案而不是條件欄');
  });

  test('車站帶路線名，且第一筆就是最寄駅', () => {
    const d = parseDetail(akasakaHtml);
    assert.equal(d.stations[0]?.primaryTrainLineName, '東京メトロ千代田線');
    assert.equal(d.stations[0]?.trainStationName, '赤坂駅');
    assert.equal(d.stations[0]?.timeMinutes, 4);
    // 同一份 payload 把 stationData 渲染兩遍，去重後才是真的站數
    assert.equal(d.stations.length, 3);
  });

  test('總室數＝個室＋ドミトリー 的 totalCount，與列表摘要的 totalRoomCount 同一個口徑', () => {
    assert.equal(parseDetail(akasakaHtml).totalRoomCount, 23);
    assert.equal(parseDetail(fixture('detail-sample6.html.gz')).totalRoomCount, 164);
  });

  test('区名與入居期間都在 payload 裡', () => {
    assert.equal(parseDetail(akasakaHtml).townName, '港区');
    assert.equal(parseDetail(akasakaHtml).tenancyPeriod, '長期');
  });

  test('入居期間有複數級距時全部收齊，最短居住期間解得出月數', () => {
    // 板橋「東京合宿所」原頁 tenancyPeriod:["長期","4〜6か月","1〜3か月"]
    // （fixture 由 2026-09-06 的 data/raw 快照複製，未經修改）
    const d = parseDetail(fixture('detail-tokyo-gasshukujo.html.gz'));
    assert.equal(d.tenancyPeriod, '長期・4〜6か月・1〜3か月');
    assert.equal(parseStayBucketsMinMonths(d.tenancyPeriod), 1);
    // 對照：只寫「長期」的頁面沒有月數可讀，這時維持未知才是誠實的
    assert.equal(parseStayBucketsMinMonths(parseDetail(akasakaHtml).tenancyPeriod), null);
  });

  test('詳情頁尾端「類似物件」的扁平欄位不可以被當成本棟的值', () => {
    // 類似物件帶著列表摘要的完整 schema；本棟的總室數是 23，
    // 但整頁第一個 "totalRoomCount" 屬於別棟。parseDetail 只能回 23。
    assert.equal(parseDetail(akasakaHtml).totalRoomCount, 23);
    const flat = /"totalRoomCount":(\d+)/.exec(akasakaHtml.replace(/\\"/g, '"'))?.[1];
    assert.ok(flat !== undefined && flat !== '23', `扁平鍵抓到的是 ${String(flat)}，正是不能用的那個值`);
  });
});

describe('空室 vs 空室予定', () => {
  test('「空室予定」是還沒空出來 → isVacant = false', () => {
    const listing = adapter.extract(
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', hint: { id: 1, name: 'x', webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka' } as Record<string, unknown> },
      { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
    );
    const u = listing?.units[0];
    assert.ok(u);
    assert.equal(u.availableFrom.known && u.availableFrom.v, '空室予定');
    assert.equal(u.isVacant.known && u.isVacant.v, false);
    assert.equal(u.isVacant.srcText, 'availabilityCode=scheduled');
  });

  test('「空室」才是現在可入住 → isVacant = true', () => {
    const html = fixture('detail-sample1.html.gz');
    const listing = adapter.extract(
      { url: 'https://x/', body: html, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: 'https://www.hituji.jp/comret/info/tokyo/adachi/x', hint: { id: 1, name: 'x', webUrl: 'https://www.hituji.jp/comret/info/tokyo/adachi/x' } as Record<string, unknown> },
      { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
    );
    assert.ok(listing);
    assert.ok(listing.units.length > 0);
    for (const u of listing.units) assert.equal(u.isVacant.known && u.isVacant.v, true);
  });
});

describe('列表 payload 掉欄位時仍要解得出建物', () => {
  // 2026-09-06 覆蓋調查：站方已把 totalRoomCount／availableRoomCount／
  // nearestTrainStationName／transportationName／transportationTimeMinutes／
  // hasAvailableRoomForForeigner 從列表 payload 拿掉。
  const bare = {
    id: 596, name: 'TOKYO SYNC 赤坂',
    webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka',
    tenancyConditionDescription: '男性 女性 外国人歓迎',
  } as Record<string, unknown>;
  const listing = adapter.extract(
    { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', hint: bare },
    { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
  );

  test('車站不會歸零，而且補上了路線名', () => {
    const st = listing?.building.stations[0];
    assert.ok(st);
    assert.equal(st.station, '赤坂');
    assert.equal(st.line, '東京メトロ千代田線');
    assert.equal(st.walkMinutes.known && st.walkMinutes.v, 4);
  });

  test('總戶數不會歸零（退回詳情頁的 availability totalCount）', () => {
    const t = listing?.building.totalUnits;
    assert.ok(t?.known === true);
    assert.equal(t.v, 23);
  });

  test('外国人可租旗標退回入居条件標籤列', () => {
    const w = listing?.units[0]?.foreigner.welcomed;
    assert.ok(w?.known === true);
    assert.equal(w.v, true);
  });
});

describe('完整房間清單（/rooms）', () => {
  test('複數鍵 singleRooms／dormitoryRooms 也要收得到', () => {
    // /rooms 頁把完整清單放在 comretRooms.singleRooms／dormitoryRooms（複數）。
    // extractArrayAfterKey 是精確鍵比對，只餵單數鍵就永遠只撿得到詳情頁那 2 筆預覽。
    const payload = '{"comretRooms":{"singleRooms":['
      + '{"id":1,"number":"101","sizeSquareMeter":"10","sizeJou":"6","rent":50000,"commonServiceFee":10000,'
      + '"variableCommonServiceFee":"","utilities":"10000","deposit":0,"keyMoney":0,'
      + '"availabilityCode":"empty","availabilityLabel":"空室"},'
      + '{"id":2,"number":"102","sizeSquareMeter":"10","sizeJou":"6","rent":51000,"commonServiceFee":10000,'
      + '"variableCommonServiceFee":"","utilities":"10000","deposit":0,"keyMoney":0,'
      + '"availabilityCode":"empty","availabilityLabel":"空室"}],'
      + '"dormitoryRooms":[{"id":3,"number":"201a","sizeSquareMeter":"12","sizeJou":"7","rent":30000,'
      + '"commonServiceFee":10000,"variableCommonServiceFee":"","utilities":"10000","deposit":0,"keyMoney":0,'
      + '"availabilityCode":"empty","availabilityLabel":"空室"}]}}';
    const rooms = parseRooms(payload);
    assert.deepEqual(rooms.map((r) => r.number), ['101', '102', '201a']);
    assert.deepEqual(rooms.map((r) => r.__kind), ['個室', '個室', 'ドミトリー']);
  });

  test('discover 把完整清單放進 hint，extract 會與詳情頁預覽合併去重', () => {
    // 預覽只有 409；假設 /rooms 另外給了 409（重複）與 410
    const room = (id: number, number: string): Record<string, unknown> => ({
      id, number, sizeSquareMeter: '9.8', sizeJou: '6', rent: 95000, commonServiceFee: 20000,
      variableCommonServiceFee: '', utilities: '20000', deposit: 50000, keyMoney: 95000,
      availabilityCode: 'empty', availabilityLabel: '空室', __kind: '個室',
    });
    const preview = parseRooms(akasakaHtml);
    assert.equal(preview.length, 1);
    const listing = adapter.extract(
      { url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka', body: akasakaHtml, fetchedAt: '2026-08-16T00:00:00Z', sha256: 'x', status: 200, notModified: false },
      {
        url: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka',
        hint: {
          id: 1, name: 'x', webUrl: 'https://www.hituji.jp/comret/info/tokyo/minato/tokyo-sync-akasaka',
          __fullRooms: [room(preview[0]?.id ?? 0, '409'), room(999_999, '410')],
        } as Record<string, unknown>,
      },
      { manifest: adapter.manifest, now: new Date('2026-08-16T00:00:00Z') },
    );
    assert.deepEqual(listing?.units.map((u) => u.roomNo.known && u.roomNo.v), ['409', '410']);
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
