/**
 * Village House（ビレッジハウス・マネジメント株式会社）adapter。
 *
 * 全國 1,064 筆物件、**東京只有 7 筆**（2026-08-16 對 sitemap 實測），
 * 但值得收：它是「敷金0・礼金0・仲介手数料0」宣傳的代表，
 * 而真正的成本藏在別的地方——沒把那些抓出來，這個來源在比價表上會假性最便宜。
 *
 * ⚠️ 必須抓的反向成本（漏掉會誤導使用者）：
 *   短期解約違約金：1年未満は3ヵ月分、2年未満は2ヵ月分 → deferred.earlyTerminationPenalty
 *   退去時クリーニング費用：逐間列金額（1,210円/m² × 専有面積）→ deferred.cleaningFeeOnExit
 *   火災保険：要加入 10,000 円～（2年）→ initial.fireInsurance（「～」是下限）
 *
 * ⚠️ robots.txt（2026-08-16 實測）明確 Disallow `/api/`。站上確實有
 * `/api/search.json` 這種好用的端點，**不可以呼叫**。清單一律走 sitemap。
 *
 * ⚠️ 管理費／共益費**不在靜態 HTML 裡**：只有「初期費用算出シミュレーション」
 * 的 JS 算得出來，而該表單的初始值 `0 円` 是欄位預設值不是這間房的管理費。
 * 填 0 就是把「不知道」變成「免費」——一律 notListed。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy,
} from '../../../packages/schema/src/model.ts';
import { parseMoney, monthsToYen } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseWalk } from '../../../packages/jp-parse/src/station.ts';
import { parseYearBuilt, parseEarlyTermination, parseForeignerSignals } from '../../../packages/jp-parse/src/contract.ts';
import { statesFurnished } from '../../../packages/jp-parse/src/text.ts';

const SITE = 'https://www.villagehouse.jp';

export const manifest: SourceManifest = {
  id: 'villagehouse',
  name: 'ビレッジハウス',
  nameZh: 'Village House',
  homepage: 'https://www.villagehouse.jp/',
  origin: 'https://www.villagehouse.jp',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'keyMoney', 'deposit', 'fireInsurance',
      'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'layout', 'areaM2', 'roomNo', 'floor', 'isVacant', 'availableFrom', 'furnished',
      'stations', 'structure', 'yearBuilt', 'floorsAboveGround', 'totalUnits',
    ],
    neverProvides: [
      'depositNonRefundable', 'keyExchangeFee', 'contractFee',
      'cleaningFeeUpfront', 'otherInitial',
      'renewalFee', 'renewalAdminFee',
      'internet', 'otherMonthly',
      'ageLimitRaw', 'genderRestriction',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測，51 行）：`User-agent: *` 群組的 Disallow 含 '
      + '/api/、/ajax/、/sitecore/、/application-form/、/wp-admin/、/message/*、'
      + '/*?utm_*=*、/valuecommerce-bridge/；另有 GPTBot／OAI-SearchBot／ChatGPT-User 的 Allow: /。'
      + '物件頁路徑 /chintai/ 未被 Disallow。無 Crawl-delay，自訂 3 秒間隔。'
      + '⚠️ /api/ 被明確禁止，因此不呼叫 /api/search.json，清單一律走 sitemap.xml。'
      + '站內找不到獨立的利用規約頁（/terms/、/policy/ 等皆 404），'
      + '唯一相關的是每頁頁尾的「©VILLAGE HOUSE. All rights reserved. （不許複製・禁無断転載）」。'
      + '⚠️ 這句對複製與轉載有明確主張——本站只保存解析後的欄位並標示出處連回原站，'
      + '不轉載頁面內容；若站方另有主張應即停止收錄。',
  },
};

/** 情報表的一格：`<th>所在地</th> <td>東京都昭島市郷地町3-10</td>` */
export function vhCell(html: string, label: string): string | null {
  const m = new RegExp(`<th>${label}</th>\\s*<td>([\\s\\S]*?)</td>`).exec(html);
  const v = m?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return v === undefined || v === '' ? null : v;
}

/**
 * 交通機關：`<strong>西立川 - JR青梅線</strong><small>1.8～2.0 km, 徒歩 23.0～26.0 分</small>`
 *
 * 兩件事要注意：
 *  1. 站名在前、路線在後（跟其他來源相反），所以不能用共用的 parseStationLine。
 *  2. 清單裡混了公車站（`昭島団地入口バス停留所`）。它們沒有路線、也不是「駅」，
 *     混進 stations 會讓「離最近車站幾分鐘」這個欄位失真——排除，但步行分鐘
 *     仍交給共用的 parseWalk 解析（它本來就是為這個「1.8～2.0 km, 徒歩 23.0～26.0 分」寫的）。
 */
const VH_STATION_RE = /<li>\s*<strong>([^<]+)<\/strong>\s*<small>([^<]+)<\/small>\s*<\/li>/g;

export function parseVhStations(html: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(VH_STATION_RE)) {
    const head = (m[1] ?? '').trim();
    const dist = (m[2] ?? '').trim();
    if (/バス停留所$/.test(head)) continue;
    const parts = head.split(/\s+-\s+/);
    const station = (parts[0] ?? '').trim();
    const line = (parts[1] ?? '').trim();
    if (station === '' || line === '') continue;
    const key = `${line}|${station}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = parseWalk(dist);
    // 範圍（大型團地各棟距離不同）一律取下界並在 srcText 標明，不取中位數也不取上界
    const minutes = w.kind === 'exact' ? w.minutes : w.kind === 'range' ? w.minMinutes : null;
    out.push({
      line,
      station,
      walkMinutes: minutes === null
        ? notListed(dist)
        : known(minutes, 'measured', `${head} ${dist}${w.kind === 'range' ? '（範圍取下界）' : ''}`),
      rawText: `${head} ${dist}`,
    });
  }
  return out;
}

export type VhRoom = {
  readonly roomNo: string;
  readonly layout: string;
  readonly areaRaw: string;
  readonly rentRaw: string;
  readonly depositRaw: string;
  readonly keyMoneyRaw: string;
  readonly floorRaw: string;
  readonly availableFromRaw: string;
  readonly cleaningOnExitRaw: string;
  readonly benefits: readonly string[];
};

const ROOM_OPEN_RE = /<div\s([^>]*?)class='container-rooms-group-card-list-item'>/g;

function attr(attrs: string, name: string): string {
  return (new RegExp(`${name}='([^']*)'`).exec(attrs)?.[1] ?? '').trim();
}

/**
 * 「間取別 部屋情報」的房間卡。
 *
 * 空室なし的物件在群組卡上帶 `data-disabled` 且**完全沒有** list-item 區塊
 * → 自然回空陣列，不必另外判斷。
 *
 * 區段邊界很重要：頁面下方的「内見予約フォーム」與「新規入居申込フォーム」
 * 也列出同一批房間的家賃／面積／房號，不切邊界會把每間房重複收兩次。
 */
export function parseVhRooms(html: string): VhRoom[] {
  const s = html.indexOf("container-instance container-rooms'");
  if (s < 0) return [];
  const e = html.indexOf('container-company-profile', s);
  const section = html.slice(s, e < 0 ? html.length : e);

  const opens = [...section.matchAll(ROOM_OPEN_RE)];
  const out: VhRoom[] = [];
  for (let i = 0; i < opens.length; i += 1) {
    const m = opens[i];
    if (m?.index === undefined) continue;
    const block = section.slice(m.index, opens[i + 1]?.index ?? section.length);
    const attrs = m[1] ?? '';

    const brief = /container-rooms-group-card-list-item-info-brief'>\s*<strong>([^<]*)<\/strong>\s*<small>([^<]*)<\/small>\s*<p>([^<]*)<\/p>/
      .exec(block);
    const roomNo = attr(attrs, 'data-room');
    if (roomNo === '') continue;

    const ymd = attr(attrs, 'data-move-in-available-date');
    out.push({
      roomNo,
      layout: (brief?.[1] ?? '').trim(),
      areaRaw: (brief?.[2] ?? '').trim(),
      // ¥ 與數字之間隔著 </span><strong>，所以取 rent 區塊裡的第一個 ¥金額
      rentRaw: (/-info-price-rent'>[\s\S]*?(¥[\d,]+)/.exec(block)?.[1] ?? '').trim(),
      depositRaw: (/敷金:\s*(¥[\d,]+)/.exec(block)?.[1] ?? '').trim(),
      keyMoneyRaw: (/礼金:\s*(¥[\d,]+)/.exec(block)?.[1] ?? '').trim(),
      // `3-306 南向き(3号棟 / 3階部分)`
      floorRaw: (/(\d+)\s*階部分/.exec(brief?.[3] ?? '')?.[1] ?? '').trim(),
      availableFromRaw: /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : '',
      cleaningOnExitRaw: vhCell(block, '退去時クリーニング費用') ?? '',
      benefits: [...block.matchAll(/container-rooms-benefit-content'>\s*<div class='container-rooms-benefit-title'>([^<]*)<\/div>\s*<p>([^<]*)<\/p>/g)]
        .map((b) => `${(b[1] ?? '').trim()}：${(b[2] ?? '').trim()}`),
    });
  }
  return out;
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    // robots.txt 禁 /api/，所以不用 /api/search.json；sitemap.xml 是 sitemapindex，
    // 物件在 sitemap_property_page_map_jp.xml（1,064 筆，全國）。
    const index = await fetcher.get(`${SITE}/sitemap.xml`);
    const propMap = /<loc>(\S*sitemap_property_page_map_jp\.xml)<\/loc>/.exec(index.body)?.[1];
    if (propMap === undefined) {
      throw new Error('sitemap.xml 找不到 sitemap_property_page_map_jp.xml——sitemap 結構可能已改版');
    }
    const props = await fetcher.get(propMap);
    // 只收東京都：物件 URL 的 pref 段就是 tokyo（extract 會再用所在地確認一次）
    const urls = [...props.body.matchAll(/<loc>(https:\/\/www\.villagehouse\.jp\/chintai\/[a-z-]+\/tokyo\/[^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((u): u is string => u !== undefined);
    if (urls.length === 0) {
      throw new Error('物件 sitemap 解析不到任何東京物件——sitemap 格式可能已改版');
    }
    const seen = new Set<string>();
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      yield { url: u };
    }
  },

  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null {
    const html = raw.body;
    const name = /<h1 class='container-showcase-heading'>([^<]+)<\/h1>/.exec(html)?.[1]?.trim() ?? '';
    if (name === '') return null;

    const addr = vhCell(html, '所在地');
    if (addr === null) return null;
    // 只收東京都。sitemap 是全國的，且 URL 段是站方填的、不是我們能保證的事實。
    const wardM = /^東京都([^\s0-9]{1,6}?[区市])/.exec(addr);
    if (wardM?.[1] === undefined) return null;

    const key = /\/([a-z0-9-]+-(\d+))\/?$/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `villagehouse:${key}`;

    const structRaw = vhCell(html, '構造•階建て') ?? '';
    const structure = /^([^/]*造)/.exec(structRaw)?.[1]?.trim() ?? '';
    const floorsN = Number(/(\d+)\s*階建/.exec(structRaw)?.[1] ?? '');
    const yearRaw = vhCell(html, '築年月') ?? '';
    const yearBuilt = parseYearBuilt(yearRaw, ctx.now);
    const unitsRaw = vhCell(html, '棟/戸数') ?? '';
    const totalUnitsN = Number(/総戸数\s*(\d+)\s*戸/.exec(unitsRaw)?.[1] ?? '');
    const imgM = /container-showcase-gallery[\s\S]{0,600}?<img src='(https:\/\/[^']+)'/.exec(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'villagehouse',
      sourceKey: key,
      sourceUrl: ref.url,
      name,
      kind: 'apartment',
      addressRaw: addr,
      prefecture: '東京都',
      ward: wardM[1],
      stations: parseVhStations(html),
      structure: structure === ''
        ? notListed(structRaw)
        : known(structure, 'measured', `構造•階建て ${structRaw}`),
      yearBuilt: yearBuilt === null
        ? notListed(yearRaw)
        : known(yearBuilt, 'measured', `築年月 ${yearRaw}`),
      floorsAboveGround: Number.isFinite(floorsN) && floorsN > 0
        ? known(floorsN, 'measured', `構造•階建て ${structRaw}`)
        : notListed(structRaw),
      totalUnits: Number.isFinite(totalUnitsN) && totalUnitsN > 0
        ? known(totalUnitsN, 'measured', `棟/戸数 ${unitsRaw}`)
        : notListed(unitsRaw),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    // ---- 建物層的條件文字。這些是「零初期費用」宣傳底下的真實成本與但書 ----
    const fireRaw = vhCell(html, '火災保険') ?? '';
    const fire = parseMoney(fireRaw);
    // 「要加入 10,000 円～（2年）」是下限不是定額。Field<Yen> 只能存單一值，
    // 全專案的合計本來就是下界語意（sumYen.lower），所以取下限並在 srcText 保留「～」，
    // 讓看到這個數字的人一定看得到它是下限。
    const fireInsurance: Field<Yen> = fire.kind === 'amount'
      ? known(yen(fire.jpy), 'measured', `火災保険 ${fireRaw}`)
      : notListed(fireRaw);

    const penaltyRaw = vhCell(html, '短期解約違約金') ?? '';
    const penaltyRules = parseEarlyTermination(penaltyRaw);
    const guarantorRaw = vhCell(html, '敷金/保証人') ?? '';
    const corporateRaw = vhCell(html, '法人契約') ?? '';
    const signals = parseForeignerSignals(guarantorRaw);
    const furnishedSaid = statesFurnished(html);

    const buildingNotes: string[] = [];
    if (fireRaw !== '') buildingNotes.push(`火災保険：${fireRaw}（「～」為下限，實際依保險方案而定）`);
    if (penaltyRaw !== '') buildingNotes.push(`短期解約違約金：${penaltyRaw}`);
    if (guarantorRaw !== '') buildingNotes.push(`敷金/保証人：${guarantorRaw}`);
    if (corporateRaw !== '') buildingNotes.push(`法人契約：${corporateRaw}`);
    buildingNotes.push('管理費／共益費：原站靜態頁未刊登（僅「初期費用算出シミュレーション」的 JS 可算），本站不填 0');

    const foreigner: ForeignerPolicy = {
      welcomed: notOffered<boolean>(),
      residenceCardRequired: notOffered<boolean>(),
      japaneseRequired: notOffered<boolean>(),
      // 「契約条件や審査の結果、敷金や連帯保証人を必要とする場合があります」是
      // 附條件的可能性，不是「需要」也不是「不需要」——兩邊都不可斷言。
      guarantorCompanyRequired: signals.guarantorCompany === null
        ? notListed(guarantorRaw)
        : known(signals.guarantorCompany, 'measured', guarantorRaw),
      guarantorPersonRequired: signals.guarantorPerson === null
        ? notListed(guarantorRaw)
        : known(signals.guarantorPerson, 'measured', guarantorRaw),
      rawText: guarantorRaw,
    };

    const units: Unit[] = parseVhRooms(html).map((r) => {
      const rent = parseMoney(r.rentRaw);
      const deposit = parseMoney(r.depositRaw);
      const keyMoney = parseMoney(r.keyMoneyRaw);
      const area = parseArea(r.areaRaw);
      const cleaning = parseMoney(r.cleaningOnExitRaw);
      const floorN = Number(r.floorRaw);

      // 違約金是「賃料N ヶ月分」——月數不是金額。只有在賃料已知時才換算，
      // 並取最高的一檔（1年未満的3ヵ月分）作為最大曝險，原文完整留在 srcText 與 notes。
      const worst = penaltyRules.reduce<number>((n, p) => Math.max(n, p.penaltyMonths), 0);
      const earlyTerminationPenalty: Field<Yen> = worst > 0 && rent.kind === 'amount'
        ? known(
          yen(monthsToYen(worst, rent.jpy)),
          'measured',
          `短期解約違約金 ${penaltyRaw}（採最高檔 ${worst}ヶ月 × 賃料 ${r.rentRaw}）`,
        )
        : notListed(penaltyRaw);

      return {
        id: `${buildingId}#${r.roomNo}`,
        buildingId,
        unitKey: r.roomNo,
        sourceUrl: ref.url,
        roomNo: known(r.roomNo, 'measured', `部屋 ${r.roomNo}`),
        layout: r.layout === '' ? notListed('') : known(r.layout, 'measured', `間取り ${r.layout}`),
        areaM2: area.kind === 'exact'
          ? known(area.m2, 'measured', `専有面積 ${r.areaRaw}`)
          : notListed(r.areaRaw),
        floor: Number.isFinite(floorN) && floorN > 0
          ? known(floorN, 'measured', `${r.roomNo}（${r.floorRaw}階部分）`)
          : notListed(r.floorRaw),
        monthly: {
          rent: rent.kind === 'amount'
            ? known(yen(rent.jpy), 'measured', `貸料: ${r.rentRaw}`)
            : notListed(r.rentRaw),
          // 見檔頭：模擬器的初始值 0 是欄位預設，不是這間房的管理費
          adminFee: notListed(''),
          utilities: notListed(''),
          internet: notOffered<Yen>(),
          otherMonthly: notOffered<Yen>(),
        },
        initial: {
          // ¥0 是原站在**這一間房**上明寫的金額，不是慣例也不是推論
          keyMoney: keyMoney.kind === 'zero'
            ? known(yen(0), 'measured', `礼金: ${r.keyMoneyRaw}`)
            : keyMoney.kind === 'amount'
              ? known(yen(keyMoney.jpy), 'measured', `礼金: ${r.keyMoneyRaw}`)
              : notListed(r.keyMoneyRaw),
          deposit: deposit.kind === 'zero'
            ? known(yen(0), 'measured', `敷金: ${r.depositRaw}`)
            : deposit.kind === 'amount'
              ? known(yen(deposit.jpy), 'measured', `敷金: ${r.depositRaw}`)
              : notListed(r.depositRaw),
          depositNonRefundable: notOffered<Yen>(),
          // 取引態様は貸主（VH 自己是出租人）→ 常識上不會有仲介手数料，
          // 但頁面從沒寫過「仲介手数料なし」。從取引態様推 0 是推論不是事實，不填。
          agencyFee: notListed('取引態様: 貸主'),
          guarantorInitialFee: notListed(guarantorRaw),
          fireInsurance,
          keyExchangeFee: notOffered<Yen>(),
          contractFee: notOffered<Yen>(),
          cleaningFeeUpfront: notOffered<Yen>(),
          otherInitial: notOffered<Yen>(),
        },
        deferred: {
          renewalFee: notOffered<Yen>(),
          renewalAdminFee: notOffered<Yen>(),
          cleaningFeeOnExit: cleaning.kind === 'amount'
            ? known(yen(cleaning.jpy), 'measured', `退去時クリーニング費用 ${r.cleaningOnExitRaw}`)
            : notListed(r.cleaningOnExitRaw),
          earlyTerminationPenalty,
        },
        utilitiesBasis: 'unknown',
        furnished: furnishedSaid === null
          ? notListed('')
          : known(furnishedSaid, 'measured', '※家具は含まれません'),
        availableFrom: r.availableFromRaw === ''
          ? notListed('')
          : known(r.availableFromRaw, 'measured', `data-move-in-available-date=${r.availableFromRaw.replace(/-/g, '')}`),
        isVacant: known(true, 'measured', `「間取別 部屋情報」列出 ${r.roomNo}`),
        contractType: 'unknown',
        contractMonths: notListed(''),
        // VH 沒有「最低居住期間」欄位，取而代之的是短期解約違約金——
        // 從違約金反推一個最低月數是推論不是事實，不填。
        minStayMonths: notListed(penaltyRaw),
        genderRestriction: 'unknown',
        ageLimitRaw: notOffered<string>(),
        // JSON-LD 有 `"petsAllowed": "false"`，但同一頁的初期費用試算表又提供
        // 「ペット希望」選項（會加收敷金）——兩者矛盾，任一邊都不足以斷言。
        petsAllowed: notListed(''),
        foreigner,
        notes: [...buildingNotes, ...r.benefits.map((b) => `特典：${b}`)],
      };
    });

    return { building, units };
  },
};

export default adapter;
