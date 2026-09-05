/**
 * 跨來源同棟候選清單——給人審的，不是自動合併。
 *
 * 同一間房可能同時出現在自營站（Couverture）與聚合站（ひつじ／Tokyo Sharehouse），
 * 或 Leopalace 與 SUUMO。比對鍵刻意保守：
 *   同 ward（空者跳過）＋ 正規化建物名完全相同 ＋ 至少一個共同站名
 * 再看房間層是否有 `(賃料, 面積)` 皆已知且相同的房——只有房間層命中才算「雙重計算」。
 *
 * 輸出 `data/aliases/candidates.json`；人審後把確認的組搬進 `data/aliases/buildings.json`，
 * build-data 的閘門 4 才會放行。這個腳本本身不寫 buildings.json。
 */

import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { DATA_ROOT } from '../http.ts';
import { readNdjsonGz } from '../ndjson.ts';
import type { Listing } from '../../../packages/schema/src/model.ts';
import { buildingMatchKey } from '../../../packages/jp-parse/src/name.ts';

/** 主來源優先序：自營站在前；同序時以 units 數多者為主（在 build-data 決定）。 */
export const SOURCE_PRIORITY = [
  'couverture', 'oakhouse', 'sakurahouse', 'borderless', 'socialapartment', 'villagehouse',
  'leopalace21', 'ur', 'jkk', 'hituji', 'tokyosharehouse', 'suumo',
] as const;

export type AliasGroup = {
  readonly key: string;
  readonly primary: string;           // buildingId
  readonly members: readonly string[]; // 其餘 buildingId
  readonly reviewedAt: string;
  readonly note: string;
};
export type AliasFile = { version: 1; groups: AliasGroup[] };

export function roomSig(l: Listing): Set<string> {
  const s = new Set<string>();
  for (const u of l.units) {
    if (u.monthly.rent.known && u.areaM2.known) s.add(`${u.monthly.rent.v.jpy}|${u.areaM2.v}`);
  }
  return s;
}

/**
 * 房間層命中：只算「不同來源」之間 (賃料, 面積) 相同的房。
 * 同一來源的兩棟同名（SUUMO 兩個 jnc 頁）不算——那是站內跨頁重複，計畫裁定只標記不合併。
 */
export function crossSourceRoomHits(ls: readonly Listing[]): number {
  const sigs = ls.map(roomSig);
  let hit = 0;
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
    if (ls[i]?.building.sourceId === ls[j]?.building.sourceId) continue;
    for (const s of sigs[i] as Set<string>) if ((sigs[j] as Set<string>).has(s)) hit += 1;
  }
  return hit;
}

export function pickPrimary(ls: readonly Listing[]): Listing {
  const rank = (id: string): number => {
    const i = SOURCE_PRIORITY.indexOf(id as (typeof SOURCE_PRIORITY)[number]);
    return i < 0 ? SOURCE_PRIORITY.length : i;
  };
  return [...ls].sort((a, b) =>
    b.units.length - a.units.length || rank(a.building.sourceId) - rank(b.building.sourceId),
  )[0] as Listing;
}

export async function loadAllListings(): Promise<Listing[]> {
  const dir = path.join(DATA_ROOT, 'normalized');
  const out: Listing[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.ndjson.gz')).sort()) {
    for await (const l of readNdjsonGz<Listing>(path.join(dir, f))) out.push(l);
  }
  return out;
}

/** 跨來源候選：key → 各來源的 listing（同來源多棟也會進來，但只有跨來源才算候選）。 */
export function findCandidates(listings: readonly Listing[]): Map<string, Listing[]> {
  const byKey = new Map<string, Listing[]>();
  for (const l of listings) {
    const b = l.building;
    if (b.ward === '' || b.name.trim() === '') continue;
    const k = buildingMatchKey(b.ward, b.name);
    (byKey.get(k) ?? byKey.set(k, []).get(k) as Listing[]).push(l);
  }
  const out = new Map<string, Listing[]>();
  for (const [k, ls] of byKey) {
    const sources = new Set(ls.map((l) => l.building.sourceId));
    if (sources.size < 2) continue;
    // 至少一個共同站名
    const stationSets = ls.map((l) => new Set(l.building.stations.map((s) => s.station)));
    const shared = stationSets.some((a, i) => stationSets.some((b, j) => i !== j && [...a].some((s) => b.has(s))));
    if (!shared) continue;
    out.set(k, ls);
  }
  return out;
}

async function main(): Promise<void> {
  const listings = await loadAllListings();
  const cands = findCandidates(listings);
  const rows: Array<Record<string, unknown>> = [];
  let roomHits = 0;
  for (const [key, ls] of cands) {
    const hit = crossSourceRoomHits(ls);
    roomHits += hit;
    const primary = pickPrimary(ls);
    rows.push({
      key,
      roomLevelHits: hit,
      primary: primary.building.id,
      members: ls.filter((l) => l !== primary).map((l) => l.building.id),
      detail: ls.map((l) => ({
        id: l.building.id, source: l.building.sourceId, name: l.building.name, ward: l.building.ward,
        stations: l.building.stations.map((s) => s.station), units: l.units.length, url: l.building.sourceUrl,
      })),
    });
  }
  rows.sort((a, b) => (b['roomLevelHits'] as number) - (a['roomLevelHits'] as number));
  await mkdir(path.join(DATA_ROOT, 'aliases'), { recursive: true });
  const out = path.join(DATA_ROOT, 'aliases', 'candidates.json');
  await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), groups: rows }, null, 1), 'utf8');
  const existing = existsSync(path.join(DATA_ROOT, 'aliases', 'buildings.json'));
  console.log(`✔ 候選：${cands.size} 組（房間層命中 ${roomHits} 間）→ ${path.relative(process.cwd(), out)}`);
  console.log(`  已審核檔 buildings.json ${existing ? '存在' : '不存在'}；人審後把確認的組搬進去，build-data 閘門 4 才放行`);
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) await main();
