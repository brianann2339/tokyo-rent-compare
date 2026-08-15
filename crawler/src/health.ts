/**
 * 解析健康度。
 *
 * 兩件事要分清楚：
 *  - 填充率監控抓得到「來源改版，某欄位突然全空」
 *  - 但抓不到「把 1ヶ月 解析成 1 円」——值全錯而填充率仍是 100%
 * 後者只有黃金 fixture 測試抓得到。兩者互補，缺一不可。
 */

import type { Field } from '../../packages/schema/src/field.ts';
import type { Listing, AnyFieldId } from '../../packages/schema/src/model.ts';
import type { SourceManifest } from './types.ts';

export type FieldStat = {
  applicable: number;   // 只計入 capabilities.provides 的欄位
  measured: number;
  notListed: number;
  unparsed: number;     // ← 唯一的故障訊號
  conflicting: number;
  notOffered: number;
};

export type SourceHealth = {
  readonly sourceId: string;
  readonly runAt: string;
  readonly buildings: number;
  readonly units: number;
  readonly robotsSha256: string;
  readonly robotsChanged: boolean;
  readonly buildIds: readonly string[];
  readonly fields: Record<string, FieldStat>;
};

function blank(): FieldStat {
  return { applicable: 0, measured: 0, notListed: 0, unparsed: 0, conflicting: 0, notOffered: 0 };
}

function tally(stat: FieldStat, f: Field<unknown>): void {
  stat.applicable += 1;
  if (f.known) { stat.measured += 1; return; }
  switch (f.why) {
    case 'not_listed_on_page': stat.notListed += 1; break;
    case 'unparsed': stat.unparsed += 1; break;
    case 'conflicting': stat.conflicting += 1; break;
    case 'not_offered_by_source': stat.notOffered += 1; break;
  }
}

export function collectHealth(
  manifest: SourceManifest,
  listings: readonly Listing[],
  meta: { robotsSha256: string; robotsChanged: boolean; buildIds: readonly string[]; runAt: string },
): SourceHealth {
  const fields: Record<string, FieldStat> = {};
  const get = (k: string): FieldStat => (fields[k] ??= blank());

  let units = 0;
  for (const { building, units: us } of listings) {
    tally(get('yearBuilt'), building.yearBuilt);
    tally(get('structure'), building.structure);
    tally(get('totalUnits'), building.totalUnits);
    tally(get('sourceUpdatedAt'), building.sourceUpdatedAt);
    const st = get('stations');
    st.applicable += 1;
    if (building.stations.length > 0 && building.stations[0]?.walkMinutes.known === true) st.measured += 1;
    else st.notListed += 1;

    for (const u of us) {
      units += 1;
      tally(get('rent'), u.monthly.rent);
      tally(get('adminFee'), u.monthly.adminFee);
      tally(get('utilities'), u.monthly.utilities);
      tally(get('keyMoney'), u.initial.keyMoney);
      tally(get('deposit'), u.initial.deposit);
      tally(get('depositNonRefundable'), u.initial.depositNonRefundable);
      tally(get('agencyFee'), u.initial.agencyFee);
      tally(get('guarantorInitialFee'), u.initial.guarantorInitialFee);
      tally(get('fireInsurance'), u.initial.fireInsurance);
      tally(get('renewalFee'), u.deferred.renewalFee);
      tally(get('earlyTerminationPenalty'), u.deferred.earlyTerminationPenalty);
      tally(get('areaM2'), u.areaM2);
      tally(get('layout'), u.layout);
      tally(get('roomNo'), u.roomNo);
      tally(get('floor'), u.floor);
      tally(get('availableFrom'), u.availableFrom);
      tally(get('isVacant'), u.isVacant);
      tally(get('furnished'), u.furnished);
      tally(get('minStayMonths'), u.minStayMonths);
      tally(get('contractMonths'), u.contractMonths);
      tally(get('ageLimitRaw'), u.ageLimitRaw);
      tally(get('petsAllowed'), u.petsAllowed);
      tally(get('foreignerWelcomed'), u.foreigner.welcomed);
      tally(get('residenceCardRequired'), u.foreigner.residenceCardRequired);
      tally(get('japaneseRequired'), u.foreigner.japaneseRequired);
      tally(get('guarantorCompanyRequired'), u.foreigner.guarantorCompanyRequired);

      const g = get('genderRestriction');
      g.applicable += 1;
      if (u.genderRestriction === 'unknown') g.notListed += 1; else g.measured += 1;
      const cb = get('contractType');
      cb.applicable += 1;
      if (u.contractType === 'unknown') cb.notListed += 1; else cb.measured += 1;
      const ub = get('utilitiesBasis');
      ub.applicable += 1;
      if (u.utilitiesBasis === 'unknown') ub.notListed += 1; else ub.measured += 1;
    }
  }

  return {
    sourceId: manifest.id,
    runAt: meta.runAt,
    buildings: listings.length,
    units,
    robotsSha256: meta.robotsSha256,
    robotsChanged: meta.robotsChanged,
    buildIds: meta.buildIds,
    fields,
  };
}

/** 有效填充率：分母排除「來源根本不提供」的部分，否則會產生永遠 0% 的假警報。 */
export function fillRate(s: FieldStat): number | null {
  const denom = s.applicable - s.notOffered;
  if (denom <= 0) return null;
  return s.measured / denom;
}

export type Alert = { level: 'RED' | 'YELLOW'; fieldId: string; message: string };

/**
 * 告警需要**絕對差 + 相對比 + 小樣本護欄**三者同時成立。
 * 只用相對比會對低填充率欄位過度敏感；只用絕對差對高填充率欄位不夠敏感。
 */
export function compareToBaseline(
  current: SourceHealth,
  baseline: Record<string, number> | null,
): readonly Alert[] {
  if (baseline === null) return [];
  const out: Alert[] = [];
  for (const [fieldId, stat] of Object.entries(current.fields)) {
    const base = baseline[fieldId];
    if (base === undefined) continue;
    const denom = stat.applicable - stat.notOffered;
    if (denom < 30) continue;
    const rate = stat.measured / denom;
    if (rate < base - 0.15 && rate < base * 0.6) {
      out.push({ level: 'RED', fieldId, message: `填充率 ${(rate * 100).toFixed(1)}%（基線 ${(base * 100).toFixed(1)}%）` });
    } else if (rate < base - 0.08) {
      out.push({ level: 'YELLOW', fieldId, message: `填充率 ${(rate * 100).toFixed(1)}%（基線 ${(base * 100).toFixed(1)}%）` });
    }
  }
  // unparsed 是解析器壞掉的直接證據，不需要基線就有意義
  for (const [fieldId, stat] of Object.entries(current.fields)) {
    if (stat.unparsed > 0 && stat.unparsed / Math.max(1, stat.applicable) > 0.1) {
      out.push({ level: 'RED', fieldId, message: `${stat.unparsed} 筆解析失敗（有文字但解不出來）` });
    }
  }
  return out;
}

/** 取最近 N 次執行的中位數當基線——用中位數，一次異常不會污染基線。 */
export function medianBaseline(history: readonly SourceHealth[]): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const h of history) {
    for (const [k, s] of Object.entries(h.fields)) {
      const r = fillRate(s);
      if (r !== null) (acc[k] ??= []).push(r);
    }
  }
  const out: Record<string, number> = {};
  for (const [k, arr] of Object.entries(acc)) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const v = sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : sorted[mid];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const ZH_LABEL: Partial<Record<AnyFieldId | string, string>> = {
  rent: '賃料', adminFee: '管理費/共益費', utilities: '水電費', utilitiesBasis: '水電是否含',
  keyMoney: '禮金', deposit: '敷金', depositNonRefundable: '敷引（不退部分）',
  agencyFee: '仲介手數料', guarantorInitialFee: '保證公司初回', fireInsurance: '火災保險',
  renewalFee: '更新料', earlyTerminationPenalty: '短期解約違約金',
  areaM2: '面積', layout: '房型', roomNo: '房號', floor: '樓層',
  availableFrom: '可入住日', isVacant: '空室', furnished: '附傢俱',
  minStayMonths: '最短居住期間', contractMonths: '契約期間', contractType: '契約種類',
  genderRestriction: '性別限制', ageLimitRaw: '年齡限制', petsAllowed: '可養寵物',
  foreignerWelcomed: '外國人可租', residenceCardRequired: '需在留卡',
  japaneseRequired: '需日語能力', guarantorCompanyRequired: '需保證公司',
  stations: '車站與步行', yearBuilt: '築年', structure: '構造', totalUnits: '總戶數',
  sourceUpdatedAt: '來源更新日',
};

export function renderMarkdown(healths: readonly SourceHealth[], alerts: Record<string, readonly Alert[]>): string {
  const lines: string[] = ['# 資料健康報告', ''];
  for (const h of healths) {
    lines.push(`## ${h.sourceId}`, '');
    lines.push(`- 執行時間：${h.runAt}`);
    lines.push(`- 建物 ${h.buildings} 棟 / 房間 ${h.units} 間`);
    lines.push(`- robots.txt sha256：\`${h.robotsSha256.slice(0, 16)}…\`${h.robotsChanged ? ' **⚠️ 已變動**' : ''}`);
    if (h.buildIds.length > 0) lines.push(`- 來源 buildId：${h.buildIds.map((b) => `\`${b}\``).join(', ')}`);
    const a = alerts[h.sourceId] ?? [];
    lines.push(a.length === 0 ? '- 告警：無' : `- 告警：${a.map((x) => `**${x.level}** ${x.fieldId}（${x.message}）`).join('；')}`);
    lines.push('', '| 欄位 | 有效填充率 | 已取得 | 頁面未寫 | 解析失敗 | 來源不提供 |', '|---|---:|---:|---:|---:|---:|');
    const rows = Object.entries(h.fields).sort((x, y) => (fillRate(y[1]) ?? -1) - (fillRate(x[1]) ?? -1));
    for (const [k, s] of rows) {
      const r = fillRate(s);
      const label = ZH_LABEL[k] ?? k;
      lines.push(`| ${label} | ${r === null ? '—' : `${(r * 100).toFixed(1)}%`} | ${s.measured} | ${s.notListed} | ${s.unparsed} | ${s.notOffered} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
