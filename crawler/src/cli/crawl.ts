/**
 * 爬取執行器。
 *
 * 用法：
 *   node crawler/src/cli/crawl.ts                 # 全部啟用的來源，全量
 *   node crawler/src/cli/crawl.ts --source hituji # 指定來源
 *   node crawler/src/cli/crawl.ts --limit 40      # 試點：只抓前 N 筆
 *   node crawler/src/cli/crawl.ts --no-cache      # 忽略 conditional GET 快取
 *
 * 產物：
 *   data/normalized/{source}.ndjson  ← 真相層，進 git，一行一棟，git diff 可讀
 *   data/health/runs/{ts}-{source}.json
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpFetcher, DATA_ROOT } from '../http.ts';
import { collectHealth, compareToBaseline, medianBaseline, renderMarkdown, type SourceHealth } from '../health.ts';
import type { Listing } from '../../../packages/schema/src/model.ts';
import type { SourceAdapter } from '../types.ts';

import hituji from '../../sources/hituji/index.ts';

const ALL: readonly SourceAdapter[] = [hituji];

type Args = { source: string | null; limit: number | null; noCache: boolean; offline: boolean };

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { source: null, limit: null, noCache: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i] ?? null;
    else if (a === '--limit') out.limit = Number(argv[++i] ?? '') || null;
    else if (a === '--no-cache') out.noCache = true;
    else if (a === '--offline') out.offline = true;
  }
  return out;
}

async function loadHistory(sourceId: string): Promise<SourceHealth[]> {
  const dir = path.join(DATA_ROOT, 'health', 'runs');
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(`-${sourceId}.json`)).sort();
    const recent = files.slice(-5);
    const out: SourceHealth[] = [];
    for (const f of recent) out.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as SourceHealth);
    return out;
  } catch {
    return [];
  }
}

async function crawlSource(adapter: SourceAdapter, args: Args): Promise<SourceHealth | null> {
  const m = adapter.manifest;
  if (!m.legal.enabled) {
    console.log(`⏭  ${m.id}：legal.enabled = false，跳過`);
    return null;
  }

  const fetcher = await HttpFetcher.create(m, { useCache: !args.noCache });
  fetcher.setOffline(args.offline);
  console.log(`\n▶ ${m.nameZh}（${m.name}）`);
  console.log(args.offline
    ? '  離線模式：只從本機原始檔重新解析，不發任何請求'
    : `  robots.txt：${fetcher.robots.absent ? '不存在（無明示禁止）' : `${fetcher.robots.disallow.length} 條 Disallow`}；請求間隔 ${fetcher.delayMs}ms`);

  if (fetcher.robotsChanged()) {
    console.error(`  ⛔ robots.txt 已變動（sha256 ${fetcher.robots.sha256.slice(0, 16)}…），停止此來源，請人工重新檢視`);
    return null;
  }

  const ctx = { manifest: m, now: new Date() };
  const refs: Array<{ url: string; hint?: Record<string, unknown> }> = [];
  for await (const ref of adapter.discover(ctx, fetcher)) refs.push(ref);
  const targets = args.limit === null ? refs : refs.slice(0, args.limit);
  console.log(`  列舉到 ${refs.length} 筆${args.limit === null ? '' : `，本次只抓前 ${targets.length} 筆（試點）`}`);

  const listings: Listing[] = [];
  const buildIds = new Set<string>();
  const failures: Array<{ url: string; error: string }> = [];

  let done = 0;
  for (const ref of targets) {
    try {
      const raw = await fetcher.get(ref.url);
      if (raw.buildId !== undefined) buildIds.add(raw.buildId);
      const listing = adapter.extract(raw, ref, ctx);
      if (listing !== null) listings.push(listing);
      else failures.push({ url: ref.url, error: 'extract 回傳 null' });
    } catch (e) {
      failures.push({ url: ref.url, error: e instanceof Error ? e.message : String(e) });
    }
    done += 1;
    if (done % 25 === 0 || done === targets.length) {
      const pct = ((done / targets.length) * 100).toFixed(0);
      process.stdout.write(`\r  抓取進度 ${done}/${targets.length} (${pct}%)  成功 ${listings.length}  失敗 ${failures.length}   `);
    }
  }
  process.stdout.write('\n');

  const runAt = new Date().toISOString();
  await mkdir(path.join(DATA_ROOT, 'normalized'), { recursive: true });
  await writeFile(
    path.join(DATA_ROOT, 'normalized', `${m.id}.ndjson`),
    listings.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );

  const health = collectHealth(m, listings, {
    robotsSha256: fetcher.robots.sha256,
    robotsChanged: fetcher.robotsChanged(),
    buildIds: [...buildIds],
    runAt,
  });

  await mkdir(path.join(DATA_ROOT, 'health', 'runs'), { recursive: true });
  await writeFile(
    path.join(DATA_ROOT, 'health', 'runs', `${runAt.replace(/[:.]/g, '-')}-${m.id}.json`),
    JSON.stringify(health, null, 1), 'utf8',
  );

  const units = listings.reduce((n, l) => n + l.units.length, 0);
  console.log(args.offline
    ? `  ✔ ${listings.length} 棟 / ${units} 間房（全部來自本機原始檔，0 次網路請求）`
    : `  ✔ ${listings.length} 棟 / ${units} 間房；HTTP ${fetcher.stats.requests} 次（304 快取命中 ${fetcher.stats.notModified}）`);
  if (failures.length > 0) {
    console.log(`  ⚠️ ${failures.length} 筆失敗，前 3 筆：`);
    for (const f of failures.slice(0, 3)) console.log(`     ${f.url} — ${f.error}`);
  }

  const alerts = compareToBaseline(health, medianBaseline(await loadHistory(m.id)));
  for (const a of alerts) console.log(`  ${a.level === 'RED' ? '🔴' : '🟡'} ${a.fieldId}：${a.message}`);

  return health;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sources = args.source === null ? ALL : ALL.filter((a) => a.manifest.id === args.source);
  if (sources.length === 0) {
    console.error(`找不到來源：${args.source ?? ''}。可用：${ALL.map((a) => a.manifest.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const healths: SourceHealth[] = [];
  const alertMap: Record<string, ReturnType<typeof compareToBaseline>> = {};
  for (const a of sources) {
    const h = await crawlSource(a, args);
    if (h !== null) {
      healths.push(h);
      alertMap[h.sourceId] = compareToBaseline(h, medianBaseline(await loadHistory(h.sourceId)));
    }
  }

  if (healths.length > 0) {
    await mkdir(path.join(DATA_ROOT, 'health'), { recursive: true });
    await writeFile(path.join(DATA_ROOT, 'health', 'latest.md'), renderMarkdown(healths, alertMap), 'utf8');
    console.log(`\n📋 健康報告：data/health/latest.md`);
  }
}

await main();
