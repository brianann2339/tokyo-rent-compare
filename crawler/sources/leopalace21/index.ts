/**
 * Leopalace21（レオパレス21）adapter——東京都 1,701 棟建物（2026-08-16 由 sitemap 實測去重後所得）。
 *
 * 資料全部取自頁面內的 JSON-LD（`<script type="application/ld+json">`）。
 * 選它而不是 RSC payload 的理由：JSON-LD 是 schema.org 的對外契約，
 * 站方改前端框架時它不會跟著變；RSC payload 的欄位名會隨 build 改。
 *
 * ⚠️ 這個來源最大的坑：同一間房會出現**兩個 Offer**。
 *   `leaseLength:"24 months"` → 賃貸契約，`price` 是**月額賃料**（頁面顯示 7.8万円）
 *   `leaseLength:"1 month"`   → マンスリー契約，`price` 是**日額**
 *                               （頁面顯示「235,400円 / 30日　1日あたり7,846円」）
 * `leaseLength` 寫「1 month」但 price 是一天的錢——把它當月租會低估到剩十分之一。
 * 所以本 adapter **只採用 ≥2 個月的 Offer**，マンスリー 只在 notes 揭露、不進比價。
 * （2026-08-16 對 17 個頁面 70 筆 Offer 普查：leaseLength 只有 "24 months" 與 "1 month" 兩種值。）
 *
 * ⚠️ 本 adapter 只讀**建物頁** `/properties/common/…`。
 * 房間詳情頁 `/properties/chintai/{pref}/{city}/{slug}/{號室}` 另有
 * 建物構造・総戸数・所在階・更新料・鍵交換費・退去時清掃費・火災保険・敷引・入居可能日，
 * 建物頁完全沒有這些欄位（2026-08-16 對建物頁 grep 構造／総戸数 皆為 0）。
 * 這些欄位在本 adapter 的取材範圍內是結構性缺席，宣告於 capabilities.neverProvides；
 * 要補齊必須加抓房間層（約 2,900 個頁面），屬於後續階段。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unknown, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, PropertyKind,
} from '../../../packages/schema/src/model.ts';
import { parseMoney, monthsToYen } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseLayout } from '../../../packages/jp-parse/src/layout.ts';
import { parseWalk } from '../../../packages/jp-parse/src/station.ts';
import { WALK_MIN, WALK_MAX } from '../../../packages/schema/src/invariants.ts';

const SITE = 'https://www.leopalace21.com';

/** 只收東京都。sitemap 是全國的（2026-08-16 實測全國 25,387 筆）。 */
const TARGET_PREFECTURE = '東京都';

/** マンスリー契約的 leaseLength。它的 price 是日額不是月額，一律排除。 */
const MONTHLY_CONTRACT_MONTHS = 1;

export const manifest: SourceManifest = {
  id: 'leopalace21',
  name: 'レオパレス21',
  nameZh: 'Leopalace21',
  homepage: 'https://www.leopalace21.com/',
  origin: 'https://www.leopalace21.com',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'keyMoney', 'deposit', 'agencyFee',
      'layout', 'areaM2', 'roomNo', 'isVacant', 'contractMonths',
      'stations', 'yearBuilt', 'floorsAboveGround', 'sourceUpdatedAt',
    ],
    // 建物頁結構性缺席的欄位。前段（費用類）多數在房間詳情頁有，
    // 但本 adapter 不抓那一層——見檔頭說明。宣告出來，健康檢查才不會產生永遠 0% 的假警報。
    neverProvides: [
      'utilities', 'internet', 'otherMonthly',
      'depositNonRefundable', 'guarantorInitialFee', 'fireInsurance',
      'keyExchangeFee', 'contractFee', 'cleaningFeeUpfront', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'floor', 'furnished', 'availableFrom', 'minStayMonths', 'contractType',
      'genderRestriction', 'ageLimitRaw', 'petsAllowed',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
      'structure', 'totalUnits',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測）：User-Agent: * 之下只有四條 Disallow——'
      + '/estimate/*、/*/estimate/*、/inquiry/*、/*/inquiry/*；無 Crawl-delay。'
      + '房源頁 /properties/common/… 未被禁止，且由 robots.txt 自報的 '
      + 'Sitemap: https://www.leopalace21.com/sitemap.xml 逐筆列出。自訂 3 秒間隔。'
      + '利用規約 /suisho 著作權條原文：「私的利用その他法律で認められる範囲を超えて'
      + '使用、複製、改ざん、頒布等を行うことはできません。」'
      + '→ 本專案只保存價格欄位與原文出處、不轉載頁面內容、每筆標示出處並連回原站。',
  },
};

/* ────────────────────────── JSON-LD 讀取 ────────────────────────── */

export type LdNode = Record<string, unknown>;

function asObject(v: unknown): LdNode | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as LdNode) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asArray(v: unknown): readonly unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

const LD_SCRIPT_RE = /<script[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * 取出頁面內所有 JSON-LD 節點（一個 script 內可以是陣列，也可能有多個 script）。
 * JSON 壞掉是「站方改版」的訊號，直接丟例外——默默回空陣列會變成靜悄悄的 0 筆。
 */
export function parseLdNodes(html: string): readonly LdNode[] {
  const out: LdNode[] = [];
  for (const m of html.matchAll(LD_SCRIPT_RE)) {
    const raw = m[1];
    if (raw === undefined || raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`[leopalace21] JSON-LD 解析失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    for (const n of asArray(parsed)) {
      const o = asObject(n);
      if (o !== null) out.push(o);
    }
  }
  return out;
}

export function pickLdType(nodes: readonly LdNode[], type: string): LdNode | null {
  return nodes.find((n) => asString(n['@type']) === type) ?? null;
}

/** PropertyValue 陣列 → 扁平的 name→value 對照。 */
function propertyValues(v: unknown): ReadonlyMap<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of asArray(v)) {
    const o = asObject(item);
    if (o === null) continue;
    const name = asString(o['name']);
    if (name === null) continue;
    map.set(name, o['value']);
  }
  return map;
}

/* ────────────────────────── Offer 解析 ────────────────────────── */

export type LeoOffer = {
  /** `105号室` */
  readonly roomLabel: string;
  /** `105`——去掉「号室」後的房號，作為 unitKey */
  readonly roomNo: string;
  /** JSON-LD leaseLength 換算出的月數 */
  readonly leaseMonths: number;
  /** 賃貸 Offer＝月額賃料；マンスリー Offer＝日額（本 adapter 不採用） */
  readonly priceJpy: number;
  readonly layoutRaw: string;
  readonly areaRaw: string;
  readonly adminFeeJpy: number | null;
  readonly agencyFeeRaw: string;
  readonly depositRaw: string;
  readonly keyMoneyRaw: string;
  readonly conditionRaw: string;
  readonly url: string;
  readonly inStock: boolean;
};

const LEASE_RE = /^\s*(\d+)\s*months?\s*$/i;

/** `"24 months"` → 24。看不懂就回 null，讓呼叫端大聲失敗，不要猜。 */
export function parseLeaseMonths(input: string | null): number | null {
  if (input === null) return null;
  const m = LEASE_RE.exec(input);
  if (m?.[1] === undefined) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export type OfferSplit = {
  /** 賃貸契約（leaseLength ≥ 2 個月）——price 是月額賃料 */
  readonly lease: readonly LeoOffer[];
  /** マンスリー契約（leaseLength = 1 month）——price 是日額，只用於揭露 */
  readonly monthlyPlan: readonly LeoOffer[];
  /** leaseLength 看不懂的筆數。>0 代表站方改了寫法。 */
  readonly unparseableLease: number;
};

export function parseOffers(listing: LdNode): OfferSplit {
  const lease: LeoOffer[] = [];
  const monthlyPlan: LeoOffer[] = [];
  let unparseableLease = 0;

  for (const item of asArray(listing['offers'])) {
    const o = asObject(item);
    if (o === null) continue;
    const price = asNumber(o['price']);
    const months = parseLeaseMonths(asString(o['leaseLength']));
    if (months === null || price === null) {
      unparseableLease += 1;
      continue;
    }
    const p = propertyValues(o['additionalProperty']);
    const roomLabel = (asString(p.get('部屋番号')) ?? '').trim();
    const adminRaw = p.get('共益費');
    const offer: LeoOffer = {
      roomLabel,
      roomNo: roomLabel.replace(/号室\s*$/, '').trim(),
      leaseMonths: months,
      priceJpy: price,
      layoutRaw: (asString(p.get('間取り')) ?? '').trim(),
      areaRaw: (asString(p.get('床面積')) ?? '').trim(),
      adminFeeJpy: asNumber(adminRaw) ?? (asString(adminRaw) === null ? null : toJpy(asString(adminRaw) ?? '')),
      agencyFeeRaw: (asString(p.get('仲介手数料')) ?? '').trim(),
      depositRaw: (asString(p.get('敷金')) ?? '').trim(),
      keyMoneyRaw: (asString(p.get('礼金')) ?? '').trim(),
      conditionRaw: (asString(p.get('契約条件')) ?? '').trim(),
      url: (asString(o['url']) ?? '').trim(),
      inStock: (asString(o['availability']) ?? '').endsWith('/InStock'),
    };
    if (months === MONTHLY_CONTRACT_MONTHS) monthlyPlan.push(offer);
    else lease.push(offer);
  }

  return { lease, monthlyPlan, unparseableLease };
}

function toJpy(raw: string): number | null {
  const r = parseMoney(raw);
  if (r.kind === 'amount') return r.jpy;
  if (r.kind === 'zero') return 0;
  return null;
}

/* ────────────────────────── 車站解析 ────────────────────────── */

/**
 * `京王電鉄京王線「幡ヶ谷駅」徒歩13分`
 * `中央本線「八王子駅」バス15分 市民体育館下車 徒歩3分`
 * `北総鉄道「新柴又駅」徒歩8分`  ← 路線名不以「線」結尾，所以不能用 jp-parse 的通用路線regex
 *
 * 站名一律包在 `「…駅」` 內，這是本站穩定的寫法；括號前的整段就是路線名。
 * 步行／公車的判讀交給 jp-parse 的 parseWalk（它已處理範圍與「バスN分…徒歩M分」）。
 */
const LEO_STATION_RE = /^(.*?)[「｢]([^」｣]{1,16}?)駅?[」｣]\s*(.*)$/;

function walkField(rest: string, seg: string): Field<number> {
  const w = parseWalk(rest);
  switch (w.kind) {
    case 'exact':
      return w.minutes >= WALK_MIN && w.minutes <= WALK_MAX
        ? known(w.minutes, 'measured', seg)
        : unparsed<number>(seg);
    case 'range':
      // 範圍只能取下界，並在原文留下完整區間
      return w.minMinutes >= WALK_MIN && w.minMinutes <= WALK_MAX
        ? known(w.minMinutes, 'measured', `${seg}（取下界 ${w.minMinutes} 分）`)
        : unparsed<number>(seg);
    case 'via_bus':
      // 「バス15分 …下車 徒歩3分」的 3 分是從公車站走，不是從車站走——不可當步行距離
      return notListed<number>(`${seg}（需搭公車 ${w.busMinutes} 分，徒歩分不是從車站起算）`);
    case 'absent':
      return notListed<number>(seg);
    case 'unparsed':
      return unparsed<number>(seg);
  }
}

export function parseLeoStations(access: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const segRaw of access.split(/[、,]/)) {
    const seg = segRaw.trim();
    if (seg === '') continue;
    const m = LEO_STATION_RE.exec(seg);
    if (m === null) continue;
    const line = (m[1] ?? '').trim();
    const station = (m[2] ?? '').trim();
    const rest = (m[3] ?? '').trim();
    const key = `${line}|${station}`;
    if (station === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ line, station, walkMinutes: walkField(rest, seg), rawText: seg });
  }
  return out;
}

/* ────────────────────────── 建物概要解析 ────────────────────────── */

export type LeoBuildingSummary = {
  /** `2階建てアパート` 的「2」 */
  readonly floors: number | null;
  /** `アパート` / `マンション` */
  readonly buildingType: string;
  readonly yearBuilt: number | null;
  /** `1985年11月築` 原文，作為 srcText */
  readonly builtRaw: string;
  readonly floorsRaw: string;
};

const FLOORS_RE = /(\d+)\s*階建て\s*([^\s|｜]{0,10})/;
const BUILT_RE = /(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?\s*築/;

/**
 * ApartmentComplex.description 的格式（2026-08-16 對 17 頁實測皆一致）：
 * `東京都中野区南台２−７−１ | 2階建てアパート | 1985年11月築 | 京王電鉄京王線「幡ヶ谷駅」徒歩13分、…`
 */
export function parseBuildingSummary(description: string): LeoBuildingSummary {
  const f = FLOORS_RE.exec(description);
  const b = BUILT_RE.exec(description);
  const floors = f?.[1] !== undefined ? Number(f[1]) : null;
  const year = b?.[1] !== undefined ? Number(b[1]) : null;
  return {
    floors: floors !== null && Number.isFinite(floors) && floors > 0 && floors <= 60 ? floors : null,
    buildingType: (f?.[2] ?? '').trim(),
    yearBuilt: year !== null && Number.isFinite(year) && year >= 1900 ? year : null,
    builtRaw: (b?.[0] ?? '').trim(),
    floorsRaw: (f?.[0] ?? '').trim(),
  };
}

const KIND_BY_TYPE: Readonly<Record<string, PropertyKind>> = {
  アパート: 'apartment',
  マンション: 'apartment',
};

export function kindOf(buildingType: string): PropertyKind {
  return KIND_BY_TYPE[buildingType] ?? 'unknown';
}

/** `/properties/common/tokyo/nakano-ku-13114/minamidai-dai3-00118` → `00118`（アパート番号）。 */
export function keyFromUrl(url: string): string | null {
  const m = /\/properties\/common\/[^/]+\/[^/]+\/[^/?#]*?(\d{4,6})(?:[/?#]|$)/.exec(url);
  return m?.[1] ?? null;
}

/**
 * 兩個來源給同一個數字時的比對。不一致代表至少有一邊解析錯了 → conflicting（視為不知道）。
 * 只有一邊有值時採用該值；兩邊都沒有才是真的沒寫。
 */
function agree(a: number | null, b: number | null, srcText: string): Field<number> {
  if (a !== null && b !== null) {
    return a === b
      ? known(a, 'measured', srcText)
      : unknown<number>('conflicting', 'measured', `${srcText}（兩處不一致：${a} vs ${b}）`);
  }
  const v = a ?? b;
  return v === null ? notListed<number>('') : known(v, 'measured', srcText);
}

/* ────────────────────────── 費用欄位 ────────────────────────── */

/**
 * 「不要」「なし」→ 有依據的 0；金額 → 金額；其他 → 不猜。
 * `parseMoney` 已經把「応相談／別途」判成 negotiable（未知），不會誤變成 0。
 */
export function feeField(label: string, raw: string): Field<Yen> {
  if (raw === '') return notListed<Yen>('');
  const r = parseMoney(raw);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${label} ${raw}`);
    case 'zero': return known(yen(0), 'measured', `${label} ${raw}`);
    case 'included': return known(yen(0), 'included_stated', `${label} ${raw}`);
    case 'negotiable': return notListed<Yen>(`${label} ${raw}`);
    case 'absent': return notListed<Yen>(`${label} ${raw}`);
    case 'months': return unparsed<Yen>(`${label} ${raw}`);
    case 'unparsed': return unparsed<Yen>(`${label} ${raw}`);
  }
}

/**
 * 礼金／敷金常寫成「1ヶ月」——那是**月數不是金額**，要乘上賃料才成金額。
 * 賃料未知時一律不換算（換算出來的就是編的）。
 */
export function monthsOrAmountField(label: string, raw: string, rentJpy: number | null): Field<Yen> {
  if (raw === '') return notListed<Yen>('');
  const r = parseMoney(raw);
  if (r.kind !== 'months') return feeField(label, raw);
  if (rentJpy === null) {
    return unparsed<Yen>(`${label} ${raw}（賃料未知，不可換算成金額）`);
  }
  const v = monthsToYen(r.months, rentJpy);
  return known(yen(v), 'measured', `${label} ${raw} × 賃料 ${jpy(rentJpy)}円 = ${jpy(v)}円`);
}

function jpy(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notOffered<boolean>(),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

/* ────────────────────────── discover ────────────────────────── */

const JA_IMAGE_SITEMAP_RE = /<loc>(https:\/\/www\.leopalace21\.com\/sitemap_image_map_ja_\d+\.xml)<\/loc>/g;
const TOKYO_PROPERTY_RE = /<loc>(https:\/\/www\.leopalace21\.com\/properties\/common\/tokyo\/[^<]+)<\/loc>/g;

export function sitemapIndexUrls(xml: string): readonly string[] {
  return [...xml.matchAll(JA_IMAGE_SITEMAP_RE)].map((m) => m[1]).filter((u): u is string => u !== undefined);
}

/** 只挑東京都的房源頁。`<image:loc>` 不會被誤匹配（那是 `<image:loc>` 不是 `<loc>`）。 */
export function tokyoPropertyUrls(xml: string): readonly string[] {
  return [...xml.matchAll(TOKYO_PROPERTY_RE)].map((m) => m[1]).filter((u): u is string => u !== undefined);
}

/* ────────────────────────── adapter ────────────────────────── */

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const index = await fetcher.get(`${SITE}/sitemap.xml`);
    const maps = sitemapIndexUrls(index.body);
    if (maps.length === 0) {
      throw new Error('[leopalace21] sitemap.xml 裡找不到任何 sitemap_image_map_ja_N.xml，站方可能改了結構');
    }

    const seen = new Set<string>();
    for (const map of maps) {
      const sm = await fetcher.get(map);
      for (const u of tokyoPropertyUrls(sm.body)) {
        if (seen.has(u)) continue;
        seen.add(u);
        yield { url: u };
      }
    }

    if (seen.size === 0) {
      throw new Error(`[leopalace21] ${maps.length} 個 sitemap 裡一筆東京房源都沒有，解析必然壞了`);
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const nodes = parseLdNodes(raw.body);
    if (nodes.length === 0) {
      throw new Error(`[leopalace21] ${ref.url} 找不到任何 JSON-LD`);
    }

    const listing = pickLdType(nodes, 'RealEstateListing');
    if (listing === null) {
      throw new Error(`[leopalace21] ${ref.url} 沒有 RealEstateListing 節點`);
    }
    const apartment = asObject(listing['mainEntity']);
    if (apartment === null) {
      throw new Error(`[leopalace21] ${ref.url} 的 RealEstateListing 缺 mainEntity`);
    }
    const address = asObject(apartment['address']);
    if (address === null) {
      throw new Error(`[leopalace21] ${ref.url} 缺 mainEntity.address`);
    }

    const prefecture = (asString(address['addressRegion']) ?? '').trim();
    if (prefecture === '') {
      throw new Error(`[leopalace21] ${ref.url} 的 addressRegion 是空的`);
    }
    // 只收東京都。用結構化欄位判斷，不掃整頁找「東京都」——導覽選單每頁都有。
    if (prefecture !== TARGET_PREFECTURE) return null;

    const name = (asString(apartment['name']) ?? asString(listing['name']) ?? '').trim();
    if (name === '') {
      throw new Error(`[leopalace21] ${ref.url} 取不到建物名稱`);
    }

    const key = keyFromUrl(ref.url) ?? keyFromUrl(asString(listing['url']) ?? '');
    if (key === null) {
      throw new Error(`[leopalace21] ${ref.url} 取不到アパート番号（URL 尾碼）`);
    }
    const buildingId = `leopalace21:${key}`;

    const complex = pickLdType(nodes, 'ApartmentComplex');
    const description = (asString(complex?.['description']) ?? asString(listing['description']) ?? '').trim();
    const summary = parseBuildingSummary(description);
    const complexProps = propertyValues(complex?.['additionalProperty']);

    const accessRaw = (asString(propertyValues(apartment['additionalProperty']).get('アクセス')) ?? '').trim();
    const stations = parseLeoStations(accessRaw);

    // datePosted = 情報公開日；dateModified = 情報**更新予定日**（未來日期），不是「上次更新」，不可用。
    const datePosted = (asString(listing['datePosted']) ?? '').trim();

    const offers = parseOffers(listing);
    if (offers.unparseableLease > 0 && offers.lease.length === 0) {
      throw new Error(
        `[leopalace21] ${ref.url} 有 ${offers.unparseableLease} 筆 Offer 但沒有一筆看得懂 leaseLength，站方可能改了寫法`,
      );
    }

    const building: Building = {
      id: buildingId,
      sourceId: 'leopalace21',
      sourceKey: key,
      sourceUrl: ref.url,
      name,
      kind: kindOf(summary.buildingType),
      addressRaw: (asString(address['streetAddress']) ?? '').trim(),
      prefecture,
      ward: (asString(address['addressLocality']) ?? '').trim(),
      stations,
      // 建物構造（木造／鉄骨造…）只在房間詳情頁，建物頁沒有
      structure: notOffered<string>(),
      yearBuilt: agree(
        asNumber(apartment['yearBuilt']),
        asNumber(complexProps.get('築年')) ?? summary.yearBuilt,
        summary.builtRaw !== '' ? summary.builtRaw : `築年 ${asNumber(apartment['yearBuilt']) ?? ''}`,
      ),
      floorsAboveGround: agree(
        toInt(asString(apartment['floorLevel'])),
        asNumber(complexProps.get('階数')) ?? summary.floors,
        summary.floorsRaw !== '' ? summary.floorsRaw : '階数',
      ),
      // 総戸数只在房間詳情頁；建物頁只列「入居可能な部屋」，不等於總戶數
      totalUnits: notOffered<number>(),
      imageUrls: asArray(apartment['image']).map(asString).filter((s): s is string => s !== null),
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: datePosted === ''
        ? notListed<string>('')
        : known(datePosted, 'measured', `情報公開日 ${datePosted}（JSON-LD datePosted）`),
      htmlSha256: raw.sha256,
    };

    const monthlyByRoom = new Map<string, LeoOffer>();
    for (const o of offers.monthlyPlan) monthlyByRoom.set(o.roomNo, o);

    const units: Unit[] = offers.lease.map((o) => {
      const rentJpy = o.priceJpy;
      const area = parseArea(o.areaRaw);
      const layout = parseLayout(o.layoutRaw);
      const notes: string[] = [];
      if (o.conditionRaw !== '') notes.push(`契約条件：${o.conditionRaw}`);
      const mp = monthlyByRoom.get(o.roomNo);
      if (mp !== undefined) {
        // 揭露而不換算：站方的マンスリー price 是日額，跟月額不可比
        notes.push(
          `同房另有マンスリー契約（leaseLength=1 month，price=${jpy(mp.priceJpy)}）；`
          + '該價為「1日あたり」的日額而非月額，未納入月額比較',
        );
      }

      return {
        id: `${buildingId}#${o.roomNo}`,
        buildingId,
        unitKey: o.roomNo,
        sourceUrl: o.url === '' ? ref.url : o.url,
        roomNo: o.roomLabel === ''
          ? notListed<string>('')
          : known(o.roomNo, 'measured', `部屋番号 ${o.roomLabel}`),
        layout: layout.kind === 'rooms'
          ? known(layout.canonical, 'measured', `間取り ${o.layoutRaw}`)
          : o.layoutRaw === '' ? notListed<string>('') : unparsed<string>(`間取り ${o.layoutRaw}`),
        areaM2: area.kind === 'exact'
          ? known(area.m2, 'measured', `床面積 ${o.areaRaw}`)
          : o.areaRaw === '' ? notListed<number>('') : unparsed<number>(`床面積 ${o.areaRaw}`),
        // 所在階只在房間詳情頁。房號首位數字看起來像樓層，但那是慣例不是欄位，不可據以推斷。
        floor: notOffered<number>(),
        monthly: {
          rent: known(yen(rentJpy), 'measured',
            `賃料 ${jpy(rentJpy)}円（JSON-LD offers[].price，leaseLength=${o.leaseMonths} months）`),
          adminFee: o.adminFeeJpy === null
            ? notListed<Yen>('')
            : known(yen(o.adminFeeJpy), 'measured', `共益費 ${jpy(o.adminFeeJpy)}円`),
          utilities: notOffered<Yen>(),
          internet: notOffered<Yen>(),
          otherMonthly: notOffered<Yen>(),
        },
        initial: {
          // 「礼金 1ヶ月」是月數不是金額，必須乘上賃料
          keyMoney: monthsOrAmountField('礼金', o.keyMoneyRaw, rentJpy),
          deposit: monthsOrAmountField('敷金', o.depositRaw, rentJpy),
          depositNonRefundable: notOffered<Yen>(),
          agencyFee: feeField('仲介手数料', o.agencyFeeRaw),
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
          earlyTerminationPenalty: notOffered<Yen>(),
        },
        utilitiesBasis: 'unknown',
        furnished: notOffered<boolean>(),
        availableFrom: notOffered<string>(),
        isVacant: known(o.inStock, 'measured',
          `availability=${o.inStock ? 'InStock' : 'OutOfStock'}（頁面「入居可能な部屋」區塊）`),
        contractType: 'unknown',
        contractMonths: known(o.leaseMonths, 'measured', `leaseLength ${o.leaseMonths} months`),
        minStayMonths: notOffered<number>(),
        genderRestriction: 'unknown',
        ageLimitRaw: notOffered<string>(),
        petsAllowed: notOffered<boolean>(),
        foreigner: NOT_OFFERED_FOREIGNER,
        notes,
      };
    });

    return { building, units };
  },
};

function toInt(s: string | null): number | null {
  if (s === null) return null;
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : null;
}

export default adapter;
