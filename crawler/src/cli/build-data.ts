/**
 * NDJSON 真相層 → 網站用的欄式 JSON。
 *
 * 這個腳本是「不虛構」真正落地的地方：驗證閘門在寫出任何檔案**之前**執行，
 * 任一條失敗就 exit 非零、不產出檔案。規則寫在程式裡，就不會有人「忘記遵守」。
 *
 * 為什麼用欄式（struct-of-arrays）：實測 5,000 筆 × 27 欄，
 * 列物件 363 KB gzip、列元組 311 KB、欄式 254 KB；Int32 二進位反而打不贏欄式
 * （小整數的十進位表示比固定 4 bytes 省，gzip 又吃得很好）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';

import { DATA_ROOT } from '../http.ts';
import { loadSourceIds } from '../registry.ts';
import type { Listing, Unit, Building } from '../../../packages/schema/src/model.ts';
import type { Field, Yen } from '../../../packages/schema/src/field.ts';
import {
  monthlyCost, initialCash, initialSunk, effectiveMonthly, tierOf,
} from '../../../packages/cost-model/src/index.ts';
import {
  checkRentRange, checkAgencyFeeCap, checkAreaRange, checkYearBuilt,
  checkMonthlyAtLeastRent, checkDepositNonRefundable, type Violation,
} from '../../../packages/schema/src/invariants.ts';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../web/public/data');


const UTIL_BASIS = { unknown: 0, included: 1, excluded: 2 } as const;
const GENDER = { unknown: 0, mixed: 1, female_only: 2, male_only: 3 } as const;
const TIER = { A: 0, B: 1, C: 2 } as const;

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

/** 閘門 3 + 跨欄位不變式。違反不變式的欄位不採用，但只警告不中止（記入報告）。 */
function checkUnit(b: Building, u: Unit, provided: ReadonlySet<string>, g: GateResult): void {
  for (const [id, f] of moneyFields(u)) {
    gateZeroWithoutBasis(id, f, u.id, g);
    gateMeasuredNeedsSource(id, f, u.id, g);
    if (f.known && !provided.has(id) && f.basis === 'measured') {
      g.errors.push(`[閘門3] ${u.id} 產出了 capabilities.provides 之外的欄位：${id}`);
    }
  }
  gateMeasuredNeedsSource('areaM2', u.areaM2, u.id, g);
  gateMeasuredNeedsSource('layout', u.layout, u.id, g);

  const push = (v: Violation | null): void => { if (v !== null) g.violations.push(v); };
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

async function main(): Promise<void> {
  const g: GateResult = { errors: [], warnings: [], violations: [] };
  const listings: Listing[] = [];
  const manifests: Array<{ id: string; provides: Set<string> }> = [];
  // 來源顯示名從 manifest 帶進資料，UI 就不必為每個新來源改一次硬編碼對照表
  const sourceMeta: Record<string, { nameZh: string; homepage: string }> = {};

  const SOURCES = await loadSourceIds();
  for (const id of SOURCES) {
    const p = path.join(DATA_ROOT, 'normalized', `${id}.ndjson.gz`);
    if (!existsSync(p)) { g.warnings.push(`找不到 ${p}，跳過`); continue; }
    const text = gunzipSync(await readFile(p)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      listings.push(JSON.parse(line) as Listing);
    }
    const mod = await import(`../../sources/${id}/index.ts`) as {
      manifest: { nameZh: string; homepage: string; capabilities: { provides: readonly string[] } };
    };
    manifests.push({ id, provides: new Set(mod.manifest.capabilities.provides) });
    sourceMeta[id] = { nameZh: mod.manifest.nameZh, homepage: mod.manifest.homepage };
  }

  if (listings.length === 0) {
    console.error('沒有任何資料可建置。請先執行 npm run crawl');
    process.exitCode = 1;
    return;
  }

  const providesOf = new Map(manifests.map((m) => [m.id, m.provides]));

  // 字典編碼：重複字串只存一次，欄式陣列裡放索引
  const wards: string[] = [];
  const stations: string[] = [];
  const sources: string[] = [];
  const idx = (arr: string[], v: string): number => {
    const i = arr.indexOf(v);
    if (i >= 0) return i;
    arr.push(v);
    return arr.length - 1;
  };

  const B = {
    name: [] as string[], url: [] as string[], ward: [] as number[], src: [] as number[],
    station: [] as number[], walk: [] as (number | null)[], img: [] as string[],
    total: [] as (number | null)[], fetchedAt: [] as string[], kind: [] as string[],
  };
  const U = {
    id: [] as string[], bid: [] as number[], room: [] as (string | null)[], layout: [] as (string | null)[],
    area: [] as (number | null)[], rent: [] as (number | null)[], admin: [] as (number | null)[],
    util: [] as (number | null)[], utilBasis: [] as number[], key: [] as (number | null)[],
    dep: [] as (number | null)[], depNR: [] as (number | null)[],
    gender: [] as number[], foreigner: [] as number[], vacant: [] as number[],
    availFrom: [] as (string | null)[],
    monthlyLower: [] as number[], monthlyTier: [] as number[],
    initCash: [] as number[], initCashTier: [] as number[],
    initSunk: [] as number[], effMonthly12: [] as number[],
    missing: [] as number[],
  };

  const prov: Record<string, unknown> = {};

  for (const { building: b, units } of listings) {
    const provided = providesOf.get(b.sourceId) ?? new Set<string>();
    const bi = B.name.length;
    const st = b.stations[0];
    B.name.push(b.name);
    B.url.push(b.sourceUrl);
    B.ward.push(idx(wards, b.ward));
    B.src.push(idx(sources, b.sourceId));
    B.station.push(st ? idx(stations, st.station) : -1);
    B.walk.push(st?.walkMinutes.known === true ? st.walkMinutes.v : null);
    B.img.push(b.imageUrls[0] ?? '');
    B.total.push(numOrNull(b.totalUnits));
    B.fetchedAt.push(b.fetchedAt.slice(0, 10));
    B.kind.push(b.kind);

    for (const u of units) {
      checkUnit(b, u, provided, g);
      const m = monthlyCost(u);
      const c = initialCash(u);
      const s = initialSunk(u);
      const e = effectiveMonthly(u, 12, null);

      U.id.push(u.id); U.bid.push(bi);
      U.room.push(strOrNull(u.roomNo)); U.layout.push(strOrNull(u.layout));
      U.area.push(numOrNull(u.areaM2));
      U.rent.push(yenOrNull(u.monthly.rent)); U.admin.push(yenOrNull(u.monthly.adminFee));
      U.util.push(yenOrNull(u.monthly.utilities));
      U.utilBasis.push(UTIL_BASIS[u.utilitiesBasis]);
      U.key.push(yenOrNull(u.initial.keyMoney)); U.dep.push(yenOrNull(u.initial.deposit));
      U.depNR.push(yenOrNull(u.initial.depositNonRefundable));
      U.gender.push(GENDER[u.genderRestriction]);
      U.foreigner.push(boolOrNull(u.foreigner.welcomed));
      U.vacant.push(boolOrNull(u.isVacant));
      U.availFrom.push(strOrNull(u.availableFrom));
      U.monthlyLower.push(m.lower.jpy); U.monthlyTier.push(TIER[tierOf(u, m)]);
      U.initCash.push(c.lower.jpy); U.initCashTier.push(TIER[tierOf(u, c)]);
      U.initSunk.push(s.lower.jpy); U.effMonthly12.push(e.lower.jpy);
      U.missing.push(missingMask(u));

      // provenance：每欄的原文出處，只在使用者點開房源時才載入
      prov[u.id] = {
        url: u.sourceUrl,
        fetchedAt: b.fetchedAt,
        foreignerRaw: u.foreigner.rawText,
        notes: u.notes,
        caveats: [...m.caveats, ...s.caveats],
        missing: m.missing,
        fields: Object.fromEntries(
          moneyFields(u).map(([id, f]) => [id, f.known
            ? { v: f.v.jpy, basis: f.basis, src: f.srcText.slice(0, 80) }
            : { v: null, why: f.why, basis: f.basis, src: f.srcText.slice(0, 80) }]),
        ),
      };
    }
  }

  // ── 閘門結果 ─────────────────────────────────────────────
  if (g.errors.length > 0) {
    console.error(`\n⛔ 建置閘門失敗（${g.errors.length} 項），未產出任何檔案：\n`);
    for (const e of g.errors.slice(0, 20)) console.error('  ' + e);
    if (g.errors.length > 20) console.error(`  …另有 ${g.errors.length - 20} 項`);
    process.exitCode = 1;
    return;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    buildings: B.name.length,
    units: U.id.length,
    sources: sources.map((id) => ({ id })),
    missingBits: MISSING_BITS,
    violations: g.violations.length,
  };

  await mkdir(path.join(OUT_DIR, 'prov'), { recursive: true });
  const index = { meta, dict: { wards, stations, sources, sourceMeta }, b: B, u: U };
  const json = JSON.stringify(index);
  await writeFile(path.join(OUT_DIR, 'index.json'), json, 'utf8');

  // provenance 依建物分桶，每桶約 200 棟
  const ids = Object.keys(prov);
  const BUCKET = 400;
  const buckets: Record<string, Record<string, unknown>> = {};
  ids.forEach((k, i) => {
    const bkt = `p${Math.floor(i / BUCKET)}`;
    (buckets[bkt] ??= {})[k] = prov[k];
  });
  const provIndex: Record<string, string> = {};
  for (const [bkt, obj] of Object.entries(buckets)) {
    await writeFile(path.join(OUT_DIR, 'prov', `${bkt}.json`), JSON.stringify(obj), 'utf8');
    for (const k of Object.keys(obj)) provIndex[k] = bkt;
  }
  await writeFile(path.join(OUT_DIR, 'prov', 'map.json'), JSON.stringify(provIndex), 'utf8');

  const gz = gzipSync(Buffer.from(json, 'utf8')).length;
  console.log(`✔ 建置完成`);
  console.log(`  建物 ${meta.buildings} 棟 / 房間 ${meta.units} 間`);
  console.log(`  index.json ${(json.length / 1024).toFixed(0)} KB raw → ${(gz / 1024).toFixed(0)} KB gzip`);
  console.log(`  provenance ${Object.keys(buckets).length} 桶`);
  if (gz > 500 * 1024) console.warn(`  ⚠️ 首屏資料 ${(gz / 1024).toFixed(0)} KB gzip 已超過 500 KB 預算，該啟動分片了`);
  if (g.violations.length > 0) {
    console.log(`  ⚠️ ${g.violations.length} 筆跨欄位不變式違反（該欄位不採用）：`);
    for (const v of g.violations.slice(0, 5)) console.log(`     ${v.rule}: ${v.detail}`);
  }
  if (g.warnings.length > 0) for (const w of g.warnings) console.log(`  · ${w}`);
}

await main();
