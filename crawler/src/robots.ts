/**
 * robots.txt 解析與驗證。
 *
 * 硬性規則：每次執行都重新抓、重新解析，**絕不把查證結果硬編碼進程式**。
 * robots.txt 會變；硬編碼會讓我們在對方改規則之後還在爬。
 * sha256 變動時停掉該來源並告警，由人重新檢視。
 */

import { createHash } from 'node:crypto';

export type RobotsRules = {
  readonly raw: string;
  readonly sha256: string;
  /** 適用於我方 UA 的規則（合併 `*` 與具名群組） */
  readonly disallow: readonly string[];
  readonly allow: readonly string[];
  readonly crawlDelaySec: number | null;
  readonly sitemaps: readonly string[];
  /** robots.txt 本身取不到（404 等）時為 true——代表「沒有明示禁止」，不等於「明示允許」 */
  readonly absent: boolean;
};

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 解析 robots.txt。
 * 群組合併規則：先取 `*` 群組，再套用具名 UA 群組（具名優先，符合 RFC 9309 的精神）。
 */
export function parseRobots(text: string, ourAgent: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; delay: number | null }> = [];
  const sitemaps: string[] = [];

  let current: { agents: string[]; disallow: string[]; allow: string[]; delay: number | null } | null = null;
  let lastWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], disallow: [], allow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (key === 'disallow') current.disallow.push(value);
    else if (key === 'allow') current.allow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.delay = n;
    }
  }

  const ua = ourAgent.toLowerCase();
  const starGroups = groups.filter((g) => g.agents.includes('*'));
  const namedGroups = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = namedGroups.length > 0 ? namedGroups : starGroups;

  return {
    raw: text,
    sha256: sha256(text),
    disallow: chosen.flatMap((g) => g.disallow).filter((d) => d !== ''),
    allow: chosen.flatMap((g) => g.allow),
    crawlDelaySec: chosen.reduce<number | null>((acc, g) => (g.delay !== null ? Math.max(acc ?? 0, g.delay) : acc), null),
    sitemaps,
    absent: false,
  };
}

export function absentRobots(): RobotsRules {
  return { raw: '', sha256: sha256(''), disallow: [], allow: [], crawlDelaySec: null, sitemaps: [], absent: true };
}

/**
 * robots.txt 的路徑樣式比對。支援 `*` 萬用與 `$` 結尾錨定，
 * 這是 Google/RFC 9309 的擴充語法，各大站（Oak House 的 `Disallow: *p=`）都在用。
 */
function patternToRegex(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '$') out += '$';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  // robots 規則是「前綴比對」，除非有 $ 錨定
  return new RegExp('^' + (out.startsWith('.*') ? '' : '') + out);
}

function matchLen(pattern: string, pathAndQuery: string): number {
  // `Disallow: *p=` 這種不是以 / 開頭的樣式，語意是「路徑中任何位置含此樣式」
  const anchored = pattern.startsWith('/');
  const re = anchored
    ? patternToRegex(pattern)
    : new RegExp(pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\*/g, '.*'));
  return re.test(pathAndQuery) ? pattern.length : -1;
}

export type RobotsDecision = {
  readonly allowed: boolean;
  readonly reason: string;
};

/**
 * 判斷某 URL 是否被允許。
 * 依 RFC 9309：最長匹配的規則勝出；同長度時 Allow 優先。
 */
export function isAllowed(rules: RobotsRules, url: string): RobotsDecision {
  if (rules.absent) return { allowed: true, reason: 'robots.txt 不存在（無明示禁止）' };
  const u = new URL(url);
  const pathAndQuery = u.pathname + u.search;

  let bestDisallow = -1;
  let bestDisallowPattern = '';
  for (const d of rules.disallow) {
    const len = matchLen(d, pathAndQuery);
    if (len > bestDisallow) { bestDisallow = len; bestDisallowPattern = d; }
  }
  let bestAllow = -1;
  for (const a of rules.allow) {
    const len = matchLen(a, pathAndQuery);
    if (len > bestAllow) bestAllow = len;
  }

  if (bestDisallow < 0) return { allowed: true, reason: '無相符的 Disallow 規則' };
  if (bestAllow >= bestDisallow) return { allowed: true, reason: 'Allow 規則較長或同長，優先' };
  return { allowed: false, reason: `被 robots.txt 規則擋下：Disallow: ${bestDisallowPattern}` };
}

export async function fetchRobots(origin: string, userAgent: string): Promise<RobotsRules> {
  const url = new URL('/robots.txt', origin).toString();
  const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'text/plain' } });
  if (!res.ok) return absentRobots();
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  // 有些站（Couverture）robots.txt 回 200 但內容是 HTML 錯誤頁，不能當規則用
  if (ct.includes('text/html') || /^\s*<(!doctype|html)/i.test(text)) return absentRobots();
  return parseRobots(text, userAgent);
}
