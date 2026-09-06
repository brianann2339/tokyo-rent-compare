/**
 * NDJSON 真相層 → 網站用的欄式 JSON。
 *
 * 這個腳本是「不虛構」真正落地的地方：驗證閘門在寫出任何檔案**之前**執行，
 * 任一條失敗就 exit 非零、不產出檔案。規則寫在程式裡，就不會有人「忘記遵守」。
 *
 * 為什麼用欄式（struct-of-arrays）：實測 5,000 筆 × 27 欄，
 * 列物件 363 KB gzip、列元組 311 KB、欄式 254 KB；Int32 二進位反而打不贏欄式
 * （小整數的十進位表示比固定 4 bytes 省，gzip 又吃得很好）。
 *
 * 去重做在這裡、不做在真相層：真相層保持「一列刊登＝一列」，
 * 合併只是呈現層的決定，隨時可以改規則重建而不用重抓。
 */

import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { readNdjsonGz } from '../ndjson.ts';
import { encodeIndex, decodeIndex, assertLossless, type ColumnIndex } from '../../../packages/wire-codec/src/index.ts';

import { DATA_ROOT } from '../http.ts';
import { loadSourceIds } from '../registry.ts';
import { mergeDuplicateAds, type MergeInfo } from '../dedup.ts';
import { findCandidates, crossSourceRoomHits, type AliasFile } from './alias-candidates.ts';
import type { Listing, Unit, Building, PropertyKind } from '../../../packages/schema/src/model.ts';
import type { Field, Yen } from '../../../packages/schema/src/field.ts';
import { parseLayout } from '../../../packages/jp-parse/src/layout.ts';
import {
  monthlyCost, initialCash, initialSunk, effectiveMonthly, tierOf,
} from '../../../packages/cost-model/src/index.ts';
import {
  checkRentRange, checkAgencyFeeCap, checkAreaRange, checkYearBuilt,
  checkMonthlyAtLeastRent, checkDepositNonRefundable, type Violation,
} from '../../../packages/schema/src/invariants.ts';

// 這兩個路徑可用環境變數覆蓋——閘門的端到端測試要能在臨時目錄跑，
// 否則「無 alias 必須 exit 非零」只能靠讀程式碼相信，不能實際證明。
const DATA = process.env['TOKYO_RENT_DATA_ROOT'] ?? DATA_ROOT;
const OUT_DIR = process.env['TOKYO_RENT_OUT_DIR'] ?? path.resolve(import.meta.dirname, '../../../web/public/data');
/** provenance 每桶的 unit 數。桶位由序號直算，改這個值要連同舊桶一起重建。 */
const PROV_BUCKET = 400;
const ALIAS_FILE = path.join(DATA, 'aliases', 'buildings.json');

const UTIL_BASIS = { unknown: 0, included: 1, excluded: 2 } as const;
const GENDER = { unknown: 0, mixed: 1, female_only: 2, male_only: 3 } as const;
const TIER = { A: 0, B: 1, C: 2 } as const;
/** 建物種類字典；順序即索引值，`dict.kinds` 照這個順序輸出。 */
const KINDS: readonly PropertyKind[] = ['unknown', 'apartment', 'sharehouse', 'social', 'dormitory'];

/**
 * 稀疏屬性的位元旗標（填充率 0.01%–2%，只做卡片標籤不做篩選器）。
 * 「✓／✗」各一個位元，兩者皆無＝來源沒寫，和「沒有」是兩回事。
 */
export const FLAG = {
  petsYes: 1, petsNo: 2, furnishedYes: 4, furnishedNo: 8,
  fixedTerm: 16, ordinary: 32, minStayKnown: 64, ageLimitKnown: 128,
  guarantorPersonYes: 256, guarantorPersonNo: 512,
  /**
   * 這間房至少違反一條合理性不變式（面積 14000㎡、賃料 8,800 円 之類）。
   * 值照原文保留——那些數字是原站自己寫的，不是我們編的——但衍生比較
   * （每㎡單價、費用排序）不該把它當一般資料看，所以在這裡標出來。
   * 明細在該房 provenance 的 invariants 欄。
   */
  invariantViolation: 1024,
} as const;

function flagsOf(u: Unit): number {
  let f = 0;
  if (u.petsAllowed.known) f |= u.petsAllowed.v ? FLAG.petsYes : FLAG.petsNo;
  if (u.furnished.known) f |= u.furnished.v ? FLAG.furnishedYes : FLAG.furnishedNo;
  if (u.contractType === 'fixed_term') f |= FLAG.fixedTerm;
  else if (u.contractType === 'ordinary') f |= FLAG.ordinary;
  if (u.minStayMonths.known) f |= FLAG.minStayKnown;
  if (u.ageLimitRaw.known && u.ageLimitRaw.v.trim() !== '') f |= FLAG.ageLimitKnown;
  const gp = u.foreigner.guarantorPersonRequired;
  if (gp.known) f |= gp.v ? FLAG.guarantorPersonYes : FLAG.guarantorPersonNo;
  return f;
}

/**
 * 間取正規化：SUUMO 的「ワンルーム」與其他站的「1R」是同一種房型，
 * 篩選器必須看到同一個值。解得出來用 canonical；解不出來保留原文（不丟成 null）。
 */
function normLayout(f: Field<string>): { v: string | null; raw: string | null } {
  if (!f.known) return { v: null, raw: null };
  const p = parseLayout(f.v);
  const v = p.kind === 'rooms' || p.kind === 'sharehouse' ? p.canonical : f.v;
  return { v, raw: v === f.v ? null : f.v };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** A 區（月額完整可比）且賃料已知的賃料清單——去重前後中位數必須相等的依據。 */
function aTierRents(units: readonly Unit[]): number[] {
  const out: number[] = [];
  for (const u of units) {
    if (u.monthly.rent.known && tierOf(u, monthlyCost(u)) === 'A') out.push(u.monthly.rent.v.jpy);
  }
  return out;
}

/** 建置期閘門。任一 error 出現即中止，不產出檔案。 */
type GateResult = { errors: string[]; warnings: string[]; violations: Violation[] };

/**
 * 閘門 1：金額為 0 但沒有依據 → 失敗。
 *
 * 允許 0 的情況只有兩種：
 *   basis='measured'   且 srcText 非空 → 原站明確說了「0 円／なし／不要」
 *   basis='included_stated'            → 明寫含在別的費用裡
 * basis='unstated' 卻是 0，就代表某處把「不知道」變成了 0——那正是要防的事。
 */
function gateZeroWithoutBasis(fieldId: string, f: Field<Yen>, unitId: string, g: GateResult): void {
  if (!f.known || f.v.jpy !== 0) return;
  if (f.basis === 'included_stated') return;
  if (f.basis === 'measured' && f.srcText.trim() !== '') return;
  g.errors.push(`[閘門1] ${unitId} 的 ${fieldId} 金額為 0 但無依據（basis=${f.basis}, srcText=${JSON.stringify(f.srcText)}）`);
}

/** 閘門 2：宣稱 measured 卻沒有原文出處。 */
function gateMeasuredNeedsSource(fieldId: string, f: Field<unknown>, unitId: string, g: GateResult): void {
  if (f.known && f.basis === 'measured' && f.srcText.trim() === '') {
    g.errors.push(`[閘門2] ${unitId} 的 ${fieldId} 標為 measured 但 srcText 為空——值必須指得出出處`);
  }
}

function moneyFields(u: Unit): ReadonlyArray<readonly [string, Field<Yen>]> {
  return [
    ['rent', u.monthly.rent], ['adminFee', u.monthly.adminFee], ['utilities', u.monthly.utilities],
    ['internet', u.monthly.internet], ['otherMonthly', u.monthly.otherMonthly],
    ['keyMoney', u.initial.keyMoney], ['deposit', u.initial.deposit],
    ['depositNonRefundable', u.initial.depositNonRefundable], ['agencyFee', u.initial.agencyFee],
    ['guarantorInitialFee', u.initial.guarantorInitialFee], ['fireInsurance', u.initial.fireInsurance],
    ['keyExchangeFee', u.initial.keyExchangeFee], ['contractFee', u.initial.contractFee],
    ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront], ['otherInitial', u.initial.otherInitial],
    ['renewalFee', u.deferred.renewalFee], ['renewalAdminFee', u.deferred.renewalAdminFee],
    ['cleaningFeeOnExit', u.deferred.cleaningFeeOnExit],
    ['earlyTerminationPenalty', u.deferred.earlyTerminationPenalty],
  ];
}

/**
 * 閘門 3 + 跨欄位不變式。
 * 閘門 3 違反會中止建置；不變式違反只記錄與標記，值照原文保留
 * （為什麼不降為 conflicting，見 invariants.ts 檔頭）。回傳這間房命中的違反，
 * 呼叫端據此打 FLAG.invariantViolation 並寫進 provenance。
 */
function checkUnit(b: Building, u: Unit, provided: ReadonlySet<string>, g: GateResult): Violation[] {
  for (const [id, f] of moneyFields(u)) {
    gateZeroWithoutBasis(id, f, u.id, g);
    gateMeasuredNeedsSource(id, f, u.id, g);
    if (f.known && !provided.has(id) && f.basis === 'measured') {
      g.errors.push(`[閘門3] ${u.id} 產出了 capabilities.provides 之外的欄位：${id}`);
    }
  }
  gateMeasuredNeedsSource('areaM2', u.areaM2, u.id, g);
  gateMeasuredNeedsSource('layout', u.layout, u.id, g);

  const hits: Violation[] = [];
  const push = (v: Violation | null): void => { if (v !== null) { hits.push(v); g.violations.push(v); } };
  if (u.monthly.rent.known) push(checkRentRange(u.monthly.rent.v.jpy));
  if (u.initial.agencyFee.known && u.monthly.rent.known) {
    push(checkAgencyFeeCap(u.initial.agencyFee.v.jpy, u.monthly.rent.v.jpy));
  }
  if (u.areaM2.known) push(checkAreaRange(u.areaM2.v));
  if (b.yearBuilt.known) push(checkYearBuilt(b.yearBuilt.v));
  if (u.monthly.rent.known) push(checkMonthlyAtLeastRent(monthlyCost(u).lower.jpy, u.monthly.rent.v.jpy));
  if (u.initial.depositNonRefundable.known && u.initial.deposit.known) {
    push(checkDepositNonRefundable(u.initial.depositNonRefundable.v.jpy, u.initial.deposit.v.jpy));
  }
  return hits;
}

const yenOrNull = (f: Field<Yen>): number | null => (f.known ? f.v.jpy : null);
const numOrNull = (f: Field<number>): number | null => (f.known ? f.v : null);
const strOrNull = (f: Field<string>): string | null => (f.known ? f.v : null);
const boolOrNull = (f: Field<boolean>): number => (f.known ? (f.v ? 1 : 0) : -1);

/** 缺項用一個整數的位元遮罩表示，體積成本近乎為零。 */
const MISSING_BITS = [
  'rent', 'adminFee', 'utilities', 'keyMoney', 'deposit', 'depositNonRefundable',
  'agencyFee', 'guarantorInitialFee', 'fireInsurance', 'renewalFee',
] as const;

function missingMask(u: Unit): number {
  const map: Record<string, Field<Yen>> = {
    rent: u.monthly.rent, adminFee: u.monthly.adminFee, utilities: u.monthly.utilities,
    keyMoney: u.initial.keyMoney, deposit: u.initial.deposit,
    depositNonRefundable: u.initial.depositNonRefundable, agencyFee: u.initial.agencyFee,
    guarantorInitialFee: u.initial.guarantorInitialFee, fireInsurance: u.initial.fireInsurance,
    renewalFee: u.deferred.renewalFee,
  };
  let mask = 0;
  MISSING_BITS.forEach((k, i) => { if (map[k]?.known !== true) mask |= 1 << i; });
  return mask;
}

/** 字典編碼器：重複字串只存一次，欄式陣列裡放索引。Map 查找，不用 indexOf 的 O(n)。 */
function dict(): { list: string[]; idx: (v: string) => number } {
  const list: string[] = [];
  const map = new Map<string, number>();
  return {
    list,
    idx: (v: string): number => {
      const i = map.get(v);
      if (i !== undefined) return i;
      list.push(v); map.set(v, list.length - 1);
      return list.length - 1;
    },
  };
}

type Work = { b: Building; units: Unit[] };
type AlsoListed = { src: string; url: string };

async function loadAliases(g: GateResult): Promise<Map<string, AliasFile['groups'][number]>> {
  const byKey = new Map<string, AliasFile['groups'][number]>();
  if (!existsSync(ALIAS_FILE)) return byKey;
  const parsed = JSON.parse(await readFile(ALIAS_FILE, 'utf8')) as AliasFile;
  if (parsed.version !== 1) { g.errors.push(`[閘門4] ${ALIAS_FILE} version 不是 1`); return byKey; }
  for (const grp of parsed.groups) {
    if (byKey.has(grp.key)) g.errors.push(`[閘門4] alias 檔 key 重複：${grp.key}`);
    byKey.set(grp.key, grp);
  }
  return byKey;
}

async function main(): Promise<void> {
  const g: GateResult = { errors: [], warnings: [], violations: [] };
  const work: Work[] = [];
  /** 同一個 building.id 被拆成多行、由本層合併掉的行數 */
  let mergedLines = 0;
  /** 同一個 unitKey 在多行裡重複出現（分頁重疊重抓）而被丟掉的列數 */
  let dupKeyRows = 0;
  const manifests: Array<{ id: string; provides: Set<string> }> = [];
  // 來源顯示名從 manifest 帶進資料，UI 就不必為每個新來源改一次硬編碼對照表
  const sourceMeta: Record<string, { nameZh: string; homepage: string }> = {};
  const sources = dict();

  const SOURCES = await loadSourceIds();
  for (const id of SOURCES) {
    const p = path.join(DATA, 'normalized', `${id}.ndjson.gz`);
    if (!existsSync(p)) { g.warnings.push(`找不到 ${p}，跳過`); continue; }
    // 同一棟建物可能被拆成多行——SUUMO 的一覧頁分頁會把同一棟切在兩頁上，
    // 而 building.id 是由 名稱+住所 算出來的，所以那兩行指的是同一棟。
    // 不先併起來的話，站內去重只在單一行內比對，跨行的重複刊登整批漏掉
    // （2026-09-06 實測：2,200 棟被拆成多行，跨行重複 1,203 列）。
    const byId = new Map<string, Work>();
    for await (const l of readNdjsonGz<Listing>(p)) {
      const seen = byId.get(l.building.id);
      if (seen === undefined) { byId.set(l.building.id, { b: l.building, units: [...l.units] }); continue; }
      // 分頁邊界會讓**同一筆刊登**被抓兩次（相同 unitKey）。那不是「多家仲介刊同一間房」
      // 而是重複抓取，先按 unitKey 去掉，再交給 7 元組合併處理真正的多家刊登。
      const have = new Set(seen.units.map((u) => u.unitKey));
      for (const u of l.units) {
        if (have.has(u.unitKey)) { dupKeyRows += 1; continue; }
        have.add(u.unitKey);
        seen.units.push(u);
      }
      mergedLines += 1;
    }
    for (const w of byId.values()) work.push(w);
    sources.idx(id); // 來源索引依載入順序固定，B.also 位元遮罩才有穩定意義
    const mod = await import(`../../sources/${id}/index.ts`) as {
      manifest: { nameZh: string; homepage: string; capabilities: { provides: readonly string[] } };
    };
    manifests.push({ id, provides: new Set(mod.manifest.capabilities.provides) });
    sourceMeta[id] = { nameZh: mod.manifest.nameZh, homepage: mod.manifest.homepage };
  }

  if (work.length === 0) {
    console.error('沒有任何資料可建置。請先執行 npm run crawl');
    process.exitCode = 1;
    return;
  }

  const providesOf = new Map(manifests.map((m) => [m.id, m.provides]));

  // ── SUUMO 站內去重：同棟 7 元組相同＝多家仲介刊同一間房 ──────────────
  // 稽核：data/health/audit-suumo-dups.md（50 組親自核對，2026-08-23）
  const dedupInfo = new Map<string, MergeInfo>(); // unit.id → 合併資訊
  const suumoBefore: Unit[] = [];
  const suumoAfter: Unit[] = [];
  let suumoGroups = 0; let suumoRemoved = 0; let suumoSuspect = 0;
  for (const w of work) {
    if (w.b.sourceId !== 'suumo') continue;
    suumoBefore.push(...w.units);
    const r = mergeDuplicateAds(w.units);
    let sumSizeMinus1 = 0;
    for (const info of r.info.values()) sumSizeMinus1 += info.adCount - 1;
    if (sumSizeMinus1 !== r.removed) {
      g.errors.push(`[去重] ${w.b.id}：removed=${r.removed} 但 Σ(size−1)=${sumSizeMinus1}`);
    }
    if (r.kept.length + r.removed !== w.units.length) {
      g.errors.push(`[去重] ${w.b.id}：after+removed≠before（${r.kept.length}+${r.removed}≠${w.units.length}）`);
    }
    for (const u of r.kept) {
      const info = r.info.get(u.unitKey);
      if (info !== undefined) dedupInfo.set(u.id, info);
    }
    w.units = r.kept;
    suumoAfter.push(...r.kept);
    suumoGroups += r.groups; suumoRemoved += r.removed; suumoSuspect += r.suspectOnly;
  }
  const medBefore = median(aTierRents(suumoBefore));
  const medAfter = median(aTierRents(suumoAfter));
  // 中位數「完全相等」不是不變式：重複刊登若略偏某價位段，拿掉它們中位數本來就會動一階
  // （賃料以 ¥1,000 為階）。2026-08-23 實測 153,000→154,000，被移除列 51.1% 低於／48.4% 高於中位數，
  // 是最小可能位移。這裡只防災難性併錯：位移超過 2% 才擋。
  if (medBefore !== null && medAfter !== null && Math.abs(medAfter - medBefore) / medBefore > 0.02) {
    g.errors.push(`[去重] SUUMO A 區賃料中位數在去重前後位移超過 2%：${medBefore} → ${medAfter}——合併規則可能併掉了不該併的列`);
  }

  // ── 閘門 4：跨來源同棟同房 ─────────────────────────────────────
  // 同 ward＋正規化名＋共同站名 → 棟層候選；再看 (賃料, 面積) 相同的房。
  // 房間層命中但 alias 檔沒審過 → 不產檔。只標記、不自動合併：
  // SUUMO 的自動生成名（「○○線△△駅10階建新築」）同名≠同棟，自動合併會併錯。
  const aliases = await loadAliases(g);
  const byId = new Map(work.map((w) => [w.b.id, w]));
  const alsoListed = new Map<string, AlsoListed[]>();   // primary unit.id → 其他來源的刊登
  const alsoMask = new Map<string, number>();            // primary building.id → 來源位元遮罩
  let crossGroups = 0; let crossRemoved = 0; let crossBuildingOnly = 0;
  const listingsView: Listing[] = work.map((w) => ({ building: w.b, units: w.units }));
  for (const [key, ls] of findCandidates(listingsView)) {
    const hits = crossSourceRoomHits(ls);
    if (hits === 0) { crossBuildingOnly += 1; continue; }
    const alias = aliases.get(key);
    if (alias === undefined) {
      g.errors.push(`[閘門4] 跨來源同房未審核：${key}（房間層命中 ${hits}；來源 ${ls.map((l) => l.building.sourceId).join('+')}）→ npm run alias:candidates 後人審加入 data/aliases/buildings.json`);
      continue;
    }
    // excluded 也算「已審核」——審核員看過並判定它不是同一棟，所以放行但不合併
    const reviewed = new Set([alias.primary, ...alias.members, ...(alias.excluded ?? [])]);
    const unknownIds = ls.map((l) => l.building.id).filter((id) => !reviewed.has(id));
    if (unknownIds.length > 0) {
      g.errors.push(`[閘門4] alias 組 ${key} 出現未審核的新成員：${unknownIds.join(', ')}`);
      continue;
    }
    const primary = byId.get(alias.primary);
    if (primary === undefined) { g.errors.push(`[閘門4] alias 組 ${key} 的 primary ${alias.primary} 不在資料中`); continue; }
    const primarySig = new Map<string, Unit>();
    for (const u of primary.units) {
      if (u.monthly.rent.known && u.areaM2.known) primarySig.set(`${u.monthly.rent.v.jpy}|${u.areaM2.v}`, u);
    }
    crossGroups += 1;
    const excluded = new Set(alias.excluded ?? []);
    for (const memberId of alias.members) {
      if (excluded.has(memberId)) continue; // 保險：同時列在兩邊時以「不合併」為準
      const member = byId.get(memberId);
      if (member === undefined) continue; // 這次抓取沒有它，沒東西可併
      member.units = member.units.filter((u) => {
        if (!u.monthly.rent.known || !u.areaM2.known) return true;
        const pu = primarySig.get(`${u.monthly.rent.v.jpy}|${u.areaM2.v}`);
        if (pu === undefined) return true;
        (alsoListed.get(pu.id) ?? alsoListed.set(pu.id, []).get(pu.id) as AlsoListed[])
          .push({ src: member.b.sourceId, url: u.sourceUrl });
        alsoMask.set(primary.b.id, (alsoMask.get(primary.b.id) ?? 0) | (1 << sources.idx(member.b.sourceId)));
        crossRemoved += 1;
        return false;
      });
    }
  }

  // ── 字典與欄式陣列 ────────────────────────────────────────────
  const wards = dict();
  const stations = dict();
  const lines = dict();
  const layouts = dict();
  const btypes = dict();
  const pairSet = new Set<string>();

  // 索引只放「搜尋當下就要用」的欄位。id／availFrom／img 都搬去 prov 桶：
  // 10 万級的 unit id 字串（每個 ~40 字元）光自己就吃掉數百 KB gzip，
  // 而它只在點開詳情時才需要。
  // 車站扁平化：B.stn／B.stw 連續存所有站，B.stc 是每棟站數（offset 由前綴和算）。
  const B = {
    name: [] as string[], url: [] as string[], ward: [] as number[], src: [] as number[],
    stn: [] as number[], stw: [] as (number | null)[], stc: [] as number[],
    total: [] as (number | null)[], fetchedAt: [] as string[], kind: [] as number[],
    yearBuilt: [] as (number | null)[], also: [] as number[],
    /** 原站標的建物種別（マンション／アパート／一戸建て…）。-1 = 該來源不標或這頁沒寫。 */
    btype: [] as number[],
  };
  const U = {
    bid: [] as number[], room: [] as (string | null)[], layout: [] as number[],
    area: [] as (number | null)[], floor: [] as (number | null)[],
    rent: [] as (number | null)[], admin: [] as (number | null)[],
    util: [] as (number | null)[], utilBasis: [] as number[], key: [] as (number | null)[],
    dep: [] as (number | null)[], depNR: [] as (number | null)[],
    gender: [] as number[], foreigner: [] as number[], vacant: [] as number[],
    monthlyLower: [] as number[], monthlyTier: [] as number[],
    initCash: [] as number[], initCashTier: [] as number[],
    initSunk: [] as number[], effMonthly12: [] as number[],
    missing: [] as number[], flags: [] as number[], ads: [] as number[],
  };

  // provenance 邊產邊寫，不在記憶體裡累積。
  // 7 萬筆時整份 prov 在記憶體是 2.6 GB（而且 Object.entries 分桶時又複製一份），
  // 擴到 23 区的 13.5 萬筆會直接撞破 Node 的 4.2 GB heap 上限。
  // 先寫進 prov.tmp/，等閘門全部通過才 rename 成 prov/——
  // 「閘門失敗就不產出任何檔案」這條保證不能因為串流寫入而破功。
  const PROV_TMP = path.join(OUT_DIR, 'prov.tmp');
  await rm(PROV_TMP, { recursive: true, force: true });
  await mkdir(PROV_TMP, { recursive: true });
  let provBucketNo = -1;
  let provBucket: Record<string, unknown> = {};
  let provBucketCount = 0;
  // 桶預先 gzip 存放：未壓縮 439 桶是 507 MB，gzip 後 12 MB（42 倍）。
  // GitHub Pages 發布站台上限 1 GB，而且 artifact 越大部署越久（10 分鐘逾時）。
  // 2026-09-06 實測 Pages 對 .json.gz 送 `content-type: application/gzip` 且**不**加
  // content-encoding，所以瀏覽器不會自動解——前端用 DecompressionStream('gzip') 解（見 web/src/data.ts）。
  const flushProv = async (): Promise<void> => {
    if (provBucketNo < 0) return;
    await writeFile(path.join(PROV_TMP, `p${provBucketNo}.json.gz`), gzipSync(Buffer.from(JSON.stringify(provBucket), 'utf8'), { level: 9 }));
    provBucket = {};
    provBucketCount += 1;
  };
  const putProv = async (unitIdx: number, value: unknown): Promise<void> => {
    const no = Math.floor(unitIdx / PROV_BUCKET);
    if (no !== provBucketNo) { await flushProv(); provBucketNo = no; }
    provBucket[String(unitIdx)] = value;
  };
  let emptyBuildings = 0;

  for (const { b, units } of work) {
    if (units.length === 0) { emptyBuildings += 1; continue; } // 房間全被併到別的來源，卡片沒東西可顯示
    const provided = providesOf.get(b.sourceId) ?? new Set<string>();
    const bi = B.name.length;
    B.name.push(b.name);
    B.url.push(b.sourceUrl);
    B.ward.push(wards.idx(b.ward));
    B.src.push(sources.idx(b.sourceId));
    for (const st of b.stations) {
      const si = stations.idx(st.station);
      B.stn.push(si);
      B.stw.push(st.walkMinutes.known ? st.walkMinutes.v : null);
      if (st.line.trim() !== '') pairSet.add(`${lines.idx(st.line)},${si}`);
    }
    B.stc.push(b.stations.length);
    B.total.push(numOrNull(b.totalUnits));
    B.fetchedAt.push(b.fetchedAt.slice(0, 10));
    B.kind.push(Math.max(0, KINDS.indexOf(b.kind)));
    B.yearBuilt.push(numOrNull(b.yearBuilt));
    B.also.push(alsoMask.get(b.id) ?? 0);
    B.btype.push(b.buildingType.known ? btypes.idx(b.buildingType.v) : -1);

    for (const u of units) {
      const violations = checkUnit(b, u, provided, g);
      const m = monthlyCost(u);
      const c = initialCash(u);
      const s = initialSunk(u);
      const e = effectiveMonthly(u, 12, null);
      const lay = normLayout(u.layout);
      const merged = dedupInfo.get(u.id);
      const also = alsoListed.get(u.id);

      U.bid.push(bi);
      U.room.push(strOrNull(u.roomNo));
      U.layout.push(lay.v === null ? -1 : layouts.idx(lay.v));
      U.area.push(numOrNull(u.areaM2));
      U.floor.push(numOrNull(u.floor));
      U.rent.push(yenOrNull(u.monthly.rent)); U.admin.push(yenOrNull(u.monthly.adminFee));
      U.util.push(yenOrNull(u.monthly.utilities));
      U.utilBasis.push(UTIL_BASIS[u.utilitiesBasis]);
      U.key.push(yenOrNull(u.initial.keyMoney)); U.dep.push(yenOrNull(u.initial.deposit));
      U.depNR.push(yenOrNull(u.initial.depositNonRefundable));
      U.gender.push(GENDER[u.genderRestriction]);
      U.foreigner.push(boolOrNull(u.foreigner.welcomed));
      U.vacant.push(boolOrNull(u.isVacant));
      U.monthlyLower.push(m.lower.jpy); U.monthlyTier.push(TIER[tierOf(u, m)]);
      U.initCash.push(c.lower.jpy); U.initCashTier.push(TIER[tierOf(u, c)]);
      U.initSunk.push(s.lower.jpy); U.effMonthly12.push(e.lower.jpy);
      U.missing.push(missingMask(u));
      U.flags.push(flagsOf(u) | (violations.length > 0 ? FLAG.invariantViolation : 0));
      U.ads.push(merged?.adCount ?? 1);

      // provenance：每欄的原文出處，只在使用者點開房源時才載入。
      // 鍵是 unit 的序號——桶位由序號直算（floor(i / PROV_BUCKET)），
      // 不需要一個 7 萬鍵的 map.json 對照表。
      await putProv(U.bid.length - 1, {
        id: u.id,
        availFrom: u.availableFrom.known ? u.availableFrom.v : null,
        url: u.sourceUrl,
        fetchedAt: b.fetchedAt,
        foreignerRaw: u.foreigner.rawText,
        notes: u.notes,
        caveats: [...m.caveats, ...s.caveats],
        missing: m.missing,
        ...(lay.raw === null ? {} : { layoutRaw: lay.raw }),
        ...(u.minStayMonths.known ? { minStayMonths: u.minStayMonths.v } : {}),
        ...(u.ageLimitRaw.known && u.ageLimitRaw.v.trim() !== '' ? { ageLimitRaw: u.ageLimitRaw.v } : {}),
        ...(merged === undefined ? {} : { adCount: merged.adCount, mergedFrom: merged.mergedFrom }),
        ...(also === undefined ? {} : { alsoListed: also }),
        ...(violations.length === 0 ? {} : { invariants: violations.map((v) => v.detail) }),
        fields: Object.fromEntries(
          moneyFields(u).map(([id, f]) => [id, f.known
            ? { v: f.v.jpy, basis: f.basis, src: f.srcText.slice(0, 80) }
            : { v: null, why: f.why, basis: f.basis, src: f.srcText.slice(0, 80) }]),
        ),
      });
    }
  }

  await flushProv();

  // ── 閘門結果 ─────────────────────────────────────────────
  if (g.errors.length > 0) {
    await rm(PROV_TMP, { recursive: true, force: true }); // 閘門失敗＝不留下任何產出
    console.error(`\n⛔ 建置閘門失敗（${g.errors.length} 項），未產出任何檔案：\n`);
    for (const e of g.errors.slice(0, 20)) console.error('  ' + e);
    if (g.errors.length > 20) console.error(`  …另有 ${g.errors.length - 20} 項`);
    process.exitCode = 1;
    return;
  }

  const pairs = [...pairSet].map((p) => p.split(',').map(Number) as [number, number]);
  const meta = {
    generatedAt: new Date().toISOString(),
    buildings: B.name.length,
    units: U.bid.length,
    provBucket: PROV_BUCKET,
    sources: sources.list.map((id) => ({ id })),
    missingBits: MISSING_BITS,
    flagBits: FLAG,
    violations: g.violations.length,
    dedup: {
      suumoWithin: {
        before: suumoBefore.length, after: suumoAfter.length,
        groups: suumoGroups, removed: suumoRemoved, suspectOnly: suumoSuspect,
        aTierRentMedianBefore: medBefore, aTierRentMedianAfter: medAfter,
      },
      crossSource: { groups: crossGroups, removedUnits: crossRemoved, buildingOnlyCandidates: crossBuildingOnly },
      emptyBuildingsDropped: emptyBuildings,
      /** 同一棟被拆成多行（分頁邊界）而在讀檔階段就合併掉的行數 */
      splitBuildingLinesMerged: mergedLines,
      /** 同一 unitKey 被重複抓取而丟棄的列數 */
      duplicateUnitKeyRows: dupKeyRows,
    },
  };

  const index = {
    meta,
    dict: {
      wards: wards.list, stations: stations.list, sources: sources.list, sourceMeta,
      kinds: KINDS, layouts: layouts.list, lines: lines.list, pairs,
      buildingTypes: btypes.list,
    },
    b: B, u: U,
  };
  const plainJson = JSON.stringify(index);

  // ── 閘門 5：壓縮不得改變任何一個數字 ────────────────────────────
  // 編碼器對「表示不了的值」都會丟例外，但那只擋得住它想得到的形狀。
  // 這道閘門是最後一關：encode → decode → **全量逐格 Object.is 比對**，
  // 任何一格對不上就讓建置失敗。這樣「解碼後的數字跟原值不一樣而且沒人會知道」
  // 在結構上就不可能發生——那正是本專案最高原則要防的事，只是換了發生位置。
  const encoded = encodeIndex(index as unknown as ColumnIndex);
  const encodedJson = JSON.stringify(encoded);
  const roundTrip = decodeIndex(JSON.parse(encodedJson) as typeof encoded);
  const { cells } = assertLossless(index as unknown as ColumnIndex, roundTrip);

  await writeFile(path.join(OUT_DIR, 'index.json'), encodedJson, 'utf8');

  // 舊桶整個換掉：桶的鍵與數量會隨資料變動，殘留的舊桶會被誤讀
  await rm(path.join(OUT_DIR, 'prov'), { recursive: true, force: true });
  await rename(PROV_TMP, path.join(OUT_DIR, 'prov'));

  const gz = gzipSync(Buffer.from(encodedJson, 'utf8')).length;
  const gzPlain = gzipSync(Buffer.from(plainJson, 'utf8')).length;
  console.log(`✔ 建置完成`);
  console.log(`  建物 ${meta.buildings} 棟 / 房間 ${meta.units} 間（空棟略過 ${emptyBuildings}；`
    + `同棟被拆成多行而合併 ${mergedLines} 行、同一刊登被重複抓取而丟棄 ${dupKeyRows} 列）`);
  console.log(`  SUUMO 去重：${suumoBefore.length} → ${suumoAfter.length}（${suumoGroups} 組、移除 ${suumoRemoved}、疑似不併 ${suumoSuspect}）；A 區賃料中位數 ${medBefore} → ${medAfter}`);
  console.log(`  跨來源：${crossGroups} 組已審核合併、移除 ${crossRemoved} 間；僅棟層命中 ${crossBuildingOnly} 組（不併）`);
  console.log(`  字典：站 ${stations.list.length}、線 ${lines.list.length}、線站對 ${pairs.length}、間取 ${layouts.list.length}、建物種別 ${btypes.list.length}`);
  console.log(`  index.json ${(encodedJson.length / 1024).toFixed(0)} KB raw → ${(gz / 1024).toFixed(0)} KB gzip`);
  console.log(`    （未編碼會是 ${(gzPlain / 1024).toFixed(0)} KB gzip，壓縮省下 ${(100 * (gzPlain - gz) / gzPlain).toFixed(1)}%；`
    + `無損閘門逐格比對 ${cells.toLocaleString()} 格通過）`);
  console.log(`  provenance ${provBucketCount} 桶（邊產邊寫，不在記憶體累積）`);
  if (gz > 500 * 1024) console.warn(`  ⚠️ 首屏資料 ${(gz / 1024).toFixed(0)} KB gzip 已超過 500 KB 預算，該啟動分片了`);
  if (g.violations.length > 0) {
    console.log(`  ⚠️ ${g.violations.length} 筆合理性不變式違反（值照原文保留，該房標記 invariantViolation）：`);
    for (const v of g.violations.slice(0, 5)) console.log(`     ${v.rule}: ${v.detail}`);
  }
  if (g.warnings.length > 0) for (const w of g.warnings) console.log(`  · ${w}`);
}

await main();
