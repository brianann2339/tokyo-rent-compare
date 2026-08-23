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
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, PropertyKind, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
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
    ],
    neverProvides: [
      'utilities', 'internet', 'otherMonthly', 'depositNonRefundable',
      'fireInsurance', 'keyExchangeFee', 'cleaningFeeUpfront', 'otherInitial',
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

/** 把 HTML 轉成以 ｜ 分隔的可掃描文字。 */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/[ \t\r\n]+/g, ' ');
}

/** 取 `標籤｜…｜¥金額` 樣式的金額。Oak House 的 ¥ 與數字常被標籤切開。 */
function labelledMoney(t: string, label: string): { raw: string; jpy: number } | null {
  const re = new RegExp(`${label}｜[^0-9]{0,40}([0-9,]{3,})`);
  const m = re.exec(t);
  if (m?.[1] === undefined) return null;
  const r = parseMoney(`${m[1]}円`);
  if (r.kind !== 'amount' && r.kind !== 'zero') return null;
  return { raw: `${label} ¥${m[1]}`, jpy: r.kind === 'zero' ? 0 : r.jpy };
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
    furnished: has('家具・家電付き') || has('家具家電付き'),
    foreignerOk: has('外国人入居可'),
    raw: seg.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

export type OakRoom = {
  id: string; number: string; vacant: boolean;
  rent: Field<Yen>; adminFee: Field<Yen>; contractFee: Field<Yen>;
  areaM2: Field<number>; layout: Field<string>; floor: Field<number>;
  kind: PropertyKind; gender: GenderRestriction;
  foreignerOk: boolean; furnished: boolean | null; rawText: string;
};

const ROOM_KIND: Record<string, PropertyKind> = {
  apartment: 'apartment', sharehouse: 'sharehouse', social: 'social', dormitory: 'dormitory',
};

export function parseRooms(html: string): OakRoom[] {
  const out: OakRoom[] = [];
  for (const m of html.matchAll(/<tr\s+id="(\d+)"[\s\S]*?<\/tr>/g)) {
    const row = m[0];
    const id = m[1];
    if (id === undefined || !row.includes('data-sort_price')) continue;
    const t = text(row);

    const attr = (name: string): string | null => {
      const a = new RegExp(`data-${name}="([^"]*)"`).exec(row);
      return a?.[1] ?? null;
    };

    // 房號是列首第一個純數字／英數短字串
    const numM = /^[｜\s]*([0-9A-Za-z-]{1,8})\s*｜\s*(?:満室|空室|入居|即入居)/.exec(t)
      ?? /｜\s*([0-9A-Za-z-]{1,8})\s*｜\s*(?:満室|空室|即入居)/.exec(t);
    const status = attr('status');
    const area = parseArea((/広さ｜\s*([0-9.]+\s*(?:㎡|m2|m²))/.exec(t)?.[1]) ?? '');
    const layoutRaw = /間取り｜[\s｜]*([0-9A-Za-z]{1,6})\s*｜/.exec(t)?.[1] ?? '';
    const floorRaw = attr('floor');
    // ⚠️ 這裡只掃「房間列」的文字，不掃整頁——整頁的「入居条件」會先命中
    // 網站導覽選單的同名標題（那裡列的是全站篩選項目，不是這間房的條件）。
    const cond = /入居条件｜([\s\S]{0,260}?)(?:｜内装|｜ 空室通知|$)/.exec(t)?.[1] ?? '';

    out.push({
      id,
      number: numM?.[1] ?? id,
      vacant: status !== null && status !== 'novacancy',
      rent: moneyOf(t, '賃料'),
      adminFee: moneyOf(t, '共益費'),
      contractFee: moneyOf(t, '契約料'),
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

function foreignerPolicy(badges: OakBadges, roomOk: boolean): ForeignerPolicy {
  const ok = badges.foreignerOk || roomOk;
  return {
    welcomed: ok
      ? known(true, 'measured', '外国人入居可')
      : notListed(badges.raw),
    residenceCardRequired: notOffered<boolean>(),
    japaneseRequired: notOffered<boolean>(),
    guarantorCompanyRequired: badges.noGuarantorCompany
      ? known(false, 'measured', '保証会社不要')
      : notListed(badges.raw),
    guarantorPersonRequired: badges.noGuarantorPerson
      ? known(false, 'measured', '保証人不要')
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

    const structM = /建物概要｜\s*([^｜]{2,30}造[^｜]{0,12})/.exec(t);
    const imgM = /<meta property="og:image" content="([^"]+)"/.exec(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'oakhouse',
      sourceKey: key,
      sourceUrl: ref.url,
      name,
      // 房間列的 data-type 是第一手；滿室時沒有房間列，退而用產品線判定（/house/ 必為 share house）
      kind: rooms[0]?.kind ?? (isShareHouseLine ? 'sharehouse' : 'unknown'),
      addressRaw: `${addr.prefecture}${addr.ward}${addr.town}`,
      prefecture: addr.prefecture,
      ward,
      stations: parseOakStations(t),
      structure: structM?.[1] !== undefined
        ? known(structM[1].trim(), 'measured', `建物概要 ${structM[1].trim()}`)
        : notListed(''),
      yearBuilt: notListed(''),
      floorsAboveGround: notListed(''),
      totalUnits: known(rooms.length, 'measured', `房間列 ${rooms.length} 筆`),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    const zeroIf = (flag: boolean, label: string): Field<Yen> =>
      flag ? known(yen(0), 'measured', label) : notListed(badges.raw);

    const units: Unit[] = rooms.filter((r) => r.vacant).map((r) => ({
      id: `${buildingId}#${r.id}`,
      buildingId,
      unitKey: r.id,
      sourceUrl: ref.url,
      roomNo: known(r.number, 'measured', `房號 ${r.number}`),
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
        keyMoney: zeroIf(badges.noKeyMoney, '礼金なし'),
        deposit: zeroIf(badges.noDeposit, '敷金なし'),
        depositNonRefundable: notOffered<Yen>(),
        agencyFee: zeroIf(badges.noAgencyFee, '仲介手数料なし'),
        guarantorInitialFee: zeroIf(badges.noGuarantorCompany, '保証会社不要'),
        fireInsurance: notOffered<Yen>(),
        keyExchangeFee: notOffered<Yen>(),
        contractFee: r.contractFee,
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
