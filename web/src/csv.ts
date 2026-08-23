/**
 * 把目前篩選結果匯出成 CSV（Excel 直接開：BOM ＋ CRLF ＋ 全欄加引號）。
 * 未知值一律空字串——絕不寫 0，0 在這裡是「零円」的意思。
 */

import { buildingStations, monthlyWithAssumption, type Wire, type Row } from './data.ts';

const HEADER = [
  '來源', '物件名', '区', '種類', '房型', '面積㎡', '樓層', '築年',
  '車站1', '徒歩1', '車站2', '徒歩2', '車站3', '徒歩3',
  '賃料', '管理費', '水電', '水電基準',
  '禮金', '敷金', '敷引', '月額下限', '月額區', '初期現金', '初期現金區', '沉沒成本',
  '實質月成本12', '每㎡單價', '缺項', '外國人可租', '性別', '空室', '仲介數', '確認日', '原站URL',
];

const TIER_ZH = ['A', 'B', 'C'];
const UTIL_ZH = ['', '含', '另計'];
const GENDER_ZH = ['', '男女皆可', '女性專用', '男性專用'];
const KIND_ZH: Record<string, string> = {
  unknown: '', apartment: '一般賃貸', sharehouse: '共居（個室）', social: '共居（Social）', dormitory: '共居（多人房）',
};
const MISSING_ZH: Record<string, string> = {
  rent: '賃料', adminFee: '管理費', utilities: '水電', keyMoney: '禮金', deposit: '敷金',
  depositNonRefundable: '敷引', agencyFee: '仲介', guarantorInitialFee: '保證公司',
  fireInsurance: '火災保險', renewalFee: '更新料',
};

const yesNo = (v: number | undefined): string => (v === 1 ? '是' : v === 0 ? '否' : '');
const num = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
const cell = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export function rowsToCsv(wire: Wire, rows: readonly Row[], opts: { assumeUtil: number | null }): string {
  const { u, b, dict, meta } = wire;
  const lines = [HEADER.map(cell).join(',')];
  for (const r of rows) {
    const i = r.i;
    const bi = u.bid[i] as number;
    const srcId = dict.sources[b.src[bi] as number] ?? '';
    const tier = u.monthlyTier[i] as number;
    const area = u.area[i] ?? null;
    // 賃料未知（C 區）時 monthlyLower／initCash／initSunk／effMonthly12 只是管理費等的殘值，
    // 寫出來會變成一個看起來合理但完全錯誤的數字——一律留空。
    const rentKnown = u.rent[i] !== null && u.rent[i] !== undefined;
    const monthly = rentKnown ? monthlyWithAssumption(wire, i, opts.assumeUtil) : null;
    const assumed = monthly === null ? 0 : monthly - (u.monthlyLower[i] as number);
    const eff12 = rentKnown ? (u.effMonthly12[i] as number) + assumed : null;
    const perM2 = monthly !== null && tier === 0 && area !== null && area > 0 ? Math.round(monthly / area) : null;
    const sts = buildingStations(wire, bi);
    const st = (k: number): [string, string] => {
      const s = sts[k];
      return s === undefined ? ['', ''] : [s.name, num(s.walk)];
    };
    const mask = u.missing[i] as number;
    const missing = meta.missingBits
      .filter((_, k) => (mask & (1 << k)) !== 0)
      .map((id) => MISSING_ZH[id] ?? id)
      .join('/');
    const layoutIdx = u.layout[i] as number;
    const fields = [
      dict.sourceMeta[srcId]?.nameZh ?? srcId,
      b.name[bi] ?? '',
      dict.wards[b.ward[bi] as number] ?? '',
      KIND_ZH[dict.kinds[b.kind[bi] as number] ?? 'unknown'] ?? '',
      layoutIdx >= 0 ? (dict.layouts[layoutIdx] ?? '') : '',
      num(area), num(u.floor[i]), num(b.yearBuilt[bi]),
      ...st(0), ...st(1), ...st(2),
      num(u.rent[i]), num(u.admin[i]), num(u.util[i]),
      UTIL_ZH[u.utilBasis[i] as number] ?? '',
      num(u.key[i]), num(u.dep[i]), num(u.depNR[i]),
      num(monthly), TIER_ZH[tier] ?? '',
      rentKnown ? num(u.initCash[i]) : '', TIER_ZH[u.initCashTier[i] as number] ?? '',
      rentKnown ? num(u.initSunk[i]) : '',
      num(eff12),
      num(perM2),
      missing,
      yesNo(u.foreigner[i]), GENDER_ZH[u.gender[i] as number] ?? '', yesNo(u.vacant[i]),
      num(u.ads[i]),
      b.fetchedAt[bi] ?? '', b.url[bi] ?? '',
    ];
    lines.push(fields.map(cell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFileName(n: number, now: Date = new Date()): string {
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `tokyo-rent-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${n}.csv`;
}

export function downloadCsv(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
