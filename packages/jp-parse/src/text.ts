/**
 * 文字正規化。日本租屋網站在全形／半形、「込み」的寫法變體上完全沒有統一標準，
 * 所有解析都必須先過這一層，否則會漏掉大量合法寫法。
 */

/** 全形英數 → 半形；全形空白 → 半形空白。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    // 注意：這裡刻意**不含** U+30FC「ー」（片假名長音符）。
    // 把它當成連字號會讓「在留カード」→「在留カ-ド」、「パスポート」→「パスポ-ト」，
    // 所有含長音的片假名詞彙全毀。只轉真正的連字號與減號。
    .replace(/[－―‐−]/g, '-')
    .replace(/[～〜]/g, '~')
    .replace(/[，]/g, ',')
    .replace(/[．]/g, '.');
}

/** 壓縮空白、去除前後空白。 */
export function squish(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 解析前的標準前處理。 */
export function norm(s: string): string {
  return squish(toHalfWidth(s));
}

/**
 * 「沒有這筆費用」的日文寫法。
 * 注意：這與「頁面上沒寫」是兩件不同的事——這裡是明確寫了「不用付」，
 * 所以值是真實的 0，不是未知。
 */
const ZERO_TOKENS = [
  'なし', '無し', 'ナシ', '不要', '無料', 'ゼロ',
  'かかりません', '頂きません', 'いただきません',
] as const;

/** 全形／半形的純零金額：`0`、`0円`、`¥0`、`0 yen`。 */
const NUMERIC_ZERO_RE = /^(?:¥|￥)?0+(?:円|yen)?$/i;
/** 英文的零，需要詞界，否則 'no' 會命中一堆無關字串。 */
const ENGLISH_ZERO_RE = /^(?:free|none|no|not\s+required)$/i;

export function isExplicitZero(s: string): boolean {
  const t = norm(s).replace(/\s/g, '');
  if (t === '') return false;
  // 純數字零必須整串相符——用 includes 會讓「6,500円」因為含「0円」而被判成零。
  if (NUMERIC_ZERO_RE.test(t)) return true;
  if (ENGLISH_ZERO_RE.test(norm(s))) return true;
  return ZERO_TOKENS.some((z) => t.includes(z));
}

/**
 * 「要另外談／看情況」——這是明確的「未定」，不是 0，也不是解析失敗。
 * 誤判成 0 會直接造成虛構數字。
 */
const NEGOTIABLE_TOKENS = ['応相談', '要相談', '相談', '別途', '実費', 'お問い合わせ', '要問合せ', '要確認'] as const;

export function isNegotiable(s: string): boolean {
  const t = norm(s).replace(/\s/g, '');
  return NEGOTIABLE_TOKENS.some((z) => t.includes(z));
}

/** 空值佔位符：`-`、`—`、`ー`、`ー`、`‐`、空字串。 */
export function isBlankPlaceholder(s: string): boolean {
  const t = norm(s).replace(/\s/g, '');
  return t === '' || /^[-‐–—ー−]+$/.test(t);
}

/**
 * 「含在別的費用裡」的寫法變體。
 * 這些是我從 SUUMO／HOME'S／オークハウス／Yahoo!不動産 的實際檢索頁觀察到的，
 * 不是官方標準用語表——日本對這類欄位沒有法定統一寫法。
 */
const INCLUDED_PATTERNS = [
  /込み?$/, /込$/, /こみ$/, /込みです/, /に含む/, /を含む/, /含まれ/, /included/i,
] as const;

export function statesIncluded(s: string): boolean {
  const t = norm(s).replace(/\s/g, '');
  return INCLUDED_PATTERNS.some((p) => p.test(t));
}

/** 水電（光熱費）含在月額內的寫法變體。 */
const UTILITIES_INCLUDED_RE =
  /(水道)?光熱費(を?含|込み?|こみ)|水道光熱費込|光熱費込|水道代込|電気代込|ガス代込|家賃に(水道)?光熱費|utilities?\s*(are\s*)?included|水道・?電気・?ガス.{0,6}(込|含)/i;

export function statesUtilitiesIncluded(s: string): boolean {
  return UTILITIES_INCLUDED_RE.test(toHalfWidth(s));
}

const UTILITIES_EXCLUDED_RE = /光熱費(は)?別途|水道光熱費(は)?別途|光熱費(は)?実費|電気・?ガス・?水道は.{0,4}別/;

export function statesUtilitiesExcluded(s: string): boolean {
  return UTILITIES_EXCLUDED_RE.test(toHalfWidth(s));
}

/** 附傢俱的寫法變體。 */
const FURNISHED_RE = /家具家?電?付き?|家具・家電付|家具付|furnished/i;
const NOT_FURNISHED_RE = /家具は?(含まれません|付きません|なし)|家具・家電な?し|unfurnished/i;

export function statesFurnished(s: string): boolean | null {
  const t = toHalfWidth(s);
  if (NOT_FURNISHED_RE.test(t)) return false;
  if (FURNISHED_RE.test(t)) return true;
  return null;
}
