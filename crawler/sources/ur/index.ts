/**
 * UR賃貸住宅 adapter（獨立行政法人都市再生機構，東京 6 個 area）。
 *
 * 收錄它的理由：這是**費用結構最乾淨**的來源，官方明文
 * 「礼金ナシ・仲介手数料ナシ・更新料ナシ・保証人ナシ」
 * （https://www.ur-net.go.jp/chintai/whats/merit/ 逐字），
 * 敷金 2 か月。對外國人也有明文的申込資格條文，不像多數民間物件語焉不詳。
 * 跟 share house 放在同一把尺上比，才看得出「零初期費用」到底值多少。
 *
 * 取得方式：官方網站自己在用的 JSON API `chintai.r6.ur-net.go.jp/chintai/api/`。
 * 這組端點不在任何公開文件裡，是從 `/chintai/common/js/api.js` 逆推的
 * （該 host 有列在 UR「このサイトについて」的官方主機清單內）。
 * 它比逐頁渲染 HTML 對對方負載更輕，但**沒有相容性承諾，隨時可能改**——
 * 所以解析失敗要能大聲失敗，不要默默產出空資料。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseStations } from '../../../packages/jp-parse/src/station.ts';

const API = 'https://chintai.r6.ur-net.go.jp/chintai/api';
const SITE = 'https://www.ur-net.go.jp';
/** 東京都的 area 代碼（tdfk=13）。由 `list_init` 回傳的 Key 得知。 */
const TOKYO_AREAS = ['01', '02', '03', '04', '05', '06'] as const;

export const manifest: SourceManifest = {
  id: 'ur',
  name: 'UR賃貸住宅',
  nameZh: 'UR 賃貸住宅（都市再生機構）',
  homepage: 'https://www.ur-net.go.jp/chintai/',
  origin: 'https://www.ur-net.go.jp',
  transport: 'http',
  fetchMode: 'none', // 全部資料來自 JSON API，不需要再抓詳情頁
  crawlDelayMs: 2000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'keyMoney', 'agencyFee', 'renewalFee',
      'layout', 'areaM2', 'roomNo', 'floor', 'isVacant', 'availableFrom',
      'guarantorPersonRequired', 'stations',
    ],
    neverProvides: [
      'utilities', 'internet', 'otherMonthly', 'depositNonRefundable',
      'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee', 'contractFee',
      'cleaningFeeUpfront', 'otherInitial', 'renewalAdminFee', 'cleaningFeeOnExit',
      'earlyTerminationPenalty', 'furnished', 'genderRestriction', 'ageLimitRaw',
      'petsAllowed', 'minStayMonths', 'contractMonths', 'contractType',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'structure', 'yearBuilt', 'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測，全文 5 行）只 Disallow 帶 ?skcs= / ?line= / ?station= / ' +
      '?station_nm= 的 result 頁，物件詳情與列表未被禁止，無 Crawl-delay。' +
      '「このサイトについて」https://www.ur-net.go.jp/site/guide.html 著作權條：' +
      '「私的使用又は引用等著作権法上認められた行為を除き、当機構に無断で転載等を' +
      '行うことはできません。引用を行う際は適宜の方法により、必ず出所を明示してください。」' +
      '同頁「リンクについて」：「リンクは、原則フリーです」。' +
      '本站每筆房源均標示出處為 UR賃貸住宅並連回原站。' +
      '⚠️ 使用的 JSON API 不在公開文件中（自 /chintai/common/js/api.js 逆推），' +
      '該 host chintai.r6.ur-net.go.jp 有列於官方主機清單，但清單本身並未授權 API 使用。',
  },
};

type UrBuilding = {
  id: string; name: string; skcs: string; roomCount: number;
  rent: string; commonfee: string; access: string; image: string;
  bukkenUrl: string; roomUrl: string;
};

type UrRoom = {
  id: string; name: string; rent: string;
  /**
   * UR 有兩個租金欄位。實測（2026-08-16）：
   *   有優惠價時 → `rent` 有值、`rent_normal` 空、`rent_normal_css=" dn"`（原價被隱藏）
   *   無優惠價時 → `rent` **空字串**、`rent_normal` 才有值
   * 只讀 `rent` 會讓後者整筆賃料變成未知，月額只剩管理費——
   * 立川幸町 3DK 56㎡ 因此顯示成 ¥2,950（實際 69,600 円）。
   */
  rent_normal?: string;
  commonfee: string | null;
  shikikin: string; requirement: string; type: string;
  floorspace: string; floor: string; year: string | null;
  floorAll: string | null; allCount: string; pageIndex: string;
  roomDetailLink: string;
};

/** `20_2550` → shisya=20, danchi=255, shikibetu=0 */
export function splitBuildingId(id: string): { shisya: string; danchi: string; shikibetu: string } | null {
  const m = /^(\d+)_(\d+)(\d)$/.exec(id);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { shisya: m[1], danchi: m[2], shikibetu: m[3] };
}

/** UR 回傳的面積帶 HTML 實體：`48&#13217;` 的 `&#13217;` 就是 ㎡（U+33A1）。 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return s.replace(/<li>/g, '').replace(/<\/li>/g, '｜').replace(/<[^>]+>/g, ' ');
}

/**
 * `requirement` 欄位對應原站表格的「礼金・仲介手数料・更新料・保証人」欄。
 * 值為「ナシ」時，這四項確實都是 0／不需要——這不是推測，
 * UR 官方 https://www.ur-net.go.jp/chintai/whats/merit/ 逐字寫著
 * 「1.礼金ナシ！ 2.仲介手数料ナシ！ 3.更新料ナシ！ 4.保証人ナシ！」。
 * 值不是「ナシ」時一律當作未知，不臆測。
 */
function isAllFree(requirement: string): boolean {
  return requirement.trim() === 'ナシ';
}

function moneyField(raw: string | null | undefined, srcKey: string): Field<Yen> {
  if (raw === null || raw === undefined || raw.trim() === '') return notListed('');
  const cleaned = decodeEntities(raw).replace(/[（）()]/g, '').trim();
  const r = parseMoney(cleaned);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${srcKey}=${cleaned}`);
    case 'zero': return known(yen(0), 'measured', `${srcKey}=${cleaned}`);
    case 'absent': return notListed(cleaned);
    case 'negotiable': return notListed(cleaned);
    default: return unparsed(`${srcKey}=${cleaned}`);
  }
}

/**
 * UR 的 `access` 是嚴格格式，不是自由文字，所以用專用解析器而不是通用的 parseStations：
 *   `<li>都営新宿線｢小川町｣駅 徒歩2分</li><li>東京メトロ千代田線「新御茶ノ水」駅 徒歩2分</li>`
 * 變體：全形數字（徒歩８分）、`｢｣` 與 `「」` 兩種括號、範圍（徒歩8～9分）、
 * 先搭公車（「銀座」駅 バス１５分徒歩１分）、路線後綴「ほか」。
 *
 * 用通用解析器會把路線前綴吃進站名（「・東武亀戸線亀戸駅」），
 * 因為它的 fallback regex 只能抓 駅 前最多 12 個字。
 */
const UR_ACCESS_RE =
  /(?<line>[^「｢<>｜]{0,30}?)[「｢](?<station>[^」｣]{1,20})[」｣]駅\s*(?:バス\s*(?<bus>[0-9０-９]+)\s*分)?\s*徒歩\s*(?<walk>[0-9０-９]+)(?:\s*[~～]\s*(?<walkMax>[0-9０-９]+))?\s*分/g;

const toHalf = (s: string): string =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function parseUrAccess(accessHtml: string): readonly Station[] {
  const text = decodeEntities(accessHtml).replace(/<\/li>/g, '｜').replace(/<[^>]+>/g, '');
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(UR_ACCESS_RE)) {
    const g = m.groups;
    if (g?.['station'] === undefined || g['walk'] === undefined) continue;
    const station = g['station'].trim();
    const line = (g['line'] ?? '').replace(/^[・｜\s]+/, '').trim();
    const walk = Number(toHalf(g['walk']));
    const bus = g['bus'] === undefined ? null : Number(toHalf(g['bus']));
    const key = `${line}|${station}`;
    if (seen.has(key) || !Number.isFinite(walk)) continue;
    seen.add(key);
    const rawText = m[0].trim();
    out.push({
      line,
      station,
      // 需先搭公車時，徒歩分鐘不是從車站走過去的距離，不可當步行距離用
      walkMinutes: bus === null
        ? known(walk, 'measured', rawText)
        : notListed(`${rawText}（含公車 ${bus} 分，徒歩分不代表從車站步行）`),
      rawText,
    });
  }
  return out;
}

function stationsOf(accessHtml: string): readonly Station[] {
  return parseUrAccess(accessHtml);
}

/**
 * 外國人申込資格。
 * UR 有明文條文（在留資格為永住者／特別永住者／中長期在留者），但那是**全站共通的申込規則**，
 * 不是逐物件欄位——所以這裡只填「保證人不需要」這個確實逐物件成立的事實，
 * 其餘留給站上的來源說明，不假裝是物件屬性。
 */
function foreignerPolicy(requirement: string): ForeignerPolicy {
  const free = isAllFree(requirement);
  return {
    welcomed: notOffered<boolean>(),
    residenceCardRequired: notOffered<boolean>(),
    japaneseRequired: notOffered<boolean>(),
    guarantorCompanyRequired: notOffered<boolean>(),
    guarantorPersonRequired: free
      ? known(false, 'measured', `requirement=${requirement}（礼金・仲介手数料・更新料・保証人 ナシ）`)
      : notListed(requirement),
    rawText: free ? '礼金・仲介手数料・更新料・保証人：ナシ' : requirement,
  };
}

function buildBuilding(b: UrBuilding, raw: RawDoc): Building {
  return {
    id: `ur:${b.id}`,
    sourceId: 'ur',
    sourceKey: b.id,
    sourceUrl: `${SITE}${b.bukkenUrl}`,
    name: decodeEntities(b.name),
    kind: 'apartment',
    addressRaw: '',
    prefecture: '東京都',
    ward: decodeEntities(b.skcs),
    stations: stationsOf(b.access),
    structure: notOffered<string>(),
    yearBuilt: notOffered<number>(),
    floorsAboveGround: notListed(''),
    totalUnits: notListed(''),
    imageUrls: b.image === '' ? [] : [b.image],
    fetchedAt: raw.fetchedAt,
    sourceUpdatedAt: notOffered<string>(),
    htmlSha256: raw.sha256,
  };
}

function buildUnit(buildingId: string, b: UrBuilding, r: UrRoom): Unit {
  // 兩個租金欄位擇一，見 UrRoom.rent_normal 的說明
  const rentRaw = r.rent.trim() !== '' ? r.rent : (r.rent_normal ?? '');
  const rentKey = r.rent.trim() !== '' ? 'rent' : 'rent_normal';
  const rentF = moneyField(rentRaw, rentKey);
  const free = isAllFree(r.requirement);
  const zeroSrc = `requirement=${r.requirement}`;
  const freeYen = (): Field<Yen> => known(yen(0), 'measured', zeroSrc);

  // 敷金以「N か月」表示。賃料已知時換算成金額——這是對已載明事實做算術，
  // 不是憑空生值；賃料未知時一律留未知。
  let deposit: Field<Yen> = notListed(r.shikikin);
  const shikiMonths = /^(\d+(?:\.\d+)?)\s*(?:か月|ヶ月|ヵ月|カ月)$/.exec(r.shikikin.trim());
  if (shikiMonths?.[1] !== undefined && rentF.known) {
    const months = Number(shikiMonths[1]);
    if (Number.isFinite(months)) {
      deposit = known(yen(Math.round(months * rentF.v.jpy)), 'measured',
        `shikikin=${r.shikikin} × rent=${rentF.v.jpy}`);
    }
  } else if (/ナシ|なし/.test(r.shikikin)) {
    deposit = known(yen(0), 'measured', `shikikin=${r.shikikin}`);
  }

  const area = parseArea(decodeEntities(r.floorspace));
  const floorM = /^(\d+)階$/.exec(r.floor.trim());

  return {
    id: `${buildingId}#${r.id}`,
    buildingId,
    unitKey: r.id,
    sourceUrl: `${SITE}${r.roomDetailLink}`,
    roomNo: known(decodeEntities(r.name), 'measured', `name=${r.name}`),
    layout: r.type.trim() === '' ? notListed('') : known(r.type.trim(), 'measured', `type=${r.type}`),
    areaM2: area.kind === 'exact'
      ? known(area.m2, 'measured', `floorspace=${decodeEntities(r.floorspace)}`)
      : area.kind === 'lower_bound'
        ? known(area.m2AtLeast, 'measured', `floorspace=${decodeEntities(r.floorspace)}（帖數下界）`)
        : notListed(decodeEntities(r.floorspace)),
    floor: floorM?.[1] !== undefined
      ? known(Number(floorM[1]), 'measured', `floor=${r.floor}`)
      : notListed(r.floor),
    monthly: {
      rent: rentF,
      adminFee: moneyField(r.commonfee ?? b.commonfee, 'commonfee'),
      utilities: notOffered<Yen>(),
      internet: notOffered<Yen>(),
      otherMonthly: notOffered<Yen>(),
    },
    initial: {
      keyMoney: free ? freeYen() : notListed(r.requirement),
      deposit,
      depositNonRefundable: notOffered<Yen>(),
      agencyFee: free ? freeYen() : notListed(r.requirement),
      guarantorInitialFee: notOffered<Yen>(),
      fireInsurance: notOffered<Yen>(),
      keyExchangeFee: notOffered<Yen>(),
      contractFee: notOffered<Yen>(),
      cleaningFeeUpfront: notOffered<Yen>(),
      otherInitial: notOffered<Yen>(),
    },
    deferred: {
      renewalFee: free ? freeYen() : notListed(r.requirement),
      renewalAdminFee: notOffered<Yen>(),
      cleaningFeeOnExit: notOffered<Yen>(),
      earlyTerminationPenalty: notOffered<Yen>(),
    },
    // UR 的水電一律自行與各事業者簽約，不含在賃料內；但站上不逐物件載明金額。
    utilitiesBasis: 'excluded',
    furnished: notOffered<boolean>(),
    availableFrom: known('随時', 'measured', 'UR は空室即入居可'),
    isVacant: known(true, 'measured', '出現在空室 API 回傳中'),
    contractType: 'unknown',
    contractMonths: notOffered<number>(),
    minStayMonths: notOffered<number>(),
    genderRestriction: 'unknown',
    ageLimitRaw: notOffered<string>(),
    petsAllowed: notOffered<boolean>(),
    foreigner: foreignerPolicy(r.requirement),
    notes: free ? ['礼金・仲介手数料・更新料・保証人 いずれもナシ（UR 官方條件）'] : [],
  };
}

/** POST 到 UR 的 API。fetcher 只做 GET，所以這裡自己送但沿用同一套節流語意。 */
async function postJson<T>(path: string, body: string, delayMs: number): Promise<T> {
  await new Promise((r) => setTimeout(r, delayMs));
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': UR_UA,
    },
    body,
  });
  if (!res.ok) throw new Error(`[ur api ${res.status}] ${path} ${body}`);
  return (await res.json()) as T;
}

const UR_UA = 'TokyoRentCompare/0.1 (personal rental price-comparison aggregator; links back to ur-net.go.jp)';

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, _fetcher: Fetcher): AsyncGenerator<TargetRef> {
    for (const area of TOKYO_AREAS) {
      const buildings = await postJson<UrBuilding[]>(
        '/bukken/search/list_bukken/', `tdfk=13&area=${area}&vacancy=1`, manifest.crawlDelayMs,
      );
      for (const b of buildings) {
        if (b.roomCount <= 0) continue; // 無空室，房間 API 會回 null
        const rooms = await fetchRooms(b);
        if (rooms.length === 0) continue;
        yield {
          url: `${SITE}${b.bukkenUrl}`,
          hint: { ...b, __rooms: rooms } as unknown as Record<string, unknown>,
        };
      }
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const b = ref.hint as unknown as UrBuilding | undefined;
    if (b === undefined || typeof b.id !== 'string') return null;
    const rooms = (ref.hint?.['__rooms'] as UrRoom[] | undefined) ?? [];
    const building = buildBuilding(b, raw);
    return { building, units: rooms.map((r) => buildUnit(building.id, b, r)) };
  },
};

/**
 * 房間層要另外打 API 且有分頁（rowMax=5）。
 * crawl 執行器只會 GET 詳情頁，所以這裡先把房間掛進 hint，再交給 extract。
 */
export async function fetchRooms(b: UrBuilding): Promise<UrRoom[]> {
  const key = splitBuildingId(b.id);
  if (key === null) return [];
  const out: UrRoom[] = [];
  for (let page = 0; page < 40; page++) {
    const body = `shisya=${key.shisya}&danchi=${key.danchi}&shikibetu=${key.shikibetu}`
      + `&orderByField=0&orderBySort=0&pageIndex=${page}&sp=`;
    const rows = await postJson<UrRoom[] | null>('/bukken/detail/detail_bukken_room/', body, manifest.crawlDelayMs);
    if (rows === null || rows.length === 0) break;
    out.push(...rows);
    const all = Number(rows[0]?.allCount ?? '0');
    if (!Number.isFinite(all) || out.length >= all) break;
  }
  return out;
}

export default adapter;
