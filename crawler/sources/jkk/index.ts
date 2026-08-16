/**
 * JKK東京（東京都住宅供給公社）adapter —「先着順あき家募集」。
 *
 * 收錄它的理由：東京都 100% 出資的特別法人，管理約 70,000 戸，而且官方明文
 * 「全物件が礼金・仲介手数料・更新料一切なし」
 * （https://www.to-kousya.or.jp/chintai/shitteru/charm/ 2026-08-16 逐字）。
 * 申込資格也明文接受外國籍
 * （https://www.to-kousya.or.jp/chintai/rent/index.html：
 *  「（1）日本国内に居住している成年者の方　外国籍の方でもお申込みできます。」）。
 * 幾乎沒有比價站收錄它，對外國人的實際價值卻極高。
 *
 * ⚠️ 敷金**不套用**上面那條零費用通則。JKK 的「敷金０円」是有條件的
 * （限用指定保証会社／らくらくスタート安心プラン），條件不成立時仍要付敷金，
 * 所以敷金一律讀詳情頁該欄的實際金額，讀不到就 notListed，絕不填 0。
 *
 * 取得方式：房源系統在另一台主機 jhomes.to-kousya.or.jp，是老式 Java servlet：
 *   1. GET  akiyaJyoukenStartInit → 3KB 自動送出跳板頁（含 forwardForm.url）
 *   2. POST 回同一 URL（帶 cookie）→ 41KB 搜尋條件表單（含 token / abcde / jklm）
 *   3. POST akiyaJyoukenRef（勾選区市）→ 結果清單（每列一個 senPage(...) 呼叫）
 *   4. POST akiyaSenDet（帶 mskKbn / jyutakuCd / yusenKbn）→ 住戸一覽詳情頁
 * 沒有驗證碼、沒有登入、沒有 robots.txt；「讀出表單裡的 token 再送回去」就是
 * 一般瀏覽器行為。若哪天出現驗證碼／WAF／403，assertNotBlocked 會直接丟例外停手。
 *
 * ⚠️ 全站編碼是 Windows-31J（Shift_JIS），用 UTF-8 解會整頁亂碼——
 * 專案的 HttpFetcher 只做 GET 且假設 UTF-8，所以這裡自備 fetch（同 UR adapter），
 * 並自己在每個請求前 sleep manifest.crawlDelayMs。
 */

import type { SourceAdapter, SourceManifest, TargetRef, RawDoc, ExtractContext, Fetcher } from '../../src/types.ts';
import {
  known, notListed, notOffered, unparsed, yen, type Field, type Yen,
} from '../../../packages/schema/src/field.ts';
import type {
  Building, Unit, Listing, Station, ForeignerPolicy, ContractType,
} from '../../../packages/schema/src/model.ts';
import { parseMoney } from '../../../packages/jp-parse/src/money.ts';
import { parseArea } from '../../../packages/jp-parse/src/area.ts';
import { parseLayout } from '../../../packages/jp-parse/src/layout.ts';
import { parseYearBuilt } from '../../../packages/jp-parse/src/contract.ts';
import { toHalfWidth } from '../../../packages/jp-parse/src/text.ts';

const BASE = 'https://jhomes.to-kousya.or.jp/search/jkknet/service';
const START = `${BASE}/akiyaJyoukenStartInit`;
const UA = 'TokyoRentCompare/0.1 (personal rental price-comparison aggregator; links back to to-kousya.or.jp)';

/**
 * 收錄範圍：東京 23 区全部（区部）。
 *
 * 代碼取自搜尋表單的 `akiyaInitRM.akiyaRefM.checks`（2026-08-16 實讀）。
 * 不收市部（八王子・立川等 30 個市町村）的理由：本站的比較對象是通勤圈內的
 * share house 與都心賃貸，市部物件與它們不在同一個選擇集裡，混進來只會稀釋比較。
 * 表單上被 disabled 的区（當下無募集）仍然送出——JKK 的 disabled 只反映「此刻沒有空室」，
 * 是會變動的狀態，寫死排除等於把未來的物件也一起排除掉。
 */
const WARD_CODES = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23',
] as const;

/**
 * 沿線名稱字典，取自搜尋表單的 `akiyaInitRM.akiyaRefM.ensenCd` 選項（2026-08-16 實讀）。
 *
 * 為什麼需要它：JKK 的「交通」欄是**無分隔符**的 会社名＋路線名＋駅名 串接，
 * 例如 `東急田園都市線用賀駅徒歩15分`、`ＪＲ中央線八王子駅バス14分住宅中央徒歩1～5分`。
 * 沒有字典就只能猜路線到哪裡結束——那正是要避免的事。
 */
const ENSEN_LINES: readonly string[] = [
  'ＪＲ京葉線', 'ＪＲ総武線', 'ＪＲ総武快速線', 'ＪＲ横須賀線', 'ＪＲ山手線',
  'ＪＲ京浜東北線', 'ＪＲ中央線', 'ＪＲ青梅線', 'ＪＲ五日市線', 'ＪＲ横浜線',
  'ＪＲ武蔵野線', 'ＪＲ埼京線', 'ＪＲ八高線', 'ＪＲ常磐線', 'ＪＲ南武線',
  '東武伊勢崎線', '東武大師線', '東武東上線',
  '京成線', '京成押上線', '京成成田スカイアクセス線',
  '西武池袋線', '西武有楽町線', '西武新宿線', '西武拝島線', '西武多摩湖線',
  '小田急小田原線', '小田急多摩線',
  '京王線', '京王高尾線', '京王相模原線', '京王井の頭線', '京王新線',
  '東急田園都市線', '東急東横線', '東急大井町線', '東急目黒線', '東急多摩川線',
  '東急池上線', '東急世田谷線',
  '京浜急行線', '京浜急行空港線',
  '東京メトロ銀座線', '東京メトロ丸ノ内線', '東京メトロ日比谷線', '東京メトロ東西線',
  '東京メトロ千代田線', '東京メトロ有楽町線', '東京メトロ半蔵門線', '東京メトロ南北線',
  '東京メトロ副都心線',
  '都営地下鉄浅草線', '都営地下鉄三田線', '都営地下鉄新宿線', '都営地下鉄大江戸線',
  'ゆりかもめ', '東京モノレール羽田線', 'りんかい線', '多摩都市モノレール',
  '都電荒川線', 'つくばエクスプレス線', '日暮里・舎人ライナー', '北総鉄道北総線',
];

/** 申込資格原文（2026-08-16 逐字）。外國人相關欄位的唯一出處。 */
const APPLY_RULE_URL = 'https://www.to-kousya.or.jp/chintai/rent/index.html';
const FOREIGNER_SRC =
  '（1）日本国内に居住している成年者の方　外国籍の方でもお申込みできます。'
  + `（${APPLY_RULE_URL} 2026-08-16 逐字）`;
const FOREIGNER_RAW =
  '（1）日本国内に居住している成年者の方　外国籍の方でもお申込みできます。'
  + '※外国籍の方の場合、お申込み時点での世帯員全員の住民票で区分、在留資格、'
  + '在留期間の満了日等を確認いたします。'
  + '（5）保証会社をご利用いただくか、連帯保証人を立てられる方';

/** 零費用通則原文（2026-08-16 逐字）。keyMoney／agencyFee／renewalFee 的唯一出處。 */
const NO_FEE_SRC =
  'JKK 官方：全物件が礼金・仲介手数料・更新料一切なし。'
  + '（https://www.to-kousya.or.jp/chintai/shitteru/charm/ 2026-08-16 逐字）';

/** 敷金０円の条件。敷金**不**因此變成 0，只是附註條件。 */
const DEPOSIT_ZERO_NOTE =
  '敷金０円の条件：株式会社オリコフォレントインシュアまたは一般財団法人東京公社住宅サービス'
  + '（らくらくスタート安心プラン）をご利用の場合、敷金はいただきません（敷金０円）。'
  + '表示の敷金額は当該プランを利用しない場合の額'
  + '（https://www.to-kousya.or.jp/chintai/shitteru/charm/）';

export const manifest: SourceManifest = {
  id: 'jkk',
  name: 'JKK東京（東京都住宅供給公社）',
  nameZh: 'JKK 東京（東京都住宅供給公社）',
  homepage: 'https://www.to-kousya.or.jp/chintai/',
  origin: 'https://jhomes.to-kousya.or.jp',
  transport: 'http',
  // 資料全部在 discover 階段經 POST 取得（詳情頁不是 GET 得到的 URL），
  // 執行器再 GET 一次只會拿到跳板頁。
  fetchMode: 'none',
  // 對方是公共機構的老系統，刻意壓到 5 秒。
  crawlDelayMs: 5000,
  capabilities: {
    provides: [
      'rent', 'adminFee', 'deposit', 'keyMoney', 'agencyFee', 'renewalFee',
      'layout', 'areaM2', 'floor', 'roomNo', 'isVacant', 'availableFrom',
      'contractType', 'contractMonths', 'stations',
      'yearBuilt', 'floorsAboveGround', 'totalUnits',
      'foreignerWelcomed', 'guarantorCompanyRequired',
    ],
    // 站上根本沒有的欄位。宣告出來，健康檢查才不會產生永遠 0% 的假警報。
    neverProvides: [
      'utilities', 'internet', 'otherMonthly',
      'depositNonRefundable', 'guarantorInitialFee', 'fireInsurance',
      'keyExchangeFee', 'contractFee', 'cleaningFeeUpfront', 'otherInitial',
      'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
      'furnished', 'minStayMonths', 'genderRestriction', 'ageLimitRaw', 'petsAllowed',
      'residenceCardRequired', 'japaneseRequired', 'guarantorPersonRequired',
      'structure', 'sourceUpdatedAt',
    ],
  },
  legal: {
    enabled: true,
    robotsCheckedAt: '2026-08-16',
    robotsSha256: null,
    tosReviewed: 'yes',
    notes:
      'https://www.to-kousya.or.jp/robots.txt 與 https://jhomes.to-kousya.or.jp/robots.txt '
      + '皆回 HTTP 404（回傳站內 404 HTML 頁）→ 兩台主機皆無 robots.txt，'
      + '無任何 Disallow、無 Crawl-delay。對方是公共機構的老式 servlet，自訂 5 秒間隔。'
      + 'サイトポリシー https://www.to-kousya.or.jp/site_p.html 第5條逐字：'
      + '「当サイトの内容について、私的使用又は引用等著作権法上認められた行為を除き、'
      + '当社に無断で転載等を行うことはできません。」'
      + '本站每筆房源均標示出處為 JKK東京 並連回原站的住宅詳細頁。'
      + '⚠️ 搜尋流程需要 session cookie 與表單內的 token（一般瀏覽器行為），'
      + '但無驗證碼、無登入、無 bot 偵測；若出現任一項，adapter 會直接停手並報錯。',
  },
};

// ── HTTP 層（Shift_JIS ＋ cookie ＋ POST ＋ 自備節流）────────────────────────

const SJIS = new TextDecoder('shift_jis');

type Session = {
  readonly jar: Map<string, string>;
  /** 最近一次回應的 HTML，供取用最新的 token／abcde。 */
  last: string;
};

function newSession(): Session {
  return { jar: new Map(), last: '' };
}

function absorbCookies(s: Session, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(';')[0] ?? '';
    const i = kv.indexOf('=');
    if (i > 0) s.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

/**
 * 紅線偵測。碰到驗證碼／WAF／403／429／要求登入就**停手並丟例外**，
 * 不重試、不改道——這些是「對方明示不要你自動存取」的訊號。
 */
function assertNotBlocked(url: string, status: number, body: string): void {
  if (status === 403 || status === 429 || status === 503) {
    throw new Error(`[jkk] ${url} 回 HTTP ${status}——視為對方拒絕自動存取，停止此來源`);
  }
  if (/recaptcha|g-recaptcha|hcaptcha|私はロボットではありません|画像認証|認証コードを入力/i.test(body)) {
    throw new Error(`[jkk] ${url} 出現驗證碼／人機驗證，依規定停手不繞過`);
  }
  if (/cloudflare|checking your browser|attention required|アクセスが制限/i.test(body)) {
    throw new Error(`[jkk] ${url} 出現 WAF／Cloudflare 阻擋頁，停手`);
  }
  if (/ログインしてください|ログインが必要|ユーザＩＤとパスワード/i.test(body)) {
    throw new Error(`[jkk] ${url} 要求登入，停手`);
  }
  // JKK 自己的錯誤頁（約 2.9KB）。出現代表流程走錯，不是資料，要大聲失敗。
  if (/ＪＫＫねっと：おわび|JKKねっと：おわび/.test(body)) {
    throw new Error(`[jkk] ${url} 回傳「JKKねっと：おわび」錯誤頁（${body.length} 字），流程中斷`);
  }
}

async function jkkRequest(
  s: Session,
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: string; readonly referer?: string },
): Promise<string> {
  await new Promise((r) => setTimeout(r, manifest.crawlDelayMs));
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (s.jar.size > 0) headers['Cookie'] = [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (init.method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (init.referer !== undefined) headers['Referer'] = init.referer;

  const res = await fetch(url, init.body === undefined
    ? { method: init.method, headers }
    : { method: init.method, headers, body: init.body });
  absorbCookies(s, res);
  const body = SJIS.decode(new Uint8Array(await res.arrayBuffer()));
  assertNotBlocked(url, res.status, body);
  if (!res.ok) throw new Error(`[jkk] ${url} 回 HTTP ${res.status}`);
  s.last = body;
  return body;
}

/** 蒐集一個 form 內所有 hidden input 的 name=value（後出現的覆蓋先出現的）。 */
export function hiddenParams(html: string, formName: string): URLSearchParams {
  const i = html.indexOf(`<form name="${formName}"`);
  const region = i < 0 ? html : html.slice(i);
  const q = new URLSearchParams();
  for (const tag of region.match(/<input[^>]*hidden[^>]*>/gi) ?? []) {
    const n = /name=['"]?([A-Za-z0-9_.]+)['"]?/i.exec(tag)?.[1];
    if (n === undefined) continue;
    q.set(n, /value=['"]([^'"]*)['"]/i.exec(tag)?.[1] ?? '');
  }
  return q;
}

/** 表單頁裡 `document.akiSearch.xyz.value="…"` 的一次性值，要回填到 hidden 欄位 `jklm`。 */
export function xyzToken(html: string, funcName: string): string {
  const i = html.indexOf(`function ${funcName}`);
  if (i < 0) return '';
  return /xyz\.value\s*=\s*"([0-9A-Fa-f]+)"/.exec(html.slice(i, i + 400))?.[1] ?? '';
}

/** 結果清單每一列的 `senPage('boshuNo','mskKbn','jyutakuCd','yusenKbn')`。 */
export type JkkRowKey = {
  readonly boshuNo: string; readonly mskKbn: string;
  readonly jyutakuCd: string; readonly yusenKbn: string;
};

export function parseResultRows(html: string): JkkRowKey[] {
  return [...html.matchAll(/senPage\('([^']*)','([^']*)','([^']*)','([^']*)'\)/g)].map((m) => ({
    boshuNo: m[1] ?? '', mskKbn: m[2] ?? '', jyutakuCd: m[3] ?? '', yusenKbn: m[4] ?? '',
  }));
}

/** 「3件が該当しました。」→ 3。查無物件時回 0。 */
export function parseHitCount(html: string): number {
  const t = html.replace(/<[^>]+>/g, ' ');
  const m = /([0-9０-９,]+)\s*件が該当しました/.exec(t);
  if (m?.[1] === undefined) return 0;
  const n = Number(toHalfWidth(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ── HTML → 結構化資料 ───────────────────────────────────────────────────────

function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '｜')
    .replace(/｜+/g, '｜')
    .replace(/[ \t\r\n]+/g, ' ');
}

function labelled(t: string, label: string, max = 40): string {
  const re = new RegExp(`${label}｜\\s*([^｜]{1,${max}}?)\\s*｜`);
  return re.exec(t)?.[1]?.trim() ?? '';
}

/**
 * 「交通」欄的一行 → Station。
 *
 * 格式是**無分隔符**的 会社名＋路線名＋駅名（＋バスN分 停留所名）＋徒歩N分。
 * 会社名有時會與路線名重複（`京王` + `京王線`、`多摩都市モノレール` + `多摩都市モノレール`），
 * 所以比對時允許路線名前面再多一段「自己的前綴」：
 *   `東急田園都市線用賀駅徒歩15分`                      → 東急田園都市線 ／ 用賀
 *   `京王京王線京王八王子駅バス24分住宅中央徒歩1～5分`   → 京王線 ／ 京王八王子
 *   `多摩都市モノレール多摩都市モノレール松が谷駅徒歩13～16分` → 多摩都市モノレール ／ 松が谷
 * 三者的駅名都經 JKK 自己的駅マスタ（akiyaEkiSelect）核對過，不是推測。
 */
export function parseJkkAccessLine(raw: string): Station | null {
  const line0 = raw.replace(/\s+/g, '');
  if (line0 === '' || !line0.includes('駅')) return null;

  let line = '';
  let rest = line0;
  let best = 0;
  for (const cand of ENSEN_LINES) {
    for (let k = cand.length; k >= 0; k--) {
      const prefix = cand.slice(0, k) + cand;
      if (prefix.length > best && line0.startsWith(prefix)) {
        best = prefix.length;
        line = cand;
        rest = line0.slice(prefix.length);
      }
    }
  }

  const stM = /^(.{1,20}?)駅/.exec(rest);
  const station = stM?.[1]?.trim() ?? '';
  if (station === '') return null;

  const tail = toHalfWidth(rest.slice(stM?.[0]?.length ?? 0));
  const bus = /バス\s*(\d+)\s*分/.exec(tail);
  const walk = /徒歩\s*(\d+)(?:\s*~\s*\d+)?\s*分/.exec(tail);
  const walkMin = walk?.[1] === undefined ? Number.NaN : Number(walk[1]);

  return {
    line,
    station,
    // 需先搭公車時，「徒歩N分」是從公車站走的距離，不是從車站——不可當步行距離用。
    walkMinutes: !Number.isFinite(walkMin)
      ? notListed(line0)
      : bus === null
        ? known(walkMin, 'measured', line0)
        : notListed(`${line0}（含公車 ${bus[1]} 分，徒歩分不代表從車站步行）`),
    rawText: line0,
  };
}

export function parseJkkAccess(t: string): readonly Station[] {
  const i = t.indexOf('交通｜');
  if (i < 0) return [];
  const j = t.indexOf('詳細情報', i);
  const seg = t.slice(i + '交通｜'.length, j < 0 ? i + 800 : j);
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const part of seg.split('｜')) {
    const st = parseJkkAccessLine(part);
    if (st === null) continue;
    const key = `${st.line}|${st.station}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(st);
  }
  return out;
}

/**
 * 「定借期限・期間」欄。只有兩種寫法：
 *   `定期借家契約ではありません` → 普通借家
 *   `3年間` / `5年間`            → 定期借家、期間 N 年
 *
 * 刻意**不用** jp-parse 的 parseContractType：它的 FIXED_TERM_RE 只看「定期借家」
 * 四個字，會把「定期借家契約ではありません」判成定期借家（2026-08-16 實測確認）。
 * 否定句是這個欄位的多數情況，判反了會讓「不綁約」的物件全部被標成綁約。
 */
export function parseTeishaku(raw: string): { type: ContractType; months: number | null } {
  const t = toHalfWidth(raw).replace(/\s+/g, '');
  if (t === '') return { type: 'unknown', months: null };
  if (/ではありません|ではない|対象外/.test(t)) return { type: 'ordinary', months: null };
  const y = /(\d+)年/.exec(t);
  if (y?.[1] !== undefined) {
    const n = Number(y[1]);
    if (Number.isFinite(n) && n > 0 && n <= 20) return { type: 'fixed_term', months: n * 12 };
  }
  const m = /(\d+)(?:ヶ月|か月|ヵ月|カ月)/.exec(t);
  if (m?.[1] !== undefined) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 240) return { type: 'fixed_term', months: n };
  }
  return { type: 'unknown', months: null };
}

export type JkkUnitRow = {
  readonly roomNo: string;
  readonly households: string;
  readonly unitType: string;
  readonly layout: string;
  readonly facing: string;
  readonly rentRaw: string;
  readonly depositRaw: string;
  readonly adminRaw: string;
  readonly address: string;
  readonly availableRaw: string;
  readonly areaRaw: string;
  readonly floorRaw: string;
  readonly equipment: readonly string[];
};

const UNIT_ANCHOR_RE = /<td width="90" rowspan="3" class="ListTXT\d">/g;
const UNIT_CELL_RE = /<td\b[^>]*class="ListTXT\d"[^>]*>([\s\S]*?)<\/td>/g;

function cellText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 住戸一覽表 → 每間房一列。
 *
 * 每間房佔 3 個 `<tr>`，第一格（間取り図，`width="90" rowspan="3"`）是穩定的起點錨。
 * 錨與錨之間固定有 13 個 class=ListTXT* 的格子，順序為
 *   部屋番号／申込世帯／住戸型式／間取り／向き／家賃／敷金／共益費／住所／入居可能日／床面積／階／設備
 * 欄位對位由表頭的 rowspan 逐格核對過（2026-08-16，5 個詳情頁 8 間房全中）。
 * 格數不等於 13 就丟例外——那代表版面改了，寧可大聲失敗也不要錯位輸出金額。
 */
export function parseJkkUnitRows(html: string): JkkUnitRow[] {
  const head = html.indexOf('>間取り図</td>');
  if (head < 0) return [];
  const region = html.slice(head);
  const anchors = [...region.matchAll(UNIT_ANCHOR_RE)];
  const out: JkkUnitRow[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a?.index === undefined) continue;
    const from = a.index + a[0].length;
    const to = anchors[i + 1]?.index ?? region.length;
    const block = region.slice(from, to);
    const cells = [...block.matchAll(UNIT_CELL_RE)].map((m) => cellText(m[1] ?? ''));
    if (cells.length !== 13) {
      throw new Error(
        `[jkk] 住戸列格數異常：第 ${i + 1} 間得到 ${cells.length} 格（預期 13）——版面可能改版，停止解析`,
      );
    }
    const equipment = [...block.matchAll(/<img[^>]*alt="([^"]+)"/g)]
      .map((m) => m[1] ?? '').filter((s) => s !== '');
    out.push({
      roomNo: cells[0] ?? '', households: cells[1] ?? '', unitType: cells[2] ?? '',
      layout: cells[3] ?? '', facing: cells[4] ?? '', rentRaw: cells[5] ?? '',
      depositRaw: cells[6] ?? '', adminRaw: cells[7] ?? '', address: cells[8] ?? '',
      availableRaw: cells[9] ?? '', areaRaw: cells[10] ?? '', floorRaw: cells[11] ?? '',
      equipment,
    });
  }
  return out;
}

export type JkkDetail = {
  readonly name: string;
  readonly kindRaw: string;
  readonly mskKbn: string;
  readonly yusen: string;
  readonly totalUnitsRaw: string;
  readonly floorsRaw: string;
  readonly teishakuRaw: string;
  readonly builtRaw: string;
  readonly stations: readonly Station[];
  readonly remarks: string;
  readonly publicUrl: string;
  readonly units: readonly JkkUnitRow[];
};

export function parseJkkDetail(html: string): JkkDetail | null {
  const t = text(html);
  const name = labelled(t, '住宅名', 60);
  if (name === '') return null;
  const remarksSeg = (() => {
    const i = t.indexOf('特記事項｜');
    if (i < 0) return '';
    const j = t.indexOf('間取り図', i);
    return t.slice(i + '特記事項｜'.length, j < 0 ? i + 900 : j)
      .replace(/｜/g, ' ').replace(/\s+/g, ' ').trim();
  })();
  return {
    name,
    kindRaw: labelled(t, '住宅種別', 40),
    mskKbn: labelled(t, '申込区分', 20),
    yusen: labelled(t, '優先募集種別', 30),
    totalUnitsRaw: labelled(t, '総戸数', 12),
    floorsRaw: labelled(t, '階層', 20),
    teishakuRaw: labelled(t, '定借期限[・･]期間', 30),
    builtRaw: labelled(t, '竣工年月日', 20),
    stations: parseJkkAccess(t),
    remarks: remarksSeg,
    publicUrl: (/openTizuFile\('([^']+)'/.exec(html)?.[1] ?? '').replace(/#map$/, ''),
    units: parseJkkUnitRows(html),
  };
}

// ── Field 組裝 ──────────────────────────────────────────────────────────────

function moneyField(raw: string, label: string): Field<Yen> {
  const cleaned = raw.trim();
  if (cleaned === '' || cleaned === '-') return notListed(cleaned);
  const r = parseMoney(`${cleaned}円`);
  switch (r.kind) {
    case 'amount': return known(yen(r.jpy), 'measured', `${label} ${cleaned}円`);
    case 'zero': return known(yen(0), 'measured', `${label} ${cleaned}`);
    case 'absent': return notListed(cleaned);
    case 'negotiable': return notListed(cleaned);
    default: return unparsed(`${label} ${cleaned}`);
  }
}

/** `東京都` 前綴與市区町村。`世田谷区上用賀四丁目…` → ward=世田谷区 */
export function splitWard(address: string): { addressRaw: string; ward: string } | null {
  const a = address.replace(/\s+/g, '');
  const m = /^(?:東京都)?([^\s]{1,6}?[区市町村])/.exec(a);
  if (m?.[1] === undefined) return null;
  return { addressRaw: a.startsWith('東京都') ? a : `東京都${a}`, ward: m[1] };
}

function availableField(raw: string): Field<string> {
  const v = toHalfWidth(raw).replace(/\s+/g, '');
  if (v === '') return notListed('');
  if (/即入居可/.test(v)) return known('随時', 'measured', `入居可能日 ${raw}`);
  const d = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(v);
  if (d !== null) return known(`${d[1]}-${d[2]}-${d[3]}`, 'measured', `入居可能日 ${raw}`);
  return notListed(raw);
}

function foreignerPolicy(remarks: string): ForeignerPolicy {
  // 全站申込資格是「保証会社をご利用いただくか、連帯保証人を立てられる方」——兩者擇一，
  // 所以保証会社「必須」只在該住宅的特記事項明寫時才成立。
  const mustCompany = /保証会社の利用が必須|保証会社のご利用が必須|保証会社利用必須/.exec(remarks);
  return {
    welcomed: known(true, 'measured', FOREIGNER_SRC),
    residenceCardRequired: notOffered<boolean>(),
    japaneseRequired: notOffered<boolean>(),
    guarantorCompanyRequired: mustCompany === null
      ? notListed('申込資格は「保証会社をご利用いただくか、連帯保証人を立てられる方」——両者択一')
      : known(true, 'measured', `特記事項：${mustCompany[0]}`),
    guarantorPersonRequired: notOffered<boolean>(),
    rawText: FOREIGNER_RAW,
  };
}

function buildUnit(buildingId: string, sourceUrl: string, d: JkkDetail, r: JkkUnitRow): Unit {
  const area = parseArea(`${toHalfWidth(r.areaRaw)}m2`);
  const layout = parseLayout(r.layout);
  const floorN = Number(toHalfWidth(r.floorRaw).replace(/[^\d]/g, ''));
  const teishaku = parseTeishaku(d.teishakuRaw);
  const zero = (): Field<Yen> => known(yen(0), 'measured', NO_FEE_SRC);

  const notes = [DEPOSIT_ZERO_NOTE];
  if (d.yusen !== '') notes.push(`優先募集種別：${d.yusen}`);
  if (d.kindRaw !== '') notes.push(`住宅種別：${d.kindRaw}`);
  if (r.unitType !== '') notes.push(`住戸型式：${r.unitType}`);
  if (r.facing !== '') notes.push(`建物向き：${r.facing}`);
  if (r.households !== '') notes.push(`申込世帯[人]：${r.households}`);
  if (r.equipment.length > 0) notes.push(`設備：${r.equipment.join('、')}`);
  if (d.remarks !== '') notes.push(`特記事項：${d.remarks}`);

  return {
    id: `${buildingId}#${r.roomNo}`,
    buildingId,
    unitKey: r.roomNo,
    sourceUrl,
    roomNo: known(r.roomNo, 'measured', `部屋番号 ${r.roomNo}`),
    layout: layout.kind === 'rooms'
      ? known(layout.canonical, 'measured', `間取り ${r.layout}`)
      : r.layout === '' ? notListed('') : unparsed(`間取り ${r.layout}`),
    areaM2: area.kind === 'exact'
      ? known(area.m2, 'measured', `床面積 ${r.areaRaw}m2`)
      : r.areaRaw === '' ? notListed('') : unparsed(`床面積 ${r.areaRaw}`),
    floor: Number.isInteger(floorN) && floorN > 0
      ? known(floorN, 'measured', `階 ${r.floorRaw}`)
      : r.floorRaw === '' ? notListed('') : unparsed(`階 ${r.floorRaw}`),
    monthly: {
      rent: moneyField(r.rentRaw, '家賃'),
      adminFee: moneyField(r.adminRaw, '共益費'),
      utilities: notOffered<Yen>(),
      internet: notOffered<Yen>(),
      otherMonthly: notOffered<Yen>(),
    },
    initial: {
      keyMoney: zero(),
      // 敷金**只讀該欄的實際金額**。空白時是未知，不是 0——
      // 「敷金０円」是條件性優惠（見 DEPOSIT_ZERO_NOTE），不能拿來當預設值。
      deposit: moneyField(r.depositRaw, '敷金'),
      depositNonRefundable: notOffered<Yen>(),
      agencyFee: zero(),
      guarantorInitialFee: notOffered<Yen>(),
      fireInsurance: notOffered<Yen>(),
      keyExchangeFee: notOffered<Yen>(),
      contractFee: notOffered<Yen>(),
      cleaningFeeUpfront: notOffered<Yen>(),
      otherInitial: notOffered<Yen>(),
    },
    deferred: {
      renewalFee: zero(),
      renewalAdminFee: notOffered<Yen>(),
      cleaningFeeOnExit: notOffered<Yen>(),
      earlyTerminationPenalty: notOffered<Yen>(),
    },
    // 站上沒有任何「光熱費込み／別途」的記載，不臆測。
    utilitiesBasis: 'unknown',
    furnished: notOffered<boolean>(),
    availableFrom: availableField(r.availableRaw),
    isVacant: known(true, 'measured', '出現在「先着順あき家」搜尋結果中'),
    contractType: teishaku.type,
    contractMonths: teishaku.months === null
      ? notListed(d.teishakuRaw)
      : known(teishaku.months, 'measured', `定借期限・期間 ${d.teishakuRaw}`),
    minStayMonths: notOffered<number>(),
    genderRestriction: 'unknown',
    ageLimitRaw: notOffered<string>(),
    petsAllowed: notOffered<boolean>(),
    foreigner: foreignerPolicy(d.remarks),
    notes,
  };
}

// ── discover / extract ──────────────────────────────────────────────────────

/** 跳板頁 → 搜尋條件表單。 */
async function openSearchForm(s: Session): Promise<string> {
  const jump = await jkkRequest(s, START, { method: 'GET' });
  const q = new URLSearchParams();
  for (const tag of jump.match(/<input[^>]*>/gi) ?? []) {
    const n = /name=['"]?([A-Za-z0-9_.]+)['"]?/i.exec(tag)?.[1];
    if (n === undefined) continue;
    q.set(n, /value=['"]([^'"]*)['"]/i.exec(tag)?.[1] ?? '');
  }
  const next = q.get('url');
  if (next === null || !next.startsWith('https://jhomes.to-kousya.or.jp/')) {
    throw new Error(`[jkk] 跳板頁沒有可用的 forwardForm.url（得到 ${JSON.stringify(next)}）`);
  }
  const form = await jkkRequest(s, next, { method: 'POST', body: q.toString(), referer: START });
  if (!form.includes('<form name="akiSearch"')) {
    throw new Error(`[jkk] POST 跳板後拿到的不是搜尋條件表單（${form.length} 字）`);
  }
  return form;
}

/** 送出条件檢索並翻頁，回傳所有列的 key 與最後一頁的 HTML（供取用最新 token）。 */
async function searchWards(s: Session, form: string): Promise<{ rows: JkkRowKey[]; lastHtml: string }> {
  const q = new URLSearchParams();
  const region = form.slice(form.indexOf('<form name="akiSearch"'));
  for (const tag of region.match(/<input[^>]*>/gi) ?? []) {
    const n = /name=['"]?([A-Za-z0-9_.]+)['"]?/i.exec(tag)?.[1];
    if (n === undefined) continue;
    const type = (/type=['"]?([A-Za-z]+)/i.exec(tag)?.[1] ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') continue;
    q.append(n, /value=['"]([^'"]*)['"]/i.exec(tag)?.[1] ?? '');
  }
  q.set('jklm', xyzToken(form, 'submitPage'));
  for (const w of WARD_CODES) q.append('akiyaInitRM.akiyaRefM.checks', w);

  let html = await jkkRequest(s, `${BASE}/akiyaJyoukenRef`, {
    method: 'POST', body: q.toString(), referer: START,
  });
  const total = parseHitCount(html);
  if (total === 0) return { rows: [], lastHtml: html };

  // 一頁 50 筆，把翻頁次數壓到最低（對方是老系統）。
  const wide = hiddenParams(html, 'frmMain');
  wide.set('akiyaRefRM.showCount', '50');
  html = await jkkRequest(s, `${BASE}/AKIYAchangeCount`, {
    method: 'POST', body: wide.toString(), referer: `${BASE}/akiyaJyoukenRef`,
  });

  const rows: JkkRowKey[] = [];
  const seen = new Set<string>();
  const push = (h: string): number => {
    let added = 0;
    for (const r of parseResultRows(h)) {
      const k = `${r.mskKbn}|${r.jyutakuCd}|${r.yusenKbn}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
      added += 1;
    }
    return added;
  };
  push(html);
  for (let page = 1; page < 40 && rows.length < total; page++) {
    const next = hiddenParams(html, 'frmMain');
    html = await jkkRequest(s, `${BASE}/AKIYAafterPage`, {
      method: 'POST', body: next.toString(), referer: `${BASE}/akiyaJyoukenRef`,
    });
    if (push(html) === 0) break;
  }
  if (rows.length < total) {
    console.warn(`  ⚠ jkk：宣稱 ${total} 件但只列舉到 ${rows.length} 件，翻頁可能中斷`);
  }
  return { rows, lastHtml: html };
}

async function fetchDetail(s: Session, listHtml: string, r: JkkRowKey): Promise<string> {
  const q = hiddenParams(listHtml, 'frmMain');
  q.set('jklm', xyzToken(listHtml, 'senPage'));
  q.set('akiyaRefRM.akiyaDatM.boshuNo', r.boshuNo);
  q.set('akiyaRefRM.akiyaDatM.mskKbn', r.mskKbn);
  q.set('akiyaRefRM.akiyaDatM.jyutakuCd', r.jyutakuCd);
  q.set('akiyaRefRM.akiyaDatM.yusenKbn', r.yusenKbn);
  return jkkRequest(s, `${BASE}/akiyaSenDet`, {
    method: 'POST', body: q.toString(), referer: `${BASE}/akiyaJyoukenRef`,
  });
}

export const adapter: SourceAdapter = {
  manifest,

  async *discover(_ctx: ExtractContext, _fetcher: Fetcher): AsyncGenerator<TargetRef> {
    const s = newSession();
    const form = await openSearchForm(s);
    const { rows, lastHtml } = await searchWards(s, form);

    // 同一棟住宅（jyutakuCd）會因為申込区分／優先種別不同而拆成多列，
    // 合併成一個 Building，房間再依部屋番号去重。
    const byBuilding = new Map<string, JkkRowKey[]>();
    for (const r of rows) {
      const list = byBuilding.get(r.jyutakuCd) ?? [];
      list.push(r);
      byBuilding.set(r.jyutakuCd, list);
    }

    for (const [jyutakuCd, group] of byBuilding) {
      const details: string[] = [];
      for (const r of group) details.push(await fetchDetail(s, lastHtml, r));
      const first = parseJkkDetail(details[0] ?? '');
      if (first === null) continue;
      yield {
        url: first.publicUrl === '' ? START : first.publicUrl,
        hint: { jyutakuCd, details } as unknown as Record<string, unknown>,
      };
    }
  },

  extract(raw: RawDoc, ref: TargetRef, _ctx: ExtractContext): Listing | null {
    const jyutakuCd = ref.hint?.['jyutakuCd'];
    const details = ref.hint?.['details'];
    if (typeof jyutakuCd !== 'string' || !Array.isArray(details)) return null;

    const parsed = details
      .filter((h): h is string => typeof h === 'string')
      .map((h) => parseJkkDetail(h))
      .filter((d): d is JkkDetail => d !== null);
    if (parsed.length === 0) return null;

    const head = parsed[0];
    if (head === undefined) return null;
    const firstUnit = parsed.flatMap((d) => d.units)[0];
    if (firstUnit === undefined) return null;
    const addr = splitWard(firstUnit.address);
    if (addr === null) return null;

    const buildingId = `jkk:${jyutakuCd}`;
    const sourceUrl = head.publicUrl === '' ? START : head.publicUrl;
    const totalUnits = Number(toHalfWidth(head.totalUnitsRaw).replace(/[^\d]/g, ''));
    // 「地上４階建」。地下階數（あれば「地下1階付」）刻意不併入——floorsAboveGround 只算地上。
    const floors = Number(/地上(\d+)階/.exec(toHalfWidth(head.floorsRaw))?.[1] ?? '');
    const builtYear = parseYearBuilt(head.builtRaw);

    const building: Building = {
      id: buildingId,
      sourceId: 'jkk',
      sourceKey: jyutakuCd,
      sourceUrl,
      name: head.name,
      kind: 'apartment',
      addressRaw: addr.addressRaw,
      prefecture: '東京都',
      ward: addr.ward,
      stations: head.stations,
      structure: notOffered<string>(),
      yearBuilt: builtYear === null
        ? notListed(head.builtRaw)
        : known(builtYear, 'measured', `竣工年月日 ${head.builtRaw}`),
      floorsAboveGround: Number.isInteger(floors) && floors > 0
        ? known(floors, 'measured', `階層 ${head.floorsRaw}`)
        : notListed(head.floorsRaw),
      totalUnits: Number.isInteger(totalUnits) && totalUnits > 0
        ? known(totalUnits, 'measured', `総戸数 ${head.totalUnitsRaw}`)
        : notListed(head.totalUnitsRaw),
      imageUrls: [],
      fetchedAt: raw.fetchedAt,
      sourceUpdatedAt: notOffered<string>(),
      htmlSha256: raw.sha256,
    };

    const units: Unit[] = [];
    const seenRooms = new Set<string>();
    for (const d of parsed) {
      for (const r of d.units) {
        if (r.roomNo === '' || seenRooms.has(r.roomNo)) continue;
        seenRooms.add(r.roomNo);
        units.push(buildUnit(buildingId, sourceUrl, d, r));
      }
    }
    if (units.length === 0) return null;
    return { building, units };
  },
};

export default adapter;
