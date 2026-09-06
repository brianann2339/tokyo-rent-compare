/**
 * ひつじ不動産 adapter（東京 share house，1,244 件——首版最大且最有價值的來源）。
 *
 * 為什麼價值最高：全站只有日文，但資料層是完整結構化的，包括
 * `hasAvailableRoomForForeigner` 這種其他站要靠自由文字才判斷得出來的旗標。
 * 把它繁中化＋費用可比，正是這個專案的核心價值。
 *
 * 枚舉方式（2026-08-16 實測）：
 *   列表 `?page=N` 是**累積式**——page 1 給 30 筆卡片、page 2 給 56、每頁 +26。
 *   page=48 一次回傳全部 1,244 筆（3.5 MB / 17 秒）。
 *   所以**取一次剛好蓋住全部的那一頁**就好，48 個請求變 2 個（含讀總數那次），
 *   對對方負載反而比逐頁抓更輕。（page=100 回空，上界在 50 與 100 之間。）
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
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, UtilitiesBasis,
} from '../../../packages/schema/src/model.ts';
import { parseGenderTags, parseForeignerSignals, parseStayBucketsMinMonths } from '../../../packages/jp-parse/src/contract.ts';

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
      // 站方以級距標籤刊登入居期間（「長期・4〜6か月」），有數字的頁面解得出最短月數。
      // 只寫「長期」的頁面沒有數字可讀，那是 not_listed_on_page 不是解析故障。
      'minStayMonths',
    ],
    // 這些欄位站上完全不刊登。宣告出來，健康檢查才不會對它們產生
    // 永遠 0% 的假警報——警報疲勞會讓人乾脆關掉整個監控。
    neverProvides: [
      'agencyFee', 'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee',
      'contractFee', 'cleaningFeeUpfront', 'renewalFee', 'renewalAdminFee',
      'cleaningFeeOnExit', 'earlyTerminationPenalty', 'depositNonRefundable',
      'structure', 'floorsAboveGround', 'petsAllowed',
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
 * 累積式分頁的實測參數（2026-08-16）：
 *   卡片數 = FIRST_PAGE_SIZE + PAGE_INCREMENT × (page - 1)
 *   page 1 → 30 筆、page 2 → 56、page 3 → 82…、page 48 → 1,244（全部）
 * 因為是累積的，只要取「剛好蓋住全部」的那一頁就好，不必逐頁抓。
 */
const FIRST_PAGE_SIZE = 30;
const PAGE_INCREMENT = 26;
/** 實測 page=100 回空，上界在 50–100 之間；設個保險上限避免請求到無效頁。 */
const MAX_PAGE = 80;

const listUrl = (page: number): string =>
  `https://www.hituji.jp/comret/info/tokyo?page=${page}`;

/** 站方自報的總筆數，用來反推需要哪一頁。 */
export function parseComretCount(payload: string): number | null {
  const m = /"comretCount":(\d+)/.exec(payload);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function pageForCount(count: number): number {
  if (count <= FIRST_PAGE_SIZE) return 1;
  return Math.min(MAX_PAGE, Math.ceil((count - FIRST_PAGE_SIZE) / PAGE_INCREMENT) + 1);
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
 * 水電基準的判定。
 *
 * 已查證（2026-08-16，抽 7 個物件 12 間房）：`utilities` 欄位是
 * `commonServiceFee` 與 `variableCommonServiceFee` 的顯示串接
 * （例：common=6000 + var="実費" → utilities="6000実費"）。
 *
 * 所以：
 *   variableCommonServiceFee 非空（如「実費」）→ 明確另計 → excluded
 *   空字串 → **unknown**。站上「光熱」「水道」等字在 payload 中零出現，
 *           沒有任何依據可以宣稱含水電。share house 慣例上多半含，
 *           但慣例不是這一頁的事實，不可據此填值。
 */
function utilitiesBasisOf(r: HitujiRoom): UtilitiesBasis {
  return variableFeeOf(r) !== '' ? 'excluded' : 'unknown';
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
  /** 入居期間，例「長期」「長期・4〜6か月」。 */
  readonly tenancyPeriod: string;
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
    tenancyPeriod: [...new Set(extractArrayAfterKey<string>(buf, 'tenancyPeriod'))].join('・'),
  };
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
 * stationData 每棟最多列到 5 站，這裡**仍然只輸出最寄的那一站**——
 * 輸出全部會改變跨來源比對用的車站集合，不在這次修正的範圍內。
 */
function stationsOf(s: HitujiSummary, d: HitujiDetail): readonly Station[] {
  const st = d.stations[0];
  if (st !== undefined && typeof st.trainStationName === 'string' && st.trainStationName !== '') {
    const mins = st.timeMinutes;
    const method = st.methodName ?? '';
    return [{
      line: st.primaryTrainLineName ?? '',
      station: st.trainStationName.replace(/駅$/, ''),
      walkMinutes: st.methodCode === 'walk' && typeof mins === 'number'
        ? known(mins, 'measured', `stationData[0].timeMinutes=${mins}`)
        : notListed(`${method}${mins ?? ''}`),
      rawText: `${st.trainStationName} ${method}${mins ?? ''}分${d.stations.length > 1 ? ' 他' : ''}`,
    }];
  }
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
    addressRaw: '',
    prefecture: '東京都',
    ward: d.townName ?? keys.ward,
    stations: stationsOf(s, d),
    structure: notOffered<string>(),
    // 這個來源不標建物種別（マンション／アパート…）；那是 SUUMO 這類入口站才有的欄位
    buildingType: notOffered<string>(),
    // 站上有「建物の建築年」這個欄位（payload 的 constructionYear，實測 767/1,244 頁有值），
    // 2026-09-06 之前這裡硬寫 notOffered＝「來源根本沒有這個欄位」，那是錯的 why：
    // health 的填充率與 unparsed 告警都不會對 not_offered 出聲，缺口永遠不會浮出來。
    yearBuilt: d.constructionYear === null
      ? notListed('')
      : known(d.constructionYear, 'measured', `constructionYear=${d.constructionYear}`),
    floorsAboveGround: notOffered<number>(),
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

function buildUnit(
  buildingId: string, sourceUrl: string, s: HitujiSummary, r: HitujiRoom,
  d: HitujiDetail,
): Unit {
  const basis = utilitiesBasisOf(r);
  const zeroNotOffered = notOffered<Yen>();
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
    floor: notListed(''),
    monthly: {
      rent: yenField(r.rent, 'rent'),
      adminFee: yenField(r.commonServiceFee, 'commonServiceFee'),
      // ⚠️ payload 的 `utilities` **不是**另一筆水電費，是 commonServiceFee 的顯示字串
      // （2026-09-06 回頭核對 data/raw 原文：`"commonServiceFee":15000,
      // "variableCommonServiceFee":"","utilities":"15000"`）。把它當成水電金額收下來，
      // 等於把同一筆共益費在 adminFee 與 utilities 各記一次，月額直接灌水一倍。
      // 所以這裡一律不採用；srcText 要寫清楚是「共益費的重複顯示」，
      // 否則稽核時會看成「金額明明就在原文裡卻沒收」。
      utilities: basis === 'excluded'
        ? { known: false, why: 'not_listed_on_page', basis: 'excluded_stated', srcText: `variableCommonServiceFee=${variableFeeOf(r)}（另計，金額未載明）` }
        : notListed(`站方未單列水電費；payload 的 utilities=「${r.utilities ?? ''}」是共益費 ${r.commonServiceFee ?? ''} 的重複顯示，不是水電金額`),
      internet: notOffered<Yen>(),
      otherMonthly: notOffered<Yen>(),
    },
    initial: {
      keyMoney: yenField(r.keyMoney, 'keyMoney'),
      deposit: yenField(r.deposit, 'deposit'),
      depositNonRefundable: zeroNotOffered,
      agencyFee: zeroNotOffered,
      guarantorInitialFee: zeroNotOffered,
      fireInsurance: zeroNotOffered,
      keyExchangeFee: zeroNotOffered,
      contractFee: zeroNotOffered,
      cleaningFeeUpfront: zeroNotOffered,
      otherInitial: zeroNotOffered,
    },
    deferred: {
      renewalFee: zeroNotOffered,
      renewalAdminFee: zeroNotOffered,
      cleaningFeeOnExit: zeroNotOffered,
      earlyTerminationPenalty: zeroNotOffered,
    },
    utilitiesBasis: basis,
    furnished: notListed(''),
    availableFrom: known(r.availabilityLabel, 'measured', `availabilityLabel=${r.availabilityLabel}`),
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
      ...(variableFeeOf(r) !== '' ? [`共益費另有變動部分：${variableFeeOf(r)}`] : []),
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
    // 先讀第一頁拿站方自報的總筆數，再反推該取哪一頁——
    // 寫死頁碼會在房源數成長後默默漏抓，這種漏抓不會有任何錯誤訊息。
    const first = await fetcher.get(listUrl(1), { headers: { RSC: '1' } });
    const count = parseComretCount(first.body);
    const summaries = count === null || count <= FIRST_PAGE_SIZE
      ? parseSummaries(first.body)
      : parseSummaries((await fetcher.get(listUrl(pageForCount(count)), { headers: { RSC: '1' } })).body);

    if (count !== null && summaries.length < count * 0.95) {
      throw new Error(
        `[hituji] 只解析出 ${summaries.length} 筆，但站方自報 ${count} 筆——` +
        `分頁公式可能已失效（實測值 first=${FIRST_PAGE_SIZE}, inc=${PAGE_INCREMENT}），請重新確認`,
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
