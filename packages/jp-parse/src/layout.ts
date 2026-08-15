/**
 * 間取り（房型）解析。
 *
 * 法定規範**只涵蓋 DK 與 LDK**（不動産の表示に関する公正競争規約 第18条）：
 *   居室1間：DK ≥ 4.5畳、LDK ≥ 8畳
 *   居室2間以上：DK ≥ 6畳、LDK ≥ 10畳
 * R 與 K 沒有法定定義，1R/1K 的區別（有無獨立廚房隔間）是業界慣例。
 * 所以這裡只做形式解析，不對「這間到底算不算 1K」下判斷。
 */

import { norm } from './text.ts';

const LAYOUT_RE = /^(\d+)\s*(LDK|DK|SLDK|SDK|LK|K|R)$/i;

export type LayoutResult =
  | { readonly kind: 'rooms'; readonly canonical: string; readonly rooms: number; readonly type: string }
  /** share house 的「個室」「ドミトリー」不是 nLDK 體系 */
  | { readonly kind: 'sharehouse'; readonly canonical: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparsed' };

const SHARE_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ドミトリー|dormitory|dorm/i, 'ドミトリー'],
  [/個室|private\s*room/i, '個室'],
  [/ロフト付|loft/i, '個室(ロフト)'],
];

export function parseLayout(input: string): LayoutResult {
  const raw = norm(input).replace(/\s/g, '').toUpperCase();
  if (raw === '') return { kind: 'absent' };

  for (const [re, canonical] of SHARE_TOKENS) {
    if (re.test(input)) return { kind: 'sharehouse', canonical };
  }

  const m = LAYOUT_RE.exec(raw);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const rooms = Number(m[1]);
    const type = m[2].toUpperCase();
    if (Number.isFinite(rooms) && rooms >= 1 && rooms <= 20) {
      return { kind: 'rooms', canonical: `${rooms}${type}`, rooms, type };
    }
  }

  // 「1K～2DK」這種區間：取第一個當代表，但標記為未解析以免誤導
  return { kind: 'unparsed' };
}

/** 排序用的粗略大小分數。只用於 UI 排序，不參與任何費用計算。 */
export function layoutSizeRank(canonical: string): number | null {
  const m = LAYOUT_RE.exec(canonical.toUpperCase());
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const rooms = Number(m[1]);
  const weight: Record<string, number> = { R: 0, K: 1, LK: 2, DK: 3, SDK: 3.5, LDK: 4, SLDK: 4.5 };
  const w = weight[m[2].toUpperCase()];
  return w === undefined ? null : rooms * 10 + w;
}
