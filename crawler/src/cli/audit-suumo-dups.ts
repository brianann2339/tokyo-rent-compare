/**
 * SUUMO 同棟重複刊登的稽核表——給人看的，不是給程式看的。
 *
 * 去重規則上線前，要先拿 50 組回**原始 HTML** 核對：每一列在一覧頁上的原文是不是
 * 真的長一樣。這一步不能用我們自己的解析器驗（同一個盲點看兩次都看不到），
 * 所以這裡只做一件事：用 `htmlSha256` 找回當初抓下來的頁面，
 * 把含該 bukkenCode 的 `<tr>` 原文剝掉標籤後並排印出來。判定留給人。
 *
 * 抽樣是確定性的（最大 10 組 ＋ 2 列組等距 20 組 ＋ 其餘等距 20 組），
 * 同一份資料每次抽到同一批，方便重複核對。
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { DATA_ROOT } from '../http.ts';
import type { Listing, Unit } from '../../../packages/schema/src/model.ts';
import { adMergeKey, mergeDuplicateAds } from '../dedup.ts';

type Group = { listing: Listing; key: string; units: Unit[] };

function fieldText(u: Unit): Record<string, string> {
  const y = (f: { known: boolean; v?: { jpy: number }; srcText: string }): string =>
    f.known && f.v !== undefined ? `¥${f.v.jpy.toLocaleString('ja-JP')}` : `（${f.srcText || '未載明'}）`;
  return {
    階: u.floor.srcText || '—',
    間取: u.layout.known ? u.layout.v : '—',
    面積: u.areaM2.known ? `${u.areaM2.v}㎡` : '—',
    賃料: y(u.monthly.rent),
    管理費: y(u.monthly.adminFee),
    敷金: y(u.initial.deposit),
    礼金: y(u.initial.keyMoney),
  };
}

/** 從一覧頁 HTML 找出含該 bukkenCode 的 `<tr>`，剝標籤後回傳原文。 */
function rawRowText(html: string, bc: string): string {
  const idx = html.indexOf(`bc=${bc}`);
  if (idx < 0) return '（原始頁中找不到此 bukkenCode）';
  const start = html.lastIndexOf('<tr', idx);
  const end = html.indexOf('</tr>', idx);
  if (start < 0 || end < 0) return '（找不到包住它的 <tr>）';
  return html.slice(start, end)
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function pickSample(groups: Group[]): Group[] {
  const bySize = [...groups].sort((a, b) => b.units.length - a.units.length || a.key.localeCompare(b.key));
  const top = bySize.slice(0, 10);
  const topSet = new Set(top);
  const twos = groups.filter((g) => g.units.length === 2 && !topSet.has(g));
  const rest = groups.filter((g) => g.units.length > 2 && !topSet.has(g));
  const evenly = (arr: Group[], n: number): Group[] => {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)] as Group);
  };
  return [...top, ...evenly(twos, 20), ...evenly(rest, 20)];
}

async function main(): Promise<void> {
  const src = path.join(DATA_ROOT, 'normalized', 'suumo.ndjson.gz');
  const listings = gunzipSync(await readFile(src)).toString('utf8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Listing);

  // raw 檔 sha256 → 路徑（對應 building.htmlSha256）
  const rawDir = path.join(DATA_ROOT, 'raw', 'suumo');
  const shaToFile = new Map<string, string>();
  for (const f of await readdir(rawDir)) {
    if (!f.endsWith('.html.gz')) continue;
    const body = gunzipSync(await readFile(path.join(rawDir, f))).toString('utf8');
    shaToFile.set(createHash('sha256').update(body, 'utf8').digest('hex'), path.join(rawDir, f));
  }

  const groups: Group[] = [];
  let totalUnits = 0; let removed = 0; let suspect = 0; let groupCount = 0;
  for (const l of listings) {
    totalUnits += l.units.length;
    const r = mergeDuplicateAds(l.units);
    removed += r.removed; suspect += r.suspectOnly; groupCount += r.groups;
    if (r.groups === 0) continue;
    const byKey = new Map<string, Unit[]>();
    for (const u of l.units) {
      const k = adMergeKey(u);
      (byKey.get(k) ?? byKey.set(k, []).get(k) as Unit[]).push(u);
    }
    for (const [key, units] of byKey) if (units.length > 1) groups.push({ listing: l, key, units });
  }

  const sample = pickSample(groups);
  const lines: string[] = [
    '# SUUMO 同棟重複刊登 稽核表',
    '',
    '**這份表不代表已驗證。** 每組把我們解析出的欄位，與原始一覧頁 HTML 中含該 bukkenCode 的列原文並排。',
    '請逐組看「一覧頁原文」是否確實相同；任一組不同 → 合併鍵要加欄位重審，不可只修那一組。',
    '',
    `產生於 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '## 總覽',
    '',
    `- 房間總數 ${totalUnits.toLocaleString()}；7 元組相同的組數 ${groupCount.toLocaleString()}；合併後將移除 ${removed.toLocaleString()} 列`,
    `- 疑似（5 元組相同、但敷金／礼金不同，**保守不併**）${suspect.toLocaleString()} 列`,
    `- 本表抽樣 ${sample.length} 組（最大 10 組＋2 列組等距 20＋其餘等距 20）`,
    `- 原始頁可回溯：${shaToFile.size} 個 raw 檔`,
    '',
    '## 核對結果',
    '',
    '（人工填寫）核對日期：　　　　／ 核對 50 組中判「同一房」：　　組／ 判「不同」：　　組',
    '',
  ];

  for (const [n, g] of sample.entries()) {
    const b = g.listing.building;
    const rawPath = shaToFile.get(b.htmlSha256);
    const html = rawPath === undefined ? null : gunzipSync(await readFile(rawPath)).toString('utf8');
    lines.push(`### ${n + 1}. ${b.name}（${b.ward}）— ${g.units.length} 列`, '');
    lines.push(`- 建物頁（主列）：<${b.sourceUrl}>`);
    lines.push(`- 原始頁：${rawPath === undefined ? '**找不到（sha 不符）**' : path.basename(rawPath)}`);
    lines.push('');
    lines.push('| bc | jnc | 階 | 間取 | 面積 | 賃料 | 管理費 | 敷金 | 礼金 | 一覧頁原文 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const u of g.units) {
      const f = fieldText(u);
      const jnc = /jnc_(\d+)/.exec(u.sourceUrl)?.[1] ?? '?';
      const raw = html === null ? '（無原始頁）' : rawRowText(html, u.unitKey);
      lines.push(`| ${u.unitKey} | ${jnc} | ${f['階']} | ${f['間取']} | ${f['面積']} | ${f['賃料']} | ${f['管理費']} | ${f['敷金']} | ${f['礼金']} | ${raw.replace(/\|/g, '｜')} |`);
    }
    lines.push('', '人工判定：同一房？ [ ]', '');
  }

  await mkdir(path.join(DATA_ROOT, 'health'), { recursive: true });
  const out = path.join(DATA_ROOT, 'health', 'audit-suumo-dups.md');
  await writeFile(out, lines.join('\n'), 'utf8');
  console.log(`✔ 稽核表：${path.relative(process.cwd(), out)}`);
  console.log(`  房間 ${totalUnits}｜組 ${groupCount}｜將移除 ${removed}｜疑似不併 ${suspect}｜抽樣 ${sample.length} 組｜raw 可回溯 ${shaToFile.size} 檔`);
}

await main();
