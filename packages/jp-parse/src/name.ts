/**
 * 建物名正規化：跨來源比對同一棟樓用的鍵。
 * 刻意保守——只抹掉空白、括號與標點這類純寫法差異，不去品牌詞、不做模糊比對；
 * 寧可同一棟樓沒對上，也不能把兩棟不同的樓併成一棟。
 */

import { toHalfWidth } from './text.ts';

/** NFKC 會把「［］（）」轉成半形，所以兩種寫法都要收；「【】」不在 NFKC 範圍內。 */
const BRACKETED_RE = /[【［\[（(][^】］\]）)]*[】］\]）)]/g;
const NOISE_RE = /[・･\-‐―~～!！.。,、/／_"']/g;

export function normalizeBuildingName(s: string): string {
  return toHalfWidth(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/\s/g, '')
    .replace(BRACKETED_RE, '')
    .replace(NOISE_RE, '');
}

export function buildingMatchKey(ward: string, name: string): string {
  return `${ward}|${normalizeBuildingName(name)}`;
}
