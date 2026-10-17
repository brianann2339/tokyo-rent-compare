/**
 * Oak House adapter（オークハウス，全國 812 棟，share house／apartment 混合）。
 *
 * 費用揭露是所有來源裡最完整的：建物層直接列出
 * 「敷金なし・礼金なし・保証金なし・仲介手数料なし・保証人不要・保証会社不要」，
 * 房間層逐間列 契約料／賃料／共益費／月額家賃。有這一整組明確的零，
 * 才能跟 ひつじ（不公開仲介費）和 UR（另一種零）放在同一把尺上比。
 *
 * 資料在渲染後的 HTML 表格裡，每個 `<tr>` 是一間房。
 * ⚠️ 房間列上有 59 個 `data-*` 屬性，但**多數是篩選旗標不是金額**——
 * 例如 `data-deposit="1"` 出現在明寫「敷金なし」的物件上，它代表
 * 「符合敷金なし篩選」而不是 1 円。只採用能與可見文字互相印證的兩個
 * （`data-sort_price` = 月額家賃、`data-sort_contract` = 契約料）。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unknown, unparsed, conflicting, statedNoAmount, includedInOther, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, PropertyKind, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney, monthsToYen } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';

const SITE = 'https://www.oakhouse.jp';

/**
 * Oak House 有兩條產品線、兩種詳情頁 URL：
 *   `/apartment/{n}` — 一般公寓線（オークアパートメント○○）
 *   `/house/{n}`     — share house 本體（オークハウス○○）
 * 首版只取了前者，結果 480 棟只有 33 間房、且「オークハウス 荻窪」這類主力物件零筆
 * （2026-08-16 跨來源盤點時由 hituji／Tokyo Sharehouse 上的 15–16 筆「オークハウス○○」發現）。
 * 兩種頁面的徽章區、最寄り駅、房間表完全同構（WebFetch /house/5 實證），extract 不用分支。
 */
const URL_PATTERN = /<loc>(https:\/\/www\.oakhouse\.jp\/(?:apartment|house)\/\d+)<\/loc>/g;

export const manifest: SourceManifest = {
  id: 'oakhouse',
  name: 'オークハウス',
  nameZh: 'Oak House',
  homepage: 'https://www.oakhouse.jp/',
  origin: 'https://www.oakhouse.jp',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'keyMoney', 'deposit', 'agencyFee', 'contractFee',
      'guarantorInitialFee', 'layout', 'areaM2', 'roomNo', 'floor', 'isVacant', 'availableFrom',
      'furnished', 'genderRestriction', 'foreignerWelcomed',
      'guarantorPersonRequired', 'guarantorCompanyRequired', 'stations', 'structure',
      // apartment 線的新版房間卡片逐間印這兩項（「鍵交換費用 33,000円」「室内清掃費用 55,000円」）。
      // 2026-09-06 之前它們被列在 neverProvides——那句宣告會叫監控永遠不必去看那裡。
      'keyExchangeFee', 'cleaningFeeUpfront',
      // 2026-10-17 第二十一輪：卡片「初期費用」表的火災保険料、退去時精算手数料／サポート24 等（全部算進站方的初期費用概算）
      'fireInsurance', 'otherInitial', 'cleaningFeeOnExit',
      // 2026-10-17：卡片「備考」的「リブクラブ2200円(月額)　SBI少額短期保険800円(月額)」（2,000 張）、
      // 「水道光熱費13750円(月額)」（19 張）與共益費欄「共益費に水道光熱費を含む」（3 張）
      'otherMonthly', 'utilities',
      // 房間卡片「インターネット使用料：なし」（2026-10-17 第二十三輪：7 間被驗證者指出存成「來源不提供」）
      'internet',
      // 「建物概要」區塊有這兩項（977/993 有樓層、747/993 有建築年月），
      // 先前 extract 寫死 notListed('') 而沒有宣告，所以監控也不會發現它們是 0%。
      'floorsAboveGround', 'yearBuilt',
    ],
    neverProvides: [
      'depositNonRefundable',
      'renewalFee', 'renewalAdminFee', 'earlyTerminationPenalty',
      'ageLimitRaw', 'petsAllowed', 'residenceCardRequired', 'japaneseRequired',
      'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測）：Sitemap 指向 /sitemap.xml；'
      + 'Disallow 只有 `*p=`、`*?fid=`、`*/booster/` 三條。'
      + '房源詳情頁 /apartment/{數字} 未被禁止；我們走 sitemap 逐筆抓，'
      + '不碰任何帶 p= 的分頁 URL。無 Crawl-delay，自訂 3 秒間隔。'
      + '每筆房源標示出處為 Oak House 並連回原站。',
  },
};

/**
 * 把 HTML 轉成以 ｜ 分隔的可掃描文字。
 * 實體要還原：新版房間卡的面積寫成 `16.52m&sup2;`，不還原就整批解不出面積。
 */
export function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/&sup2;/g, '²')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\n]+/g, ' ');
}

/**
 * 取 `標籤｜…｜¥金額` 樣式的金額。Oak House 的 ¥ 與數字常被標籤切開。
 * `label` 當正則片段用（共益費在兩種版型的寫法不同），srcText 存實際命中的那個標籤。
 */
function labelledMoney(t: string, label: string): { raw: string; jpy: number } | null {
  // 金額只要 1 位數就收：要求 3 位數會把原站白紙黑字的「共益費 ¥0」判成「頁面沒寫」。
  // 前面有 `標籤｜` 錨點、且 [^0-9] 跨不過數字，抓到的必定是標籤後第一個數字串。
  // 標籤要有左邊界，否則「再契約料」的尾巴會命中「契約料」——
  // 2026-09-06 實測 apartment/15758 的「再契約料 258,000円」被收成 contractFee，
  // 而且 srcText 被合成成「契約料 ¥258,000」，錯誤還被自己的 srcText 蓋住。
  // text() 最後才壓縮空白，所以分隔符旁邊會留空格：實際長相是「｜ 契約料 ｜ 22,000円 ｜」
  const re = new RegExp(`(?:^|｜)\\s*(${label})\\s*｜[^0-9]{0,40}([0-9,]+)`);
  const m = re.exec(t);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const r = parseMoney(`${m[2]}円`);
  if (r.kind !== 'amount' && r.kind !== 'zero') return null;
  return { raw: `${m[1]} ¥${m[2]}`, jpy: r.kind === 'zero' ? 0 : r.jpy };
}

/** 取標籤後的原文（到下一個分隔符為止）。回 null 代表這張卡片根本沒有這個欄位。 */
function labelledRaw(t: string, label: string): string | null {
  // `<dt>礼金</dt><dd>1ヶ月</dd>` 經過 text() 會變成「｜礼金｜ ｜1ヶ月｜」——
  // 標籤與值之間隔著**兩個**分隔符（中間的換行讓 `｜+` 那一步壓不掉）。
  const m = new RegExp(`(?:^|｜)\\s*${label}\\s*(?:｜\\s*)+([^｜]{1,40})`).exec(t);
  const v = m?.[1]?.trim();
  return v === undefined || v === '' ? null : v;
}

/**
 * 房間卡片自己印的費用。新版 apartment 卡片會逐間印「礼金 1ヶ月」「敷金 1ヶ月」，
 * 那是**這一間**的條件，比建物層的「敷金なし」徽章具體。
 *
 * 「Nヶ月」要乘上賃料才是金額；賃料未知、或月數離譜（日本慣例最多 3，這裡寬鬆給到 12）
 * 就回 unparsed 而不是算一個數字出來——原站沒有主張過那個金額。
 */
function roomFee(t: string, label: string, rent: Field<Yen>): Field<Yen> | null {
  const raw = labelledRaw(t, label);
  if (raw === null) return null;
  const src = `${label} ${raw}`;
  const r = parseMoney(raw);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', src);
    case 'zero': return known(yen(0), 'measured', src);
    case 'included': return known(yen(0), 'included_stated', src);
    case 'months':
      if (!rent.known || !(r.months >= 0 && r.months <= 12)) return unparsed<Yen>(src);
      return known(yen(monthsToYen(r.months, rent.v.jpy)), 'measured', src);
    case 'negotiable': return notListed<Yen>(src);
    case 'absent': return notListed<Yen>(src);
    default: return unparsed<Yen>(src);
  }
}

/** 取第一個「有值」的；都沒有就回第一個非 null 的未知狀態（保住它的 why 與原文）。 */
function firstKnown(...fs: Array<Field<Yen> | null>): Field<Yen> {
  for (const f of fs) if (f !== null && f.known) return f;
  for (const f of fs) if (f !== null && !f.known && f.why === 'unparsed') return f;
  for (const f of fs) if (f !== null) return f;
  return notListed<Yen>('');
}

function moneyOf(t: string, label: string): Field<Yen> {
  const m = labelledMoney(t, label);
  return m === null ? notListed('') : known(yen(m.jpy), 'measured', m.raw);
}

/**
 * 建物層的「初期費用と条件」徽章。
 * 「敷金なし」這種寫法是原站明確聲明，值為 0 且有依據——
 * 跟「頁面沒提到敷金」是完全不同的狀態，不可混為一談。
 */
export type OakBadges = {
  noDeposit: boolean; noKeyMoney: boolean; noSecurityDeposit: boolean;
  noAgencyFee: boolean; noGuarantorPerson: boolean; noGuarantorCompany: boolean;
  /**
   * 站方在同一個徽章區同時印正反兩面：「敷金なし」／「敷金あり」、
   * 「保証会社不要」／「保証会社必要」。只讀反面（なし／不要）會把
   * 「原站說要付」整批當成「原站沒寫」。
   * 2026-09-06 對 data/raw/oakhouse 全部 992 個含徽章區的原始檔實測，
   * 正反兩面是互斥且窮盡的：敷金 830+162、礼金 324+668、保証金 972+20、
   * 保証人 991+1、保証会社 225+767，每組都剛好等於 992。
   * 例外是仲介手数料：只有「なし」228 筆、沒有任何「あり」寫法，
   * 所以其餘 764 筆確實是「這頁沒寫」。
   */
  hasDeposit: boolean; hasKeyMoney: boolean; hasSecurityDeposit: boolean;
  guarantorPersonRequired: boolean; guarantorCompanyRequired: boolean;
  furnished: boolean; unfurnished: boolean; foreignerOk: boolean; raw: string;
};

export function parseBadges(html: string): OakBadges {
  const t = text(html);
  const i = t.indexOf('初期費用と条件');
  const seg = i >= 0 ? t.slice(i, i + 1200) : '';
  const has = (s: string): boolean => seg.includes(s);
  return {
    noDeposit: has('敷金なし'),
    noKeyMoney: has('礼金なし'),
    noSecurityDeposit: has('保証金なし'),
    noAgencyFee: has('仲介手数料なし'),
    noGuarantorPerson: has('保証人不要'),
    noGuarantorCompany: has('保証会社不要'),
    hasDeposit: has('敷金あり'),
    hasKeyMoney: has('礼金あり'),
    hasSecurityDeposit: has('保証金必要'),
    guarantorPersonRequired: has('保証人必要'),
    guarantorCompanyRequired: has('保証会社必要'),
    furnished: has('家具・家電付き') || has('家具家電付き'),
    // 「家具・家電なし」（tooltip「家具・家電は含まれていません」）：明寫不附傢俱（2026-10-17 第二十輪，18316）
    unfurnished: has('家具・家電なし') || has('家具家電なし'),
    foreignerOk: has('外国人入居可'),
    raw: seg.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

/**
 * 房間卡片的「初期費用概算」能不能**用算式證實**卡片上的某一筆（礼金／敷金）。
 *
 * 背景：建物層徽章寫「礼金なし」、房間卡片卻寫「礼金 1ヶ月」時，舊版一律標 conflicting（誰都不採信）。
 * 2026-10-17 驗證幫手指出卡片還附有概算總額，可以拿來裁決。實測規則（站方註明「契約日が月初1日の場合」
 * 「保証会社への保証料は含まれていません」）：
 *   概算 ＝ 2 ×（賃料＋共益費）＋ 卡片上其餘每一列費用（保証会社除外）
 * 例 /apartment/17916 504 室：2×(120,000＋11,000)＋礼金 120,000＋事務 22,000＋退去時精算 5,500
 *   ＋仲介 132,000＋鍵交換 33,000＋清掃 55,000 ＝ 629,500，與概算 ¥629,500 一致；礼金若是 0 只會是 509,500。
 * 只有「卡片版本的總和剛好等於概算、徽章版本（該列當 0）不等於」才算證實；
 * 卡片上有任何一列解析不出金額、或兩邊都對不上（有我們不認得的費用列）→ 回 null，維持 conflicting。
 * 日圓整數完全相等才算——巧合相等的機率可以忽略，但近似相等一律不算。
 */
const ESTIMATE_LABELS = ['礼金', '敷金', '保証金', '事務手数料', '退去時精算手数料', '仲介手数料', '鍵交換費用', '室内清掃費用', '火災保険料'] as const;

export function oakEstimateConfirms(
  t: string, rent: Field<Yen>, admin: Field<Yen>, target: '礼金' | '敷金',
): { estimate: number } | null {
  const i = t.indexOf('毎月費用');
  const j = t.indexOf('初期費用概算');
  if (i < 0 || j < 0 || !rent.known || !admin.known) return null;
  const est = /初期費用概算[｜\s]*¥\s*([\d,]+)/.exec(t.slice(j))?.[1];
  if (est === undefined) return null;
  const estimate = Number(est.replace(/,/g, ''));
  const seg = t.slice(i, j);
  let others = 0;
  let card: number | null = null;
  for (const label of ESTIMATE_LABELS) {
    const f = roomFee(seg, label, rent);
    if (f === null) continue;
    if (!f.known) return null;
    if (label === target) card = f.v.jpy; else others += f.v.jpy;
  }
  if (card === null || card === 0) return null;
  const base = 2 * (rent.v.jpy + admin.v.jpy) + others;
  return base + card === estimate && base !== estimate ? { estimate } : null;
}

export type OakRoom = {
  id: string; roomNo: Field<string>; vacant: boolean;
  rent: Field<Yen>; adminFee: Field<Yen>; contractFee: Field<Yen>;
  /**
   * 新版 apartment 卡片會逐間印自己的敷金／礼金／仲介手数料等。
   * `null` = 這張卡片沒有這個欄位（舊版表格列一律如此），要退回建物層徽章。
   */
  cardKeyMoney: Field<Yen> | null; cardDeposit: Field<Yen> | null;
  cardAgencyFee: Field<Yen> | null; cardGuarantorFee: Field<Yen> | null;
  cardKeyExchange: Field<Yen> | null; cardCleaningUpfront: Field<Yen> | null;
  cardFireInsurance: Field<Yen> | null; cardCleaningOnExit: Field<Yen> | null; cardOtherInitial: Field<Yen> | null;
  /** 備考／費用表的月費；`null` = 卡片沒列 */
  cardOtherMonthly: Field<Yen> | null; cardUtilities: Field<Yen> | null; utilitiesIncluded: boolean;
  cardInternet: Field<Yen> | null;
  areaM2: Field<number>; layout: Field<string>; floor: Field<number>;
  kind: PropertyKind; gender: GenderRestriction;
  foreignerOk: boolean; furnished: boolean | null; rawText: string;
  availableFrom: Field<string>;
  /** 卡片的初期費用概算證實了卡片上的礼金／敷金（見 oakEstimateConfirms）。 */
  estimateConfirms: { keyMoney: number | null; deposit: number | null };
};

const ROOM_KIND: Record<string, PropertyKind> = {
  apartment: 'apartment', sharehouse: 'sharehouse', social: 'social', dormitory: 'dormitory',
};

/**
 * 房間表有兩種版型，同一站同時存在：
 *   舊版 `<tr id="數字">` 表格列
 *   新版 `<article class="p-room__caset">` 卡片
 * data-* 屬性完全同構，差在外層標籤與幾個欄位標籤（広さ：／間取り：／共益費・管理費）。
 * 只認舊版時，565 棟裡有 413 棟（978 張房間卡）整批掃不到——而且 0 間房被記成
 * 「量測到 0 間」，失敗被當成事實（2026-09-06 稽核）。
 */
const ROOM_ROW_RE =
  /<tr\s+id="\d+"[\s\S]*?<\/tr>|<article[^>]*class="[^"]*p-room__caset[^"]*"[\s\S]*?<\/article>/g;

/** 新版卡片寫「共益費・管理費」，舊版表格寫「共益費」。 */
const ADMIN_FEE_LABEL = '共益費(?:・管理費)?';

/**
 * 房號在原站是獨立元素（舊版 `<h3>`、新版 `<p class="p-room__caset__number">`），
 * 不要從剝完標籤的整列文字裡猜位置——舊版就是這樣猜錯，退回去拿 `<tr id>` 當房號。
 */
function roomNumberSlot(row: string): string {
  const m = /<div class="ext-spheader">\s*<h3>([\s\S]*?)<\/h3>/.exec(row)
    ?? /<p class="p-room__caset__number[^"]*">([\s\S]*?)<\/p>/.exec(row);
  return (m?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 房間自己標的入居時期（2026-10-17 驗證幫手指出：1,557 間全記成「頁面沒寫」，其實 96% 有寫）。
 *   新版卡片：房號後面「402 | 空室予定 2026/09/21 ~」「504 | 空室」「204 | 入居日相談」「0202 | 空室予定 202610 ~」
 *   舊版表格：房號旁 `<em><span>2026/12/17 ~</span></em>`、按鈕 `<a class="c-button ext-cart">2026/9/10 ～入居可能</a>`，
 *            或整列裡一格「空室」
 * 換算規則（model.ts：ISO8601 或「随時」）：
 *   日期 → YYYY-MM-DD；`202610`（6 位數、只到月）→ 2026-10（ISO 的月精度，不補日）；
 *   「空室」＝現在就空 → 随時；「入居日相談」不是日期 → 頁面沒給日期，原文留 srcText。
 * 過去的日期（「2024/03/01 ～入居可能」）照原文存——那就是原站寫的。
 * 只有日期、沒有「~」的（`<em>2026/11/01</em>`，47 間全在 /house/1204 ハルモニア葛西）：同一頁介紹寫
 * 「11/1新規オープン」、詢問按鈕也印同一日期，所以它就是入居起始日（2026-10-17 全量重驗後改收）。
 */
export function oakAvailableFrom(row: string, slot: string): Field<string> {
  const pad = (n: string): string => n.padStart(2, '0');
  // 舊版列有兩顆 ext-cart 按鈕：狀態（「空室」「2026/9/10 ～入居可能」）與「お問い合わせ」——要挑狀態那顆
  const cart = [...row.matchAll(/<a[^>]*class="[^"]*ext-cart[^"]*"[^>]*>([^<]*)<\/a>/g)]
    .map((x) => (x[1] ?? '').trim()).find((x) => /空室|入居可能|予定|相談/.test(x));
  // 舊版列的房號標題旁也有 `<em><span>2026/12/17 ~ </span></em>`——與新版卡片同一個結構，只是少了「空室予定」字樣
  const em = /<div class="ext-spheader">\s*<h3>[\s\S]*?<\/h3>\s*<em>([\s\S]*?)<\/em>/.exec(row)?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const status = (slot.includes('|') ? slot.slice(slot.indexOf('|') + 1) : (em !== undefined && em !== '' ? em : cart ?? ''))
    .replace(/\s+/g, ' ').trim();
  const d = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(status);
  if (d?.[1] !== undefined && d[2] !== undefined && d[3] !== undefined
    && /空室予定|入居可能|^\d{4}\/\d{1,2}\/\d{1,2}\s*[~～]?$/.test(status)) {
    return known(`${d[1]}-${pad(d[2])}-${pad(d[3])}`, 'measured', status);
  }
  const ym = /空室予定\s*(20\d{2})(0[1-9]|1[0-2])\s*[~～]/.exec(status);
  if (ym?.[1] !== undefined && ym[2] !== undefined) return known(`${ym[1]}-${ym[2]}`, 'measured', status);
  if (status === '空室' || (status === '' && /｜\s*空室\s*｜/.test(text(row)))) return known('随時', 'measured', '空室');
  return notListed(status);
}

/**
 * 房間卡片「毎月費用」到「初期費用概算」之間的費用表，逐列 `<th>標籤</th><td>值</td>`。
 * 2026-10-17 全量驗算：2,742 張可驗算的卡片裡 2,709 張「概算 ＝ 2×(賃料＋共益費)＋表內其餘每一列（保証会社除外）」
 * 完全相等——表上列的每一項都是入居時要付的錢，包括「退去時クリーニング費用」「火災保険料」「サポート24」「退去時精算手数料」。
 * 對不上的 33 張是「フリーレント」折抵或 share house 的「合計」版型。
 */
export function oakCardRows(row: string): Array<readonly [string, string]> {
  // 一般版型有「毎月費用」列頭；戸建等版型（2026-10-17 第二十三輪 h18336）沒有，表從「賃料」列開始
  const head = row.indexOf('毎月費用');
  const i = head >= 0 ? head : row.search(/<th[^>]*>\s*賃料\s*<\/th>/);
  const j = row.indexOf('初期費用概算');
  if (i < 0 || j < 0) return [];
  const clean = (h: string): string => h.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return [...row.slice(i, j).matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => [clean(m[1] ?? ''), clean(m[2] ?? '')] as const);
}

const escRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 標籤照字面比對（「契約時ルームクリーニング費用(税込)」的括號不是 regex 群組）；srcText 留原文標籤，不留跳脫字元。 */
function rowFee(t: string, label: string, rent: Field<Yen>): Field<Yen> | null {
  const f = roomFee(t, escRe(label), rent);
  return f === null ? null : { ...f, srcText: f.srcText.replace(escRe(label), label) };
}
function withNote(f: Field<Yen> | null, note: string): Field<Yen> | null {
  return f === null ? null : { ...f, srcText: `${f.srcText}${note}` };
}
/** 依序找第一個出現在卡片上的標籤。 */
function firstRow(t: string, labels: readonly string[], rent: Field<Yen>): Field<Yen> | null {
  for (const l of labels) {
    const f = rowFee(t, l, rent);
    if (f !== null) return f;
  }
  return null;
}
const KEY_LABELS = ['鍵交換費用', 'スマートロックシステム登録料(税込)', 'スマートロックシステム登録料', 'スマートロック登録料', '鍵設定料'] as const;
// 明寫契約時付的清潔費，與「室内清掃費用」同類
const CLEANING_UPFRONT_LABELS = [
  '室内清掃費用', '契約時ルームクリーニング費用(税込)', '契約時クリーニング費用(税込)', '契約時ルームクリーニング代(税込)',
  '契約時ﾙｰﾑｸﾘｰﾆﾝｸﾞ費用(税込)', '契約時ルームクリーニング費用(税別)', '契約時ルームクリーニング費用', '退去時クリーニング費用(契約時支払)',
] as const;
// 字面是退去時，但列在初期費用表、而且算進概算（81/81、55/59 張驗算相符）——驗算相符才當入居時付
const CLEANING_AMBIGUOUS_LABELS = ['退去時クリーニング費用', 'ルームクリーニング代'] as const;
/** 其他初期費用：列在初期費用表、算進概算、又不屬於任何既有欄位的一次性費用 */
const OTHER_INITIAL_RE = /^(?:退去時精算手数料|入居者サポート料|サポート24|プレミア(?:ム)?デスク.*|くらしーど24|書類作成費|除菌施工料\(契約時のみ\)|町会費(?!.*月額).*)$/;
/**
 * 已經由別的欄位處理、或不是入居時一次付的（月費、選配、活動折抵、合計）。
 * 「再契約料」「事務手数料(更新/再契約)」**不在這裡**：2026-10-17 第二十二輪 14006#204 的卡片把「再契約料 89,000円」
 * 算進初期費用概算（10 張卡片全部如此），字面卻是再簽約時付——何時付原站沒說，不猜，
 * 走 oakOtherInitial 的「性質不明」路徑（excluded_stated、原文列出、金額不歸入），不再默默丟掉。
 */
const HANDLED_RE = /^(?:賃料|共益費(?:・管理費)?|礼金|敷金|仲介手数料|事務手数料|契約料|保証会社|初回保証料|火災保険料|合計|フリーレント|町内会費\/月額|水道・給湯料金|契約期間|備考)$|（任意）$|\(任意\)$|利用時のみ/;

/** 卡片費用表能否用概算驗算（每一列都看得懂、加總剛好等於概算）。 */
export function oakCardEstimateBalances(rows: ReadonlyArray<readonly [string, string]>, row: string, rent: Field<Yen>, admin: Field<Yen>): boolean {
  const est = /初期費用概算[\s\S]{0,400}?¥\s*([\d,]+)/.exec(row)?.[1];
  // 卡片表裡根本沒有共益費列（戸建版型）時，月額就是賃料——以 0 驗算；有列但讀不出來則不驗
  const hasAdminRow = rows.some(([l]) => /^共益費/.test(l));
  if (est === undefined || !rent.known || (hasAdminRow && !admin.known)) return false;
  let sum = 2 * (rent.v.jpy + (admin.known ? admin.v.jpy : 0));
  for (const [l, v] of rows) {
    if (l === '賃料' || /^共益費/.test(l) || /保証料|保証会社|初回保証/.test(l)) continue;
    const r = parseMoney(v.replace(/^賃料の/, '').replace(/分$/, ''));
    if (r.kind === 'amount') sum += r.jpy;
    else if (r.kind === 'zero') sum += 0;
    else if (r.kind === 'months' && r.months >= 0 && r.months <= 12) sum += monthsToYen(r.months, rent.v.jpy);
    else return false;
  }
  return sum === Number(est.replace(/,/g, ''));
}

/** 其他初期費用：白名單內的列加總；有看不懂歸屬的列（鍵保証金、保証金…）就只說「原站列了，金額未取得」。 */
function oakOtherInitial(rows: ReadonlyArray<readonly [string, string]>, t: string, rent: Field<Yen>): Field<Yen> | null {
  const isCleaning = (l: string): boolean => (CLEANING_UPFRONT_LABELS as readonly string[]).includes(l)
    || (CLEANING_AMBIGUOUS_LABELS as readonly string[]).includes(l) || (KEY_LABELS as readonly string[]).includes(l);
  const others = rows.filter(([l]) => !HANDLED_RE.test(l) && !isCleaning(l));
  if (others.length === 0) return null;
  const unknownRows = others.filter(([l]) => !OTHER_INITIAL_RE.test(l));
  const src = others.map(([l, v]) => `${l} ${v}`).join('、');
  if (unknownRows.length > 0) {
    return unknown<Yen>('not_listed_on_page', 'excluded_stated', `初期費用表：${src}（${unknownRows.map(([l]) => l).join('、')} 的性質不明，金額不歸入）`);
  }
  let total = 0;
  for (const [l] of others) {
    const f = rowFee(t, l, rent);
    if (f === null || !f.known) return unknown<Yen>('not_listed_on_page', 'excluded_stated', `初期費用表：${src}（有一列解析不出金額）`);
    total += f.v.jpy;
  }
  return known(yen(total), 'measured', `初期費用表：${src}`);
}

/**
 * 房間卡片「備考」欄開頭的費用短句：「リブクラブ2200円(月額)　SBI少額短期保険800円(月額)　〔物件介紹文〕」。
 * 2026-10-17 全量盤點 8,135 張卡片：2,789 張有備考，費用短句依次數是
 * SBI少額短期保険 2,000、リブクラブ 1,996、水道代 85、水道光熱費 19、町会費 7、あんしんサポート 4、
 * 水道・給湯料金 2、町内会費月額 2、プロパンガス保証金(初期) 2。
 * ⚠️ 標籤和金額中間沒有分隔：「あんしんサポート241100円(月額)」是商品名「あんしんサポート24」接 1,100 円
 * （同一張卡片的費用表另有「サポート24」列），照字面切會變成月費 241,100 円。
 * 所以這裡只切出原文，金額要不要採用由白名單決定。
 */
export type OakRemarkFee = { readonly label: string; readonly jpy: number; readonly when: '月額' | '初期'; readonly src: string };
export function oakRemarkFees(row: string): OakRemarkFee[] {
  const b = /<th[^>]*>備考<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(row)?.[1];
  if (b === undefined) return [];
  const t = b.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const out: OakRemarkFee[] = [];
  for (const tok of t.split(/[\s\u3000]+/)) {
    const m = /^(\D+?)([\d,]+)円[(（](月額|初期)[)）]$/.exec(tok);
    if (m !== null) out.push({ label: m[1] ?? '', jpy: Number((m[2] ?? '').replace(/,/g, '')), when: m[3] === '初期' ? '初期' : '月額', src: tok });
  }
  return out;
}
// 標籤尾端不是數字、切法不會錯的月費。水道代／水道・給湯料金只是水費，不是「水電費」——
// 放進 utilities 會讓使用者自填的水電假設被跳過（cost-model 認為水電已知），所以歸其他月費。
const OTHER_MONTHLY_LABELS = ['リブクラブ', 'SBI少額短期保険', '町会費', '町内会費月額', '町内会費/月額', '水道代', '水道・給湯料金'] as const;
const UTILITIES_LABELS = ['水道光熱費'] as const;

/** 其他月費：備考的月額短句＋費用表的「町内会費/月額」「水道・給湯料金」列（同名同額只算一次）。 */
function oakOtherMonthly(remarks: readonly OakRemarkFee[], rows: ReadonlyArray<readonly [string, string]>): Field<Yen> | null {
  const items: Array<{ label: string; jpy: number | null; src: string }> = remarks
    .filter((f) => f.when === '月額' && !(UTILITIES_LABELS as readonly string[]).includes(f.label))
    .map((f) => ({ label: f.label, jpy: (OTHER_MONTHLY_LABELS as readonly string[]).includes(f.label) ? f.jpy : null, src: `備考「${f.src}」` }));
  for (const [l, v] of rows) {
    if (l !== '町内会費/月額' && l !== '水道・給湯料金') continue;
    const m = parseMoney(v);
    const jpy = m.kind === 'amount' ? m.jpy : null;
    const norm = l.replace('/月額', '月額');
    if (items.some((x) => x.label.replace('/月額', '月額') === norm && x.jpy === jpy)) continue;
    items.push({ label: l, jpy, src: `費用表「${l} ${v}」` });
  }
  if (items.length === 0) return null;
  const src = items.map((x) => x.src).join('、');
  const unclear = items.filter((x) => x.jpy === null);
  if (unclear.length > 0) {
    return statedNoAmount<Yen>(`${src}（${unclear.map((x) => x.label).join('、')} 的標籤與金額黏在一起或不是金額，無法確定切法，金額不採用）`);
  }
  return known(yen(items.reduce((a, x) => a + (x.jpy ?? 0), 0)), 'measured', src);
}

/**
 * 房間卡片「インターネット」區：「インターネット対応」＋「インターネット使用料：なし」（2026-10-17：7,805 張裡 1,797 張寫使用料なし）。
 * 只有寫了「使用料：なし」才記 0；只寫「インターネット対応」的不知道要不要錢，維持未知。
 */
export function oakCardInternet(row: string): Field<Yen> | null {
  const sec = /<h3>インターネット<\/h3>([\s\S]*?)<\/div>/.exec(row)?.[1];
  if (sec === undefined) return null;
  const m = /インターネット使用料[：:]\s*(なし|無料|0円)/.exec(sec.replace(/<[^>]+>/g, ' '));
  return m === null ? null : known(yen(0), 'measured', `インターネット使用料：${m[1] ?? ''}`);
}

/**
 * 費用表「保証会社」格：「加入要　初回保証料:総賃料の100%　更新時:20,000円/年毎」（1,866 張）、
 * 或列出好幾家保證公司各自的費率（エポス【B】…【GTN】…）。
 * 「総賃料」含哪些項目原站沒定義、多家費率要看住戶選哪家——沒有單一金額，不換算；
 * 但原文要留下，不能再說成「金額未載明」（2026-10-17 第二十三輪 18499#1402）。
 */
export function oakGuarantorCell(rows: ReadonlyArray<readonly [string, string]>): Field<Yen> | null {
  const cell = rows.find(([l]) => l === '保証会社')?.[1];
  if (cell === undefined || !/^加入要/.test(cell)) return null;
  const v = cell.length > 160 ? `${cell.slice(0, 160)}…` : cell;
  return statedNoAmount<Yen>(`保証会社 ${v}（保証料依「総賃料」等基數或所選保證公司而定，原站沒有單一金額，不換算）`);
}

export function parseRooms(html: string): OakRoom[] {
  const out: OakRoom[] = [];
  const usedKeys = new Set<string>();
  for (const m of html.matchAll(ROOM_ROW_RE)) {
    const row = m[0];
    if (!row.includes('data-sort_price')) continue;
    const t = text(row);

    const attr = (name: string): string | null => {
      const a = new RegExp(`data-${name}="([^"]*)"`).exec(row);
      return a?.[1] ?? null;
    };

    const slot = roomNumberSlot(row);
    // 新版卡片把狀態接在房號後面（「402 | 空室予定 2026/09/21 ~」），只取分隔符前那段。
    const shown = (slot.split('|')[0] ?? '').trim();
    // 原站偶爾在房號欄放房型文字（「シングル」「ツイン」）——那不是房號。
    // 抓不到就是抓不到，不可以拿站內流水號充數；原文留在 srcText 供事後查。
    const roomNo = /[0-9０-９]/.test(shown) ? known(shown, 'measured', slot) : notListed<string>(slot);

    const trId = /^<tr\s+id="(\d+)"/.exec(row)?.[1] ?? null;
    // 新版卡片沒有任何列 id，改用原站房號當鍵；同頁撞號時加序號後綴保證唯一。
    const base = trId ?? (shown === '' ? `r${out.length + 1}` : shown);
    let key = base;
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}-${n}`;
    usedKeys.add(key);

    const status = attr('status');
    const area = parseArea((/広さ[：:]?[｜\s]*([0-9.]+\s*(?:㎡|m2|m²))/.exec(t)?.[1]) ?? '');
    const layoutRaw = /間取り[：:]?[｜\s]*([0-9A-Za-z]{1,6})\s*｜/.exec(t)?.[1] ?? '';
    const floorRaw = attr('floor');
    // ⚠️ 這裡只掃「房間列」的文字，不掃整頁——整頁的「入居条件」會先命中
    // 網站導覽選單的同名標題（那裡列的是全站篩選項目，不是這間房的條件）。
    // 終止詞要涵蓋兩種版型的下一個區塊，少一個就整段抓空（新版曾 782/978 抓空）。
    const cond = /入居条件｜([\s\S]{0,260}?)(?:｜内装|｜ 空室通知|｜採光|｜こだわり条件|｜水回り|$)/
      .exec(t)?.[1] ?? '';

    const rentField = moneyOf(t, '賃料');
    const cardRows = oakCardRows(row);
    const balances = oakCardEstimateBalances(cardRows, row, rentField, moneyOf(t, ADMIN_FEE_LABEL));
    const remarks = oakRemarkFees(row);
    out.push({
      id: key,
      roomNo,
      vacant: status !== null && status !== 'novacancy',
      rent: rentField,
      cardKeyMoney: roomFee(t, '礼金', rentField),
      cardDeposit: roomFee(t, '敷金', rentField),
      cardAgencyFee: roomFee(t, '仲介手数料', rentField),
      cardGuarantorFee: roomFee(t, '初回保証料', rentField) ?? oakGuarantorCell(cardRows),
      cardKeyExchange: firstRow(t, KEY_LABELS, rentField),
      // 契約時付的清潔費優先；字面是退去時的那兩種，卡片概算驗算相符（＝算進入居時的錢）才當入居時付
      cardCleaningUpfront: firstRow(t, CLEANING_UPFRONT_LABELS, rentField)
        ?? (balances ? withNote(firstRow(t, CLEANING_AMBIGUOUS_LABELS, rentField), '（列在房間卡片的初期費用表，且算進初期費用概算＝入居時付）') : null),
      cardCleaningOnExit: balances || firstRow(t, CLEANING_UPFRONT_LABELS, rentField) !== null
        ? null : firstRow(t, ['退去時クリーニング費用'], rentField),
      cardFireInsurance: roomFee(t, '火災保険料', rentField),
      cardOtherInitial: oakOtherInitial(cardRows, t, rentField),
      cardOtherMonthly: oakOtherMonthly(remarks, cardRows),
      cardUtilities: ((u) => u === undefined ? null : known(yen(u.jpy), 'measured', `備考「${u.src}」`))(
        remarks.find((f) => f.when === '月額' && (UTILITIES_LABELS as readonly string[]).includes(f.label))),
      utilitiesIncluded: cardRows.some(([l, v]) => /^共益費/.test(l) && v.includes('共益費に水道光熱費を含む')),
      cardInternet: oakCardInternet(row),
      adminFee: moneyOf(t, ADMIN_FEE_LABEL),
      // 兩條產品線的標籤不同：share house 印「契約料」、apartment 卡片印「事務手数料」。
      // 只認前者會讓 apartment 線的這筆費用整批變成「頁面沒寫」。
      contractFee: firstKnown(moneyOf(t, '契約料'), roomFee(t, '事務手数料', rentField)),
      areaM2: area.kind === 'exact'
        ? known(area.m2, 'measured', `広さ ${area.m2}㎡`)
        : notListed(''),
      layout: layoutRaw === '' ? notListed('') : known(layoutRaw, 'measured', `間取り ${layoutRaw}`),
      // `data-floor="-1"` **不是**地下 1 階，是站方的「未設定」哨兵：
      // 2026-09-06 把 data/raw 裡全部 8 個出現 -1 的頁面拉出來看房號，
      // 分別是 0106／103／0102／102／102／103／0105／003——全在 1 樓。
      // 誤當成地下層會把 8 間 1 樓的房排到「地下」去。
      floor: floorRaw !== null && /^\d+$/.test(floorRaw)
        ? known(Number(floorRaw), 'measured', `data-floor=${floorRaw}`)
        : floorRaw === '-1' || floorRaw === null || floorRaw === ''
          ? notListed(floorRaw === '-1' ? 'data-floor=-1（站方的未設定哨兵，非地下樓層）' : '')
          : unparsed(`data-floor=${floorRaw}`),
      kind: ROOM_KIND[attr('type') ?? ''] ?? 'unknown',
      gender: /男性\/女性|男女/.test(cond) ? 'mixed'
        : /女性専用|女性のみ/.test(cond) ? 'female_only'
          : /男性専用|男性のみ/.test(cond) ? 'male_only' : 'unknown',
      foreignerOk: cond.includes('外国人入居可'),
      furnished: /家具・?家電付き/.test(cond) ? true : null,
      rawText: cond.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      availableFrom: oakAvailableFrom(row, slot),
      estimateConfirms: {
        keyMoney: oakEstimateConfirms(t, rentField, moneyOf(t, ADMIN_FEE_LABEL), '礼金')?.estimate ?? null,
        deposit: oakEstimateConfirms(t, rentField, moneyOf(t, ADMIN_FEE_LABEL), '敷金')?.estimate ?? null,
      },
    });
  }
  return out;
}

/**
 * Oak House 沒有結構化的「站名＋徒歩N分」欄位。
 * 徒歩時間只出現在自由文字的宣傳句裡（例：「駅までなんと徒歩1分30秒！！」），
 * 那是行銷文案不是欄位，從裡面抽數字等於編資料——所以步行時間一律留未知，
 * 只取麵包屑上的站名。寧可少一個欄位，也不要一個猜出來的數字。
 */
/**
 * 「最寄り駅N： ｜ ｜西武新宿線｜ / ｜上井草駅｜まで徒歩2分」——這是結構化欄位，
 * 路線、站名、步行分鐘都拿得到。
 *
 * 注意不要退回去掃麵包屑：那裡會混進導覽選單的「ターミナル駅から探す」，
 * 而且沒有步行時間。頁面正文裡的「駅までなんと徒歩1分30秒！！」是行銷文案，
 * 也不可當欄位用。
 */
const OAK_STATION_RE =
  /最寄り駅\d+：[｜\s]*([^｜]{2,24}?)[｜\s]*\/[｜\s]*([^｜]{1,14}?)駅[｜\s]*まで徒歩\s*(\d+)\s*分/g;

export function parseOakStations(t: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(OAK_STATION_RE)) {
    const line = (m[1] ?? '').trim();
    const station = (m[2] ?? '').trim();
    const walk = Number(m[3]);
    const key = `${line}|${station}`;
    if (station === '' || seen.has(key) || !Number.isFinite(walk)) continue;
    seen.add(key);
    out.push({
      line,
      station,
      walkMinutes: known(walk, 'measured', m[0].replace(/[｜\s]+/g, ' ').trim()),
      rawText: `${line} ${station}駅 徒歩${walk}分`,
    });
  }
  return out;
}

/**
 * 「アクセス」區塊的「その他交通」（2026-10-17：1,185 頁裡 71 頁有，每頁一站），
 * 例：「小田原線下北沢駅　徒歩14分」「都営新宿線 浜町駅 徒歩12分」「東京モノレール 大井競馬場前駅 徒歩11分」。
 * 路線與站名之間不一定有空格：只在「最後一個『線』或空格」能切開時才收（71/71 逐筆看過切法正確），
 * 切不開的（例如沒有「線」也沒有空格的路線名）寧可不收。與最寄り駅重複的站不再加。
 */
const OTHER_ACCESS_RE = /^(.*?(?:線|\s))\s*([^\s線]{1,14})駅\s*徒歩\s*(\d+)\s*分$/;
export function parseOakOtherAccess(html: string, have: readonly Station[]): Station[] {
  const out: Station[] = [];
  const seen = new Set(have.map((s) => s.station));
  for (const blk of html.matchAll(/<strong>その他交通<\/strong>\s*<span>([\s\S]*?)<\/span>/g)) {
    for (const part of (blk[1] ?? '').split(/<br\s*\/?>|、/)) {
      const raw = part.replace(/<[^>]+>/g, '').replace(/[\s\u3000]+/g, ' ').trim();
      const m = OTHER_ACCESS_RE.exec(raw);
      if (m === null) continue;
      const line = (m[1] ?? '').trim();
      const station = m[2] ?? '';
      const walk = Number(m[3]);
      if (seen.has(station) || !Number.isFinite(walk)) continue;
      seen.add(station);
      out.push({ line, station, walkMinutes: known(walk, 'measured', `その他交通 ${raw}`), rawText: `${line} ${station}駅 徒歩${walk}分` });
    }
  }
  return out;
}

function buildingName(html: string): string {
  const m = /<title>【オークハウス】(.+?)の(?:シェアハウス|アパート|マンション)?情報/.exec(html)
    ?? /<title>【オークハウス】(.+?)<\/title>/.exec(html);
  return (m?.[1] ?? '').trim();
}

/**
 * 住所是結構化欄位：`住所｜ ｜東京都｜杉並区｜上井草`。
 * 之前掃整頁找「都道府県＋区市」會命中区域介紹文
 * （例「南東部に位置する埼玉県の県庁所在地です。2001年5月に浦和市」），
 * 而且會讓埼玉的物件因為導覽選單提到東京而被誤判為東京。
 */
export function parseOakAddress(t: string): { prefecture: string; ward: string; town: string } | null {
  const m = /住所｜[｜\s]*([^｜]{2,6}[都道府県])｜([^｜]{1,12}[区市町村])｜?([^｜]{0,20})/.exec(t);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { prefecture: m[1].trim(), ward: m[2].trim(), town: (m[3] ?? '').trim() };
}

/**
 * 站方認可的構造寫法。
 * 這份清單不是我想出來的：2026-09-06 對 data/raw/oakhouse 993 個含「建物概要」
 * 的原始檔逐頁抽出構造欄的字面值，全部相異值只有下面這幾種——
 * RC 572、木造 129、鉄筋コンクリート造 88、鉄骨造 83、SRC 50、
 * 鉄骨鉄筋コンクリート造 22、軽量鉄骨 5、鉄骨ALC 4、軽量鉄骨造 3。
 * 「以造字結尾」再加上四個沒有造字的簡寫，剛好蓋滿 960/993。
 * 認不得的字串一律 unparsed（有文字但解不出來），不是 notListed——
 * 站方哪天換寫法，健康報告要立刻叫出來，而不是安靜地變成一片「未提供」。
 */
const OAK_STRUCT_SHORTHAND = ['RC', 'SRC', '軽量鉄骨', '鉄骨ALC'] as const;

export type OakBuildingSummary = {
  structure: Field<string>;
  floorsAboveGround: Field<number>;
  yearBuilt: Field<number>;
};

/**
 * 「建物概要」區塊：構造／地上樓層／建築年月。
 *
 * 版面實測長這樣（｜ 是標籤被抽掉留下的分隔）：
 *   `建物概要｜ ｜ RC ｜ 3階建て ｜ 建築年月:2024/04`
 * 構造欄可能整格是空的，這時「建物概要」後面第一個數字就是樓層數
 * ——先用「N階建」把樓層定位出來，再取它前面那一段當構造，
 * 才不會把「11階建」的第一個 1 誤讀成構造（實測會發生 4 次）。
 *
 * 三個欄位先前全部寫死 notListed('')／只認「造」字，2026-09-06 實測的損失是：
 * 構造 330→960、地上樓層 0→977、築年 0→747（993 個原始檔）。
 * 築年這裡用 basis 'measured'：站方寫的是**確切的建築年月**（2024/04），
 * 不是 SUUMO 那種只能推下界的「築N年」。
 */
export function parseOakBuildingSummary(t: string): OakBuildingSummary {
  const i = t.indexOf('建物概要');
  if (i < 0) {
    const why = notListed<string>('頁面沒有「建物概要」區塊');
    return { structure: why, floorsAboveGround: notListed<number>(why.srcText), yearBuilt: notListed<number>(why.srcText) };
  }
  const seg = t.slice(i, i + 220);
  // 沒抓到值時的 srcText 只說「這一欄沒填」，不要把整段 220 字倒進來。
  // 那段裡有「3階建て」「週1回」這些鄰居欄位的數字，稽核工具看到
  // 「說沒寫、原文卻有數字」就會誤報，真正的漏抓反而被淹掉。
  const absent = (field: string): string => `建物概要區塊有，但沒有${field}`;

  const fm = /([0-9]{1,2})\s*階建/.exec(seg);
  const floors = fm?.[1] === undefined
    ? notListed<number>(absent('地上樓層'))
    : known(Number(fm[1]), 'measured', `建物概要 ${fm[0]}`);

  // 構造 = 「建物概要」與樓層數之間那段文字（沒有樓層數時就取整段）
  const beforeFloor = fm === null ? seg.slice('建物概要'.length) : seg.slice('建物概要'.length, fm.index);
  const token = beforeFloor.replace(/[｜\s]+/g, ' ').trim();
  const structure: Field<string> = token === ''
    ? notListed<string>(absent('構造'))
    : (/造$/.test(token) || OAK_STRUCT_SHORTHAND.some((x) => x === token))
      ? known(token, 'measured', `建物概要 ${token}`)
      : unparsed<string>(`建物概要 ${token}`);

  const ym = /建築年月[｜\s:：]*([0-9]{4})[/年]([0-9]{1,2})?/.exec(seg);
  const yearBuilt = ym?.[1] === undefined
    ? notListed<number>(absent('建築年月'))
    : known(Number(ym[1]), 'measured', `建築年月 ${ym[1]}/${ym[2] ?? '??'}`);

  return { structure, floorsAboveGround: floors, yearBuilt };
}

function foreignerPolicy(badges: OakBadges, roomOk: boolean): ForeignerPolicy {
  const ok = badges.foreignerOk || roomOk;
  return {
    welcomed: ok
      ? known(true, 'measured', '外国人入居可')
      : notListed(badges.raw),
    residenceCardRequired: notOffered<boolean>(),
    japaneseRequired: notOffered<boolean>(),
    // 正反兩面都要讀：只讀「不要」會讓 767 棟寫著「保証会社必要」的物件
    // 變成「原站沒寫」，使用者少掉一筆真實的承租門檻（2026-09-06 實測）。
    guarantorCompanyRequired: badges.noGuarantorCompany
      ? known(false, 'measured', '保証会社不要')
      : badges.guarantorCompanyRequired
        ? known(true, 'measured', '保証会社必要')
        : notListed(badges.raw),
    guarantorPersonRequired: badges.noGuarantorPerson
      ? known(false, 'measured', '保証人不要')
      : badges.guarantorPersonRequired
        ? known(true, 'measured', '保証人必要')
        : notListed(badges.raw),
    rawText: badges.raw,
  };
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const sm = await fetcher.get(`${SITE}/sitemap-pages.xml`);
    const urls = [...sm.body.matchAll(URL_PATTERN)]
      .map((m) => m[1])
      .filter((u): u is string => u !== undefined);
    const seen = new Set<string>();
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      yield { url: u };
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const html = raw.body;
    const name = buildingName(html);
    if (name === '') return null;
    const t = text(html);
    const badges = parseBadges(html);
    const rooms = parseRooms(html);

    // 只收東京都的物件——sitemap 是全國的。
    // 用結構化住所判斷，不用「頁面有沒有出現東京都」——導覽選單每頁都有。
    const addr = parseOakAddress(t);
    if (addr === null || addr.prefecture !== '東京都') return null;
    const ward = addr.ward;

    const km = /\/(apartment|house)\/(\d+)/.exec(ref.url);
    // apartment 維持純數字 id（與既有資料連續）；house 加 h 前綴避免兩條線的 id 撞號
    const key = km?.[2] === undefined ? ref.url : (km[1] === 'house' ? `h${km[2]}` : km[2]);
    const isShareHouseLine = km?.[1] === 'house';
    const buildingId = `oakhouse:${key}`;

    const summary = parseOakBuildingSummary(t);
    const imgM = /<meta property="og:image" content="([^"]+)"/.exec(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'oakhouse',
      sourceKey: key,
      sourceUrl: ref.url,
      name,
      // 產品線是第一手事實（`/house/` 全是 share house、`/apartment/` 全是一般賃貸），
      // 房間列的 data-type 只用來把 share house 再細分成 dormitory。
      // 反過來以房間為主會出事：data-type 認不得就回 unknown，整棟跟著變 unknown
      // ——2026-08-23 實測 565 棟裡有 495 棟被這樣標成 unknown。
      kind: isShareHouseLine
        ? (rooms.some((r) => r.kind === 'dormitory') ? 'dormitory' : 'sharehouse')
        : 'apartment',
      addressRaw: `${addr.prefecture}${addr.ward}${addr.town}`,
      prefecture: addr.prefecture,
      ward,
      stations: ((main) => [...main, ...parseOakOtherAccess(html, main)])(parseOakStations(t)),
      structure: summary.structure,
      yearBuilt: summary.yearBuilt,
      // 這個來源不標建物種別；那是 SUUMO 這類入口站才有的欄位
      buildingType: notOffered<string>(),
      floorsAboveGround: summary.floorsAboveGround,
      // 0 筆不是量測值——解析失敗與「頁面真的沒列房」長得一樣，
      // 把它記成 known(0,'measured') 等於宣稱「量到 0 間」，會把故障蓋掉。
      totalUnits: rooms.length > 0
        ? known(rooms.length, 'measured', `房間列 ${rooms.length} 筆`)
        : notListed<number>(''),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    /**
     * 建物層徽章（「敷金なし」）與房間卡片（「敷金 1ヶ月」）打架時怎麼辦。
     *
     * 舊寫法一律用徽章，於是 2026-09-06 實測出 24 筆 basis='measured' 的假零——
     * 同一頁上該房卡片白紙黑字寫著「敷金 1ヶ月」，我們卻說它免敷金，
     * 使用者的初期現金被低估一整個月房租。
     * 卡片講的是「這一間」，比徽章具體，所以卡片優先；
     * 兩邊都說得很明確卻互相矛盾時，誰都不採信——標 conflicting 把兩段原文都留著。
     */
    const feeOf = (
      card: Field<Yen> | null, flag: boolean, label: string,
      /** 站方明講「有這筆費用」的徽章（如「礼金あり」）與其原文標籤。 */
      stated: { present: boolean; label: string } | null = null,
      /** 卡片的初期費用概算用算式證實了卡片數字時，概算總額；否則 null。 */
      confirmedBy: number | null = null,
    ): Field<Yen> => {
      if (card === null) {
        if (flag) return known(yen(0), 'measured', label);
        // 沒有「なし」徽章，但有「あり／必要」徽章 → 原站說了要付，只是沒寫金額。
        // 這跟「頁面沒提到」不同，混成 notListed 會讓使用者以為可能不用付。
        if (stated?.present === true) return statedNoAmount<Yen>(`${stated.label}（金額未載明）｜${badges.raw}`);
        return notListed(badges.raw);
      }
      if (flag && card.known && card.v.jpy !== 0) {
        if (confirmedBy !== null) {
          return known(card.v, 'measured',
            `${card.srcText}（房間卡片；初期費用概算 ¥${confirmedBy.toLocaleString('en-US')} 的算式與此一致，建物層徽章「${label}」與之矛盾）`);
        }
        return conflicting<Yen>(`建物層「${label}」 vs 房間卡片「${card.srcText}」`);
      }
      return card;
    };

    const units: Unit[] = rooms.filter((r) => r.vacant).map((r) => ({
      id: `${buildingId}#${r.id}`,
      buildingId,
      unitKey: r.id,
      sourceUrl: ref.url,
      roomNo: r.roomNo,
      layout: r.layout,
      areaM2: r.areaM2,
      floor: r.floor,
      monthly: {
        rent: r.rent,
        adminFee: r.adminFee,
        utilities: r.cardUtilities
          ?? (r.utilitiesIncluded ? includedInOther(`共益費 ${r.adminFee.srcText}：共益費に水道光熱費を含む`) : notOffered<Yen>()),
        // 「インターネット使用料：なし」（1,797 張）→ 0；其餘卡片沒寫，不是來源不提供
        internet: r.cardInternet ?? notListed<Yen>(''),
        otherMonthly: r.cardOtherMonthly ?? notOffered<Yen>(),
      },
      initial: {
        keyMoney: feeOf(r.cardKeyMoney, badges.noKeyMoney, '礼金なし',
          { present: badges.hasKeyMoney, label: '礼金あり' }, r.estimateConfirms.keyMoney),
        deposit: feeOf(r.cardDeposit, badges.noDeposit, '敷金なし',
          { present: badges.hasDeposit, label: '敷金あり' }, r.estimateConfirms.deposit),
        depositNonRefundable: notOffered<Yen>(),
        agencyFee: feeOf(r.cardAgencyFee, badges.noAgencyFee, '仲介手数料なし'),
        guarantorInitialFee: feeOf(r.cardGuarantorFee, badges.noGuarantorCompany, '保証会社不要',
          { present: badges.guarantorCompanyRequired, label: '保証会社必要' }),
        // 卡片「初期費用」表的「火災保険料 18,000円」（70 張，全部算進概算）；沒列的卡片維持「此來源不公開」
        fireInsurance: r.cardFireInsurance ?? notOffered<Yen>(),
        // 舊版表格列（share house 線）沒有這兩欄，但 apartment 線的卡片有——
        // 所以它不是「來源根本沒有」，而是「這一頁沒寫」。
        keyExchangeFee: r.cardKeyExchange ?? notListed<Yen>(''),
        contractFee: r.contractFee,
        cleaningFeeUpfront: r.cardCleaningUpfront ?? notListed<Yen>(''),
        // 「退去時精算手数料 5,500円」「サポート24 22,000円」等（2,000 多張卡片）：算進概算的一次性費用
        otherInitial: r.cardOtherInitial ?? notOffered<Yen>(),
      },
      deferred: {
        renewalFee: notOffered<Yen>(),
        renewalAdminFee: notOffered<Yen>(),
        cleaningFeeOnExit: r.cardCleaningOnExit ?? notOffered<Yen>(),
        earlyTerminationPenalty: notOffered<Yen>(),
      },
      // 「共益費に水道光熱費を含む」＝含；「水道光熱費13750円(月額)」＝月額之外另付定額
      utilitiesBasis: r.utilitiesIncluded ? 'included' : r.cardUtilities !== null ? 'excluded' : 'unknown',
      // 房間卡片寫「家具・家電付き」優先；否則看物件徽章（「付き」→ true、「なし」→ false）
      furnished: r.furnished === true || badges.furnished
        ? known(true, 'measured', '家具・家電付き')
        : badges.unfurnished
          ? known(false, 'measured', '家具・家電なし')
          : notListed(r.rawText),
      availableFrom: r.availableFrom,
      // data-status=vacancy 是站方「空室・空室予定」合一的篩選值，分不出現在空不空——看卡片自己的狀態：
      // 「空室」＝現在空；「空室予定 2026/11/01 ~」與只寫日期的＝還沒空出（同ひつじ scheduled、TSH 空室予定）；
      // 「入居日相談」判不出來（2026-10-17 第二十一輪）
      isVacant: r.availableFrom.known
        ? known(r.availableFrom.v === '随時', 'measured', r.availableFrom.v === '随時' ? '空室' : r.availableFrom.srcText)
        : unknown<boolean>('not_listed_on_page', 'unstated', `data-status=vacancy（站方「空室・空室予定」合一）；狀態「${r.availableFrom.srcText}」`),
      contractType: 'unknown',
      contractMonths: notListed(''),
      minStayMonths: notListed(''),
      genderRestriction: r.gender,
      ageLimitRaw: notOffered<string>(),
      petsAllowed: notOffered<boolean>(),
      foreigner: foreignerPolicy(badges, r.foreignerOk),
      notes: [],
    }));

    return { building, units };
  },
};

export default adapter;
