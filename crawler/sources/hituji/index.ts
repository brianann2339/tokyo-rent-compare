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
 */

import { reassembleFlight, extractObjects, extractArrayAfterKey } from '../../src/rsc.ts';
import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, UtilitiesBasis,
} from '../../../packages/schema/src/model.ts';
import { parseGenderTags, parseForeignerSignals } from '../../../packages/jp-parse/src/contract.ts';

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
    ],
    // 這些欄位站上完全不刊登。宣告出來，健康檢查才不會對它們產生
    // 永遠 0% 的假警報——警報疲勞會讓人乾脆關掉整個監控。
    neverProvides: [
      'agencyFee', 'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee',
      'contractFee', 'cleaningFeeUpfront', 'renewalFee', 'renewalAdminFee',
      'cleaningFeeOnExit', 'earlyTerminationPenalty', 'depositNonRefundable',
      'yearBuilt', 'structure', 'floorsAboveGround', 'petsAllowed',
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

/** 列表頁 payload 的建物摘要。欄位名取自 2026-08-16 實測的 RSC payload。 */
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
  variableCommonServiceFee: string;
  /** `commonServiceFee` 與 `variableCommonServiceFee` 的**顯示串接**，不是獨立金額。 */
  utilities: string;
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
 */
export function parseRooms(html: string): HitujiRoom[] {
  const buf = reassembleFlight(html);
  const tagged: HitujiRoom[] = [
    ...extractArrayAfterKey<HitujiRoom>(buf, 'singleRoom').map((r) => ({ ...r, __kind: '個室' as const })),
    ...extractArrayAfterKey<HitujiRoom>(buf, 'dormitoryRoom').map((r) => ({ ...r, __kind: 'ドミトリー' as const })),
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
  return r.variableCommonServiceFee.trim() !== '' ? 'excluded' : 'unknown';
}

/** 把 HTML 標籤換成分隔符，取得可掃描的純文字。 */
function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜{2,}/g, '｜');
}

/** 詳情頁 payload 的 `townName` 是站方給的真實区名（例「港区」），優先於 URL 的 romaji slug。 */
export function parseTownName(payload: string): string | null {
  const m = /"townName":"((?:[^"\\]|\\.)*)"/.exec(reassembleFlight(payload));
  if (m?.[1] === undefined || m[1] === '') return null;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
}

/**
 * 詳情頁的入居条件是渲染後的 HTML 文字，不在 RSC payload 裡（實測 2026-08-16：
 * payload 中「入居条件」「入居期間」零出現）。所以這兩項只能從 HTML 抽。
 */
export function parseTenancyFromHtml(html: string): { foreignerReq: string; japaneseReq: string; term: string } {
  const t = htmlText(html);
  const fm = /外国人｜?：?｜?([^｜]{5,200})/.exec(t);
  const jm = /日本人｜?：?｜?([^｜]{5,200})/.exec(t);
  const tm = /入居期間｜([^｜]{1,20})/.exec(t);
  return {
    foreignerReq: fm?.[1]?.trim() ?? '',
    japaneseReq: jm?.[1]?.trim() ?? '',
    term: tm?.[1]?.trim() ?? '',
  };
}

function foreignerPolicy(s: HitujiSummary, req: string): ForeignerPolicy {
  const tags = s.tenancyConditionDescription ?? '';
  const flag = s.hasAvailableRoomForForeigner;
  const sig = req === '' ? null : parseForeignerSignals(req);
  const boolField = (v: boolean | null | undefined): Field<boolean> =>
    typeof v === 'boolean' ? known(v, 'measured', req) : notListed(req);
  return {
    welcomed: typeof flag === 'boolean'
      ? known(flag, 'measured', `hasAvailableRoomForForeigner=${flag}`)
      : notListed(tags),
    residenceCardRequired: sig === null ? notListed('') : boolField(sig.residenceCard),
    japaneseRequired: sig === null ? notListed('') : boolField(sig.japanese),
    guarantorCompanyRequired: sig === null ? notListed('') : boolField(sig.guarantorCompany),
    guarantorPersonRequired: sig === null ? notListed('') : boolField(sig.guarantorPerson),
    rawText: [tags, req === '' ? '' : `外国人：${req}`].filter((x) => x !== '').join('\n'),
  };
}

function stationsOf(s: HitujiSummary): readonly Station[] {
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

function buildBuilding(s: HitujiSummary, raw: RawDoc, ctx: ExtractContext, townName: string | null): Building | null {
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
    ward: townName ?? keys.ward,
    stations: stationsOf(s),
    structure: notOffered<string>(),
    yearBuilt: notOffered<number>(),
    floorsAboveGround: notOffered<number>(),
    totalUnits: numField(s.totalRoomCount, 'totalRoomCount'),
    imageUrls: images,
    fetchedAt: raw.fetchedAt,
    sourceUpdatedAt: notListed(''),
    htmlSha256: raw.sha256,
    ...(ctx.now ? {} : {}),
  };
}

function buildUnit(
  buildingId: string, sourceUrl: string, s: HitujiSummary, r: HitujiRoom,
  tenancy: { foreignerReq: string; term: string },
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
      utilities: basis === 'excluded'
        ? { known: false, why: 'not_listed_on_page', basis: 'excluded_stated', srcText: `variableCommonServiceFee=${r.variableCommonServiceFee}` }
        : notListed(`utilities=${r.utilities}`),
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
    isVacant: known(r.availabilityCode !== 'occupied', 'measured', `availabilityCode=${r.availabilityCode}`),
    contractType: 'unknown',
    contractMonths: notListed(''),
    minStayMonths: notListed(tenancy.term),
    genderRestriction: parseGenderTags(s.tenancyConditionDescription ?? ''),
    ageLimitRaw: notListed(''),
    petsAllowed: notOffered<boolean>(),
    foreigner: foreignerPolicy(s, tenancy.foreignerReq),
    notes: [
      ...(r.variableCommonServiceFee.trim() !== '' ? [`共益費另有變動部分：${r.variableCommonServiceFee}`] : []),
      ...(tenancy.term !== '' ? [`入居期間：${tenancy.term}`] : []),
    ],
  };
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

    for (const s of summaries) {
      yield { url: s.webUrl, hint: s as unknown as Record<string, unknown> };
    }
  },

  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null {
    const s = ref.hint as unknown as HitujiSummary | undefined;
    if (s === undefined || typeof s.webUrl !== 'string') return null;
    const building = buildBuilding(s, raw, ctx, parseTownName(raw.body));
    if (building === null) return null;
    const rooms = parseRooms(raw.body);
    const tenancy = parseTenancyFromHtml(raw.body);
    const units = rooms.map((r) => buildUnit(building.id, s.webUrl, s, r, tenancy));
    return { building, units };
  },
};

export default adapter;
