/**
 * Couverture adapter 的黃金測試。
 *
 * 用 2026-10-17 改版後凍結的真實頁面快照測，不打對方伺服器。
 * 這個來源在那一天整站改版，舊解析器把 28 頁全判成「不在收錄範圍」——
 * 而它當時連一個測試都沒有，所以那次失效只能靠爬取結果暴跌才看得出來。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import {
  adapter, parseCvName, parseCvMeta, parseCvAddress, parseCvStations, parseCvTotalUnits,
  parseContractFees, cvFireInsurance, cvGender, parseCvProse, cvAvailableFrom, cvCleaningIncluded,
} from '../sources/couverture/index.ts';
import type { Listing } from '../../packages/schema/src/model.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/couverture/fixtures');
const page = (slug: string): string =>
  gunzipSync(readFileSync(path.join(FIX, `detail-${slug}-2026-10-17.html.gz`))).toString('utf8');

function extract(slug: string): Listing | null {
  const url = `https://couverture.jp/house_detail/${slug}/`;
  return adapter.extract(
    { url, body: page(slug), fetchedAt: '2026-10-17T02:09:00Z', sha256: 'x', status: 200, notModified: false },
    { url },
    { manifest: adapter.manifest, now: new Date('2026-10-17T02:09:00Z') },
  );
}

const unit = (l: Listing | null, no: string) => l?.units.find((u) => u.unitKey === no);

describe('名稱與基本情報', () => {
  test('名稱取自 <h1 class="room_name_ja">（改版後 <title> 不再以「シェアハウス」開頭）', () => {
    assert.equal(parseCvName(page('nakano')), 'クーベルチュール中野富士見町');
  });

  test('基本情報四欄都讀得到', () => {
    const m = parseCvMeta(page('nakano'));
    assert.equal(m.get('住所'), '東京都杉並区和田1丁目');
    assert.equal(m.get('部屋数'), '40(44ベッド）');
    assert.match(m.get('最寄り駅') ?? '', /^\[1\]東京メトロ丸の内方南線/);
    assert.match(m.get('初期費用') ?? '', /【契約手数料】40,000円/);
  });

  test('部屋数：開頭的整數就是房間數，原文整段留在 srcText', () => {
    for (const [v, n] of [['13部屋', 13], ['40(44ベッド）', 40], ['21 ', 21], ['6部屋（女性専用ペアルーム1室）', 6]] as const) {
      const f = parseCvTotalUnits(v);
      assert.ok(f.known && f.v === n, `${v} → ${JSON.stringify(f)}`);
    }
    assert.equal(parseCvTotalUnits('').known, false);
  });
});

describe('住所：不補都名、不猜区名', () => {
  test('東京都＋区', () => {
    assert.deepEqual(parseCvAddress('東京都杉並区和田1丁目'), { addressRaw: '東京都杉並区和田1丁目', prefecture: '東京都', ward: '杉並区' });
  });
  test('都名省略的頁不替它補「東京都」', () => {
    assert.deepEqual(parseCvAddress('豊島区北大塚3丁目'), { addressRaw: '豊島区北大塚3丁目', prefecture: '', ward: '豊島区' });
  });
  test('他県（ココンわらび＝埼玉県川口市）不收錄', () => {
    assert.equal(parseCvAddress(' 埼玉県川口市芝樋ノ爪'), null);
    assert.equal(extract('warabi'), null);
  });
  test('原站漏了「区」字（北大塚THREE：`東京都豊島北大塚3丁目`）→ 不收錄，不替它推成豊島区', () => {
    assert.equal(parseCvAddress('東京都豊島北大塚3丁目'), null);
    assert.equal(extract('kitaotsuka3'), null);
  });
});

describe('車站', () => {
  test('多站時的 [n] 寫法；站名照原站寫法（保留連字號）', () => {
    const s = parseCvStations(parseCvMeta(page('nakano')).get('最寄り駅') ?? '');
    assert.deepEqual(s.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]), [
      ['東京メトロ丸の内方南線', '中野-富士見町', 6],
      ['東京メトロ丸の内線（1番出口）', '東高円寺', 12],
      ['東京メトロ丸の内線（1番出口）', '新中野', 14],
    ]);
  });

  test('只有一站時沒有 [n]，「駅」在括號外——舊解析器這 5 棟的車站全掉了', () => {
    const s = parseCvStations(parseCvMeta(page('koiwa')).get('最寄り駅') ?? '');
    assert.deepEqual(s.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]), [['JR中央・総武線', '小岩', 7]]);
  });

  test('一行兩站共用一個分鐘數：兩站都收，但徒歩分記「頁面沒寫」，不替原站分配', () => {
    const s = parseCvStations('[4]ＪＲ「王子」「上中里」　徒歩16分');
    assert.deepEqual(s.map((x) => x.station), ['王子', '上中里']);
    for (const x of s) assert.equal(x.walkMinutes.known, false);
  });

  test('出口註記寫在站名後面（`「巣鴨駅」Ａ3出口　徒歩3分`）也要收——舊正則整行漏掉、只剩下較遠的 JR', () => {
    const s = parseCvStations('[1]都営地下鉄 三田線「巣鴨駅」Ａ3出口　徒歩3分\n[2]JR 山手線「巣鴨駅」徒歩5分');
    assert.deepEqual(s.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]), [
      ['都営地下鉄 三田線', '巣鴨', 3],
      ['JR 山手線', '巣鴨', 5],
    ]);
  });

  test('從車站轉公車（`「赤羽駅」バス10分`）不是徒歩距離，不收', () => {
    assert.deepEqual(parseCvStations('[2]JR埼京線「赤羽駅」バス10分'), []);
  });

  test('公車站不是鐵道車站，不收', () => {
    const s = parseCvStations(parseCvMeta(page('megurofudomae')).get('最寄り駅') ?? '');
    assert.ok(s.length > 0);
    assert.ok(!s.some((x) => /バス/.test(x.line) || x.station === '不動尊門前'), JSON.stringify(s.map((x) => x.station)));
  });
});

describe('契約手数料與火災保險', () => {
  test('分価：`水回り付個室`（沒有「き」）不可以被當成一般個室的價錢', () => {
    const f = parseContractFees('【契約手数料】\n水回り付個室：50,000円\n個室：40,000円\n※事務手数料…');
    assert.deepEqual([f.plain, f.wet, f.split], [40000, 50000, true]);
  });
  test('分価（個室在前、水回り付き個室在後）', () => {
    const f = parseContractFees('【契約手数料】\n個室：40,000円\n水回り付き個室：50,000円');
    assert.deepEqual([f.plain, f.wet, f.split], [40000, 50000, true]);
  });
  test('一本値（含 `【契約手数料】<br> 40,000円` 換行寫法）', () => {
    for (const v of ['【契約手数料】40,000円\n※事務手数料…', parseCvMeta(page('kitaueno')).get('初期費用') ?? '']) {
      const f = parseContractFees(v);
      assert.deepEqual([f.plain, f.wet, f.split], [40000, 40000, false], v);
    }
  });
  test('火災保險：有金額記金額、只說必須記「明講有但沒寫多少」、沒提到維持來源不提供', () => {
    const a = cvFireInsurance('居室内シャワー、洗面、トイレ、ベランダあり ※火災保険 必須 ￥12,400/ 2年');
    assert.ok(a.known && a.v.jpy === 12400);
    const b = cvFireInsurance('居室内シャワー、洗面、トイレあり ※保険加入必須');
    assert.ok(!b.known && b.why === 'not_listed_on_page' && b.basis === 'excluded_stated');
    const c = cvFireInsurance('角部屋');
    assert.ok(!c.known && c.why === 'not_offered_by_source');
  });
});

describe('房間（中野富士見町）', () => {
  const l = extract('nakano');

  test('只收空室；満室的房不產生 unit', () => {
    assert.ok(l);
    assert.deepEqual(l.units.map((u) => u.unitKey).sort(), ['004-C', '110', '208', '209', '210']);
  });

  test('性別看房間卡片自己的標籤——頁尾其他物件的 Female 不可以漏進來', () => {
    // 舊版對整頁文字判性別：這棟的男性房 110 會被標成女性專用
    assert.equal(unit(l, '110')?.genderRestriction, 'male_only');
    assert.equal(unit(l, '208')?.genderRestriction, 'female_only');
    assert.deepEqual([cvGender(['Female', 'Male']), cvGender(['Female']), cvGender([])], ['mixed', 'female_only', 'unknown']);
  });

  test('トリプルルーム的一張床：layout 是ドミトリー、面積不當成這張床的', () => {
    const u = unit(l, '004-C');
    assert.ok(u?.layout.known && u.layout.v === 'ドミトリー');
    assert.equal(u.areaM2.known, false);
    assert.ok(u.monthly.rent.known && u.monthly.rent.v.jpy === 29000);
  });

  test('原站筆誤 `60000㎡ ／ 7.2帖` 照抄、帖數留在 srcText——交給建置期的㎡／帖不變式抓，不在這裡改值', () => {
    const u = unit(l, '210');
    assert.ok(u?.areaM2.known && u.areaM2.v === 60000);
    assert.match(u.areaM2.srcText, /7\.2帖/);
  });

  test('「10/29～空室」收進來但不是現在空（isVacant=false，同 ひつじ scheduled／TSH 空室予定），原文留在 notes；入居時期存 --10-29（原站沒寫年，不替它補）', () => {
    const u = unit(l, '110');
    assert.ok(u?.isVacant.known && u.isVacant.v === false);
    assert.equal(u.isVacant.srcText, '空室状況 10/29～空室');
    assert.ok(u.notes.includes('空室状況：10/29～空室'));
    assert.ok(u.availableFrom.known && u.availableFrom.v === '--10-29', JSON.stringify(u.availableFrom));
  });

  test('「空室」→ 入居時期 随時', () => {
    const u = unit(l, '004-C');
    assert.ok(u?.availableFrom.known && u.availableFrom.v === '随時');
    assert.ok(u.isVacant.known && u.isVacant.v === true);
  });

  test('改版後頁面不再列個室設備，furnished 是「頁面沒寫」，不沿用舊版的 true', () => {
    assert.equal(unit(l, '208')?.furnished.known, false);
  });
});

describe('房間（門前仲町：分価＋火災保險）', () => {
  const l = extract('monzennakacho');
  test('水回り付き的房收 50,000、其餘 40,000，判定依據寫進 srcText', () => {
    const c = unit(l, 'c');
    const h = unit(l, 'h');
    assert.ok(c?.initial.contractFee.known && c.initial.contractFee.v.jpy === 50000);
    assert.match(c.initial.contractFee.srcText, /居室內有水回り/);
    assert.ok(h?.initial.contractFee.known && h.initial.contractFee.v.jpy === 40000);
  });
  test('備考裡的火災保險金額進 initial.fireInsurance', () => {
    const c = unit(l, 'c');
    assert.ok(c?.initial.fireInsurance.known && c.initial.fireInsurance.v.jpy === 12400);
  });
});

describe('房間（プチ日本橋本町：女性專用ツインルーム）', () => {
  test('ツインルーム的床位：女性專用、ドミトリー', () => {
    const u = unit(extract('nihonbashihoncho'), '301b');
    assert.equal(u?.genderRestriction, 'female_only');
    assert.ok(u?.layout.known && u.layout.v === 'ドミトリー');
  });
});

describe('西巣鴨：一行兩站', () => {
  test('王子／上中里都收、徒歩分未知；其他站正常', () => {
    const s = extract('nishisugamo')?.building.stations ?? [];
    const byName = new Map(s.map((x) => [x.station, x]));
    assert.equal(byName.get('王子')?.walkMinutes.known, false);
    assert.equal(byName.get('上中里')?.walkMinutes.known, false);
    const w = byName.get('西巣鴨')?.walkMinutes;
    assert.ok(w?.known && w.v === 10);
  });
});

describe('介紹文裡的築年／樓層數', () => {
  test('「2017年にシェアハウスのために建てられた建物で、」→ 2017，原句留 srcText', () => {
    const r = parseCvProse(page('ikebukurowest'));
    assert.ok(r.yearBuilt.known && r.yearBuilt.v === 2017, JSON.stringify(r.yearBuilt));
    assert.match(r.yearBuilt.srcText, /2017年にシェアハウスのために建てられた/);
  });

  test('「2023年7月…新築で建てられた4階建てのビル」→ 2023 年、4 層', () => {
    const r = parseCvProse('<div class="room_description"><p>2023年7月シェアハウスのために新築で建てられた4階建てのビル<br />1～3階がシェアハウスのスペースです。</p></div>');
    assert.ok(r.yearBuilt.known && r.yearBuilt.v === 2023);
    assert.ok(r.floorsAboveGround.known && r.floorsAboveGround.v === 4);
  });

  test('頁首全站列表的「2026年9月フルリノベーションでオープン」是別棟、而且是改裝——不是這棟的築年', () => {
    const html = page('nakano');
    assert.match(html, /フルリノベーションでオープン/, 'fixture 應含該字樣，否則沒在測東西');
    const r = parseCvProse(html);
    assert.equal(r.yearBuilt.known, false);
    assert.equal(r.yearBuilt.known ? null : r.yearBuilt.why, 'not_offered_by_source');
  });

  test('介紹文自己的改裝句也不收', () => {
    const r = parseCvProse('<div class="room_description"><p>2019年に建てられたマンションの2階と3階をリノベーションしたシェアハウス</p></div>');
    assert.equal(r.yearBuilt.known, false);
  });
});

describe('2026-10-17 全量重驗補的三件事', () => {
  test('cvAvailableFrom：空室／M/D～空室／其他', () => {
    const now = cvAvailableFrom('空室');
    assert.equal(now.known ? now.v : null, '随時');
    const d = cvAvailableFrom('11/5～空室');
    assert.ok(d.known && d.v === '--11-05');
    assert.equal(cvAvailableFrom('10/31満室').known, false);
  });

  test('一行兩組「站名＋徒歩」各配自己的分鐘數（上野：`「鶯谷」徒歩10分、「上野」徒歩15分`）', () => {
    const s = parseCvStations('[3]JR山手線「鶯谷」徒歩10分、「上野」徒歩15分');
    assert.deepEqual(s.map((x) => [x.line, x.station, x.walkMinutes.known ? x.walkMinutes.v : null]), [
      ['JR山手線', '鶯谷', 10],
      ['JR山手線', '上野', 15],
    ]);
  });

  test('房間備考寫了這間房自己的家具（門前仲町 h：ソファ、セミダブルベッド付）→ furnished true', () => {
    const u = unit(extract('monzennakacho'), 'h');
    assert.ok(u?.furnished.known && u.furnished.v === true, JSON.stringify(u?.furnished));
    assert.match(u.furnished.srcText, /ベッド/);
  });
});

describe('2026-10-17 第二十五輪：清掃費含在契約手数料', () => {
  test('初期費用欄「※事務手数料や個室清掃費などを含む…」→ 入居清掃費＝含在其他費用（0、included_stated），引原句', () => {
    const units = extract('kitaueno')?.units ?? [];
    assert.ok(units.length > 0);
    const f = units[0]?.initial.cleaningFeeUpfront;
    assert.ok(f?.known);
    assert.equal(f.v.jpy, 0);
    assert.equal(f.basis, 'included_stated');
    assert.match(f.srcText, /個室清掃費などを含む契約時のみ/);
  });
  test('沒有這句註腳就維持「此來源不公開」', () => {
    const f = cvCleaningIncluded('【契約手数料】40,000円');
    assert.equal(f.known === false && f.why, 'not_offered_by_source');
  });
});
