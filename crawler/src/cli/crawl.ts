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

import { mkdir, writeFile, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import { HttpFetcher, DATA_ROOT } from '../http.ts';
import { readNdjsonGz } from '../ndjson.ts';
import { healthCollector, compareToBaseline, medianBaseline, type SourceHealth } from '../health.ts';
import { writeLatestReport } from './health-report.ts';
import type { Listing } from '../../../packages/schema/src/model.ts';
import type { SourceAdapter } from '../types.ts';

import { loadAdapters } from '../registry.ts';


type Args = { source: string | null; limit: number | null; noCache: boolean; offline: boolean };

/**
 * 認不得的參數一律中止，**不可以默默忽略**。
 *
 * 2026-09-06 的實際事故：我打了 `--source=oakhouse`（等號形式），
 * 舊的迴圈只認 `--source oakhouse`（空白形式），於是那個參數被靜靜丟掉、
 * `source` 維持 null＝「跑全部來源」。結果是一個本來只該碰 oakhouse 的指令
 * 去重跑了每一個來源，還撞上當時正在跑的 hituji 爬取、把它寫到一半的
 * 暫存檔覆蓋掉。打錯字的代價不該是「安靜地做另一件事」。
 * 兩種形式現在都收，其餘一律 error + exit 2。
 */
function parseArgs(argv: readonly string[]): Args {
  const out: Args = { source: null, limit: null, noCache: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? '';
    const eq = raw.indexOf('=');
    const a = eq > 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq > 0 ? raw.slice(eq + 1) : null;
    const value = (): string | null => inlineValue ?? argv[++i] ?? null;
    if (a === '--source') out.source = value();
    else if (a === '--limit') {
      const v = value() ?? '';
      const n = Number(v);
      // `--limit 0` 以前會變成「無上限」（`0 || null`），跟使用者想說的正好相反。
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--limit 需要 ≥1 的整數，收到「${v}」`);
        process.exit(2);
      }
      out.limit = n;
    }
    else if (a === '--no-cache') out.noCache = true;
    else if (a === '--offline') out.offline = true;
    else {
      console.error(`認不得的參數：${raw}\n`
        + '可用：--source <id>｜--limit <n>｜--no-cache｜--offline（--source=<id> 等號形式也可以）');
      process.exit(2);
    }
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
  const buildIds = new Set<string>();
  const failures: Array<{ url: string; error: string }> = [];
  // extract 回 null 與「丟出例外」是兩件事：前者多半是「不在收錄範圍」
  // （例：Oak House 的 sitemap 是全國的，非東京物件會回 null），
  // 後者才是真的壞掉。混在一起會讓真正的解析錯誤被幾百筆正常跳過淹沒。
  let skipped = 0;
  let kept = 0;
  let done = 0;

  // 一邊 discover 一邊解析一邊寫檔，**任何一份完整資料都不留在記憶體**。
  // 2026-09-06 的教訓：SUUMO 23 区列舉出 87,113 筆，舊寫法先把 refs（hint 裡是整棟資料）
  // 與 listings 兩份都堆起來、最後再 `listings.map(JSON.stringify).join('\n')` 產生一個
  // 400 MB 的巨串餵給 gzipSync——1,753 頁全部抓完（0 錯誤）之後才在寫檔那一行 OOM，
  // 兩個半小時的網路請求全部白費。
  const collector = healthCollector(m);
  const outPath = path.join(DATA_ROOT, 'normalized', `${m.id}.ndjson.gz`);
  const tmpPath = `${outPath}.tmp`;
  await mkdir(path.join(DATA_ROOT, 'normalized'), { recursive: true });

  // 真相層以 gzip 存放：SUUMO 一家未壓縮就 300 MB，超過 GitHub 建議的單檔上限。
  // 代價是 git diff 不再直接可讀，改用 `npm run diff:data` 之類的方式看（尚未做）。
  const gz = createGzip();
  const writing = pipeline(gz, createWriteStream(tmpPath));
  const writeLine = async (line: string): Promise<void> => {
    if (!gz.write(line)) await new Promise<void>((r) => gz.once('drain', () => r()));
  };

  try {
    for await (const ref of adapter.discover(ctx, fetcher)) {
      if (args.limit !== null && done >= args.limit) break;
      try {
        const raw = m.fetchMode === 'none'
          ? { url: ref.url, body: '', fetchedAt: new Date().toISOString(), sha256: '', status: 200, notModified: false }
          : await fetcher.get(ref.url);
        if (raw.buildId !== undefined) buildIds.add(raw.buildId);
        const listing = adapter.extract(raw, ref, ctx);
        if (listing !== null) {
          await writeLine(`${JSON.stringify(listing)}\n`);
          collector.add(listing);
          kept += 1;
        } else skipped += 1;
      } catch (e) {
        failures.push({ url: ref.url, error: e instanceof Error ? e.message : String(e) });
      }
      done += 1;
      if (done % 25 === 0) {
        process.stdout.write(`\r  處理 ${done} 筆${args.limit === null ? '' : ` / 上限 ${args.limit}`}  收錄 ${kept}  跳過 ${skipped}  錯誤 ${failures.length}   `);
      }
    }
    gz.end();
    await writing;
  } catch (e) {
    gz.destroy();
    await rm(tmpPath, { force: true }); // 中途失敗不留半份真相層，舊檔原封不動
    throw e;
  }
  process.stdout.write(`\r  處理 ${done} 筆  收錄 ${kept}  跳過 ${skipped}  錯誤 ${failures.length}   \n`);

  // 離線重解析不該讓資料變少。
  // 2026-09-06 的教訓：ur 與 sakurahouse 走 API／真實瀏覽器，沒有 data/raw/ 目錄，
  // `--offline` 於是從不完整的 cache 讀，靜默把 150→126 間、666→627 間。
  // 那不是「解析改變」而是「原始檔根本不全」，寫出去就是無聲的資料損失。
  if (args.offline && existsSync(outPath)) {
    let before = 0;
    for await (const _ of readNdjsonGz<unknown>(outPath)) before += 1;
    if (before > 0 && kept < before * 0.95) {
      await rm(tmpPath, { force: true });
      throw new Error(
        `[offline] 重解析後從 ${before} 棟掉到 ${kept} 棟（少於 95%）——`
        + `多半是本機原始檔不全（這個來源有 data/raw/${m.id}/ 嗎？），不是解析改變。`
        + '既有真相層原封不動，未覆寫。要強制覆寫請先正常抓一次。',
      );
    }
  }
  await rename(tmpPath, outPath);

  const runAt = new Date().toISOString();
  const health = collector.finish({
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

  console.log(args.offline
    ? `  ✔ ${health.buildings} 棟 / ${health.units} 間房（全部來自本機原始檔，0 次網路請求）`
    : `  ✔ ${health.buildings} 棟 / ${health.units} 間房；HTTP ${fetcher.stats.requests} 次（304 快取命中 ${fetcher.stats.notModified}）`);
  if (skipped > 0) console.log(`  · ${skipped} 筆不在收錄範圍（非東京或非房源頁），已跳過`);
  if (failures.length > 0) {
    console.log(`  ⚠️ ${failures.length} 筆真的出錯，前 3 筆：`);
    for (const f of failures.slice(0, 3)) console.log(`     ${f.url} — ${f.error}`);
  }

  const alerts = compareToBaseline(health, medianBaseline(await loadHistory(m.id)));
  for (const a of alerts) console.log(`  ${a.level === 'RED' ? '🔴' : '🟡'} ${a.fieldId}：${a.message}`);

  return health;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ALL = await loadAdapters();
  const sources = args.source === null ? ALL : ALL.filter((a) => a.manifest.id === args.source);
  if (sources.length === 0) {
    console.error(`找不到來源：${args.source ?? ''}。可用：${ALL.map((a) => a.manifest.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const healths: SourceHealth[] = [];
  for (const a of sources) {
    const h = await crawlSource(a, args);
    if (h !== null) healths.push(h);
  }

  // latest.md 由 runs/ 內每個來源的最新一檔合併而成，
  // 單跑一個來源不會把其他來源從報告抹掉。
  if (healths.length > 0) {
    const included = await writeLatestReport();
    console.log(`\n📋 健康報告：data/health/latest.md（收錄 ${included.length} 個來源）`);
  }
}

await main();
