/**
 * HTTP transport：速率限制、conditional GET、原始檔落地、robots 驗證。
 *
 * 這一層是共用基礎設施——來源不實作 fetch，只實作 extract。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { sha256, fetchRobots, isAllowed, type RobotsRules } from './robots.ts';
import type { Fetcher, RawDoc, SourceManifest } from './types.ts';

/**
 * User-Agent 標明站名、用途與聯絡方式，方便對方要求停爬。
 * 這不是禮貌問題而已——匿名爬蟲更容易被整段封鎖。
 */
// HTTP 標頭只能是 ASCII（ByteString），不可放中日文。
export const USER_AGENT =
  `TokyoRentCompare/0.1 (personal rental price-comparison aggregator; ` +
  `every listing links back to the source site; contact via repository issues) Node/${process.versions.node}`;

export const DATA_ROOT = path.resolve(import.meta.dirname, '../../data');
const RAW_DIR = path.join(DATA_ROOT, 'raw');
const CACHE_DIR = path.join(DATA_ROOT, 'cache');

type CacheEntry = { etag?: string; lastModified?: string; sha256: string; fetchedAt: string };

function keyOf(url: string): string {
  return sha256(url).slice(0, 40);
}

async function readCache(sourceId: string, url: string): Promise<CacheEntry | null> {
  const p = path.join(CACHE_DIR, sourceId, `${keyOf(url)}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(sourceId: string, url: string, e: CacheEntry): Promise<void> {
  const dir = path.join(CACHE_DIR, sourceId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${keyOf(url)}.json`), JSON.stringify(e), 'utf8');
}

async function readRaw(sourceId: string, url: string): Promise<string | null> {
  const p = path.join(RAW_DIR, sourceId, `${keyOf(url)}.html.gz`);
  if (!existsSync(p)) return null;
  try {
    return gunzipSync(await readFile(p)).toString('utf8');
  } catch {
    return null;
  }
}

async function writeRaw(sourceId: string, url: string, body: string): Promise<void> {
  const dir = path.join(RAW_DIR, sourceId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${keyOf(url)}.html.gz`), gzipSync(Buffer.from(body, 'utf8')));
}

const NEXT_BUILD_ID_RE = /\/_next\/static\/([A-Za-z0-9_-]{8,})\//;

export function extractBuildId(html: string): string | undefined {
  const m = NEXT_BUILD_ID_RE.exec(html);
  return m?.[1];
}

/**
 * 暫時性失敗的退避時間。只有 502／503／504 與連線層錯誤會重試。
 *
 * 2026-10-17 實測：SUUMO 在一次預計 2.5 小時的爬取中途回了 503（兩次分別在第 49 頁、第 9 頁），
 * 20 秒後同一頁就回 200，沒有驗證頁、也沒有 Retry-After——是對方暫時過載，不是擋人。
 * 舊版遇到一次就讓整個來源中止，之前的請求全部白費。
 * **403／429 不重試**：那可能是對方在要我們停，重試等於硬闖。
 * 間隔刻意拉長（1／5／15 分鐘）：對方過載時最不該做的就是馬上再敲一次。
 */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];
const TRANSIENT_STATUS = new Set([502, 503, 504]);

/**
 * Node 內建 fetch 的連線層失敗一律只說「fetch failed」，真正原因（ECONNRESET、逾時、DNS…）在 `cause`。
 * 2026-10-17 SUUMO 同一頁連三次 fetch failed，當下用 curl 抓同一頁 1.2 秒就回 200——
 * 沒有 cause 就分不出是對方斷線、本機網路還是程序內連線池壞掉。
 */
export function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return e.message;
  const code = (cause as { code?: unknown }).code;
  return `${e.message}（${typeof code === 'string' ? `${code} ` : ''}${cause.message}）`;
}

export async function fetchRetrying(
  doFetch: () => Promise<Response>,
  opts: {
    backoffMs: readonly number[];
    sleep: (ms: number) => Promise<void>;
    onRetry: (why: string, waitMs: number, attempt: number) => void;
  },
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let why: string;
    try {
      const res = await doFetch();
      if (!TRANSIENT_STATUS.has(res.status)) return res;
      await res.body?.cancel();
      why = `http ${res.status}`;
    } catch (e) {
      why = describeFetchError(e);
    }
    const wait = opts.backoffMs[attempt];
    if (wait === undefined) throw new Error(`[${why}] 重試 ${attempt} 次仍失敗`);
    opts.onRetry(why, wait, attempt + 1);
    await opts.sleep(wait);
  }
}

export class HttpFetcher implements Fetcher {
  #manifest: SourceManifest;
  #robots: RobotsRules;
  #delayMs: number;
  #lastRequestAt = 0;
  #useCache: boolean;
  #reuseSince: string | null;

  stats = { requests: 0, notModified: 0, blocked: 0, errors: 0, fromDisk: 0, retries: 0 };

  private constructor(manifest: SourceManifest, robots: RobotsRules, useCache: boolean, reuseSince: string | null) {
    this.#manifest = manifest;
    this.#robots = robots;
    this.#useCache = useCache;
    this.#reuseSince = reuseSince;
    // robots.txt 的 Crawl-delay 若比我方設定嚴格，以對方為準
    const robotsDelay = (robots.crawlDelaySec ?? 0) * 1000;
    this.#delayMs = Math.max(manifest.crawlDelayMs, robotsDelay);
  }

  static async create(
    manifest: SourceManifest,
    opts: { useCache?: boolean; reuseSince?: string | null; offline?: boolean } = {},
  ): Promise<HttpFetcher> {
    // 離線重解析不發任何請求，robots.txt 也不抓（2026-10-17：網路斷線時重解析曾卡在這一步）；sha256 留空＝這次沒查
    const robots = opts.offline === true
      ? { raw: '', sha256: '', disallow: [], allow: [], crawlDelaySec: null, sitemaps: [], absent: false }
      : await fetchRobots(manifest.origin, USER_AGENT);
    const f = new HttpFetcher(manifest, robots, opts.useCache ?? true, opts.reuseSince ?? null);
    f.setOffline(opts.offline === true);
    return f;
  }

  get robots(): RobotsRules { return this.#robots; }
  get delayMs(): number { return this.#delayMs; }

  /** robots.txt 是否與上次查證時相同。不同代表對方改了規則，該停下來重新檢視。 */
  robotsChanged(): boolean {
    const known = this.#manifest.legal.robotsSha256;
    return known !== null && this.#robots.sha256 !== '' && known !== this.#robots.sha256;
  }

  async #throttle(): Promise<void> {
    const elapsed = Date.now() - this.#lastRequestAt;
    const wait = this.#delayMs - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#lastRequestAt = Date.now();
  }

  /**
   * 離線模式：只從本機已抓下的原始檔重新解析，完全不發任何請求。
   * 改了 adapter 的解析邏輯後要重跑時用這個——重新解析不該再打對方伺服器一次。
   */
  #offline = false;
  setOffline(v: boolean): void { this.#offline = v; }

  async get(url: string, opts: { headers?: Record<string, string> } = {}): Promise<RawDoc> {
    if (this.#offline) {
      const body = await readRaw(this.#manifest.id, url);
      if (body === null) throw new Error(`[offline] 本機沒有 ${url} 的原始檔，請先正常抓一次`);
      this.stats.fromDisk += 1;
      return {
        url, body, fetchedAt: (await readCache(this.#manifest.id, url))?.fetchedAt ?? new Date().toISOString(),
        sha256: sha256(body), status: 200, buildId: extractBuildId(body), notModified: true,
      };
    }

    const decision = isAllowed(this.#robots, url);
    if (!decision.allowed) {
      this.stats.blocked += 1;
      throw new Error(`[robots] ${url} — ${decision.reason}`);
    }

    // 中斷後續跑（--reuse-since）：這個時刻之後已抓過、原始檔雜湊對得上的頁直接讀本機。
    // SUUMO 全量要數小時，抓到一半被對方連線中斷時，重跑不該把已經拿到的幾萬筆再要一次。
    // 跨時段的分頁位移與單次長時間抓取是同一件事，build-data 已按建物 id 合併、按 unitKey 去重。
    if (this.#reuseSince !== null) {
      const c = await readCache(this.#manifest.id, url);
      if (c !== null && c.sha256 !== '' && c.fetchedAt >= this.#reuseSince) {
        const body = await readRaw(this.#manifest.id, url);
        if (body !== null && sha256(body) === c.sha256) {
          this.stats.fromDisk += 1;
          return {
            url, body, fetchedAt: c.fetchedAt, sha256: c.sha256,
            status: 200, buildId: extractBuildId(body), notModified: true,
          };
        }
      }
    }

    const cached = this.#useCache ? await readCache(this.#manifest.id, url) : null;
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja,en;q=0.8',
      ...opts.headers,
    };
    if (cached?.etag !== undefined) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified !== undefined) headers['If-Modified-Since'] = cached.lastModified;

    let res: Response;
    try {
      res = await fetchRetrying(async () => {
        await this.#throttle();
        this.stats.requests += 1;
        return fetch(url, { headers, redirect: 'follow' });
      }, {
        backoffMs: RETRY_BACKOFF_MS,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onRetry: (why, ms, n) => {
          this.stats.retries += 1;
          console.warn(`\n  ⚠ ${url} — ${why}；${ms / 1000} 秒後重試（第 ${n} 次）`);
        },
      });
    } catch (e) {
      this.stats.errors += 1;
      throw new Error(`${e instanceof Error ? e.message : String(e)}：${url}`);
    }

    if (res.status === 304) {
      this.stats.notModified += 1;
      const body = await readRaw(this.#manifest.id, url);
      if (body !== null) {
        this.stats.fromDisk += 1;
        return {
          url, body, fetchedAt: new Date().toISOString(), sha256: sha256(body),
          status: 304, buildId: extractBuildId(body), notModified: true,
        };
      }
      // 有 304 但本機沒有原始檔：清掉快取下次重抓
      await writeCache(this.#manifest.id, url, { sha256: '', fetchedAt: new Date().toISOString() });
      throw new Error(`[cache] ${url} 回 304 但本機無原始檔，已清除快取，請重跑`);
    }

    if (!res.ok) {
      this.stats.errors += 1;
      throw new Error(`[http ${res.status}] ${url}`);
    }

    const body = await res.text();
    const hash = sha256(body);
    await writeRaw(this.#manifest.id, url, body);
    const entry: CacheEntry = { sha256: hash, fetchedAt: new Date().toISOString() };
    const etag = res.headers.get('etag');
    const lm = res.headers.get('last-modified');
    if (etag !== null) entry.etag = etag;
    if (lm !== null) entry.lastModified = lm;
    await writeCache(this.#manifest.id, url, entry);

    return {
      url, body, fetchedAt: entry.fetchedAt, sha256: hash,
      status: res.status, buildId: extractBuildId(body), notModified: false,
    };
  }
}
