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

/**
 * 站名比對鍵：同一個站在各來源的寫法差異（2026-10-17 全量盤點 55 組），例如
 * 「大塚(東京)」「押上〈スカイツリー前〉」「浅草(つくばＥＸＰ)」（Oak House 用的全國站名去重註記）、
 * 尾端「駅」、全半形、「阿佐ケ谷／阿佐ヶ谷」「自由が丘／自由ヶ丘」「竹ノ塚／竹の塚」。
 * 之前這些在站名字典裡是不同的站：搜「大塚」會漏掉寫成「大塚(東京)」的 9 棟 Oak House。
 * 只拿來比對與分組，原始資料（真相層）照原文保留。
 */
export function stationKey(name: string): string {
  return name.normalize('NFKC').replace(/\s/g, '')
    .replace(/[(（〈<][^)）〉>]*[)）〉>]$/, '')
    .replace(/駅$/, '')
    .replace(/[ケヵが]/g, 'ヶ')
    .replace(/ノ/g, 'の');
}

// 沒有營運商前綴、但在東京只可能是那一家的路線名
const BARE_JR = /^(?:山手線|埼京線|京浜東北線|南武線|横浜線|青梅線|五日市線|八高線|武蔵野線|京葉線|常磐線|中央線|総武線|宇都宮線|横須賀線|高崎線|湘南新宿ライン|中央本線|総武本線|東海道本線|東北本線)$/;
const BARE_METRO = /^(?:丸の内|東西|日比谷|千代田|有楽町|副都心|南北|半蔵門|銀座)線$/;
const BARE_TOEI = /^(?:大江戸|三田|浅草)線$/; // 「新宿線」可能是都営或西武，不補

/**
 * 路線比對鍵：只合併「同一條線、寫法不同」——營運商全名／簡稱（東京地下鉄→東京メトロ、京王電鉄→京王、
 * 東京都大江戸線→都営大江戸線）、全半形（ＪＲ→JR）、空白、尾端的區間或支線註記（「JR中央線(快速)」「JR常磐線(上野～取手)」）。
 * 2026-10-17 盤點真相層 574 種寫法，路線下拉選單有 445 項、同一條線出現 5 種以上寫法。
 * 篩選本身走「路線→站→物件」，所以這裡只影響選單與路線—站對照，不改原始資料。
 * 「小田急線」併入「小田急小田原線」等：已查 SUUMO「小田急線」的站全部是小田原線的站（沒有多摩線的站）。
 */
export function lineKey(name: string): string {
  let s = name.normalize('NFKC').replace(/\s/g, '').replace(/ノ/g, 'の');
  if (/^東京さくらトラム[(（]都電荒川線[)）]$/.test(s) || s === '東京都荒川線') return '都電荒川線';
  s = s.replace(/[(（][^)）]*[)）]$/, '');
  s = s.replace(/^東京地下鉄/, '東京メトロ')
    .replace(/^(?:東京都営?|都営地下鉄)(?=(?:大江戸|三田|新宿|浅草)線$)/, '都営')
    .replace(/^京王電鉄/, '京王').replace(/^京王京王線$/, '京王線')
    .replace(/^西武鉄道/, '西武')
    .replace(/^東武鉄道/, '東武').replace(/^東武東上本線$/, '東武東上線')
    .replace(/^京成電鉄/, '京成')
    .replace(/^京浜急行(?:電鉄)?/, '京急')
    .replace(/^(?:小田急電鉄|小田急)?小田原線$|^小田急本線$/, '小田急線').replace(/^小田急電鉄/, '小田急')
    .replace(/^日暮里舎人ライナー$/, '日暮里・舎人ライナー')
    .replace(/^つくばエクスプレス線$/, 'つくばエクスプレス')
    .replace(/^新交通ゆりかもめ$/, 'ゆりかもめ')
    .replace(/^(?:JR)?京浜東北・根岸線$/, 'JR京浜東北線')
    .replace(/^JR線(?=.+線$)/, 'JR');
  if (BARE_JR.test(s)) s = `JR${s}`;
  if (BARE_METRO.test(s)) s = `東京メトロ${s}`;
  if (BARE_TOEI.test(s)) s = `都営${s}`;
  return s;
}
