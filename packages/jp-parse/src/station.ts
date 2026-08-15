/**
 * 車站與步行時間解析。
 *
 * 實務上的坑：
 *   - 「バス7分 徒歩1～11分」：搭公車再走路，徒歩分鐘不代表從車站走過去
 *   - 「徒歩1～11分」：範圍（大型團地各棟距離不同）
 *   - 「1.8～2.0 km, 徒歩 23.0～26.0 分」：Village House 用小數
 * 這些都不能硬塞一個數字，否則就是虛構。範圍一律取下界並標記。
 */

import { norm } from './text.ts';

const WALK_RE = /徒歩\s*(\d+(?:\.\d+)?)\s*(?:~\s*(\d+(?:\.\d+)?)\s*)?分/;
const BUS_RE = /バス\s*(\d+)\s*分/;
/** 「東京メトロ千代田線「代々木公園駅」徒歩10分」 */
const LINE_STATION_RE = /(.{2,20}?線)\s*[「『]?\s*(.{1,12}?)駅?\s*[」』]?\s*(?:まで)?\s*(?:徒歩|バス)/;
/** 「赤坂駅 まで 徒歩 4 分」 */
const STATION_ONLY_RE = /(.{1,12}?)駅\s*(?:まで)?\s*(?:徒歩|バス)/;

export type WalkResult =
  | { readonly kind: 'exact'; readonly minutes: number }
  /** 範圍：只取下界，並保留上界供顯示 */
  | { readonly kind: 'range'; readonly minMinutes: number; readonly maxMinutes: number }
  /** 需搭公車：徒歩分鐘不是從車站算起，不可直接當作步行距離 */
  | { readonly kind: 'via_bus'; readonly busMinutes: number; readonly walkMinutes: number | null }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparsed' };

export function parseWalk(input: string): WalkResult {
  const raw = norm(input);
  if (raw === '') return { kind: 'absent' };

  const bus = BUS_RE.exec(raw);
  const walk = WALK_RE.exec(raw);

  if (bus?.[1] !== undefined) {
    const busMinutes = Number(bus[1]);
    const walkMinutes = walk?.[1] !== undefined ? Number(walk[1]) : null;
    if (!Number.isFinite(busMinutes)) return { kind: 'unparsed' };
    return { kind: 'via_bus', busMinutes, walkMinutes: Number.isFinite(walkMinutes as number) ? walkMinutes : null };
  }

  if (walk?.[1] !== undefined) {
    const lo = Number(walk[1]);
    if (!Number.isFinite(lo)) return { kind: 'unparsed' };
    if (walk[2] !== undefined) {
      const hi = Number(walk[2]);
      if (Number.isFinite(hi)) return { kind: 'range', minMinutes: lo, maxMinutes: hi };
    }
    return { kind: 'exact', minutes: lo };
  }

  return /徒歩|バス/.test(raw) ? { kind: 'unparsed' } : { kind: 'absent' };
}

export type StationRef = {
  readonly line: string | null;
  readonly station: string | null;
  readonly walk: WalkResult;
  readonly rawText: string;
};

export function parseStationLine(input: string): StationRef {
  const raw = norm(input);
  const ls = LINE_STATION_RE.exec(raw);
  if (ls?.[1] !== undefined && ls[2] !== undefined) {
    return { line: ls[1].trim(), station: ls[2].trim(), walk: parseWalk(raw), rawText: raw };
  }
  const so = STATION_ONLY_RE.exec(raw);
  if (so?.[1] !== undefined) {
    return { line: null, station: so[1].trim(), walk: parseWalk(raw), rawText: raw };
  }
  return { line: null, station: null, walk: parseWalk(raw), rawText: raw };
}

/** 一段文字裡常含多個車站，用分隔符切開後逐一解析。 */
export function parseStations(input: string): readonly StationRef[] {
  const raw = norm(input);
  if (raw === '') return [];
  return raw
    .split(/[｜|/／、,]|\s{2,}|\[\d+\]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && /徒歩|バス|駅/.test(s))
    .map(parseStationLine);
}
