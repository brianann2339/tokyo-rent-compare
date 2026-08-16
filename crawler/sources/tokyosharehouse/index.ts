/**
 * 東京シェアハウス（Tokyo Sharehouse）adapter——聚合站，關東各運營者的 share house。
 *
 * 收錄它的理由：**逐物件刊登外國人受入條件**（パスポート／在留カード／日本語能力），
 * 這是其他來源幾乎都沒有的欄位；房間層也給到房號／樓層／面積／賃料／共益費／空室予定日。
 *
 * ⚠️ 兩個必須知道的坑（2026-08-16 實測）：
 *
 * 1. **不可用 sitemap 枚舉**。robots.txt 指向 `https://sharehouse.in/sitemap_index.xml`
 *    （另一個 host），其中 88k 筆 URL 有 95% 是 `/jpn/currency/change/N` 這種雜訊，
 *    且**完全不含** `/jpn/house/detail/`。只能爬列表頁。
 *
 * 2. **列表頁不可用整頁 grep**。整頁 `href="/jpn/house/detail/N/"` 會同時撈到
 *    右欄「その他人気のシェアハウス」推薦；area 6 與 area 186 兩張不同區域的列表頁
 *    整頁 grep 各得 30 筆且大量重疊，實際列表項只有各 10 筆、零重疊。
 *    所以只掃 `#listContentArea` 內 `div.listItem` 的 `data-item-id`。
 *
 * ⚠️ **鮮度風險高**：抽樣物件的「データ更新日」有 2019-01-22、2021-02-02 這種數年前的值。
 * 所以一定要把它解析進 building.sourceUpdatedAt，讓使用者自己看得到資料多舊。
 *
 * ⚠️ **金額用反斜線代替日圓符號**：建物層寫成 `\56,000 ~ \69,000`（JIS 的 `\` 即 ¥），
 * 房間層卻寫成全形 `￥69,000`，共益費又是 `&#165;14,000`。三種寫法都要還原。
 *
 * 刻意不解析的東西：物件說明欄的自由文字。有物件在說明裡寫
 * 「契約手数料（通常80000円）が50% OFF　40,000円に！※6ヶ月未満で退去…差額を頂戴します」——
 * 這種帶條件、帶活動期限的數字沒有結構化欄位可依附，抓成金額就是製造假精確度。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseMinStayMonths, parseGenderTags, parseForeignerSignals } from '../../../packages/jp-parse/src/contract.ts';

const SITE = 'https://tokyosharehouse.com';

export const manifest: SourceManifest = {
  id: 'tokyosharehouse',
  name: '東京シェアハウス',
  nameZh: 'Tokyo Sharehouse（東京シェアハウス）',
  homepage: 'https://tokyosharehouse.com/jpn/',
  origin: 'https://tokyosharehouse.com',
  transport: 'http',
  crawlDelayMs: 3000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'depositNonRefundable',
      'layout', 'areaM2', 'roomNo', 'floor', 'isVacant', 'availableFrom',
      'furnished', 'minStayMonths', 'genderRestriction', 'ageLimitRaw', 'petsAllowed',
      'residenceCardRequired', 'japaneseRequired',
      'stations', 'totalUnits', 'sourceUpdatedAt',
    ],
    // 全站沒有這些欄位的結構化位置——宣告出來，健康檢查才不會誤報。
    // 註：契約手数料／保険料等偶爾出現在物件說明的自由文字裡，但沒有欄位可依附，
    //     本 adapter 刻意不從自由文字抓金額（見檔頭），所以一律視為來源不提供。
    neverProvides: [
      'keyMoney', 'agencyFee', 'guarantorInitialFee', 'fireInsurance',
      'keyExchangeFee', 'contractFee', 'cleaningFeeUpfront', 'otherInitial',
      'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'utilities', 'internet', 'otherMonthly',
      'contractType', 'contractMonths', 'structure', 'yearBuilt', 'floorsAboveGround',
      'foreignerWelcomed', 'guarantorCompanyRequired', 'guarantorPersonRequired',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null, // 首次執行時寫入；2026-08-16 實測值 3c90b6ae4940738e…
    tosReviewed: 'yes',
    notes:
      '/robots.txt 回 HTTP 200，全文三行（2026-08-16 實測）：'
      + '「# updated 2026-02-12」「User-agent: *」「Sitemap: https://sharehouse.in/sitemap_index.xml」。'
      + '有 User-agent: * 群組但**零 Disallow**、無 Crawl-delay。自訂 3 秒間隔。'
      + '利用規約 https://tokyosharehouse.com/jpn/pages/terms/ 第5条（知的財産権）逐字：'
      + '「本サイトに掲載されるすべての情報に関する特許権、商標権、著作権、プログラムその他の'
      + '知的財産権は、当社及びその他の権利者に帰属します。無断での実施、使用、複製、転載、改変、'
      + 'その他の利用は著作権侵害となり…法的に罰せられるほか、損害賠償を請求されることがあります。」'
      + '同規約全文未見禁止爬取／自動収集的條款。本站每筆房源標示出處為東京シェアハウス並連回原站，'
      + '不轉載說明文與照片。⚠️ 上述條款對「引用範圍」沒有明文界線，需求方應自行評估。',
  },
};

/** `&#165;` `&nbsp;` 等實體還原。TSH 的共益費就是用 `&#165;` 寫的。 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&yen;/g, '¥')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * JIS X 0201 把日圓符號放在 ASCII 0x5C，所以 `\56,000` 就是 `¥56,000`。
 * 只在後面接數字時才換，避免動到真的反斜線。
 */
export function yenBackslash(s: string): string {
  return s.replace(/\\(?=\s*[0-9０-９])/g, '¥');
}

function plain(fragment: string): string {
  return yenBackslash(decodeEntities(fragment.replace(/<[^>]+>/g, ' '))).replace(/\s+/g, ' ').trim();
}

/**
 * 取右欄摘要表的一格。
 * 結構固定：`<td><div class="detail-value-area"><div class="label">エリア</div>
 *            <div class="labelDesc">…</div></div></td>`
 * labelDesc 內含巢狀 `<div>`（アクセス 每個車站一個 div），所以不能用非貪婪抓到 `</div>`，
 * 一律切到該格的 `</td>`。
 */
export function summaryCell(html: string, label: string): string | null {
  const m = new RegExp(`<div class="label[^"]*">\\s*${label}\\s*</div>`).exec(html);
  if (m === null) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</td>', start);
  return end < 0 ? null : html.slice(start, end);
}

/** 東京都 23 特別区。用於「省略都名的地址」判斷（部分物件只寫「杉並区下井草1丁目」）。 */
const TOKYO_WARDS_23 = [
  '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
  '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
  '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区',
] as const;

export type AddressResult =
  | { readonly kind: 'tokyo'; readonly addressRaw: string; readonly ward: string }
  | { readonly kind: 'other' }
  | { readonly kind: 'unparsed' };

/**
 * 「エリア」欄的地址。實測三種寫法：
 *   `東京都港区西新橋一丁目`（有都名）
 *   `杉並区下井草1丁目`（**省略都名**）
 *   `神奈川県 川崎市 中原区 新城1019`（他県，含空白分隔）
 *
 * 省略都名時只在「区名屬於 23 特別区」且「字串裡沒有其他県／府／道／市」時才判定為東京。
 * 「中央区」「北区」「港区」在大阪市等地也存在，但那些寫法一定帶著市名或県名；
 * TSH 的收錄範圍是關東，非東京的地址實測都帶「県」或「市」。仍判不出來就回 unparsed，不猜。
 */
export function parseTshAddress(raw: string): AddressResult {
  const t = raw.replace(/\s+/g, '').trim();
  if (t === '') return { kind: 'unparsed' };

  if (t.startsWith('東京都')) {
    const rest = t.slice('東京都'.length);
    const m = /^([^0-9０-９]{1,8}?[区市町村])/.exec(rest);
    return { kind: 'tokyo', addressRaw: t, ward: m?.[1] ?? '' };
  }
  if (/[都道府県]/.test(t)) return { kind: 'other' };

  const ward = TOKYO_WARDS_23.find((w) => t.startsWith(w));
  if (ward !== undefined && !t.includes('市')) {
    return { kind: 'tokyo', addressRaw: `東京都${t}`, ward };
  }
  return /[区市町村]/.test(t) ? { kind: 'other' } : { kind: 'unparsed' };
}

/**
 * アクセス欄。是運營者自己填的自由欄位，實測四種寫法都存在：
 *   `都営三田線 内幸町駅 徒歩3分`   標準
 *   `JR総武線 荻窪駅 16分`          **沒有「徒歩」二字**
 *   `JR山手線 大崎 徒歩10分`        **沒有「駅」字**
 *   `東京都営浅草線ほか 三田駅 徒歩8分` 路線帶「ほか」
 *
 * 所以不能用「駅」當錨點，改從尾端的「N分」往回切：
 * 時間前的最後一個空白段是站名，再前面全部是路線。
 *
 * 沒寫「徒歩」的那種可能是徒歩也可能是バス，walkMinutes 一律留未知、
 * 原文完整保留在 rawText，不替站方補上「徒歩」。
 */
const TSH_MINUTES_RE = /(徒歩|バス)?\s*(\d+(?:\.\d+)?)\s*分\s*$/;

export function parseTshStations(cellHtml: string): readonly Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const m of cellHtml.matchAll(/<div>([\s\S]*?)<\/div>/g)) {
    const line = plain(m[1] ?? '');
    if (line === '') continue;
    const g = TSH_MINUTES_RE.exec(line);
    if (g?.[2] === undefined) continue;
    const minutes = Number(g[2]);
    if (!Number.isFinite(minutes)) continue;

    const head = line.slice(0, g.index).trim().split(/\s+/);
    const station = (head.pop() ?? '').replace(/駅$/, '').trim();
    const lineName = head.join(' ').trim();
    const key = `${lineName}|${station}`;
    if (station === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({
      line: lineName,
      station,
      walkMinutes: g[1] === '徒歩'
        ? known(minutes, 'measured', line)
        : notListed(`${line}（原文未寫交通方式，不視為步行時間）`),
      rawText: line,
    });
  }
  return out;
}

/**
 * 「入居条件」區塊。每個 `td.condition-item` 有一個 `div.icon {name}-{0|1}` 與一段說明。
 * 實測 icon 名稱是固定的 8 個：manage / min_contract / japanese / clean / deposit /
 * foreigner / rule / event（第一格是性別，用的是 `gender-icon`，這裡抓不到，也不需要）。
 *
 * ⚠️ 尾碼的 0/1 是圖示的亮／暗狀態，**語意未經查證**——實測有物件 `foreigner-0`
 * 卻仍列出護照與簽證要求。所以只讀說明文字，不解讀 0/1。
 */
export function parseConditionBlocks(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const i = html.indexOf('<div class="condition">');
  if (i < 0) return out;
  const j = html.indexOf('入居者データ', i);
  const seg = html.slice(i, j < 0 ? html.length : j);
  for (const part of seg.split('<td class="condition-item">').slice(1)) {
    const icon = /<div class="icon ([a-z_]+)-[01]"/.exec(part)?.[1];
    if (icon === undefined) continue;
    const body = /<td class="explainBlock">([\s\S]*?)<\/table>/.exec(part)?.[1] ?? '';
    out.set(icon, plain(body));
  }
  return out;
}

export type TshRoomStatus = 'available' | 'coming_soon' | 'occupied' | 'unknown';

export type TshRoom = {
  readonly roomNoRaw: string;
  readonly roomNo: string;
  readonly status: TshRoomStatus;
  /** 空室予定日（ISO），status = coming_soon 時才有 */
  readonly emptyDate: string | null;
  readonly layout: string;
  readonly floorRaw: string;
  readonly male: boolean | null;
  readonly female: boolean | null;
  readonly rentRaw: string;
  readonly adminRaw: string;
  readonly areaRaw: string;
  readonly conditionRaw: string;
  readonly remarks: string;
  /** 房內設備圖示中「有」的那些（`bed-on` → `bed`） */
  readonly equipmentOn: readonly string[];
};

/**
 * 房間區塊。
 *
 * ⚠️ 詳情頁的「部屋情報」**只列空室與空室予定的房間**，不是全部房間——
 * 2026-08-16 拿 detail/350 與 room/350 逐間對過：room 頁 18 間（301–410），
 * 其中 408=空室、302=2026-09-02、307=2026-10-03，detail 頁就恰好是這 3 間，順序也一致。
 * detail/1889 同樣：room 頁 7 間、僅 302 空室，detail 頁就是 302。
 * 所以不需要為了拿房間再多打一次 room 頁。
 */
export function parseTshRooms(html: string): TshRoom[] {
  const start = html.indexOf('<div class="detail-room');
  if (start < 0) return [];
  const stop = html.indexOf('<a name="condition"', start);
  const seg = html.slice(start, stop < 0 ? html.length : stop);

  const out: TshRoom[] = [];
  for (const chunk of seg.split('<div class="room-item"').slice(1)) {
    const roomNoRaw = plain(/<div class="room-num">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '');
    if (roomNoRaw === '') continue;

    const status: TshRoomStatus = chunk.includes('btnAvailable')
      ? 'available'
      : chunk.includes('btnComingSoon')
        ? 'coming_soon'
        : chunk.includes('btnOccupied') ? 'occupied' : 'unknown';

    const dateRaw = plain(/<div class="empty-date">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '');
    const prices = new Map<string, string>();
    for (const p of chunk.matchAll(/<div class="label[^"]*">\s*([^<]*?)\s*<\/div>\s*<div class="value">([\s\S]*?)<\/div>/g)) {
      prices.set(plain(p[1] ?? ''), plain(p[2] ?? ''));
    }

    out.push({
      roomNoRaw,
      // 房號常把性別條件黏在後面（`302男性専用`）；性別另有圖示欄位，這裡去掉以免污染房號
      roomNo: roomNoRaw.replace(/\s*(男性専用|女性専用)\s*$/, '').trim(),
      status,
      emptyDate: /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null,
      layout: plain(/<div class="room-info"><span>([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? ''),
      floorRaw: plain(/<div class="room-floor">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? ''),
      male: boolIcon(chunk, 'male'),
      female: boolIcon(chunk, 'female'),
      rentRaw: prices.get('賃料') ?? '',
      adminRaw: prices.get('共益費') ?? '',
      areaRaw: plain(/<span class="width">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^広さ:\s*/, ''),
      conditionRaw: plain(/<span class="condition">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^入居条件:\s*/, ''),
      remarks: plain(/<span class="remarks">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '').replace(/^備考:\s*/, ''),
      equipmentOn: [...chunk.matchAll(/<div class="icon ([a-z_]+)-on"/g)].map((m) => m[1] ?? ''),
    });
  }
  return out;
}

function boolIcon(chunk: string, which: 'male' | 'female'): boolean | null {
  const m = new RegExp(`<div class="gender-icon ${which}-([01])"`).exec(chunk);
  return m?.[1] === undefined ? null : m[1] === '1';
}

/** 房間層的性別圖示是結構化的兩個布林，比建物層的「男性, 女性」標籤列精確。 */
export function genderOfRoom(r: TshRoom, fallback: GenderRestriction): GenderRestriction {
  if (r.male === null || r.female === null) return fallback;
  if (r.male && r.female) return 'mixed';
  if (r.male) return 'male_only';
  if (r.female) return 'female_only';
  return fallback;
}

/**
 * 「保証金」欄。實測五種寫法：
 *   `家賃1カ月分 （退去時¥25,000償却）`   償却額（＝敷引）直接給
 *   `家賃1カ月分 （退去時100％返却）`     全額退還 → 敷引 0
 *   `¥50,000 （退去時100％償却）`         全額不退 → 敷引＝保証金
 *   `¥80,000 （退去時¥47,000返却）`       給的是**退還額**，敷引要減出來
 *   `¥44,000`（無括號）                   敷引未知
 *
 * 月數要乘賃料才成金額，賃料未知時一律留未知（不換算）。
 * 括號裡的百分比與減法都是對「原站白紙黑字寫出來的兩個數字」做算術，不是憑空生值，
 * 所以算式一律寫進 srcText 供稽核。
 */
export function parseDeposit(
  raw: string,
  rent: Field<Yen>,
): { deposit: Field<Yen>; nonRefundable: Field<Yen> } {
  const t = yenBackslash(raw).trim();
  if (t === '') return { deposit: notListed(''), nonRefundable: notListed('') };

  const paren = /[（(]([^）)]*)[）)]/.exec(t)?.[1] ?? '';
  const head = t.replace(/[（(][^）)]*[）)]/g, '').trim();

  let deposit: Field<Yen> = notListed(t);
  const money = parseMoney(head);
  if (money.kind === 'amount') {
    deposit = known(yen(money.jpy), 'measured', `保証金 ${head}`);
  } else if (money.kind === 'zero') {
    deposit = known(yen(0), 'measured', `保証金 ${head}`);
  } else if (money.kind === 'months') {
    // 「家賃1カ月分」是倍數不是金額——只有賃料已知時才換算，且把算式寫進 srcText 供稽核
    deposit = rent.known
      ? known(yen(Math.round(money.months * rent.v.jpy)), 'measured',
        `保証金 ${head} × 賃料 ${rent.v.jpy}円`)
      : notListed(`${head}（賃料未知，不換算）`);
  } else if (money.kind === 'unparsed') {
    deposit = unparsed(`保証金 ${head}`);
  }

  let nonRefundable: Field<Yen> = notListed(paren === '' ? t : paren);
  if (paren !== '') {
    const pct = /(\d+(?:\.\d+)?)\s*[％%]\s*償却/.exec(paren);
    const written = parseMoney(paren.replace(/[償返]却/g, ''));
    if (/[％%]\s*返却|全額返却/.test(paren)) {
      nonRefundable = known(yen(0), 'measured', `保証金 ${paren}`);
    } else if (pct?.[1] !== undefined && deposit.known) {
      nonRefundable = known(
        yen(Math.round((Number(pct[1]) / 100) * deposit.v.jpy)), 'measured',
        `保証金 ${paren} × 保証金 ${deposit.v.jpy}円`,
      );
    } else if (/償却/.test(paren) && written.kind === 'amount') {
      nonRefundable = known(yen(written.jpy), 'measured', `保証金 ${paren}`);
    } else if (/返却/.test(paren) && written.kind === 'amount' && deposit.known
      && written.jpy <= deposit.v.jpy) {
      // 給的是退還額，敷引＝保証金 − 退還額。兩個數字都在原文裡，減法把算式留在出處
      nonRefundable = known(yen(deposit.v.jpy - written.jpy), 'measured',
        `保証金 ${deposit.v.jpy}円 − ${paren}`);
    }
  }
  return { deposit, nonRefundable };
}

function moneyField(raw: string, label: string): Field<Yen> {
  const t = yenBackslash(raw).trim();
  if (t === '') return notListed('');
  const r = parseMoney(t);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${label} ${t}`);
    case 'zero': return known(yen(0), 'measured', `${label} ${t}`);
    case 'absent': case 'negotiable': case 'months': return notListed(`${label} ${t}`);
    default: return unparsed(`${label} ${t}`);
  }
}

/** 「男性, 女性, 30代まで」的第三段才是年齡限制；只有男女標籤時代表沒寫。 */
export function parseAgeLimit(tenancy: string): Field<string> {
  const rest = tenancy
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '男性' && s !== '女性');
  return rest.length === 0
    ? notListed(tenancy)
    : known(rest.join(' / '), 'measured', `入居条件 ${tenancy}`);
}

function foreignerPolicy(text: string): ForeignerPolicy {
  if (text === '') {
    return {
      welcomed: notOffered<boolean>(),
      residenceCardRequired: notListed(''),
      japaneseRequired: notListed(''),
      guarantorCompanyRequired: notOffered<boolean>(),
      guarantorPersonRequired: notOffered<boolean>(),
      rawText: '',
    };
  }
  const s = parseForeignerSignals(text);
  return {
    // 站方列出「外国人」受入條件不等於明示「歓迎」，這一欄本站不臆測
    welcomed: notOffered<boolean>(),
    residenceCardRequired: s.residenceCard === true
      ? known(true, 'measured', `外国人 ${text}`)
      : notListed(text),
    japaneseRequired: s.japanese === true
      ? known(true, 'measured', `外国人 ${text}`)
      : notListed(text),
    guarantorCompanyRequired: notOffered<boolean>(),
    guarantorPersonRequired: notOffered<boolean>(),
    rawText: text,
  };
}

/** 列表頁 `#listContentArea` 內的物件 id。見檔頭坑 2：不可用整頁 grep。 */
export function parseListItemIds(html: string): string[] {
  const i = html.indexOf('id="listContentArea"');
  if (i < 0) return [];
  const j = html.indexOf('class="paging"', i);
  const seg = html.slice(i, j < 0 ? html.length : j);
  const out: string[] = [];
  for (const m of seg.matchAll(/<div class="listItem[^"]*"[^>]*data-item-id="(\d+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 分頁：第 1 頁的 `rel="last"` 給出最後一頁；最後一頁本身沒有這個連結。 */
export function parseLastPage(html: string): number {
  const m = /href="[^"]*\/page:(\d+)"\s+rel="last"/.exec(html);
  const n = m?.[1] === undefined ? 1 : Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 首頁地圖列出的地域 id。橫跨關東（含神奈川／埼玉／千葉），東京篩選在 extract 做。 */
export function parseAreaIds(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\/jpn\/area\/search\/(\d+)\/?/g)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return [...out];
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const home = await fetcher.get(`${SITE}/jpn/`);
    const areas = parseAreaIds(home.body);
    if (areas.length === 0) throw new Error('[tokyosharehouse] 首頁解析不到任何 area id，版面可能已改');

    // 同一物件會出現在多個地域的列表裡，全域去重
    const seen = new Set<string>();
    for (const area of areas) {
      const first = await fetcher.get(`${SITE}/jpn/area/search/${area}/page:1`);
      const last = parseLastPage(first.body);
      for (let page = 1; page <= last; page++) {
        const body = page === 1
          ? first.body
          : (await fetcher.get(`${SITE}/jpn/area/search/${area}/page:${page}`)).body;
        for (const id of parseListItemIds(body)) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield { url: `${SITE}/jpn/house/detail/${id}/` };
        }
      }
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const html = raw.body;

    // 右欄摘要表是這個來源的骨架，缺了就是版面改了——大聲失敗，不要默默產出空資料
    const areaCell = summaryCell(html, 'エリア');
    if (areaCell === null) {
      throw new Error(`[tokyosharehouse] ${ref.url} 找不到「エリア」摘要格，版面可能已改`);
    }

    const addr = parseTshAddress(plain(areaCell));
    if (addr.kind === 'other') return null;        // 非東京（神奈川／埼玉／千葉），不收錄
    if (addr.kind === 'unparsed') {
      throw new Error(`[tokyosharehouse] ${ref.url} 地址解析不出來：${plain(areaCell)}`);
    }

    const name = decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '')
      .replace(/：東京シェアハウス\s*$/, '').trim();
    if (name === '') throw new Error(`[tokyosharehouse] ${ref.url} 取不到物件名稱`);

    const id = /\/jpn\/house\/detail\/(\d+)/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `tokyosharehouse:${id}`;

    const conditions = parseConditionBlocks(html);
    const tenancy = plain(summaryCell(html, '入居条件') ?? '');
    const households = /(\d+)\s*世帯/.exec(plain(summaryCell(html, '世帯数') ?? ''));
    const updated = /データ更新日[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})/.exec(plain(html.replace(/<[^>]+>/g, ' ')));

    const buildingGender = parseGenderTags(tenancy);
    const ageLimit = parseAgeLimit(tenancy);
    const minStay = parseMinStayMonths(conditions.get('min_contract') ?? '');
    const ruleText = conditions.get('rule') ?? '';
    const foreigner = foreignerPolicy(conditions.get('foreigner') ?? '');
    const depositRaw = conditions.get('deposit') ?? '';

    const building: Building = {
      id: buildingId,
      sourceId: 'tokyosharehouse',
      sourceKey: id,
      sourceUrl: ref.url,
      name,
      kind: 'sharehouse',
      addressRaw: addr.addressRaw,
      prefecture: '東京都',
      ward: addr.ward,
      stations: parseTshStations(summaryCell(html, 'アクセス') ?? ''),
      structure: notOffered<string>(),
      yearBuilt: notOffered<number>(),
      floorsAboveGround: notOffered<number>(),
      totalUnits: households?.[1] !== undefined
        ? known(Number(households[1]), 'measured', `世帯数 ${households[0]}`)
        : notListed(''),
      imageUrls: (() => {
        const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
        return og === undefined ? [] : [og];
      })(),
      fetchedAt: raw.fetchedAt,
      // 這個來源的鮮度差異極大（實測 2019～2026），一定要讓使用者看得到
      sourceUpdatedAt: updated?.[1] !== undefined
        ? known(updated[1], 'measured', `データ更新日 ${updated[1]}`)
        : notListed(''),
      htmlSha256: raw.sha256,
    };

    const units: Unit[] = parseTshRooms(html)
      // 詳情頁只列空室與空室予定，但保險起見仍排除明確標示已滿的房間
      .filter((r) => r.status === 'available' || r.status === 'coming_soon')
      .map((r) => {
        const rent = moneyField(r.rentRaw, '賃料');
        const { deposit, nonRefundable } = parseDeposit(depositRaw, rent);
        const area = parseArea(r.areaRaw);
        const floor = /^(\d+)階$/.exec(r.floorRaw);
        const notes: string[] = [];
        if (r.remarks !== '') notes.push(`備考：${r.remarks}`);
        if (r.conditionRaw !== '') notes.push(`部屋入居条件：${r.conditionRaw}`);
        if (ruleText !== '') notes.push(`ハウスルール：${ruleText}`);

        return {
          id: `${buildingId}#${r.roomNo}`,
          buildingId,
          unitKey: r.roomNo,
          sourceUrl: ref.url,
          roomNo: known(r.roomNo, 'measured', `部屋番号 ${r.roomNoRaw}`),
          layout: r.layout === '' ? notListed('') : known(r.layout, 'measured', `部屋種別 ${r.layout}`),
          // 面積欄未填時站方寫「0 ㎡」而不是留空——0 是佔位符不是面積，必須擋掉
          areaM2: area.kind === 'exact' && area.m2 > 0
            ? known(area.m2, 'measured', `広さ ${r.areaRaw}`)
            : notListed(r.areaRaw),
          floor: floor?.[1] !== undefined
            ? known(Number(floor[1]), 'measured', `階 ${r.floorRaw}`)
            : notListed(r.floorRaw),
          monthly: {
            rent,
            adminFee: moneyField(r.adminRaw, '共益費'),
            // 共益費是否含水道光熱費，站方沒有結構化欄位說明，不臆測
            utilities: notOffered<Yen>(),
            internet: notOffered<Yen>(),
            otherMonthly: notOffered<Yen>(),
          },
          initial: {
            keyMoney: notOffered<Yen>(),
            deposit,
            depositNonRefundable: nonRefundable,
            agencyFee: notOffered<Yen>(),
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
          // 房內設備是逐項圖示的 on/off，有「ベッド」亮起就是站方明示房內附床
          furnished: r.equipmentOn.includes('bed')
            ? known(true, 'measured', `部屋設備 ${r.equipmentOn.join(', ')}`)
            : notListed(r.equipmentOn.join(', ')),
          availableFrom: r.status === 'available'
            ? known('随時', 'measured', '空室')
            : r.emptyDate !== null
              ? known(r.emptyDate, 'measured', `空室予定 ${r.emptyDate}`)
              : notListed(''),
          isVacant: known(r.status === 'available', 'measured',
            r.status === 'available' ? '空室' : '空室予定（現時点は入居中）'),
          contractType: 'unknown',
          contractMonths: notOffered<number>(),
          minStayMonths: minStay === null
            ? notListed(conditions.get('min_contract') ?? '')
            : known(minStay, 'measured', `契約 ${conditions.get('min_contract') ?? ''}`),
          genderRestriction: genderOfRoom(r, buildingGender),
          ageLimitRaw: ageLimit,
          petsAllowed: /ペット不可/.test(ruleText)
            ? known(false, 'measured', `ルール ${ruleText}`)
            : /ペット可|ペット相談/.test(ruleText)
              ? known(true, 'measured', `ルール ${ruleText}`)
              : notListed(ruleText),
          foreigner,
          notes,
        } satisfies Unit;
      });

    return { building, units };
  },
};

export default adapter;
