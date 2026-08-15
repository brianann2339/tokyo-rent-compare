/**
 * 面積解析。
 *
 * 關鍵事實：1帖 = 1.62㎡「以上」（不動産の表示に関する公正競争規約施行規則 第11条第16号）。
 * 這是**下限**不是等值，所以：
 *   - 有 ㎡ 就用 ㎡（主鍵）
 *   - 只有帖數時，只能得到面積的下界，必須標記為下界而非精確值
 * 反過來從 ㎡ 推帖數會高估，一律不做。
 */

import { norm } from './text.ts';
import { JO_TO_M2_MIN } from '../../schema/src/invariants.ts';

const M2_RE = /(\d+(?:\.\d+)?)\s*(?:㎡|m2|m²|平米|平方メートル)/i;
const JO_RE = /(\d+(?:\.\d+)?)\s*(?:帖|畳|тат)/;

export type AreaResult =
  | { readonly kind: 'exact'; readonly m2: number; readonly joDisplay: number | null }
  /** 只有帖數：這是面積的下界，不是面積 */
  | { readonly kind: 'lower_bound'; readonly m2AtLeast: number; readonly jo: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparsed' };

export function parseArea(input: string): AreaResult {
  const raw = norm(input);
  if (raw === '') return { kind: 'absent' };

  const m2m = M2_RE.exec(raw);
  const jom = JO_RE.exec(raw);

  if (m2m?.[1] !== undefined) {
    const m2 = Number(m2m[1]);
    if (!Number.isFinite(m2)) return { kind: 'unparsed' };
    const jo = jom?.[1] !== undefined ? Number(jom[1]) : null;
    return { kind: 'exact', m2, joDisplay: Number.isFinite(jo as number) ? jo : null };
  }

  if (jom?.[1] !== undefined) {
    const jo = Number(jom[1]);
    if (!Number.isFinite(jo)) return { kind: 'unparsed' };
    return { kind: 'lower_bound', m2AtLeast: Number((jo * JO_TO_M2_MIN).toFixed(2)), jo };
  }

  return /\d/.test(raw) ? { kind: 'unparsed' } : { kind: 'absent' };
}
