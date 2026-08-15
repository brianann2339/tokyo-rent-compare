/**
 * 日文金額解析。
 *
 * 設計原則：解不出來就回 unparsed，絕不猜。
 * 特別是「なし」「応相談」「-」三者必須嚴格區分：
 *   なし   → 真實的 0（有來源依據）
 *   応相談 → 未知（不是 0！誤判成 0 就是虛構）
 *   -      → 頁面沒寫（未知）
 */

import { norm, isExplicitZero, isNegotiable, isBlankPlaceholder, statesIncluded } from './text.ts';

export type MoneyResult =
  | { readonly kind: 'amount'; readonly jpy: number }
  | { readonly kind: 'zero' }              // 明寫「なし／無料／0円」
  | { readonly kind: 'included' }          // 明寫「込み」→ 這一項為 0 且有依據
  | { readonly kind: 'months'; readonly months: number }  // 「賃料1ヶ月分」，需乘上賃料才成金額
  | { readonly kind: 'negotiable' }        // 応相談：明確未定
  | { readonly kind: 'absent' }            // 頁面沒寫
  | { readonly kind: 'unparsed' };         // 有文字但解不出來 ← 唯一的故障訊號

const MAN_RE = /(\d+(?:\.\d+)?)\s*万\s*円?/;                       // 8.5万円
const YEN_RE = /(?:¥|￥)?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円/;         // 68,000円
const BARE_YEN_SYMBOL_RE = /(?:¥|￥)\s*(\d{1,3}(?:,\d{3})+|\d+)/;   // ￥95,000
const MONTHS_RE = /(\d+(?:\.\d+)?)\s*(?:ヶ月|か月|ヵ月|カ月|ケ月|か月分|月分)/;

function digits(s: string): number {
  return Number(s.replace(/,/g, ''));
}

/**
 * 解析單一金額字串。
 *
 * 順序有意義：先判斷「含む」與「なし」這類語義標記，再抽數字。
 * 否則「礼金なし（0円）」會被抽成 amount 0，丟失「這是明確聲明」的資訊。
 */
export function parseMoney(input: string): MoneyResult {
  const raw = norm(input);
  if (isBlankPlaceholder(raw)) return { kind: 'absent' };

  // 「別途」「実費」等：明確表示要另外付但沒給金額 → 未知，不可當 0
  if (isNegotiable(raw)) return { kind: 'negotiable' };

  // 「込み」：這一項含在別的費用裡 → 金額 0 且有依據
  if (statesIncluded(raw) && !/\d/.test(raw)) return { kind: 'included' };

  // 「賃料1ヶ月分」：是倍數不是金額，必須交給呼叫端乘上賃料
  const m = MONTHS_RE.exec(raw);
  if (m?.[1] !== undefined) {
    const months = Number(m[1]);
    if (Number.isFinite(months)) return { kind: 'months', months };
  }

  // 「なし／無料／不要」：真實的 0
  if (isExplicitZero(raw)) return { kind: 'zero' };

  const man = MAN_RE.exec(raw);
  if (man?.[1] !== undefined) {
    const v = Number(man[1]) * 10_000;
    if (Number.isFinite(v)) return { kind: 'amount', jpy: Math.round(v) };
  }

  const y = YEN_RE.exec(raw);
  if (y?.[1] !== undefined) {
    const v = digits(y[1]);
    if (Number.isFinite(v)) return v === 0 ? { kind: 'zero' } : { kind: 'amount', jpy: v };
  }

  const sym = BARE_YEN_SYMBOL_RE.exec(raw);
  if (sym?.[1] !== undefined) {
    const v = digits(sym[1]);
    if (Number.isFinite(v)) return v === 0 ? { kind: 'zero' } : { kind: 'amount', jpy: v };
  }

  return { kind: 'unparsed' };
}

export type MoneyRange = {
  readonly minJpy: number;
  readonly maxJpy: number;
};

/**
 * 解析「￥55,000 - 59,000」「5.5万円～6.2万円」這類區間。
 * share house 的列表頁大量使用這種寫法。
 */
export function parseMoneyRange(input: string): MoneyRange | null {
  const raw = norm(input);
  const parts = raw.split(/\s*(?:~|-|から|より)\s*/).filter((p) => p.trim() !== '');
  if (parts.length < 2) return null;

  const first = parseMoney(parts[0] ?? '');
  if (first.kind !== 'amount') return null;

  // 「￥55,000 - 59,000」的後半沒有円字，需要補上單位再解析
  const secondRaw = parts[1] ?? '';
  const second = parseMoney(/[円万¥￥]/.test(secondRaw) ? secondRaw : `${secondRaw}円`);
  if (second.kind !== 'amount') return null;

  const lo = Math.min(first.jpy, second.jpy);
  const hi = Math.max(first.jpy, second.jpy);
  return { minJpy: lo, maxJpy: hi };
}

/**
 * 把「賃料N ヶ月分」換算成金額。
 * 呼叫端必須自己確認 rentJpy 是已知的——這裡不接受 null，
 * 就是為了不讓「賃料未知但礼金 1 個月」變成一個編出來的數字。
 */
export function monthsToYen(months: number, rentJpy: number): number {
  return Math.round(months * rentJpy);
}
