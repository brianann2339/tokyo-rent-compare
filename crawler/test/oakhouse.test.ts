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

import { text, parseBadges, parseOakBuildingSummary, parseOakAddress, parseRooms, oakAvailableFrom, oakEstimateConfirms, oakCardRows, oakCardEstimateBalances, oakRemarkFees, parseOakOtherAccess, adapter } from '../sources/oakhouse/index.ts';

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

describe('入居時期（2026-10-17 驗證幫手指出 1,557 間全記成「頁面沒寫」）', () => {
  const v = (f: ReturnType<typeof oakAvailableFrom>): string | null => (f.known ? f.v : null);

  test('新版卡片：房號後面的狀態', () => {
    assert.equal(v(oakAvailableFrom('', '202 | 空室予定 2026/12/11 ~')), '2026-12-11');
    assert.equal(v(oakAvailableFrom('', '504 | 空室')), '随時');
    assert.equal(v(oakAvailableFrom('', '0202 | 空室予定 202610 ~')), '2026-10', '只到月就只存到月，不補日');
    const consult = oakAvailableFrom('', '204 | 入居日相談');
    assert.ok(!consult.known && consult.srcText === '入居日相談');
  });

  test('舊版表格：房號旁的 <em><span>日期 ~</span></em>，以及兩顆按鈕裡挑狀態那顆', () => {
    assert.equal(v(oakAvailableFrom('<tr id="1"><div class="ext-spheader"> <h3>207</h3> <em> <span>2026/12/17 ~ </span> </em>', '207')), '2026-12-17');
    const carts = '<tr id="2"><a class="c-button ext-cart">2026/9/10 ～入居可能</a><a class="c-button ext-cart">お問い合わせ</a>';
    assert.equal(v(oakAvailableFrom(carts, '301')), '2026-09-10');
  });

  test('只有日期、沒有「~」（/house/1204 新規オープン 11/1）→ 也是入居起始日', () => {
    const f = oakAvailableFrom('<tr id="3"><div class="ext-spheader"> <h3>101</h3> <em>2026/11/01</em>', '101');
    assert.ok(f.known && f.v === '2026-11-01' && f.srcText === '2026/11/01');
  });

  test('「入居日相談」「お申込みから1カ月後」不是日期 → 頁面沒給日期，原文留著', () => {
    for (const st of ['入居日相談', 'お申込みから1カ月後の入居になります。']) {
      const f = oakAvailableFrom(`<tr id="4"><div class="ext-spheader"> <h3>102</h3> <em>${st}</em>`, '102');
      assert.ok(!f.known && f.srcText === st, st);
    }
  });

  test('真實頁面（/apartment/17410）：202 號 2026-12-11、401 號 2026-11-01', () => {
    const rooms = parseRooms(fixture('apartment-17410-2026-10-17.html.gz'));
    const by = new Map(rooms.map((r) => [r.roomNo.known ? r.roomNo.v : r.id, r]));
    assert.equal(v(by.get('202')?.availableFrom ?? oakAvailableFrom('', '')), '2026-12-11');
    assert.equal(v(by.get('401')?.availableFrom ?? oakAvailableFrom('', '')), '2026-11-01');
  });
});

describe('徽章「礼金なし」vs 房間卡片「礼金 1ヶ月」：用卡片的初期費用概算裁決', () => {
  const html = fixture('apartment-17916-2026-10-17.html.gz');
  const url = 'https://www.oakhouse.jp/apartment/17916';
  const l = adapter.extract(
    { url, body: html, fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
  );

  test('504 室：2×(120,000＋11,000)＋礼金 120,000＋其餘各列 ＝ 概算 629,500 → 採信卡片', () => {
    const u = l?.units.find((x) => x.roomNo.known && x.roomNo.v === '504');
    const f = u?.initial.keyMoney;
    assert.ok(f?.known && f.v.jpy === 120000, JSON.stringify(f));
    assert.match(f.srcText, /初期費用概算 ¥629,500/);
    assert.match(f.srcText, /礼金なし/, '徽章的矛盾要留在原文裡');
  });

  const yen = (n: number) => ({ known: true as const, v: { jpy: n } as never, basis: 'measured' as const, srcText: '' });
  const card = (fee: string, est: string) =>
    `｜毎月費用｜賃料｜¥100,000｜共益費・管理費｜¥10,000｜礼金｜${fee}｜鍵交換費用｜20,000円｜初期費用概算｜¥${est}｜`;

  test('概算對不上卡片版本 → 不採信（維持 conflicting）', () => {
    assert.equal(oakEstimateConfirms(card('1ヶ月', '340,000'), yen(100000), yen(10000), '礼金')?.estimate, 340000);
    assert.equal(oakEstimateConfirms(card('1ヶ月', '340,001'), yen(100000), yen(10000), '礼金'), null, '差 1 円也不算');
    assert.equal(oakEstimateConfirms(card('1ヶ月', '240,000'), yen(100000), yen(10000), '礼金'), null, '吻合的是「礼金 0」那一版');
  });

  test('卡片上有一列解析不出金額 → 無法驗算，回 null', () => {
    const t = card('1ヶ月', '340,000').replace('鍵交換費用｜20,000円', '鍵交換費用｜別途');
    assert.equal(oakEstimateConfirms(t, yen(100000), yen(10000), '礼金'), null);
  });
});

describe('物件徽章「家具・家電なし」→ furnished=false（2026-10-17 第二十輪）', () => {
  const html = fixture('apartment-18316-2026-10-17.html.gz');
  const url = 'https://www.oakhouse.jp/apartment/18316';
  const l = adapter.extract(
    { url, body: html, fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
  );

  test('801 室：卡片沒寫附傢俱、徽章寫「家具・家電なし」→ 明寫不附，不是「頁面沒寫」', () => {
    const u = l?.units.find((x) => x.roomNo.known && x.roomNo.v === '801');
    assert.ok(u?.furnished.known && u.furnished.v === false, JSON.stringify(u?.furnished));
    assert.equal(u.furnished.srcText, '家具・家電なし');
  });

  test('導覽選單的「家具・家電付き」不算（只看初期費用と条件那一段）', () => {
    const u = l?.units.find((x) => x.roomNo.known && x.roomNo.v === '801');
    assert.notEqual(u?.furnished.known && u.furnished.v, true);
  });
});

describe('房間卡片的初期費用表（2026-10-17 第二十一輪）', () => {
  const ex = (id: string) => {
    const url = `https://www.oakhouse.jp/apartment/${id}`;
    return adapter.extract(
      { url, body: fixture(`apartment-${id}-2026-10-17.html.gz`), fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
    );
  };

  test('14080 106 室：火災保険料 18,000、退去時クリーニング費用 55,000（算進概算＝入居時付）、サポート24 22,000 → 其他初期費用', () => {
    const u = ex('14080')?.units.find((x) => x.roomNo.known && x.roomNo.v === '106');
    assert.ok(u?.initial.fireInsurance.known && u.initial.fireInsurance.v.jpy === 18000, JSON.stringify(u?.initial.fireInsurance));
    assert.ok(u.initial.cleaningFeeUpfront.known && u.initial.cleaningFeeUpfront.v.jpy === 55000);
    assert.match(u.initial.cleaningFeeUpfront.srcText, /^退去時クリーニング費用 55,000円（列在房間卡片的初期費用表/);
    assert.equal(u.deferred.cleaningFeeOnExit.known, false, '同一筆錢不在退去時再算一次');
    assert.ok(u.initial.otherInitial.known && u.initial.otherInitial.v.jpy === 22000);
    assert.match(u.initial.otherInitial.srcText, /サポート24 22,000円/);
  });

  test('14080 106 室「空室予定 2026/11/01 ~」→ 還沒空出（data-status=vacancy 是「空室・空室予定」合一的值）', () => {
    const u = ex('14080')?.units.find((x) => x.roomNo.known && x.roomNo.v === '106');
    assert.ok(u?.isVacant.known && u.isVacant.v === false, JSON.stringify(u?.isVacant));
    assert.match(u.isVacant.srcText, /空室予定 2026\/11\/01/);
  });

  test('17916 504 室：退去時精算手数料 5,500 → 其他初期費用（概算 629,500 也算了它）', () => {
    const u = ex('17916')?.units.find((x) => x.roomNo.known && x.roomNo.v === '504');
    assert.ok(u?.initial.otherInitial.known && u.initial.otherInitial.v.jpy === 5500, JSON.stringify(u?.initial.otherInitial));
  });

  test('費用表逐列解析與概算驗算', () => {
    const rows = oakCardRows('<table><tr><th>毎月費用</th><th>賃料</th><td>¥100,000</td></tr><tr><th>共益費・管理費</th><td>¥10,000</td></tr>'
      + '<tr><th>礼金</th><td>1ヶ月</td><th>退去時精算手数料</th><td>5,500円</td></tr><tr><th>仲介手数料</th><td>賃料の1.1ヶ月分</td></tr>'
      + '<tr><th>保証会社</th><td>加入要</td></tr><tr><th>初期費用概算</th><td>¥435,500</td></tr></table>');
    assert.deepEqual(rows.map(([l]) => l), ['賃料', '共益費・管理費', '礼金', '退去時精算手数料', '仲介手数料', '保証会社']);
    const html = '<th>初期費用概算</th><td>¥435,500</td>';
    const rent = { known: true as const, v: { jpy: 100000 } as never, basis: 'measured' as const, srcText: '' };
    const admin = { known: true as const, v: { jpy: 10000 } as never, basis: 'measured' as const, srcText: '' };
    // 2×110,000 + 100,000 + 5,500 + 110,000 = 435,500
    assert.equal(oakCardEstimateBalances(rows, html, rent, admin), true);
    assert.equal(oakCardEstimateBalances(rows, html.replace('435,500', '430,000'), rent, admin), false);
  });
});

describe('房間卡片的月費與再契約料（2026-10-17 第二十二輪）', () => {
  const ex = (id: string) => {
    const url = `https://www.oakhouse.jp/apartment/${id}`;
    return adapter.extract(
      { url, body: fixture(`apartment-${id}-2026-10-17.html.gz`), fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
    );
  };
  const room = (id: string, no: string, date = '2026-10-17') => {
    const url = `https://www.oakhouse.jp/apartment/${id}`;
    const l = date === '2026-10-17' ? ex(id) : adapter.extract(
      { url, body: fixture(`apartment-${id}-${date}.html.gz`), fetchedAt: `${date}T02:00:00Z`, sha256: 'x', status: 200, notModified: false },
      { url }, { manifest: adapter.manifest, now: new Date(`${date}T02:00:00Z`) },
    );
    return l?.units.find((x) => x.roomNo.known && x.roomNo.v === no);
  };

  test('17410 101 室備考「リブクラブ2200円(月額)　SBI少額短期保険800円(月額)」→ 其他月費 3,000', () => {
    const u = room('17410', '101');
    assert.ok(u?.monthly.otherMonthly.known && u.monthly.otherMonthly.v.jpy === 3000, JSON.stringify(u?.monthly.otherMonthly));
    assert.match(u.monthly.otherMonthly.srcText, /リブクラブ2200円\(月額\).*SBI少額短期保険800円\(月額\)/);
    assert.equal(u.monthly.utilities.known, false, '會員費與少額保險不是水電');
  });

  test('17950 202 室「あんしんサポート241100円(月額)」是商品名「…24」接 1,100 円——不可以存成月費 241,100', () => {
    const u = room('17950', '202');
    const f = u?.monthly.otherMonthly;
    assert.ok(f !== undefined && !f.known, JSON.stringify(f));
    assert.equal(f.basis, 'excluded_stated');
    assert.match(f.srcText, /あんしんサポート241100円\(月額\).*金額不採用/);
  });

  test('17870 104 室備考「水道光熱費13750円(月額)」→ 水電 13,750、月額之外另付', () => {
    const u = room('17870', '104');
    assert.ok(u?.monthly.utilities.known && u.monthly.utilities.v.jpy === 13750, JSON.stringify(u?.monthly.utilities));
    assert.equal(u.utilitiesBasis, 'excluded');
  });

  test('18144 404 室「水道・給湯料金5500円(月額)」只是水費 → 其他月費，不冒充水電（否則使用者的水電假設會被跳過）', () => {
    // 2026-08-23 的快照：這棟 10-17 已不在 sitemap，但寫法本身仍要守住
    const u = room('18144', '404', '2026-08-23');
    assert.ok(u?.monthly.otherMonthly.known && u.monthly.otherMonthly.v.jpy === 5500, JSON.stringify(u?.monthly.otherMonthly));
    assert.equal(u.monthly.utilities.known, false);
    assert.equal(u.utilitiesBasis, 'unknown');
  });

  test('共益費欄「共益費に水道光熱費を含む」→ 含水電（1188 リーガル京都西陣，京都不收錄，只驗規則）', () => {
    const r = parseRooms(fixture('apartment-1188-2026-10-17.html.gz')).find((x) => x.id === '303');
    assert.equal(r?.utilitiesIncluded, true);
  });

  test('14006 204 室費用表「再契約料 89,000円」算進概算但字面是再簽約時付 → 其他初期費用標「列了、金額不歸入」，不默默丟掉', () => {
    const u = room('14006', '204');
    const f = u?.initial.otherInitial;
    assert.ok(f !== undefined && !f.known, JSON.stringify(f));
    assert.equal(f.basis, 'excluded_stated');
    assert.match(f.srcText, /再契約料 89,000円/);
    const other = room('14006', '201');
    assert.ok(other?.initial.otherInitial.known && other.initial.otherInitial.v.jpy === 22000, '同棟沒有再契約料的房照常加總');
  });

  test('備考費用短句只切原文，金額採不採用另外決定', () => {
    const fees = oakRemarkFees('<tr><th class="ext-sub">備考</th><td colspan="3"> リブクラブ2200円(月額)　プロパンガス保証金10000円(初期)　毎月9.5万円で至高の生活 </td></tr>');
    assert.deepEqual(fees.map((f) => [f.label, f.jpy, f.when]), [['リブクラブ', 2200, '月額'], ['プロパンガス保証金', 10000, '初期']]);
  });
});

describe('「その他交通」也是車站（2026-10-17 第二十二輪驗證者指出沒收）', () => {
  test('14006：最寄り駅之外的「西武新宿線野方駅　徒歩15分」接在後面', () => {
    const url = 'https://www.oakhouse.jp/apartment/14006';
    const l = adapter.extract(
      { url, body: fixture('apartment-14006-2026-10-17.html.gz'), fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
      { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
    );
    const last = l?.building.stations.at(-1);
    assert.equal(last?.station, '野方');
    assert.equal(last?.line, '西武新宿線');
    assert.ok(last?.walkMinutes.known && last.walkMinutes.v === 15);
  });
  test('路線與站名沒有空格時從最後一個「線」切；已在最寄り駅的站不重複；切不開的不收', () => {
    const html = (x: string) => `<strong>その他交通</strong>\n<span>${x}</span>`;
    assert.deepEqual(parseOakOtherAccess(html('東京メトロ丸ノ内線東高円寺駅　徒歩20分'), []).map((s) => [s.line, s.station]), [['東京メトロ丸ノ内線', '東高円寺']]);
    assert.deepEqual(parseOakOtherAccess(html('東京モノレール 大井競馬場前駅 徒歩11分'), []).map((s) => [s.line, s.station]), [['東京モノレール', '大井競馬場前']]);
    const have = [{ line: '中央線', station: '高円寺', walkMinutes: { known: false, why: 'not_listed_on_page', basis: 'unstated', srcText: '' }, rawText: '' }] as never;
    assert.equal(parseOakOtherAccess(html('中央線 高円寺駅 徒歩13分'), have).length, 0);
    assert.equal(parseOakOtherAccess(html('つくばエクスプレス秋葉原駅 徒歩9分'), []).length, 0, '沒有「線」也沒有空格：路線與站名切不開');
  });
});

describe('房間卡片的網路費、保證會社格、戸建版型（2026-10-17 第二十三輪）', () => {
  const ex = (file: string, url: string) => adapter.extract(
    { url, body: fixture(file), fetchedAt: '2026-10-17T02:00:00Z', sha256: 'x', status: 200, notModified: false },
    { url }, { manifest: adapter.manifest, now: new Date('2026-10-17T02:00:00Z') },
  );

  test('17870 407 室「インターネット使用料：なし」→ 網路費 0（舊版寫死「來源不提供」）', () => {
    const u = ex('apartment-17870-2026-10-17.html.gz', 'https://www.oakhouse.jp/apartment/17870')?.units.find((x) => x.roomNo.known && x.roomNo.v === '407');
    assert.ok(u?.monthly.internet.known && u.monthly.internet.v.jpy === 0, JSON.stringify(u?.monthly.internet));
    assert.equal(u.monthly.internet.srcText, 'インターネット使用料：なし');
  });

  test('17410 保証会社格「加入要　初回保証料:総賃料の…%」→ 明講要付、原文留下，不再說成「金額未載明」', () => {
    const u = ex('apartment-17410-2026-10-17.html.gz', 'https://www.oakhouse.jp/apartment/17410')?.units[0];
    const f = u?.initial.guarantorInitialFee;
    assert.ok(f !== undefined && !f.known && f.basis === 'excluded_stated', JSON.stringify(f));
    assert.match(f.srcText, /^保証会社 加入要 初回保証料:総賃料の\d+%/);
    assert.doesNotMatch(f.srcText, /金額未載明/);
  });

  test('h18336 戸建版型沒有「毎月費用」也沒有共益費列：算式 2×360,000＋各列＝概算 2,433,600 → 退去時クリーニング費用算入居時付', () => {
    const u = ex('house-18336-2026-10-17.html.gz', 'https://www.oakhouse.jp/house/18336')?.units[0];
    assert.ok(u?.initial.cleaningFeeUpfront.known && u.initial.cleaningFeeUpfront.v.jpy === 215600, JSON.stringify(u?.initial.cleaningFeeUpfront));
    assert.equal(u.deferred.cleaningFeeOnExit.known, false);
    const o = u.initial.otherInitial;
    assert.ok(!o.known && o.basis === 'excluded_stated' && /再契約料 360,000円/.test(o.srcText), JSON.stringify(o));
  });
});
