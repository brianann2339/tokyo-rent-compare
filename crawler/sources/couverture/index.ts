/**
 * Couverture（クーベルチュール）adapter——東京 share house，約 25 棟。
 *
 * 規模最小但值得收：它的房間層資料很完整（逐間列房號／空室狀況／面積／賃料／共益費／備考），
 * 而且是使用者一開始就點名的來源之一。
 *
 * ⚠️ 全站沒有礼金與敷金欄位（2026-08-16 對 detail 與 list 頁 grep 皆為 0）。
 * 這是**來源的穩定屬性**不是解析故障，所以宣告在 capabilities.neverProvides，
 * 健康檢查才不會對它產生永遠 0% 的假警報。
 *
 * 清單來源是 `map.html` 不是 sitemap.xml——後者 lastmod 停在 2019 且與實況不符
 * （少了 akabanenishi、ikebukurowest 等實際存在的物件）。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseGender } from '../../../packages/jp-parse/src/contract.ts';

const SITE = 'https://couverture.jp';

export const manifest: SourceManifest = {
  id: 'couverture',
  name: 'クーベルチュール',
  nameZh: 'Couverture',
  homepage: 'https://couverture.jp/',
  origin: 'https://couverture.jp',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'contractFee', 'areaM2', 'roomNo',
      'isVacant', 'furnished', 'genderRestriction', 'stations', 'totalUnits',
    ],
    // 全站不刊登這些欄位——宣告出來，健康檢查才不會誤報
    neverProvides: [
      'keyMoney', 'deposit', 'depositNonRefundable', 'agencyFee',
      'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee', 'cleaningFeeUpfront',
      'otherInitial', 'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit',
      'earlyTerminationPenalty', 'utilities', 'internet', 'otherMonthly',
      'availableFrom', 'minStayMonths', 'contractMonths', 'contractType',
      'ageLimitRaw', 'petsAllowed', 'floor',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
      'structure', 'yearBuilt', 'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      '/robots.txt 回 HTTP 404（回傳站內 404 HTML 頁）→ 全站無 robots.txt，'
      + '無任何 Disallow、無 Crawl-delay。自訂 3 秒間隔。'
      + '站內找不到任何利用規約／terms／kiyaku／policy 頁面，頁尾僅有 '
      + '「(C) Couverture. All Rights Reserved.」。'
      + '⚠️ 找不到條款只能證明「站內無公開連結」，不能證明其不存在或無主張。'
      + '每筆房源標示出處並連回原站。',
  },
};

function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/[ \t\r\n]+/g, ' ');
}

/** `[1]東京メトロ千代田線｜「代々木公園駅」徒歩10分` */
// 注意「駅」字在括號**內**：`「代々木公園駅」徒歩10分`，不是 `「代々木公園」駅`。
const CV_STATION_RE = /\[(\d+)\]([^｜]{2,24}?)｜?[「｢]([^」｣]{1,14}?)駅?[」｣]\s*徒歩\s*(\d+)\s*分/g;

export function parseCvStations(t: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(CV_STATION_RE)) {
    const line = (m[2] ?? '').trim();
    const station = (m[3] ?? '').trim();
    const walk = Number(m[4]);
    const key = `${line}|${station}`;
    if (station === '' || seen.has(key) || !Number.isFinite(walk)) continue;
    seen.add(key);
    out.push({
      line, station,
      walkMinutes: known(walk, 'measured', m[0].replace(/｜/g, ' ').trim()),
      rawText: `${line}「${station}駅」徒歩${walk}分`,
    });
  }
  return out;
}

export type CvRoom = {
  number: string; vacant: boolean;
  areaM2: Field<number>; rent: Field<Yen>; adminFee: Field<Yen>;
  remarks: string; wetArea: boolean;
};

/**
 * 房間列樣式：
 * `部屋番号｜ ｜001｜ … ｜空室状況｜ ｜満室｜ ｜面積｜ ｜12.7m｜2｜8.2帖｜ ｜賃料｜ ｜¥74,000｜ ｜共益費｜ ｜¥17,000｜ ｜備考｜…`
 * 注意面積被 `<sup>2</sup>` 切成「12.7m｜2」，要先還原成 12.7m2。
 */
export function parseCvRooms(html: string): CvRoom[] {
  const t = text(html).replace(/(\d+(?:\.\d+)?)\s*m｜2/g, '$1m2');
  const out: CvRoom[] = [];
  const re = /部屋番号｜\s*｜?\s*([0-9A-Za-z-]{1,8})\s*｜[\s\S]{0,80}?空室状況｜\s*｜?\s*([^｜]{1,12})｜[\s\S]{0,60}?面積｜\s*｜?\s*([^｜]{1,24})｜[\s\S]{0,40}?賃料｜\s*｜?\s*([^｜]{1,16})｜[\s\S]{0,40}?共益費｜\s*｜?\s*([^｜]{1,16})｜([\s\S]{0,220}?)(?=部屋番号｜|$)/g;
  for (const m of t.matchAll(re)) {
    const number = (m[1] ?? '').trim();
    const status = (m[2] ?? '').trim();
    const areaRaw = (m[3] ?? '').trim();
    const rentRaw = (m[4] ?? '').trim();
    const adminRaw = (m[5] ?? '').trim();
    const remarks = (m[6] ?? '').replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (number === '') continue;

    const area = parseArea(areaRaw);
    const rent = parseMoney(rentRaw);
    const admin = parseMoney(adminRaw);

    out.push({
      number,
      // 「満室」＝已滿；其餘（空室／即入居可）視為有空房
      vacant: !/満室/.test(status),
      areaM2: area.kind === 'exact'
        ? known(area.m2, 'measured', `面積 ${areaRaw}`)
        : notListed(areaRaw),
      rent: rent.kind === 'amount'
        ? known(yen(rent.jpy), 'measured', `賃料 ${rentRaw}`)
        : notListed(rentRaw),
      adminFee: admin.kind === 'amount'
        ? known(yen(admin.jpy), 'measured', `共益費 ${adminRaw}`)
        : notListed(adminRaw),
      remarks,
      // 「水回り付き個室」的判定依據：備考明寫居室內有浴室或廁所
      wetArea: /居室内浴室|居室内トイレ|水回り付/.test(remarks),
    });
  }
  return out;
}

/** `【契約手数料】個室：40,000円 水回り付き個室：50,000円` */
export function parseContractFees(t: string): { plain: number | null; wet: number | null; raw: string } {
  const i = t.indexOf('初期費用');
  const seg = i >= 0 ? t.slice(i, i + 300) : '';
  const plainM = /(?<!水回り付き)個室[：:]\s*([0-9,]+)\s*円/.exec(seg.replace(/水回り付き個室[：:]\s*[0-9,]+\s*円/, ''));
  const wetM = /水回り付き個室[：:]\s*([0-9,]+)\s*円/.exec(seg);
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const r = parseMoney(`${s}円`);
    return r.kind === 'amount' ? r.jpy : null;
  };
  return {
    plain: num(plainM?.[1]),
    wet: num(wetM?.[1]),
    raw: seg.replace(/｜/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notOffered<boolean>(),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    // sitemap.xml 的 lastmod 停在 2019 且漏收實際存在的物件，改以 map.html 為準
    const list = await fetcher.get(`${SITE}/map.html`);
    const slugs = new Set(
      [...list.body.matchAll(/house_detail\/([a-z0-9-]+)\//g)]
        .map((m) => m[1])
        .filter((s): s is string => s !== undefined),
    );
    for (const slug of slugs) yield { url: `${SITE}/house_detail/${slug}/` };
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const html = raw.body;
    const t = text(html);
    const nameM = /<title>シェアハウス\s*([^|｜<]+)/.exec(html);
    const name = (nameM?.[1] ?? '').trim();
    if (name === '') return null;

    // 「区市」優先且非貪婪——`東京都渋谷区元代々木町` 的行政区是「渋谷区」，
    // 若讓 `[区市町村]` 貪婪匹配會得到「渋谷区元代々木町」。
    // 「東京都」是**選用**的：部分頁面直接寫 `住所｜豊島区北大塚3丁目`（省略都名）。
    const addrM = /住所｜\s*｜?\s*((?:東京都)?([^｜\s]{1,6}?[区市])[^｜\s]{0,20})/.exec(t);
    if (addrM?.[1] === undefined || addrM[2] === undefined) return null;

    const slug = /house_detail\/([a-z0-9-]+)/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `couverture:${slug}`;
    const roomsCountM = /部屋数｜\s*｜?\s*(\d+)\s*部屋/.exec(t);
    const fees = parseContractFees(t);
    const rooms = parseCvRooms(html);
    const gender = parseGender(t);
    const imgM = /<meta property="og:image" content="([^"]+)"/.exec(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'couverture',
      sourceKey: slug,
      sourceUrl: ref.url,
      name,
      kind: 'sharehouse',
      addressRaw: addrM[1].startsWith('東京都') ? addrM[1] : `東京都${addrM[1]}`,
      prefecture: '東京都',
      ward: addrM[2],
      stations: parseCvStations(t),
      structure: notOffered<string>(),
      yearBuilt: notOffered<number>(),
      floorsAboveGround: notListed(''),
      totalUnits: roomsCountM?.[1] !== undefined
        ? known(Number(roomsCountM[1]), 'measured', `部屋数 ${roomsCountM[1]}部屋`)
        : notListed(''),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    const units: Unit[] = rooms.filter((r) => r.vacant).map((r) => {
      // 契約手数料分「個室」與「水回り付き個室」兩價，依備考是否明寫居室內浴室／廁所判定。
      // 規則本身來自同一頁的「【契約手数料】個室：40,000円 水回り付き個室：50,000円」，
      // 判定依據也來自同一頁的備考欄——兩邊都有出處，srcText 記錄推導過程供稽核。
      const feeJpy = r.wetArea ? fees.wet : fees.plain;
      const contractFee: Field<Yen> = feeJpy === null
        ? notListed(fees.raw)
        : known(yen(feeJpy), 'measured',
          `${fees.raw}｜備考=${r.wetArea ? '居室內有水回り' : '無水回り記載'}`);

      return {
        id: `${buildingId}#${r.number}`,
        buildingId,
        unitKey: r.number,
        sourceUrl: ref.url,
        roomNo: known(r.number, 'measured', `部屋番号 ${r.number}`),
        layout: known('個室', 'measured', 'share house 個室'),
        areaM2: r.areaM2,
        floor: notOffered<number>(),
        monthly: {
          rent: r.rent,
          adminFee: r.adminFee,
          utilities: notOffered<Yen>(),
          internet: notOffered<Yen>(),
          otherMonthly: notOffered<Yen>(),
        },
        initial: {
          keyMoney: notOffered<Yen>(),
          deposit: notOffered<Yen>(),
          depositNonRefundable: notOffered<Yen>(),
          agencyFee: notOffered<Yen>(),
          guarantorInitialFee: notOffered<Yen>(),
          fireInsurance: notOffered<Yen>(),
          keyExchangeFee: notOffered<Yen>(),
          contractFee,
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
        furnished: known(true, 'measured', '個室部分設備：冷蔵庫、エアコン、ベット、クローゼット、机、椅子…'),
        availableFrom: notOffered<string>(),
        isVacant: known(true, 'measured', '空室状況欄非「満室」'),
        contractType: 'unknown',
        contractMonths: notOffered<number>(),
        minStayMonths: notOffered<number>(),
        genderRestriction: gender,
        ageLimitRaw: notOffered<string>(),
        petsAllowed: notOffered<boolean>(),
        foreigner: NOT_OFFERED_FOREIGNER,
        notes: r.remarks === '' ? [] : [`備考：${r.remarks}`],
      };
    });

    return { building, units };
  },
};

export default adapter;
