/**
 * 契約條件解析：綁約、最短居住期間、解約違約金、築年。
 *
 * 這一組是使用者特別指定的篩選需求（「是否綁約」）。
 * 但要注意：這些欄位在日本租屋網上常寫在自由文字的備考欄，
 * 甚至根本不寫——填充率可能很低，Phase 0 的探針就是要量這件事。
 */

import { norm } from './text.ts';

const FIXED_TERM_RE = /定期借家|定期建物賃貸借|fixed-?term/i;
const ORDINARY_RE = /普通借家|普通建物賃貸借/;
const CONTRACT_YEARS_RE = /(?:契約期間|契約)\s*[:：]?\s*(\d+)\s*年/;
const CONTRACT_MONTHS_RE = /(?:契約期間|契約)\s*[:：]?\s*(\d+)\s*(?:ヶ月|か月|ヵ月|カ月)/;
const MIN_STAY_RE = /(?:最低|最短)(?:契約|利用|入居|居住)?期間\s*[:：]?\s*(\d+)\s*(?:ヶ月|か月|ヵ月|カ月|年)(?:以上)?/;
const MIN_STAY_EN_RE = /minimum\s+of\s+(\d+)\s*(month|year)/i;

export type ContractTypeResult = 'ordinary' | 'fixed_term' | 'unknown';

export function parseContractType(input: string): ContractTypeResult {
  const t = norm(input);
  if (FIXED_TERM_RE.test(t)) return 'fixed_term';
  if (ORDINARY_RE.test(t)) return 'ordinary';
  return 'unknown';
}

/** 契約期間（月）。年會換算成月。 */
export function parseContractMonths(input: string): number | null {
  const t = norm(input);
  const y = CONTRACT_YEARS_RE.exec(t);
  if (y?.[1] !== undefined) {
    const v = Number(y[1]);
    if (Number.isFinite(v) && v > 0 && v <= 20) return v * 12;
  }
  const m = CONTRACT_MONTHS_RE.exec(t);
  if (m?.[1] !== undefined) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 240) return v;
  }
  return null;
}

/** 最低居住期間（月）。 */
export function parseMinStayMonths(input: string): number | null {
  const t = norm(input);
  const m = MIN_STAY_RE.exec(t);
  if (m?.[1] !== undefined) {
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    return /年/.test(m[0]) ? v * 12 : v;
  }
  const e = MIN_STAY_EN_RE.exec(t);
  if (e?.[1] !== undefined && e[2] !== undefined) {
    const v = Number(e[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    return /year/i.test(e[2]) ? v * 12 : v;
  }
  return null;
}

/**
 * 短期解約違約金。
 * Village House 的寫法：「1年未満の解約は3ヵ月分、2年未満の解約は2ヵ月分」
 * 這是「零初期費用」宣傳底下的真實成本，漏抓會誤導使用者。
 */
export type EarlyTerminationRule = {
  readonly beforeMonths: number;   // 未滿幾個月
  readonly penaltyMonths: number;  // 賠幾個月租金
};

const EARLY_TERM_RE = /(\d+)\s*(?:年|ヶ月|か月|ヵ月|カ月)未満の?解約は?(?:賃料)?(\d+)\s*(?:ヶ月|か月|ヵ月|カ月)分/g;

export function parseEarlyTermination(input: string): readonly EarlyTerminationRule[] {
  const t = norm(input);
  const out: EarlyTerminationRule[] = [];
  for (const m of t.matchAll(EARLY_TERM_RE)) {
    const beforeRaw = Number(m[1]);
    const penalty = Number(m[2]);
    if (!Number.isFinite(beforeRaw) || !Number.isFinite(penalty)) continue;
    const beforeMonths = /年未満/.test(m[0]) ? beforeRaw * 12 : beforeRaw;
    out.push({ beforeMonths, penaltyMonths: penalty });
  }
  return out.sort((a, b) => a.beforeMonths - b.beforeMonths);
}

const YEAR_BUILT_RE = /(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?\s*築?/;
const YEAR_SLASH_RE = /(\d{4})\/(\d{1,2})/;
const AGE_YEARS_RE = /築\s*(\d+)\s*年/;

/** 築年。「築15年」需要基準年才能換算，所以要傳入 now。 */
export function parseYearBuilt(input: string, now: Date = new Date()): number | null {
  const t = norm(input);
  const y = YEAR_BUILT_RE.exec(t);
  if (y?.[1] !== undefined) {
    const v = Number(y[1]);
    if (Number.isFinite(v) && v >= 1900 && v <= now.getFullYear()) return v;
  }
  const s = YEAR_SLASH_RE.exec(t);
  if (s?.[1] !== undefined) {
    const v = Number(s[1]);
    if (Number.isFinite(v) && v >= 1900 && v <= now.getFullYear()) return v;
  }
  const a = AGE_YEARS_RE.exec(t);
  if (a?.[1] !== undefined) {
    const age = Number(a[1]);
    if (Number.isFinite(age) && age >= 0 && age <= 150) return now.getFullYear() - age;
  }
  return null;
}

const FEMALE_ONLY_RE = /女性(専用|限定|のみ|専門)|女性専用|female\s*only/i;
const MALE_ONLY_RE = /男性(専用|限定|のみ)|male\s*only/i;
const MIXED_RE = /男女|男性・女性|男性,\s*女性|mixed|co-?ed/i;

export type GenderResult = 'female_only' | 'male_only' | 'mixed' | 'unknown';

/** 自由文字用：必須有「専用／限定／のみ」等明確字樣才判定，避免「女性に人気」被誤讀。 */
export function parseGender(input: string): GenderResult {
  const t = norm(input);
  if (FEMALE_ONLY_RE.test(t)) return 'female_only';
  if (MALE_ONLY_RE.test(t)) return 'male_only';
  if (MIXED_RE.test(t)) return 'mixed';
  return 'unknown';
}

/**
 * 標籤列用：ひつじ的 `tenancyConditionDescription`（例「女性 外国人歓迎」「男性・女性募集中」）
 * 與 Tokyo Sharehouse 的「入居条件」欄，是**募集對象的標籤列**而非自由文字，
 * 所以裸的「女性」就代表只收女性。
 *
 * 這個判定只在明確知道欄位是標籤列時才可使用——不要拿去解析自由文字，
 * 否則「女性に人気のエリア」會被讀成女性專用。
 */
export function parseGenderTags(input: string): GenderResult {
  const t = norm(input);
  const explicit = parseGender(t);
  if (explicit !== 'unknown') return explicit;
  const hasFemale = /女性/.test(t);
  const hasMale = /男性/.test(t);
  if (hasFemale && hasMale) return 'mixed';
  if (hasFemale) return 'female_only';
  if (hasMale) return 'male_only';
  return 'unknown';
}

/**
 * 外國人相關條件。各站寫法差異極大，這裡只抓「有沒有提到」，
 * 不對「這樣算不算歡迎外國人」下判斷——原文一律保留供使用者自己看。
 */
export type ForeignerSignals = {
  readonly welcomed: boolean | null;
  readonly residenceCard: boolean | null;
  readonly japanese: boolean | null;
  readonly guarantorCompany: boolean | null;
  readonly guarantorPerson: boolean | null;
};

export function parseForeignerSignals(input: string): ForeignerSignals {
  const t = norm(input);
  const mentionsForeigner = /外国人|外国籍|foreign/i.test(t);
  return {
    welcomed: /外国人歓迎|外国籍の方.{0,10}(可|歓迎|できます)|foreigners?\s*welcome/i.test(t)
      ? true
      : mentionsForeigner
        ? null
        : null,
    residenceCard: /在留カード|在留資格|外国人登録|residence\s*card|passport|パスポート/i.test(t) ? true : null,
    japanese: /日本語(の読み書き|が話せる|日常会話)|日常会話程度の日本語/.test(t) ? true : null,
    guarantorCompany: /保証会社(の利用は)?(必須|加入必須|必要)|保証会社へ加入/.test(t)
      ? true
      : /保証会社(不要|なし|ナシ)/.test(t)
        ? false
        : null,
    guarantorPerson: /連帯保証人(が)?(必要|必須)/.test(t)
      ? true
      : /保証人(不要|なし|ナシ)|連帯保証人(不要|なし)/.test(t)
        ? false
        : null,
  };
}
