/**
 * 抽樣核對報表。
 *
 * 這個腳本**不驗證任何東西**——它只是把「我們存了什麼」與「原站原文是什麼」
 * 並排印出來，讓人親自開原站逐欄比對。
 *
 * 為什麼不自動比對：自動比對會用我們自己的解析器去讀原站，
 * 同一個盲點會看兩次都看不到。核對必須是人拿原始來源對照。
 *
 * 抽樣量：≥10 筆或全量 10%（取大者），且必含第一筆、最後一筆、最貴、最便宜、
 * 以及缺項最多的那一筆——邊界值最容易出錯。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { DATA_ROOT } from '../http.ts';
import { loadSourceIds } from '../registry.ts';
import type { Listing, Unit } from '../../../packages/schema/src/model.ts';
import type { Field, Yen } from '../../../packages/schema/src/field.ts';
import { monthlyCost, initialCash, initialSunk } from '../../../packages/cost-model/src/index.ts';



const LABEL: Record<string, string> = {
  rent: '賃料', adminFee: '管理費/共益費', utilities: '水電費',
  keyMoney: '禮金', deposit: '敷金', depositNonRefundable: '敷引',
  agencyFee: '仲介手數料', renewalFee: '更新料',
};

function fmt(f: Field<Yen>): string {
  if (f.known) return `¥${f.v.jpy.toLocaleString('ja-JP')} \`${f.srcText}\``;
  return `**未提供**（${f.why}）`;
}

function missingCount(u: Unit): number {
  const all = [
    u.monthly.rent, u.monthly.adminFee, u.monthly.utilities,
    u.initial.keyMoney, u.initial.deposit, u.initial.agencyFee,
  ];
  return all.filter((f) => !f.known).length;
}

/** 確定性的抽樣：同一份資料每次抽到同一批，方便重複核對。 */
function pick(listings: readonly Listing[]): Listing[] {
  const n = Math.max(10, Math.ceil(listings.length * 0.1));
  const withRent = listings.filter((l) => l.units.some((u) => u.monthly.rent.known));
  const rentOf = (l: Listing): number => {
    const r = l.units.find((u) => u.monthly.rent.known)?.monthly.rent;
    return r?.known === true ? r.v.jpy : 0;
  };
  const must = new Set<Listing>();
  const first = listings[0];
  const last = listings[listings.length - 1];
  if (first !== undefined) must.add(first);
  if (last !== undefined) must.add(last);
  if (withRent.length > 0) {
    must.add([...withRent].sort((a, b) => rentOf(b) - rentOf(a))[0] as Listing);
    must.add([...withRent].sort((a, b) => rentOf(a) - rentOf(b))[0] as Listing);
  }
  const worst = [...listings].sort(
    (a, b) => Math.max(...b.units.map(missingCount), 0) - Math.max(...a.units.map(missingCount), 0),
  )[0];
  if (worst !== undefined) must.add(worst);

  // 其餘用等間距取樣（確定性，不用亂數）
  const rest = listings.filter((l) => !must.has(l));
  const need = Math.max(0, n - must.size);
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, need)));
  for (let i = 0; i < rest.length && must.size < n; i += step) {
    const l = rest[i];
    if (l !== undefined) must.add(l);
  }
  return [...must];
}

async function main(): Promise<void> {
  const lines: string[] = [
    '# 抽樣核對表',
    '',
    '**這份報表不代表已驗證。** 請親自開每一個「原站連結」，逐欄比對右邊的原文，',
    '任何一筆對不上 → 全量重驗，不是只修那一筆。',
    '',
    `產生於 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
  ];

  const SOURCES = await loadSourceIds();
  for (const id of SOURCES) {
    const p = path.join(DATA_ROOT, 'normalized', `${id}.ndjson`);
    if (!existsSync(p)) continue;
    const listings = (await readFile(p, 'utf8'))
      .split('\n').filter((x) => x.trim() !== '')
      .map((x) => JSON.parse(x) as Listing);

    const sample = pick(listings);
    lines.push(`## ${id}：全量 ${listings.length} 棟，抽 ${sample.length} 棟`, '');

    for (const [n, l] of sample.entries()) {
      const b = l.building;
      lines.push(`### ${n + 1}. ${b.name}`, '');
      lines.push(`- 原站連結：<${b.sourceUrl}>`);
      lines.push(`- 我們存的：${b.ward} ／ ${b.stations.map((s) => `${s.station}站 ${s.walkMinutes.known ? `徒步${s.walkMinutes.v}分` : '步行時間未提供'}`).join('、') || '車站未提供'}`);
      lines.push(`- 擷取時間：${b.fetchedAt.slice(0, 16).replace('T', ' ')}`);
      lines.push('');
      lines.push('| 房號 | 面積 | 賃料 | 管理費 | 禮金 | 敷金 | 月額 | 初期現金 | 沉沒成本 |');
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const u of l.units.slice(0, 6)) {
        const m = monthlyCost(u);
        const c = initialCash(u);
        const s = initialSunk(u);
        lines.push(
          `| ${u.roomNo.known ? u.roomNo.v : '—'} | ${u.areaM2.known ? `${u.areaM2.v}㎡` : '—'} `
          + `| ${fmt(u.monthly.rent)} | ${fmt(u.monthly.adminFee)} `
          + `| ${fmt(u.initial.keyMoney)} | ${fmt(u.initial.deposit)} `
          + `| ${m.completeness === 'LOWER_BOUND' ? '≥' : ''}¥${m.lower.jpy.toLocaleString('ja-JP')} `
          + `| ¥${c.lower.jpy.toLocaleString('ja-JP')} | ¥${s.lower.jpy.toLocaleString('ja-JP')} |`,
        );
      }
      if (l.units.length > 6) lines.push(`| …另有 ${l.units.length - 6} 間 | | | | | | | | |`);
      const caveats = [...new Set(l.units.flatMap((u) => [...monthlyCost(u).caveats, ...initialSunk(u).caveats]))];
      if (caveats.length > 0) {
        lines.push('', ...caveats.map((c) => `> ⚠️ ${c}`));
      }
      const fgn = l.units[0]?.foreigner.rawText ?? '';
      if (fgn !== '') lines.push('', '外國人條件原文：', '```', fgn, '```');
      lines.push('');
    }
  }

  await mkdir(path.join(DATA_ROOT, 'health'), { recursive: true });
  const out = path.join(DATA_ROOT, 'health', 'verify-sample.md');
  await writeFile(out, lines.join('\n'), 'utf8');
  console.log(`✔ 抽樣核對表：${path.relative(process.cwd(), out)}`);
  console.log(`  ${LABEL['rent']} 等欄位都附了原站原文，請親自開連結逐欄比對。`);
}

await main();
