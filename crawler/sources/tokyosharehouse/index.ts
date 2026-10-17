/**
 * 東京シェアハウス（Tokyo Sharehouse）adapter——聚合站，關東各運營者的 share house。
 *
 * 收錄它的理由：**逐物件刊登外國人受入條件**（パスポート／在留カード／日本語能力），
 * 這是其他來源幾乎都沒有的欄位；房間層也給到房號／樓層／面積／賃料／共益費／空室予定日。
 *
 * ⚠️ 兩個必須知道的坑（2026-08-16 實測）：
 *
 * 1. **不可用 sitemap 枚舉**。robots.txt 指向 `https://sharehouse.in/sitemap_index.xml`
 *    （另一個 host），其中 88k 筆 URL 有 95% 是 `/jpn/currency/change/N` 這種雜訊，
 *    且**完全不含** `/jpn/house/detail/`。只能爬列表頁。
 *
 * 2. **列表頁不可用整頁 grep**。整頁 `href="/jpn/house/detail/N/"` 會同時撈到
 *    右欄「その他人気のシェアハウス」推薦；area 6 與 area 186 兩張不同區域的列表頁
 *    整頁 grep 各得 30 筆且大量重疊，實際列表項只有各 10 筆、零重疊。
 *    所以只掃 `#listContentArea` 內 `div.listItem` 的 `data-item-id`。
 *
 * ⚠️ **鮮度風險高**：抽樣物件的「データ更新日」有 2019-01-22、2021-02-02 這種數年前的值。
 * 所以一定要把它解析進 building.sourceUpdatedAt，讓使用者自己看得到資料多舊。
 *
 * ⚠️ **金額用反斜線代替日圓符號**：建物層寫成 `\56,000 ~ \69,000`（JIS 的 `\` 即 ¥），
 * 房間層卻寫成全形 `￥69,000`，共益費又是 `&#165;14,000`。三種寫法都要還原。
 *
 * 刻意不解析的東西：物件說明欄自由文字裡的**金額**。有物件在說明裡寫
 * 「契約手数料（通常80000円）が50% OFF　40,000円に！※6ヶ月未満で退去…差額を頂戴します」——
 * 這種帶條件、帶活動期限的數字沒有結構化欄位可依附，抓成金額就是製造假精確度。
 *
 * 2026-10-17 起的例外（全部在 jp-parse/prose.ts，規則與實測寫在那裡）：說明文**明寫**的
 * 築年、地上樓數、「礼金／仲介手数料／契約手数料はかかりません」這種免收、「外国人歓迎／不可」。
 * 第二十五輪起再加保証料、更新料／更新事務手数料、清掃費（入居時／退去時）、網路費（見 proseGuarantorFee 等）。
 * 第二十七輪後再加「初期費用」總稱（其他初期費用）與保證公司月費／月付事務手数料（其他月費，見 proseOtherMonthly）。
 * 驗證幫手指出：頁面明寫「仲介手数料はかかりません」，我們卻存「此來源不公開這個欄位」，那句話是假的。
 * 免收只在前後文沒有キャンペーン／条件／場合／６ヶ月以上 等字眼時採用；金額一律不從說明文抓。
 * 另有 note 欄的保証金門檻（「※賃料44,000円以下の場合は、保証金44,000円」），見 depositFloorRule。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, conflicting, statedNoAmount, includedInOther, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseMinStayMonths, parseGenderTags, parseForeignerSignals } from '../../../packages/jp-parse/src/contract.ts';
import {
  proseZeroFees, proseZeroDeposit, proseDepositAmounts, proseFeeAmounts, roomTypesOf, scopeToRoomTypes, proseYearBuilt, proseFloorsAboveGround, proseForeignerWelcomed, proseUtilities, proseSentences, type ProseFeeKey, type ProseAmountKey,
  proseGuarantorFee, proseRenewalFees, proseCleaningFees, proseInternet, proseOtherMonthly, BLOCK_BREAK,
  proseOnlyRentAndCommonFee, proseBareInsuranceInCommonFee, proseDepositAmortized, proseUnadoptedZeroFees, type UnadoptedZero,
  proseInitialOnly, proseMonthlyOnly, proseDepositNoRefund, verbatimQuotes,
} from '../../../packages/jp-parse/src/prose.ts';
import { proseFeeField, proseOtherMonthlyField } from '../../src/prose-fields.ts';

const SITE = 'https://tokyosharehouse.com';

export const manifest: SourceManifest = {
  id: 'tokyosharehouse',
  name: '東京シェアハウス',
  nameZh: 'Tokyo Sharehouse（東京シェアハウス）',
  homepage: 'https://tokyosharehouse.com/jpn/',
  origin: 'https://tokyosharehouse.com',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'depositNonRefundable',
      'layout', 'areaM2', 'roomNo', 'floor', 'isVacant', 'availableFrom',
      'furnished', 'minStayMonths', 'genderRestriction', 'ageLimitRaw', 'petsAllowed',
      'residenceCardRequired', 'japaneseRequired',
      'stations', 'totalUnits', 'sourceUpdatedAt',
      // 以下只來自物件說明文的明寫句（見檔頭與 jp-parse/prose.ts）；沒寫的物件仍是 not_offered
      'keyMoney', 'agencyFee', 'contractFee', 'yearBuilt', 'floorsAboveGround', 'foreignerWelcomed',
      'utilities',
      // 說明文明寫「火災保険はオーナー負担」「鍵交換代も…オーナー様のご負担」→ 0（2026-10-17：11 間火災保険、2 間鍵交換）
      'fireInsurance', 'keyExchangeFee',
      // 第二十五輪：「家賃保証会社：不要」「更新料全て【０円】」「（清掃代、保険料等）は一切請求いたしません」「インターネット無料」→ 0
      'guarantorInitialFee', 'cleaningFeeUpfront', 'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'internet',
      // 第三十～三十一輪：總括句「家賃と共益費以外の費用が、かからない」「初期費用は…のみ」「毎月の支払いは…のみ」→ 0
      //（明寫要付的仍只標「有一筆要付」，金額不採用）
      'otherInitial', 'otherMonthly',
    ],
    // 全站沒有這些欄位的結構化位置——宣告出來，健康檢查才不會誤報。
    neverProvides: [
      'earlyTerminationPenalty',
      'contractType', 'contractMonths', 'structure',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null, // 首次執行時寫入；2026-08-16 實測值 3c90b6ae4940738e…
    tosReviewed: 'yes',
    notes:
      '/robots.txt 回 HTTP 200，全文三行（2026-08-16 實測）：'
      + '「# updated 2026-02-12」「User-agent: *」「Sitemap: https://sharehouse.in/sitemap_index.xml」。'
      + '有 User-agent: * 群組但**零 Disallow**、無 Crawl-delay。自訂 3 秒間隔。'
      + '利用規約 https://tokyosharehouse.com/jpn/pages/terms/ 第5条（知的財産権）逐字：'
      + '「本サイトに掲載されるすべての情報に関する特許権、商標権、著作権、プログラムその他の'
      + '知的財産権は、当社及びその他の権利者に帰属します。無断での実施、使用、複製、転載、改変、'
      + 'その他の利用は著作権侵害となり…法的に罰せられるほか、損害賠償を請求されることがあります。」'
      + '同規約全文未見禁止爬取／自動収集的條款。本站每筆房源標示出處為東京シェアハウス並連回原站，'
      + '不轉載說明文與照片。⚠️ 上述條款對「引用範圍」沒有明文界線，需求方應自行評估。',
  },
};

/** `&#165;` `&nbsp;` 等實體還原。TSH 的共益費就是用 `&#165;` 寫的。 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&yen;/g, '¥')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * JIS X 0201 把日圓符號放在 ASCII 0x5C，所以 `\56,000` 就是 `¥56,000`。
 * 只在後面接數字時才換，避免動到真的反斜線。
 */
export function yenBackslash(s: string): string {
  return s.replace(/\\(?=\s*[0-9０-９])/g, '¥');
}

function plain(fragment: string): string {
  return yenBackslash(decodeEntities(fragment.replace(/<[^>]+>/g, ' '))).replace(/\s+/g, ' ').trim();
}

/**
 * 全形數字 → 半形。JS 的 `\d` 只認 ASCII 0-9，而 TSH 的運營者有一批把步行分鐘
 * 寫成全形（`徒歩８分`）。不轉的話正則整條匹配失敗。
 * 只轉數字：全形英字與長音符不能動（動了會毀掉片假名詞彙）。
 */
export function halfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * Unicode Cf（format）類不可見字元。實測 エリア 欄有物件寫成 `東京都\u200e世田谷区経堂1丁目`——
 * U+200E（LEFT-TO-RIGHT MARK）來自原站，肉眼完全看不出來，卻會讓 ward 變成
 * 一個「看起來是世田谷区但不等於世田谷区」的字串，該棟從此不會出現在区篩選裡。
 * `\s` 不含這類字元，所以壓空白清不掉，必須另外剝。
 */
export function stripFormatChars(s: string): string {
  return s.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
}

/**
 * 取右欄摘要表的一格。
 * 結構固定：`<td><div class="detail-value-area"><div class="label">エリア</div>
 *            <div class="labelDesc">…</div></div></td>`
 * labelDesc 內含巢狀 `<div>`（アクセス 每個車站一個 div），所以不能用非貪婪抓到 `</div>`，
 * 一律切到該格的 `</td>`。
 */
export function summaryCell(html: string, label: string): string | null {
  const m = new RegExp(`<div class="label[^"]*">\\s*${label}\\s*</div>`).exec(html);
  if (m === null) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</td>', start);
  return end < 0 ? null : html.slice(start, end);
}

/** 東京都 23 特別区。用於「省略都名的地址」判斷（部分物件只寫「杉並区下井草1丁目」）。 */
const TOKYO_WARDS_23 = [
  '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
  '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
  '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区',
] as const;

export type AddressResult =
  | { readonly kind: 'tokyo'; readonly addressRaw: string; readonly ward: string }
  | { readonly kind: 'other' }
  | { readonly kind: 'unparsed' };

/**
 * 市区町村名的切點。**不可以**用 `/^(.{1,8}?)[区市町村]/` 這種「非貪婪＋字元類含町村」的寫法：
 * 大字裡的「町」「村」會讓它提前收尾，實測切出過根本不存在的行政區——
 * `東村山市萩山町` → `東村`、`武蔵村山市学園` → `武蔵村`。
 *
 * 改成依「区 → 市 → 郡＋町/村」的優先序各自比對完整型態：
 * 区名裡不會再出現区，市名裡不會再出現市，郡下的町村一定帶郡名。
 * 三種都不中就回空字串（例：原站自己漏寫市名的 `東京都国分寺光町1丁目`）——
 * 硬切出「国分寺光町」等於把原站的錯誤升級成一個新的行政區分類。
 */
export function tokyoMunicipality(rest: string): string {
  const m = /^([^0-9０-９]{1,5}?区)/.exec(rest)
    ?? /^([^0-9０-９]{1,6}?市)/.exec(rest)
    ?? /^([^0-9０-９]{1,6}?郡[^0-9０-９]{1,6}?[町村])/.exec(rest);
  return m?.[1] ?? '';
}

/**
 * 「エリア」欄的地址。實測三種寫法：
 *   `東京都港区西新橋一丁目`（有都名）
 *   `杉並区下井草1丁目`（**省略都名**）
 *   `神奈川県 川崎市 中原区 新城1019`（他県，含空白分隔）
 *
 * 省略都名時只在「区名屬於 23 特別区」且「字串裡沒有其他県／府／道／市」時才判定為東京。
 * 「中央区」「北区」「港区」在大阪市等地也存在，但那些寫法一定帶著市名或県名；
 * TSH 的收錄範圍是關東，非東京的地址實測都帶「県」或「市」。仍判不出來就回 unparsed，不猜。
 * 唯一的例外是姊妹站 sharehouse.in 的頁（實測京都的「北区出雲路…」），那在 extract 先以
 * og:url 擋掉，不會走到這裡。2026-10-17 核對其餘 137 棟省略都名的物件：區名在大阪等地也存在的
 * 北区／中央区／港区開頭共 10 棟，麵包屑是赤羽・十条・王子、渋谷・青山・恵比寿、東京・銀座・日本橋、
 * 赤坂・六本木・麻布——都是東京地域。（麵包屑是搜尋地域不是行政區：detail/3397 地址
 * 「世田谷区祖師谷」掛在「二子新地,溝の口,宮崎台」底下，所以麵包屑只能當旁證、不能當判準。）
 *
 * ⚠️ 解析前一定要先剝 Cf 不可見字元（見 stripFormatChars）：原站有一筆把 U+200E
 * 夾在「東京都」與「世田谷区」之間，不剝就會產出一個外觀相同、值不同的假行政區。
 */
export function parseTshAddress(raw: string): AddressResult {
  const t = stripFormatChars(raw).replace(/\s+/g, '').trim();
  if (t === '') return { kind: 'unparsed' };

  if (t.startsWith('東京都')) {
    return { kind: 'tokyo', addressRaw: t, ward: tokyoMunicipality(t.slice('東京都'.length)) };
  }
  if (/[都道府県]/.test(t)) return { kind: 'other' };

  const ward = TOKYO_WARDS_23.find((w) => t.startsWith(w));
  if (ward !== undefined && !t.includes('市')) {
    return { kind: 'tokyo', addressRaw: `東京都${t}`, ward };
  }
  return /[区市町村]/.test(t) ? { kind: 'other' } : { kind: 'unparsed' };
}

/**
 * アクセス欄。是運營者自己填的自由欄位，實測的寫法遠不只一種：
 *   `都営三田線 内幸町駅 徒歩3分`                        標準
 *   `JR総武線 荻窪駅 16分`                               **沒有「徒歩」二字**
 *   `JR山手線 大崎 徒歩10分`                             **沒有「駅」字**
 *   `京急本線 平和島駅 徒歩８分`                         **全形數字**
 *   `JR京浜東北線 蒲田駅 徒歩約8分`                      **「約」卡在徒歩與數字之間**
 *   `鷹の台駅 西武国分寺線 徒歩10分`                     **站名寫在路線前面**
 *   `東急東横線「都立大学」駅 徒歩8分、「学芸大学」駅 徒歩16分`  一格塞兩站
 *   `日比谷線 八丁堀駅`                                  **完全沒寫分鐘**
 *
 * 三條原則，每一條都是踩過的坑：
 *
 * 1. **分鐘讀不出來不可以丟掉整列**。站名與路線是與分鐘各自獨立的事實，照收；
 *    分鐘另外標未知——有數字但讀不出來（`徒歩1分半`、`徒歩30秒`、`西武池袋線 大泉学園駅 12`）
 *    標 unparsed（唯一的故障訊號，health 靠它告警），完全沒寫數字才標 not_listed。
 *    舊版是「正則不中就 continue」，加上 `\d` 不認全形數字，實測讓 61 棟建物一個車站都沒有。
 *
 * 2. **切點用「駅」與路線後綴（線／ライン／ライナー／モノレール）雙錨點，切不出來就整列不收**。
 *    舊版從句尾「N分」往回切、最後一個空白段當站名，遇到「徒歩約」「自転車6分・」「バスと」
 *    這類修飾語就整串左移一格：站名欄裝進句子碎片、路線欄裝「路線＋站名」，
 *    而這些碎片會變成車站字典裡使用者看得到的選項。硬切的代價比少收一列大得多。
 *
 * 3. **バス停／停留所／営業所不是鐵路車站**，切得出來也不收。
 *
 * 沒寫「徒歩」的那種可能是徒歩也可能是バス，walkMinutes 一律留未知、
 * 原文完整保留在 rawText，不替站方補上「徒歩」。
 */
// 「徒歩で10分」（2026-10-17 驗證幫手抓到 1214：「多摩小田急線/小田急永山駅/徒歩で10分」）——で 夾在中間
const TSH_MINUTES_RE = /(?:(徒歩|歩|バス|自転車|車|乗車|電車)\s*で?)?\s*(?:約)?\s*(\d+(?:\.\d+)?)\s*分\s*$/;
/** 同款但不錨定句尾，用來把「一格兩站」切開。 */
const TSH_MINUTES_G = /(?:(?:徒歩|歩|バス|自転車|車|乗車|電車)\s*で?)?\s*(?:約)?\s*\d+(?:\.\d+)?\s*分/g;
// 不以「線」結尾的路線名：つくばエクスプレス、ゆりかもめ（3470「つくばエクスプレス 浅草 徒歩9分」曾存成無路線）
const LINE_SUFFIX_RE = /(線|ライン|ライナー|モノレール|エクスプレス|ゆりかもめ)$/;
/** 站名不可能長這樣：交通方式、時間、公車設施、句讀。 */
const NOT_A_STATION_RE = /徒歩|歩\d|バス|自転車|乗車|下車|電車|停留所|営業所|交番|\d+\s*[分秒]|^\d+$|[。「」『』【】*＊]/;
const BRACKETED_TAIL_RE = /[「『【]([^」』】]{1,20})[」』】]\s*$/;
const OPEN_BRACKET_RE = /^[「『（(【[]/;
const CLOSE_BRACKET_RE = /[」』）)】\]]$/;

/**
 * 一格裡塞了多站時切段。只在「這個 N分 後面還有駅或路線」時才切：
 * 「バス5分+徒歩1分・自転車6分・徒歩18分」後面既無駅也無線，那是同一站的多種到達方式，
 * 切開會憑空生出三個不存在的車站。
 */
export function tshAccessSegments(text: string): readonly string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(TSH_MINUTES_G)) {
    const end = (m.index ?? 0) + m[0].length;
    if (!/駅|線|ライン|ライナー|モノレール|エクスプレス|ゆりかもめ/.test(text.slice(end))) continue;
    out.push(text.slice(start, end));
    start = end;
  }
  if (text.slice(start).trim() !== '') out.push(text.slice(start));
  return out.map((s) => s.replace(/^[\s、,・･。]+/, '').trim()).filter((s) => s !== '');
}

/** 站名候選的清洗：去括號、砍掉「…まで／…から」的尾巴、並列取最後一個、路線黏在前面就切掉。 */
function cleanStationName(token: string): string {
  const stripped = token.replace(OPEN_BRACKET_RE, '').replace(CLOSE_BRACKET_RE, '').trim()
    .replace(/(まで|から|へ).*$/, '')
    .replace(/[（(].*$/, '');
  const listed = Math.max(stripped.lastIndexOf('、'), stripped.lastIndexOf('/'));
  const one = listed >= 0 ? stripped.slice(listed + 1) : stripped;
  const glued = one.lastIndexOf('線');
  // 「丸ノ内線東高円寺」：路線黏在站名前面。線之前至少要有 2 字才算路線名，
  // 否則會把「西線11条」這種本身含「線」的站名切壞。
  const bare = glued >= 2 && glued < one.length - 1 ? one.slice(glued + 1).replace(/^[の‐\-・･]+/, '') : one;
  // 「JR池袋駅東口」這種把事業者黏在站名前面的寫法：站名本身不會以 JR 開頭
  return bare.replace(/^(?:JR|ＪＲ)(?=.)/, '').replace(/駅$/, '').trim();
}

/** 上面切掉的路線那半。 */
function lineGluedBefore(token: string): string {
  const s = token.replace(OPEN_BRACKET_RE, '').replace(CLOSE_BRACKET_RE, '').trim();
  const i = s.lastIndexOf('線');
  return i >= 2 && i < s.length - 1 ? s.slice(0, i + 1) : '';
}

function isStationName(s: string): boolean {
  return s !== '' && s.length <= 12 && !NOT_A_STATION_RE.test(s) && !LINE_SUFFIX_RE.test(s);
}

export type LineStation = { readonly line: string; readonly station: string };

/** 由後往前找第一個「像站名」的詞；它前面的詞（扣掉交通方式碎片）就是路線。 */
function fromTokens(before: string): LineStation | null {
  const first = before.split(/\s+/).filter((t) => t !== '');
  const toks = first.length === 1 && (first[0] ?? '').includes('/')
    ? (first[0] ?? '').split('/').filter((t) => t !== '')
    : first;
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i] ?? '';
    const station = cleanStationName(tok);
    if (!isStationName(station)) continue;
    const pre = toks.slice(0, i).filter((t) => !NOT_A_STATION_RE.test(t)).join(' ').trim();
    return { line: pre === '' ? lineGluedBefore(tok) : pre, station };
  }
  return null;
}

/** `東京メトロ・日比谷線「小伝馬町」`、`●東京メトロ千代田線【乃木坂駅】` 這種引號寫法。 */
function fromBrackets(s: string): LineStation | null {
  const t = s.trim();
  const m = BRACKETED_TAIL_RE.exec(t);
  if (m?.[1] === undefined) return null;
  const station = m[1].trim().replace(/駅$/, '');
  return isStationName(station) ? { line: t.slice(0, m.index).trim(), station } : null;
}

export function splitLineStation(head: string): LineStation | null {
  const h = head.trim();
  if (h === '') return null;
  const quoted = fromBrackets(h);
  if (quoted !== null) return quoted;
  const i = h.lastIndexOf('駅');
  if (i >= 0) {
    const before = h.slice(0, i).trim();
    const after = h.slice(i + 1).replace(/^[\s・･、,/]+/, '').replace(CLOSE_BRACKET_RE, '').trim();
    const parts = fromBrackets(before) ?? fromTokens(before);
    if (parts === null) return null;
    // 「住吉駅（都営新宿線、半蔵門線）まで徒歩12分」（30）：路線寫在駅後面的括號裡。
    // 多條線照原文存成一個字串，與「半蔵門線・都営新宿線」這類既有寫法一致
    const paren = /^\s*[（(]([^）)]{1,30})[）)]/.exec(h.slice(i + 1))?.[1]?.trim();
    if (parts.line === '' && paren !== undefined && LINE_SUFFIX_RE.test(paren)) return { line: paren, station: parts.station };
    // 站名寫在路線前面（`鷹の台駅 西武国分寺線`）：駅 後面那段才是路線
    return after !== '' && LINE_SUFFIX_RE.test(after) ? { line: after, station: parts.station } : parts;
  }
  const toks = h.split(/\s+/).filter((t) => t !== '');
  const last = toks[toks.length - 1] ?? '';
  if (toks.length >= 2 && LINE_SUFFIX_RE.test(last)) {
    const station = cleanStationName(toks[toks.length - 2] ?? '');
    return isStationName(station) ? { line: last, station } : null;
  }
  return fromTokens(h);
}

/**
 * 路線名的最低門檻。寧可留空（未知）也不要把散文殘句放進路線字典——
 * 使用者在路線下拉看到「です！」會不知道那是什麼，選了也只會得到空結果。
 * 「JR」「JR線」這種原站就只寫這麼多的要留（含事業者名即可）。
 */
function looksLikeLine(s: string): boolean {
  const t = s.replace(/^[☆★●○◆■・\s]+/, '').trim();
  if (t === '') return false;
  // 一列寫好幾條路線（3081「東京メトロ東西線・南北線・有楽町線・JR総武線・都営大江戸線 飯田橋駅」30 字）：
  // 每一段都像路線名才收；超過 24 字的散文殘句照舊擋
  if (t.length > 24) {
    return t.length <= 60 && t.split(/[・･/／、,]/).every((p) => {
      const q = p.trim();
      return q !== '' && q.length <= 24 && /線|ライン|ライナー|モノレール|エクスプレス|ゆりかもめ/.test(q) && !/[。！!？?]|です|ます/.test(q);
    });
  }
  // 「北総鉄道 新柴又駅」（2196）：路線名就是鐵道公司名
  if (/線|ライン|ライナー|モノレール|エクスプレス|ゆりかもめ|JR|ＪＲ|メトロ|新幹線|鉄道|電鉄/.test(t)) return true;
  // 「東武東上 上板橋駅」（330）「西武新宿」「京浜急行」「東武スカイツリー」：鐵道公司＋路線簡稱，不帶「線」字。
  // 「東急バス」也是鐵道公司開頭，要擋
  return t.length <= 12 && !/バス/.test(t) && /^(?:東武|西武|京王|小田急|東急|京急|京浜急行|京成|都営|相鉄|北総|つくば)/.test(t);
}

/**
 * アクセス欄只寫「京成高砂駅 6分」（沒寫交通方式）時，說明文若對**同一站**明寫「徒歩6分」——
 * 分鐘數相同——就當作步行時間（2026-10-17 驗證幫手抓到 4414／2926／4515：說明文寫
 * 「「京成高砂駅」徒歩6分」「赤羽岩淵駅から徒歩5分」「奥沢駅から徒歩4分、自由が丘駅から徒歩6分」）。
 * 只認站名緊接（可夾括號、駅、から／より／まで）徒歩的寫法，分鐘數不同或句內提到公車都不採用。
 * 說明文在站名前直接寫了路線、又與這一列的路線對不上時也不採用（4340：說明文是「JR中央・総武線飯田橋駅から
 * 徒歩8分」，這一列是大江戸線／南北線的飯田橋——同名不同站體，步行時間不能挪用）。
 */
export function proseConfirmsWalk(prose: string, station: string, minutes: number, line = ''): string | null {
  return proseWalkMentions(prose, station, line).find((w) => w.minutes === minutes)?.sentence ?? null;
}

/**
 * アクセス欄對這一站完全沒寫分鐘（3033「東武スカイツリーライン 竹ノ塚駅」）時，說明文明寫的步行分鐘。
 * 說明文對同一站寫了兩種不同分鐘就不採用（不替原站挑）。
 */
export function proseWalkOnly(prose: string, station: string, line = ''): { minutes: number; sentence: string } | null {
  const ws = proseWalkMentions(prose, station, line);
  return ws.length > 0 && ws.every((w) => w.minutes === ws[0]?.minutes) ? ws[0] ?? null : null;
}

/** 說明文裡對某站明寫步行分鐘的每一處（寫法見 proseConfirmsWalk 的說明）。 */
function proseWalkMentions(prose: string, station: string, line: string): Array<{ minutes: number; sentence: string }> {
  const found: Array<{ minutes: number; sentence: string }> = [];
  if (prose === '' || station === '') return found;
  const st = station.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 「JR赤羽駅にも徒歩15分ほどで行ける」（2926）：に／へ＋は／も也算緊接
  // 「地下鉄赤塚駅（有楽町線・副都心線）から徒歩６分」（3328）：駅 後面可夾一段路線括號
  // 「つつじヶ丘駅からSHIFT調布までは徒歩7分」（3235）：から 和 まで 之間夾著房子的名字（不含駅、讀點）
  const re = new RegExp(`[「『]?${st}[」』]?\\s*駅?[」』]?\\s*(?:[（(][^）)]{1,20}[）)])?\\s*(?:(?:から|より)(?:[^。、駅]{1,20}?まで)?|まで|に|へ)?\\s*(?:は|も)?\\s*徒歩\\s*(?:約)?\\s*(\\d+)\\s*分(?!\\s*半)`, 'g');
  // 「12分ほど歩けば品川駅と白金高輪駅にも行けます」（3155）：分鐘寫在站名前面，用「歩けば／歩くと」明寫走路
  const reversed = new RegExp(`(\\d+)\\s*分\\s*(?:ほど|くらい|ぐらい|程度)?\\s*歩(?:けば|くと|いて)([^。]{0,20}?)[「『]?${st}[」』]?\\s*駅`, 'g');
  // 「徒歩7分の日比谷線、半蔵門線直結の「竹ノ塚」駅」（3033）：步行分鐘當修飾語寫在前面；
  // 中間夾了「から／まで」或別的駅就不是同一段路（「徒歩7分の公園から竹ノ塚駅まで…」）
  const modifier = new RegExp(`徒歩\\s*(?:約)?\\s*(\\d+)\\s*分(?:ほど)?の((?:(?!から|まで|より|駅|バス|乗|電車)[^。]){0,25}?)[「『]?${st}[」』]?\\s*駅`, 'g');
  for (const s of proseSentences(halfWidthDigits(prose))) {
    if (/バス/.test(s)) continue;
    for (const m of [...s.matchAll(reversed), ...s.matchAll(modifier)]) {
      const gap = m[2] ?? '';
      // 「北品川駅」不是「品川駅」：站名前一個字是漢字／片假名（「線」除外）就不是這一站
      const prev = gap.at(-1) ?? '';
      if (/[一-龥ァ-ヶー]/.test(prev) && prev !== '線') continue;
      const proseLine = /([^\s、。,，「」『』【】()（）はがをにでともへや]{1,24}線)$/.exec(gap)?.[1];
      if (proseLine !== undefined && line !== '' && !sameLine(proseLine, line)) continue;
      found.push({ minutes: Number(m[1]), sentence: s });
    }
    for (const m of s.matchAll(re)) {
      // 「京成高砂」不可以吃到「…新高砂」這種更長站名的尾巴（「線」緊接站名是常見寫法，放行）
      const prev = s[(m.index ?? 0) - 1] ?? '';
      if (/[一-龥ァ-ヶー]/.test(prev) && prev !== '線') continue;
      // 助詞當邊界：「ルチアハウス築地は日比谷線築地駅」的路線是「日比谷線」，不是整串
      const proseLine = /([^\s、。,，「」『』【】()（）はがをにでともへや]{1,24}線)$/.exec(s.slice(0, m.index))?.[1];
      if (proseLine !== undefined && line !== '' && !sameLine(proseLine, line)) continue;
      found.push({ minutes: Number(m[1]), sentence: s });
    }
  }
  return found;
}

/** 說明文的路線寫法（「東急東横線」「JR中央・総武線」）是否指向這一列的路線（「東急東横,目黒,多摩川線」「都営大江戸線」）。 */
function sameLine(proseLine: string, rowLine: string): boolean {
  const OPERATOR = /^(?:JR|ＪＲ|東京メトロ|都営|東急|京王|京成|西武|東武|小田急|京急|京浜急行|メトロ|地下鉄)/;
  // 「京王線」去掉營運商前綴會變空字串（3878 因此對不上）——剩不到 2 字就保留原名
  const core = (t: string): string => {
    const bare = t.replace(/線$/, '').trim();
    const stripped = bare.replace(OPERATOR, '');
    return stripped.length >= 2 ? stripped : bare;
  };
  const names = (l: string): string[] => l.replace(/の/g, 'ノ').split(/[・,、/]/).map(core).filter((t) => t.length >= 2);
  const p = proseLine.replace(/の/g, 'ノ');
  const r = rowLine.replace(/の/g, 'ノ');
  return names(proseLine).some((t) => r.includes(t)) || names(rowLine).some((t) => p.includes(t));
}

export function parseTshStations(cellHtml: string, prose = ''): readonly Station[] {
  const out: Station[] = [];
  /** 這一段沒寫徒歩（只有車程、自轉車、或沒寫方式）的列 */
  const noWalkInSegment = new Set<Station>();
  const seen = new Map<string, number>();
  for (const m of cellHtml.matchAll(/<div>([\s\S]*?)<\/div>/g)) {
    const original = plain(m[1] ?? '');
    if (original === '') continue;
    for (const seg of tshAccessSegments(stripFormatChars(halfWidthDigits(original)))) {
      // 「（池袋駅西口乗り場から約7分）」這種整段括號是補充說明，不是車站列
      if (/^[（(]/.test(seg)) continue;
      // 「JR山手線 高田馬場駅 急行で2駅12分」是從最近車站搭車到轉乘站的車程，不是這棟的車站
      // （3456：舊版把「急行で2」存成站名）
      if (/\d\s*駅(?:目)?\s*\d+\s*分/.test(seg)) continue;
      const g = TSH_MINUTES_RE.exec(seg);
      const head = g === null ? seg : seg.slice(0, g.index);
      const parts = splitLineStation(head);
      if (parts === null) continue;
      // 一格塞多站又只寫一個時間時，line 會殘留前面幾站的名字（`…「馬喰横山」 都営浅草線`）。
      // 這些殘句會直接變成路線字典的項目，切到最後一個站名之後只留真正的路線。
      const trimmed = parts.line.includes('」')
        ? parts.line.slice(parts.line.lastIndexOf('」') + 1)
        : parts.line;
      // 「駅」當站名邊界時要避開「各駅停車」——那個「駅」是路線名的一部分，
      // 切下去會得到「停車」這種不存在的路線（2026-09-06 實測 3 筆）。
      let cutAt = -1;
      for (const mm of trimmed.matchAll(/駅(?!停車)/g)) cutAt = mm.index ?? -1;
      const cut = cutAt >= 0
        ? trimmed.slice(cutAt + 1).replace(/^[\s・･、,/]+/, '').trim()
        : trimmed.trim();
      // 最後一道防線：路線名長得不像路線就當作不知道。
      // 站名是從結構化位置抓的、可信；但 line 有可能是散文被切出來的殘句
      // （實測「です！」「☆JR総武線」），存進去會變成路線字典裡一個假的選項。
      const line = looksLikeLine(cut) ? cut.replace(/^[☆★●○◆■・\s]+/, '').trim() : '';
      // 公車站牌不是鐵路車站。判準是「這一列提到公車設施，而且沒有任何鐵路路線活下來」——
      //「山手線 目黒駅 バス4分…」有路線，是鐵路站的公車補充說明，要留。
      if (/バス|停留所|営業所/.test(line) && !LINE_SUFFIX_RE.test(line)) continue;
      // 沒有鐵路路線又提到公車的列＝公車資訊（2026-10-17 第九輪驗證後全量掃到：
      // 1586「東急バス 柿の木坂交番（恵比寿駅行き）…恵比寿駅まで21分」存成車站「恵比寿」、
      // 2998「バス森5 荏原病院前」、3399「都営バス 北砂３丁目駅」存成車站）
      if (line === '' && /バス|停留所|営業所/.test(seg)) continue;
      // 「京王相模原線/京王永山駅/徒歩で10分 新宿まで27分」：句尾的分鐘是到新宿的車程，步行寫在中間。
      // 段內沒提公車時，句尾不是步行就改取段內第一個明寫「徒歩」的分鐘；提到公車就不取——
      // 「バス4分（バス停まで徒歩3分）」的徒歩是走到公車站，不是到車站。
      const inner = g?.[1] === '徒歩' || g?.[1] === '歩' || /バス/.test(seg)
        ? null
        : /(?:徒歩|歩)\s*で?\s*(?:約)?\s*(\d+(?:\.\d+)?)\s*分(?!\s*半)/.exec(seg);
      const minutes = inner !== null ? Number(inner[1]) : g === null ? Number.NaN : Number(g[2]);
      // 「バスと徒歩15分」（2664）「バス14分、バス停徒歩5分」（1627）：徒歩是公車站走過去的那一段，不是到車站的步行時間。
      // 「バス5分+徒歩1分・自転車6分・徒歩18分」（1784）最後的徒歩18分是另一種走法，照收
      const busLeg = g !== null && /(?:バス停?|停)\s*(?:から|より)?\s*(?:と|[+＋])?\s*$/.test(seg.slice(0, g.index));
      const walked = !busLeg && (inner !== null || g?.[1] === '徒歩' || g?.[1] === '歩');
      const confirmed = !walked && g !== null && g[1] === undefined && !/バス/.test(seg) && Number.isFinite(minutes)
        ? proseConfirmsWalk(prose, parts.station, minutes, line)
        : null;
      // アクセス欄這一站完全沒寫分鐘（3033「東武スカイツリーライン 竹ノ塚駅」）：說明文對同站明寫的步行分鐘
      const proseOnly = g === null && !/バス|\d/.test(seg) ? proseWalkOnly(prose, parts.station, line) : null;
      const row: Station = {
        line,
        station: parts.station,
        walkMinutes: walked && Number.isFinite(minutes)
          ? known(minutes, 'measured', original)
          : confirmed !== null
            ? known(minutes, 'measured', `${original}；物件說明「${confirmed}」`)
          : proseOnly !== null
            ? known(proseOnly.minutes, 'measured', `${original}（アクセス欄沒寫分鐘）；物件說明「${proseOnly.sentence}」`)
          : g !== null
            ? notListed(`${original}（${/バス/.test(seg) ? '原文是公車接駁' : '原文未寫交通方式'}，不視為步行時間）`)
            // 有數字卻讀不出分鐘（`徒歩1分半`／`徒歩30秒`／尾端只有裸數字）＝我們讀不出來，
            // 這是故障訊號，不可以標成「這頁沒寫」把它靜音掉
            : /\d+\s*[分秒]|\d+\s*$/.test(seg)
              ? unparsed(original)
              : notListed(original),
        rawText: original,
      };
      // 同一條線的同一站可能被寫成兩列（實測：一列「バス4分（バス停まで徒歩3分）」、
      // 另一列「徒歩18分」）。留分鐘已知的那一列，否則第二列的真實步行時間會被先到的那列擋掉。
      if (!/徒歩|歩/.test(seg)) noWalkInSegment.add(row);
      const key = `${line}|${parts.station}`;
      const at = seen.get(key);
      if (at === undefined) { seen.set(key, out.length); out.push(row); continue; }
      const prev = out[at];
      if (prev !== undefined && !prev.walkMinutes.known && row.walkMinutes.known) out[at] = row;
    }
  }
  // 沒路線的那一列若只是同站的重複（4018：「小岩駅北口からのバスに乗ると…」切出一個無路線的「小岩」，
  // 與「JR総武線 小岩」重複），又沒有自己的步行分鐘，就丟掉——留著會在車站篩選裡多出一個假的「小岩」路線組合。
  // 沒路線、該段沒寫徒歩、同棟另有寫了路線或步行分鐘的車站：那是補充的車程——1264「京王線 西調布駅 徒歩2分」
  // 之後的「新宿駅 25分」、1586「…恵比寿駅まで21分」（公車到恵比寿）、30「豊洲駅まで自転車15分」。
  // 留著會讓調布的房子出現在「新宿」的車站篩選裡。
  const anchored = out.some((o) => o.line !== '' || o.walkMinutes.known);
  return out.filter((st) => st.line !== '' || st.walkMinutes.known
    || (!out.some((o) => o !== st && o.line !== '' && o.station === st.station)
      && !(noWalkInSegment.has(st) && anchored)));
}

/**
 * 「入居条件」區塊。每個 `td.condition-item` 有一個 `div.icon {name}-{0|1}` 與一段說明。
 * 實測 icon 名稱是固定的 8 個：manage / min_contract / japanese / clean / deposit /
 * foreigner / rule / event（第一格是性別，用的是 `gender-icon`，這裡抓不到，也不需要）。
 *
 * ⚠️ 尾碼的 0/1 是圖示的亮／暗狀態，**語意未經查證**——實測有物件 `foreigner-0`
 * 卻仍列出護照與簽證要求。所以只讀說明文字，不解讀 0/1。
 */
export function parseConditionBlocks(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const i = html.indexOf('<div class="condition">');
  if (i < 0) return out;
  const j = html.indexOf('入居者データ', i);
  const seg = html.slice(i, j < 0 ? html.length : j);
  for (const part of seg.split('<td class="condition-item">').slice(1)) {
    const icon = /<div class="icon ([a-z_]+)-[01]"/.exec(part)?.[1];
    if (icon === undefined) continue;
    const body = /<td class="explainBlock">([\s\S]*?)<\/table>/.exec(part)?.[1] ?? '';
    out.set(icon, plain(body));
  }
  return out;
}

export type TshRoomStatus = 'available' | 'coming_soon' | 'occupied' | 'unknown';

export type TshRoom = {
  readonly roomNoRaw: string;
  readonly roomNo: string;
  readonly status: TshRoomStatus;
  /** 空室予定日（ISO），status = coming_soon 時才有 */
  readonly emptyDate: string | null;
  readonly layout: string;
  readonly floorRaw: string;
  readonly male: boolean | null;
  readonly female: boolean | null;
  readonly rentRaw: string;
  readonly adminRaw: string;
  readonly areaRaw: string;
  readonly conditionRaw: string;
  readonly remarks: string;
  /** 房內設備圖示中「有」的那些（`bed-on` → `bed`） */
  readonly equipmentOn: readonly string[];
};

/**
 * 房間區塊。
 *
 * ⚠️ 詳情頁的「部屋情報」**只列空室與空室予定的房間**，不是全部房間——
 * 2026-08-16 拿 detail/350 與 room/350 逐間對過：room 頁 18 間（301–410），
 * 其中 408=空室、302=2026-09-02、307=2026-10-03，detail 頁就恰好是這 3 間，順序也一致。
 * detail/1889 同樣：room 頁 7 間、僅 302 空室，detail 頁就是 302。
 * 所以不需要為了拿房間再多打一次 room 頁。
 */
export function parseTshRooms(html: string): TshRoom[] {
  const start = html.indexOf('<div class="detail-room');
  if (start < 0) return [];
  const stop = html.indexOf('<a name="condition"', start);
  const seg = html.slice(start, stop < 0 ? html.length : stop);

  const out: TshRoom[] = [];
  for (const chunk of seg.split('<div class="room-item"').slice(1)) {
    const roomNoRaw = plain(/<div class="room-num">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '');
    if (roomNoRaw === '') continue;

    const status: TshRoomStatus = chunk.includes('btnAvailable')
      ? 'available'
      : chunk.includes('btnComingSoon')
        ? 'coming_soon'
        : chunk.includes('btnOccupied') ? 'occupied' : 'unknown';

    const dateRaw = plain(/<div class="empty-date">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '');
    const prices = new Map<string, string>();
    for (const p of chunk.matchAll(/<div class="label[^"]*">\s*([^<]*?)\s*<\/div>\s*<div class="value">([\s\S]*?)<\/div>/g)) {
      prices.set(plain(p[1] ?? ''), plain(p[2] ?? ''));
    }

    out.push({
      roomNoRaw,
      // 房號常把性別條件黏在後面（`302男性専用`）；性別另有圖示欄位，這裡去掉以免污染房號
      roomNo: roomNoRaw.replace(/\s*(男性専用|女性専用)\s*$/, '').trim(),
      status,
      emptyDate: /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null,
      layout: plain(/<div class="room-info"><span>([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? ''),
      floorRaw: plain(/<div class="room-floor">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? ''),
      male: boolIcon(chunk, 'male'),
      female: boolIcon(chunk, 'female'),
      rentRaw: prices.get('賃料') ?? '',
      adminRaw: prices.get('共益費') ?? '',
      areaRaw: plain(/<span class="width">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^広さ:\s*/, ''),
      conditionRaw: plain(/<span class="condition">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^入居条件:\s*/, ''),
      remarks: plain(/<span class="remarks">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^備考:\s*/, ''),
      equipmentOn: [...chunk.matchAll(/<div class="icon ([a-z_]+)-on"/g)].map((m) => m[1] ?? ''),
    });
  }
  return out;
}

function boolIcon(chunk: string, which: 'male' | 'female'): boolean | null {
  const m = new RegExp(`<div class="gender-icon ${which}-([01])"`).exec(chunk);
  return m?.[1] === undefined ? null : m[1] === '1';
}

/** 房間層的性別圖示是結構化的兩個布林，比建物層的「男性, 女性」標籤列精確。 */
export function genderOfRoom(r: TshRoom, fallback: GenderRestriction): GenderRestriction {
  if (r.male === null || r.female === null) return fallback;
  if (r.male && r.female) return 'mixed';
  if (r.male) return 'male_only';
  if (r.female) return 'female_only';
  return fallback;
}

/**
 * 「保証金」欄。實測五種寫法：
 *   `家賃1カ月分 （退去時¥25,000償却）`   償却額（＝敷引）直接給
 *   `家賃1カ月分 （退去時100％返却）`     全額退還 → 敷引 0
 *   `¥50,000 （退去時100％償却）`         全額不退 → 敷引＝保証金
 *   `¥80,000 （退去時¥47,000返却）`       給的是**退還額**，敷引要減出來
 *   `¥44,000`（無括號）                   敷引未知
 *
 * 月數要乘賃料才成金額，賃料未知時一律留未知（不換算）。
 * 括號裡的百分比與減法都是對「原站白紙黑字寫出來的兩個數字」做算術，不是憑空生值，
 * 所以算式一律寫進 srcText 供稽核。
 */
/**
 * 保証金倍率的合理上界。日本的保証金慣例最多 3 個月；放寬到 12 是為了留餘裕，
 * 不是因為看過 12 個月的物件。超過就視為原站把金額寫進倍率位置（見 parseDeposit）。
 */
const MAX_DEPOSIT_MONTHS = 12;

/**
 * 房間的「階」欄。
 *
 * 站方自己的寫法幾乎全是 `N階`（實測 1,624 次），另有 `地下 1階` 1 次、
 * 英文的 `Ground floor` 6 次、空字串 46 次。
 * 地下記成負數，與 SUUMO 的 `B1階` 同一表示法。
 * `Ground floor` 極可能就是 1 階（站方自己有 434 筆寫 `1階`），但那是推測不是原文，
 * 所以標 unparsed 把原文留著——寧可讓健康報告記一筆解析失敗，也不替原站決定它的意思。
 */
export function parseTshFloor(raw: string): Field<number> {
  const t = raw.trim();
  if (t === '') return notListed(t);
  const b = /^地下\s*(\d+)\s*階$/.exec(t);
  if (b?.[1] !== undefined) return known(-Number(b[1]), 'measured', `階 ${t}`);
  const m = /^(\d+)\s*階$/.exec(t);
  if (m?.[1] === undefined) return unparsed(`階 ${t}`);
  return known(Number(m[1]), 'measured', `階 ${t}`);
}

export function parseDeposit(
  raw: string,
  rent: Field<Yen>,
): { deposit: Field<Yen>; nonRefundable: Field<Yen> } {
  const t = yenBackslash(raw).trim();
  if (t === '') return { deposit: notListed(''), nonRefundable: notListed('') };

  const paren = /[（(]([^）)]*)[）)]/.exec(t)?.[1] ?? '';
  const head = t.replace(/[（(][^）)]*[）)]/g, '').trim();

  let deposit: Field<Yen> = notListed(t);
  const money = parseMoney(head);
  if (money.kind === 'amount') {
    deposit = known(yen(money.jpy), 'measured', `保証金 ${head}`);
  } else if (money.kind === 'zero') {
    deposit = known(yen(0), 'measured', `保証金 ${head}`);
  } else if (money.kind === 'months') {
    // 「家賃1カ月分」是倍數不是金額——只有賃料已知時才換算，且把算式寫進 srcText 供稽核。
    // ⚠️ 換算前先過合理範圍：原站有一筆把金額寫進倍率位置（逐字「家賃44000カ月分」，
    // 顯然是想寫 ¥44,000），照乘會生出 ¥2,420,000,000 這個原站從未主張過的數字。
    // 日本的保証金慣例最多 3 個月，這裡寬鬆放到 12；超出就是原站那一句寫壞了，
    // 標 unparsed 並保留原文——寧可讓 health 亮燈，也不編一個沒人寫過的金額。
    deposit = money.months > MAX_DEPOSIT_MONTHS
      ? unparsed(`保証金 ${head}`)
      : rent.known
        ? known(yen(Math.round(money.months * rent.v.jpy)), 'measured',
          `保証金 ${head} × 賃料 ${rent.v.jpy}円`)
        : notListed(`${head}（賃料未知，不換算）`);
  } else if (money.kind === 'unparsed') {
    deposit = unparsed(`保証金 ${head}`);
  }

  let nonRefundable: Field<Yen> = notListed(paren === '' ? t : paren);
  if (paren !== '') {
    const pct = /(\d+(?:\.\d+)?)\s*[％%]\s*償却/.exec(paren);
    const written = parseMoney(paren.replace(/[償返]却/g, ''));
    // 「退去時N％返却」：退 N％、不退 (100−N)％。第二十九輪 3056「（退去時0％返却）」曾一律當成全退存 0，與字面相反；
    // 超過 100％（「10000％返却」）是原站誤植，不替它猜
    const ret = /(\d+(?:\.\d+)?)\s*[％%]\s*返却/.exec(paren);
    if (/全額返却/.test(paren) || (ret?.[1] !== undefined && Number(ret[1]) === 100)) {
      nonRefundable = known(yen(0), 'measured', `保証金 ${paren}`);
    } else if (ret?.[1] !== undefined) {
      const n = Number(ret[1]);
      nonRefundable = n > 100
        ? unparsed<Yen>(`保証金 ${paren}（返還比例超過 100％，疑似原站誤植）`)
        : deposit.known
          ? known(yen(Math.round(((100 - n) / 100) * deposit.v.jpy)), 'measured', `保証金 ${paren}（返還 ${n}％，不退 ${100 - n}％）× 保証金 ${deposit.v.jpy}円`)
          : notListed<Yen>(`保証金 ${paren}（保証金金額未知，不換算）`);
    } else if (pct?.[1] !== undefined && Number(pct[1]) > 100) {
      // 「（退去時22000％償却）」（190，第三十一輪建置期不變式抓到：照乘會存出 660 萬的不退金額）：同返却，超過 100％ 不替它猜
      nonRefundable = unparsed<Yen>(`保証金 ${paren}（償却比例超過 100％，疑似原站誤植）`);
    } else if (pct?.[1] !== undefined && deposit.known) {
      nonRefundable = known(
        yen(Math.round((Number(pct[1]) / 100) * deposit.v.jpy)), 'measured',
        `保証金 ${paren} × 保証金 ${deposit.v.jpy}円`,
      );
    } else if (/償却/.test(paren) && written.kind === 'amount') {
      nonRefundable = known(yen(written.jpy), 'measured', `保証金 ${paren}`);
    } else if (/返却/.test(paren) && written.kind === 'amount' && deposit.known
      && written.jpy <= deposit.v.jpy) {
      // 給的是退還額，敷引＝保証金 − 退還額。兩個數字都在原文裡，減法把算式留在出處
      nonRefundable = known(yen(deposit.v.jpy - written.jpy), 'measured',
        `保証金 ${deposit.v.jpy}円 − ${paren}`);
    }
  }
  return { deposit, nonRefundable };
}

function moneyField(raw: string, label: string): Field<Yen> {
  const t = yenBackslash(raw).trim();
  if (t === '') return notListed('');
  const r = parseMoney(t);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${label} ${t}`);
    case 'zero': return known(yen(0), 'measured', `${label} ${t}`);
    case 'absent': case 'negotiable': case 'months': return notListed(`${label} ${t}`);
    default: return unparsed(`${label} ${t}`);
  }
}

/** 「男性, 女性, 30代まで」的第三段才是年齡限制；只有男女標籤時代表沒寫。 */
export function parseAgeLimit(tenancy: string): Field<string> {
  const rest = tenancy
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '男性' && s !== '女性');
  return rest.length === 0
    ? notListed(tenancy)
    : known(rest.join(' / '), 'measured', `入居条件 ${tenancy}`);
}

function foreignerPolicy(text: string): ForeignerPolicy {
  if (text === '') {
    return {
      welcomed: notOffered<boolean>(),
      residenceCardRequired: notListed(''),
      japaneseRequired: notListed(''),
      guarantorCompanyRequired: notOffered<boolean>(),
      guarantorPersonRequired: notOffered<boolean>(),
      rawText: '',
    };
  }
  const s = parseForeignerSignals(text);
  return {
    // 站方列出「外国人」受入條件不等於明示「歓迎」：這一格是全站樣板——明寫「現在は外国人の募集は
    // 行ってません」的 detail/3360 也列著「パスポート ビザ 外国人登録書」。可否只認說明文明寫的句子，
    // 在 extract 以 welcomedOf 覆寫。
    welcomed: notOffered<boolean>(),
    residenceCardRequired: s.residenceCard === true
      ? known(true, 'measured', `外国人 ${text}`)
      : notListed(text),
    // 「日本語以外の言語対応不可」是否定形的日語能力要求：運營者只能用日語對應，
    // 等於租客要具備日語能力。共用的 parseForeignerSignals 只認肯定寫法
    //（「日本語の読み書き」等），這個寫法在 TSH 佔了近百筆，漏掉就是整欄靜音。
    // 判定依據原文原樣留在 srcText，使用者自己看得到我們是憑哪一句下的結論。
    japaneseRequired: s.japanese === true || /日本語以外の言語対応不可/.test(text)
      ? known(true, 'measured', `外国人 ${text}`)
      : notListed(text),
    guarantorCompanyRequired: notOffered<boolean>(),
    guarantorPersonRequired: notOffered<boolean>(),
    rawText: text,
  };
}

/** 說明文的 HTML 片段 → 純文字，保留 <br> 的換行（prose.ts 用行與句判前後文）。 */
// 「…もっと見る」「...more」是摺疊連結的介面字（4027／4028 的引句曾帶著它，第二十七輪）；摺疊的外層 span 去掉不留空白
function proseText(fragment: string): string {
  return decodeEntities(fragment
    .replace(/<a\b[^>]*more-text-area-link[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<span class="more-text-area(?:-rest)?"[^>]*>/g, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '));
}

/** 從 `<div` 開頭配對到它自己的 `</div>`（中間可有巢狀 div）。 */
function balancedDiv(html: string, start: number): string {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

/**
 * 物件介紹（#detailContent）＋ note 欄：運營者寫給這一棟的說明文。
 * 介紹區裡可能巢著一塊「キャンペーン」（house-detail-campaign-introduction）——2026-10-17 驗證幫手抓到 3986
 * 的「海外留学生等外国人の方大歓迎」寫在那塊裡，舊的非貪婪 `</div>` 在活動標題就收尾了。
 * 活動區整塊是活動條款：築年／樓數／外國人可否照讀，費用與水電一律不從它讀（見 extract）。
 */
export function tshBuildingProse(html: string): { intro: string; campaign: string; note: string; faq: string } {
  const i = html.indexOf('<div id="detailContent" class="house-detail-introduction">');
  const block = i < 0 ? '' : balancedDiv(html, i);
  const c = block.indexOf('<div class="house-detail-campaign-introduction">');
  const campaign = c < 0 ? '' : balancedDiv(block, c);
  return {
    intro: proseText(c < 0 ? block : block.slice(0, c) + block.slice(c + campaign.length)),
    campaign: proseText(campaign),
    note: proseText(/<div class="house-detail-note">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''),
    faq: tshFaqAnswers(html),
  };
}

type ProseUtil = { basis: 'included' | 'excluded' | 'partial'; sentence: string; someExcludedOnly?: true };

/** 物件說明與運營者 FAQ 的水電判讀合併：只有一邊有就用那邊；兩邊說法不同＝部分（不替原站挑）。 */
function mergeUtilities(
  own: ProseUtil | null, faq: ProseUtil | null, whereOf: (q: string) => string,
): (ProseUtil & { from: string }) | null {
  if (own === null) return faq === null ? null : { ...faq, from: '運営者FAQ' };
  if (faq === null || faq.basis === own.basis) return { ...own, from: whereOf(own.sentence) };
  return { basis: 'partial', sentence: `${own.sentence}／${faq.sentence}`, from: `${whereOf(own.sentence)}與運営者FAQ` };
}

/**
 * 「運営者FAQ」區塊的答句（只取 A，不取 Q）。這是運營者對自家物件的共通說明，照樣顯示在每一棟的頁面上——
 * 2026-10-17 第十二輪驗證：3249 的 FAQ 答「共益費には、水道光熱費、インターネット使用料…が含まれます」，
 * 我們沒讀而標成「此來源不公開」。全量掃描 170 個 FAQ 區塊，講到費用或水電的只有這一題（同一運營者 6 棟）。
 * 只用在水電：單獨判讀後與物件說明的結果合併（mergeUtilities），說法不同就算部分含。
 */
function tshFaqAnswers(html: string): string {
  const i = html.indexOf('<div class="house-detail-faq">');
  if (i < 0) return '';
  const block = balancedDiv(html, i);
  return [...block.matchAll(/<div class="faq-ans">[\s\S]*?<div class="faq-content">([\s\S]*?)<\/div>/g)]
    .map((m) => proseText(m[1] ?? '').trim()).filter((t) => t !== '').join('\n');
}

/** 說明文裡指定房號的押金：「敷金40,000円(301号室)」。「(301号室以外)」不算。全量只有 2807 一棟這樣寫。 */
export function roomDepositNote(text: string, roomNo: string): { amount: number; text: string } | null {
  for (const m of halfWidthDigits(text).matchAll(/(?:敷金|保証金)\s*[：:]?\s*([0-9,]+)\s*円\s*[（(]\s*([^）)]+?)\s*号室\s*[）)]/g)) {
    if ((m[2] ?? '').split(/[・、,，]/).map((x) => x.trim()).includes(roomNo)) return { amount: Number((m[1] ?? '').replace(/,/g, '')), text: m[0] };
  }
  return null;
}

/**
 * note 欄的保証金門檻：「※賃料44,000円以下の場合は、保証金44,000円」。
 * 2026-10-17 驗證幫手抓到 detail/4227：入居条件表寫「家賃1カ月分（退去時50％償却）」，
 * 我們照表算出賃料 19,800 的房保証金 19,800，但 note 明寫賃料 44,000 以下保証金一律 44,000。
 * 全量掃描只有 3 棟寫這句（4227、2914、1244），後兩棟現有房間賃料都高於門檻，不受影響。
 */
export function depositFloorRule(note: string): { maxRent: number; amount: number; text: string } | null {
  const m = /賃料\s*([\d,]+)\s*円以下の場合は、?\s*保証金\s*([\d,]+)\s*円/.exec(halfWidthDigits(note));
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const maxRent = Number(m[1].replace(/,/g, ''));
  const amount = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(maxRent) && Number.isFinite(amount) ? { maxRent, amount, text: m[0] } : null;
}

/** 房間備考明寫沒附家具：「家具はありません」「家具の設置はありません」「家具なしのため…値引」（「家具なしプラン」這種選項不算）。 */
const NO_FURNITURE = /家具(?:の設置)?は(?:ありません|ございません|付いて(?:い|お)りません)|家具(?:なし|無し)(?:のため|です|$)/;

type CampaignKey = 'keyMoney' | 'agencyFee' | 'guarantorInitialFee' | 'fireInsurance' | 'keyExchangeFee' | 'contractFee'
  | 'cleaningFeeUpfront' | 'otherInitial' | 'renewalFee' | 'renewalAdminFee' | 'cleaningFeeOnExit' | 'otherMonthly'
  | 'utilities' | 'internet';

/**
 * 活動區塊（house-detail-campaign-introduction）裡提到的費用：要付的、免收的都算「提到」（第三十二輪 3235 活動區的
 * 「＜初期費用＞ 申込金50,000円 契約費30,000円⇒10,000円引き 保険10,000円」，我們卻標「此來源不公開」）。
 * 費用照舊不從活動區讀（那是活動條款，見 tshBuildingProse）——這裡只回傳原句，呼叫端用來改標「頁面有提到」。
 */
function campaignFeeMentions(campaign: string, otherProse: string): Partial<Record<CampaignKey, string>> {
  if (campaign.trim() === '') return {};
  const out: Partial<Record<CampaignKey, string>> = {};
  const amounts = proseFeeAmounts(campaign);
  const zeros = proseZeroFees(campaign);
  const unadopted = proseUnadoptedZeroFees(campaign);
  for (const k of ['keyMoney', 'agencyFee', 'contractFee', 'fireInsurance', 'keyExchangeFee'] as const) {
    const s = amounts[k] ?? zeros[k] ?? unadopted[k]?.sentence;
    if (s !== undefined) out[k] = s;
  }
  if (amounts.otherInitial !== undefined) out.otherInitial = amounts.otherInitial;
  const g = proseGuarantorFee(campaign);
  if (g !== null) out.guarantorInitialFee = g.sentence;
  const cl = proseCleaningFees(campaign);
  if (cl.cleaningFeeUpfront !== undefined) out.cleaningFeeUpfront = cl.cleaningFeeUpfront.sentence;
  if (cl.cleaningFeeOnExit !== undefined) out.cleaningFeeOnExit = cl.cleaningFeeOnExit.sentence;
  const rn = proseRenewalFees(campaign);
  if (rn.renewalFee !== undefined) out.renewalFee = rn.renewalFee.sentence;
  if (rn.renewalAdminFee !== undefined) out.renewalAdminFee = rn.renewalAdminFee.sentence;
  const om = proseOtherMonthly(campaign);
  if (om[0] !== undefined) out.otherMonthly = om[0];
  // 第三十三輪 3119：活動區的「＜毎月＞ 水道光熱費15,000円」——頁面提到水電，不能標「此來源不公開」；網路同理
  const ut = proseUtilities(campaign);
  if (ut !== null) out.utilities = ut.sentence;
  const net = proseInternet(campaign);
  if (net !== null) out.internet = net.sentence;
  // 只寫「保険」接金額（3235「保険10,000円」）：沒寫是不是火災／家財，但確實是入居時的一筆保險
  if (out.fireInsurance === undefined) {
    const b = proseSentences(campaign).find((x) => /(?<!保証|携行品)保険\s*[：:]?\s*[0-9０-９]/.test(x));
    if (b !== undefined) out.fireInsurance = b;
  }
  // 頁面別處把這筆保險寫成「携行品保証料」（第三十三輪 228「保険料 9,600円 → 0円」＝note 的「④携行品保証料（初回）9,600円」，
  // 1864 房間備考「携行品保証料・事務手数料無料」）：活動區只寫「保険（料）」、沒寫火災／家財，講的就是那筆攜帶物品保證——
  // 它由其他初期費用讀，不當成火災保険的提及
  if (out.fireInsurance !== undefined && /携行品/.test(otherProse) && !/火災|家財|借家人|住宅|賠償/.test(out.fireInsurance)) {
    delete out.fireInsurance;
  }
  return out;
}

/** srcText 的引文換回原站寫法（判讀時轉成半形的數字照原文的全形，見 jp-parse verbatimQuotes；第三十二輪 2062）。 */
function verbatimFields<T>(x: T, src: string): T {
  if (Array.isArray(x)) return x.map((y: unknown) => verbatimFields(y, src)) as T;
  if (x === null || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = k === 'srcText' && typeof v === 'string' && typeof o['known'] === 'boolean' ? verbatimQuotes(v, src) : verbatimFields(v, src);
  }
  return out as T;
}

/**
 * 站方沒有礼金／仲介／契約手数料／火災保険／鍵交換欄位，只讀說明文：明寫免收＝0；直接寫了金額＝「原站明寫要付」但金額不採用
 *（說明文金額常帶方案與活動，見 jp-parse/prose.ts 檔頭）；都沒有才是「此來源不公開」。
 */
function feeOf(
  zeros: Partial<Record<ProseFeeKey, string>>, amounts: Partial<Record<ProseAmountKey, string>>, key: ProseAmountKey,
  whereOf: (q: string) => string = () => '物件說明',
  unadopted: Partial<Record<ProseFeeKey, UnadoptedZero>> = {},
): Field<Yen> {
  const z = key === 'otherInitial' ? undefined : zeros[key];
  if (z !== undefined) return known(yen(0), 'measured', `${whereOf(z)}「${z}」`);
  const a = amounts[key];
  // 「初期費用：25,000円」這類總稱沒拆項目（第二十七輪）：可能是一筆另收的費用，也可能是含押金、房租的總額——照實說分不出來
  const lump = key === 'otherInitial' && /初期費用/.test(a ?? '') ? '；原文只寫「初期費用」總稱、沒拆項目，可能與其他已列費用重疊' : '';
  if (a !== undefined) return statedNoAmount<Yen>(`${whereOf(a)}「${a}」（說明文的金額不自動採用，見原文${lump}）`);
  // 寫了免收但沒採用（第三十輪 492、3392）：值照舊未知，但頁面確實提到了，不標「此來源不公開」
  const u = key === 'otherInitial' ? undefined : unadopted[key];
  return u === undefined ? notOffered<Yen>() : notListed<Yen>(`${whereOf(u.sentence)}「${u.sentence}」（${UNADOPTED_NOTE[u.reason]}）`);
}

const UNADOPTED_NOTE = {
  conditional: '免收句附近有條件或活動字眼，未採用',
  contested: '免收句與頁面另一處帶金額或條件的說法並存，未採用',
} as const;

function welcomedOf(text: string): Field<boolean> {
  const r = proseForeignerWelcomed(text);
  if (r === null) return notOffered<boolean>();
  if (r === 'conflict') return conflicting<boolean>('物件說明對外國人可否前後說法不一');
  return known(r.welcomed, 'measured', `物件說明「${r.sentence}」`);
}

/** 列表頁 `#listContentArea` 內的物件 id。見檔頭坑 2：不可用整頁 grep。 */
export function parseListItemIds(html: string): string[] {
  const i = html.indexOf('id="listContentArea"');
  if (i < 0) return [];
  const j = html.indexOf('class="paging"', i);
  const seg = html.slice(i, j < 0 ? html.length : j);
  const out: string[] = [];
  for (const m of seg.matchAll(/<div class="listItem[^"]*"[^>]*data-item-id="(\d+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 分頁：第 1 頁的 `rel="last"` 給出最後一頁；最後一頁本身沒有這個連結。 */
export function parseLastPage(html: string): number {
  const m = /href="[^"]*\/page:(\d+)"\s+rel="last"/.exec(html);
  const n = m?.[1] === undefined ? 1 : Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 首頁地圖列出的地域 id。橫跨關東（含神奈川／埼玉／千葉），東京篩選在 extract 做。 */
export function parseAreaIds(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\/jpn\/area\/search\/(\d+)\/?/g)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return [...out];
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const home = await fetcher.get(`${SITE}/jpn/`);
    const areas = parseAreaIds(home.body);
    if (areas.length === 0) throw new Error('[tokyosharehouse] 首頁解析不到任何 area id，版面可能已改');

    // 同一物件會出現在多個地域的列表裡，全域去重
    const seen = new Set<string>();
    for (const area of areas) {
      const first = await fetcher.get(`${SITE}/jpn/area/search/${area}/page:1`);
      const last = parseLastPage(first.body);
      for (let page = 1; page <= last; page++) {
        const body = page === 1
          ? first.body
          : (await fetcher.get(`${SITE}/jpn/area/search/${area}/page:${page}`)).body;
        for (const id of parseListItemIds(body)) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield { url: `${SITE}/jpn/house/detail/${id}/` };
        }
      }
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const html = raw.body;

    // 右欄摘要表是這個來源的骨架，缺了就是版面改了——大聲失敗，不要默默產出空資料
    const areaCell = summaryCell(html, 'エリア');
    if (areaCell === null) {
      throw new Error(`[tokyosharehouse] ${ref.url} 找不到「エリア」摘要格，版面可能已改`);
    }

    const addr = parseTshAddress(plain(areaCell));
    if (addr.kind === 'other') return null;        // 非東京（神奈川／埼玉／千葉），不收錄
    if (addr.kind === 'unparsed') {
      throw new Error(`[tokyosharehouse] ${ref.url} 地址解析不出來：${plain(areaCell)}`);
    }

    // 頁面自己宣告的所屬站。2026-10-17 實測 detail/3825 以本站網址回應，內容卻是
    // 姊妹站 sharehouse.in（全國版）的頁：og:url 指向 sharehouse.in、麵包屑「関西」、
    // エリア欄「北区出雲路立テ本町50-2」（省略了府市名）、房間列版面不同（賃料一格都抓不到）。
    // 照常解析的話，省略都名的「北区…」會被補成「東京都北区…」——把關西的物件捏造成東京的。
    // 這種頁不屬於本來源，大聲失敗、不收錄。放在地址判定之後：姊妹站的頁有數百張是明寫
    // 神奈川県／埼玉県的，那些照舊當「非東京」安靜跳過；只擋「會被當成東京收進來」的那種。
    const ogHost = /<meta property="og:url" content="https?:\/\/([^/"]+)/.exec(html)?.[1];
    if (ogHost !== undefined && ogHost !== 'tokyosharehouse.com') {
      throw new Error(`[tokyosharehouse] ${ref.url} 頁面屬於 ${ogHost}（og:url），不是本站物件頁，不收錄`);
    }

    const name = decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '')
      .replace(/：東京シェアハウス\s*$/, '').trim();
    if (name === '') throw new Error(`[tokyosharehouse] ${ref.url} 取不到物件名稱`);

    const id = /\/jpn\/house\/detail\/(\d+)/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `tokyosharehouse:${id}`;

    const conditions = parseConditionBlocks(html);
    const tenancy = plain(summaryCell(html, '入居条件') ?? '');
    const households = /(\d+)\s*世帯/.exec(plain(summaryCell(html, '世帯数') ?? ''));
    const updated = /データ更新日[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})/.exec(plain(html.replace(/<[^>]+>/g, ' ')));

    const buildingGender = parseGenderTags(tenancy);
    const ageLimit = parseAgeLimit(tenancy);
    const minStay = parseMinStayMonths(conditions.get('min_contract') ?? '');
    const ruleText = conditions.get('rule') ?? '';
    const foreigner = foreignerPolicy(conditions.get('foreigner') ?? '');
    const depositRaw = conditions.get('deposit') ?? '';
    const prose = tshBuildingProse(html);
    // 事實類（築年／樓數／外國人可否）讀整份說明含活動區；費用與水電不讀活動區
    const buildingProse = `${prose.intro}\n${prose.campaign}\n${prose.note}`;
    // 介紹與 note 是兩個區塊：判條件的前後文不跨區塊（BLOCK_BREAK，第二十八輪 2428）
    const feeProse = `${prose.intro}\n${BLOCK_BREAK}\n${prose.note}`;
    // 活動區以外的整頁說明（物件介紹、note、各房備考）
    const pageProse = `${feeProse}\n${parseTshRooms(html).map((r) => r.remarks ?? '').join('\n')}`;
    const campaignMentions = campaignFeeMentions(prose.campaign, pageProse);
    // 頁面把那筆保險寫成「携行品保証料」（攜帶物品的保證費，歸其他初期費用）時，只寫「保険料」、沒寫火災／家財的句子講的就是它
    //（第三十四輪 3289 房間備考「内見当日申し込みで初回契約事務手数料：22,000円、保険料：9,600円が無料」＝note 的「携行品保証料（初回）9,600円」）
    const carryOnOnly = (f: Field<Yen>): Field<Yen> =>
      /携行品/.test(pageProse) && /保険/.test(f.srcText) && !/火災|家財|借家人|住宅|賠償/.test(f.srcText) ? notOffered<Yen>() : f;
    // FAQ 單獨判讀：接在 note 後面會被 note 最後幾句的「場合」「3ヶ月以上」波及成附條件（4396、3481）
    const faqUtil = proseUtilities(prose.faq);
    const yearProse = proseYearBuilt(buildingProse, Number(raw.fetchedAt.slice(0, 4)));
    const floorsProse = proseFloorsAboveGround(buildingProse);
    const depositFloor = depositFloorRule(prose.note);
    // 建物層按鈕寫「ただいま満室です」，房間層卻標空室／空室予定：原站自相矛盾（2026-10-17 全量 526 棟滿室頁中
    // 14 棟仍列出可申請的房，データ更新日多為 2023-10-19）。不替原站挑，空房狀態標 conflicting。
    const buildingFull = /class="contact-button contact-button-gray"[^>]*>\s*ただいま満室です/.test(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'tokyosharehouse',
      sourceKey: id,
      sourceUrl: ref.url,
      name,
      kind: 'sharehouse',
      addressRaw: addr.addressRaw,
      prefecture: '東京都',
      ward: addr.ward,
      stations: parseTshStations(summaryCell(html, 'アクセス') ?? '', buildingProse),
      structure: notOffered<string>(),
      // 站上沒有築年／樓數欄位；只有運營者在說明文明寫時才有值（見 jp-parse/prose.ts）
      yearBuilt: yearProse === null
        ? notOffered<number>()
        : known(yearProse.year, 'measured', `物件說明「${yearProse.sentence}」`),
      // 這個來源不標建物種別；那是 SUUMO 這類入口站才有的欄位
      buildingType: notOffered<string>(),
      floorsAboveGround: floorsProse === null
        ? notOffered<number>()
        : known(floorsProse.floors, 'measured', `物件說明「${floorsProse.sentence}」`),
      totalUnits: households?.[1] !== undefined
        ? known(Number(households[1]), 'measured', `世帯数 ${households[0]}`)
        : notListed(''),
      imageUrls: (() => {
        const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
        return og === undefined ? [] : [og];
      })(),
      fetchedAt: raw.fetchedAt,
      // 這個來源的鮮度差異極大（實測 2019～2026），一定要讓使用者看得到
      sourceUpdatedAt: updated?.[1] !== undefined
        ? known(updated[1], 'measured', `データ更新日 ${updated[1]}`)
        : notListed(''),
      htmlSha256: raw.sha256,
    };

    // 詳情頁只列空室與空室予定，但保險起見仍排除明確標示已滿的房間
    const rooms = parseTshRooms(html)
      .filter((r) => r.status === 'available' || r.status === 'coming_soon');
    // 原站的 room-num 欄偶爾裝的是房型文字（實測「ルームシェア RoomShare」出現兩次），
    // 房號因此不唯一，2 階與 4 階兩間不同的房會拿到同一個 unit id 而互相蓋掉。
    // 房號重複時補上頁面序位當後綴；不重複的房號維持原樣，既有 id 不受影響。
    const roomNoTimes = new Map<string, number>();
    for (const r of rooms) roomNoTimes.set(r.roomNo, (roomNoTimes.get(r.roomNo) ?? 0) + 1);

    const units: Unit[] = rooms
      .map((r, i) => {
        const unitKey = (roomNoTimes.get(r.roomNo) ?? 0) > 1 ? `${r.roomNo}#${i + 1}` : r.roomNo;
        // 「賃料 ￥0」（2030#102、2829#E）：房租不會是 0，同「0 ㎡」是站方沒填——存 0 會讓它排到最便宜的第一名
        const rent0 = moneyField(r.rentRaw, '賃料');
        const rent = rent0.known && rent0.v.jpy === 0 ? notListed<Yen>(`${rent0.srcText}（房租不會是 0，視為站方未填）`) : rent0;
        const parsed = parseDeposit(depositRaw, rent);
        // 房間層的說明文＝建物說明＋這間房自己的備考（別間房的備考不套用）
        const roomProse = `${buildingProse}\n${r.remarks}`;
        // 「(シェアハウスタイプ)礼金1か月」「(マンションタイプ)敷金礼金1か月ずつ」（3985）：備考寫了房型時，別種房型的行不套用
        const roomTypes = roomTypesOf(r.remarks);
        const roomFeeProse = `${scopeToRoomTypes(feeProse, roomTypes)}\n${BLOCK_BREAK}\n${r.remarks}`;
        // 引句出處標籤：只出現在這間房備考裡的句子標「房間備考」，其餘標「物件說明」（第二十九輪：備考的句子曾一律標成物件說明）
        // 判讀前有些函式把全形數字轉半形（proseInternet、保証料／更新／清掃的 prepX），比對前兩邊都轉
        const norm = (x: string): string => x.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/\s+/g, ' ');
        const remarksFlat = norm(r.remarks);
        const buildingFlat = norm(feeProse);
        // 好幾句用「／」接起來的引文逐段判（第三十輪：282 前段在物件介紹、後段在房間備考，整段標成物件說明；
        // 3363「家財保険に加入／2年間￥5000」原文是「。」，前 10 字含「／」在哪都找不到，落到預設的物件說明）
        const whereOf = (q: string): string => {
          const segs = q.split('／').map((x) => norm(x).trim()).filter((x) => x !== '');
          const heads = segs.map((seg) => seg.slice(0, 10));
          const rem = heads.filter((h) => remarksFlat.includes(h) && !buildingFlat.includes(h)).length;
          const bld = heads.filter((h) => buildingFlat.includes(h)).length;
          return rem === 0 ? '物件說明' : bld === 0 ? '房間備考' : '物件說明與房間備考';
        };
        const whereP = (p: { sentence: string } | null | undefined): string => (p === null || p === undefined ? '物件說明' : whereOf(p.sentence));
        const floorApplies = depositFloor !== null && rent.known && rent.v.jpy <= depositFloor.maxRent;
        // 保証金欄空白時才讀說明文的「敷金…なし」（4027）；欄位有字就以欄位為準
        const proseNoDeposit = depositRaw.trim() === '' ? proseZeroDeposit(roomFeeProse) : null;
        const depositBase = floorApplies
          ? known(yen(depositFloor.amount), 'measured',
            `note「${depositFloor.text}」；賃料 ${rent.known ? rent.v.jpy : ''}円 ≤ ${depositFloor.maxRent}円`)
          : proseNoDeposit !== null
            ? known(yen(0), 'measured', `${whereOf(proseNoDeposit)}「${proseNoDeposit}」；入居条件的保証金欄空白`)
            : parsed.deposit;
        // 說明文對這間房另寫了不同的押金（2807「敷金40,000円(301号室)　30,000円(301号室以外)」，入居条件表是全棟的 ¥30,000）：
        // 兩處說法不一，不替原站挑——說明文金額照樣不採用
        const roomDep = roomDepositNote(feeProse, r.roomNo);
        // 說明文無條件寫出的押金與入居条件表不同（357 表「家賃1カ月分」、note「・保証金：10,000円(退去時50%…)」；
        // 4043 表「保証金無し」、說明「初期費用はデポジット￥20,000と…」）：同樣不替原站挑。
        // 表空白而說明文寫了金額（2664「(2) デポジット（保証金）20,000円」）：標「原站明寫要付」，金額照樣不採用
        const depAmounts = proseDepositAmounts(roomFeeProse, roomTypes);
        const depDiffers = depositBase.known
          ? depAmounts.find((a) => a.jpy !== undefined ? a.jpy !== depositBase.v.jpy
            : a.months !== undefined && rent.known && Math.round(a.months * rent.v.jpy) !== depositBase.v.jpy)
          : undefined;
        const deposit = roomDep !== null && depositBase.known && depositBase.v.jpy !== roomDep.amount
          ? conflicting<Yen>(`${depositBase.srcText}（入居条件表）／物件說明「${roomDep.text}」`)
          : depDiffers !== undefined
            ? conflicting<Yen>(`${depositBase.known ? depositBase.srcText : ''}（入居条件表）／物件說明「${depDiffers.sentence}」`)
            : !depositBase.known && depositBase.why === 'not_listed_on_page' && depositRaw.trim() === '' && depAmounts[0] !== undefined
              ? statedNoAmount<Yen>(`${whereOf(depAmounts[0].sentence)}「${depAmounts[0].sentence}」（說明文的金額不自動採用，見原文）；入居条件的保証金欄空白`)
              : depositBase;
        // 門檻改了保証金金額，入居条件表的償却比例是否照樣套在新金額上，原站沒寫——不替它算
        // 保証金本身說法不一（3764 表「家賃1カ月分（退去時50％償却）」、說明「保証金：30,000円(退去時50%…償却)」）：
        // 比例乘哪個基數分不出來，不退部分同樣不替原站挑（第三十輪）
        // 表沒寫償却、說明文寫了（282 note「保証金1ヶ月分（入居時50％償却）」）：標「原站明寫有」，比例不採用
        const amortized = !parsed.nonRefundable.known && parsed.nonRefundable.why === 'not_listed_on_page'
          ? proseDepositAmortized(roomFeeProse) : null;
        // 表算出會退一部分、說明文卻寫一毛不退（1319 表「¥50,000（退去時¥20,000返却）」、房間備考「※退室時、保証金返金はなし」，第三十一輪）
        const noRefund = parsed.nonRefundable.known && deposit.known && parsed.nonRefundable.v.jpy !== deposit.v.jpy
          ? proseDepositNoRefund(roomFeeProse) : null;
        const nonRefundable = floorApplies && parsed.nonRefundable.known
          ? statedNoAmount<Yen>(`保証金 ${depositRaw}；note 改以 ${depositFloor.amount}円 計，償却是否同比例未寫明`)
          : !deposit.known && deposit.why === 'conflicting' && parsed.nonRefundable.known && parsed.nonRefundable.v.jpy > 0
            ? conflicting<Yen>(`${parsed.nonRefundable.srcText}；但保証金本身入居条件表與說明文說法不一（見保証金欄），不退金額的基數未定`)
            : noRefund !== null && parsed.nonRefundable.known
              ? conflicting<Yen>(`${parsed.nonRefundable.srcText}（入居条件表）／${whereOf(noRefund)}「${noRefund}」`)
            : amortized !== null
              ? statedNoAmount<Yen>(`${whereOf(amortized)}「${amortized}」（說明文寫了償却，比例與基數不自動採用，見原文）；入居条件的保証金欄沒寫償却`)
              : parsed.nonRefundable;
        const fees = proseZeroFees(roomFeeProse);
        const condFees = proseUnadoptedZeroFees(roomFeeProse);
        const feeAmounts = proseFeeAmounts(roomFeeProse);
        const util = mergeUtilities(proseUtilities(roomFeeProse), faqUtil, whereOf);
        const guarantorProse = proseGuarantorFee(roomFeeProse);
        const renewalProse = proseRenewalFees(roomFeeProse);
        const cleaningProse = proseCleaningFees(roomFeeProse);
        // 運営者FAQ 只補「含在共益費」（3249「共益費には、水道光熱費、インターネット使用料…が含まれます」），同水電
        const netOwn = proseInternet(roomFeeProse);
        const netFaq = proseInternet(prose.faq);
        // 物件說明只有附條件、未採用的免收句時，FAQ 明寫含在共益費的照樣補上
        const netProse = netOwn !== null && netOwn.kind !== 'unadopted' ? netOwn : (netFaq?.kind === 'included' ? netFaq : netOwn);
        const fireIns = feeOf(fees, feeAmounts, 'fireInsurance', whereOf, condFees);
        // 「共益費（水光熱費・wi-fi・保険含む）」（3513、3820）：只寫「保険」，不當火災保険已含；頁面確實提到了，不標「此來源不公開」
        const bareIns = proseBareInsuranceInCommonFee(roomFeeProse);
        const fee = {
          keyMoney: feeOf(fees, feeAmounts, 'keyMoney', whereOf, condFees),
          agencyFee: feeOf(fees, feeAmounts, 'agencyFee', whereOf, condFees),
          guarantorInitialFee: proseFeeField(guarantorProse, false, whereP(guarantorProse)),
          fireInsurance: !fireIns.known && fireIns.why === 'not_offered_by_source' && bareIns !== null
            ? notListed<Yen>(`${whereOf(bareIns)}「${bareIns}」（原文只寫「保険」含在共益費，沒寫是不是火災／家財保険）`)
            : fireIns,
          keyExchangeFee: feeOf(fees, feeAmounts, 'keyExchangeFee', whereOf, condFees),
          contractFee: feeOf(fees, feeAmounts, 'contractFee', whereOf, condFees),
          cleaningFeeUpfront: proseFeeField(cleaningProse.cleaningFeeUpfront, cleaningProse.cleaningFeeUpfront?.timingUnstated === true, whereP(cleaningProse.cleaningFeeUpfront)),
          // 「契約金55,000円」：分不出是手續費還是初期費用總額，只標「有一筆契約時要付的錢」
          otherInitial: feeOf(fees, feeAmounts, 'otherInitial', whereOf),
          // 第二十七輪後：保證公司月費（「・月額保証料：1,830円」）與月付事務手数料（「事務手数料：990円/月」）
          otherMonthly: ((om) => proseOtherMonthlyField(om, om[0] === undefined ? '物件說明' : whereOf(om[0])))(proseOtherMonthly(roomFeeProse)),
          renewalFee: proseFeeField(renewalProse.renewalFee, false, whereP(renewalProse.renewalFee)),
          renewalAdminFee: proseFeeField(renewalProse.renewalAdminFee, false, whereP(renewalProse.renewalAdminFee)),
          cleaningFeeOnExit: proseFeeField(cleaningProse.cleaningFeeOnExit, false, whereP(cleaningProse.cleaningFeeOnExit)),
        };
        // 總括免收句（2227「家賃と共益費以外の費用が、かからないので…」，第三十輪）：只補頁面對那一項沒有其他說法的欄位；
        // 任何一欄明寫要付，就表示這句不能照字面用，整句不採用
        // 附近有活動或條件字眼（2227 後面是「期間限定キャンペーン…」）：不採用，但頁面確實提到了，標「頁面有提到」而不是「此來源不公開」
        const onlyRent = proseOnlyRentAndCommonFee(roomFeeProse);
        const blanketOk = onlyRent !== null && !Object.values(fee).some((f) => !f.known && f.basis === 'excluded_stated');
        const filled = (f: Field<Yen>): Field<Yen> => {
          if (!blanketOk || onlyRent === null || f.known || f.why !== 'not_offered_by_source') return f;
          const where = whereOf(onlyRent.sentence);
          return onlyRent.conditional
            ? notListed<Yen>(`${where}「${onlyRent.sentence}」（原文總括寫房租與共益費以外不收其他費用，但附近有條件或活動字眼，未採用）`)
            : known(yen(0), 'measured', `${where}「${onlyRent.sentence}」（原文總括寫房租與共益費以外不收其他費用）`);
        };
        // 「初期費用は…のみ」「それ以外にかかる費用は一切ございません」（第三十一輪 3163、332、2493）：只補入居時的各欄。
        // 明寫要付的入居時費用都得在清單裡（3275「初期費用：初月分の賃料日割りと事務手数料1.5万円のみ」的契約手数料）——
        // 清單外還有一欄明寫要付，這句就不能照字面用，整句不採用
        const initialOnly = proseInitialOnly(roomFeeProse);
        const INITIAL_TERM = {
          keyMoney: /礼金/, agencyFee: /仲介/, guarantorInitialFee: /保証料|保証会社|保証委託/, fireInsurance: /保険/,
          keyExchangeFee: /鍵|カギ|キー/, contractFee: /手数料|契約料/, cleaningFeeUpfront: /清掃|クリーニング/, otherInitial: /契約金|入居金|入館料|施設利用料/,
        } as const;
        const initialOk = initialOnly !== null && (Object.keys(INITIAL_TERM) as Array<keyof typeof INITIAL_TERM>)
          .every((k) => fee[k].known || fee[k].basis !== 'excluded_stated' || initialOnly.listed.some((n) => INITIAL_TERM[k].test(n)));
        const filledInitial = (f: Field<Yen>): Field<Yen> => {
          const g = filled(f);
          if (!initialOk || initialOnly === null || g.known || g.why !== 'not_offered_by_source') return g;
          const where = whereOf(initialOnly.sentence);
          return initialOnly.conditional
            ? notListed<Yen>(`${where}「${initialOnly.sentence}」（原文寫入居時只收清單上的費用，但附近有條件或活動字眼，未採用）`)
            : known(yen(0), 'measured', `${where}「${initialOnly.sentence}」（原文寫入居時只收清單上的費用）`);
        };
        const internetField = proseFeeField(netProse, false, netProse !== null && netProse === netFaq ? '運営者FAQ' : whereP(netProse));
        // 「毎月の支払いは…のみ」（3163「【毎月かかる費用】は「賃料」＋「水道光熱費（実費…）」のみ」、3399）：只補其他月費；
        // 明寫另收的水電、網路都得在清單裡才採用
        const monthlyOnly = proseMonthlyOnly(roomFeeProse);
        const monthlyOk = monthlyOnly !== null
          && (util === null || util.basis === 'included' || /水道|光熱|電気|ガス/.test(monthlyOnly.list))
          && (internetField.known || internetField.basis !== 'excluded_stated' || /ネット|Wi-?Fi|WiFi/i.test(monthlyOnly.list));
        const filledMonthly = (f: Field<Yen>): Field<Yen> => {
          const g = filled(f);
          if (!monthlyOk || monthlyOnly === null || g.known || g.why !== 'not_offered_by_source') return g;
          const where = whereOf(monthlyOnly.sentence);
          return monthlyOnly.conditional
            ? notListed<Yen>(`${where}「${monthlyOnly.sentence}」（原文寫每月只付清單上的費用，但句中有條件字眼，未採用）`)
            : known(yen(0), 'measured', `${where}「${monthlyOnly.sentence}」（原文寫每月只付清單上的費用）`);
        };
        const area = parseArea(r.areaRaw);
        const floor = parseTshFloor(r.floorRaw);
        const notes: string[] = [];
        if (r.remarks !== '') notes.push(`備考：${r.remarks}`);
        const noFurniture = proseSentences(r.remarks ?? '').find((x) => NO_FURNITURE.test(x));
        if (r.conditionRaw !== '') notes.push(`部屋入居条件：${r.conditionRaw}`);
        if (ruleText !== '') notes.push(`ハウスルール：${ruleText}`);
        // 活動區塊提到、其他地方都沒說的費用：標「頁面有提到」而不是「此來源不公開」（第三十二輪 3235）
        const camp = (key: CampaignKey, f: Field<Yen>): Field<Yen> => {
          const s = campaignMentions[key];
          if (s === undefined || f.known || f.why !== 'not_offered_by_source') return f;
          return notListed<Yen>(`物件說明的活動區塊「${s}」（只出現在活動區塊；費用不從活動條款採用）`);
        };

        return verbatimFields({
          id: `${buildingId}#${unitKey}`,
          buildingId,
          unitKey,
          sourceUrl: ref.url,
          roomNo: known(r.roomNo, 'measured', `部屋番号 ${r.roomNoRaw}`),
          layout: r.layout === '' ? notListed('') : known(r.layout, 'measured', `部屋種別 ${r.layout}`),
          // 面積欄未填時站方寫「0 ㎡」而不是留空——0 是佔位符不是面積，必須擋掉
          areaM2: area.kind === 'exact' && area.m2 > 0
            ? known(area.m2, 'measured', `広さ ${r.areaRaw}`)
            : notListed(r.areaRaw),
          floor,
          monthly: {
            rent,
            adminFee: moneyField(r.adminRaw, '共益費'),
            // 站方沒有水電欄位；只認說明文明寫「共益費にライフライン費用を含む」或「水光熱費は実費」（jp-parse/prose.ts）
            utilities: util === null
              ? camp('utilities', notOffered<Yen>())
              : util.basis === 'included'
                ? includedInOther(`${util.from}「${util.sentence}」`)
                : util.basis === 'partial'
                  // 只寫了某一部分另計（3595「電気代は各室使用分実費精算」，第三十一輪）：其餘含不含原文沒寫，不說「部分含在共益費」
                  ? statedNoAmount<Yen>(`${util.from}「${util.sentence}」（${util.someExcludedOnly === true ? '部分水電明寫另計，其餘是否含在共益費原文沒寫' : '部分含在共益費、部分另計'}；未取得確定金額，見原文）`)
                  : statedNoAmount<Yen>(`${util.from}「${util.sentence}」（另計；未取得確定金額，見原文）`),
            internet: camp('internet', internetField),
            otherMonthly: camp('otherMonthly', filledMonthly(fee.otherMonthly)),
          },
          initial: {
            keyMoney: camp('keyMoney', filledInitial(fee.keyMoney)),
            deposit,
            depositNonRefundable: nonRefundable,
            agencyFee: camp('agencyFee', filledInitial(fee.agencyFee)),
            guarantorInitialFee: camp('guarantorInitialFee', filledInitial(fee.guarantorInitialFee)),
            fireInsurance: camp('fireInsurance', carryOnOnly(filledInitial(fee.fireInsurance))),
            keyExchangeFee: camp('keyExchangeFee', filledInitial(fee.keyExchangeFee)),
            contractFee: camp('contractFee', filledInitial(fee.contractFee)),
            cleaningFeeUpfront: camp('cleaningFeeUpfront', filledInitial(fee.cleaningFeeUpfront)),
            otherInitial: camp('otherInitial', filledInitial(fee.otherInitial)),
          },
          deferred: {
            renewalFee: camp('renewalFee', filled(fee.renewalFee)),
            renewalAdminFee: camp('renewalAdminFee', filled(fee.renewalAdminFee)),
            cleaningFeeOnExit: camp('cleaningFeeOnExit', filled(fee.cleaningFeeOnExit)),
            earlyTerminationPenalty: notOffered<Yen>(),
          },
          utilitiesBasis: util === null || util.basis === 'partial' ? 'unknown' : util.basis,
          // 房內設備是逐項圖示的 on/off，有「ベッド」亮起就是站方明示房內附床。
          // 這間房自己的備考明寫沒有家具（第三十三輪 3235#0205「エアコン、天井照明付き/家具の設置はありません」、841#205、2195#105）：
          // 圖示亮床就是同一間房兩種說法 → conflicting；圖示沒亮床 → 明寫沒附
          furnished: noFurniture !== undefined
            ? r.equipmentOn.includes('bed')
              ? conflicting<boolean>(`部屋設備 ${r.equipmentOn.join(', ')}／房間備考「${noFurniture}」`)
              : known(false, 'measured', `房間備考「${noFurniture}」`)
            : r.equipmentOn.includes('bed')
              ? known(true, 'measured', `部屋設備 ${r.equipmentOn.join(', ')}`)
              : notListed(r.equipmentOn.join(', ')),
          availableFrom: buildingFull
            ? conflicting<string>(`建物層「ただいま満室です」與房間層「${r.status === 'available' ? '空室' : '空室予定'}」矛盾`)
            : r.status === 'available'
              ? known('随時', 'measured', '空室')
              : r.emptyDate !== null
                ? known(r.emptyDate, 'measured', `空室予定 ${r.emptyDate}`)
                : notListed(''),
          isVacant: buildingFull
            ? conflicting<boolean>(`建物層「ただいま満室です」與房間層「${r.status === 'available' ? '空室' : '空室予定'}」矛盾`)
            : known(r.status === 'available', 'measured',
              // srcText 只放頁面上的字：「（現時点は入居中）」是我們自己的說明，曾被驗證幫手當成假原文（2851）
              r.status === 'available' ? '空室' : `空室予定${r.emptyDate !== null ? ` ${r.emptyDate}` : ''}`),
          contractType: 'unknown',
          contractMonths: notOffered<number>(),
          minStayMonths: minStay === null
            ? notListed(conditions.get('min_contract') ?? '')
            : known(minStay, 'measured', `契約 ${conditions.get('min_contract') ?? ''}`),
          genderRestriction: genderOfRoom(r, buildingGender),
          ageLimitRaw: ageLimit,
          petsAllowed: /ペット不可/.test(ruleText)
            ? known(false, 'measured', `ルール ${ruleText}`)
            : /ペット可|ペット相談/.test(ruleText)
              ? known(true, 'measured', `ルール ${ruleText}`)
              : notListed(ruleText),
          foreigner: { ...foreigner, welcomed: welcomedOf(roomProse) },
          notes,
        } satisfies Unit, `${buildingProse}\n${prose.faq}\n${r.remarks}`);
      });

    return { building: verbatimFields(building, buildingProse), units };
  },
};

export default adapter;
