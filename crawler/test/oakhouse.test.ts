/**
 * Oak House adapter 的黃金測試。
 *
 * 用凍結的真實頁面快照測（複製自 2026-09-06 的 data/raw/oakhouse，未經修改），
 * 不打對方伺服器。這個來源先前完全沒有測試檔，而它同時是本輪稽核裡
 * 被改動最多的來源——沒有對答案的測試，填充率再漂亮也證明不了值是對的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { text, parseBadges, parseOakBuildingSummary, parseOakAddress } from '../sources/oakhouse/index.ts';

const FIX = path.resolve(import.meta.dirname, '../sources/oakhouse/fixtures');
const fixture = (name: string): string => gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8');

// /apartment/14493 プレール・ドゥーク方南町：礼金あり・保証会社必要・建築年月あり
const honancho = fixture('apartment-14493-preal-douk-honancho.html.gz');
// /apartment/1117 オークアパートメント新宿：初期費用全免、且沒有建築年月
const shinjuku = fixture('apartment-1117-oak-apartment-shinjuku.html.gz');

describe('初期費用徽章的正反兩面', () => {
  test('原頁寫「保証会社必要」時要收下來，不是當成「原站沒寫」', () => {
    const b = parseBadges(honancho);
    assert.equal(b.guarantorCompanyRequired, true);
    assert.equal(b.noGuarantorCompany, false);
    // 原頁徽章列：敷金なし 礼金あり 保証金なし 保証人不要 保証会社必要 外国人入居可
    assert.equal(b.hasKeyMoney, true, '「礼金あり」＝有礼金但沒寫金額');
    assert.equal(b.noKeyMoney, false);
    assert.equal(b.noDeposit, true, '「敷金なし」＝敷金真的是 0');
    assert.equal(b.hasDeposit, false);
    assert.equal(b.noGuarantorPerson, true);
    assert.equal(b.guarantorPersonRequired, false);
  });

  test('全免的物件不會因為新增正面徽章而誤判', () => {
    const b = parseBadges(shinjuku);
    for (const k of ['noDeposit', 'noKeyMoney', 'noSecurityDeposit', 'noAgencyFee',
      'noGuarantorPerson', 'noGuarantorCompany'] as const) {
      assert.equal(b[k], true, `${k} 應為 true`);
    }
    for (const k of ['hasDeposit', 'hasKeyMoney', 'hasSecurityDeposit',
      'guarantorPersonRequired', 'guarantorCompanyRequired'] as const) {
      assert.equal(b[k], false, `${k} 應為 false`);
    }
  });

  test('正反徽章互斥——同一頁不會同時說「なし」與「あり」', () => {
    for (const html of [honancho, shinjuku]) {
      const b = parseBadges(html);
      assert.ok(!(b.noDeposit && b.hasDeposit));
      assert.ok(!(b.noKeyMoney && b.hasKeyMoney));
      assert.ok(!(b.noGuarantorCompany && b.guarantorCompanyRequired));
      assert.ok(!(b.noGuarantorPerson && b.guarantorPersonRequired));
    }
  });
});

describe('建物概要：構造／地上樓層／建築年月', () => {
  test('原頁「RC 3階建て 建築年月:2024/04」三個值全部收得到', () => {
    const s = parseOakBuildingSummary(text(honancho));
    assert.equal(s.structure.known && s.structure.v, 'RC', 'RC 沒有「造」字，舊 regex 抓不到');
    assert.equal(s.floorsAboveGround.known && s.floorsAboveGround.v, 3);
    assert.equal(s.yearBuilt.known && s.yearBuilt.v, 2024);
    // 這是站方寫的確切建築年月，不是從「築N年」推的下界，所以 measured 站得住
    assert.equal(s.yearBuilt.known && s.yearBuilt.basis, 'measured');
    assert.match(s.yearBuilt.srcText, /2024\/04/);
  });

  test('沒寫建築年月的頁面不可以生一個年份出來', () => {
    const s = parseOakBuildingSummary(text(shinjuku));
    assert.equal(s.structure.known && s.structure.v, '鉄骨造');
    assert.equal(s.floorsAboveGround.known && s.floorsAboveGround.v, 3);
    assert.equal(s.yearBuilt.known, false);
    assert.equal(s.yearBuilt.known === false && s.yearBuilt.why, 'not_listed_on_page');
  });

  test('構造格是空的時候，不可以把「11階建」的 1 當成構造', () => {
    const s = parseOakBuildingSummary('建物概要｜ ｜ ｜ 11階建て ｜');
    assert.equal(s.floorsAboveGround.known && s.floorsAboveGround.v, 11);
    assert.equal(s.structure.known, false);
  });

  test('認不得的構造寫法標 unparsed（故障訊號），不是 notListed（假裝沒寫）', () => {
    const s = parseOakBuildingSummary('建物概要｜ ｜ ブロック塀 ｜ 2階建て ｜');
    assert.equal(s.structure.known, false);
    assert.equal(s.structure.known === false && s.structure.why, 'unparsed');
    assert.match(s.structure.srcText, /ブロック塀/);
  });

  test('沒有「建物概要」區塊 → 三欄都是 not_listed_on_page', () => {
    const s = parseOakBuildingSummary('｜まったく別のページ｜');
    for (const f of [s.structure, s.floorsAboveGround, s.yearBuilt]) {
      assert.equal(f.known, false);
      assert.equal(f.known === false && f.why, 'not_listed_on_page');
    }
  });
});

describe('住所是結構化欄位，不從介紹文猜', () => {
  test('方南町這一頁解得出東京都杉並区以外的正確值', () => {
    const a = parseOakAddress(text(honancho));
    assert.notEqual(a, null);
    assert.match(a?.prefecture ?? '', /[都道府県]$/);
    assert.match(a?.ward ?? '', /[区市町村]$/);
  });

  test('沒有住所欄時回 null，不編一個東京都出來', () => {
    assert.equal(parseOakAddress('｜どこにも住所欄がない｜'), null);
  });
});
