/**
 * ひつじ不動産 adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 抓取）測，不打對方伺服器。
 * 填充率監控抓不到「把 1ヶ月 解析成 1 円」這種值全錯但填充率 100% 的故障，
 * 只有這種對答案的測試抓得到——兩者互補，缺一不可。
 */

import { test, describe } from 'node:test';
import { proseGuarantorFee, proseRenewalFees } from '../../packages/jp-parse/src/prose.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  parseSummaries, parseRooms, parseDetail, keysFromUrl, adapter, parseComretCount, utilitiesBasisOfText, adminFeeOf,
  hitujiInternet, hitujiCampaignFees, houseFloorOf,
} from '../sources/hituji/index.ts';
import { proseZeroFees, proseYearBuilt } from '../../packages/jp-parse/src/prose.ts';
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

  test('站方自報總筆數', () => {
    assert.equal(parseComretCount(fixture('list-tokyo-rsc-page1.txt.gz')), 1244);
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
    // 欄位定義是 ISO 日期或「随時」；空室予定 payload 沒給日期 → 未知，原文留在 srcText
    assert.equal(u.availableFrom.known, false);
    assert.match(u.availableFrom.srcText, /availabilityLabel=空室予定（站方沒給日期）/);
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
    for (const u of listing.units) {
      assert.equal(u.isVacant.known && u.isVacant.v, true);
      assert.equal(u.availableFrom.known && u.availableFrom.v, '随時', '「空室」＝随時，不存站方字樣');
    }
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

describe('列表分頁：不靠公式，讀到湊滿站方自報筆數為止', () => {
  const card = (id: number): string =>
    `{"id":${id},"name":"棟${id}","comment":"","webUrl":"https://www.hituji.jp/comret/info/tokyo/x/b${id}",`
    + '"hasAvailableRoom":false,"availableRoomCount":0}';
  const page = (count: number, ids: readonly number[]): string =>
    `{"comretCount":${count},"comrets":[${ids.map(card).join(',')}]}`;
  const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

  async function run(pages: (p: number) => string): Promise<{ urls: string[]; requested: number[] }> {
    const requested: number[] = [];
    const fetcher = {
      async get(url: string) {
        const p = Number(new URL(url).searchParams.get('page'));
        requested.push(p);
        return { url, body: pages(p), fetchedAt: '2026-10-17T00:00:00Z', sha256: 'x', status: 200, notModified: false };
      },
    };
    const urls: string[] = [];
    for await (const ref of adapter.discover({ manifest: adapter.manifest, now: new Date() }, fetcher)) urls.push(ref.url);
    return { urls, requested };
  }

  test('一般分頁（2026-10-17 改版後）：每頁 30 筆不重疊，讀 3 頁收齊 65 筆就停', async () => {
    const r = await run((p) => page(65, p === 1 ? range(1, 30) : p === 2 ? range(31, 30) : p === 3 ? range(61, 5) : []));
    assert.equal(r.urls.length, 65);
    assert.equal(new Set(r.urls).size, 65);
    assert.deepEqual(r.requested, [1, 2, 3], '湊滿就停，不多打第 4 頁');
  });

  test('累積式（2026-08-16 舊版）：重複的卡片以 id 去重，照樣收齊', async () => {
    const r = await run((p) => page(82, range(1, Math.min(82, 30 + 26 * (p - 1)))));
    assert.equal(r.urls.length, 82);
    assert.deepEqual(r.requested, [1, 2, 3]);
  });

  test('某一頁沒有新卡片就停，收不到 95% 一律丟例外（不可以安靜地少收）', async () => {
    // 這正是 2026-10-17 的實況：舊公式只讀第 48 頁，改版後那頁是空的
    await assert.rejects(run((p) => page(100, p === 1 ? range(1, 30) : [])), /讀了 2 頁只解析出 30 筆，但站方自報 100 筆/);
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
    for (const f of [u.initial.agencyFee, u.initial.fireInsurance, u.deferred.earlyTerminationPenalty]) {
      assert.equal(f.known, false);
      if (!f.known) assert.equal(f.why, 'not_offered_by_source');
    }
  });
});

describe('2026-10-17 驗證幫手抓到的兩個缺口：所在地、第 2 站以後', () => {
  const d = parseDetail(fixture('detail-roof-meidaimae-2026-10-17.html.gz'));

  test('所在地取 payload 的 address（不是 ownerAddress＝業者事務所）', () => {
    assert.equal(d.address, '東京都杉並区和泉2丁目');
  });

  test('akasaka 的 address 只寫「東京都」——照原文存，不補区名', () => {
    assert.equal(parseDetail(akasakaHtml).address, '東京都');
  });

  test('stationData 的每一站都輸出，順序照頁面；分鐘數各配各的', () => {
    const l = adapter.extract(
      { url: 'https://www.hituji.jp/comret/info/tokyo/suginami/roof-meidaimae', body: fixture('detail-roof-meidaimae-2026-10-17.html.gz'),
        fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url: 'https://www.hituji.jp/comret/info/tokyo/suginami/roof-meidaimae',
        hint: { id: 1, name: 'RooF 明大前', webUrl: 'https://www.hituji.jp/comret/info/tokyo/suginami/roof-meidaimae' } },
      { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
    );
    const st = l?.building.stations ?? [];
    assert.deepEqual(st.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]), [
      ['京王線', '代田橋', 8],
      ['京王線', '明大前', 13],
    ]);
    assert.equal(l?.building.addressRaw, '東京都杉並区和泉2丁目');
  });
});

describe('2026-10-17 第三輪驗證補的事', () => {
  test('variableCommonServiceFee 是自由文字：讀內容，不是看空不空', () => {
    assert.equal(utilitiesBasisOfText(''), 'unknown');
    assert.equal(utilitiesBasisOfText('実費'), 'excluded');
    assert.equal(utilitiesBasisOfText('水道・ガス・光熱費は実費請求'), 'excluded');
    assert.equal(utilitiesBasisOfText('個室の電気、ガス（LPガス）、水道は個別に契約が必要。'), 'excluded');
    assert.equal(utilitiesBasisOfText('共益費（水光熱費・wi-fi・保険含む）'), 'included');
    assert.equal(utilitiesBasisOfText('水道光熱費は共益費にふくまれます。その他追加徴収ありませんのでご安心ください。'), 'included');
    // 驗證幫手抓到的：活動文案被當成「水電另計」
    assert.equal(utilitiesBasisOfText('家賃は2年プラン適用時の価格です。さらに今なら1ヶ月のフリーレント付き！'), 'unknown');
    assert.equal(utilitiesBasisOfText('ペット飼育の場合は共益費＋2,000円'), 'unknown');
    assert.equal(utilitiesBasisOfText('0'), 'unknown');
    // 部分含、部分實費：說不準
    assert.equal(utilitiesBasisOfText('光熱費は各室50KWまでは定額に含まれ、超過分は実費請求。'), 'unknown');
    // share-house-180-kamiitabashi：共益費欄另列「ライフライン費￥11000」＝另計（金額不自動採用）
    assert.equal(utilitiesBasisOfText('ライフライン費￥11000\n補償料¥1100'), 'excluded');
  });

  test('共益費欄 ￥0 但附註寫住戶分攤：0 是佔位，不是不收（machida-forest 101）', () => {
    const room = (fee: number, note: string) => ({ commonServiceFee: fee, variableCommonServiceFee: note }) as never;
    const split = adminFeeOf(room(0, '共益費は入居者で頭割り（¥3000〜¥8000）。'));
    assert.equal(split.known, false);
    assert.equal(split.basis, 'excluded_stated');
    assert.match(split.srcText, /頭割り/);
    // 結構化值不是 0、或附註沒講分攤：照結構化值
    const fixed = adminFeeOf(room(10000, '共益費は￥10000／月を前預かり後、年2回精算（住人で折半）。'));
    assert.ok(fixed.known && fixed.v.jpy === 10000);
    const none = adminFeeOf(room(0, '実費'));
    assert.ok(none.known && none.v.jpy === 0);
    assert.equal(utilitiesBasisOfText('電気・ガス・消耗品費・清掃費は固定費に含まれます。'), 'unknown', '沒提水道，不算全含');
  });

  test('說明文：絆家的「仲介料…全て【無料】」→ 仲介 0；description 是本棟自己的', () => {
    const d = parseDetail(fixture('detail-kizunaya-hygge-asagaya-2026-10-17.html.gz'));
    assert.match(d.description, /阿佐ヶ谷/);
    const fees = proseZeroFees(d.description);
    assert.match(fees.agencyFee ?? '', /仲介料・更新料全て【無料】/);
    assert.equal(fees.contractFee, undefined);
  });

  test('說明文築年只在 constructionYear 沒填時用：compartir 新宿「2013年3月に新築されました」', () => {
    const d = parseDetail(fixture('detail-compartir-shinjuku-2026-10-17.html.gz'));
    assert.equal(d.constructionYear, null);
    assert.equal(proseYearBuilt(d.description, 2026)?.year, 2013);
  });

  test('「新築シェアハウスが2017年9月誕生」是開幕日，不當築年（驗證裁決者指出新築可早一年完工）', () => {
    assert.equal(proseYearBuilt('津田塾大学に面して、おしゃれな新築シェアハウスが2017年9月誕生！', 2026), null);
  });
});

describe('網路費與 CAMPAIGN 區塊（2026-10-17 第二十三輪）', () => {
  const url = 'https://www.hituji.jp/comret/info/tokyo/koto/kameido-plaisir';
  const l = adapter.extract(
    { url, body: fixture('detail-kameido-plaisir-2026-10-17.html.gz'), fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url, hint: { id: 1461, name: '亀戸プレジール', webUrl: url } },
    { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
  );
  const u = l?.units[0];

  test('設備「回線 光ファイバー（無料）」→ 網路費 0（舊版存成「來源不提供」）', () => {
    assert.ok(u?.monthly.internet.known && u.monthly.internet.v.jpy === 0, JSON.stringify(u?.monthly.internet));
    assert.match(u.monthly.internet.srcText, /回線 光ファイバー（無料）/);
  });

  test('CAMPAIGN「内見当日のお申し込みの方限定！事務手数料￥20,000円→タダ！」→ 平常要付，金額不採用', () => {
    const f = u?.initial.contractFee;
    assert.ok(f !== undefined && !f.known, JSON.stringify(f));
    assert.equal(f.basis, 'excluded_stated');
    assert.match(f.srcText, /事務手数料￥20,000円→タダ/);
  });

  test('網路費的各種寫法', () => {
    const n = (caption: string, has = true) => hitujiInternet({ has, caption });
    const z = n('回線 CATV（無料）\n＊無線LAN有り。');
    assert.ok(z.known && z.v.jpy === 0);
    const m = n('回線 光ファイバー（￥2100/月）');
    assert.ok(m.known && m.v.jpy === 2100);
    for (const c of ['回線 光ファイバー（無料）\n＊居室での利用は個別契約。', '回線 光ファイバー（入居人数で頭割り。）', '回線 光ファイバー（￥6090を入居人数で頭割り。）',
      '回線 光ファイバー（¥1000。）', '回線 光ファイバー（無料）\n＊無線LAN、有線LAN（リビング）有り。LAN利用料金は￥1000/月。']) {
      const f = n(c);
      assert.ok(!f.known && f.basis === 'excluded_stated', `${c} → ${JSON.stringify(f)}`);
    }
    const inc = n('回線 光ファイバー（無料）\n＊共益費月額￥10000に含む。');
    assert.ok(inc.known && inc.v.jpy === 0 && inc.basis === 'included_stated', '￥10000 是共益費，不是另一筆網路費');
    assert.equal(n('回線 光ファイバー（なし）\n＊J-com。').known, false, '「なし」分不出免費還是沒回線');
    const heavy = n('回線 光ファイバー（無料）\n＊無線LAN、有線LAN（全室、リビング）有。ネットゲーム、ニコニコ動画中継等の膨大なデータ使用の際は別途個別契約をしていただく場合があります。');
    assert.ok(heavy.known && heavy.v.jpy === 0, '大量傳輸「可能」另簽 ≠ 房間要另簽');
    const inCommon = n('回線 光ファイバー（共益費に含む。）');
    assert.ok(inCommon.known && inCommon.basis === 'included_stated');
    assert.equal(n('', false).known, false);
    const none = hitujiInternet(null);
    assert.equal(none.known === false && none.why, 'not_offered_by_source');
  });

  test('CAMPAIGN 只證明費用存在：沒提費用的活動不產生任何欄位', () => {
    assert.deepEqual(hitujiCampaignFees('賃料1ヶ月無料!（諸条件あり）外国人OK。'), {});
    const g = hitujiCampaignFees('【限定1名様＊春キャン＊10/31まで!】初期費用66,000円が0円に！更に10月は初回保証料も0円。');
    assert.equal(g.guarantorInitialFee?.basis, 'excluded_stated');
    assert.equal(g.contractFee, undefined);
  });
});

describe('2026-10-17 第二十五輪：保證公司讀入居条件、更新料讀說明文（與 TSH 同一套）', () => {
  test('入居条件「日本人」欄取結構化欄位；「保証会社加入必須」→ 提到保證公司、沒寫初回多少（存這頁沒寫，不是來源不公開）', () => {
    const d = parseDetail(fixture('detail-sample4.html.gz'));
    assert.equal(d.qualificationJapanese, '身分証明書、緊急連絡先、保証会社加入必須。');
    assert.equal(proseGuarantorFee([d.description, d.qualificationJapanese, d.qualificationForeigner].join('\n'))?.kind, 'mentioned');
  });
  test('入居条件裡保證公司自己的「1年毎に10,000円の更新料」不算租約更新料；初回保証料＝明寫要付', () => {
    const q = '写し。日常会話程度の日本語が話せること。保証会社加入必須（初回保証料：月額総賃料の0.5ヶ月分、1年毎に10,000円の更新料がかかります）。';
    assert.equal(proseGuarantorFee(q)?.kind, 'stated');
    assert.deepEqual(proseRenewalFees(q), {});
  });
  test('說明文「敷金・礼金・仲介料・更新料全て【無料】」→ 更新料 0', () => {
    assert.equal(proseRenewalFees('全国28拠点700室運営・敷金・礼金・仲介料・更新料全て【無料】・ぜひ気軽にお問い合わせください').renewalFee?.kind, 'zero');
  });
});

describe('第三十輪：整個 house 在同一層', () => {
  test('明寫整個 house／全部房間在第 N 層 → N', () => {
    assert.equal(houseFloorOf('駅前の商店街にはお店も沢山あります！ハウスは全て建物2階部分の為、防犯面でも安心感があります。')?.floor, 2); // chezelle-8
    assert.equal(houseFloorOf('お部屋は全5室ですべて2階。')?.floor, 2); // ys-house-shinjuku
    assert.equal(houseFloorOf('JR国立駅南口を出て、徒歩2分のビルの4階にあります。')?.floor, 4); // owl-kunitachi
    assert.equal(houseFloorOf('「ADDress聖蹟桜ヶ丘A邸」の2階を、2026年9月より女性専用・ペット可のシェアハウスとしてリニューアルします。')?.floor, 2); // address-seiseki-sakuragaoka-a
    assert.equal(houseFloorOf('戸建ての2階、3階部分を女性専用のシェアハウスとして運用しており'), null); // ivy-abode
    assert.equal(houseFloorOf('マンションの2，4，5階部分をリノベーションしシェアハウスとしてオープンします！'), null); // begood-toyocho-eki-mae
  });
  test('兩層以上、N階建て、沒有主詞、只講某一間 → 不收', () => {
    assert.equal(houseFloorOf('シェアハウスは2・3階'), null); // tsunagari-share-yoyogiuehara
    assert.equal(houseFloorOf('シェアハウスは2階建てで全4部屋とアットホームな一軒家です'), null); // sancourt-suzukakedai
    assert.equal(houseFloorOf('ハウスは1階3部屋、2階4部屋で各階に独立した共用部分を備え'), null); // branch-house
    assert.equal(houseFloorOf('4階部分につき、陽当り絶好！'), null); // sharehouse-joy-takashimadaira-11
    assert.equal(houseFloorOf('お部屋は1階は広めの7.5畳のフローリング'), null); // share-house-narimasu-6
    assert.equal(houseFloorOf('9階建てのマンションの8階、9階部分の1室をシェアハウスとして'), null); // begood-komagome
  });
});
