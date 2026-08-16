/**
 * BORDERLESS HOUSE adapter——自營國際交流 share house（日本／韓國／台灣，本站只收東京）。
 *
 * 收錄它的理由只有一個，但很值錢：**它是少數把水電網路費逐間標成固定金額的來源**。
 * 房間表有一欄 `Monthly Utilities and Internet ¥14,000`，
 * 意思明確——不含在賃料裡（utilitiesBasis = 'excluded'）但金額已知。
 * 其他 share house 站幾乎都只有一個語意含混的「共益費」，含不含水電得用猜的；
 * 沒有這種來源，share house 與一般物件的月額就沒有共同基準。
 *
 * ⚠️ 三個必須知道的限制（2026-08-16 實測）：
 *
 * 1. **全站不公開街道地址**。詳情頁只有最寄駅與一張自訂 Google 地圖，
 *    整頁沒有「東京都」「港区」這類字串（實測 grep 為 0）。
 *    所以 addressRaw 與 ward 一律留空，不從站名或車站反推行政區。
 *    是否為東京改用麵包屑的地域段判定：`/jp/tokyo/…`＝東京、`/jp/kansai/…`＝関西、
 *    仙台則是 `/jp/undefined/undefined`（站方自己的資料破口，標題文字仍寫 Sendai）。
 *
 * 2. **只有英文版**。語言切換是 JS（`onclick="LangJa(...)"`），
 *    `?lang=` 與 `Accept-Language` 都無效，所以欄位標籤全部是英文。
 *
 * 3. **房間表有桌機版與手機版兩套 HTML，只能用手機版**。
 *    桌機版 `table` 用 rowspan 合併共用房的儲存格——同一間 2 人房的第 2 床
 *    （roppongi 的 3A-2）整列少掉 Room Type／Size／Gender 三欄，按欄位位置解析會全部錯位。
 *    手機版是 `<th>標籤</th><td>值</td>` 的自描述結構，房型／面積／性別／國籍／可入住日
 *    每間都齊全，所以解析對象是手機版的 `div.housegrid`。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, includedInOther, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseMinStayMonths } from '../../../packages/jp-parse/src/contract.ts';

const SITE = 'https://www.borderless-house.com';

export const manifest: SourceManifest = {
  id: 'borderless',
  name: 'BORDERLESS HOUSE',
  nameZh: 'Borderless House（國際交流 share house）',
  homepage: 'https://www.borderless-house.com/jp/',
  origin: 'https://www.borderless-house.com',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'utilities', 'internet', 'keyMoney', 'cleaningFeeUpfront',
      'layout', 'areaM2', 'roomNo', 'isVacant', 'availableFrom', 'furnished',
      'minStayMonths', 'genderRestriction', 'foreignerWelcomed',
      'stations', 'totalUnits',
    ],
    // 全站不刊登這些欄位。
    // 註：日本的入居費用說明只列 key money 30,000 + Cleaning Fee 15,000 共 45,000 円，
    //     完全沒提敷金（韓國分店才有 deposit）。「沒提」不等於「是 0」，所以敷金列為
    //     來源不提供，不寫成 0——原文另存在 unit.notes 供使用者自行判讀。
    neverProvides: [
      'adminFee', 'otherMonthly',
      'deposit', 'depositNonRefundable', 'agencyFee', 'guarantorInitialFee',
      'fireInsurance', 'keyExchangeFee', 'contractFee', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'floor', 'contractType', 'contractMonths', 'ageLimitRaw', 'petsAllowed',
      'structure', 'yearBuilt', 'floorsAboveGround', 'sourceUpdatedAt',
      'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'pending',
    notes:
      '/robots.txt 實測 301 → /robots.txt/ → HTTP 404（站內 404 頁）→ 全站無 robots.txt，'
      + '無任何 Disallow、無 Crawl-delay。自訂 3 秒間隔。'
      + '/sitemap.xml 回 HTTP 200、409 筆 <loc>，房源樣式 /{country}/sharehouse/{slug}/，'
      + '其中 /jp/sharehouse/ 共 58 筆（含索引頁 1 筆，實際物件 57 筆，含関西與仙台）。'
      + '⚠️ /jp/tokyo/s-* 那 44 筆是車站導覽頁不是房源，不可當物件列舉。'
      + '站內只找到 /privacy/，**找不到利用規約／terms of use 頁面**，所以 tosReviewed 記為 pending：'
      + '找不到條款只能證明「站內無公開連結」，不能證明其不存在或無主張。'
      + '本站每筆房源標示出處為 BORDERLESS HOUSE 並連回原站，不轉載照片與住民介紹文。',
  },
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function plain(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sitemap 的 `/jp/sharehouse/{slug}/`。索引頁（slug 為空）要排除。 */
export function parseSitemapSlugs(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1];
    if (url === undefined) continue;
    const slug = /\/jp\/sharehouse\/([^/]+)\/?$/.exec(url)?.[1];
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * 麵包屑的地域段。第 3 個連結指向 `/jp/{region}/{area}`，region 是站方自己的分類。
 * 這是全站唯一由站方明示的地區資訊（沒有地址可用），所以東京篩選只能靠它。
 */
export function parseRegion(html: string): string | null {
  const bc = /class="header-bottom breadcrumbs"><div class="container">([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (bc === undefined) return null;
  const m = /href="https?:\/\/[^"]*\/jp\/([a-z]+)\/[^"]*"/.exec(bc);
  return m?.[1] ?? null;
}

/** 麵包屑最後一段是物件代號（`ROPPONGI1`），比 <title>／<h1> 穩定。 */
export function parseHouseCode(html: string): string | null {
  const bc = /class="header-bottom breadcrumbs"><div class="container">([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (bc === undefined) return null;
  const m = /<a>([^<]+)</.exec(bc);
  return m?.[1]?.trim() ?? null;
}

/**
 * 最寄駅。英文，而且**兩種語序都在用**（同一站不同物件寫法不同）：
 *   A `Roppongi Station, Tokyo-Metro Hibiya/ Toei Oedo Line 4 mins walk.`（站名在前）
 *   B `Toden Arakawa Line- 4minutes walk to Mukaihara Station`（路線在前）
 * 只支援這兩種，格式再變就跳過該行、不硬套——寧可少一個車站，不要標錯站名。
 */
const BH_STATION_A = /^(.+?)\s+Station,\s*(.+?)\s+(\d+)\s*min(?:ute)?s?\s*walk/i;
const BH_STATION_B = /^(.+?)\s*-\s*(\d+)\s*min(?:ute)?s?\s*walk\s+to\s+(.+?)(?:\s+Station)?\.?$/i;

export function parseBhStations(html: string): readonly Station[] {
  const block = /The closest station<\/p><ul>([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (block === undefined) return [];
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const li of block.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const line = plain(li[1] ?? '');
    if (line === '') continue;

    const a = BH_STATION_A.exec(line);
    const b = a === null ? BH_STATION_B.exec(line) : null;
    const station = (a?.[1] ?? b?.[3] ?? '').trim();
    const lineName = (a?.[2] ?? b?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const walk = Number(a?.[3] ?? b?.[2] ?? NaN);
    if (station === '' || seen.has(station) || !Number.isFinite(walk)) continue;
    seen.add(station);
    out.push({
      line: lineName,
      station,
      walkMinutes: known(walk, 'measured', line),
      rawText: line,
    });
  }
  return out;
}

export type BhRoom = {
  readonly bedNo: string;
  readonly status: string;          // Open / Will Open / Occupied
  readonly rentRaw: string;
  readonly utilitiesRaw: string;
  readonly roomType: string;        // Room for 1 / Room for 2 …
  readonly sizeRaw: string;
  readonly genderRaw: string;       // Male / Female / Any
  readonly nationalityRaw: string;  // Foreign nationality / Japanese nationality / -
  readonly availableFromRaw: string;// Right Now / 2026.09.24 / -
};

/**
 * 房間表（手機版 `div.housegrid`，見檔頭限制 3）。
 *
 * 頁面上有兩個手機版面板：「只顯示空房」與「顯示全部」，後者是前者的超集合。
 * 兩個都掃再以床號去重，就不必依賴面板出現的順序——
 * 全滿的物件只會有一個面板（實測 ikebukuro／tsuruhashi1），依順序取會取錯。
 */
export function parseBhRooms(html: string): BhRoom[] {
  const out: BhRoom[] = [];
  const seen = new Set<string>();
  for (const block of html.split('<div class="housegrid ').slice(1)) {
    const bedNo = plain(/<p class="dispId">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '');
    if (bedNo === '' || seen.has(bedNo)) continue;
    seen.add(bedNo);

    const fields = new Map<string, string>();
    for (const tr of block.matchAll(/<tr[^>]*><th>([\s\S]*?)<\/th><td[^>]*>([\s\S]*?)<\/td><\/tr>/g)) {
      fields.set(plain(tr[1] ?? ''), plain(tr[2] ?? ''));
    }

    out.push({
      bedNo,
      status: plain(/<p class="roomstatus">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''),
      rentRaw: plain(/<p class="red">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''),
      utilitiesRaw: plain(/<span class="utilities">[\s\S]*?<\/span>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''),
      roomType: fields.get('Room Type') ?? '',
      sizeRaw: fields.get('Size') ?? '',
      genderRaw: fields.get('Gender') ?? '',
      // 「Applicable Nationalities」格是 <p class="nationality">…</p><p class="dash">-</p>，
      // 整格取文字會黏成「Foreign nationality-」，所以只取 nationality 那一段
      nationalityRaw: plain(/<p class="nationality">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''),
      availableFromRaw: fields.get('Available from') ?? '',
    });
  }
  return out;
}

/** 房間表的 Gender 欄是招募對象，不是自由文字，所以 Male／Female 就代表限定。 */
export function genderOf(raw: string): GenderRestriction {
  const t = raw.trim().toLowerCase();
  if (t === 'male') return 'male_only';
  if (t === 'female') return 'female_only';
  if (t === 'any') return 'mixed';
  return 'unknown';
}

/** `2026.09.24` → `2026-09-24`；`Right Now` → `随時`；其餘（`-`）視為未寫。 */
export function parseAvailableFrom(raw: string): Field<string> {
  const t = raw.trim();
  const d = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(t);
  if (d?.[1] !== undefined && d[2] !== undefined && d[3] !== undefined) {
    const iso = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    return known(iso, 'measured', `Available from: ${t}`);
  }
  if (/^right\s*now$/i.test(t)) return known('随時', 'measured', `Available from: ${t}`);
  return notListed(t);
}

export type BhInitialFees = {
  readonly keyMoney: Field<Yen>;
  readonly cleaning: Field<Yen>;
  readonly raw: string;
};

/**
 * 日本分店的入居費用。FAQ 逐字：
 *   「Initial fee 45,000 yen (30,000 yen key money and 15,000 yen Cleaning Fee are included)…」
 *
 * ⚠️ 同一頁還有韓國（800,000won / 500,000won deposit）與台灣的段落，
 * 抓錯段落就會把韓元寫成日圓，所以一定要先鎖定 `BORDERLESS HOUSE JAPAN` 那一格。
 */
export function parseInitialFees(html: string): BhInitialFees {
  const seg = /BORDERLESS HOUSE JAPAN<\/div><div class="tx">([\s\S]{0,900}?)<\/div>/.exec(html)?.[1];
  if (seg === undefined) return { keyMoney: notListed(''), cleaning: notListed(''), raw: '' };
  const raw = plain(seg);

  const num = (re: RegExp): Field<Yen> => {
    const m = re.exec(raw);
    if (m?.[1] === undefined) return notListed(raw.slice(0, 200));
    const r = parseMoney(`${m[1]}円`);
    if (r.kind === 'amount') return known(yen(r.jpy), 'measured', m[0]);
    if (r.kind === 'zero') return known(yen(0), 'measured', m[0]);
    return unparsed(m[0]);
  };

  return {
    keyMoney: num(/([\d,]+)\s*yen\s+key\s*money/i),
    cleaning: num(/([\d,]+)\s*yen\s+Cleaning\s*Fee/i),
    raw: raw.slice(0, 300),
  };
}

/** 「In Each Room」的設備清單。有列出就是站方明示房內附設備。 */
function furnishedOf(html: string): Field<boolean> {
  const seg = /<p>In Each Room<\/p><ul>([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (seg === undefined) return notListed('');
  const items = [...seg.matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) => plain(m[1] ?? ''))
    // 這個清單裡夾了一則長文案內（寝具レンタルの説明），那不是設備名稱，出處字串裡不要它
    .filter((s) => s !== '' && s.length <= 60);
  if (items.length === 0) return notListed('');
  return known(true, 'measured', `In Each Room: ${items.join(' / ')}`.slice(0, 200));
}

/**
 * 房間層的「Applicable Nationalities」。
 * `Foreign nationality` ＝這間床只收外國籍 → 對外國人而言明確可租；
 * `Japanese nationality` ＝只收日本籍 → 對外國人而言明確不可租（實測仙台物件有此值）。
 * BORDERLESS HOUSE 的模式就是日／外各半，所以這一欄是逐間的硬條件，不是宣傳詞。
 */
function foreignerOf(nationalityRaw: string, minStayRaw: string): ForeignerPolicy {
  const t = nationalityRaw.trim().toLowerCase();
  const welcomed: Field<boolean> = t.startsWith('foreign')
    ? known(true, 'measured', `Applicable Nationalities: ${nationalityRaw}`)
    : t.startsWith('japanese')
      ? known(false, 'measured', `Applicable Nationalities: ${nationalityRaw}`)
      : notListed(nationalityRaw);
  return {
    welcomed,
    residenceCardRequired: notOffered<boolean>(),
    japaneseRequired: notOffered<boolean>(),
    guarantorCompanyRequired: notOffered<boolean>(),
    guarantorPersonRequired: notOffered<boolean>(),
    rawText: [nationalityRaw, minStayRaw].filter((s) => s !== '').join(' ｜ ').slice(0, 200),
  };
}

function moneyField(raw: string, label: string): Field<Yen> {
  const t = raw.trim();
  if (t === '' || t === '-') return notListed(t);
  const r = parseMoney(t);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${label}: ${t}`);
    case 'zero': return known(yen(0), 'measured', `${label}: ${t}`);
    case 'absent': case 'negotiable': case 'months': return notListed(`${label}: ${t}`);
    default: return unparsed(`${label}: ${t}`);
  }
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const sitemap = await fetcher.get(`${SITE}/sitemap.xml`);
    const slugs = parseSitemapSlugs(sitemap.body);
    if (slugs.length === 0) throw new Error('[borderless] sitemap 解析不到任何 /jp/sharehouse/ slug');
    // 東京篩選在 extract 做（sitemap 沒有地區資訊，只有詳情頁的麵包屑有）
    for (const slug of slugs) yield { url: `${SITE}/jp/sharehouse/${slug}/` };
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const html = raw.body;

    const region = parseRegion(html);
    if (region === null) {
      throw new Error(`[borderless] ${ref.url} 找不到麵包屑地域段，版面可能已改`);
    }
    if (region !== 'tokyo') return null;   // 関西・仙台・その他，不收錄

    const code = parseHouseCode(html);
    if (code === null || code === '') {
      throw new Error(`[borderless] ${ref.url} 取不到物件代號`);
    }

    const rooms = parseBhRooms(html);
    if (rooms.length === 0) {
      // 每個物件都必然有 VACANCY INFORMATION 表；一間都解不出來就是解析器壞了
      throw new Error(`[borderless] ${ref.url} 房間表解析出 0 間，版面可能已改`);
    }

    const slug = /\/jp\/sharehouse\/([^/]+)/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `borderless:${slug}`;
    const fees = parseInitialFees(html);
    const furnished = furnishedOf(html);
    const bedding = /rent a[^.]{0,60}bedding set[^.]{0,80}?fee[^.]{0,20}?([\d,]+)\s*yen/i.exec(plain(html));
    const minStayRaw = /Minimum of[^.]{0,40}\./i.exec(plain(html))?.[0] ?? '';
    const minStay = parseMinStayMonths(minStayRaw);

    const building: Building = {
      id: buildingId,
      sourceId: 'borderless',
      sourceKey: slug,
      sourceUrl: ref.url,
      name: `BORDERLESS HOUSE ${code}`,
      kind: 'sharehouse',
      // 全站不公開街道地址（見檔頭限制 1）——留空，不從站名或車站反推
      addressRaw: '',
      prefecture: '東京都',
      ward: '',
      stations: parseBhStations(html),
      structure: notOffered<string>(),
      yearBuilt: notOffered<number>(),
      floorsAboveGround: notOffered<number>(),
      // 站方的房間表逐床列出，列數就是床位數；這是數表格列不是估算
      totalUnits: known(rooms.length, 'measured', `VACANCY INFORMATION 表列 ${rooms.length} 床`),
      imageUrls: (() => {
        const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
        return og === undefined ? [] : [og];
      })(),
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    const notesBase: string[] = [];
    if (fees.raw !== '') notesBase.push(`入居費用（日本）原文：${fees.raw}`);
    if (bedding?.[1] !== undefined) {
      notesBase.push(`寝具セットは任意レンタル（一時金 ${bedding[1]} yen）——必須ではないため初期費用に計上しない`);
    }
    notesBase.push('敷金：日本の入居費用説明に記載なし（韓国店のみ deposit あり）。記載がないことは 0 円の根拠にならないため未記載として扱う');

    const units: Unit[] = rooms
      // Occupied は募集していない。Open（即入居可）と Will Open（空室予定）のみ収録
      .filter((r) => /^(open|will open)$/i.test(r.status))
      .map((r) => {
        const area = parseArea(r.sizeRaw);
        const utilities = moneyField(r.utilitiesRaw, 'Monthly Utilities and Internet');
        // 「Room for 2/4」是同一間房多張床，Size 是**整間**的面積不是一人份
        const shared = /Room for (\d+)/i.exec(r.roomType);
        const notes = shared?.[1] !== undefined && shared[1] !== '1'
          ? [...notesBase, `${r.roomType}：Size ${r.sizeRaw} は部屋全体の広さで、${shared[1]} 人で共有する`]
          : notesBase;
        return {
          id: `${buildingId}#${r.bedNo}`,
          buildingId,
          unitKey: r.bedNo,
          sourceUrl: ref.url,
          roomNo: known(r.bedNo, 'measured', `Bed No. ${r.bedNo}`),
          layout: r.roomType === '' ? notListed('') : known(r.roomType, 'measured', `Type(people): ${r.roomType}`),
          areaM2: area.kind === 'exact' && area.m2 > 0
            ? known(area.m2, 'measured', `Size: ${r.sizeRaw}`)
            : notListed(r.sizeRaw),
          floor: notOffered<number>(),
          monthly: {
            rent: moneyField(r.rentRaw, 'Rent'),
            adminFee: notOffered<Yen>(),
            utilities,
            // 同一筆金額同時涵蓋水電與網路，網路費不另計——這個 0 有原文依據
            internet: utilities.known
              ? includedInOther(`Monthly Utilities and Internet: ${r.utilitiesRaw}`)
              : notListed(r.utilitiesRaw),
            otherMonthly: notOffered<Yen>(),
          },
          initial: {
            keyMoney: fees.keyMoney,
            deposit: notOffered<Yen>(),
            depositNonRefundable: notOffered<Yen>(),
            agencyFee: notOffered<Yen>(),
            guarantorInitialFee: notOffered<Yen>(),
            fireInsurance: notOffered<Yen>(),
            keyExchangeFee: notOffered<Yen>(),
            contractFee: notOffered<Yen>(),
            cleaningFeeUpfront: fees.cleaning,
            otherInitial: notOffered<Yen>(),
          },
          deferred: {
            renewalFee: notOffered<Yen>(),
            renewalAdminFee: notOffered<Yen>(),
            cleaningFeeOnExit: notOffered<Yen>(),
            earlyTerminationPenalty: notOffered<Yen>(),
          },
          // 賃料とは別建てで毎月定額の水道光熱＋ネット費を払う → excluded かつ金額既知
          utilitiesBasis: 'excluded',
          furnished,
          availableFrom: parseAvailableFrom(r.availableFromRaw),
          isVacant: known(/^open$/i.test(r.status), 'measured', `Status: ${r.status}`),
          contractType: 'unknown',
          contractMonths: notOffered<number>(),
          minStayMonths: minStay === null
            ? notListed(minStayRaw)
            : known(minStay, 'measured', minStayRaw),
          genderRestriction: genderOf(r.genderRaw),
          ageLimitRaw: notOffered<string>(),
          petsAllowed: notOffered<boolean>(),
          foreigner: foreignerOf(r.nationalityRaw, minStayRaw),
          notes,
        } satisfies Unit;
      });

    return { building, units };
  },
};

export default adapter;
