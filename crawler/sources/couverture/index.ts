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
 *
 * ── 2026-10-17 整站改版後的頁面結構（解析器依此重寫）─────────────────
 *   名稱      `<h1 class="room_name_ja">`（`<title>` 不再以「シェアハウス」開頭——舊解析器靠它，
 *             改版後 28 頁全被判成「不在收錄範圍」，22 棟的真相層差點被 0 棟覆寫）
 *   基本情報  `<div class="room_meta_item"><h4>住所</h4><p>…</p>`（住所／最寄り駅／部屋数／初期費用）
 *   房間      `<section id="room">` 裡一張張 `room_card`：房號、空室狀態、性別標籤、面積・帖、賃料、共益費、備考
 * ⚠️ 頁尾有「其他物件」卡片，上面也印著 Female／Male、水回り付き個室、女性専用……
 *    舊版對**整頁文字**判性別，於是幾乎每棟都被標成女性專用（實測中野富士見町的男性房也是）。
 *    現在一律只讀上面兩個區塊。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, statedNoAmount, includedInOther, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, GenderRestriction,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';

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
      'rent', 'adminFee', 'contractFee', 'fireInsurance', 'areaM2', 'roomNo',
      'isVacant', 'furnished', 'genderRestriction', 'stations', 'totalUnits',
      // 只有少數物件在介紹文寫「20XX年に…建てられた」「N階建てのビル」（見 parseCvProse）
      'yearBuilt', 'floorsAboveGround', 'availableFrom',
      // 初期費用欄「※事務手数料や個室清掃費などを含む契約時のみお支払い頂く料金です」→ 含在契約手数料（cvCleaningIncluded）
      'cleaningFeeUpfront',
    ],
    // 全站不刊登這些欄位——宣告出來，健康檢查才不會誤報
    neverProvides: [
      'keyMoney', 'deposit', 'depositNonRefundable', 'agencyFee',
      'guarantorInitialFee', 'keyExchangeFee',
      'otherInitial', 'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit',
      'earlyTerminationPenalty', 'utilities', 'internet', 'otherMonthly',
      'minStayMonths', 'contractMonths', 'contractType',
      'ageLimitRaw', 'petsAllowed', 'floor',
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorCompanyRequired', 'guarantorPersonRequired',
      'structure', 'sourceUpdatedAt',
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

/**
 * 数値実体（`&#8545;` ＝ローマ数字 Ⅱ）まで戻す。
 * `<title>` に生の実体が残る物件が実在する（クーベルチュール錦糸町Ⅱ／北大塚Ⅱ）。
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 儲存格 HTML → 文字：`<br>` 變換行，其餘標籤拿掉，實體還原，行內空白壓成一格。 */
function cellText(html: string): string {
  return decodeEntities(html.replace(/&yen;/g, '¥').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

/** 物件名。`<h1 class="room_name_ja">`；`&#8545;`（Ⅱ）之類的實體要還原（錦糸町Ⅱ／北大塚Ⅱ）。 */
export function parseCvName(html: string): string {
  return decodeEntities(/<h1 class="room_name_ja">([^<]*)<\/h1>/.exec(html)?.[1] ?? '').trim();
}

/**
 * 「基本情報」欄的 標籤 → 值（多行值以 `\n` 分隔）。
 * 只讀 `room_meta_item`：頁尾「其他物件」卡片也印著性別、標籤與金額，掃整頁會撿到別棟的字。
 */
export function parseCvMeta(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<div class="room_meta_item">\s*<h4>([^<]+)<\/h4>\s*<p>([\s\S]*?)<\/p>/g)) {
    const label = decodeEntities(m[1] ?? '').trim();
    if (label !== '' && !out.has(label)) out.set(label, cellText(m[2] ?? ''));
  }
  return out;
}

/**
 * 最寄り駅欄，一行一站。實測寫法：
 *   `[1]東京メトロ丸の内方南線　「中野-富士見町」　徒歩6分`（多站時有 [n]）
 *   `東西線「西葛西」徒歩5分`（只有一站時沒有 [n]——舊解析器要求 [n]，這 5 棟的車站全掉了）
 *   `JR中央・総武線「小岩」駅徒歩7分`（「駅」在括號**外**）
 *   `ＪＲ「王子」「上中里」　徒歩16分`（一行兩站共用一個分鐘數）
 *   `バス（渋72系統）「不動尊門前」　徒歩1分`（公車站）
 *   `[1]都営地下鉄 三田線「巣鴨駅」Ａ3出口　徒歩3分`（出口註記在站名**後面**；2026-10-17 驗證幫手抓到舊正則整行漏掉）
 *   `[2]JR埼京線「赤羽駅」バス10分`（從車站轉公車——不是徒歩距離，不收）
 *   `[3]JR山手線「鶯谷」徒歩10分、「上野」徒歩15分`（一行兩組、各自的分鐘數；2026-10-17 全量重驗抓到上野漏掉）
 * 處置：
 *   - 公車站**不收**：它不是鐵道車站，收進來會讓「離車站徒歩 1 分」這種篩選把它排到最前面。
 *   - 一行兩站：兩站都收，但徒歩分記為「頁面沒寫」——原站沒說 16 分是到哪一站，替它分配就是虛構。
 *   - 站名照原站寫法（`中野-富士見町` 保留連字號）；路線名裡的出口註記（`（1番出口）`）也照留。
 */
const CV_STATION_GROUP_RE = /((?:[「｢][^」｣]{1,20}[」｣]\s*)+)駅?\s*(?:[^\s「｢」｣徒]{1,10}出口)?\s*徒歩\s*(\d+)\s*分/g;

export function parseCvStations(value: string): Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const raw of value.split('\n')) {
    const lineText = raw.trim();
    const body = lineText.replace(/^\[\d+\]\s*/, '');
    const q = body.search(/[「｢]/);
    if (q < 0) continue;
    const line = body.slice(0, q).trim();
    if (/^バス/.test(line)) continue;
    // 一行可能有好幾組「站名＋徒歩N分」（`JR山手線「鶯谷」徒歩10分、「上野」徒歩15分`），每組各配自己的分鐘數；
    // 同一組裡有兩個站名共用一個分鐘數（`「王子」「上中里」　徒歩16分`）時，那個分鐘數不知道屬於哪一站。
    for (const g of body.slice(q).matchAll(CV_STATION_GROUP_RE)) {
      const names = [...(g[1] ?? '').matchAll(/[「｢]([^」｣]+)[」｣]/g)]
        .map((x) => (x[1] ?? '').trim().replace(/駅$/, ''))
        .filter((x) => x !== '');
      const walk = Number(g[2]);
      for (const station of names) {
        const key = `${line}|${station}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          line, station,
          walkMinutes: names.length === 1 && Number.isFinite(walk)
            ? known(walk, 'measured', lineText)
            : notListed<number>(lineText),
          rawText: lineText,
        });
      }
    }
  }
  return out;
}

/**
 * 住所欄的值。`東京都渋谷区元代々木町` 與 `豊島区北大塚3丁目`（都名省略）兩種都有。
 *
 * ⚠️ 都名を無条件に前置してはいけない。旧実装は「埼玉県川口市芝樋ノ爪」に「東京都」を足して
 * 「東京都埼玉県川口市芝樋ノ爪」という存在しない住所を作り、prefecture も '東京都' と決め打ちしていた。
 * 原站が言っていないことを我々が断言する＝捏造。収録範囲は東京都なので、
 * 他県が明記されている物件は**除外**する（籍を書き換えない）。
 * 都道府県が書かれていない頁は、区市名をそのまま行政区として使い、都名は補わない。
 * ⚠️ 区市が読めない住所も除外する。2026-10-17 実例：北大塚THREE は `東京都豊島北大塚3丁目`
 * （「区」の脱字）。駅も同じ棟の兄弟物件も豊島区を指しているが、それは推測であって原站の記載ではない。
 */
const CV_PREFECTURE_RE = /^(東京都|北海道|京都府|大阪府|[^\s]{2,3}県)/;

export function parseCvAddress(
  value: string,
): { addressRaw: string; prefecture: string; ward: string } | null {
  const addressRaw = value.replace(/\s+/g, ' ').trim();
  // 「区市」優先且非貪婪——`東京都渋谷区元代々木町` 的行政区是「渋谷区」，不是「渋谷区元代々木町」。
  const ward = /^(?:東京都)?([^\s]{1,6}?[区市])/.exec(addressRaw)?.[1];
  if (addressRaw === '' || ward === undefined) return null;
  const pref = CV_PREFECTURE_RE.exec(addressRaw)?.[1] ?? null;
  if (pref !== null && pref !== '東京都') return null;
  // 都名が書かれている頁だけ '東京都' と言う。区名から都を逆算するのは推測であって原站の記載ではない。
  return { addressRaw, prefecture: pref ?? '', ward };
}

/** 部屋数欄：`13部屋`／`40(44ベッド）`／`21`／`6部屋（女性専用ペアルーム1室）`。欄名就是「部屋数」，開頭的整數即房間數。 */
export function parseCvTotalUnits(value: string | undefined): Field<number> {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(\d+)/.exec(v);
  return m?.[1] !== undefined ? known(Number(m[1]), 'measured', `部屋数 ${v}`) : notListed(v);
}

export type CvRoom = {
  number: string;
  status: string;
  vacant: boolean;
  areaRaw: string;
  areaM2: Field<number>;
  rent: Field<Yen>;
  adminFee: Field<Yen>;
  note: string;
  genders: string[];
  /** ツイン／トリプルルーム的一張床：賃料是一床的價錢，面積是整間共用的面積。 */
  sharedBed: boolean;
  wetArea: boolean;
};

/**
 * `<section id="room">` 裡的房間卡片。
 * `meta` 三行依內容判別（不依順序）：含「㎡」的是面積（`8.5㎡ ／ 5.1帖`，帖可能缺）、`賃料　¥54,000`、`共益費　¥17,000`。
 * 面積的 srcText 保留帖數，建置期的「㎡ 與帖數對不上」不變式才查得到原站筆誤
 * （實測中野富士見町 210 號寫成 `60000㎡ ／ 7.2帖`）。
 */
export function parseCvRooms(html: string): CvRoom[] {
  const start = html.indexOf('<section id="room">');
  if (start < 0) return [];
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end < 0 ? undefined : end);
  const out: CvRoom[] = [];
  for (const card of section.split(/<div class="room_card\b/).slice(1)) {
    const number = decodeEntities(/<div class="name">([^<]*)<\/div>/.exec(card)?.[1] ?? '').trim();
    if (number === '') continue;
    const status = cellText(/<div class="status[^"]*">([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '');
    const genders = [...card.matchAll(/<span class="sex_tag [^"]*">([^<]*)<\/span>/g)].map((m) => (m[1] ?? '').trim());
    const metaHtml = /<div class="meta">([\s\S]*?)<\/div>\s*<div class="note">/.exec(card)?.[1] ?? '';
    const metas = [...metaHtml.matchAll(/<div>([\s\S]*?)<\/div>/g)].map((m) => cellText(m[1] ?? ''));
    const note = cellText(/<div class="note">([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '').replace(/\n/g, ' ');

    const areaRaw = metas.find((x) => /㎡|m2/.test(x)) ?? '';
    const rentRaw = (metas.find((x) => /^賃料/.test(x)) ?? '').replace(/^賃料\s*/, '');
    const adminRaw = (metas.find((x) => /^共益費/.test(x)) ?? '').replace(/^共益費\s*/, '');
    const area = parseArea(areaRaw);
    const rent = parseMoney(rentRaw);
    const admin = parseMoney(adminRaw);

    out.push({
      number,
      status,
      // 「空室」「10/29～空室」＝可申請（收進來；後者 isVacant=false）；「満室」「10/31満室」與認不得的狀態都不算——沒寫空室就不替它宣稱
      vacant: /空室/.test(status) && !/満室/.test(status),
      areaRaw,
      areaM2: area.kind === 'exact' ? known(area.m2, 'measured', `面積 ${areaRaw}`) : notListed(areaRaw),
      rent: rent.kind === 'amount' ? known(yen(rent.jpy), 'measured', `賃料 ${rentRaw}`) : notListed(rentRaw),
      adminFee: admin.kind === 'amount' ? known(yen(admin.jpy), 'measured', `共益費 ${adminRaw}`) : notListed(adminRaw),
      note,
      genders,
      sharedBed: /ツインルーム|トリプルルーム/.test(note),
      // 「水回り付き個室」的判定依據：備考寫了居室內的淋浴／浴室／廁所
      wetArea: /水回り付|シャワー|浴室|トイレ/.test(note),
    });
  }
  return out;
}

/**
 * 房間卡片的空室狀況 → 入居時期（model.ts：ISO8601 或「随時」）。
 *   `空室` → 随時；`10/29～空室` → `--10-29`（ISO 8601 的「月日、無年」寫法——原站沒寫年，不替它補）。
 * 2026-10-17 全量重驗前一律記「來源不提供」，但 60 間裡 61 張卡片都寫了。
 */
export function cvAvailableFrom(status: string): Field<string> {
  if (status === '空室') return known('随時', 'measured', '空室状況 空室');
  const m = /^(\d{1,2})\/(\d{1,2})\s*～\s*空室$/.exec(status);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return known(`--${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, 'measured', `空室状況 ${status}`);
  }
  return notListed<string>(status);
}

/** 房間卡片的性別標籤：兩個都有＝男女皆可；只有一個＝限該性別；沒有＝頁面沒寫。 */
export function cvGender(tags: readonly string[]): GenderRestriction {
  const f = tags.includes('Female');
  const m = tags.includes('Male');
  if (f && m) return 'mixed';
  if (f) return 'female_only';
  if (m) return 'male_only';
  return 'unknown';
}

/**
 * 火災保險：少數房間在備考寫了（`※火災保険 必須 ￥12,400/ 2年`、`※保険加入必須`）。
 * 有金額就記金額；只說必須沒給金額＝「原站明講有這筆、沒寫多少」，絕不補一個猜的數字；
 * 沒提到的房維持「來源不提供」。
 */
export function cvFireInsurance(note: string): Field<Yen> {
  const m = /火災保険[^0-9￥¥]*[￥¥]\s*([0-9,]+)/.exec(note);
  if (m?.[1] !== undefined) {
    const r = parseMoney(`${m[1]}円`);
    if (r.kind === 'amount') return known(yen(r.jpy), 'measured', `備考 ${note}`);
  }
  if (/保険.{0,4}必須/.test(note)) return statedNoAmount<Yen>(`備考 ${note}`);
  return notOffered<Yen>();
}

/**
 * 契約手数料。原站有**兩種**寫法：
 *   分価  `【契約手数料】 個室：40,000円 水回り付き個室：50,000円`
 *         ⚠️ 門前仲町寫成 `水回り付個室`（沒有「き」）——舊正則只認「付き」，於是把
 *         `水回り付個室：50,000円` 裡的「個室：50,000円」當成一般個室的價錢。
 *   一本値 `【契約手数料】 40,000円`
 * 一本値の頁は部屋の別なく同額——原站がそう書いているので、水回り付きにも同じ値を返す。
 * 分価の型に当てはまらないからといって金額を捨てると、頁に印字されている料金を
 * 「頁に記載なし」と偽ることになる。
 */
export function parseContractFees(value: string): {
  plain: number | null; wet: number | null; split: boolean; raw: string;
} {
  const seg = value.replace(/\s+/g, ' ').trim();
  const WET = /水回り付き?個室[：:]\s*([0-9,]+)\s*円/;
  const wetM = WET.exec(seg);
  // 先把水回り付き的整段拿掉，再找一般個室——兩者前方一致，順序反過來就會撿錯
  const rest = seg.replace(new RegExp(WET.source, 'g'), '');
  const plainM = /個室(?:・[^：:\s]{1,6})?[：:]\s*([0-9,]+)\s*円/.exec(rest);
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const r = parseMoney(`${s}円`);
    return r.kind === 'amount' ? r.jpy : null;
  };
  const split = plainM !== null || wetM !== null;
  const flat = split ? null : num(/【契約手数料】\s*([0-9,]+)\s*円/.exec(rest)?.[1]);
  return {
    plain: split ? num(plainM?.[1]) : flat,
    wet: split ? num(wetM?.[1]) : flat,
    split,
    raw: `初期費用 ${seg}`.slice(0, 200),
  };
}

/**
 * 初期費用欄的註腳「※事務手数料や個室清掃費などを含む契約時のみお支払い頂く料金です。」（2026-10-17 有初期費用欄的 28 頁全都有）：
 * 個室清掃費含在契約手数料裡、只在契約時付一次。存「此來源不公開」會讓人以為另有一筆清掃費沒算進來。
 */
export function cvCleaningIncluded(feeText: string): Field<Yen> {
  const m = /※?\s*[^※。]*?個室清掃費[^。]*?含む[^。]*。?/.exec(feeText.replace(/\s+/g, ' '));
  return m === null ? notOffered<Yen>() : includedInOther(`初期費用「${m[0].trim()}」`);
}

const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notOffered<boolean>(),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

/**
 * 介紹文（`<div class="room_description">`）裡明寫的築年與樓層數。
 *
 * 全站沒有築年／構造欄位，但有物件在介紹文寫
 *   `2017年にシェアハウスのために建てられた建物で、`
 *   `2023年7月シェアハウスのために新築で建てられた4階建てのビル`
 * 2026-10-17 驗證幫手指出：這兩棟存成「來源不提供」與頁面矛盾。
 * ⚠️ 只讀 room_description：頁面上半部的全站物件列表有別棟的
 * `2026年9月フルリノベーションでオープン`——那是**改裝開幕**、而且是**別棟**，兩個理由都不可以當築年。
 * 同一句含リノベ／改装／改築／リフォーム一律不收（改裝年不是建築年）。
 */
export function parseCvProse(html: string): { yearBuilt: Field<number>; floorsAboveGround: Field<number> } {
  const block = /<div class="room_description">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const sentences = block.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
    .split(/[\n。]/).map((x) => x.trim()).filter((x) => x !== '' && !/リノベ|改装|改築|リフォーム/.test(x));
  let yearBuilt: Field<number> = notOffered<number>();
  let floorsAboveGround: Field<number> = notListed('');
  for (const x of sentences) {
    const y = /((?:19|20)\d{2})年(?:\d{1,2}月)?に?[^、]{0,20}?建てられた/.exec(x);
    if (y?.[1] !== undefined && !yearBuilt.known) yearBuilt = known(Number(y[1]), 'measured', `物件紹介「${x}」`);
    const f = /(\d{1,2})階建て?の(?:ビル|建物|マンション|アパート|一軒家)/.exec(x);
    if (f?.[1] !== undefined && !floorsAboveGround.known) floorsAboveGround = known(Number(f[1]), 'measured', `物件紹介「${x}」`);
  }
  return { yearBuilt, floorsAboveGround };
}

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
    const name = parseCvName(html);
    if (name === '') return null;

    const meta = parseCvMeta(html);
    const addr = parseCvAddress(meta.get('住所') ?? '');
    // 東京都以外（ココンわらび＝埼玉県川口市）と、住所から区市が読めない頁は収録しない
    if (addr === null) return null;

    const slug = /house_detail\/([a-z0-9-]+)/.exec(ref.url)?.[1] ?? ref.url;
    const buildingId = `couverture:${slug}`;
    const fees = parseContractFees(meta.get('初期費用') ?? '');
    const cleaningFeeUpfront = cvCleaningIncluded(meta.get('初期費用') ?? '');
    const rooms = parseCvRooms(html);
    const imgM = /<meta property="og:image" content="([^"]+)"/.exec(html);
    const prose = parseCvProse(html);

    const building: Building = {
      id: buildingId,
      sourceId: 'couverture',
      sourceKey: slug,
      sourceUrl: ref.url,
      name,
      kind: 'sharehouse',
      addressRaw: addr.addressRaw,
      prefecture: addr.prefecture,
      ward: addr.ward,
      stations: parseCvStations(meta.get('最寄り駅') ?? ''),
      structure: notOffered<string>(),
      // 這個來源不標建物種別（マンション／アパート…）；那是 SUUMO 這類入口站才有的欄位
      buildingType: notOffered<string>(),
      yearBuilt: prose.yearBuilt,
      floorsAboveGround: prose.floorsAboveGround,
      totalUnits: parseCvTotalUnits(meta.get('部屋数')),
      imageUrls: imgM?.[1] !== undefined ? [imgM[1]] : [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    const units: Unit[] = rooms.filter((r) => r.vacant).map((r) => {
      // 分価頁は「個室」と「水回り付き個室」の二本立てなので、備考に居室内の水回りの
      // 記載があるかで選ぶ。規則も判定材料も同じ頁にあるので、srcText に推導過程を残す。
      // 一本値の頁は部屋の別なく同額なので、備考は選択に関与しない＝書かない。
      const feeJpy = r.wetArea ? fees.wet : fees.plain;
      const contractFee: Field<Yen> = feeJpy === null
        ? notListed(fees.raw)
        : known(yen(feeJpy), 'measured', fees.split
          ? `${fees.raw}｜備考=${r.wetArea ? `居室內有水回り（${r.note}）` : '無水回り記載'}`
          : fees.raw);
      const notes: string[] = [];
      if (r.note !== '') notes.push(`備考：${r.note}`);
      if (r.status !== '空室') notes.push(`空室状況：${r.status}`);

      return {
        id: `${buildingId}#${r.number}`,
        buildingId,
        unitKey: r.number,
        sourceUrl: ref.url,
        roomNo: known(r.number, 'measured', `部屋番号 ${r.number}`),
        layout: r.sharedBed
          ? known('ドミトリー', 'measured', `備考 ${r.note}（一床的價錢）`)
          : known('個室', 'measured', 'share house 個室'),
        // 多人房的一張床：卡片上的面積是整間共用的面積，不是這張床的——與 Sakura House 的 dormitory 同一處置
        areaM2: r.sharedBed ? notListed<number>(`${r.areaRaw}（${r.note}：整間面積，非本床專有）`) : r.areaM2,
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
          fireInsurance: cvFireInsurance(r.note),
          keyExchangeFee: notOffered<Yen>(),
          contractFee,
          cleaningFeeUpfront,
          otherInitial: notOffered<Yen>(),
        },
        deferred: {
          renewalFee: notOffered<Yen>(),
          renewalAdminFee: notOffered<Yen>(),
          cleaningFeeOnExit: notOffered<Yen>(),
          earlyTerminationPenalty: notOffered<Yen>(),
        },
        utilitiesBasis: 'unknown',
        // 改版後的房間卡片不再列個室設備（舊版的「個室部分設備：冷蔵庫、エアコン…」整段消失）；
        // 只有少數房間的備考寫「ソファ、セミダブルベッド付」——那是這間房自己的家具，記 true，原文留著
        furnished: /ベッド|ソファ|デスク|机|チェア|家具/.test(r.note)
          ? known(true, 'measured', `備考 ${r.note}`)
          : notListed<boolean>(''),
        availableFrom: cvAvailableFrom(r.status),
        // 「空室」＝現在空著；「10/29～空室」＝那天起才空（站方 class 是 status_schedule），與 ひつじ scheduled、
        // TSH 空室予定同一語意記 false——房間照收、入居日照存，只是「只看有空房」不會把它當現在有空
        isVacant: known(r.status === '空室', 'measured', `空室状況 ${r.status}`),
        contractType: 'unknown',
        contractMonths: notOffered<number>(),
        minStayMonths: notOffered<number>(),
        genderRestriction: cvGender(r.genders),
        ageLimitRaw: notOffered<string>(),
        petsAllowed: notOffered<boolean>(),
        foreigner: NOT_OFFERED_FOREIGNER,
        notes,
      };
    });

    return { building, units };
  },
};

export default adapter;
