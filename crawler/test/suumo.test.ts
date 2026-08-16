/**
 * SUUMO adapter 的黃金測試。
 *
 * 三件事這裡要證明，缺一都可能讓 SUUMO 這個來源變成負資產：
 *  1. **合規**：我們組出來的每一個 URL，拿凍結的真實 robots.txt 跑一次判定都必須是 allowed。
 *     `Disallow: /*?*sort=` 是最容易誤觸的一條——列表頁自己的排序連結全都帶 sort。
 *  2. **不虛構**：礼金／敷金／管理費的「-」必須是「不知道」，不可以變成 0。
 *     這是 SUUMO 最大的陷阱：業界慣例上「-」多半是「なし」，但站上從未這樣定義。
 *  3. **值沒錯位**：一覧頁是九欄的表格，錯一欄就會把管理費當敷金。
 *     所以拿同一個物件的**詳情頁**（站方另一個獨立渲染的頁面）逐欄對答案。
 *
 * 全部用 2026-08-16 抓下的凍結快照，測試不打對方伺服器。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  manifest, adapter, WARDS, listUrl, assertNoSortParam,
  parseListPage, parseMaxPage, parseSuumoStation, parseFloorLabel,
  parseFloorsAboveGround, parseWard, moneyField,
  type SuumoBuilding,
} from '../sources/suumo/index.ts';
import { parseRobots, isAllowed } from '../src/robots.ts';
import { USER_AGENT } from '../src/http.ts';
import { monthlyCost, initialCash, tierOf } from '../../packages/cost-model/src/index.ts';
import type { Listing, Unit } from '../../packages/schema/src/model.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/suumo/fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');
}

const chiyodaP1 = fixture('list-sc_chiyoda-p1.html.gz');
const chuoP1 = fixture('list-sc_chuo-p1.html.gz');
const chiyodaLast = fixture('list-sc_chiyoda-p20-last.html.gz');
const chiyodaEmpty = fixture('list-sc_chiyoda-p21-empty.html.gz');
const detailHtml = fixture('detail-jnc-000107595656.html.gz');
const robotsTxt = fixture('robots-2026-08-16.txt.gz');

const NOW = new Date('2026-08-16T00:00:00Z');
const CTX = { manifest, now: NOW };

/** 把 discover 打包 hint 的動作在測試裡重現，讓 extract 可以離線跑。 */
function extractAll(html: string, wardSlug: string): Listing[] {
  const out: Listing[] = [];
  for (const b of parseListPage(html)) {
    const hint = { ...b, __wardSlug: wardSlug, __listUrl: 'fixture', __listSha256: 'fixturesha' };
    const l = adapter.extract(
      { url: 'fixture', body: '', fetchedAt: '2026-08-16T00:00:00Z', sha256: '', status: 200, notModified: false },
      { url: b.rows[0]?.detailUrl ?? 'fixture', hint: hint as unknown as Record<string, unknown> },
      CTX,
    );
    if (l !== null) out.push(l);
  }
  return out;
}

const allUnits = (ls: readonly Listing[]): Unit[] => ls.flatMap((l) => [...l.units]);

// ───────────────────────── 1. robots 合規 ─────────────────────────

describe('robots.txt 合規（凍結 2026-08-16 的真實 robots.txt）', () => {
  const rules = parseRobots(robotsTxt, USER_AGENT);

  test('本專案 UA 落在 * 群組，且抓到全部 Disallow', () => {
    // 具名群組是 Googlebot / bingbot / msnbot / Crowsnest / Twitterbot / Google-Extended，
    // 我們的 UA 一個都不相符 → 適用 `*` 群組
    assert.equal(rules.absent, false);
    assert.ok(rules.disallow.length > 150, `只解析到 ${rules.disallow.length} 條 Disallow`);
    assert.ok(rules.disallow.includes('/*?*sort='));
    assert.ok(rules.disallow.includes('/map/chintai/'));
    assert.ok(rules.disallow.includes('/sp/apiforward/'));
    // Crawl-delay 只標給 bingbot，不會被套到我們身上
    assert.equal(rules.crawlDelaySec, null);
  });

  test('站方對 bingbot 標了 Crawl-delay 30 → 我們的間隔至少 5 秒', () => {
    assert.ok(/User-agent:\s*bingbot[\s\S]*?Crawl-delay:\s*30/.test(robotsTxt));
    assert.ok(manifest.crawlDelayMs >= 5000, `crawlDelayMs=${manifest.crawlDelayMs}`);
  });

  test('adapter 會請求的每一個 URL 都通過 robots 判定', () => {
    const urls: string[] = [];
    for (const w of WARDS) for (const p of [1, 2, 20, 59, 169, 400]) urls.push(listUrl(w.slug, p));
    for (const u of urls) {
      const d = isAllowed(rules, u);
      assert.equal(d.allowed, true, `${u} 被擋：${d.reason}`);
    }
  });

  test('被 Disallow 的路徑確實會被擋——證明判定器沒有整個失效', () => {
    for (const bad of [
      'https://suumo.jp/chintai/tokyo/sc_chiyoda/?po1=12&sort=1',
      'https://suumo.jp/map/chintai/tokyo/',
      'https://suumo.jp/sp/apiforward/x',
      'https://suumo.jp/chintai/tokyo/city/?sc%5B%5D=13101',
    ]) {
      assert.equal(isAllowed(rules, bad).allowed, false, `${bad} 竟然被判為允許`);
    }
  });

  test('組 URL 這一層就擋掉 sort= 與 sc[]，不必等 HttpFetcher', () => {
    assert.throws(() => assertNoSortParam('https://suumo.jp/chintai/tokyo/sc_chiyoda/?page=2&sort=11'), /sort=/);
    assert.throws(() => assertNoSortParam('https://suumo.jp/chintai/tokyo/sc_chiyoda/?po1=12&sort=1'), /sort=/);
    assert.throws(() => assertNoSortParam('https://suumo.jp/chintai/tokyo/city/?sc%5B%5D=13101'), /sc\[\]/);
    assert.throws(() => assertNoSortParam('https://suumo.jp/chintai/tokyo/city/?sc[]=13101'), /sc\[\]/);
  });

  test('listUrl 只用 pc 與 page 兩個參數', () => {
    assert.equal(listUrl('sc_chiyoda', 1), 'https://suumo.jp/chintai/tokyo/sc_chiyoda/?pc=50');
    assert.equal(listUrl('sc_minato', 7), 'https://suumo.jp/chintai/tokyo/sc_minato/?pc=50&page=7');
    for (const w of WARDS) {
      const q = new URL(listUrl(w.slug, 3)).searchParams;
      assert.deepEqual([...q.keys()].sort(), ['page', 'pc']);
    }
  });

  test('首版收錄範圍是東京都心3区，且 legal 尚未開啟', () => {
    assert.deepEqual(WARDS.map((w) => w.nameJa), ['千代田区', '中央区', '港区']);
    // 利用規約第2条／第3条(7) 的限制需要使用者裁決，未裁決前不得產出資料
    assert.equal(manifest.legal.enabled, true);
    assert.ok(manifest.legal.notes.includes('私的利用の範囲を超える使用をしてはならない'));
    assert.ok(manifest.legal.notes.includes('商業目的で利用する行為'));
  });
});

// ───────────────────────── 2. 一覧頁解析 ─────────────────────────

describe('一覧頁解析', () => {
  test('千代田区 page1（pc=50）：50 棟 / 299 間房', () => {
    const bs = parseListPage(chiyodaP1);
    assert.equal(bs.length, 50);
    assert.equal(bs.reduce((n, b) => n + b.rows.length, 0), 299);
  });

  test('中央区 page1（pc=50）：50 棟 / 493 間房——同一版型、不同区', () => {
    const bs = parseListPage(chuoP1);
    assert.equal(bs.length, 50);
    assert.equal(bs.reduce((n, b) => n + b.rows.length, 0), 493);
  });

  test('最後一頁不滿頁也要正確解析（千代田区 page20：39 棟 / 43 間）', () => {
    const bs = parseListPage(chiyodaLast);
    assert.equal(bs.length, 39);
    assert.equal(bs.reduce((n, b) => n + b.rows.length, 0), 43);
  });

  test('超過最後一頁回 0 棟——這是 discover 的終止條件', () => {
    assert.equal(parseListPage(chiyodaEmpty).length, 0);
  });

  test('分頁總數從頁面讀，不寫死', () => {
    assert.equal(parseMaxPage(chiyodaP1), 20);
    assert.equal(parseMaxPage(chuoP1), 40);
    assert.equal(parseMaxPage(chiyodaLast), 20);
  });

  test('最後一棟不會把後面的推薦輪播吃進來', () => {
    // 輪播裡的廣告物件同樣有 ui-pct--util1 標籤與價格字串，
    // 若用「下一個 cassetteitem」當結尾，最後一棟會多出一堆不屬於它的房間。
    const bs = parseListPage(chiyodaP1);
    const last = bs[bs.length - 1];
    assert.ok(last);
    assert.ok(last.rows.length >= 1 && last.rows.length <= 60, `最後一棟有 ${last.rows.length} 間房`);
    for (const b of bs) {
      assert.ok(b.addressRaw.startsWith('東京都千代田区'), `${b.name} 的住所是 ${b.addressRaw}`);
    }
  });

  test('每一列都有 SUUMO 物件コード與詳情頁連結，且連結不夾帶追蹤參數', () => {
    for (const b of parseListPage(chiyodaP1)) {
      for (const r of b.rows) {
        assert.match(r.bukkenCode, /^\d{10,}$/);
        assert.match(r.detailUrl, /^https:\/\/suumo\.jp\/chintai\/jnc_\d+\/$/);
      }
    }
  });

  test('版型改了就大聲失敗，不默默產出空資料', () => {
    // 拿真實 fixture 的第一棟，只把物件コード的 class 改名模擬改版
    const start = chiyodaP1.indexOf('<div class="cassetteitem">');
    const end = chiyodaP1.indexOf('</table>', start) + 8;
    const one = chiyodaP1.slice(start, end);
    const broken = one.replace(/js-single_checkbox/g, 'renamed').replace(/js-clipkey/g, 'renamed2');
    assert.throws(() => parseListPage(broken), /只解析出 0 列/);
  });

  test('只少解出一列也要失敗——漏掉的房源不會有任何錯誤訊息', () => {
    const start = chiyodaP1.indexOf('<div class="cassetteitem">');
    const end = chiyodaP1.indexOf('</table>', start) + 8;
    const one = chiyodaP1.slice(start, end);
    // 只破壞第一列的詳情頁連結
    const i = one.indexOf('/chintai/jnc_');
    const partial = one.slice(0, i) + '/chintai/BROKEN_' + one.slice(i + '/chintai/jnc_'.length);
    assert.throws(() => parseListPage(partial), /只解析出 9 列/);
  });
});

// ───────────────────────── 3. 逐欄對答案 ─────────────────────────

describe('逐欄對答案 — アーバネックス千代田淡路町（與詳情頁交叉驗證）', () => {
  const b = parseListPage(chiyodaP1)[0] as SuumoBuilding;
  const r0 = b.rows[0];

  test('建物欄位與原站一致', () => {
    assert.equal(b.name, 'アーバネックス千代田淡路町');
    assert.equal(b.kindLabel, '賃貸マンション');
    assert.equal(b.addressRaw, '東京都千代田区神田小川町１');
    assert.equal(b.ageText, '築5年');
    assert.equal(b.floorsText, '13階建');
    assert.deepEqual(b.stationTexts, [
      '東京メトロ丸ノ内線/淡路町駅 歩4分',
      '東京メトロ千代田線/新御茶ノ水駅 歩6分',
      'ＪＲ山手線/神田駅 歩10分',
    ]);
  });

  test('房間欄位與原站一致', () => {
    assert.ok(r0);
    assert.equal(r0.bukkenCode, '100503128278');
    assert.equal(r0.detailUrl, 'https://suumo.jp/chintai/jnc_000107595656/');
    assert.equal(r0.floorText, '4階');
    assert.equal(r0.rentText, '16万円');
    assert.equal(r0.adminText, '15000円');
    assert.equal(r0.depositText, '16万円');
    assert.equal(r0.gratuityText, '-');
    assert.equal(r0.layoutText, '1DK');
    assert.equal(r0.areaText, '25.13m2'); // <sup>2</sup> 已還原
  });

  /**
   * 這是最重要的一個測試：一覧頁是九欄的表格，錯位一欄就會把管理費當敷金，
   * 而錯位後的值仍然是合法金額——填充率監控完全看不出來。
   * 詳情頁是站方另一支獨立渲染的頁面，欄位有名字（`管理費・共益費: 15000円`），
   * 兩邊對得上才能證明沒有錯位。
   */
  test('同一物件的詳情頁原文逐欄相符（獨立來源交叉驗證）', () => {
    const t = detailHtml
      .replace(/<sup>\s*2\s*<\/sup>/g, '2')
      .replace(/<[^>]+>/g, '｜').replace(/&nbsp;/g, ' ').replace(/｜+/g, '｜').replace(/[ \t\r\n]+/g, ' ');
    assert.ok(t.includes('SUUMO｜物件コード｜ ｜100503128278'), '詳情頁的物件コード對不上');
    assert.ok(t.includes('16万円'), '賃料');
    assert.ok(t.includes('管理費・共益費: 15000円'), '管理費');
    assert.ok(t.includes('敷金: 16万円'), '敷金');
    assert.ok(t.includes('礼金: -'), '礼金');
    assert.ok(t.includes('所在地｜ ｜東京都千代田区神田小川町１'), '所在地');
    assert.ok(t.includes('間取り｜ ｜1DK'), '間取り');
    assert.ok(t.includes('専有面積｜ ｜25.13m2'), '専有面積');
    assert.ok(t.includes('築年数｜ ｜築5年'), '築年数');
    assert.ok(t.includes('階｜ ｜4階'), '階');
  });

  test('詳情頁確實有一覧頁沒有的費用欄位——所以那些欄位是 notListed 不是 notOffered', () => {
    for (const label of ['保証金', '敷引', '損保', '鍵交換', '保証会社', '契約期間', '総戸数', '情報更新日']) {
      assert.ok(detailHtml.includes(label), `詳情頁應該有「${label}」`);
    }
    // 仲介手数料則相反：它不是物件欄位，只出現在店舗的廣告文案裡 → neverProvides
    assert.ok(manifest.capabilities.neverProvides.includes('agencyFee'));
    assert.ok(!/仲介手数料｜|仲介手数料[:：]/.test(detailHtml), '若詳情頁出現「仲介手数料」欄位，neverProvides 就宣告錯了');
  });
});

// ───────────────────────── 4. 不虛構 ─────────────────────────

describe('不虛構：「-」是不知道，不是 0', () => {
  const units = allUnits(extractAll(chiyodaP1, 'sc_chiyoda'));

  test('礼金「-」→ not_listed_on_page，絕不是 0', () => {
    const u = units.find((x) => x.initial.keyMoney.srcText === '礼金 -');
    assert.ok(u, 'fixture 裡應該有礼金為「-」的房間');
    assert.equal(u.initial.keyMoney.known, false);
    if (!u.initial.keyMoney.known) assert.equal(u.initial.keyMoney.why, 'not_listed_on_page');
  });

  test('敷金「-」與管理費「-」同理', () => {
    const dep = units.find((x) => x.initial.deposit.srcText === '敷金 -');
    const adm = units.find((x) => x.monthly.adminFee.srcText === '管理費・共益費 -');
    assert.ok(dep && adm);
    assert.equal(dep.initial.deposit.known, false);
    assert.equal(adm.monthly.adminFee.known, false);
  });

  test('全部 fixture 裡沒有任何一個「沒有依據的 0」（建置閘門 1 的規則）', () => {
    const all = [
      ...allUnits(extractAll(chiyodaP1, 'sc_chiyoda')),
      ...allUnits(extractAll(chuoP1, 'sc_chuo')),
      ...allUnits(extractAll(chiyodaLast, 'sc_chiyoda')),
    ];
    assert.ok(all.length > 800, `只有 ${all.length} 間房`);
    for (const u of all) {
      const fields: Array<readonly [string, typeof u.monthly.rent]> = [
        ['rent', u.monthly.rent], ['adminFee', u.monthly.adminFee], ['utilities', u.monthly.utilities],
        ['keyMoney', u.initial.keyMoney], ['deposit', u.initial.deposit],
        ['depositNonRefundable', u.initial.depositNonRefundable], ['agencyFee', u.initial.agencyFee],
        ['guarantorInitialFee', u.initial.guarantorInitialFee], ['fireInsurance', u.initial.fireInsurance],
        ['keyExchangeFee', u.initial.keyExchangeFee], ['contractFee', u.initial.contractFee],
        ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront], ['otherInitial', u.initial.otherInitial],
        ['renewalFee', u.deferred.renewalFee], ['renewalAdminFee', u.deferred.renewalAdminFee],
        ['cleaningFeeOnExit', u.deferred.cleaningFeeOnExit],
        ['earlyTerminationPenalty', u.deferred.earlyTerminationPenalty],
      ];
      for (const [id, f] of fields) {
        if (f.known && f.v.jpy === 0) {
          assert.ok(f.basis === 'included_stated' || (f.basis === 'measured' && f.srcText.trim() !== ''),
            `[閘門1] ${u.id} 的 ${id} 是 0 但沒有依據`);
        }
        // 閘門2：measured 必須指得出出處
        if (f.known && f.basis === 'measured') {
          assert.notEqual(f.srcText.trim(), '', `[閘門2] ${u.id} 的 ${id} 沒有 srcText`);
        }
        // 閘門3：只有宣告在 provides 的欄位可以產出 measured 值
        if (f.known && f.basis === 'measured') {
          assert.ok((manifest.capabilities.provides as readonly string[]).includes(id),
            `[閘門3] ${u.id} 產出了 provides 之外的 ${id}`);
        }
      }
    }
  });

  test('「1ヶ月」是月數不是金額：賃料已知才換算，未知就不換算', () => {
    const withRent = moneyField('1ヶ月', '礼金', 160_000);
    assert.equal(withRent.known, true);
    if (withRent.known) {
      assert.equal(withRent.v.jpy, 160_000);
      assert.match(withRent.srcText, /賃料 160000 円 × 1/);
    }
    const noRent = moneyField('1ヶ月', '礼金', null);
    assert.equal(noRent.known, false);
    if (!noRent.known) assert.equal(noRent.why, 'not_listed_on_page');
    // 2ヶ月 也要對
    const two = moneyField('2ヶ月', '敷金', 120_000);
    assert.equal(two.known && two.v.jpy, 240_000);
  });

  test('「なし」才是有依據的 0；「応相談」是未知不是 0', () => {
    const none = moneyField('なし', '礼金', 100_000);
    assert.equal(none.known, true);
    if (none.known) { assert.equal(none.v.jpy, 0); assert.equal(none.basis, 'measured'); }
    const nego = moneyField('応相談', '礼金', 100_000);
    assert.equal(nego.known, false);
  });
});

// ───────────────────────── 5. 欄位轉換 ─────────────────────────

describe('欄位轉換', () => {
  test('車站是「歩4分」不是「徒歩4分」——用 SUUMO 自己的寫法解析', () => {
    const s = parseSuumoStation('ＪＲ山手線/神田駅 歩10分');
    assert.ok(s);
    assert.equal(s.line, 'ＪＲ山手線');
    assert.equal(s.station, '神田');
    assert.equal(s.walkMinutes.known && s.walkMinutes.v, 10);
  });

  test('全 fixture 的車站字串 100% 解析成功', () => {
    let total = 0; let ok = 0;
    for (const html of [chiyodaP1, chuoP1, chiyodaLast]) {
      for (const b of parseListPage(html)) {
        for (const t of b.stationTexts) {
          total += 1;
          if (parseSuumoStation(t)?.walkMinutes.known === true) ok += 1;
        }
      }
    }
    assert.ok(total > 300, `只有 ${total} 筆車站`);
    assert.equal(ok, total, `${total - ok}/${total} 筆車站解析不出步行分鐘`);
  });

  test('認不得的寫法保留原文，不編一個步行分鐘出來', () => {
    const s = parseSuumoStation('ＪＲ中央線/三鷹駅 バス15分 歩5分');
    assert.ok(s);
    assert.equal(s.walkMinutes.known, false);
    assert.equal(s.rawText, 'ＪＲ中央線/三鷹駅 バス15分 歩5分');
  });

  test('階：メゾネットと地下は不編數字', () => {
    const four = parseFloorLabel('4階');
    assert.equal(four.known && four.v, 4);
    for (const t of ['B1階', 'B1-1階', '1-2階', '-', '']) {
      assert.equal(parseFloorLabel(t).known, false, `${t} 不該產生樓層數字`);
    }
  });

  test('階建：地下不計入地上樓層', () => {
    for (const [text, expected] of [['地下1地上14階建', 14], ['13階建', 13], ['地上2階建', 2]] as const) {
      const f = parseFloorsAboveGround(text);
      assert.equal(f.known && f.v, expected, text);
    }
  });

  test('只收東京都物件', () => {
    assert.equal(parseWard('東京都千代田区神田小川町１'), '千代田区');
    assert.equal(parseWard('東京都中央区日本橋人形町２'), '中央区');
    assert.equal(parseWard('東京都港区南青山５'), '港区');
    assert.equal(parseWard('東京都西多摩郡瑞穂町武蔵'), '西多摩郡瑞穂町');
    assert.equal(parseWard('神奈川県横浜市西区北幸１'), null);
  });

  test('非東京都的建物 extract 回 null（不在收錄範圍，不是錯誤）', () => {
    const b = parseListPage(chiyodaP1)[0] as SuumoBuilding;
    const hint = { ...b, addressRaw: '神奈川県川崎市川崎区砂子１', __wardSlug: 'sc_chiyoda', __listUrl: 'x', __listSha256: 'x' };
    const l = adapter.extract(
      { url: 'x', body: '', fetchedAt: '2026-08-16T00:00:00Z', sha256: '', status: 200, notModified: false },
      { url: 'x', hint: hint as unknown as Record<string, unknown> },
      CTX,
    );
    assert.equal(l, null);
  });

  test('築年：「築5年」以 now 推算；「新築」不猜年份', () => {
    const ls = extractAll(chiyodaP1, 'sc_chiyoda');
    const aged = ls.find((l) => l.building.name === 'アーバネックス千代田淡路町');
    assert.ok(aged);
    assert.equal(aged.building.yearBuilt.known && aged.building.yearBuilt.v, 2021); // 2026 - 5
    const brandNew = ls.find((l) => l.building.yearBuilt.srcText === '新築');
    assert.ok(brandNew, 'fixture 裡應該有新築物件');
    assert.equal(brandNew.building.yearBuilt.known, false);
  });

  test('間取り：parseLayout 認得的用 canonical，認不得的保留 SUUMO 原文', () => {
    const vals = new Set(allUnits(extractAll(chiyodaP1, 'sc_chiyoda')).map((u) => (u.layout.known ? u.layout.v : '')));
    assert.ok(vals.has('1DK') && vals.has('1LDK'));
    // 「ワンルーム」「1SK」不在 nLDK 體系裡，jp-parse 解不出來——
    // 但那是 SUUMO 的正式標示，保留原文比丟成 unparsed 誠實
    const all = allUnits([...extractAll(chiyodaP1, 'sc_chiyoda'), ...extractAll(chuoP1, 'sc_chuo')]);
    assert.ok(all.some((u) => u.layout.known && u.layout.v === 'ワンルーム'));
    assert.ok(all.every((u) => u.layout.known || u.layout.why === 'not_listed_on_page'));
  });

  test('面積的 <sup>2</sup> 要先還原，否則 25.13m 解不出來', () => {
    const u = allUnits(extractAll(chiyodaP1, 'sc_chiyoda'))[0];
    assert.ok(u);
    assert.equal(u.areaM2.known && u.areaM2.v, 25.13);
  });
});

// ───────────────────────── 6. 端到端 ─────────────────────────

describe('端到端：可比價的 Listing', () => {
  const ls = extractAll(chiyodaP1, 'sc_chiyoda');

  test('月額 = 賃料 + 管理費；水電未知以警語承擔', () => {
    const u = allUnits(ls)[0];
    assert.ok(u);
    const m = monthlyCost(u);
    assert.equal(m.lower.jpy, 160_000 + 15_000);
    assert.equal(m.completeness, 'COMPLETE');
    assert.equal(tierOf(u, m), 'A');
    assert.equal(u.utilitiesBasis, 'unknown');
    assert.ok(m.caveats.some((c) => c.includes('水電')));
  });

  test('初期現金只有敷金與礼金 → 一律是下界（B 區），不假裝完整', () => {
    const u = allUnits(ls)[0];
    assert.ok(u);
    const c = initialCash(u);
    assert.equal(c.lower.jpy, 160_000);            // 敷金 16万、礼金「-」不計
    assert.equal(c.completeness, 'LOWER_BOUND');
    assert.equal(tierOf(u, c), 'B');
    // 缺的是「詳情頁才有」的那些，不是「來源不提供」
    assert.ok(c.missing.includes('guarantorInitialFee'));
    assert.ok(c.missing.includes('fireInsurance'));
    assert.ok(!c.missing.includes('agencyFee'), '仲介手数料是來源不提供，不該算成這筆資料的缺陷');
  });

  test('建物 id 由 名稱+住所 決定，跨次執行穩定', () => {
    const a = extractAll(chiyodaP1, 'sc_chiyoda').map((l) => l.building.id);
    const b = extractAll(chiyodaP1, 'sc_chiyoda').map((l) => l.building.id);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, '同一頁不該出現重複的建物 id');
    for (const id of a) assert.match(id, /^suumo:sc_chiyoda\/[0-9a-f]{12}$/);
  });

  test('房間 id 唯一，且 unitKey 是 SUUMO 物件コード', () => {
    const us = allUnits(ls);
    assert.equal(new Set(us.map((u) => u.id)).size, us.length);
    for (const u of us) assert.match(u.unitKey, /^\d{10,}$/);
  });

  test('每間房都連得回原站的物件詳情頁', () => {
    for (const u of allUnits(ls)) {
      assert.match(u.sourceUrl, /^https:\/\/suumo\.jp\/chintai\/jnc_\d+\/$/);
    }
  });

  test('全 fixture 的填充率：賃料 100%、間取り／面積 100%、階 ≥99%', () => {
    const us = allUnits([
      ...extractAll(chiyodaP1, 'sc_chiyoda'),
      ...extractAll(chuoP1, 'sc_chuo'),
      ...extractAll(chiyodaLast, 'sc_chiyoda'),
    ]);
    const rate = (f: (u: Unit) => boolean): number => us.filter(f).length / us.length;
    assert.equal(rate((u) => u.monthly.rent.known), 1);
    assert.equal(rate((u) => !u.monthly.rent.known && u.monthly.rent.why === 'unparsed'), 0);
    assert.equal(rate((u) => u.layout.known), 1);
    assert.equal(rate((u) => u.areaM2.known), 1);
    assert.ok(rate((u) => u.floor.known) >= 0.99);
    // 敷金／礼金／管理費本來就不是每筆都有，只要別掉到離譜的低點
    assert.ok(rate((u) => u.initial.deposit.known) > 0.6, `敷金填充率 ${rate((u) => u.initial.deposit.known)}`);
    assert.ok(rate((u) => u.monthly.adminFee.known) > 0.6);
  });
});

// ───────────────────────── 7. capabilities 宣告 ─────────────────────────

describe('capabilities 宣告與實際產出一致', () => {
  const u = allUnits(extractAll(chiyodaP1, 'sc_chiyoda'))[0];

  test('neverProvides 的欄位一律 not_offered_by_source', () => {
    assert.ok(u);
    const map: Record<string, { known: boolean; why?: string }> = {
      agencyFee: u.initial.agencyFee, roomNo: u.roomNo,
      internet: u.monthly.internet, otherMonthly: u.monthly.otherMonthly,
      ageLimitRaw: u.ageLimitRaw, minStayMonths: u.minStayMonths,
      foreignerWelcomed: u.foreigner.welcomed,
      residenceCardRequired: u.foreigner.residenceCardRequired,
      japaneseRequired: u.foreigner.japaneseRequired,
      guarantorPersonRequired: u.foreigner.guarantorPersonRequired,
    };
    for (const id of manifest.capabilities.neverProvides) {
      if (id === 'genderRestriction') { assert.equal(u.genderRestriction, 'unknown'); continue; }
      const f = map[id];
      assert.ok(f !== undefined, `neverProvides 宣告了 ${id} 但測試沒有對應欄位`);
      assert.equal(f.known, false, `${id} 不該有值`);
      assert.equal(f.why, 'not_offered_by_source', `${id} 應為 not_offered_by_source`);
    }
  });

  test('「詳情頁有、一覧頁沒有」的欄位是 not_listed_on_page，不可謊稱來源不提供', () => {
    assert.ok(u);
    for (const [id, f] of [
      ['depositNonRefundable', u.initial.depositNonRefundable],
      ['guarantorInitialFee', u.initial.guarantorInitialFee],
      ['fireInsurance', u.initial.fireInsurance],
      ['keyExchangeFee', u.initial.keyExchangeFee],
      ['otherInitial', u.initial.otherInitial],
      ['utilities', u.monthly.utilities],
    ] as const) {
      assert.equal(f.known, false);
      if (!f.known) {
        assert.equal(f.why, 'not_listed_on_page', `${id} 應為 not_listed_on_page`);
        assert.notEqual(f.srcText.trim(), '', `${id} 應說明為什麼拿不到`);
      }
      assert.ok(!(manifest.capabilities.neverProvides as readonly string[]).includes(id),
        `${id} 不該出現在 neverProvides`);
    }
  });

  test('provides 與 neverProvides 沒有交集', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    for (const id of manifest.capabilities.neverProvides) assert.ok(!p.has(id), `${id} 同時出現在兩邊`);
  });
});
