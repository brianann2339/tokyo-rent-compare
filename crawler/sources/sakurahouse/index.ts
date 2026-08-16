/**
 * SAKURA HOUSE（サクラハウス）adapter——東京／京都的外國人向 share house・apartment・dormitory。
 *
 * 收錄它的理由：它是少數把「月額全包」講清楚的來源。每個房間下面都逐字印著
 * 「Utility costs such as electricity, water, gas, furniture and regular maintenance
 * are all included in the stated price.」——有這句話，水電與管理費的 0 才是**有依據的 0**，
 * 才能跟 UR（水電另計）放在同一把尺上比。多語系介面（含繁體中文）與外國人取向也是使用者的需求。
 *
 * ⚠️ 取得方式與其他來源不同，三件事要先知道：
 *
 * 1. **必須用真實瀏覽器**。站在 Cloudflare 後面，純 HTTP 客戶端取首頁與 /sitemap.xml
 *    一律 403 + managed challenge（2026-08-16 實測）；真實瀏覽器載入則直接放行、
 *    不需要任何人機驗證。所以 transport='browser'、fetchMode='none'，
 *    由 discover 用 ./browser.ts 一次把資料備齊，執行器不再抓詳情頁。
 *    我們**不做**任何繞過 challenge 的事——細節見 browser.ts 檔頭。
 *
 * 2. **清單頁的房源連結是 JS 渲染的**：`/building/` 的原始 HTML 有 122KB 但
 *    `/building/{slug}` 連結數為 0，渲染後才有 95 個。
 *
 * 3. **房間資料取自頁面自己載入的 GraphQL 回應**，不是 DOM。
 *    房間清單是 React embed（`#embed-room-list-view`），class 名帶 build hash
 *    （`RoomListView__UnitHeader-j6p6o2-5`），照著刻正則等於綁死對方的 build。
 *    頁面向 sakurahouse-production.an.r.appspot.com/graphql 要的那份 JSON 才是
 *    畫面的真正來源，欄位有名字、數值是數字，不必猜。
 *    ⚠️ 我們沒有另外去打那個端點——是在瀏覽器載入這一頁的過程中，
 *    把它自己收到的回應讀下來。這份 payload 沒有相容性承諾，
 *    所以解析不到要大聲失敗，不可默默產出空資料。
 *
 * ⚠️ 已知的坑，動這個檔前先看：
 *   - **dormitory 的房間層 displayRate 是 0**，真正的價錢在 `room.beds[]` 上。
 *     把房間層的 0 當賃料就是虛構一個 0 円房間——所以有 beds 的房間一律
 *     改成「一張床一個 Unit」。同理，dorm 房間的 60m² 是**整間**的面積，
 *     不是一張床的面積，床的 areaM2 一律留未知。
 *   - `room.available` 與畫面上的 AVAILABLE/OCCUPIED **不一致**
 *     （神楽坂 101 是 available=false 但畫面顯示 AVAILABLE）。
 *     以 displayOccupiedLabel／displayAvailableLabel 為準，那才是畫面的依據。
 *   - `bed.discountedRateMonth` 出現過 0（田端 C 的 BED 06）。只用 displayRate。
 */

import { createHash } from 'node:crypto';

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, includedInOther, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, PropertyKind, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { ChromeSession } from './browser.ts';

const SITE = 'https://www.sakura-house.com';

export const manifest: SourceManifest = {
  id: 'sakurahouse',
  name: 'サクラハウス',
  nameZh: 'Sakura House',
  homepage: 'https://www.sakura-house.com/',
  origin: SITE,
  transport: 'browser',
  // 資料在 discover 階段就由瀏覽器備齊，執行器不必也不能再用 HTTP 抓一次（會被 403）
  fetchMode: 'none',
  crawlDelayMs: 5000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'utilities', 'areaM2', 'roomNo', 'floor',
      'isVacant', 'availableFrom', 'furnished', 'genderRestriction',
      'stations', 'totalUnits', 'sourceUpdatedAt',
    ],
    // 建物頁完全不刊登初期費用與契約條件——那是預約時才報價的。
    // 宣告出來，健康檢查才不會對它們產生永遠 0% 的假警報。
    neverProvides: [
      'keyMoney', 'deposit', 'depositNonRefundable', 'agencyFee',
      'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee', 'contractFee',
      'cleaningFeeUpfront', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'otherMonthly', 'layout', 'contractType', 'contractMonths', 'minStayMonths',
      'ageLimitRaw', 'petsAllowed',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
      'structure', 'yearBuilt', 'floorsAboveGround',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測，HTTP 200，全文三行）：'
      + '「User-Agent: *」「Disallow:」（空值＝全站允許）「Sitemap: https://www.sakura-house.com/sitemap.xml」。'
      + '無 Crawl-delay，自訂 5 秒間隔、單執行緒。'
      + '⚠️ 利用規約 https://www.sakura-house.com/en/termsofuse（2026-08-16 HTTP 200）著作權條逐字：'
      + '"The copyright to all work on this website, including images, videos, text, and illustrations '
      + '(hereinafter generally referred to as "Content"), belongs to the Company or the author of the Content. '
      + 'Therefore, the unauthorized usage, reproduction, revision, or distribution of all website Content '
      + 'without prior permission from the Company or copyright holder of the Content is prohibited."'
      + ' 同頁 Links 條逐字要求連結前先以 email 告知網址與連結目的，並載明 '
      + '"the Company may deny the link at its own discretion"。'
      + '⚠️ 這兩條與本站的引用方式有潛在衝突（本站標示出處並連回原站，但未事前 email 告知）。'
      + '使用者已於 2026-08-16 閱讀上述條文並裁決自行承擔。'
      + '⚠️ Cloudflare：純 HTTP 客戶端取首頁與 sitemap.xml 皆 403 + managed challenge；'
      + '本 adapter 只用真實瀏覽器正常載入頁面，不做任何 challenge 繞過、不完成任何人機驗證。'
      + '⚠️ 房間資料取自頁面自己載入的 GraphQL 回應（sakurahouse-production.an.r.appspot.com/graphql），'
      + '我們未另行呼叫該端點，也未使用其未公開的查詢介面。'
      + '⚠️ 建物街道地址雖在該 payload 中，但原站頁面刻意不顯示，'
      + '因此本站只保留到「都道府県＋市区」層級，不轉載門牌。',
  },
};

/* ───────────────────────── GraphQL payload 的型別 ─────────────────────────
 * 只宣告我們真的會讀的欄位。對方沒有相容性承諾，缺欄位時要看得出來是缺哪一個。
 */

type ShImage = { url?: string };
type ShStation = { name?: string; lineName?: string };

export type ShBed = {
  name?: string;
  displayRate?: number;
  displayDiscountRate?: number | null;
  displayOccupiedLabel?: string;
  displayAvailableLabel?: string;
  displayAvailableFromLabel?: string;
  displayAvailableUntilLabel?: string;
  displayDiscountPeriodLabel?: string;
};

export type ShRoom = {
  id?: string;
  name?: string;
  type?: string;
  size?: number | null;
  maximumOccupancy?: number | null;
  beds?: ShBed[];
  images?: ShImage[];
  featureMenOnly?: boolean;
  featureWomenOnly?: boolean;
  featureWifiInternet?: boolean;
  isPublic?: boolean;
  displayRate?: number;
  displayDiscountRate?: number | null;
  displayOccupiedLabel?: string;
  displayAvailableLabel?: string;
  displayAvailableFromLabel?: string;
  displayAvailableUntilLabel?: string;
  displayDiscountPeriodLabel?: string;
};

export type ShUnit = { name?: string; rooms?: ShRoom[] };
export type ShHouse = { units?: ShUnit[] };

export type ShBuilding = {
  siteKey?: string;
  displayName?: string;
  name?: string;
  address?: string;
  addressEN?: string;
  area?: { name?: string } | null;
  stations?: ShStation[];
  access?: string;
  roomTypes?: string[];
  houses?: ShHouse[];
  images?: ShImage[];
  updatedAt?: number;
  featureMenOnly?: boolean;
  featureWomenOnly?: boolean;
};

/** discover 掛進 hint 的東西。extract 只從這裡組裝，不再碰網路。 */
export type SakuraHint = {
  readonly graphql: readonly string[];
  /** 房間清單展開後的**可見**文字。用來佐證「月額含水電」這類聲明。 */
  readonly roomListText: string;
};

/* ───────────────────────── 純解析函式（可單測） ───────────────────────── */

/** 從渲染後的清單頁抓 slug。原始 HTML 抓不到——清單是 JS 畫出來的。 */
export function parseSlugs(html: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="(?:https:\/\/www\.sakura-house\.com)?\/building\/([a-z0-9_-]+)"/gi)) {
    const slug = m[1];
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export type SakuraAddress = { readonly prefecture: string; readonly ward: string };

/**
 * `〒162-0825 東京都新宿区神楽坂6-22 斉藤邸` → 東京都 / 新宿区。
 *
 * 只取到「市区」層級就停：門牌之後的字不要。
 * 「区市」用非貪婪且**不接著吃町村**——`東京都北区田端新町` 的行政区是「北区」，
 * 讓它繼續吃下去會變成「北区田端新町」。郡下的町村是唯一的例外（郡＋町村才是完整地名）。
 */
export function parseSakuraAddress(address: string): SakuraAddress | null {
  const cleaned = address.replace(/^\s*〒?\s*[\d０-９-]{3,9}\s*/, '').trim();
  const pref = /^(東京都|北海道|京都府|大阪府|.{2,3}?県)/.exec(cleaned);
  if (pref?.[1] === undefined) return null;
  const rest = cleaned.slice(pref[1].length);
  const cityWard = /^(.{1,8}?[区市])/.exec(rest);
  if (cityWard?.[1] !== undefined) return { prefecture: pref[1], ward: cityWard[1] };
  const gun = /^(.{1,8}?郡.{1,8}?[町村])/.exec(rest);
  if (gun?.[1] !== undefined) return { prefecture: pref[1], ward: gun[1] };
  return null;
}

/** 把 HTML 片段壓成單行純文字。 */
function flatten(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const normStation = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * `access` 欄是**手寫的自由文字**，同一個站名會寫成 `Kagurazaka sta.`／`KAGURAZAKA STATION`／
 * `Nishi-Shinjuku-gochome Station`，還出現過 `- 11 min. wall` 這種錯字。
 * 所以步行分鐘從這裡抽，但**只有在站名與結構化 `stations[]` 的那一筆完全相同時才採用**——
 * 對不上就留未知，不硬塞。
 *
 * 同段文字裡的「APPROX. TIME TO KEY STATION … Shinjuku - 15 min.」是**搭車**時間不是步行，
 * 因為它後面沒有 `wal`，正則不會命中。
 *
 * ⚠️ 抽名字前一定要先砍掉「NEAREST STATIONS」這個小標。正則是最左優先，
 * 小標留著的話 `Kagurazaka sta.` 會被連前面的小標一起吃成
 * 「NEAREST STATIONS Kagurazaka」，站名就對不上了（神楽坂的真實 fixture 就是這樣）。
 * 站名最多吃 4 個詞，也是為了不讓它往前吞掉別的字。
 */
const ACCESS_HEADING_RE = /NEAREST\s+STATIONS?\s*[:：]?/gi;
// 結尾寫 `wal[a-z]*` 而不是 `wal`：`walk` 沒被整個吃掉的話，剩下的那個 `k`
// 會變成下一站名字的第一個詞（「k Ushigome Kagurazaka」），站名就對不上了。
// `wall` 是原站的錯字，同一個寫法一併吃下。
const ACCESS_WALK_RE =
  /([A-Za-z][A-Za-z0-9'-]*(?:\s+[A-Za-z][A-Za-z0-9'-]*){0,3}?)\s*(?:sta\.|station)\s*(?:\([^)]*\))?\s*(?:\[[^\]]*\])?\s*[-–—]*\s*(\d+)\s*min\.?\s*wal[a-z]*/gi;

export function parseAccessWalkMinutes(accessHtml: string): ReadonlyMap<string, { minutes: number; rawText: string }> {
  const text = flatten(accessHtml).replace(ACCESS_HEADING_RE, ' ');
  const out = new Map<string, { minutes: number; rawText: string }>();
  for (const m of text.matchAll(ACCESS_WALK_RE)) {
    const name = (m[1] ?? '').trim();
    const minutes = Number(m[2]);
    const key = normStation(name);
    if (key === '' || !Number.isFinite(minutes)) continue;
    // 同一站在文字裡重複出現時保留第一筆；對不上結構化站名的鍵本來就不會被用到
    if (!out.has(key)) out.set(key, { minutes, rawText: m[0].replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * 結構化站名是 `Kagurazaka(Tozai Line)` 這種格式：括號外是站名、括號內是路線。
 * `lineName` 欄位實測一律是空字串，所以路線只能從這裡拆。
 */
export function parseSakuraStations(
  stations: readonly ShStation[] | undefined,
  accessHtml: string,
): readonly Station[] {
  const walks = parseAccessWalkMinutes(accessHtml);
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const s of stations ?? []) {
    const raw = (s.name ?? '').trim();
    if (raw === '') continue;
    const m = /^([^(]+?)\s*(?:\(([^)]*)\))?$/.exec(raw);
    const station = (m?.[1] ?? raw).trim();
    const line = (m?.[2] ?? s.lineName ?? '').trim();
    const key = `${line}|${station}`;
    if (station === '' || seen.has(key)) continue;
    seen.add(key);
    const walk = walks.get(normStation(station));
    out.push({
      line,
      station,
      walkMinutes: walk === undefined
        // access 欄的寫法對不上這一站（拼字不一致或原站根本沒寫步行時間）→ 留未知，不猜
        ? notListed(`stations=${raw}（access 欄找不到對得上的步行時間）`)
        : known(walk.minutes, 'measured', walk.rawText),
      rawText: walk === undefined ? raw : `${raw} / ${walk.rawText}`,
    });
  }
  return out;
}

/**
 * `from now` → 随時；`from 2026/08/31` → 2026-08-31；空字串 → null。
 * 只認這兩種寫法，其他一律回 null 交給呼叫端記成未知。
 */
export function parseAvailableFrom(label: string): string | null {
  const t = label.trim();
  if (t === '') return null;
  if (/^from\s+now$/i.test(t)) return '随時';
  const m = /^from\s+(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 樓層名是 `1F`／`2F`。地下（`B1F`）不硬換算成負數，留未知。 */
export function parseFloor(unitName: string): number | null {
  const m = /^(\d{1,2})F$/i.exec(unitName.trim());
  if (m?.[1] === undefined) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

const KIND_BY_TYPE: Record<string, PropertyKind> = {
  ShareHouse: 'sharehouse',
  Apartment: 'apartment',
  LuxuryApartment: 'apartment',
  GuestHouse: 'dormitory',
  Dormitory: 'dormitory',
};

/** 一棟可能同時掛多種 roomTypes（例：雪谷大塚是 ShareHouse＋GuestHouse），取最能代表的一個。 */
export function buildingKind(roomTypes: readonly string[] | undefined): PropertyKind {
  const set = new Set(roomTypes ?? []);
  if (set.has('ShareHouse')) return 'sharehouse';
  if (set.has('Apartment') || set.has('LuxuryApartment')) return 'apartment';
  if (set.has('GuestHouse') || set.has('Dormitory')) return 'dormitory';
  return 'unknown';
}

/**
 * 只有 featureMenOnly／featureWomenOnly 為真才判定，兩者皆假一律 unknown。
 * 不把「沒標」讀成 mixed——原站沒說的事不要替它說。
 */
export function genderOf(menOnly: boolean | undefined, womenOnly: boolean | undefined): GenderRestriction {
  if (menOnly === true && womenOnly === true) return 'unknown';
  if (menOnly === true) return 'male_only';
  if (womenOnly === true) return 'female_only';
  return 'unknown';
}

/**
 * 每個房間下面都印著的那句話。**必須在可見文字裡找到才算數**——
 * 「No deposit」「Furnished」那類徽章雖然在 DOM 裡，但實測是隱藏的（innerText 取不到），
 * 拿隱藏內容當「原站明寫」是自欺。
 */
export const UTILITIES_INCLUDED_SENTENCE =
  'Utility costs such as electricity, water, gas, furniture and regular maintenance are all included in the stated price.';

export function statesAllInclusive(roomListText: string): boolean {
  return roomListText.includes(UTILITIES_INCLUDED_SENTENCE);
}

/** 從 GraphQL 回應堆裡挑出建物那一份。 */
export function pickBuilding(graphql: readonly string[]): ShBuilding | null {
  for (const body of graphql) {
    if (!body.includes('buildingBySiteKey')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const b = (parsed as { data?: { buildingBySiteKey?: unknown } }).data?.buildingBySiteKey;
    if (b !== null && b !== undefined && typeof b === 'object') return b as ShBuilding;
  }
  return null;
}

/* ───────────────────────── 組裝 ───────────────────────── */

const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notOffered<boolean>(),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

const NOT_OFFERED_INITIAL = {
  keyMoney: notOffered<Yen>(),
  deposit: notOffered<Yen>(),
  depositNonRefundable: notOffered<Yen>(),
  agencyFee: notOffered<Yen>(),
  guarantorInitialFee: notOffered<Yen>(),
  fireInsurance: notOffered<Yen>(),
  keyExchangeFee: notOffered<Yen>(),
  contractFee: notOffered<Yen>(),
  cleaningFeeUpfront: notOffered<Yen>(),
  otherInitial: notOffered<Yen>(),
} as const;

const NOT_OFFERED_DEFERRED = {
  renewalFee: notOffered<Yen>(),
  renewalAdminFee: notOffered<Yen>(),
  cleaningFeeOnExit: notOffered<Yen>(),
  earlyTerminationPenalty: notOffered<Yen>(),
} as const;

/** 一個可出租標的（整間房，或 dormitory 的一張床）在畫面上的狀態。 */
type Rentable = {
  readonly key: string;
  readonly label: string;
  readonly rateJpy: number | undefined;
  readonly discountJpy: number | null | undefined;
  readonly discountLabel: string;
  readonly occupiedLabel: string;
  readonly availableLabel: string;
  readonly availableFromLabel: string;
  readonly availableUntilLabel: string;
};

function rentablesOf(room: ShRoom): readonly Rentable[] {
  const roomName = (room.name ?? '').trim();
  const beds = room.beds ?? [];
  // dormitory：房間層的 displayRate 是 0，價錢在床上。一張床＝一個可出租標的。
  if (beds.length > 0) {
    return beds.map((b, i) => {
      const bedName = (b.name ?? String(i + 1)).trim();
      return {
        key: `${roomName}-${bedName}`,
        label: `ROOM ${roomName} BED ${bedName}`,
        rateJpy: b.displayRate,
        discountJpy: b.displayDiscountRate,
        discountLabel: (b.displayDiscountPeriodLabel ?? '').trim(),
        occupiedLabel: (b.displayOccupiedLabel ?? '').trim(),
        availableLabel: (b.displayAvailableLabel ?? '').trim(),
        availableFromLabel: (b.displayAvailableFromLabel ?? '').trim(),
        availableUntilLabel: (b.displayAvailableUntilLabel ?? '').trim(),
      };
    });
  }
  return [{
    key: roomName,
    label: `ROOM ${roomName}`,
    rateJpy: room.displayRate,
    discountJpy: room.displayDiscountRate,
    discountLabel: (room.displayDiscountPeriodLabel ?? '').trim(),
    occupiedLabel: (room.displayOccupiedLabel ?? '').trim(),
    availableLabel: (room.displayAvailableLabel ?? '').trim(),
    availableFromLabel: (room.displayAvailableFromLabel ?? '').trim(),
    availableUntilLabel: (room.displayAvailableUntilLabel ?? '').trim(),
  }];
}

/**
 * 賃料。displayRate 是畫面上印的那個數字（`¥91,000 / month`）。
 * 0 一律不當金額——dormitory 的房間層就是 0，那代表「這一層不報價」而不是免費。
 */
function rentField(r: Rentable): Field<Yen> {
  const v = r.rateJpy;
  if (v === undefined || v === null) return notListed(`${r.label} 無 displayRate`);
  if (!Number.isFinite(v)) return unparsed(`${r.label} displayRate=${String(v)}`);
  if (v <= 0) return notListed(`${r.label} displayRate=${v}（原站未於此層報價）`);
  return known(yen(v), 'measured', `${r.label} displayRate=${v}（畫面顯示 ¥${v.toLocaleString('en-US')} / month）`);
}

function unitOf(
  buildingId: string,
  sourceUrl: string,
  unit: ShUnit,
  room: ShRoom,
  r: Rentable,
  building: ShBuilding,
  allInclusive: boolean,
): Unit {
  const isBed = (room.beds ?? []).length > 0;
  const floor = parseFloor(unit.name ?? '');
  const availableFrom = parseAvailableFrom(r.availableFromLabel);
  const gender = genderOf(
    room.featureMenOnly ?? building.featureMenOnly,
    room.featureWomenOnly ?? building.featureWomenOnly,
  );

  const notes: string[] = [];
  if (isBed) {
    const size = room.size;
    notes.push(
      typeof size === 'number' && size > 0
        ? `dormitory：本筆是 ROOM ${room.name ?? ''} 的一張床；${size}㎡ 是整間房的面積，非本床專有`
        : `dormitory：本筆是 ROOM ${room.name ?? ''} 的一張床`,
    );
  }
  const occ = room.maximumOccupancy;
  if (typeof occ === 'number' && occ > 1) {
    notes.push(`Up to ${occ} people（原站另註：每多一人月額加 ¥20,000）`);
  }
  if (typeof r.discountJpy === 'number' && r.discountJpy > 0) {
    notes.push(
      `期間限定折扣價 ¥${r.discountJpy.toLocaleString('en-US')} / month`
      + `${r.discountLabel === '' ? '' : `（${r.discountLabel}）`}——rent 欄採用的是原價`,
    );
  }
  if (r.availableUntilLabel !== '') notes.push(`入居可能期間 ${r.availableFromLabel} ${r.availableUntilLabel}`.trim());

  return {
    id: `${buildingId}#${r.key}`,
    buildingId,
    unitKey: r.key,
    sourceUrl,
    roomNo: r.key === '' ? notListed('') : known(r.key, 'measured', r.label),
    // 原站從不刊登 1R／1K 這種間取り
    layout: notOffered<string>(),
    areaM2: isBed
      // 床沒有專有面積，房間的 60㎡ 是共用的——填上去就是誤導
      ? notListed(`dormitory 的床無專有面積（整間 ${String(room.size ?? '?')}㎡ 為共用）`)
      : typeof room.size === 'number' && room.size > 0
        ? known(room.size, 'measured', `size=${room.size}（畫面顯示 ${room.size}m²）`)
        : notListed(`size=${String(room.size ?? '')}`),
    floor: floor === null ? notListed(`unit=${unit.name ?? ''}`) : known(floor, 'measured', `unit=${unit.name ?? ''}`),
    monthly: {
      rent: rentField(r),
      // 「regular maintenance … included in the stated price」＝管理費含在月額內
      adminFee: allInclusive ? includedInOther(UTILITIES_INCLUDED_SENTENCE) : notListed(''),
      utilities: allInclusive ? includedInOther(UTILITIES_INCLUDED_SENTENCE) : notListed(''),
      // 那句話列的是 electricity, water, gas, furniture, maintenance——**沒有** internet。
      // 房間有 WiFi 設備，但費用是否含在月額內原站沒說，不替它說。
      internet: notListed(
        room.featureWifiInternet === true
          ? 'featureWifiInternet=true（有 WiFi，但原站未載明費用是否含在月額內）'
          : '',
      ),
      otherMonthly: notOffered<Yen>(),
    },
    initial: NOT_OFFERED_INITIAL,
    deferred: NOT_OFFERED_DEFERRED,
    utilitiesBasis: allInclusive ? 'included' : 'unknown',
    furnished: allInclusive
      // 同一句話裡的 furniture 也含在月額內 → 附傢俱
      ? known(true, 'measured', UTILITIES_INCLUDED_SENTENCE)
      : notListed(''),
    availableFrom: availableFrom === null
      ? notListed(r.availableFromLabel)
      : known(availableFrom, 'measured', `${r.label} ${r.availableFromLabel}`),
    isVacant: known(true, 'measured', `${r.label} ${r.availableLabel}`),
    contractType: 'unknown',
    contractMonths: notOffered<number>(),
    minStayMonths: notOffered<number>(),
    genderRestriction: gender,
    ageLimitRaw: notOffered<string>(),
    petsAllowed: notOffered<boolean>(),
    foreigner: NOT_OFFERED_FOREIGNER,
    notes,
  };
}

/**
 * 把 GraphQL payload 組成 Listing。非東京都一律回 null（原站也收京都與神奈川）。
 * 解析不到必要欄位就丟例外——這是「對方改版了」的訊號，不可默默產出空資料。
 */
export function buildListing(hint: SakuraHint, url: string, fetchedAt: string): Listing | null {
  const b = pickBuilding(hint.graphql);
  if (b === null) {
    throw new Error(`[sakurahouse] ${url}：GraphQL 回應裡找不到 buildingBySiteKey（對方可能改版）`);
  }
  const siteKey = (b.siteKey ?? '').trim();
  const name = (b.displayName ?? b.name ?? '').trim();
  if (siteKey === '' || name === '') {
    throw new Error(`[sakurahouse] ${url}：payload 缺 siteKey 或 displayName`);
  }

  const addressRaw = (b.address ?? '').trim();
  const addr = parseSakuraAddress(addressRaw);
  if (addr === null) {
    throw new Error(`[sakurahouse] ${url}：address 解析不出都道府県／市区：${JSON.stringify(addressRaw)}`);
  }
  // 只收東京都。原站同時經營京都（京都府）與川崎・横浜（神奈川県）。
  if (addr.prefecture !== '東京都') return null;

  const buildingId = `sakurahouse:${siteKey}`;
  const sourceUrl = `${SITE}/building/${siteKey}`;
  const allInclusive = statesAllInclusive(hint.roomListText);
  const houses = b.houses ?? [];
  const roomCount = houses.reduce(
    (n, h) => n + (h.units ?? []).reduce((m, u) => m + (u.rooms ?? []).length, 0),
    0,
  );
  if (roomCount === 0) {
    throw new Error(`[sakurahouse] ${url}：payload 裡一間房都沒有（對方可能改版）`);
  }

  const sha = createHash('sha256').update(hint.graphql.join('\n')).digest('hex');
  const updatedAt = b.updatedAt;

  const building: Building = {
    id: buildingId,
    sourceId: 'sakurahouse',
    sourceKey: siteKey,
    sourceUrl,
    name,
    kind: buildingKind(b.roomTypes),
    // 原站頁面刻意不顯示門牌，這裡只保留到市区層級——見 manifest.legal.notes
    addressRaw: `${addr.prefecture}${addr.ward}`,
    prefecture: addr.prefecture,
    ward: addr.ward,
    stations: parseSakuraStations(b.stations, b.access ?? ''),
    structure: notOffered<string>(),
    yearBuilt: notOffered<number>(),
    floorsAboveGround: notOffered<number>(),
    totalUnits: known(roomCount, 'measured', `payload 房間數 ${roomCount}`),
    imageUrls: (b.images ?? [])
      .map((i) => i.url)
      .filter((u): u is string => typeof u === 'string' && u !== '')
      .slice(0, 8),
    fetchedAt,
    sourceUpdatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      ? known(new Date(updatedAt).toISOString(), 'measured', `updatedAt=${updatedAt}`)
      : notOffered<string>(),
    htmlSha256: sha,
  };

  const units: Unit[] = [];
  for (const house of houses) {
    for (const unit of house.units ?? []) {
      for (const room of unit.rooms ?? []) {
        if (room.isPublic === false) continue;
        for (const r of rentablesOf(room)) {
          // 只收畫面上顯示為 AVAILABLE 的。OCCUPIED 與兩個標籤都空白的
          // （dormitory 的房間層就是這樣）都不是可租的標的。
          if (r.occupiedLabel !== '' || r.availableLabel === '') continue;
          units.push(unitOf(buildingId, sourceUrl, unit, room, r, b, allInclusive));
        }
      }
    }
  }

  return { building, units };
}

/* ───────────────────────── adapter ───────────────────────── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LIST_READY = 'document.querySelectorAll(\'a[href^="/building/"]\').length > 20';
const DETAIL_READY = '!!document.querySelector("#embed-room-list-view [class*=RoomListView__UnitHeader]")';

export const adapter: SourceAdapter = {
  manifest,

  /**
   * 清單與詳情都在這裡用瀏覽器抓齊，掛進 hint；extract 只做組裝（fetchMode='none'）。
   * 節流自己做——執行器的 HttpFetcher 這條路對本來源走不通。
   */
  async *discover(_ctx: ExtractContext, _fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const session = await ChromeSession.launch();
    try {
      await sleep(manifest.crawlDelayMs);
      const list = await session.capture(`${SITE}/building/`, {
        readyExpression: LIST_READY,
        expandRooms: false,
        timeoutMs: 90_000,
      });
      const slugs = parseSlugs(list.html);
      if (slugs.length === 0) {
        throw new Error('[sakurahouse] 清單頁渲染後仍抓不到任何 /building/{slug}（對方可能改版）');
      }

      for (const slug of slugs) {
        await sleep(manifest.crawlDelayMs);
        const url = `${SITE}/building/${slug}`;
        const cap = await session.capture(url, {
          readyExpression: DETAIL_READY,
          expandRooms: true,
          timeoutMs: 90_000,
        });
        const graphql = cap.graphql.filter((g) => g.includes('buildingBySiteKey'));
        if (graphql.length === 0) continue; // 非房源頁（例如清單頁自己的 /building/）
        const hint: SakuraHint = { graphql, roomListText: cap.roomListText };
        yield { url, hint: hint as unknown as Record<string, unknown> };
      }
    } finally {
      session.close();
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const hint = ref.hint as unknown as SakuraHint | undefined;
    if (hint === undefined || !Array.isArray(hint.graphql)) return null;
    return buildListing(hint, ref.url, raw.fetchedAt);
  },
};

export default adapter;
