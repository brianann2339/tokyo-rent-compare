/**
 * SUUMO（株式会社リクルート）adapter——房源量最大的來源，也是唯一的「一般賃貸」來源。
 *
 * 為什麼要收：其餘四個來源都是 share house／UR／Oak House，全是特殊型態。
 * SUUMO 補上的是普通的賃貸マンション・アパート，沒有它就沒有比較基準。
 *
 * ⚠️ 首版狀態：`legal.enabled = false`，可測試但不產生資料。
 *    理由見 `legal.notes`——利用規約第2条與第3条的條文限制超過「個人の私的利用」的
 *    使用與「商業目的で利用する行為」，是否適用於本專案需要使用者本人裁決。
 *    這不是解析故障，翻成 true 之前不會有任何資料產出。
 *
 * ── 收錄範圍：東京 23 区全部（2026-09-06 由使用者指示「資料越齊全越好」擴到全區）─────
 * 沿革：首版都心 3 区 → 2026-08-16 使用者指定 10 区 → 2026-09-06 補齊其餘 13 区。
 *   【實測 2026-08-16，pc=50 時各区的分頁總數】千代田 20、中央 40、港 59、新宿 96、世田谷 169。
 *   【實測 2026-09-06】文京 51 頁、新宿 97 頁；13 個新增区的掲載件數合計約 93 万件
 *     （最大 新宿 126,670、世田谷 116,731；最小 荒川 30,605）。
 *   23 区全量推估約 1,700 個列表頁、以 3 秒間隔約 85 分鐘。
 *   ⚠️ 前端資料預算：10 区時索引已是 1,485 KB gzip（預算 500 KB 的 3 倍）；
 *      23 区推估約 4 MB，**擴區必須配合索引壓縮**，否則首屏會慢到不能用。
 * 為什麼是「整個区抓完」而不是「每区前 N 頁」：
 *   SUUMO 列表預設是「おすすめ順」（廣告權重排序），取前 N 頁會得到一份有偏差的樣本；
 *   而且我們不能用 `sort=` 參數換排序（robots.txt 明文 Disallow）。
 *   整个区抓完至少是這個区的完整母體。
 * WARDS 是常數，主線要擴張範圍改這一個陣列即可。
 *
 * ── 取得方式：只讀一覧頁，不讀物件詳情頁 ─────────────────────────
 * 一覧頁（`/chintai/tokyo/sc_{ward}/?pc=50&page=N`）是 SSR HTML，每頁含 50 棟建物、
 * 每棟數間房，欄位有：賃料／管理費・共益費／敷金／礼金／階／間取り／専有面積／
 * 所在地／駅徒歩／築年数／階建／建物種別。
 * 物件詳情頁（`/chintai/jnc_XXXXXXXXXXXX/`）另有 保証金・敷引/償却・損保・鍵交換代・
 * 保証会社・ほか初期費用・契約期間・入居・総戸数・情報更新日，
 * **但每個房間各一頁**——一頁一覧的 299～493 個房間就要 299～493 次請求，
 * 是列表頁的 300～500 倍負載。首版不做，改用 `notListed()` 如實標記「這一頁沒寫」。
 * 那些欄位因此會讓 SUUMO 的房間落在初期費用的 B 區（僅有下限）——那正是實情。
 *
 * ── robots.txt 合規（2026-08-16 實測，sha256 9303fdf4…）────────────
 * 對 `User-agent: *` 共 183 條 Disallow，與本 adapter 相關的是（規則原文見 legal.notes；
 * 這裡的萬用字元寫成全形 ＊ 只是為了不讓 `*` 加 `/` 提前結束這個註解區塊）：
 *   `Disallow: /＊?＊sort=`           → **絕不使用排序參數**（見 assertNoSortParam）
 *   `Disallow: /map/chintai/`        → 不碰地圖檢索
 *   `Disallow: /sp/chintai/api/…`、`/sp/apiforward/`、`…/bukkencountlist/` → 不碰
 *   `Disallow: /chintai/＊/city/?sc%5B%5D=`、`?＊sc[]=` → 不使用 sc[] 形式的市区篩選
 * 我們只用 `/chintai/tokyo/sc_{ward}/`（路徑形式的市区篩選，未被禁止）
 * 與 `?pc=`（表示建物数）、`?page=`（分頁）兩個參數。
 * `Crawl-delay` 只對 bingbot 標了 30 秒，不適用我方 UA；但那代表站方希望慢一點，
 * 所以 crawlDelayMs 設 5000（比專案其他來源都保守）。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import { sha256 } from '../../src/robots.ts';
import {
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, PropertyKind,
} from '../../../packages/schema/src/model.ts';
import { parseMoney, monthsToYen } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseLayout } from '../../../packages/jp-parse/src/layout.ts';

const SITE = 'https://suumo.jp';

/**
 * 收錄範圍（使用者指定，2026-08-16）：都心 10 区。擴張改這個陣列即可。
 *
 * 量級提醒：SUUMO 跟其他來源差兩個數量級（都心 3 区實測 16,499 間房）。
 * 首屏索引已做字串瘦身（id／availFrom／img 移出索引），10 区仍可能超過
 * 500 KB gzip 預算——已知取捨，下一步是按区分片或二進位索引。
 * 真相層以 .ndjson.gz 存放，不受單檔上限影響。
 */
export const WARDS: ReadonlyArray<{ readonly slug: string; readonly nameJa: string }> = [
  { slug: 'sc_bunkyo', nameJa: '文京区' },
  { slug: 'sc_chuo', nameJa: '中央区' },
  { slug: 'sc_minato', nameJa: '港区' },
  { slug: 'sc_shibuya', nameJa: '渋谷区' },
  { slug: 'sc_chiyoda', nameJa: '千代田区' },
  { slug: 'sc_taito', nameJa: '台東区' },
  { slug: 'sc_toshima', nameJa: '豊島区' },
  { slug: 'sc_meguro', nameJa: '目黒区' },
  { slug: 'sc_shinagawa', nameJa: '品川区' },
  { slug: 'sc_koto', nameJa: '江東区' },
  // 2026-09-06 補齊其餘 13 区。每個 slug 都實際抓過首頁、以 <title> 含該区名驗證對應正確。
  { slug: 'sc_shinjuku', nameJa: '新宿区' },
  { slug: 'sc_setagaya', nameJa: '世田谷区' },
  { slug: 'sc_suginami', nameJa: '杉並区' },
  { slug: 'sc_nerima', nameJa: '練馬区' },
  { slug: 'sc_itabashi', nameJa: '板橋区' },
  { slug: 'sc_adachi', nameJa: '足立区' },
  { slug: 'sc_katsushika', nameJa: '葛飾区' },
  { slug: 'sc_edogawa', nameJa: '江戸川区' },
  { slug: 'sc_nakano', nameJa: '中野区' },
  { slug: 'sc_kita', nameJa: '北区' },
  { slug: 'sc_arakawa', nameJa: '荒川区' },
  { slug: 'sc_sumida', nameJa: '墨田区' },
  { slug: 'sc_ota', nameJa: '大田区' },
];

/**
 * 每頁顯示的建物數。實測 10/20/30/50 皆可（`pc` 是站方自己的 select name）。
 * 取 50 是為了少打對方 2.5 倍的請求——20（預設）要 50 頁的区，50 只要 20 頁。
 */
const PAGE_SIZE = 50;

/** 保險上限：實測最大的世田谷区是 169 頁；設 400 以免解析錯誤導致無限迴圈。 */
const MAX_PAGES_PER_WARD = 400;

export const manifest: SourceManifest = {
  id: 'suumo',
  name: 'SUUMO',
  nameZh: 'SUUMO（リクルート）',
  homepage: 'https://suumo.jp/chintai/',
  origin: 'https://suumo.jp',
  transport: 'http',
  // 資料全部來自一覧頁，discover 階段就備齊；再抓一次詳情頁會是 300 倍請求量
  fetchMode: 'none',
  crawlDelayMs: 5000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'keyMoney',
      'layout', 'areaM2', 'floor', 'stations', 'yearBuilt', 'floorsAboveGround',
    ],
    /**
     * 只列「SUUMO 全站（含物件詳情頁）都沒有這個欄位」的項目。
     * 依據：2026-08-16 對 3 個一覧頁與 1 個物件詳情頁的實際比對。
     *
     * 「詳情頁有、但首版只讀一覧頁所以拿不到」的欄位（保証金・敷引・損保・鍵交換代・
     * 保証会社・ほか初期費用・契約期間・入居・総戸数・情報更新日・ペット・家具…）
     * **不列在這裡**，一律用 notListed() 標成「這一頁沒寫」——
     * 把它們宣告成「來源不提供」會對使用者謊稱 SUUMO 沒有這些資訊。
     */
    neverProvides: [
      // 仲介手数料是不動産会社的報酬，不是物件規格：詳情頁只有「取引態様: 仲介」，
      // 金額只出現在店舗的廣告文案裡（「賃料の半月分+税にてご紹介可能」），
      // 不是這個物件的費用欄位，不可當成資料抓。
      'agencyFee',
      'roomNo',          // 部屋番号全站不公開
      'internet', 'otherMonthly',
      'genderRestriction', 'ageLimitRaw',
      'minStayMonths',
      // 一般賃貸沒有「外國人條件」欄位（一覧頁與詳情頁「外国人」出現次數皆為 0）
      'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
      'guarantorPersonRequired',
    ],
  },
  legal: {
    // ⚠️ 首版刻意為 false：利用規約的限制需要使用者本人裁決，見下方 notes。
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null, // 首次執行時寫入（SUUMO 的 robots.txt 很長且常動，寫死會頻繁誤停）
    tosReviewed: 'yes',
    notes:
      'robots.txt（2026-08-16 實測，sha256 9303fdf4880f9cf93f822cdd28c2064faf18b4ed71d80ecb6589882dc08bfbbd，'
      + 'User-agent:* 共 183 條 Disallow）與本 adapter 相關者：'
      + '「Disallow: /*?*sort=」「Disallow: /map/chintai/」「Disallow: /sp/chintai/api/bukken/count/」'
      + '「Disallow: /sp/chintai/*/bukkencountlist/」「Disallow: /sp/apiforward/」'
      + '「Disallow: /chintai/*/city/?sc%5B%5D=」「Disallow: /chintai/*/city/?*sc[]=」。'
      + '本 adapter 只請求 /chintai/tokyo/sc_{ward}/ 加 ?pc= 與 ?page= 兩個參數，'
      + '並在組 URL 時以 assertNoSortParam() 主動擋下任何含 sort= 的 URL。'
      + 'Crawl-delay 只對 bingbot 標 30 秒（不適用我方 UA），但據此把間隔設為 5000ms。'
      + ' ⚠️ 利用規約 https://cdn.p.recruit.co.jp/terms/suu-t-1003/index.html（2025年10月1日改定，'
      + '2026-08-16 抓取）第2条 著作権等 第1項逐字：'
      + '「ユーザーは、本サイトを通じて提供されるすべてのコンテンツについて、当社の事前の承諾なく'
      + '著作権法で定めるユーザー個人の私的利用の範囲を超える使用をしてはならないものとします。」'
      + '第3条 ユーザーの禁止行為 第1項(7)逐字：「商業目的で利用する行為(当社が認める場合を除く）」。'
      + '同規約全文中未出現「スクレイピング」「クローラ」「ロボット」「自動取得」等字詞。'
      + '→ 本來源的資料利用是否落在「個人の私的利用」範圍內，超出 adapter 可自行認定的範圍，'
      + '故 enabled 先設 false，待使用者本人裁決後再開啟。',
  },
};

// ───────────────────────── robots 護欄 ─────────────────────────

/**
 * `Disallow: /*?*sort=` 是這個來源最容易誤觸的一條：
 * SUUMO 列表頁自己的排序連結、以及很多教學文的範例 URL 都帶排序參數。
 * HttpFetcher 也會擋，但那是最後一道；在組 URL 的地方就擋掉，
 * 才能在測試裡直接證明「我們永遠不會產生這種 URL」。
 */
export function assertNoSortParam(url: string): string {
  const q = new URL(url).search;
  if (/[?&][^=&]*sort=/i.test(q)) {
    throw new Error(`[suumo] 拒絕組出含 sort= 的 URL（robots.txt: Disallow: /*?*sort=）：${url}`);
  }
  if (/sc(%5B%5D|\[\])=/i.test(q)) {
    throw new Error(`[suumo] 拒絕組出 sc[] 形式的市区篩選 URL（robots.txt Disallow）：${url}`);
  }
  return url;
}

export function listUrl(wardSlug: string, page: number): string {
  const base = `${SITE}/chintai/tokyo/${wardSlug}/?pc=${PAGE_SIZE}`;
  return assertNoSortParam(page <= 1 ? base : `${base}&page=${page}`);
}

// ───────────────────────── 一覧頁解析 ─────────────────────────

/** 一覧頁的一列＝一個房間（SUUMO 的一個「物件」掲載）。全部是原站原文，不做任何換算。 */
export type SuumoRow = {
  /** SUUMO 物件コード，例 100503128278。列表頁 checkbox 的 value。 */
  readonly bukkenCode: string;
  readonly detailUrl: string;
  readonly floorText: string;
  readonly rentText: string;
  readonly adminText: string;
  readonly depositText: string;
  readonly gratuityText: string;
  readonly layoutText: string;
  readonly areaText: string;
  readonly tags: readonly string[];
};

/** 一覧頁的一個 cassetteitem＝一棟建物。 */
export type SuumoBuilding = {
  readonly name: string;
  readonly kindLabel: string;      // 賃貸マンション／賃貸アパート／賃貸一戸建て
  readonly addressRaw: string;     // 東京都千代田区神田小川町１
  readonly stationTexts: readonly string[];
  readonly ageText: string;        // 築5年／新築
  readonly floorsText: string;     // 13階建／地下1地上14階建
  readonly imageUrl: string;
  readonly rows: readonly SuumoRow[];
};

const BLOCK_OPEN = '<div class="cassetteitem">';
const ROW_OPEN = '<tr class="js-cassette_link">';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function pick(re: RegExp, s: string): string {
  const m = re.exec(s);
  return m?.[1] === undefined ? '' : decodeEntities(m[1]).trim();
}

/**
 * 每個 cassetteitem 內恰有一個 `<table class="cassetteitem_other">`，
 * 所以「從 block 開頭到下一個 `</table>`」就是這棟建物的完整範圍。
 * 用下一個 BLOCK_OPEN 當結尾在**最後一棟**會失效——後面接的是推薦輪播，
 * 那裡有同樣的 `ui-pct--util1` 標籤與價格字串，會把廣告物件吃進來。
 */
export function parseListPage(html: string): SuumoBuilding[] {
  const out: SuumoBuilding[] = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf(BLOCK_OPEN, from);
    if (start < 0) break;
    const close = html.indexOf('</table>', start);
    const end = close < 0 ? html.length : close + '</table>'.length;
    from = end;

    const block = html.slice(start, end);
    const b = parseBuildingBlock(block);
    if (b !== null) out.push(b);
  }
  return out;
}

function parseBuildingBlock(block: string): SuumoBuilding | null {
  const name = pick(/<div class="cassetteitem_content-title">([^<]*)<\/div>/, block);
  const addressRaw = pick(/<li class="cassetteitem_detail-col1">([^<]*)<\/li>/, block);
  if (name === '' || addressRaw === '') return null;

  const col2 = /<li class="cassetteitem_detail-col2">([\s\S]*?)<\/li>/.exec(block)?.[1] ?? '';
  const stationTexts = [...col2.matchAll(/<div class="cassetteitem_detail-text">([^<]*)<\/div>/g)]
    .map((m) => decodeEntities(m[1] ?? '').trim())
    .filter((s) => s !== '');

  const col3 = /<li class="cassetteitem_detail-col3">([\s\S]*?)<\/li>/.exec(block)?.[1] ?? '';
  const col3Divs = [...col3.matchAll(/<div>([^<]*)<\/div>/g)].map((m) => decodeEntities(m[1] ?? '').trim());

  const rows: SuumoRow[] = [];
  let from = 0;
  for (;;) {
    const s = block.indexOf(ROW_OPEN, from);
    if (s < 0) break;
    const e = block.indexOf(ROW_OPEN, s + ROW_OPEN.length);
    from = e < 0 ? block.length : e;
    const row = parseRow(block.slice(s, e < 0 ? block.length : e));
    if (row !== null) rows.push(row);
    if (e < 0) break;
  }

  // 少解出來一列，就是少一間房——而且完全不會有任何錯誤訊息。
  // 實測 3 個 fixture 共 835 列 100% 解析成功，所以「解出來的比 <tr> 少」一定是改版，
  // 不是資料本來就長這樣。寧可整個 ward 停下來，也不要默默漏房源。
  const trCount = (block.match(/<tr class="js-cassette_link">/g) ?? []).length;
  if (rows.length < trCount) {
    throw new Error(
      `[suumo] 「${name}」有 ${trCount} 個房間列但只解析出 ${rows.length} 列——一覧頁版型可能已改版`,
    );
  }
  if (rows.length === 0) return null;

  return {
    name,
    kindLabel: pick(/<span class="ui-pct ui-pct--util1">([^<]*)<\/span>/, block),
    addressRaw,
    stationTexts,
    ageText: col3Divs[0] ?? '',
    floorsText: col3Divs[1] ?? '',
    imageUrl: pick(/<div class="cassetteitem_object-item">\s*<img[^>]*\brel="([^"]+)"/, block),
    rows,
  };
}

/**
 * 「階」欄沒有 class，只能靠位置定位：它是緊接在賃料那個 `<td>` 前面的 `<td>`。
 * 用「第 N 個 td」數位置會被縮圖欄的巢狀 td 弄錯，所以用向前 lookahead 錨在賃料上。
 */
const FLOOR_RE =
  /<td>\s*([^<>]*?)\s*<\/td>(?=\s*<td>\s*<ul>\s*<li><span class="cassetteitem_price cassetteitem_price--rent")/;

function parseRow(row: string): SuumoRow | null {
  // class 是多值的（`js-ikkatsuCB js-single_checkbox`），不能寫死整個 class 屬性
  const bukkenCode = pick(/<input[^>]*js-single_checkbox[^>]*\bvalue="(\d+)"/, row)
    || pick(/<input[^>]*js-clipkey[^>]*\bvalue="(\d+)"/, row);
  // 站方的連結帶追蹤參數（`/chintai/jnc_000107595656/?bc=100503128278`），
  // 只留乾淨路徑：查詢字串對使用者沒有意義，也讓連結不會夾帶我們沒查證過的參數
  const detailPath = pick(/href="(\/chintai\/jnc_\d+\/)(?:\?[^"]*)?"/, row);
  if (bukkenCode === '' || detailPath === '') return null;

  return {
    bukkenCode,
    detailUrl: `${SITE}${detailPath}`,
    floorText: pick(FLOOR_RE, row),
    // 賃料外面多包一層 <span class="cassetteitem_other-emphasis">，其餘費用沒有
    rentText: pick(/cassetteitem_price--rent"[^>]*>(?:<span[^>]*>)?([^<]*)/, row),
    adminText: pick(/cassetteitem_price--administration">([^<]*)</, row),
    depositText: pick(/cassetteitem_price--deposit">([^<]*)</, row),
    gratuityText: pick(/cassetteitem_price--gratuity">([^<]*)</, row),
    layoutText: pick(/<span class="cassetteitem_madori">([^<]*)<\/span>/, row),
    // 面積被 <sup>2</sup> 切開：`25.13m<sup>2</sup>` → `25.13m2`
    areaText: pick(/<span class="cassetteitem_menseki">([\s\S]*?)<\/span>/, row)
      .replace(/<sup>\s*2\s*<\/sup>/gi, '2'),
    tags: [...row.matchAll(/<span class="cassetteitem-tag">([^<]*)<\/span>/g)]
      .map((m) => decodeEntities(m[1] ?? '').trim())
      .filter((s) => s !== ''),
  };
}

/**
 * 分頁總數。列表頁的分頁列長這樣：`1 2 3 4 5 … 20`，最後一個數字就是總頁數
 * （實測千代田区 pc=50 顯示 20，page=20 回 39 棟（不滿頁）、page=21 回 0 棟）。
 * 寫死頁數會在房源增減時默默漏抓或空打，所以每次都從頁面讀。
 */
export function parseMaxPage(html: string): number | null {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  return pages.length === 0 ? null : Math.max(...pages);
}

// ───────────────────────── 欄位轉換 ─────────────────────────

/**
 * 車站：`ＪＲ山手線/神田駅 歩4分`。
 * 注意是「歩4分」不是「徒歩4分」——jp-parse 的 parseStations 認的是「徒歩」，
 * 直接套會全部解不出來（2026-08-16 實測 278 個相異車站字串全是這個格式）。
 *
 * ⚠️ 已知的**站方自身不一致**（2026-08-16 逐欄核對時發現，不是解析錯誤）：
 * 同一個物件在一覧頁與詳情頁列出的車站**不一定是同一組**。
 * 例：チェスターコート御茶ノ水（物件コード 100521828056）
 *   一覧頁 → 都営新宿線/小川町駅 歩3分、東京メトロ千代田線/新御茶ノ水駅 歩5分、東京メトロ半蔵門線/神保町駅 歩7分
 *   詳情頁 → 都営新宿線/小川町駅 歩3分、都営三田線/神保町駅 歩7分、ＪＲ中央線/御茶ノ水駅 歩9分
 * 最近站（第一筆）兩邊一致，其餘是站方各自挑選的路線。我們採用一覧頁那組並保留原文。
 */
const STATION_RE = /^(.+?)\/(.+?)駅\s*歩\s*(\d+)\s*分$/;

export function parseSuumoStation(text: string): Station | null {
  const t = text.trim();
  if (t === '') return null;
  const m = STATION_RE.exec(t);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
    // バス経由等的其他寫法：保留原文，但不編一個步行分鐘出來
    const slash = t.indexOf('/');
    return {
      line: slash > 0 ? t.slice(0, slash) : '',
      station: (slash > 0 ? t.slice(slash + 1) : t).replace(/駅.*$/, ''),
      walkMinutes: notListed(t),
      rawText: t,
    };
  }
  return {
    line: m[1].trim(),
    station: m[2].trim(),
    walkMinutes: known(Number(m[3]), 'measured', t),
    rawText: t,
  };
}

/**
 * 一覧頁的「階」欄。
 *
 * 2026-09-06 對真相層全量掃描，解不出數字的寫法共 47 種、3,679 間房，
 * 其中最多的是メゾネット的樓層區間（`1-2階` 1,738、`1-3階` 600…）
 * 與地下樓層（`B1階` 454、`B1-1階` 255、`B2階` 20…）。
 *
 * 先前這些一律回 `notListed(t)`，也就是對著一個白紙黑字寫著「B1階」的頁面
 * 宣稱「這一頁沒寫樓層」——那句話是假的，而且它把故障訊號也一併關掉了
 * （`unparsed` 是健康監控唯一不需基線就有意義的訊號，全站卻只有 30 筆）。
 *
 * 現在的分法：
 *   - `4階` → 4；`B1階` → −1（地下 N 階記成 −N，是日本通用的表示法）
 *   - `2-2階` 這種上下界相同的區間 → 就是 2 階
 *   - `1-2階`／`B2-B1階` 這種真的橫跨兩層 → **unparsed**：頁面有寫，
 *     但我們的模型是單一樓層，給任何一個數字都是選一個來用
 *   - 空字串與 `-` → notListed（頁面真的沒寫）
 */
export function parseFloorLabel(text: string): Field<number> {
  const t = text.trim();
  if (t === '' || t === '-') return notListed(t);
  const m = /^(B?\d+)-(B?\d+)階$|^(B?\d+)階$/.exec(t);
  if (m === null) return unparsed(`階 ${t}`);
  const num = (x: string): number => (x.startsWith('B') ? -Number(x.slice(1)) : Number(x));
  if (m[3] !== undefined) return known(num(m[3]), 'measured', `階 ${t}`);
  const lo = num(m[1] as string);
  const hi = num(m[2] as string);
  if (lo !== hi) return unparsed(`階 ${t}`);
  return known(lo, 'measured', `階 ${t}`);
}

/**
 * 築年。**SUUMO 一覧頁不寫完工年，只寫屋齡**，所以這裡不能用 jp-parse 的 parseYearBuilt
 * （它的「築N年」分支是 `now.getFullYear() - N`，對 SUUMO 會系統性推早一年）。
 *
 * ── SUUMO 的「築N年」到底是什麼（2026-09-06 兩組互相獨立的實測，逐字比對原始檔）──
 *   N = (基準年 − 完工年) + (完工月 ≤ 基準月 ? 1 : 0)     ← 含月份的**進位**屋齡
 *   (a) data/aliases/buildings.json 人審通過的 suumo×leopalace21 同棟共 775 組，
 *       其中 773 組雙方都有築年；以各棟自己那頁的抓取時點（JST）代入上式，
 *       **773/773** 與 SUUMO 印出的「築N年」完全相同，0 例外。
 *   (b) data/raw/suumo 內另有 4 個物件詳情頁帶結構化的「築年月」欄
 *       （jnc_000109161796＝2007年3月／jnc_000109148930＝2020年8月／
 *         jnc_000107595656＝2022年3月／jnc_000108031279＝2026年7月），
 *       與同批一覧頁的「築20年／築7年／築5年／新築」也 **4/4** 相符。
 *   全 1,767 頁掃描結果：一覧頁的築年欄只有三種寫法——「築N年」（N=0〜99）、
 *   「新築」3,849 次、「築99年以上」16 次；「築年月」只出現在上述 4 個詳情頁。
 *
 * ── 為什麼不是「加 1」──────────────────────────────────────
 * 把上式反解，一個「築N年」對應的不是一個年份，而是一段 12 個月的完工區間，
 * 它橫跨兩個西元年；完工年只可能是 Y−N 或 Y−N+1，我們無從分辨是哪一個
 * （前述 773 組裡 175 組落在 Y−N、598 組落在 Y−N+1）。
 * 「一律 +1」會有 22.6% 的筆數是錯的——那是猜一個年份，不是解析出一個年份。
 *
 * ── 所以存什麼 ────────────────────────────────────────────
 * 存**區間的下界年**，並且 basis 用 'unstated' 而不是 'measured'：
 * 這個年份是我們從屋齡推出來的，SUUMO 從來沒有寫過它，
 * 而 'measured' 的定義是「原站明寫」（見 packages/schema/src/field.ts）。
 * srcText 一律寫出推導過程與區間，讓任何人事後都看得出真值可能是下一年
 * （「新築」只寫下界——它的完工日可能還在未來，寫上界會是假的）。
 * 下界年還有一個好處：用該頁的抓取年回推屋齡（Y − 下界年）會剛好還原
 * SUUMO 自己印的「築N年」，我們不會跟來源自相矛盾。
 */
function monthIndex(year: number, month: number): number { return year * 12 + (month - 1); }

function fromMonthIndex(i: number): { year: number; month: number } {
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

/** SUUMO 的頁面以日本時間渲染，基準月份要用 JST 取；用 UTC 會在月底跨月時整整差一個月。 */
function jstYearMonth(at: Date): { year: number; month: number } {
  const d = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/**
 * @param ageText  一覧頁 col3 的第一個 div（`築5年`／`新築`／`築99年以上`）
 * @param listFetchedAt **那一頁**被抓下來的時間——不是重新解析的時間。
 *   兩者不同就會整批位移一年，所以基準時間是從 hint 帶進來的（見 `__listFetchedAt`）。
 */
export function parseSuumoYearBuilt(ageText: string, listFetchedAt: Date): Field<number> {
  const t = ageText.trim();
  if (t === '') return notListed('');
  const { year, month } = jstYearMonth(listFetchedAt);
  const base = `該頁抓取於 ${year}年${month}月`;

  // 「築99年以上」是 SUUMO 的封頂顯示：只說了屋齡 ≥99 年，換算成年份只有上界
  // （完工不晚於某年），沒有下界可存——真值可能是 1890 年。
  // 舊版把它當成「築99年」推出確切的 1927，是把一個界限當成值。
  if (t.includes('以上')) {
    return unparsed(`築年数 ${t}（${base}；封頂顯示，只給了屋齡下界，無法推出完工年下界）`);
  }

  // 新築＝完工未滿 1 年且未曾入居（品確法第2条）。SUUMO 對這種物件不印「築N年」，
  // 而且**包含尚未完工的物件**（實測 jnc_000109467282 的 leopalace 原文是「2026年10月築」，
  // SUUMO 一覧頁寫「新築」），所以完工日可能還在未來。
  // 能保證的只有「完工不早於抓取日的一年前」——與「築1年」的區間下界完全相同。
  const bucket = t === '新築' ? 1 : null;
  const m = bucket === null ? /^築\s*(\d+)\s*年$/.exec(t) : null;
  if (bucket === null && m?.[1] === undefined) {
    return unparsed(`築年数 ${t}（${base}；不是「築N年」也不是「新築」，可能是版型改了）`);
  }
  const age = bucket ?? Number(m?.[1]);
  if (!Number.isFinite(age) || age < 0 || age > 150) {
    return unparsed(`築年数 ${t}（${base}；屋齡 ${age} 超出可信範圍）`);
  }

  const baseIdx = monthIndex(year, month);
  const from = fromMonthIndex(baseIdx - 12 * age + 1);
  const to = fromMonthIndex(baseIdx - 12 * age + 12);
  // 「新築」只有下界：完工可能還在未來，寫出上界會是假的。
  // 實例：jnc_000109467282（アルク中川コート）一覧頁寫「新築」，
  // 人審同棟的 leopalace21 原文是「2026年10月築」，比 2026-09 的抓取日還晚。
  const note = t === '新築'
    ? `築年数 新築（${base}；未滿 1 年且未入居，SUUMO 對尚未完工的物件也標新築，`
      + `故完工不早於 ${from.year}年${from.month}月、可能仍在未來，此處存下界年）`
    : `築年数 ${t}（${base}；SUUMO 的築年数是含月份進位的屋齡，`
      + `可推得完工 ∈ ${from.year}年${from.month}月〜${to.year}年${to.month}月，此處存區間下界年）`;
  return known(from.year, 'unstated', note);
}

/** `13階建` → 13；`地下1地上14階建` → 14（地下不計入地上樓層數）。 */
export function parseFloorsAboveGround(text: string): Field<number> {
  const t = text.trim();
  if (t === '') return notListed('');
  const m = /(\d+)\s*階建/.exec(t);
  if (m?.[1] === undefined) return notListed(t);
  return known(Number(m[1]), 'measured', `階建 ${t}`);
}

/** `東京都千代田区神田小川町１` → `千代田区`。非東京都一律回 null（只收東京都物件）。 */
export function parseWard(addressRaw: string): string | null {
  if (!addressRaw.startsWith('東京都')) return null;
  const m = /^東京都((?:[^\s0-9０-９]{1,5}郡)?[^\s0-9０-９]{1,6}?[区市町村])/.exec(addressRaw);
  return m?.[1] ?? null;
}

/**
 * 金額欄位。SUUMO 一覧頁的 `-` 是**沒有數字**，不是 0。
 *
 * 業界慣例上 礼金「-」多半代表礼金なし，但 SUUMO 並沒有在任何地方這樣定義，
 * 也沒有寫「なし／不要／0円」。把它當 0 就是替使用者編一個省下來的錢，
 * 所以一律 notListed——建置期閘門也會擋沒依據的 0。
 *
 * `1ヶ月` 這種倍數寫法必須乘上賃料；賃料未知時不可換算（回 notListed）。
 */
export function moneyField(text: string, label: string, rentJpy: number | null): Field<Yen> {
  const raw = text.trim();
  if (raw === '') return notListed('');
  const r = parseMoney(raw);
  switch (r.kind) {
    case 'amount':
      return known(yen(r.jpy), 'measured', `${label} ${raw}`);
    case 'zero':
      return known(yen(0), 'measured', `${label} ${raw}`);
    case 'months':
      return rentJpy === null
        ? notListed(`${label} ${raw}（賃料未知，無法換算）`)
        : known(yen(monthsToYen(r.months, rentJpy)), 'measured', `${label} ${raw}（賃料 ${rentJpy} 円 × ${r.months}）`);
    case 'included':
      return known(yen(0), 'included_stated', `${label} ${raw}`);
    case 'unparsed':
      return unparsed(`${label} ${raw}`);
    case 'negotiable':
    case 'absent':
      return notListed(`${label} ${raw}`);
  }
}

const KIND_BY_LABEL: Readonly<Record<string, PropertyKind>> = {
  賃貸マンション: 'apartment',
  賃貸アパート: 'apartment',
  賃貸一戸建て: 'apartment',
  賃貸テラス・タウンハウス: 'apartment',
};

/** SUUMO 一般賃貸沒有任何外國人條件欄位（一覧頁與詳情頁「外国人」出現次數皆為 0）。 */
const NOT_OFFERED_FOREIGNER: ForeignerPolicy = {
  welcomed: notOffered<boolean>(),
  residenceCardRequired: notOffered<boolean>(),
  japaneseRequired: notOffered<boolean>(),
  guarantorCompanyRequired: notListed('詳情頁有「保証会社」欄，首版只讀一覧頁'),
  guarantorPersonRequired: notOffered<boolean>(),
  rawText: '',
};

// ───────────────────────── adapter ─────────────────────────

/** discover 把整棟建物打包進 hint，extract 不再打網路（fetchMode: 'none'）。 */
type Hint = SuumoBuilding & {
  readonly __wardSlug: string;
  readonly __listUrl: string;
  readonly __listSha256: string;
  /**
   * 這一頁被抓下來的時間（ISO）。築年只能從屋齡回推，基準必須是**抓取時點**；
   * SUUMO 的 fetchMode 是 'none'，extract 拿到的 raw.fetchedAt 是重新解析的當下，
   * 拿它當基準會讓每次重跑都把全站築年往後推一年。
   */
  readonly __listFetchedAt: string;
};

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef> {
    for (const ward of WARDS) {
      const first = await fetcher.get(listUrl(ward.slug, 1));
      const firstBuildings = parseListPage(first.body);
      if (firstBuildings.length === 0) {
        throw new Error(`[suumo] ${ward.nameJa}（${ward.slug}）第 1 頁解析出 0 棟——版型或 URL 樣式可能已改`);
      }
      const maxPage = parseMaxPage(first.body);
      if (maxPage === null) {
        throw new Error(`[suumo] ${ward.nameJa} 第 1 頁讀不到分頁總數——不知道要抓幾頁，停止而非猜一個數字`);
      }

      for (const b of firstBuildings) {
        yield refOf(b, ward.slug, first.url, first.sha256, first.fetchedAt);
      }

      for (let page = 2; page <= Math.min(maxPage, MAX_PAGES_PER_WARD); page++) {
        const doc = await fetcher.get(listUrl(ward.slug, page));
        const buildings = parseListPage(doc.body);
        // 超過最後一頁時 SUUMO 回一個 0 筆的頁面：這是正常終止，不是錯誤
        if (buildings.length === 0) break;
        for (const b of buildings) {
          yield refOf(b, ward.slug, doc.url, doc.sha256, doc.fetchedAt);
        }
      }
    }
  },

  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null {
    const h = ref.hint as unknown as Hint | undefined;
    if (h === undefined || typeof h.name !== 'string' || !Array.isArray(h.rows)) return null;

    const ward = parseWard(h.addressRaw);
    // 只收東京都物件。非東京都＝不在收錄範圍（回 null，不是錯誤）
    if (ward === null) return null;

    // 基準時間：這一頁自己的抓取時點。hint 沒帶（例如手工組 hint）時才退回 ctx.now，
    // 因為推早／推晚一年比解析不出來更難察覺。
    const listFetchedAt = new Date(h.__listFetchedAt);
    const ageBaseAt = Number.isNaN(listFetchedAt.getTime()) ? ctx.now : listFetchedAt;

    const buildingId = `suumo:${h.__wardSlug}/${sha256(`${h.name}|${h.addressRaw}`).slice(0, 12)}`;
    const firstRow = h.rows[0];
    if (firstRow === undefined) return null;

    const building: Building = {
      id: buildingId,
      sourceId: 'suumo',
      sourceKey: `${h.__wardSlug}/${sha256(`${h.name}|${h.addressRaw}`).slice(0, 12)}`,
      // 建物本身在 SUUMO 沒有專屬頁面，指向第一間房的物件詳情頁（同一棟、可再往下逛）
      sourceUrl: firstRow.detailUrl,
      name: h.name,
      kind: KIND_BY_LABEL[h.kindLabel] ?? 'unknown',
      addressRaw: h.addressRaw,
      prefecture: '東京都',
      ward,
      stations: h.stationTexts
        .map(parseSuumoStation)
        .filter((s): s is Station => s !== null),
      // 「建物種別: マンション」是種別不是構造（RC造等），SUUMO 賃貸不刊構造
      structure: notListed(h.kindLabel),
      yearBuilt: parseSuumoYearBuilt(h.ageText, ageBaseAt),
      // 建物種別（賃貸マンション／アパート／一戸建て／テラス・タウンハウス／その他）。
      // 這個欄位其實一直被解析著（`h.kindLabel`），只是以前只拿來推 `kind`（全部映到 apartment）
      // 就丟掉了。2026-09-06 全量統計 87,318 個標記：マンション 69.2%、アパート 26.9%、
      // 一戸建て 3.1%、テラス・タウンハウス 0.7%、**その他 53 棟**。
      // 最後那個很小但很重要——抽驗抓到 3.57㎡「舟渡トランクルーム」與 2.4㎡「bCASA Yahiro」
      // 都是「その他」：值抄對了，但它們是儲藏空間不是住宅，混進找房的池子會污染每㎡單價。
      // 開頭的「賃貸」是全站共通贅字，去掉只留種別本身。
      buildingType: h.kindLabel === ''
        ? notListed<string>('')
        : known(h.kindLabel.replace(/^賃貸/, ''), 'measured', `建物種別 ${h.kindLabel}`),
      floorsAboveGround: parseFloorsAboveGround(h.floorsText),
      totalUnits: notListed('詳情頁有「総戸数」欄，首版只讀一覧頁'),
      imageUrls: h.imageUrl === '' ? [] : [h.imageUrl],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notListed('詳情頁有「情報更新日」欄，首版只讀一覧頁'),
      htmlSha256: h.__listSha256,
    };

    const units = h.rows.map((r) => buildUnit(buildingId, h, r));
    return { building, units };
  },
};

const DETAIL_ONLY = (field: string): string => `詳情頁有「${field}」欄，首版只讀一覧頁`;

function buildUnit(buildingId: string, h: Hint, r: SuumoRow): Unit {
  const rent = moneyField(r.rentText, '賃料', null);
  const rentJpy = rent.known ? rent.v.jpy : null;
  const layout = parseLayout(r.layoutText);
  const area = parseArea(r.areaText);

  return {
    id: `${buildingId}#${r.bukkenCode}`,
    buildingId,
    unitKey: r.bukkenCode,
    sourceUrl: r.detailUrl,
    roomNo: notOffered<string>(),
    // 認得的用 jp-parse 的 canonical（ワンルーム→1R、nLDK+S→nSLDK 已正規化），
    // 認不得的就用原站原文——那本來就是站方的正式標示，不丟成 unparsed
    layout: r.layoutText === ''
      ? notListed('')
      : known(layout.kind === 'rooms' ? layout.canonical : r.layoutText, 'measured', `間取り ${r.layoutText}`),
    areaM2: area.kind === 'exact'
      ? known(area.m2, 'measured', `専有面積 ${r.areaText}`)
      : notListed(r.areaText),
    floor: parseFloorLabel(r.floorText),
    monthly: {
      rent,
      adminFee: moneyField(r.adminText, '管理費・共益費', rentJpy),
      // 詳情頁有「目安光熱費」欄（實測該筆為 -），一覧頁沒有
      utilities: notListed(DETAIL_ONLY('目安光熱費')),
      internet: notOffered<Yen>(),
      otherMonthly: notOffered<Yen>(),
    },
    initial: {
      keyMoney: moneyField(r.gratuityText, '礼金', rentJpy),
      deposit: moneyField(r.depositText, '敷金', rentJpy),
      depositNonRefundable: notListed(DETAIL_ONLY('敷引・償却')),
      agencyFee: notOffered<Yen>(),
      guarantorInitialFee: notListed(DETAIL_ONLY('保証会社')),
      fireInsurance: notListed(DETAIL_ONLY('損保')),
      keyExchangeFee: notListed(DETAIL_ONLY('ほか初期費用（鍵交換代）')),
      contractFee: notListed(DETAIL_ONLY('ほか初期費用')),
      cleaningFeeUpfront: notListed(DETAIL_ONLY('ほか初期費用')),
      otherInitial: notListed(DETAIL_ONLY('ほか初期費用')),
    },
    deferred: {
      // 更新料在本次查證的詳情頁沒有出現，但只看過 1 頁，不足以斷言全站沒有
      renewalFee: notListed('本次查證的詳情頁未見「更新料」欄（樣本僅 1 頁）'),
      renewalAdminFee: notListed('本次查證的詳情頁未見「更新事務手数料」欄（樣本僅 1 頁）'),
      cleaningFeeOnExit: notListed(DETAIL_ONLY('備考（退去時清掃）')),
      earlyTerminationPenalty: notListed(DETAIL_ONLY('備考')),
    },
    // SUUMO 的管理費・共益費與水道光熱費是兩回事，站上沒說水電含不含
    utilitiesBasis: 'unknown',
    furnished: notListed('「家具家電付き」是こだわり条件，一覧頁的房間列沒有這個標記'),
    availableFrom: notListed(DETAIL_ONLY('入居')),
    // 一覧頁沒有任何「空室／満室」欄位。「刊登在賃貸一覧上」是推論不是頁面事實，不填。
    isVacant: notListed(DETAIL_ONLY('入居')),
    contractType: 'unknown',
    contractMonths: notListed(DETAIL_ONLY('契約期間')),
    minStayMonths: notOffered<number>(),
    genderRestriction: 'unknown',
    ageLimitRaw: notOffered<string>(),
    petsAllowed: notListed('「ペット相談」是物件特徴，一覧頁的房間列沒有這個標記'),
    foreigner: NOT_OFFERED_FOREIGNER,
    notes: [
      `建物種別：${h.kindLabel}`,
      ...(r.tags.length > 0 ? [`一覧頁標記：${r.tags.join('・')}`] : []),
      '初期費用只有敷金與礼金來自 SUUMO 一覧頁；保証金・敷引・損保・鍵交換代・保証会社・'
      + 'ほか初期費用在物件詳情頁，首版未取得，故初期現金為下界。',
    ],
  };
}

function refOf(b: SuumoBuilding, wardSlug: string, url: string, hash: string, fetchedAt: string): TargetRef {
  const hint: Hint = {
    ...b, __wardSlug: wardSlug, __listUrl: url, __listSha256: hash, __listFetchedAt: fetchedAt,
  };
  return {
    url: b.rows[0]?.detailUrl ?? url,
    hint: hint as unknown as Record<string, unknown>,
  };
}

export default adapter;
