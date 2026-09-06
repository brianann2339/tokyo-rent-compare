/**
 * 「原站明明寫了，我們卻說沒寫」的稽核工具。
 *
 * 由來：2026-09-06 的第一份稽核報告發現全站 `unparsed` 只有 30 筆、
 * `not_listed_on_page` 有 375 萬筆——健康監控唯一不需基線就有意義的故障訊號
 * 等於是關著的，所有漏抓都躲在「這一頁沒寫」底下。
 *
 * 這支腳本把那個一次性的掃描變成可重跑的稽核：
 * 掃真相層每一個 `known:false & why:'not_listed_on_page'` 的欄位，
 * 挑出 **srcText 裡含數字** 的組合——那是「原文有值卻說沒寫」的訊號。
 *
 * ⚠️ 這個訊號會有偽陽性，而且必須由人判：
 *   - 真陽性：`階 1-2階`（頁面寫了樓層）、`保証会社必要`（頁面寫了條件）
 *   - 偽陽性：srcText 是我們自己寫的說明句（「詳情頁有『損保』欄，首版只讀一覧頁」），
 *             或是月數已知但賃料未知所以不換算（「家賃1カ月分（賃料未知，不換算）」）
 * 所以下面的 REVIEWED 是**人審過的白名單**：審過就記在這裡，
 * 之後每次跑只會浮出新的組合。清單裡的每一條都寫了審核當下的判斷理由。
 *
 * 用法：
 *   node crawler/src/cli/audit-why.ts            # 只印新出現的可疑組合
 *   node crawler/src/cli/audit-why.ts --all      # 連已審核的一起印
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DATA_ROOT } from '../http.ts';
import { readNdjsonGz } from '../ndjson.ts';
import type { Listing } from '../../../packages/schema/src/model.ts';

/**
 * 人審過、判定為「不是漏抓」的組合，key 是 `{來源}|{欄位路徑}`。
 * 值是判定理由——沒有理由的白名單就只是把警報關掉。
 */
const REVIEWED: Record<string, string> = {
  'suumo|deferred.renewalFee': 'srcText 是我們自己寫的說明句（「詳情頁未見更新料欄」），數字來自句中的「1 頁」',
  'suumo|deferred.renewalAdminFee': '同上',
  'suumo|stations.walkMinutes': '原文是バス路線（「バス5分 (バス停)…歩4分」），那不是從車站步行的時間，刻意不採用',
  'leopalace21|stations.walkMinutes': '同上，srcText 已寫明「需搭公車 N 分，徒歩分不是從車站起算」',
  'ur|stations.walkMinutes': '同上',
  'tokyosharehouse|stations.walkMinutes': '原文未寫交通方式，不視為步行時間（srcText 已載明）',
  'hituji|stations.walkMinutes': '原文是「バス9」，公車時間不是步行時間',
  'hituji|monthly.utilities': 'payload 的 utilities 是共益費的重複顯示，收下來會讓月額灌水一倍（見 hituji/index.ts）',
  'hituji|foreigner.guarantorPersonRequired': '入居条件寫的是緊急連絡先，沒說要不要連帶保證人',
  'hituji|foreigner.guarantorCompanyRequired': '同上',
  'hituji|foreigner.japaneseRequired': '同上',
  'hituji|foreigner.residenceCardRequired': '同上',
  'hituji|minStayMonths': '只寫「長期」的頁面沒有月數；有級距的已於 2026-09-06 改為 known',
  'sakurahouse|areaM2': 'dormitory 的床位沒有專有面積，srcText 已寫明整間 N㎡ 是共用',
  'borderless|areaM2': '同上（Size 是兩人共用的整間面積）',
  'tokyosharehouse|areaM2': '原站自己寫「0 ㎡」，0 不是面積；保留原文不採用',
  'tokyosharehouse|initial.deposit': '「家賃1カ月分」是倍數，賃料未知時不換算',
  'tokyosharehouse|initial.depositNonRefundable': '保証金欄沒有括號＝原站沒說退不退，月數是保証金本身的數字',
  'oakhouse|furnished': 'srcText 是整段徽章文字，其中沒有任何家具相關字樣',
  'oakhouse|foreigner.welcomed': '站方只印「外国人入居可」，沒有任何否定寫法（實測 992 頁 0 筆），所以沒印＝沒說',
  'socialapartment|deferred.earlyTerminationPenalty': '違約金依方案而異（1年プラン 1 個月／2年プラン 2 個月），沒有單一金額',
  'socialapartment|contractMonths': '同上，站方列的是多個方案不是一個契約期間',
  'villagehouse|minStayMonths': 'srcText 是解約違約金條文，站方沒有規定最短居住期間',
  'oakhouse|floor': 'data-floor="-1" 是站方的未設定哨兵，不是地下樓層（實測 8 頁房號全在 1 樓）',
  'oakhouse|initial.agencyFee': '站方只印「仲介手数料なし」，沒有任何「あり」寫法（實測 992 頁 0 筆），所以沒印＝沒說',
  'sakurahouse|floor': '`B1F` 已於 2026-09-06 改成 −1，但這個來源只能用真人在場的瀏覽器抓、沒有 data/raw/，'
    + '真相層要等下次人工重抓才會更新',
};

type Row = { key: string; n: number; withNum: number; sample: string };

function walk(src: string, prefix: string, node: unknown, out: Map<string, Row>): void {
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o['known'] === 'boolean' && 'basis' in o) {
    if (o['known'] === true) return;
    if (o['why'] !== 'not_listed_on_page') return;
    // statedNoAmount()：原站明講有這筆費用、只是沒寫金額。
    // 它刻意用 why='not_listed_on_page' + basis='excluded_stated'（金額確實沒寫），
    // 是已經表達清楚的狀態，不是漏抓——原文裡的數字是同一段徽章文字帶進來的。
    if (o['basis'] === 'excluded_stated') return;
    const srcText = typeof o['srcText'] === 'string' ? o['srcText'] : '';
    const key = `${src}|${prefix}`;
    const row = out.get(key) ?? { key, n: 0, withNum: 0, sample: '' };
    row.n += 1;
    if (/\d/.test(srcText)) {
      row.withNum += 1;
      if (row.sample === '') row.sample = srcText.slice(0, 100).replace(/\s+/g, ' ');
    }
    out.set(key, row);
    return;
  }
  if (Array.isArray(node)) { for (const x of node) walk(src, prefix, x, out); return; }
  for (const [k, v] of Object.entries(o)) {
    // notes／imageUrls 是自由文字與 URL 陣列，不是 Field
    if (k === 'notes' || k === 'imageUrls') continue;
    walk(src, prefix === '' ? k : `${prefix}.${k}`, v, out);
  }
}

async function main(): Promise<void> {
  const showAll = process.argv.includes('--all');
  const dir = path.join(DATA_ROOT, 'normalized');
  const rows = new Map<string, Row>();
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.ndjson.gz')).sort()) {
    const src = f.replace('.ndjson.gz', '');
    for await (const l of readNdjsonGz<Listing>(path.join(dir, f))) {
      walk(src, '', l.building, rows);
      for (const u of l.units) walk(src, '', u, rows);
    }
  }

  const suspects = [...rows.values()]
    .filter((r) => r.withNum > 0)
    .filter((r) => showAll || REVIEWED[r.key] === undefined)
    .sort((a, b) => b.withNum - a.withNum);

  const total = [...rows.values()].reduce((s, r) => s + r.n, 0);
  console.log(`真相層 not_listed_on_page 共 ${total.toLocaleString()} 筆；`
    + `srcText 含數字的組合 ${[...rows.values()].filter((r) => r.withNum > 0).length} 組，`
    + `其中人審過 ${Object.keys(REVIEWED).length} 組。`);
  if (suspects.length === 0) {
    console.log('✔ 沒有未審核的新可疑組合。');
    return;
  }
  console.log(`\n⚠️ ${suspects.length} 組需要人判（原文裡有數字，卻宣稱「這一頁沒寫」）：`);
  for (const r of suspects) {
    const mark = REVIEWED[r.key] === undefined ? '' : `  ← 已審：${REVIEWED[r.key]}`;
    console.log(`  ${String(r.withNum).padStart(7)} / ${String(r.n).padEnd(7)} ${r.key}${mark}`);
    console.log(`          例：${r.sample}`);
  }
  console.log('\n判完請把結論寫進 crawler/src/cli/audit-why.ts 的 REVIEWED，'
    + '或修好解析器讓那個欄位變成 known／unparsed。');
  process.exitCode = 1;
}

await main();
