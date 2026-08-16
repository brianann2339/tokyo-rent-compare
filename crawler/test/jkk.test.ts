/**
 * JKK東京 adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照（2026-08-16 自 jhomes.to-kousya.or.jp 抓取、Shift_JIS 解碼後存檔）測，
 * 不打對方伺服器。填充率監控抓不到「把敷金欄與月収基準欄對錯位」這種
 * 值全錯但填充率 100% 的故障，只有對答案的測試抓得到。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, manifest,
  parseJkkAccessLine, parseJkkDetail, parseJkkUnitRows, parseTeishaku,
  parseResultRows, parseHitCount, splitWard, hiddenParams, xyzToken,
} from '../sources/jkk/index.ts';
import type { RawDoc, TargetRef, ExtractContext } from '../src/types.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/jkk/fixtures');
const fixture = (n: string): string => gunzipSync(readFileSync(path.join(FIX, n))).toString('utf8');

const yogaHtml = fixture('detail-setagaya-carmest-yoga.html.gz');
const yokokawaHtml = fixture('detail-hachioji-yokokawacho.html.gz');
const resultHtml = fixture('result-list-23ku.html.gz');
const formHtml = fixture('search-form.html.gz');

const RAW: RawDoc = {
  url: 'https://www.to-kousya.or.jp/chintai/reco/c_yogabajikoen.html',
  body: '', fetchedAt: '2026-08-16T00:00:00.000Z', sha256: '', status: 200, notModified: false,
};
const CTX: ExtractContext = { manifest, now: new Date('2026-08-16T00:00:00Z') };

describe('Shift_JIS 快照的完整性', () => {
  test('日文沒有亂碼（解碼正確才可能出現這些字）', () => {
    assert.ok(yogaHtml.includes('カーメスト用賀馬事公苑'));
    assert.ok(yogaHtml.includes('世田谷区上用賀四丁目１７番１号'));
    assert.ok(yokokawaHtml.includes('定期借家契約ではありません'));
    // U+FFFD（置換字元）出現就代表解碼錯了
    assert.equal(yogaHtml.includes('�'), false);
    assert.equal(yokokawaHtml.includes('�'), false);
  });
});

describe('搜尋流程用到的表單欄位', () => {
  test('搜尋表單有 token / abcde / jklm', () => {
    const q = hiddenParams(formHtml, 'akiSearch');
    assert.match(q.get('token') ?? '', /^[0-9A-F]{32}$/);
    assert.match(q.get('abcde') ?? '', /^[0-9A-F]{32}$/);
    assert.equal(q.get('jklm'), '');
    assert.equal(q.get('sen_flg'), '1');
  });

  test('submitPage 的一次性 xyz 值要能取出（回填到 jklm）', () => {
    assert.match(xyzToken(formHtml, 'submitPage'), /^[0-9A-F]{32}$/);
  });

  test('結果頁能取出 senPage 的一次性值與分頁欄位', () => {
    assert.match(xyzToken(resultHtml, 'senPage'), /^[0-9A-F]{32}$/);
    const q = hiddenParams(resultHtml, 'frmMain');
    assert.equal(q.get('pagingInputDataGrid_url'), 'AKIYA');
    assert.equal(q.get('pagingInputDataGrid_name'), 'AKIYA_GRID');
  });
});

describe('結果清單解析', () => {
  test('件數與列數一致（23 区，2026-08-16 快照）', () => {
    assert.equal(parseHitCount(resultHtml), 3);
    const rows = parseResultRows(resultHtml);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { boshuNo: '', mskKbn: 'L8852', jyutakuCd: '1280950', yusenKbn: '0000' });
    assert.deepEqual(rows.map((r) => r.mskKbn), ['L8852', 'L8855', 'L8856']);
    // 同一棟住宅會因申込区分不同拆成多列
    assert.equal(new Set(rows.map((r) => r.jyutakuCd)).size, 1);
  });

  test('查無物件的頁面回 0，不丟例外', () => {
    assert.equal(parseHitCount('<html>ご希望の条件の空室はございませんでした。</html>'), 0);
    assert.deepEqual(parseResultRows('<html></html>'), []);
  });
});

describe('交通欄解析（無分隔符的 会社名＋路線名＋駅名）', () => {
  test('路線名直接開頭', () => {
    const s = parseJkkAccessLine('東急田園都市線用賀駅徒歩15分');
    assert.equal(s?.line, '東急田園都市線');
    assert.equal(s?.station, '用賀');
    assert.equal(s?.walkMinutes.known && s.walkMinutes.v, 15);
  });

  test('会社名與路線名重複：京王京王線京王八王子 → 京王線／京王八王子', () => {
    const s = parseJkkAccessLine('京王京王線京王八王子駅バス24分住宅中央徒歩1～5分');
    assert.equal(s?.line, '京王線');
    assert.equal(s?.station, '京王八王子');
  });

  test('多摩都市モノレール重複兩次 → 駅名只剩 松が谷（對過 JKK 自己的駅マスタ）', () => {
    const s = parseJkkAccessLine('多摩都市モノレール多摩都市モノレール松が谷駅徒歩13～16分');
    assert.equal(s?.line, '多摩都市モノレール');
    assert.equal(s?.station, '松が谷');
    // 範圍取下界
    assert.equal(s?.walkMinutes.known && s.walkMinutes.v, 13);
  });

  test('需先搭公車時，徒歩分不可當步行距離', () => {
    const s = parseJkkAccessLine('東急田園都市線用賀駅バス10分用賀公団前徒歩2分');
    assert.equal(s?.station, '用賀');
    assert.equal(s?.walkMinutes.known, false);
    assert.ok(s?.walkMinutes.srcText.includes('公車'));
  });

  test('沒有駅字的字串 → null，不硬湊', () => {
    assert.equal(parseJkkAccessLine('　'), null);
    assert.equal(parseJkkAccessLine('詳細情報'), null);
  });

  test('詳情頁的交通欄：同站不同路線各算一筆，重複去除', () => {
    const d = parseJkkDetail(yogaHtml);
    assert.equal(d?.stations.length, 2);
    assert.deepEqual(d?.stations.map((s) => `${s.line}/${s.station}`),
      ['東急田園都市線/用賀', '小田急小田原線/千歳船橋']);
  });
});

describe('定借期限・期間', () => {
  test('否定句必須判成普通借家（jp-parse 的 parseContractType 在這裡會判反）', () => {
    assert.deepEqual(parseTeishaku('定期借家契約ではありません'), { type: 'ordinary', months: null });
  });
  test('「3年間」→ 定期借家 36 個月', () => {
    assert.deepEqual(parseTeishaku('3年間'), { type: 'fixed_term', months: 36 });
  });
  test('「5年間」→ 60 個月', () => {
    assert.deepEqual(parseTeishaku('5年間'), { type: 'fixed_term', months: 60 });
  });
  test('空字串 → unknown，不預設任何一邊', () => {
    assert.deepEqual(parseTeishaku(''), { type: 'unknown', months: null });
  });
});

describe('住戸一覽表逐格對位', () => {
  test('カーメスト用賀馬事公苑：3 間房，每格與原站一致', () => {
    const rows = parseJkkUnitRows(yogaHtml);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.roomNo, r.layout, r.rentRaw, r.depositRaw, r.adminRaw, r.areaRaw, r.floorRaw]),
      [
        ['1-103', '１ＬＤＫ', '206,800', '620,400', '10,000', '45.7', '1'],
        ['1-202', '１ＬＤＫ', '233,400', '700,200', '10,000', '50.17', '2'],
        ['1-307', '１ＬＤＫ', '215,700', '647,100', '10,000', '45.7', '3'],
      ],
    );
    assert.equal(rows[0]?.address, '世田谷区上用賀四丁目１７番１号');
    assert.equal(rows[0]?.availableRaw, '即入居可');
  });

  test('敷金欄不是月収基準：JKK 官方「敷金は原則、月額家賃の2か月分（一部住宅は3か月分）」', () => {
    const yoga = parseJkkUnitRows(yogaHtml)[0];
    const yoko = parseJkkUnitRows(yokokawaHtml)[0];
    // 用賀是 3 か月、横川町是 2 か月——倍率不固定，正是「這欄是敷金而非固定倍率的月収基準」的證據
    assert.equal(Number(yoga?.depositRaw.replace(/,/g, '')) / Number(yoga?.rentRaw.replace(/,/g, '')), 3);
    assert.equal(Number(yoko?.depositRaw.replace(/,/g, '')) / Number(yoko?.rentRaw.replace(/,/g, '')), 2);
  });

  test('格數不等於 13 就丟例外，不錯位輸出金額', () => {
    const broken = '>間取り図</td>'
      + '<td width="90" rowspan="3" class="ListTXT1"></td>'
      + '<td class="ListTXT1">1-101</td><td class="ListTXT1">70,000</td>';
    assert.throws(() => parseJkkUnitRows(broken), /住戸列格數異常/);
  });

  test('沒有住戸表的頁面 → 空陣列', () => {
    assert.deepEqual(parseJkkUnitRows('<html><body>おわび</body></html>'), []);
  });
});

describe('建物層資訊', () => {
  test('カーメスト用賀馬事公苑', () => {
    const d = parseJkkDetail(yogaHtml);
    assert.equal(d?.name, 'カーメスト用賀馬事公苑');
    assert.equal(d?.kindRaw, '一般賃貸住宅（期限付）');
    assert.equal(d?.mskKbn, 'L8852');
    assert.equal(d?.yusen, '一般申込');
    assert.equal(d?.totalUnitsRaw, '79');
    assert.equal(d?.floorsRaw, '地上４階建');
    assert.equal(d?.teishakuRaw, '3年間');
    assert.equal(d?.builtRaw, '2025/08/20');
    assert.equal(d?.publicUrl, 'https://www.to-kousya.or.jp/chintai/reco/c_yogabajikoen.html');
    assert.ok(d?.remarks.includes('保証会社の利用が必須'));
  });

  test('横川町（普通借家、市部）', () => {
    const d = parseJkkDetail(yokokawaHtml);
    assert.equal(d?.name, '横川町');
    assert.equal(d?.teishakuRaw, '定期借家契約ではありません');
    assert.equal(d?.builtRaw, '1980/01/08');
    assert.equal(d?.units.length, 1);
  });

  test('住所 → 都道府県與市区町村（「区」不可貪婪吃掉町名）', () => {
    assert.deepEqual(splitWard('世田谷区上用賀四丁目１７番１号'),
      { addressRaw: '東京都世田谷区上用賀四丁目１７番１号', ward: '世田谷区' });
    assert.deepEqual(splitWard('八王子市横川町１０８－２４'),
      { addressRaw: '東京都八王子市横川町１０８－２４', ward: '八王子市' });
    assert.equal(splitWard('番地不明'), null);
  });
});

describe('extract：完整 Listing', () => {
  const ref: TargetRef = {
    url: 'https://www.to-kousya.or.jp/chintai/reco/c_yogabajikoen.html',
    hint: { jyutakuCd: '1280950', details: [yogaHtml] },
  };
  const listing = adapter.extract(RAW, ref, CTX);

  test('建物欄位', () => {
    assert.ok(listing !== null);
    const b = listing.building;
    assert.equal(b.id, 'jkk:1280950');
    assert.equal(b.sourceId, 'jkk');
    assert.equal(b.name, 'カーメスト用賀馬事公苑');
    assert.equal(b.ward, '世田谷区');
    assert.equal(b.addressRaw, '東京都世田谷区上用賀四丁目１７番１号');
    assert.equal(b.yearBuilt.known && b.yearBuilt.v, 2025);
    assert.equal(b.floorsAboveGround.known && b.floorsAboveGround.v, 4);
    assert.equal(b.totalUnits.known && b.totalUnits.v, 79);
    assert.equal(b.sourceUrl, 'https://www.to-kousya.or.jp/chintai/reco/c_yogabajikoen.html');
  });

  test('房間費用逐筆對原站', () => {
    assert.ok(listing !== null);
    assert.equal(listing.units.length, 3);
    const u = listing.units[0];
    assert.equal(u?.unitKey, '1-103');
    assert.equal(u?.monthly.rent.known && u.monthly.rent.v.jpy, 206_800);
    assert.equal(u?.monthly.adminFee.known && u.monthly.adminFee.v.jpy, 10_000);
    assert.equal(u?.initial.deposit.known && u.initial.deposit.v.jpy, 620_400);
    assert.equal(u?.layout.known && u.layout.v, '1LDK');
    assert.equal(u?.areaM2.known && u.areaM2.v, 45.7);
    assert.equal(u?.floor.known && u.floor.v, 1);
    assert.equal(u?.availableFrom.known && u.availableFrom.v, '随時');
    assert.equal(u?.isVacant.known && u.isVacant.v, true);
    assert.equal(u?.contractType, 'fixed_term');
    assert.equal(u?.contractMonths.known && u.contractMonths.v, 36);
  });

  test('零費用三項有值 0 且都指得出出處（建置期閘門 1 的要求）', () => {
    assert.ok(listing !== null);
    for (const u of listing.units) {
      for (const [id, f] of [
        ['keyMoney', u.initial.keyMoney], ['agencyFee', u.initial.agencyFee],
        ['renewalFee', u.deferred.renewalFee],
      ] as const) {
        assert.ok(f.known, `${id} 應為 known`);
        assert.equal(f.v.jpy, 0);
        assert.equal(f.basis, 'measured');
        assert.ok(f.srcText.includes('全物件が礼金・仲介手数料・更新料一切なし'), `${id} 缺出處`);
      }
    }
  });

  test('敷金絕不套用零費用通則，也不預設 0', () => {
    assert.ok(listing !== null);
    // 有金額時照讀
    assert.equal(listing.units[1]?.initial.deposit.known && listing.units[1].initial.deposit.v.jpy, 700_200);
    // 欄位空白時是「未知」，不是 0
    const blanked = yogaHtml.replace(
      /(<td width="58" rowspan="2" class="ListTXT1">\s*)620,400(\s*<\/td>)/, '$1$2',
    );
    assert.notEqual(blanked, yogaHtml, '測試前提：快照裡要有 620,400 這一格');
    const l2 = adapter.extract(RAW, { url: ref.url, hint: { jyutakuCd: '1280950', details: [blanked] } }, CTX);
    const d = l2?.units[0]?.initial.deposit;
    assert.equal(d?.known, false);
    assert.equal(d?.known === false && d.why, 'not_listed_on_page');
  });

  test('每個 known 欄位都有非空 srcText（建置期閘門 2 的要求）', () => {
    assert.ok(listing !== null);
    const b = listing.building;
    for (const f of [b.yearBuilt, b.floorsAboveGround, b.totalUnits]) {
      if (f.known) assert.notEqual(f.srcText.trim(), '');
    }
    for (const u of listing.units) {
      const fields = [
        u.roomNo, u.layout, u.areaM2, u.floor, u.availableFrom, u.isVacant, u.contractMonths,
        u.monthly.rent, u.monthly.adminFee, u.initial.deposit,
        u.initial.keyMoney, u.initial.agencyFee, u.deferred.renewalFee,
        u.foreigner.welcomed, u.foreigner.guarantorCompanyRequired,
      ];
      for (const f of fields) {
        if (f.known) assert.notEqual(f.srcText.trim(), '', JSON.stringify(f));
      }
      for (const s of u.foreigner.rawText === '' ? [] : [u.foreigner.rawText]) {
        assert.ok(s.includes('外国籍の方でもお申込みできます'));
      }
    }
  });

  test('外國人政策：站方明文可申請；保証会社「必須」只在特記事項明寫時才成立', () => {
    assert.ok(listing !== null);
    const f = listing.units[0]?.foreigner;
    assert.equal(f?.welcomed.known && f.welcomed.v, true);
    assert.ok(f?.welcomed.srcText.includes('外国籍の方でもお申込みできます'));
    // 這棟的特記事項明寫「当住宅は保証会社の利用が必須となります」
    assert.equal(f?.guarantorCompanyRequired.known && f.guarantorCompanyRequired.v, true);
    // 沒明寫的住宅不可推定
    const yoko = adapter.extract(RAW, { url: 'x', hint: { jyutakuCd: '3180120', details: [yokokawaHtml] } }, CTX);
    assert.equal(yoko?.units[0]?.foreigner.guarantorCompanyRequired.known, false);
  });

  test('敷金 0 円 的條件寫進 notes，不寫進金額', () => {
    assert.ok(listing !== null);
    assert.ok(listing.units[0]?.notes.some((n) => n.includes('らくらくスタート安心プラン')));
  });

  test('普通借家的物件不可被標成定期借家', () => {
    const l = adapter.extract(RAW, { url: 'x', hint: { jyutakuCd: '3180120', details: [yokokawaHtml] } }, CTX);
    assert.equal(l?.units[0]?.contractType, 'ordinary');
    assert.equal(l?.units[0]?.contractMonths.known, false);
  });

  test('hint 不合法時回 null，不產出空資料', () => {
    assert.equal(adapter.extract(RAW, { url: 'x' }, CTX), null);
    assert.equal(adapter.extract(RAW, { url: 'x', hint: { jyutakuCd: '1', details: [] } }, CTX), null);
    assert.equal(adapter.extract(RAW, { url: 'x', hint: { jyutakuCd: '1', details: ['<html></html>'] } }, CTX), null);
  });

  test('同一棟的多個申込区分合併成一個 Building，房號去重', () => {
    const l = adapter.extract(
      RAW, { url: 'x', hint: { jyutakuCd: '1280950', details: [yogaHtml, yogaHtml] } }, CTX,
    );
    assert.equal(l?.units.length, 3);
    assert.equal(new Set(l?.units.map((u) => u.id)).size, 3);
  });
});

describe('manifest 的誠實宣告', () => {
  test('crawlDelayMs ≥ 5000（對方是公共機構的老系統）', () => {
    assert.ok(manifest.crawlDelayMs >= 5000);
  });
  test('fetchMode 為 none：資料在 discover 就備齊，不再 GET 詳情頁', () => {
    assert.equal(manifest.fetchMode, 'none');
  });
  test('provides 與 neverProvides 不重疊', () => {
    const p = new Set<string>(manifest.capabilities.provides);
    for (const n of manifest.capabilities.neverProvides) assert.equal(p.has(n), false, n);
  });
  test('實際會填的欄位有宣告在 provides', () => {
    for (const id of ['deposit', 'keyMoney', 'agencyFee', 'renewalFee', 'contractType', 'foreignerWelcomed']) {
      assert.ok(manifest.capabilities.provides.includes(id as never), id);
    }
  });
});
