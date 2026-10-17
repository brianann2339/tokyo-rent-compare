/**
 * ひつじ不動産 adapter（東京 share house，1,244 件——首版最大且最有價值的來源）。
 *
 * 為什麼價值最高：全站只有日文，但資料層是完整結構化的，包括
 * `hasAvailableRoomForForeigner` 這種其他站要靠自由文字才判斷得出來的旗標。
 * 把它繁中化＋費用可比，正是這個專案的核心價值。
 *
 * 枚舉方式：列表 `?page=N` 逐頁讀、以 id 去重（2026-10-17 改；細節與改版經過見 `listUrl` 上方）。
 *   2026-08-16 時是累積式，取第 48 頁一次拿全部；站方改成一般分頁後那一頁變空的。
 *
 * 注意兩種回應格式差很多：一般 GET 的 HTML 只含 30 筆，
 * 帶 `RSC: 1` 標頭才拿得到完整 payload——這點若搞錯會默默只抓到 30 筆。
 *
 * 一棟要看兩頁（2026-09-06 修正）：
 *   詳情頁 `{webUrl}`      → 建物層的一切（constructionYear／stationData／
 *                            qualificationForeigner／tenancyPeriod）＋房間**預覽**（各房型上限 2 筆）
 *   房間頁 `{webUrl}/rooms` → 完整房間清單（鍵名是複數 singleRooms／dormitoryRooms）
 * 只抓詳情頁會少 32% 的可申請房（實測：站方自報 802 間，預覽只給得出 545 間）。
 */

import { reassembleFlight, extractObjects, extractArrayAfterKey } from '../../src/rsc.ts';
import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, includedInOther, statedNoAmount, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, UtilitiesBasis,
} from '../../../packages/schema/src/model.ts';
import { parseGenderTags, parseForeignerSignals, parseStayBucketsMinMonths } from '../../../packages/jp-parse/src/contract.ts';
import {
  proseZeroFees, proseUnadoptedZeroFees, proseFeeAmounts, proseYearBuilt, proseFloorsAboveGround, proseGuarantorFee, proseRenewalFees, proseCleaningFees,
  proseOtherMonthly, BLOCK_BREAK,
} from '../../../packages/jp-parse/src/prose.ts';
import { proseFeeField, proseOtherMonthlyField } from '../../src/prose-fields.ts';

export const manifest: SourceManifest = {
  id: 'hituji',
  name: 'ひつじ不動産',
  nameZh: '羊不動產（share house 情報站）',
  homepage: 'https://www.hituji.jp/',
  origin: 'https://www.hituji.jp',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'keyMoney',
      'layout', 'areaM2', 'roomNo', 'isVacant',
      'genderRestriction', 'foreignerWelcomed', 'stations', 'totalUnits',
      'yearBuilt',
      // 站上沒有樓數欄位；說明文明寫「4階建て」「5階建のビル」時才有值（2026-10-17 驗證幫手抓到 3 棟漏收）
      'floorsAboveGround',
      // 站上沒有這兩個欄位；只有物件說明文明寫「仲介料…全て【無料】」這種免收時才有值（jp-parse/prose.ts）
      'agencyFee', 'contractFee',
      // 站方以級距標籤刊登入居期間（「長期・4〜6か月」），有數字的頁面解得出最短月數。
      // 只寫「長期」的頁面沒有數字可讀，那是 not_listed_on_page 不是解析故障。
      'minStayMonths',
      // 設備區「回線 光ファイバー（無料）」（2026-10-17 第二十三輪：4 間被驗證者指出沒讀）
      'internet',
      // 同 agencyFee：說明文明寫「火災保険はオーナー負担」時才有值（2026-10-17：4 間）
      'fireInsurance', 'keyExchangeFee',
      // 2026-10-17 第二十五輪（與 TSH 同一套，jp-parse proseGuarantorFee 等）：說明文「敷金・礼金・仲介料・更新料全て【無料】」→ 0；
      // 入居条件「保証会社加入必須」→ 這頁沒寫初回保証料（不是來源不公開）
      'guarantorInitialFee', 'cleaningFeeUpfront', 'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit',
    ],
    // 這些欄位站上完全不刊登。宣告出來，健康檢查才不會對它們產生
    // 永遠 0% 的假警報——警報疲勞會讓人乾脆關掉整個監控。
    neverProvides: [
      'earlyTerminationPenalty', 'depositNonRefundable',
      'structure', 'petsAllowed',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null, // 首次執行時寫入
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測）只 Disallow /owner-members/、/admin-members/、' +
      '/comret/info/*/*/*/ask$、/sns/auth/，房源詳情頁未被禁止，無 Crawl-delay。' +
      '利用規約 https://www.hituji.jp/about/terms 著作權條：「…データベースの著作物、' +
      'およびこれらの二次的著作物について、…権利者に無断で複製、送信、放送、配付、貸与、' +
      '翻訳、変造、翻案することは、著作権侵害となり…」。' +
      '條款中未出現「スクレイピング」「クローラ」「自動取得」等字詞。' +
      '使用者已閱讀條款並裁決自行承擔（2026-08-16）。每筆房源均標註來源並連回原站。',
  },
};

/**
 * 列表頁 payload 的建物摘要。欄位名取自 2026-08-16 實測的 RSC payload。
 *
 * ⚠️ 這裡除了 `id`／`name`／`webUrl` 以外全部是選填，而且是**真的會消失**：
 * 2026-09-06 的覆蓋調查發現站方已把 `totalRoomCount`、`availableRoomCount`、
 * `nearestTrainStationName`、`transportationName`、`transportationTimeMinutes`、
 * `hasAvailableRoomForForeigner`、`minRent`／`maxRent`、`ownerName` 從列表 payload 拿掉。
 * 所以凡是用到這些欄位的地方都必須有「詳情頁 payload 的退路」（見 `parseDetail`）——
 * 少了退路，下一次 crawl 會把 1,243 棟的車站與 1,244 棟的總戶數靜默歸零，
 * 而 95% 閘門守的是棟數，這種歸零它不會擋。
 */
type HitujiSummary = {
  id: number;
  name: string;
  webUrl: string;
  eyecatchImageUrl?: string;
  eyecatchImageUrls?: string[];
  nearestTrainStationName?: string;
  transportationName?: string;
  transportationTimeMinutes?: number;
  hasOtherTransportations?: boolean;
  totalRoomCount?: number;
  hasAvailableRoom?: boolean;
  availableRoomCount?: number;
  hasAvailableRoomForMan?: boolean;
  hasAvailableRoomForWoman?: boolean;
  hasAvailableRoomForForeigner?: boolean;
  hasAvailableRoomForJapanese?: boolean;
  tenancyConditionDescription?: string;
  minRent?: number | null;
  maxRent?: number | null;
  ownerName?: string | null;
};

/** 詳情頁 payload 的房間。 */
type HitujiRoom = {
  id: number;
  number: string;
  sizeSquareMeter: string;
  sizeJou: string;
  rent: number;
  commonServiceFee: number;
  /**
   * 變動共益費的說明，例「実費」。
   * 空字串＝共益費是固定額；「実費」＝另有按實際用量計算的費用。
   */
  variableCommonServiceFee?: string;
  /** `commonServiceFee` 與 `variableCommonServiceFee` 的**顯示串接**，不是獨立金額。 */
  utilities?: string;
  deposit: number;
  keyMoney: number;
  availabilityCode: string;
  availabilityLabel: string;
  /** 由 adapter 依來源陣列補上：個室 vs ドミトリー（相部屋）。原始 payload 沒有這個欄位。 */
  __kind?: '個室' | 'ドミトリー';
};

/**
 * 列表分頁（2026-10-17 實測改版）：**一般分頁，每頁 30 筆、不累積**——
 * page 1／2／3 各 30 筆且彼此零重疊，page 47 回 0 筆（站方自報 1,240 筆 → 42 頁）。
 * 舊版（2026-08-16）是累積式（30 + 26×(N-1)），只抓第 48 頁就拿得到全部；
 * 改版後那一頁是空的，舊公式於是解出 0 筆（被 discover 的 95% 護欄擋下，舊資料未被覆寫）。
 *
 * 所以不再依賴任何分頁公式：從第 1 頁往下讀、以 id 去重，
 * 湊滿站方自報的筆數、或某一頁沒有新 id 就停。累積式與一般分頁都收得齊
 * （累積式只是多下載重複的卡片）。
 */
/** 保險上限，避免站方的筆數欄位壞掉時一路請求下去。1,240 筆／30 = 42 頁。 */
const MAX_PAGE = 80;

const listUrl = (page: number): string =>
  `https://www.hituji.jp/comret/info/tokyo?page=${page}`;

/** 站方自報的總筆數，用來判斷讀到哪一頁可以停、以及收齊了沒。 */
export function parseComretCount(payload: string): number | null {
  const m = /"comretCount":(\d+)/.exec(payload);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const SUMMARY_ANCHOR = /\{"id":\d+,"name":"(?:[^"\\]|\\.)*","comment":/;
const ROOM_ANCHOR = /\{"id":\d+,"number":"(?:[^"\\]|\\.)*","sizeSquareMeter":/;

export function parseSummaries(html: string): HitujiSummary[] {
  const buf = reassembleFlight(html);
  const objs = extractObjects<HitujiSummary>(buf, SUMMARY_ANCHOR);
  const seen = new Set<number>();
  const out: HitujiSummary[] = [];
  for (const o of objs) {
    if (typeof o.webUrl !== 'string' || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}

/**
 * 房間分別掛在 `singleRoom`（個室）與 `dormitoryRoom`（相部屋）兩個陣列下。
 * 合併前必須先記住來源——原始 payload 的房間物件本身沒有任何欄位可以區分，
 * 合併後就再也分不出來，會把相部屋標成個室。
 * （2026-08-16 親自比對 HAKUSAN HOUSE 原站時發現。）
 *
 * 詳情頁給的是**預覽**，兩個陣列各最多 2 筆；完整清單在 `{webUrl}/rooms`，
 * 那一頁的鍵名是**複數**（`singleRooms`／`dormitoryRooms`，掛在 `comretRooms` 底下）。
 * `extractArrayAfterKey` 是精確鍵比對，只餵單數鍵就永遠只撿得到那 2 筆預覽。
 * 單複數都收：同一份 payload 不會兩種都有，重複 id 由下面的 seen 濾掉。
 */
export function parseRooms(html: string): HitujiRoom[] {
  const buf = reassembleFlight(html);
  const pick = (keys: readonly string[]): HitujiRoom[] =>
    keys.flatMap((k) => extractArrayAfterKey<HitujiRoom>(buf, k));
  const tagged: HitujiRoom[] = [
    ...pick(['singleRoom', 'singleRooms']).map((r) => ({ ...r, __kind: '個室' as const })),
    ...pick(['dormitoryRoom', 'dormitoryRooms']).map((r) => ({ ...r, __kind: 'ドミトリー' as const })),
  ];
  // 兩個具名陣列都取不到時才退回錨點掃描，此時無法判斷房型
  const pool = tagged.length > 0 ? tagged : extractObjects<HitujiRoom>(buf, ROOM_ANCHOR);
  const seen = new Set<number>();
  return pool.filter((r) => {
    if (typeof r?.number !== 'string' || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function yenField(n: number | null | undefined, srcKey: string): Field<Yen> {
  if (typeof n !== 'number' || !Number.isFinite(n)) return notListed('');
  // 0 是結構化欄位明確給的值，有出處，不是猜的
  return known(yen(n), 'measured', `${srcKey}=${n}`);
}

function numField(raw: string | number | null | undefined, srcKey: string): Field<number> {
  if (raw === null || raw === undefined || raw === '') return notListed('');
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return unparsed(`${srcKey}=${String(raw)}`);
  return known(n, 'measured', `${srcKey}=${String(raw)}`);
}

/**
 * 水電基準的判定——讀 variableCommonServiceFee 的**內容**，不是看它空不空。
 *
 * 已查證（2026-08-16，抽 7 個物件 12 間房）：`utilities` 欄位是
 * `commonServiceFee` 與 `variableCommonServiceFee` 的顯示串接
 * （例：common=6000 + var="実費" → utilities="6000実費"）。當時抽到的變動欄只見過「実費」，
 * 於是寫成「非空就是另計」。
 *
 * 2026-10-17 第三輪驗證抓到反例，全量列出 1,240 棟的值（38 種）才看清楚這是運營者的自由文字欄：
 *   另計：「実費」「水道・ガス・光熱費は実費請求」「個室の電気、ガス、水道は個別に契約が必要」
 *   含在共益費：「共益費（水光熱費・wi-fi・保険含む）」「水道光熱費は共益費にふくまれます」
 *   無關：活動文案「家賃は2年プラン適用時の価格です…フリーレント付き！」（11 間曾被標成另計）、
 *        二人入居加價、寵物加價、駐輪場代、「0」「なし」
 *   說不準，維持 unknown：「光熱費は各室50KWまでは定額に含まれ、超過分は実費請求」（部分含）、
 *        「電気・ガス…は固定費に含まれます」（沒提水道）、「共益費は¥10000／月を前預かり後、年2回精算」
 * 空字串 → **unknown**。站上「光熱」「水道」等字在 payload 中零出現，沒有任何依據可以宣稱含水電。
 */
export function utilitiesBasisOfText(t: string): UtilitiesBasis {
  if (t === '') return 'unknown';
  const mentionsInclusion = /含|込|ふくま|定額/.test(t);
  if (/実費|個別に契約|別途/.test(t) && !mentionsInclusion) return 'excluded';
  // 「ライフライン費￥11000」（share-house-180-kamiitabashi）：共益費之外另列的水電費
  if (/(?:水道光熱|水光熱|光熱|ライフライン)費?\s*[￥¥]\s*[\d,]+/.test(t) && !mentionsInclusion) return 'excluded';
  const included = /(?:水道光熱|水光熱|光熱水)[^。]{0,20}(?:含ま|含む|ふくま|込み)/.test(t)
    || /共益費[（(][^）)]*(?:水道光熱|水光熱|光熱水)[^）)]*含む[）)]/.test(t);
  if (included && !/実費|超過|上回|オーバー|別途/.test(t)) return 'included';
  return 'unknown';
}

function utilitiesBasisOf(r: HitujiRoom): UtilitiesBasis {
  return utilitiesBasisOfText(variableFeeOf(r));
}

/**
 * 共益費欄顯示 ￥0、附註卻寫「共益費は入居者で頭割り（¥3000〜¥8000）」（machida-forest 101）：
 * 0 是版面上的佔位，不是「不收共益費」。存 0 會讓這間在比價裡平白便宜 3,000〜8,000 円，
 * 改存「明寫要付、金額不固定」。只在結構化值為 0 且附註明說共益費由住戶分攤時才改。
 */
export function adminFeeOf(r: HitujiRoom): Field<Yen> {
  const note = variableFeeOf(r);
  if (r.commonServiceFee === 0 && /共益費[^。]{0,12}(?:頭割|割り勘|割勘|按分|案分|折半|住人で割|入居者で割)/.test(note)) {
    return statedNoAmount<Yen>(`commonServiceFee=0；共益費欄附註「${note}」（共益費由住戶分攤，金額不固定）`);
  }
  return yenField(r.commonServiceFee, 'commonServiceFee');
}

/** `/rooms` 頁的房間物件形狀尚未實測過，缺欄位時不可讓 `.trim()` 把整棟炸掉。 */
function variableFeeOf(r: HitujiRoom): string {
  return typeof r.variableCommonServiceFee === 'string' ? r.variableCommonServiceFee.trim() : '';
}

/** 詳情頁 `locations.stationData[]` 的一筆交通。 */
type HitujiStation = {
  trainStationName?: string;
  primaryTrainLineName?: string;
  methodCode?: string;
  methodName?: string;
  timeMinutes?: number;
  remarks?: string;
};

/**
 * 詳情頁 payload 裡屬於「這一棟」的結構化欄位。
 *
 * ⚠️ 地雷：詳情頁尾端的「類似物件」區塊帶著**列表摘要的完整 schema**
 * （`totalRoomCount`、`availableRoomCount`、`nearestTrainStationName`、
 * `hasAvailableRoomForForeigner`…）。對這些扁平鍵下 regex 抓到的是**別棟**的值——
 * 2026-09-06 實測 1,244 頁，用第一個 `hasAvailableRoomForForeigner` 有 227 頁與本棟不符。
 * 所以這裡只用「類似物件沒有的鍵」：`townName`、`constructionYear`、`stationData`、
 * `singleRoomAvailability`／`dormitoryRoomAvailability`、`qualificationForeigner`、
 * `tenancyPeriod`。這幾個鍵每頁各出現 2 次（同一份資料渲染兩遍），
 * 實測 1,244 頁兩次的值完全相同，取第一個即可。
 */
type HitujiDetail = {
  /** 站方給的真實区名（例「港区」），優先於 URL 的 romaji slug。 */
  readonly townName: string | null;
  /** 「建物の建築年」。null＝站方有這個欄位、但這一頁沒填（實測 477/1,244 頁）。 */
  readonly constructionYear: number | null;
  /** 去重後的交通清單，第 0 筆就是站方認定的最寄駅（實測 1,243/1,243 與列表摘要一致）。 */
  readonly stations: readonly HitujiStation[];
  /** 個室＋ドミトリー 的總室數；null＝兩個 availability 物件解不出來。 */
  readonly totalRoomCount: number | null;
  /** 入居条件「外国人」欄的原文。空字串＝站方有這個欄位、但這一頁沒寫（實測 128/1,244 頁）。 */
  readonly qualificationForeigner: string;
  /** 入居条件「日本人」欄的原文（「身分証明書、緊急連絡先、保証会社加入必須。」）。只用來判保證公司。 */
  readonly qualificationJapanese: string;
  /** 入居期間，例「長期」「長期・4〜6か月」。 */
  readonly tenancyPeriod: string;
  /**
   * 物件說明文（payload `description.comment`）。2026-10-17 實測 1,240 頁都出現兩次、title 都等於本棟名稱；
   * 其中 28 頁的 comment 是 RSC 參照（"$24"），本檔不解析 flight 協定（見 rsc.ts 檔頭），那幾棟視為空字串。
   */
  readonly description: string;
  /**
   * 頁面「所在地」（payload `address`；同區塊另有 `ownerAddress`＝業者事務所，不是這個）。
   * 2026-10-17 驗證幫手指出舊版把 addressRaw 寫死成空字串。實測 1,240 頁：每頁正好 2 次、值相同；
   * 955 頁是「東京都〇〇区…」，其餘是空字串、只寫「東京都」或省略都名——照原文存，不補。
   */
  readonly address: string;
  /**
   * 設備區「インターネット」（payload `internet: {has, networkName, caption}`；2026-10-17 實測 1,240 個詳情頁每頁 2 份、內容相同）。
   * null＝這頁沒有這個物件。
   */
  readonly internet: { readonly has: boolean; readonly caption: string } | null;
  /** 頁面 CAMPAIGN 區塊（payload `communicationOptionMessage`）；2026-10-17 實測 1,639 頁裡 88 頁有。 */
  readonly campaign: string;
};

/** 取某個鍵之後的 JSON 字串值（第一個）。 */
function stringAfterKey(buf: string, key: string): string | null {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(buf);
  if (m?.[1] === undefined) return null;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
}

/**
 * `singleRoomAvailability`／`dormitoryRoomAvailability` 的 totalCount。
 * 值為 `null`＝這一棟沒有這種房型 → 0 室；鍵不存在或解不出來 → null（不是 0，不可當 0 加）。
 */
function availabilityTotal(buf: string, key: string): number | null {
  const m = new RegExp(`"${key}":(null|\\{[^}]*\\})`).exec(buf);
  if (m?.[1] === undefined) return null;
  if (m[1] === 'null') return 0;
  const t = /"totalCount":(\d+)/.exec(m[1]);
  return t?.[1] === undefined ? null : Number(t[1]);
}

export function parseDetail(payload: string): HitujiDetail {
  const buf = reassembleFlight(payload);
  const town = stringAfterKey(buf, 'townName');
  const single = availabilityTotal(buf, 'singleRoomAvailability');
  const dorm = availabilityTotal(buf, 'dormitoryRoomAvailability');
  const year = /"constructionYear":(\d+)/.exec(buf);
  // stationData 在同一頁渲染兩遍，extractArrayAfterKey 會把兩份接起來 → 去重
  const seen = new Set<string>();
  const stations = extractArrayAfterKey<HitujiStation>(buf, 'stationData')
    .filter((st) => {
      const k = JSON.stringify(st);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    townName: town === null || town === '' ? null : town,
    constructionYear: year?.[1] === undefined ? null : Number(year[1]),
    stations,
    totalRoomCount: single === null || dorm === null ? null : single + dorm,
    qualificationForeigner: stringAfterKey(buf, 'qualificationForeigner') ?? '',
    qualificationJapanese: stringAfterKey(buf, 'qualificationJapanese') ?? '',
    tenancyPeriod: [...new Set(extractArrayAfterKey<string>(buf, 'tenancyPeriod'))].join('・'),
    address: (stringAfterKey(buf, 'address') ?? '').trim(),
    description: descriptionOf(buf),
    internet: internetOf(buf),
    campaign: stringAfterKey(buf, 'communicationOptionMessage') ?? '',
  };
}

/**
 * CAMPAIGN 區塊只拿來證明「這筆費用平常存在」，不拿活動的減免當值（減免有條件：內覽當天申請、住滿一年…）。
 * 例：「内見当日のお申し込みの方限定！事務手数料￥20,000円→タダ！」「事務手数料0円＆…（1年以上ご入居の方限定）」
 * 「事務手数料半額」「10月は初回保証料も0円」。2026-10-17 第二十三輪 kameido-plaisir#202：
 * 舊版只讀物件說明，這筆被存成「來源不提供」；與 Social Apartment 活動欄礼金同一處理（明講有、金額不採用）。
 */
export function hitujiCampaignFees(msg: string): { contractFee?: Field<Yen>; guarantorInitialFee?: Field<Yen> } {
  const t = msg.replace(/\s+/g, ' ').trim();
  if (t === '') return {};
  const note = `活動欄「${t.length > 120 ? `${t.slice(0, 120)}…` : t}」（活動條件下才減免＝平常要付；金額不採用）`;
  return {
    ...(/事務手数料|契約手数料/.test(t) ? { contractFee: statedNoAmount<Yen>(note) } : {}),
    ...(/初回保証料/.test(t) ? { guarantorInitialFee: statedNoAmount<Yen>(note) } : {}),
  };
}

function internetOf(buf: string): HitujiDetail['internet'] {
  const m = /"internet":\{"has":(true|false)(?:,"networkName":(?:"(?:[^"\\]|\\.)*"|null))?(?:,"caption":("(?:[^"\\]|\\.)*"|null))?\}/.exec(buf);
  if (m === null) return null;
  let caption = '';
  try { caption = m[2] === undefined || m[2] === 'null' ? '' : JSON.parse(m[2]) as string; } catch { caption = ''; }
  return { has: m[1] === 'true', caption: /^\$[0-9a-z]+$/i.test(caption) ? '' : caption };
}

/**
 * 網路費。設備區 caption 的第一行是「回線 〈種類〉（〈費用〉）」，後面「＊」開頭是補充。
 * 2026-10-17 全量盤點 1,639 頁：「（無料）」佔絕大多數；另有「（￥2100/月）」「（¥1000。）」「（入居人数で頭割り。）」
 * 「（￥6090を入居人数で頭割り。）」「（なし）」，以及補充寫「居室での利用は個別契約」「LAN利用料金は￥1000/月」。
 * - 要另外簽約、與住戶分攤、或另有一筆收費 → 原站說了要付，但沒有這間房可採用的單一金額
 * - 沒寫是月付還是一次付（「¥1000。」）→ 同上，不猜
 * - 「（なし）」分不出是免費還是沒有回線 → 未知
 */
export function hitujiInternet(net: HitujiDetail['internet']): Field<Yen> {
  if (net === null) return notOffered<Yen>();
  if (!net.has) return notListed<Yen>('internet.has=false（站方標示沒有網路設備）');
  const cap = net.caption.replace(/\r/g, '');
  const src = `設備「${cap.replace(/\n/g, ' ')}」`;
  const first = cap.split('\n')[0] ?? '';
  const rest = cap.split('\n').slice(1).join('\n');
  const fee = /（([^）]*)）/.exec(first)?.[1] ?? '';
  // 「居室での利用は個別契約」才是房間要另簽；「膨大なデータ使用の際は別途個別契約…場合があります」是特殊用量，一般使用仍免費
  if (/(?:居室|個室|専有部)[^。]{0,20}(?:個別|個人)(?:に)?契約|頭割|割る|人数/.test(cap)) {
    return statedNoAmount<Yen>(`${src}（房間要另外簽約或與住戶分攤，金額不採用）`);
  }
  if (/共益費.{0,6}含/.test(fee)) return includedInOther(src);
  const monthly = /^[￥¥]\s*([\d,]+)\s*[/／]\s*月。?$/.exec(fee);
  const otherYen = /[￥¥]\s*[\d,]+/.test(rest);
  if (monthly !== null) {
    return otherYen ? statedNoAmount<Yen>(`${src}（另有一筆收費，金額不採用）`) : known(yen(Number((monthly[1] ?? '').replace(/,/g, ''))), 'measured', src);
  }
  if (/無料/.test(fee) || (fee === '-' && /＊無料/.test(rest))) {
    // 「＊共益費月額￥10000に含む。」裡的金額是共益費，不是另一筆網路費
    if (/共益費.{0,12}含/.test(rest)) return includedInOther(src);
    if (otherYen) return statedNoAmount<Yen>(`${src}（部分用法另收費，金額不採用）`);
    return known(yen(0), 'measured', src);
  }
  if (/^[￥¥]\s*[\d,]+。?$/.test(fee)) return statedNoAmount<Yen>(`${src}（沒寫是月付還是一次付，金額不採用）`);
  if (fee === 'なし') return notListed<Yen>(`${src}（「なし」分不出是免費還是沒有回線）`);
  return unparsed<Yen>(src);
}

function descriptionOf(buf: string): string {
  const m = /"description":\{"title":"(?:[^"\\]|\\.)*","subTitle":"(?:[^"\\]|\\.)*","comment":"((?:[^"\\]|\\.)*)"/.exec(buf);
  if (m?.[1] === undefined) return '';
  let text: string;
  try { text = JSON.parse(`"${m[1]}"`) as string; } catch { return ''; }
  return /^\$[0-9a-z]+$/i.test(text) ? '' : text;
}

/**
 * 「外国人可」旗標。
 *
 * 第一來源是列表摘要的 `hasAvailableRoomForForeigner`；2026-09 起該欄可能整個不見，
 * 退回入居条件標籤列（`tenancyConditionDescription`）。實測 1,244 棟：
 * 標籤列含「外国人」與該旗標為 true **完全一致（1,244/1,244）**，所以標籤列在的時候
 * 可以雙向判定；標籤列也是空的才算未知。
 * 詳情頁 payload 裡那個扁平的 `hasAvailableRoomForForeigner` **不可以用**——
 * 它屬於頁尾的類似物件（實測 227/1,244 頁與本棟不符）。
 */
function welcomedOf(s: HitujiSummary, tags: string): Field<boolean> {
  const flag = s.hasAvailableRoomForForeigner;
  if (typeof flag === 'boolean') return known(flag, 'measured', `hasAvailableRoomForForeigner=${flag}`);
  if (tags === '') return notListed('');
  return known(tags.includes('外国人'), 'measured', `tenancyConditionDescription=${tags}`);
}

function foreignerPolicy(s: HitujiSummary, d: HitujiDetail): ForeignerPolicy {
  const tags = s.tenancyConditionDescription ?? '';
  // 入居条件是 payload 的結構化欄位 `qualificationForeigner`，不是頁面文字。
  // 2026-09-06 之前這裡用「整頁第一個『外国人』」的 regex 去撈，
  // 介紹文裡先出現「外国人」的物件就會抓到招租文案而不是條件欄
  // （實測 1,244 棟有 50 棟撈到的文字與結構化欄位不符），該棟的在留卡／日語／
  // 保証会社需求也跟著掉成未知。
  const req = d.qualificationForeigner;
  const sig = req === '' ? null : parseForeignerSignals(req);
  const boolField = (v: boolean | null | undefined): Field<boolean> =>
    typeof v === 'boolean' ? known(v, 'measured', req) : notListed(req);
  return {
    welcomed: welcomedOf(s, tags),
    residenceCardRequired: sig === null ? notListed('') : boolField(sig.residenceCard),
    japaneseRequired: sig === null ? notListed('') : boolField(sig.japanese),
    guarantorCompanyRequired: sig === null ? notListed('') : boolField(sig.guarantorCompany),
    guarantorPersonRequired: sig === null ? notListed('') : boolField(sig.guarantorPerson),
    rawText: [tags, req === '' ? '' : `外国人：${req}`].filter((x) => x !== '').join('\n'),
  };
}

/**
 * 最寄駅。
 *
 * 第一來源改成詳情頁的 `stationData`：那是唯一帶路線名的地方
 * （列表摘要的 `transportationName` 是交通方式「徒歩／バス」，不是路線），
 * 而且列表摘要的三個車站欄位 2026-09 起可能整組消失。
 * 實測 1,243/1,243 棟 `stationData[0].trainStationName` 與列表摘要的
 * `nearestTrainStationName` 完全相同，所以換來源不會換掉「哪一站」。
 *
 * stationData 每棟最多列到 5 站。2026-09-06 版只輸出第 0 站；2026-10-17 驗證幫手指出頁面明列的
 * 第 2 站以後全被丟掉（例：RooF 明大前 只剩代田橋、少了明大前 13 分），改為照順序全部輸出。
 * 跨來源同棟比對因此多了車站可比，建置後重新跑 alias:candidates 人審。
 */
function stationsOf(s: HitujiSummary, d: HitujiDetail): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  d.stations.forEach((st, i) => {
    if (typeof st.trainStationName !== 'string' || st.trainStationName === '') return;
    const line = st.primaryTrainLineName ?? '';
    const station = st.trainStationName.replace(/駅$/, '');
    if (seen.has(`${line}|${station}`)) return;
    seen.add(`${line}|${station}`);
    const mins = st.timeMinutes;
    const method = st.methodName ?? '';
    // 自轉車站的備註只寫「徒歩25分。」（communityhouse-tobu-nerimatokumaru 的上板橋、西台，第三十輪）：站方另寫了走路分鐘數。
    // 巴士站的「「井口八幡入口」下車　徒歩5分」是下車後走路、不是到車站，不收
    const remark = st.remarks ?? '';
    const walkRemark = st.methodCode === 'bicycle'
      ? /^\s*[＊*]?\s*徒歩\s*(\d+)\s*分[。.]?\s*$/.exec(remark.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)))
      : null;
    out.push({
      line,
      station,
      walkMinutes: st.methodCode === 'walk' && typeof mins === 'number'
        ? known(mins, 'measured', `stationData[${i}].timeMinutes=${mins}`)
        : walkRemark?.[1] !== undefined
          ? known(Number(walkRemark[1]), 'measured', `stationData[${i}].remarks「${remark}」`)
          : notListed(`${method}${mins ?? ''}`),
      rawText: `${st.trainStationName} ${method}${mins ?? ''}分${remark !== '' && walkRemark !== null ? ` ${remark}` : ''}`,
    });
  });
  if (out.length > 0) return out;
  const name = s.nearestTrainStationName;
  if (typeof name !== 'string' || name === '') return [];
  const mins = s.transportationTimeMinutes;
  const isWalk = s.transportationName === '徒歩';
  return [{
    line: '',
    station: name.replace(/駅$/, ''),
    walkMinutes: isWalk && typeof mins === 'number'
      ? known(mins, 'measured', `transportationTimeMinutes=${mins}`)
      : notListed(`${s.transportationName ?? ''}${mins ?? ''}`),
    rawText: `${name} ${s.transportationName ?? ''}${mins ?? ''}分${s.hasOtherTransportations === true ? ' 他' : ''}`,
  }];
}

/** 從 webUrl 取出 `/comret/info/tokyo/{ward}/{slug}` 的 ward 與 slug。 */
export function keysFromUrl(url: string): { ward: string; slug: string } | null {
  const m = /\/comret\/info\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/.exec(new URL(url).pathname);
  if (m?.[2] === undefined || m[3] === undefined) return null;
  return { ward: m[2], slug: m[3] };
}

/**
 * 總戶數。列表摘要的 `totalRoomCount` 是第一來源；2026-09 起該欄可能不存在，
 * 退回詳情頁的 singleRoomAvailability.totalCount + dormitoryRoomAvailability.totalCount。
 * 實測 1,244 棟兩者完全相等（1,244/1,244），退路不會換來另一個口徑。
 */
function totalUnitsOf(s: HitujiSummary, d: HitujiDetail): Field<number> {
  if (typeof s.totalRoomCount === 'number') return numField(s.totalRoomCount, 'totalRoomCount');
  if (d.totalRoomCount === null) return notListed('');
  return known(d.totalRoomCount, 'measured',
    `singleRoomAvailability.totalCount+dormitoryRoomAvailability.totalCount=${d.totalRoomCount}`);
}

/**
 * 結構化的 constructionYear 優先；沒填時才讀說明文明寫的築年（jp-parse/prose.ts）。
 * 2026-10-17 用有填 constructionYear 的 34 棟對照說明文規則：31 棟同年、3 棟差一年
 * （2019年築 vs 2020、2016年築 vs 2015、2018年新築 vs 2017）——是運營者自己兩處寫法不一，
 * 不是規則抓錯；所以說明文的年份照原句存，srcText 留整句讓人看得到出處。
 */
function yearBuiltOf(d: HitujiDetail, fetchedAt: string): Field<number> {
  if (d.constructionYear !== null) {
    return known(d.constructionYear, 'measured', `constructionYear=${d.constructionYear}`);
  }
  const p = proseYearBuilt(d.description, Number(fetchedAt.slice(0, 4)));
  return p === null ? notListed('') : known(p.year, 'measured', `物件說明「${p.sentence}」`);
}

/**
 * 站上沒有樓數欄位，只認說明文明寫（jp-parse/prose.ts：「N階建て」，地下層、改裝與メゾネット句不算）。
 * 房間樓層**不**從相簿標籤「2F ROOM」推：2026-10-17 掃 486 頁，6 間房同時被標兩個不同樓層、
 * 42 間標籤樓層與房號首碼不一致，還有「0F ROOM」「-1F ROOM」——那是運營者自填的相簿分組，不是樓層欄位。
 */
function floorsAboveGroundOf(d: HitujiDetail): Field<number> {
  const p = proseFloorsAboveGround(d.description);
  return p === null ? notListed('') : known(p.floors, 'measured', `物件說明「${p.sentence}」`);
}

function buildBuilding(s: HitujiSummary, raw: RawDoc, ctx: ExtractContext, d: HitujiDetail): Building | null {
  const keys = keysFromUrl(s.webUrl);
  if (keys === null) return null;
  const images = s.eyecatchImageUrls ?? (s.eyecatchImageUrl !== undefined ? [s.eyecatchImageUrl] : []);
  return {
    id: `hituji:${keys.ward}/${keys.slug}`,
    sourceId: 'hituji',
    sourceKey: `${keys.ward}/${keys.slug}`,
    sourceUrl: s.webUrl,
    name: s.name,
    kind: 'sharehouse',
    addressRaw: d.address,
    prefecture: '東京都',
    ward: d.townName ?? keys.ward,
    stations: stationsOf(s, d),
    structure: notOffered<string>(),
    // 這個來源不標建物種別（マンション／アパート…）；那是 SUUMO 這類入口站才有的欄位
    buildingType: notOffered<string>(),
    // 站上有「建物の建築年」這個欄位（payload 的 constructionYear，實測 767/1,244 頁有值），
    // 2026-09-06 之前這裡硬寫 notOffered＝「來源根本沒有這個欄位」，那是錯的 why：
    // health 的填充率與 unparsed 告警都不會對 not_offered 出聲，缺口永遠不會浮出來。
    yearBuilt: yearBuiltOf(d, raw.fetchedAt),
    floorsAboveGround: floorsAboveGroundOf(d),
    totalUnits: totalUnitsOf(s, d),
    imageUrls: images,
    fetchedAt: raw.fetchedAt,
    sourceUpdatedAt: notListed(''),
    htmlSha256: raw.sha256,
    ...(ctx.now ? {} : {}),
  };
}

/**
 * 空室 vs 空室予定。
 *
 * 實測 1,244 頁只出現兩種 code：`empty`→「空室」（現在可入住）、
 * `scheduled`→「空室予定」（還沒空出來）。2026-09-06 之前寫成
 * `availabilityCode !== 'occupied'`，把 128 間「空室予定」標成現在有空房，
 * 與 tokyosharehouse／borderless 同義狀態標 false 的做法相反，
 * 網站預設的「只看有空房」會把還沒空的房算進去。
 * 沒見過的 code 標 unparsed（唯一會觸發 health 告警的狀態），不猜。
 */
function vacancyOf(r: HitujiRoom): Field<boolean> {
  const src = `availabilityCode=${r.availabilityCode}`;
  if (r.availabilityCode === 'empty') return known(true, 'measured', src);
  if (r.availabilityCode === 'scheduled' || r.availabilityCode === 'occupied') {
    return known(false, 'measured', src);
  }
  return unparsed<boolean>(src);
}

/**
 * 整個 house 在同一層的明寫句（第三十輪 chezelle-8「ハウスは全て建物2階部分の為、防犯面でも安心感があります」）：
 * 站方沒有房間樓層欄，說明文明寫整個 house／全部房間在第 N 層時，每間房都是 N 樓。
 * 寫了兩層以上（「シェアハウスは2・3階」「4階〜5階部分」「ハウスは1階3部屋、2階4部屋」）、「N階建て」、
 * 沒有主詞（「4階部分につき、陽当り絶好！」）、只講某一間（「お部屋は1階は広めの…」）都不收；
 * 全文寫出兩個不同樓層也不收。2026-10-17 對 1,701 頁說明文全量掃描、逐句看過後定的四種寫法。
 */
const HOUSE_FLOOR: readonly RegExp[] = [
  // 「ハウスは全て建物2階部分」「シェアハウスは、建物の2階なので」「ハウスは建物の、最上階3階まるごと1フロア」「ハウスは9階の東南角部屋！」
  /^(?:当)?(?:シェア)?ハウスは、?(?:全て|すべて)?、?(?:建物の?、?)?(?:最上階)?\s*([1-9][0-9]?)\s*(?:階|[FＦ])(?!\s*(?:建|以上|以下|[〜～\-ー・、と]|[0-9]))/,
  // 「お部屋は全5室ですべて2階。」「お部屋はエレベーターなしの4階ですが」
  /^お部屋は(?:全\s*[0-9]+\s*室で)?(?:すべて|全て)?[^。、0-9]{0,12}?([1-9][0-9]?)\s*(?:階|[FＦ])(?:です|。|$)/,
  // 「高級分譲マンションの4階部分です。」「ビルの2Fにあります。」「徒歩2分のビルの4階にあります。」
  /(?:マンション|ビル)の\s*([1-9][0-9]?)\s*(?:階|[FＦ])(?:部分)?(?:です|にあります)/,
  // 「一軒家の2階部分をゲストハウスとして利用」「「ADDress聖蹟桜ヶ丘A邸」の2階を、2026年9月より女性専用・ペット可のシェアハウスとして」（第三十一輪）
  // 「戸建ての2階、3階部分を」「マンションの2，4，5階部分を」是好幾層，「の」後面不是單一個樓層，不收
  /の\s*([1-9][0-9]?)\s*階(?:部分)?を[^。]{0,40}?(?:シェアハウス|ゲストハウス)として/,
];
export function houseFloorOf(description: string): { floor: number; sentence: string } | null {
  const found = new Map<number, string>();
  for (const sentence of description.split(/(?<=[。！!])|\n/).map((x) => x.trim()).filter((x) => x !== '')) {
    const t = sentence.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    for (const re of HOUSE_FLOOR) {
      const m = re.exec(t);
      if (m?.[1] !== undefined) { if (!found.has(Number(m[1]))) found.set(Number(m[1]), sentence); break; }
    }
  }
  if (found.size !== 1) return null;
  const [hit] = [...found];
  return hit === undefined ? null : { floor: hit[0], sentence: hit[1] };
}

function buildUnit(
  buildingId: string, sourceUrl: string, s: HitujiSummary, r: HitujiRoom,
  d: HitujiDetail,
): Unit {
  const basis = utilitiesBasisOf(r);
  const zeroNotOffered = notOffered<Yen>();
  // 礼金／敷金有結構化欄位，不讀說明文；仲介／契約手数料／火災保険／鍵交換站上沒有欄位：說明文明寫免收＝0，
  // 直接寫了金額＝原站明寫要付但金額不採用（與 TSH 同一套，見 jp-parse/prose.ts proseFeeAmounts）
  const fees = proseZeroFees(d.description);
  const condFees = proseUnadoptedZeroFees(d.description);
  const feeAmounts = proseFeeAmounts(d.description);
  const campaign = hitujiCampaignFees(d.campaign);
  // 保證公司常寫在入居条件（日本人／外国人欄）而不是說明文
  // 三個區塊（說明文／日本人入居条件／外國人入居条件）判條件時不互相跨（BLOCK_BREAK）
  const qualText = [d.description, d.qualificationJapanese, d.qualificationForeigner].join(`\n${BLOCK_BREAK}\n`);
  const guarantor = proseGuarantorFee(qualText);
  const renewal = proseRenewalFees(d.description);
  const cleaning = proseCleaningFees(d.description);
  const houseFloor = houseFloorOf(d.description);
  const proseFee = (key: 'agencyFee' | 'contractFee' | 'fireInsurance' | 'keyExchangeFee'): Field<Yen> => {
    const z = fees[key];
    if (z !== undefined) return known(yen(0), 'measured', `物件說明「${z}」`);
    const a = feeAmounts[key];
    if (a !== undefined) return statedNoAmount<Yen>(`物件說明「${a}」（說明文的金額不自動採用，見原文）`);
    const fromCampaign = key === 'contractFee' ? campaign.contractFee : undefined;
    if (fromCampaign !== undefined) return fromCampaign;
    // 寫了免收但沒採用（同 TSH，第三十輪）：值照舊未知，標「頁面有提到」而不是「此來源不公開」
    const u = condFees[key];
    return u === undefined ? zeroNotOffered : notListed<Yen>(`物件說明「${u.sentence}」（${u.reason === 'conditional'
      ? '免收句附近有條件或活動字眼，未採用' : '免收句與頁面另一處帶金額或條件的說法並存，未採用'}）`);
  };
  return {
    id: `${buildingId}#${r.number}`,
    buildingId,
    unitKey: String(r.id),
    sourceUrl,
    roomNo: known(r.number, 'measured', `number=${r.number}`),
    layout: r.__kind === undefined
      ? notListed('')
      : known(r.__kind, 'measured', r.__kind === '個室' ? 'singleRoom[]' : 'dormitoryRoom[]'),
    areaM2: numField(r.sizeSquareMeter, 'sizeSquareMeter'),
    floor: houseFloor === null
      ? notListed('')
      : known(houseFloor.floor, 'measured', `物件說明「${houseFloor.sentence}」（整個 house 在同一層）`),
    monthly: {
      rent: yenField(r.rent, 'rent'),
      adminFee: adminFeeOf(r),
      // ⚠️ payload 的 `utilities` **不是**另一筆水電費，是 commonServiceFee 的顯示字串
      // （2026-09-06 回頭核對 data/raw 原文：`"commonServiceFee":15000,
      // "variableCommonServiceFee":"","utilities":"15000"`）。把它當成水電金額收下來，
      // 等於把同一筆共益費在 adminFee 與 utilities 各記一次，月額直接灌水一倍。
      // 所以這裡一律不採用；srcText 要寫清楚是「共益費的重複顯示」，
      // 否則稽核時會看成「金額明明就在原文裡卻沒收」。
      // 另計：自由文字或說明文裡可能寫了金額或估計（「ライフライン費￥11000」「月7000円～10000円が目安」），
      // 金額不自動採用（常帶條件或只是目安）。srcText 不可以寫「金額未載明」——2026-10-17 驗證幫手抓到
      // 說明文別處明明寫了估計值；只說「未取得確定金額」，叫人去看原文。
      utilities: basis === 'excluded'
        ? statedNoAmount<Yen>(`variableCommonServiceFee=${variableFeeOf(r)}（另計；未取得確定金額，見原文）`)
        : basis === 'included'
          ? includedInOther(`variableCommonServiceFee=${variableFeeOf(r)}`)
          : variableFeeOf(r) !== ''
            ? notListed(`共益費欄附註「${variableFeeOf(r)}」無法判定是否含水電；payload 的 utilities=「${r.utilities ?? ''}」是共益費 ${r.commonServiceFee ?? ''} 接上附註文字的顯示字串，不是水電金額`)
            : notListed(`站方未單列水電費；payload 的 utilities=「${r.utilities ?? ''}」是共益費 ${r.commonServiceFee ?? ''} 的重複顯示，不是水電金額`),
      internet: hitujiInternet(d.internet),
      otherMonthly: proseOtherMonthlyField(proseOtherMonthly(qualText), '物件說明／入居条件'),
    },
    initial: {
      keyMoney: yenField(r.keyMoney, 'keyMoney'),
      deposit: yenField(r.deposit, 'deposit'),
      depositNonRefundable: zeroNotOffered,
      agencyFee: proseFee('agencyFee'),
      guarantorInitialFee: campaign.guarantorInitialFee ?? proseFeeField(guarantor, false, '物件說明／入居条件'),
      fireInsurance: proseFee('fireInsurance'),
      keyExchangeFee: proseFee('keyExchangeFee'),
      contractFee: proseFee('contractFee'),
      cleaningFeeUpfront: proseFeeField(cleaning.cleaningFeeUpfront, cleaning.cleaningFeeUpfront?.timingUnstated === true),
      otherInitial: zeroNotOffered,
    },
    deferred: {
      renewalFee: proseFeeField(renewal.renewalFee),
      renewalAdminFee: proseFeeField(renewal.renewalAdminFee),
      cleaningFeeOnExit: proseFeeField(cleaning.cleaningFeeOnExit),
      earlyTerminationPenalty: zeroNotOffered,
    },
    utilitiesBasis: basis,
    furnished: notListed(''),
    // 欄位定義是「ISO 日期或『随時』」：empty（空室）＝随時；scheduled（空室予定）payload 與頁面都沒給日期 → 未知。
    // 2026-10-17 之前直接存站方字樣「空室」「空室予定」，與其他來源的值域不一致。
    availableFrom: r.availabilityCode === 'empty'
      ? known('随時', 'measured', `availabilityLabel=${r.availabilityLabel}`)
      : notListed(`availabilityLabel=${r.availabilityLabel}（站方沒給日期）`),
    isVacant: vacancyOf(r),
    contractType: 'unknown',
    contractMonths: notListed(''),
    // 入居期間是 payload 的結構化陣列 tenancyPeriod（實測 1,244/1,244 頁都有）。
    // 之前用頁面文字的 regex 只撈得到第一個值，1,244 棟中有 76 棟因此漏掉
    // 「長期・4〜6か月」這種複數值裡的短期選項。
    //
    // 這個欄位是可接受停留長度的**集合**，最短居住期間＝所有級距下界的最小值
    // （見 jp-parse/contract.ts 的 parseStayBucketsMinMonths）。
    // 只寫「長期」時沒有月數可讀 → 維持未知，原文留在 srcText 與備考。
    // 先前這裡一律 notListed，等於對「長期・4〜6か月」這種寫了數字的頁面
    // 斷言「頁面沒寫」——那句話是假的。
    minStayMonths: minStayOf(d.tenancyPeriod),
    genderRestriction: parseGenderTags(s.tenancyConditionDescription ?? ''),
    ageLimitRaw: notListed(''),
    petsAllowed: notOffered<boolean>(),
    foreigner: foreignerPolicy(s, d),
    notes: [
      // 這一欄是運營者的自由文字（活動文案、二人入居加價也寫在這裡），標籤不替它定性
      ...(variableFeeOf(r) !== '' ? [`共益費欄附註：${variableFeeOf(r)}`] : []),
      ...(d.tenancyPeriod !== '' ? [`入居期間：${d.tenancyPeriod}`] : []),
    ],
  };
}

/**
 * ひつじ的 `tenancyPeriod` → 最短居住期間。
 * basis 用 'measured'：數字是站方自己列的級距下界，不是我們推估的。
 */
function minStayOf(tenancyPeriod: string): Field<number> {
  const m = parseStayBucketsMinMonths(tenancyPeriod);
  return m === null
    ? notListed<number>(tenancyPeriod)
    : known(m, 'measured', `入居期間 ${tenancyPeriod}`);
}

/** discover 把完整房間清單放進 hint 的鍵名。 */
const FULL_ROOMS = '__fullRooms';

/**
 * 這一棟要不要另外去拿完整房間清單 `{webUrl}/rooms`。
 *
 * 為什麼需要：詳情頁的 singleRoom／dormitoryRoom 只是**預覽**，各上限 2 筆。
 * 實測 1,244 棟——站方自報的 availableRoomCount 合計 802 間，
 * 從詳情頁只解得出 545 間，差 257 間（32% 的可申請房從來沒進過我們的資料）。
 * 完整清單在 `{webUrl}/rooms`（1,244 頁的 payload 都寫了 roomsUrl，
 * 且 1,244/1,244 恰好等於 webUrl + '/rooms'），鍵名是複數的
 * `comretRooms.singleRooms`／`dormitoryRooms`。
 *
 * 為什麼不乾脆改抓 /rooms 取代詳情頁（那樣請求數不變）：
 * `constructionYear`（767 棟的築年）、`stationData`（唯一有路線名的地方）、
 * `qualificationForeigner`（入居条件）、`tenancyPeriod`（入居期間）都只在詳情頁，
 * 換過去等於拿這四項去換那 257 間房。所以是「詳情頁照抓 + 有空房的再補一次 /rooms」。
 *
 * 判斷條件只用「站方明說沒有空房」這一個否定條件，不用
 * 「availableRoomCount > 預覽上限」這種聰明版：實測有 2 棟
 * （arakawa/access-higashi-ogu、itabashi/shintoshin-itabashi3）availableRoomCount=2
 * 但詳情頁的預覽陣列整個不存在，聰明版會把它們漏掉。
 * 舊版列表 schema 下要多抓 363 頁；新版 schema 沒有這兩個欄位時退為全部 1,244 頁。
 */
function needsFullRoomList(s: HitujiSummary): boolean {
  return s.hasAvailableRoom !== false && s.availableRoomCount !== 0;
}

/**
 * 完整清單優先、詳情頁預覽補位，以 room id 去重。
 * 兩份都留是因為兩邊都可能缺：/rooms 取不到時預覽是唯一來源，
 * 而預覽每種房型上限 2 筆、拿不到完整清單就一定不齊。
 */
function mergeRooms(full: unknown, preview: readonly HitujiRoom[]): HitujiRoom[] {
  const list = Array.isArray(full) ? (full as HitujiRoom[]) : [];
  const seen = new Set<number>();
  const out: HitujiRoom[] = [];
  for (const r of [...list, ...preview]) {
    if (typeof r?.number !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    // 先讀第一頁拿站方自報的總筆數，再往下讀到湊滿為止——
    // 寫死頁碼會在房源數成長後默默漏抓，這種漏抓不會有任何錯誤訊息。
    const first = await fetcher.get(listUrl(1), { headers: { RSC: '1' } });
    const count = parseComretCount(first.body);
    const byId = new Map<number, HitujiSummary>();
    let pages = 0;
    for (let page = 1; page <= MAX_PAGE; page++) {
      const body = page === 1 ? first.body : (await fetcher.get(listUrl(page), { headers: { RSC: '1' } })).body;
      pages = page;
      let fresh = 0;
      for (const s of parseSummaries(body)) {
        if (byId.has(s.id)) continue;
        byId.set(s.id, s);
        fresh += 1;
      }
      if (fresh === 0 || count === null || byId.size >= count) break;
    }
    const summaries = [...byId.values()];

    if (count !== null && summaries.length < count * 0.95) {
      throw new Error(
        `[hituji] 讀了 ${pages} 頁只解析出 ${summaries.length} 筆，但站方自報 ${count} 筆——` +
        '列表格式或分頁方式可能又改了，請重新確認',
      );
    }

    let roomsFailed = 0;
    let firstRoomsError = '';
    for (const s of summaries) {
      const hint = { ...s } as unknown as Record<string, unknown>;
      if (needsFullRoomList(s)) {
        const url = `${s.webUrl.replace(/\/$/, '')}/rooms`;
        try {
          hint[FULL_ROOMS] = parseRooms((await fetcher.get(url)).body);
        } catch (e) {
          // 取不到就退回詳情頁的預覽（不齊，但是真的）。離線重解析時本機沒有
          // /rooms 原始檔，會全部走這條路——所以要在最後把筆數講出來，
          // 不能讓「房間變少」看起來像網站上真的沒房。
          roomsFailed += 1;
          if (firstRoomsError === '') {
            firstRoomsError = `${url} — ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      yield { url: s.webUrl, hint };
    }
    if (roomsFailed > 0) {
      console.warn(
        `  ⚠ hituji：${roomsFailed} 棟拿不到完整房間清單（/rooms），` +
        `這些棟只剩詳情頁預覽（每種房型最多 2 間）。首例：${firstRoomsError}`,
      );
    }
  },

  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null {
    const s = ref.hint as unknown as HitujiSummary | undefined;
    if (s === undefined || typeof s.webUrl !== 'string') return null;
    const detail = parseDetail(raw.body);
    const building = buildBuilding(s, raw, ctx, detail);
    if (building === null) return null;
    const rooms = mergeRooms(ref.hint?.[FULL_ROOMS], parseRooms(raw.body));
    const units = rooms.map((r) => buildUnit(building.id, s.webUrl, s, r, detail));
    return { building, units };
  },
};

export default adapter;
