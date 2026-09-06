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
  known, notListed, notOffered, unparsed, conflicting, statedNoAmount, yen, type Field, type Yen,
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
      'guarantorInitialFee', 'layout', 'areaM2', 'roomNo', 'floor', 'isVacant',
      'furnished', 'genderRestriction', 'foreignerWelcomed',
      'guarantorPersonRequired', 'guarantorCompanyRequired', 'stations', 'structure',
      // apartment 線的新版房間卡片逐間印這兩項（「鍵交換費用 33,000円」「室内清掃費用 55,000円」）。
      // 2026-09-06 之前它們被列在 neverProvides——那句宣告會叫監控永遠不必去看那裡。
      'keyExchangeFee', 'cleaningFeeUpfront',
      // 「建物概要」區塊有這兩項（977/993 有樓層、747/993 有建築年月），
      // 先前 extract 寫死 notListed('') 而沒有宣告，所以監控也不會發現它們是 0%。
      'floorsAboveGround', 'yearBuilt',
    ],
    neverProvides: [
      'utilities', 'internet', 'otherMonthly', 'depositNonRefundable',
      'fireInsurance', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
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
  furnished: boolean; foreignerOk: boolean; raw: string;
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
    foreignerOk: has('外国人入居可'),
    raw: seg.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
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
  areaM2: Field<number>; layout: Field<string>; floor: Field<number>;
  kind: PropertyKind; gender: GenderRestriction;
  foreignerOk: boolean; furnished: boolean | null; rawText: string;
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
    out.push({
      id: key,
      roomNo,
      vacant: status !== null && status !== 'novacancy',
      rent: rentField,
      cardKeyMoney: roomFee(t, '礼金', rentField),
      cardDeposit: roomFee(t, '敷金', rentField),
      cardAgencyFee: roomFee(t, '仲介手数料', rentField),
      cardGuarantorFee: roomFee(t, '初回保証料', rentField),
      cardKeyExchange: roomFee(t, '鍵交換費用', rentField),
      cardCleaningUpfront: roomFee(t, '室内清掃費用', rentField),
      adminFee: moneyOf(t, ADMIN_FEE_LABEL),
      // 兩條產品線的標籤不同：share house 印「契約料」、apartment 卡片印「事務手数料」。
      // 只認前者會讓 apartment 線的這筆費用整批變成「頁面沒寫」。
      contractFee: firstKnown(moneyOf(t, '契約料'), roomFee(t, '事務手数料', rentField)),
      areaM2: area.kind === 'exact'
        ? known(area.m2, 'measured', `広さ ${area.m2}㎡`)
        : notListed(''),
      layout: layoutRaw === '' ? notListed('') : known(layoutRaw, 'measured', `間取り ${layoutRaw}`),
      floor: floorRaw !== null && /^\d+$/.test(floorRaw)
        ? known(Number(floorRaw), 'measured', `data-floor=${floorRaw}`)
        : notListed(floorRaw ?? ''),
      kind: ROOM_KIND[attr('type') ?? ''] ?? 'unknown',
      gender: /男性\/女性|男女/.test(cond) ? 'mixed'
        : /女性専用|女性のみ/.test(cond) ? 'female_only'
          : /男性専用|男性のみ/.test(cond) ? 'male_only' : 'unknown',
      foreignerOk: cond.includes('外国人入居可'),
      furnished: /家具・?家電付き/.test(cond) ? true : null,
      rawText: cond.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
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
  const flat = seg.replace(/[｜\s]+/g, ' ').trim();

  const fm = /([0-9]{1,2})\s*階建/.exec(seg);
  const floors = fm?.[1] === undefined
    ? notListed<number>(flat)
    : known(Number(fm[1]), 'measured', `建物概要 ${fm[0]}`);

  // 構造 = 「建物概要」與樓層數之間那段文字（沒有樓層數時就取整段）
  const beforeFloor = fm === null ? seg.slice('建物概要'.length) : seg.slice('建物概要'.length, fm.index);
  const token = beforeFloor.replace(/[｜\s]+/g, ' ').trim();
  const structure: Field<string> = token === ''
    ? notListed<string>(flat)
    : (/造$/.test(token) || OAK_STRUCT_SHORTHAND.some((x) => x === token))
      ? known(token, 'measured', `建物概要 ${token}`)
      : unparsed<string>(`建物概要 ${token}`);

  const ym = /建築年月[｜\s:：]*([0-9]{4})[/年]([0-9]{1,2})?/.exec(seg);
  const yearBuilt = ym?.[1] === undefined
    ? notListed<number>(flat)
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
      stations: parseOakStations(t),
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
    ): Field<Yen> => {
      if (card === null) {
        if (flag) return known(yen(0), 'measured', label);
        // 沒有「なし」徽章，但有「あり／必要」徽章 → 原站說了要付，只是沒寫金額。
        // 這跟「頁面沒提到」不同，混成 notListed 會讓使用者以為可能不用付。
        if (stated?.present === true) return statedNoAmount<Yen>(`${stated.label}（金額未載明）｜${badges.raw}`);
        return notListed(badges.raw);
      }
      if (flag && card.known && card.v.jpy !== 0) {
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
        utilities: notOffered<Yen>(),
        internet: notOffered<Yen>(),
        otherMonthly: notOffered<Yen>(),
      },
      initial: {
        keyMoney: feeOf(r.cardKeyMoney, badges.noKeyMoney, '礼金なし',
          { present: badges.hasKeyMoney, label: '礼金あり' }),
        deposit: feeOf(r.cardDeposit, badges.noDeposit, '敷金なし',
          { present: badges.hasDeposit, label: '敷金あり' }),
        depositNonRefundable: notOffered<Yen>(),
        agencyFee: feeOf(r.cardAgencyFee, badges.noAgencyFee, '仲介手数料なし'),
        guarantorInitialFee: feeOf(r.cardGuarantorFee, badges.noGuarantorCompany, '保証会社不要',
          { present: badges.guarantorCompanyRequired, label: '保証会社必要' }),
        fireInsurance: notOffered<Yen>(),
        // 舊版表格列（share house 線）沒有這兩欄，但 apartment 線的卡片有——
        // 所以它不是「來源根本沒有」，而是「這一頁沒寫」。
        keyExchangeFee: r.cardKeyExchange ?? notListed<Yen>(''),
        contractFee: r.contractFee,
        cleaningFeeUpfront: r.cardCleaningUpfront ?? notListed<Yen>(''),
        otherInitial: notOffered<Yen>(),
      },
      deferred: {
        renewalFee: notOffered<Yen>(),
        renewalAdminFee: notOffered<Yen>(),
        cleaningFeeOnExit: notOffered<Yen>(),
        earlyTerminationPenalty: notOffered<Yen>(),
      },
      utilitiesBasis: 'unknown',
      furnished: r.furnished === true || badges.furnished
        ? known(true, 'measured', '家具・家電付き')
        : notListed(r.rawText),
      availableFrom: notListed(''),
      isVacant: known(true, 'measured', `data-status=${r.vacant ? 'vacancy' : 'novacancy'}`),
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
