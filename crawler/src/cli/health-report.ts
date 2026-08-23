/**
 * 健康報告合併器。
 *
 * crawl.ts 每跑完一個來源就寫一檔 data/health/runs/{ts}-{source}.json；
 * 這裡取每個來源最新的一檔合併成 data/health/latest.md。
 * 若改由「本次執行的來源」整檔覆寫，單跑 SUUMO 就會把其他十一家從報告抹掉，
 * 看報告判斷「哪個欄位有資料」的人會被誤導。
 *
 * 用法：
 *   node crawler/src/cli/health-report.ts
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DATA_ROOT } from '../http.ts';
import {
  compareToBaseline, medianBaseline, renderMarkdown,
  type Alert, type SourceHealth, type SourceNote,
} from '../health.ts';

const RUNS_DIR = path.join(DATA_ROOT, 'health', 'runs');
const HISTORY_DEPTH = 5;
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

// 檔名由 crawl.ts 以 `${runAt.replace(/[:.]/g, '-')}-${sourceId}.json` 寫出，
// 時間戳固定寬度，同一來源的檔名可直接字典排序。
const RUN_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.json$/;

async function loadRunsBySource(): Promise<Map<string, string[]>> {
  const bySource = new Map<string, string[]>();
  let files: string[];
  try {
    files = await readdir(RUNS_DIR);
  } catch {
    return bySource;
  }
  for (const f of files.sort()) {
    const m = RUN_FILE.exec(f);
    if (m?.[1] === undefined) continue;
    const list = bySource.get(m[1]) ?? [];
    list.push(f);
    bySource.set(m[1], list);
  }
  return bySource;
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 合併每個來源最新一次執行，寫出 data/health/latest.md；回傳收錄的 sourceId。 */
export async function writeLatestReport(now: Date = new Date()): Promise<string[]> {
  const bySource = await loadRunsBySource();
  const healths: SourceHealth[] = [];
  const alerts: Record<string, readonly Alert[]> = {};
  const notes: Record<string, SourceNote> = {};

  for (const sourceId of [...bySource.keys()].sort()) {
    const recent = (bySource.get(sourceId) ?? []).slice(-HISTORY_DEPTH);
    const history: SourceHealth[] = [];
    for (const f of recent) history.push(JSON.parse(await readFile(path.join(RUNS_DIR, f), 'utf8')) as SourceHealth);
    const latest = history.at(-1);
    if (latest === undefined) continue;
    healths.push(latest);
    alerts[sourceId] = compareToBaseline(latest, medianBaseline(history));
    notes[sourceId] = {
      lastRunAt: formatLocal(latest.runAt),
      stale: now.getTime() - Date.parse(latest.runAt) > STALE_MS,
    };
  }

  await mkdir(path.join(DATA_ROOT, 'health'), { recursive: true });
  await writeFile(path.join(DATA_ROOT, 'health', 'latest.md'), renderMarkdown(healths, alerts, notes), 'utf8');
  return healths.map((h) => h.sourceId);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const included = await writeLatestReport();
  console.log(`收錄 ${included.length} 個來源：${included.join(', ')}`);
}
