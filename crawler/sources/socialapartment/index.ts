/**
 * Social Apartment（ソーシャルアパートメント／株式会社グローバルエージェンツ）adapter。
 *
 * 「シェアハウスと一人暮らしのいいとこ取り」型的大型共居，全國 49 棟、東京 31 棟
 * （2026-08-16 對 /builds 實測）。kind 用 'social' 而非 'sharehouse'：
 * 每戶是有獨立衛浴的專有部，只共用大型 lounge，費用結構跟一般 share house 不同。
 *
 * ⚠️ 本來源最重要的一件事：**物件頁完全不刊登初期費用金額**。
 * 站方只在 FAQ（/faq）用定性文字說明「基本的には保証金(敷金)、礼金、初回保証料がかかります。
 * 一部のアパートメントでは仲介手数料が発生する場合があります。」——那是**全站通則**，
 * 不是任何一筆物件的金額。從它推出任何數字就是虛構，所以敷金／礼金／仲介手数料／
 * 保証料一律 notOffered 並宣告在 capabilities.neverProvides，健康檢查才不會對
 * 永遠 0% 的欄位發假警報。
 *
 * 2026-10-17 更正（fresh-context 驗證幫手對原始頁面抓到）：「完全不刊登」說得太滿。
 * 32 頁裡有 18 頁的キャンペーン欄寫著「初期費用でお支払いいただく礼金（賃料1か月分）が無料になります」
 * ＋「※ 内覧当日お申込みの方のみの限定キャンペーンです」，2 頁的備考寫「仲介手数料：賃料1ヶ月分(+税)」。
 * 這些頁面**明講有這筆費用**，存成 notOffered（來源不提供）是錯的——使用者會以為可能不用付。
 * 但金額仍然不能算：同一頁並列 2年／1年／短期三種方案、賃料各差 4,000〜8,000 円，
 * 房間卡片的賃料沒標是哪個方案，「賃料1か月分」乘哪一個是猜。所以存 statedNoAmount
 * （明講有、沒給金額），原文放 srcText；沒提到的頁維持 notOffered。
 * 房間卡片的 `room-list-component__room-notes`（「※ 家具付き居室」「※ 女性専用居室」）是逐房標示，
 * 同日起讀進 furnished／genderRestriction。
 *
 * 同樣的判斷也適用於外國人條件與最低居住期間：FAQ 有
 * 「外国籍の方の場合は、パスポート、日本のビザもしくは在留カードが必要です。
 *   保証会社の利用は必須です。」與「基本的に皆様に6ヶ月以上のご入居をお願いしております。」，
 * 但那是站方的一般規定，不是這一棟、這一間房的屬性。把它寫進每一筆 unit 會讓
 * 「我們從未在物件頁讀到過的東西」看起來像是逐筆查證過的欄位——所以一律 notOffered，
 * 只在本註解留下查證日期與原文，不進資料。
 *
 * 清單來源是 /builds：sitemap.xml 回 HTTP 404（全站沒有 sitemap），
 * 而 /builds 一頁列完全國 49 棟、無分頁參數。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, statedNoAmount, unknown, unparsed, yen, type Yen, type Field,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy,
} from '../../../packages/schema/src/model.ts';
import { parseMoney, parseMoneyRange } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseYearBuilt } from '../../../packages/jp-parse/src/contract.ts';

const SITE = 'https://www.social-apartment.com';

export const manifest: SourceManifest = {
  id: 'socialapartment',
  name: 'ソーシャルアパートメント',
  nameZh: 'Social Apartment',
  homepage: 'https://www.social-apartment.com/',
  origin: 'https://www.social-apartment.com',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'layout', 'areaM2', 'roomNo', 'isVacant', 'availableFrom',
      'stations', 'structure', 'yearBuilt', 'floorsAboveGround', 'totalUnits',
      // 只有部分頁面寫、且多半只寫「有這筆」不寫金額（statedNoAmount），見檔頭 2026-10-17 更正
      'keyMoney', 'agencyFee', 'utilities', 'furnished', 'genderRestriction',
    ],
    // 全站物件頁都沒有這些欄位——不是解析故障，是來源的穩定屬性
    neverProvides: [
      'deposit', 'depositNonRefundable',
      'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee', 'contractFee',
      'cleaningFeeUpfront', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit',
      'internet', 'otherMonthly',
      'floor', 'minStayMonths', 'ageLimitRaw', 'petsAllowed',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
      'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      '/robots.txt 回 HTTP 200，但全文只有一行註解：'
      + '「# See https://www.robotstxt.org/robotstxt.html for documentation on how to use the robots.txt file」，'
      + '無 User-agent、無 Disallow、無 Crawl-delay。自訂 3 秒間隔。'
      + '/sitemap.xml 回 HTTP 404（全站無 sitemap），改以 /builds 列表頁列舉。'
      + '站內找不到利用規約頁（只有 /privacy），頁尾僅有 '
      + '「Copyright (C) Global Agents All Rights Reserved.」。'
      + '⚠️ 找不到條款只能證明「站內無公開連結」，不能證明其不存在或無主張。'
      + '每筆房源標示出處並連回原站。',
  },
};

/** 把 HTML 轉成以 ｜ 分隔的可掃描文字。 */
export function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/[ \t\r\n]+/g, ' ');
}

/**
 * 物件概要表格的一列。
 *
 * ⚠️ 只能在「物件概要」區段內使用：所在地與アクセス在頁面上半部的
 * 「アクセス・周辺環境」區也各出現一次，而那一份的站名被 `<span>` 切成
 * 「「｜葛西」｜駅」，解析不出來。物件概要那一份是完整文字。
 */
export function saRow(seg: string, label: string): string | null {
  const m = new RegExp(`${label}｜[\\s｜]*([^｜]{1,80}?)\\s*｜`).exec(seg);
  const v = m?.[1]?.trim();
  return v === undefined || v === '' ? null : v;
}

/** 物件概要區段。找不到就回 null——寧可整筆不收，也不要用半頁文字硬湊。 */
export function saOverview(t: string): string | null {
  const i = t.indexOf('物件概要');
  return i < 0 ? null : t.slice(i, i + 2000);
}

/**
 * `アクセス｜ ｜ ｜ 東京メトロ東西線 「葛西」駅 徒歩15分 ｜ ｜ JR山手線 「目黒」駅 徒歩15分`
 *
 * 路線可能含「・」（`JR山手線・東京メトロ副都心線`）。要求前面有 ｜ 邊界，
 * 否則非貪婪的路線群組會從句子中間開始匹配、把路線切成半截。
 */
const SA_STATION_RE = /｜\s*([^｜「]{2,40}?)\s*「([^」｜]{1,14})」\s*駅\s*徒歩\s*(\d+)\s*分/g;

export function parseSaStations(seg: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of seg.matchAll(SA_STATION_RE)) {
    const line = (m[1] ?? '').trim();
    const station = (m[2] ?? '').trim();
    const walk = Number(m[3]);
    const key = `${line}|${station}`;
    if (line === '' || station === '' || seen.has(key) || !Number.isFinite(walk)) continue;
    seen.add(key);
    out.push({
      line,
      station,
      walkMinutes: known(walk, 'measured', `${line} 「${station}」駅 徒歩${walk}分`),
      rawText: `${line} 「${station}」駅 徒歩${walk}分`,
    });
  }
  return out;
}

export type SaRoom = {
  readonly number: string;
  readonly rentRaw: string;
  readonly adminRaw: string;
  readonly layoutRaw: string;
  readonly areaRaw: string;
  readonly availabilityRaw: string;
  /** 卡片自己的註記（`※ 家具付き居室`、`※ 女性専用居室、家具付き居室`）。沒有就是空字串。 */
  readonly notesRaw: string;
};

/**
 * 空室情報區的房間卡。滿室時整區只有
 * 「現在満室です。詳細はお問い合わせください。」一句、沒有任何房間卡 → 回空陣列。
 *
 * 走 class 名而不是扁平文字：`data-test-selector`、`modal#open` 這類屬性值
 * 在扁平化後會混進文字，用 class 切塊就完全碰不到它們。
 */
// `(?:\s[^"]*)?` 而不是 `[^"]*`：後者會連容器 `room-list-component__rooms` 一起吃掉。
const SA_ROOM_RE = /<div class="room-list-component__room(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/a>/g;

function inner(block: string, cls: string): string {
  const m = new RegExp(`room-list-component__room-${cls}">\\s*([^<]*?)\\s*<`).exec(block);
  return (m?.[1] ?? '').trim();
}

export function parseSaRooms(html: string): SaRoom[] {
  const out: SaRoom[] = [];
  for (const m of html.matchAll(SA_ROOM_RE)) {
    const block = m[1];
    if (block === undefined) continue;
    const number = inner(block, 'unit-number');
    if (number === '') continue;
    const details = [...block.matchAll(/room-list-component__room-detail">\s*([^<]*?)\s*</g)]
      .map((d) => (d[1] ?? '').trim())
      .filter((d) => d !== '');
    out.push({
      number,
      rentRaw: inner(block, 'amount'),
      adminRaw: inner(block, 'management-cost'),
      // details 依序是 間取り、面積；用「含 ㎡ 的那一項是面積」判定而不是靠位置，
      // 位置一改版就會把面積填進間取り欄還不報錯。
      layoutRaw: details.find((d) => !/[㎡m²]/.test(d)) ?? '',
      areaRaw: details.find((d) => /[㎡m²]/.test(d)) ?? '',
      availabilityRaw: inner(block, 'availability-date'),
      notesRaw: inner(block, 'notes'),
    });
  }
  return out;
}

/**
 * 物件頁上「明講有這筆費用」的地方：キャンペーン欄的礼金、物件概要的備考。
 *
 * - 礼金：只看「現在実施中のキャンペーン」到「空室情報」之間——頁尾「この物件を見ている人に
 *   人気の物件」是**別棟**的卡片，那裡的礼金字樣不屬於這一棟。
 * - 仲介手数料／電気代：只看備考列。備考可能很長（超過 saRow 的 80 字上限），所以單獨取。
 * - 寫法認得出是「有、但金額依方案而定」→ statedNoAmount（只有「礼金無料！」banner、沒有描述礼金本身的句子 → 維持 notOffered）；提到了但寫法沒見過 → notListed 帶原文，
 *   讓 audit:why 掃到交給人看；完全沒提到 → notOffered（維持原判）。
 */
export function parseSaFeeMentions(t: string, seg: string): {
  keyMoney: Field<Yen>; agencyFee: Field<Yen>; utilities: Field<Yen>; remarks: string;
} {
  const start = t.indexOf('現在実施中のキャンペーン');
  const end = start < 0 ? -1 : t.indexOf('空室情報', start);
  const camp = start < 0 || end < 0 ? '' : t.slice(start, end);
  const pieces = (s: string, re: RegExp): string[] =>
    [...new Set(s.split('｜').map((x) => x.trim()).filter((x) => re.test(x)))];
  const reikin = pieces(camp, /礼金/);
  const conditions = pieces(camp, /限定|当日/).filter((x) => !reikin.includes(x));
  // 只有「礼金無料！」字樣的 banner 不算明講：要有把礼金當成一筆應付費用描述的句子
  // （「初期費用でお支払いいただく礼金（賃料1か月分）」）。從「無料」反推「平常要付」是推論，不是原文。
  const keyMoney = !reikin.some((x) => /お支払いいただく礼金|礼金[（(]賃料/.test(x))
    ? notOffered<Yen>()
    : statedNoAmount<Yen>(`キャンペーン欄：${[...reikin, ...conditions].join(' / ')}`);

  const remarks = /備考｜[\s｜]*([^｜]{1,400}?)\s*｜/.exec(seg)?.[1]?.trim() ?? '';
  const parts = remarks.split(/\s*\/\s*/).filter((x) => x !== '');
  const agencyRaw = parts.find((x) => /仲介手数料/.test(x));
  const agencyFee = agencyRaw === undefined
    ? notOffered<Yen>()
    : /仲介手数料[：:]\s*賃料[\d.]+\s*[ヶか]月分/.test(agencyRaw)
      ? statedNoAmount<Yen>(`備考 ${agencyRaw}`)
      : notListed<Yen>(`備考 ${agencyRaw}`);
  const utilRaw = parts.find((x) => /電気代|光熱費|水道/.test(x));
  // 「給湯設備使用料3,960円＋実費」：固定部分有金額、實費部分沒有 → 總額未知，不可只取 3,960
  const utilities = utilRaw === undefined ? notOffered<Yen>() : statedNoAmount<Yen>(`備考 ${utilRaw}`);
  return { keyMoney, agencyFee, utilities, remarks };
}

/** 全站沒有任何外國人條件欄位（FAQ 的通則不是物件屬性，見檔頭說明）。 */
const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notOffered<boolean>(),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

/**
 * `鉄筋コンクリート造陸屋根5階建` / `RC造地下1階地上4階建　(陸屋根)` /
 * `鉄筋コンクリート地上4階` / `RC造6階`
 *
 * 最後那種（沒有「地上」也沒有「階建」，只有「N階」）先前解不出來，
 * 於是 structure 欄白紙黑字寫著 6 階、floorsAboveGround 卻記成「這頁沒寫」。
 * 補上時要先把「地下N階」拿掉再找，否則只寫地下層的物件會被當成地上層。
 */
export function parseSaFloors(structure: string): number | null {
  const ok = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 && v <= 60 ? v : null;
  };
  const above = ok(/地上\s*(\d+)\s*階/.exec(structure)?.[1]);
  if (above !== null) return above;
  // 「地下1階」不能拿來當地上樓層，先剝掉再找
  const noBasement = structure.replace(/地下\s*\d+\s*階/g, '');
  const built = ok(/(\d+)\s*階建/.exec(noBasement)?.[1]);
  if (built !== null) return built;
  return ok(/(\d+)\s*階/.exec(noBasement)?.[1]);
}

/**
 * 空室情報欄的「availability-date」：「即入居可能」或「10月下旬入居可能」（2026-10-17 全站 24 間：即入居可能 14、N月X旬 10）。
 * 欄位定義是 ISO 日期或「随時」——「10月下旬」不是日期，換成月初會把入住日提早，所以只留原文、值未知。
 * isVacant 與其他來源同一語意（ひつじ scheduled、TSH／Oak 空室予定）：還沒到可入住日＝現在不是空房。
 */
export function saAvailability(raw: string, listed: string): { availableFrom: Field<string>; isVacant: Field<boolean> } {
  if (raw === '') return { availableFrom: notListed(''), isVacant: known(true, 'measured', listed) };
  if (/^即入居可(?:能)?$/.test(raw)) return { availableFrom: known('随時', 'measured', raw), isVacant: known(true, 'measured', `${listed}：${raw}`) };
  if (/^[0-9０-９]{1,2}月(?:上旬|中旬|下旬|初旬|末)?(?:以降)?入居可(?:能)?$/.test(raw)) {
    return {
      availableFrom: unknown<string>('not_listed_on_page', 'unstated', `${raw}（只到旬，沒有日期）`),
      isVacant: known(false, 'measured', `${listed}：${raw}`),
    };
  }
  return { availableFrom: unparsed(raw), isVacant: unknown<boolean>('not_listed_on_page', 'unstated', `${listed}：${raw}`) };
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    // /sitemap.xml 是 404，全站唯一的完整清單是 /builds（無分頁參數，一頁列完 49 棟）
    const list = await fetcher.get(`${SITE}/builds`);
    // 只收東京：URL 的都道府県段就是 `tokyo`。市区段有大小寫混用
    // （實際存在 `/builds/osaka/Suita-shi/...`），所以不限定大小寫。
    const paths = new Set(
      [...list.body.matchAll(/href="(\/builds\/tokyo\/[A-Za-z0-9-]+\/view\/\d+)"/g)]
        .map((m) => m[1])
        .filter((p): p is string => p !== undefined),
    );
    if (paths.size === 0) {
      throw new Error('/builds 解析不到任何東京物件連結——列表頁版型可能已改版');
    }
    for (const p of paths) yield { url: `${SITE}${p}` };
  },

  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null {
    const html = raw.body;
    const t = text(html);
    const seg = saOverview(t);
    if (seg === null) return null;

    const name = saRow(seg, '物件名');
    const addr = saRow(seg, '所在地');
    if (name === null || addr === null) return null;

    // 只收東京都。/builds 已經先過濾過一次，這裡用物件自己的所在地再確認一次，
    // 因為 URL 的都道府県段是站方填的、不是我們能保證的事實。
    const wardM = /^東京都([^\s]{1,6}?[区市])/.exec(addr);
    if (wardM?.[1] === undefined) return null;

    const idM = /\/view\/(\d+)/.exec(ref.url);
    const key = idM?.[1] ?? ref.url;
    const buildingId = `socialapartment:${key}`;

    const structure = saRow(seg, '構造');
    const yearRaw = saRow(seg, '築年');
    const yearBuilt = yearRaw === null ? null : parseYearBuilt(yearRaw, ctx.now);
    const households = saRow(seg, '世帯数');
    const householdsN = households === null ? null : Number(/(\d+)\s*世帯/.exec(households)?.[1] ?? '');
    const floors = structure === null ? null : parseSaFloors(structure);
    const imgM = /<meta property="og:image" content="([^"]+)"/.exec(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'socialapartment',
      sourceKey: key,
      sourceUrl: ref.url,
      name,
      kind: 'social',
      addressRaw: addr,
      prefecture: '東京都',
      ward: wardM[1],
      stations: parseSaStations(seg),
      structure: structure === null
        ? notListed('')
        : known(structure, 'measured', `構造 ${structure}`),
      yearBuilt: yearBuilt === null
        ? notListed(yearRaw ?? '')
        : known(yearBuilt, 'measured', `築年 ${yearRaw ?? ''}`),
      // 這個來源不標建物種別；那是 SUUMO 這類入口站才有的欄位
      buildingType: notOffered<string>(),
      floorsAboveGround: floors === null
        ? notListed(structure ?? '')
        : known(floors, 'measured', `構造 ${structure ?? ''}`),
      totalUnits: householdsN !== null && Number.isFinite(householdsN)
        ? known(householdsN, 'measured', `世帯数 ${households ?? ''}`)
        : notListed(households ?? ''),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    // 建物層的共同備註。這些是原文照抄，不做任何換算——
    // 「賃料1か月」是月數不是金額（且是哪一個方案的月數取決於住戶選哪個 plan），
    // 「礼金無料」是有條件的期間限定活動，兩者都不可變成 unit 的金額欄位。
    const rentRangeRaw = saRow(seg, '賃料');
    const range = rentRangeRaw === null ? null : parseMoneyRange(rentRangeRaw);
    const planRaw = /契約期間未満の退去で[^｜]{0,80}/.exec(t)?.[0]?.trim() ?? '';
    // 「2年プラン、1年プラン、短期プラン」——入居プラン列的值。不能用 saRow()：
    // 該列第一個子節點是 `tooltip#toggle"` 這種屬性殘字，會被當成值抓走。
    const plansRaw = /｜\s*((?:\d+年プラン|短期プラン)(?:、(?:\d+年プラン|短期プラン))+)\s*｜/.exec(seg)?.[1] ?? '';
    const twoPersonRaw = saRow(seg, '2人入居');
    const dealTypeRaw = saRow(seg, '取引形態');
    const campaign = /礼金無料/.test(t);
    const fees = parseSaFeeMentions(t, seg);

    const buildingNotes: string[] = [];
    if (rentRangeRaw !== null) {
      buildingNotes.push(range === null
        ? `同棟賃料：${rentRangeRaw}`
        : `同棟賃料 ${range.minJpy.toLocaleString('en-US')}〜${range.maxJpy.toLocaleString('en-US')}円（原文：${rentRangeRaw}）`);
    }
    if (planRaw !== '') buildingNotes.push(`短期解約違約金（原文，依方案而異，非金額）：${planRaw}`);
    if (twoPersonRaw !== null) buildingNotes.push(`2人入居：${twoPersonRaw}`);
    if (dealTypeRaw !== null) buildingNotes.push(`取引形態：${dealTypeRaw}`);
    if (fees.remarks !== '') buildingNotes.push(`備考：${fees.remarks}`);
    if (campaign) {
      buildingNotes.push('原站標示「礼金無料」為期間限定且需內覧当日申込的活動條件，非本物件常態礼金金額——本站不據此填 0');
    }

    const rooms = parseSaRooms(html);

    const units: Unit[] = rooms.map((r) => {
      const rent = parseMoney(r.rentRaw);
      const admin = parseMoney(r.adminRaw);
      const area = parseArea(r.areaRaw);

      return {
        id: `${buildingId}#${r.number}`,
        buildingId,
        unitKey: r.number,
        sourceUrl: ref.url,
        roomNo: known(r.number, 'measured', `部屋番号 ${r.number}`),
        layout: r.layoutRaw === ''
          ? notListed('')
          : known(r.layoutRaw, 'measured', `間取り ${r.layoutRaw}`),
        areaM2: area.kind === 'exact'
          ? known(area.m2, 'measured', `面積 ${r.areaRaw}`)
          : notListed(r.areaRaw),
        // 房號（413）看得出樓層，但站方沒有樓層欄位——從房號推是猜，不做。
        floor: notOffered<number>(),
        monthly: {
          rent: rent.kind === 'amount'
            ? known(yen(rent.jpy), 'measured', `賃料 ${r.rentRaw}`)
            : notListed(r.rentRaw),
          adminFee: admin.kind === 'amount'
            ? known(yen(admin.jpy), 'measured', r.adminRaw)
            : notListed(r.adminRaw),
          utilities: fees.utilities,
          internet: notOffered<Yen>(),
          otherMonthly: notOffered<Yen>(),
        },
        // 初期費用的金額整組不刊登（見檔頭）。FAQ 的定性描述不可換算成金額；
        // 物件頁明講「有這筆」的礼金／仲介手数料記 statedNoAmount。
        initial: {
          keyMoney: fees.keyMoney,
          deposit: notOffered<Yen>(),
          depositNonRefundable: notOffered<Yen>(),
          agencyFee: fees.agencyFee,
          guarantorInitialFee: notOffered<Yen>(),
          fireInsurance: notOffered<Yen>(),
          keyExchangeFee: notOffered<Yen>(),
          contractFee: notOffered<Yen>(),
          cleaningFeeUpfront: notOffered<Yen>(),
          otherInitial: notOffered<Yen>(),
        },
        deferred: {
          renewalFee: notOffered<Yen>(),
          renewalAdminFee: notOffered<Yen>(),
          cleaningFeeOnExit: notOffered<Yen>(),
          // 違約金是「賃料1か月／2か月」且取決於住戶選的方案 → 是月數不是金額，
          // 也無法從物件屬性決定要用哪一檔，所以不換算，原文留在 notes。
          earlyTerminationPenalty: notListed(planRaw),
        },
        utilitiesBasis: 'unknown',
        // 只認房間卡片自己的註記；頁面其他地方的「家具」字樣是 lounge 或全館的宣傳文案，不可當這間房的欄位。
        furnished: /家具付き/.test(r.notesRaw)
          ? known(true, 'measured', r.notesRaw)
          : notListed(r.notesRaw),
        ...saAvailability(r.availabilityRaw, `空室情報欄列出 ${r.number} 号室`),
        contractType: 'unknown',
        // 1年／2年／短期三種方案並存，選哪一種是住戶的決定不是物件屬性 → 不挑一個當值
        contractMonths: notListed(plansRaw),
        minStayMonths: notOffered<number>(),
        genderRestriction: /女性専用/.test(r.notesRaw) ? 'female_only'
          : /男性専用/.test(r.notesRaw) ? 'male_only'
            : 'unknown',
        ageLimitRaw: notOffered<string>(),
        petsAllowed: notOffered<boolean>(),
        foreigner: NOT_OFFERED_FOREIGNER,
        notes: buildingNotes,
      };
    });

    return { building, units };
  },
};

export default adapter;
