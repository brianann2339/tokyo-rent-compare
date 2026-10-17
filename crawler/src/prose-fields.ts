/**
 * 說明文判讀（jp-parse/prose.ts 的 proseGuarantorFee 等）→ 欄位。Tokyo Sharehouse 與ひつじ共用。
 * mentioned（提到保證公司但沒寫初回要付多少）存「這頁沒寫」：頁面講了要用保證公司，
 * 說「此來源不公開」是假的，說「0」更是假的。
 */
import {
  known, notListed, notOffered, conflicting, statedNoAmount, includedInOther, yen, type Field, type Yen,
} from '../../packages/schema/src/field.ts';
import type { FeeProse } from '../../packages/jp-parse/src/prose.ts';

/** 說明文明寫每月另付的固定費（proseOtherMonthly：保證公司月費、月付手續費、サポート料、町会費、月付保險…）→ 其他月費：明寫要付、金額不採用；沒寫就維持「此來源不公開」。 */
export function proseOtherMonthlyField(sentences: readonly string[], where = '物件說明'): Field<Yen> {
  if (sentences.length === 0) return notOffered<Yen>();
  return statedNoAmount<Yen>(`${where}「${sentences.join('／')}」（每月另付的固定費；說明文的金額不自動採用，見原文）`);
}

export function proseFeeField(p: FeeProse | null | undefined, unsure = false, where = '物件說明'): Field<Yen> {
  if (p === null || p === undefined) return notOffered<Yen>();
  switch (p.kind) {
    case 'zero': return known(yen(0), 'measured', `${where}「${p.sentence}」`);
    case 'included': return includedInOther(`${where}「${p.sentence}」`);
    case 'stated': return statedNoAmount<Yen>(`${where}「${p.sentence}」（說明文的金額不自動採用，見原文${unsure ? '；原文沒寫入居時還是退去時付' : ''}）`);
    case 'mentioned': return notListed(`${where}「${p.sentence}」（提到保証会社，但沒寫初回要付多少）`);
    case 'unadopted': return notListed(`${where}「${p.sentence}」（免收句附近有條件或活動字眼，未採用）`);
    case 'conflict': return conflicting<Yen>(`${where}前後說法不一：${p.sentence}`);
  }
}
