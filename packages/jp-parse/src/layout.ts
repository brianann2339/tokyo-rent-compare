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

const LAYOUT_RE = /^(\d+)\s*(LDK|DK|SLDK|SDK|SK|LK|K|R)$/i;

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
  // Borderless 英文「Room for 1」「Room for 2」：數字是可住人數，不是房間數
  [/\broom\s+for\s+\d/i, '個室'],
  [/ルームシェア/, 'ルームシェア'],
];

/** 「ワンルーム」「ワンルーム（1R）」「1ルーム」都是 1R 的別寫。 */
const ONE_ROOM_RE = /^(?:ワンルーム|1ルーム)(?:[（(]1R[）)])?$/;
/**
 * 「+S」「+納戸」「+WIC」都是サービスルーム的標示，併進 type：2LDK+S → 2SLDK、1K+S → 1SK。
 * 英文「1BR」「2BR」（bedroom）與 nLDK 體系對不上，刻意不收，讓它留在 unparsed。
 */
const SERVICE_ROOM_RE = /^(\d+)(LDK|DK|K)[+＋](?:S|納戸|WIC)$/;

export function parseLayout(input: string): LayoutResult {
  const raw = norm(input).replace(/\s/g, '').toUpperCase();
  if (raw === '') return { kind: 'absent' };

  for (const [re, canonical] of SHARE_TOKENS) {
    if (re.test(input)) return { kind: 'sharehouse', canonical };
  }

  if (ONE_ROOM_RE.test(raw)) return { kind: 'rooms', canonical: '1R', rooms: 1, type: 'R' };

  const s = SERVICE_ROOM_RE.exec(raw);
  if (s?.[1] !== undefined && s[2] !== undefined) {
    return roomsResult(Number(s[1]), `S${s[2]}`) ?? { kind: 'unparsed' };
  }

  const m = LAYOUT_RE.exec(raw);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const r = roomsResult(Number(m[1]), m[2].toUpperCase());
    if (r !== null) return r;
  }

  // 「1K～2DK」這種區間：取第一個當代表，但標記為未解析以免誤導
  return { kind: 'unparsed' };
}

function roomsResult(rooms: number, type: string): LayoutResult | null {
  if (!Number.isFinite(rooms) || rooms < 1 || rooms > 20) return null;
  return { kind: 'rooms', canonical: `${rooms}${type}`, rooms, type };
}

/** 排序用的粗略大小分數。只用於 UI 排序，不參與任何費用計算。 */
export function layoutSizeRank(canonical: string): number | null {
  const m = LAYOUT_RE.exec(canonical.toUpperCase());
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const rooms = Number(m[1]);
  const weight: Record<string, number> = { R: 0, K: 1, SK: 1.5, LK: 2, DK: 3, SDK: 3.5, LDK: 4, SLDK: 4.5 };
  const w = weight[m[2].toUpperCase()];
  return w === undefined ? null : rooms * 10 + w;
}
