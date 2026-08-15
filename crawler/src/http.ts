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

export class HttpFetcher implements Fetcher {
  #manifest: SourceManifest;
  #robots: RobotsRules;
  #delayMs: number;
  #lastRequestAt = 0;
  #useCache: boolean;

  stats = { requests: 0, notModified: 0, blocked: 0, errors: 0, fromDisk: 0 };

  private constructor(manifest: SourceManifest, robots: RobotsRules, useCache: boolean) {
    this.#manifest = manifest;
    this.#robots = robots;
    this.#useCache = useCache;
    // robots.txt 的 Crawl-delay 若比我方設定嚴格，以對方為準
    const robotsDelay = (robots.crawlDelaySec ?? 0) * 1000;
    this.#delayMs = Math.max(manifest.crawlDelayMs, robotsDelay);
  }

  static async create(manifest: SourceManifest, opts: { useCache?: boolean } = {}): Promise<HttpFetcher> {
    const robots = await fetchRobots(manifest.origin, USER_AGENT);
    return new HttpFetcher(manifest, robots, opts.useCache ?? true);
  }

  get robots(): RobotsRules { return this.#robots; }
  get delayMs(): number { return this.#delayMs; }

  /** robots.txt 是否與上次查證時相同。不同代表對方改了規則，該停下來重新檢視。 */
  robotsChanged(): boolean {
    const known = this.#manifest.legal.robotsSha256;
    return known !== null && known !== this.#robots.sha256;
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

    const cached = this.#useCache ? await readCache(this.#manifest.id, url) : null;
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja,en;q=0.8',
      ...opts.headers,
    };
    if (cached?.etag !== undefined) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified !== undefined) headers['If-Modified-Since'] = cached.lastModified;

    await this.#throttle();
    this.stats.requests += 1;

    const res = await fetch(url, { headers, redirect: 'follow' });

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
