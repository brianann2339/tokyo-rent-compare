/**
 * 建置閘門的**端到端**測試：實際跑 build-data.ts，看它有沒有真的中止。
 *
 * 純函式測試（alias.test.ts）證明判準對，但證明不了「閘門真的會擋下建置」——
 * 少一行 `process.exitCode = 1` 判準再對也照樣產出髒資料。這裡用臨時資料目錄實跑。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { known, notListed, notOffered, yen, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit, SourceId } from '../../packages/schema/src/model.ts';
import { decodeIndex, type EncodedIndex } from '../../packages/wire-codec/src/index.ts';
import { decodeNames, type EncodedNames } from '../../packages/wire-codec/src/names.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../src/cli/build-data.ts');

function unit(bid: string, key: string, rent: number, area: number): Unit {
  const z = notOffered<Yen>();
  const money = (n: number): Field<Yen> => known(yen(n), 'measured', `賃料 ${n}円`);
  return {
    id: `${bid}#${key}`, buildingId: bid, unitKey: key, sourceUrl: `https://example.test/${key}`,
    roomNo: notListed(''), layout: known('1K', 'measured', '間取り 1K'),
    areaM2: known(area, 'measured', `専有面積 ${area}m2`), floor: known(3, 'measured', '3階'),
    monthly: { rent: money(rent), adminFee: z, utilities: z, internet: z, otherMonthly: z },
    initial: {
      keyMoney: z, deposit: z, depositNonRefundable: z, agencyFee: z, guarantorInitialFee: z,
      fireInsurance: z, keyExchangeFee: z, contractFee: z, cleaningFeeUpfront: z, otherInitial: z,
    },
    deferred: { renewalFee: z, renewalAdminFee: z, cleaningFeeOnExit: z, earlyTerminationPenalty: z },
    utilitiesBasis: 'unknown', furnished: notListed(''), availableFrom: notListed(''),
    isVacant: known(true, 'measured', '空室'), contractType: 'unknown',
    contractMonths: notListed(''), minStayMonths: notListed(''), genderRestriction: 'unknown',
    ageLimitRaw: notListed(''), petsAllowed: notListed(''),
    foreigner: {
      welcomed: notListed(''), residenceCardRequired: notListed(''), japaneseRequired: notListed(''),
      guarantorCompanyRequired: notListed(''), guarantorPersonRequired: notListed(''), rawText: '',
    },
    notes: [],
  };
}

/** 兩個來源各一棟「レオパレス閘門テスト」，都有一間 ¥80,000 / 20㎡ → 跨來源同房 */
function listing(src: SourceId, rent: number, walkMinutes = 5): Listing {
  const id = `${src}:gate`;
  return {
    building: {
      id, sourceId: src, sourceKey: 'gate', sourceUrl: `https://${src}.test/gate`,
      name: 'レオパレス閘門テスト', kind: 'apartment', addressRaw: '東京都豊島区', prefecture: '東京都',
      ward: '豊島区',
      stations: [{ line: 'JR山手線', station: '大塚', walkMinutes: known(walkMinutes, 'measured', `徒歩${walkMinutes}分`) }],
      structure: notListed(''), buildingType: notListed(''),
      yearBuilt: notListed(''), floorsAboveGround: notListed(''),
      totalUnits: notListed(''), imageUrls: [], fetchedAt: '2026-08-23T00:00:00Z',
      sourceUpdatedAt: notOffered<string>(), htmlSha256: 'x'.repeat(64),
    },
    units: [unit(id, 'r1', rent, 20)],
  } as unknown as Listing;
}

let dir = '';
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  TOKYO_RENT_DATA_ROOT: path.join(dir, 'data'),
  TOKYO_RENT_OUT_DIR: path.join(dir, 'out'),
});

async function build(): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run('node', [CLI], { env: env(), maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tokyo-rent-gate-'));
  await mkdir(path.join(dir, 'data', 'normalized'), { recursive: true });
  await mkdir(path.join(dir, 'out'), { recursive: true });
  for (const src of ['leopalace21', 'suumo'] as const) {
    await writeFile(
      path.join(dir, 'data', 'normalized', `${src}.ndjson.gz`),
      gzipSync(Buffer.from(`${JSON.stringify(listing(src, 80000))}\n`, 'utf8')),
    );
  }
});

after(async () => { if (dir !== '') await rm(dir, { recursive: true, force: true }); });

describe('閘門 4：跨來源同房未審核就不准產檔', () => {
  test('無 alias 檔 → exit 非零、三份產出檔一份都不留', async () => {
    const r = await build();
    assert.notEqual(r.code, 0, '應該以非零離開');
    assert.match(r.stderr, /\[閘門4\] 跨來源同房未審核：豊島区\|レオパレス閘門テスト/);
    // 「閘門失敗＝不留下任何產出」現在要涵蓋三個檔案：
    // index.json.gz、names.json.gz、prov/ 以序號互相對齊，留下任何一個都可能被下一次
    // 建置的另外兩個配成一組，那就是「新索引配舊名稱」的錯位。
    for (const f of ['index.json', 'index.json.gz', 'names.json.gz', 'index.json.gz.tmp', 'names.json.gz.tmp', 'prov.tmp']) {
      assert.equal(existsSync(path.join(dir, 'out', f)), false, `不可留下 ${f}`);
    }
  });

  test('alias 審過後 → 通過，非主來源的房間移出索引、prov 記 alsoListed', async () => {
    await mkdir(path.join(dir, 'data', 'aliases'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'aliases', 'buildings.json'), JSON.stringify({
      version: 1,
      groups: [{
        key: '豊島区|レオパレス閘門テスト', primary: 'leopalace21:gate', members: ['suumo:gate'],
        reviewedAt: '2026-08-23', note: '測試用',
      }],
    }), 'utf8');

    const r = await build();
    assert.equal(r.code, 0, `應該成功，stderr=${r.stderr}`);
    // index.json.gz 是預壓的編碼格式（頂層 v:'C4'），要先解壓、再解碼才有欄位
    const encoded = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex;
    assert.equal(encoded.v, 'C4', 'index.json.gz 應為 C4 編碼格式');
    assert.equal(existsSync(path.join(dir, 'out', 'index.json')), false, '不再產出未壓縮的 index.json');
    const idx = decodeIndex(encoded) as unknown as {
      meta: { units: number; buildings: number; dedup: { crossSource: { groups: number; removedUnits: number } } };
      dict: { sources: string[] };
      b: { also: number[] };
    };
    // 兩棟各一間 → 合併後只剩主來源那一間；空掉的那棟不進索引
    assert.equal(idx.meta.units, 1);
    assert.equal(idx.meta.buildings, 1);
    assert.equal(idx.meta.dedup.crossSource.groups, 1);
    assert.equal(idx.meta.dedup.crossSource.removedUnits, 1);
    // B.also 的位元指向 suumo
    const suumoBit = 1 << idx.dict.sources.indexOf('suumo');
    assert.equal((idx.b.also[0] as number) & suumoBit, suumoBit);

    // prov 桶放在 prov/<buildId>/ 底下（舊索引要的目錄在新部署裡不存在 → 404，
    // 而不是拿到別次建置的桶），而且是預先 gzip 的（未壓縮 507 MB vs 壓縮後 11 MB）
    const provDir = (encoded.meta as { provDir: string; buildId: string });
    assert.equal(provDir.provDir, provDir.buildId, 'prov 目錄名就是 buildId');
    const provRoot = await readdir(path.join(dir, 'out', 'prov'));
    assert.deepEqual(provRoot, [provDir.buildId], 'prov/ 底下只該有這一次建置的目錄');
    const provFiles = await readdir(path.join(dir, 'out', 'prov', provDir.buildId));
    assert.ok(provFiles.every((f) => f.endsWith('.json.gz')), `prov 桶應為 .json.gz，實際 ${provFiles.join(',')}`);
    const prov = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'prov', provDir.buildId, provFiles[0] as string))).toString('utf8')) as
      Record<string, { alsoListed?: Array<{ src: string; url: string }> }>;
    const also = (prov['0'] ?? {}).alsoListed;
    assert.deepEqual(also, [{ src: 'suumo', url: 'https://example.test/r1' }]);
  });

  test('alias 組出現未審核的新成員 → 仍然擋下', async () => {
    await writeFile(path.join(dir, 'data', 'normalized', 'hituji.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('hituji', 80000))}\n`, 'utf8')));
    const r = await build();
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /出現未審核的新成員：hituji:gate/);
    await rm(path.join(dir, 'data', 'normalized', 'hituji.ndjson.gz'));
  });

  test('賃料不同 → 只是棟層候選，不擋建置也不合併', async () => {
    await writeFile(path.join(dir, 'data', 'aliases', 'buildings.json'), JSON.stringify({ version: 1, groups: [] }), 'utf8');
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('suumo', 95000))}\n`, 'utf8')));
    const r = await build();
    assert.equal(r.code, 0, `應該成功，stderr=${r.stderr}`);
    const idx = decodeIndex(JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex) as unknown as {
      meta: { units: number; dedup: { crossSource: { groups: number; buildingOnlyCandidates: number } } };
    };
    assert.equal(idx.meta.units, 2, '兩間都要留著');
    assert.equal(idx.meta.dedup.crossSource.groups, 0);
    assert.equal(idx.meta.dedup.crossSource.buildingOnlyCandidates, 1);
  });
});

describe('棟層不變式：徒歩分超出合理範圍', () => {
  /**
   * 2026-09-06 全量掃描發現 SUUMO 有 48 個站條目寫著 61〜220 分
   * （原文如「東京メトロ有楽町線/平和台駅 歩220分」，是原站自己印的數字，解析忠實）。
   * 處置是保留原值＋標記，不是丟掉——但先前 checkWalkMinutes 根本沒有呼叫端，
   * 所以這 48 筆一路靜靜地進了索引。這個測試證明它現在真的會被標記。
   */
  test('歩220分 → 該棟每間房打上 invariantViolation 旗標，明細進 provenance', async () => {
    await writeFile(path.join(dir, 'data', 'aliases', 'buildings.json'),
      JSON.stringify({ version: 1, groups: [] }), 'utf8');
    await rm(path.join(dir, 'data', 'normalized', 'leopalace21.ndjson.gz'));
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('suumo', 95000, 220))}\n`, 'utf8')));

    const r = await build();
    assert.equal(r.code, 0, `違反不變式不該中止建置，值要照原文保留；stderr=${r.stderr}`);
    assert.match(r.stdout, /walk_minutes_range ×1/, '一棟只該記一次，不是每間房記一次');
    assert.match(r.stdout, /歩?220/, '訊息要帶得出原值');

    const idx = decodeIndex(JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex) as unknown as {
      u: { flags: number[] }; b: { stw: Array<number | null> };
    };
    const INVARIANT_VIOLATION = 1024;
    assert.equal((idx.u.flags[0] as number) & INVARIANT_VIOLATION, INVARIANT_VIOLATION, '房間要被標記');
    assert.equal(idx.b.stw[0], 220, '原值照原文保留，不可被清成 null');

    const bid = (JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex).meta as { buildId: string };
    const provFiles = await readdir(path.join(dir, 'out', 'prov', bid.buildId));
    const prov = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'prov', bid.buildId, provFiles[0] as string))).toString('utf8')) as
      Record<string, { invariants?: string[] }>;
    assert.match((prov['0']?.invariants ?? []).join('|'), /walk|徒歩|220/, `prov 要留下明細，實際 ${JSON.stringify(prov['0']?.invariants)}`);
  });

  test('歩5分 → 沒有任何不變式違反', async () => {
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('suumo', 95000, 5))}\n`, 'utf8')));
    const r = await build();
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /不變式違反/);
  });
});

describe('房間不變式：原站自己寫錯的賃料與面積不拿來比', () => {
  /**
   * ひつじ REVE 吉祥寺 203 的原頁房間表就印著「賃料 ￥ 1」（payload rent=1，2026-10-17 抓），
   * 先前只打 invariantViolation 旗標，月額區仍是 A——於是按月額排序時它排第一名，
   * 卡片大字印「¥1／月」。這裡證明它現在比照「賃料未知」落 C 區，原值照留。
   */
  const decode = async (): Promise<{ u: { rent: Array<number | null>; area: Array<number | null>; flags: number[]; monthlyTier: number[]; initCashTier: number[] } }> =>
    decodeIndex(JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex) as unknown as {
      u: { rent: Array<number | null>; area: Array<number | null>; flags: number[]; monthlyTier: number[]; initCashTier: number[] };
    };
  const only = async (l: Listing): Promise<void> => {
    await writeFile(path.join(dir, 'data', 'aliases', 'buildings.json'), JSON.stringify({ version: 1, groups: [] }), 'utf8');
    await rm(path.join(dir, 'data', 'normalized', 'leopalace21.ndjson.gz'), { force: true });
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'), gzipSync(Buffer.from(`${JSON.stringify(l)}\n`, 'utf8')));
  };

  test('賃料 1 円 → 月額與初期費用都落 C 區，打 rentSuspect，賃料照原文保留', async () => {
    await only(listing('suumo', 1));
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /rent_range ×1/);
    const { u } = await decode();
    assert.equal(u.rent[0], 1, '原站寫的數字照原文保留');
    assert.equal(u.monthlyTier[0], 2, '不可信的賃料不參與月額排序與行情');
    assert.equal(u.initCashTier[0], 2, '比照賃料未知：初期費用也不參與排序');
    assert.equal((u.flags[0] as number) & (1024 | 2048), 1024 | 2048);
    assert.equal((u.flags[0] as number) & 4096, 0, '面積沒問題就不可打 areaSuspect');
  });

  test('面積 60000㎡ → 打 areaSuspect，月額區照常（賃料可信）', async () => {
    const l = listing('suumo', 95000);
    (l.units[0] as unknown as { areaM2: Field<number> }).areaM2 = known(60000, 'measured', '60000㎡ ／ 7.2帖');
    await only(l);
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const { u } = await decode();
    assert.equal(u.area[0], 60000, '原值照留');
    assert.equal((u.flags[0] as number) & 4096, 4096);
    assert.equal((u.flags[0] as number) & 2048, 0);
    assert.equal(u.monthlyTier[0], 0);
  });

  test('同区 40 間 ¥80,000 前後的 1K 裡混一間「80.1万円」→ 統計離群，打 rentSuspect 落 C 區', async () => {
    // 各間賃料、面積略不同，免得被站內去重（7 元組相同＝多家仲介刊同一間）併掉
    const one = listing('suumo', 80_000);
    const l: Listing = {
      ...one,
      units: [
        ...Array.from({ length: 40 }, (_, k) => unit(one.building.id, `n${k}`, 80_000 + k * 100, 20 + k * 0.1)),
        unit(one.building.id, 'typo', 801_000, 20.05),
      ],
    };
    await only(l);
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /per_m2_outlier ×1/, '只有那一間');
    const { u } = await decode();
    const typo = u.rent.indexOf(801_000);
    assert.ok(typo >= 0);
    assert.equal(u.monthlyTier[typo], 2);
    assert.equal((u.flags[typo] as number) & 2048, 2048);
    assert.equal(u.rent.filter((x, k) => k !== typo && ((u.flags[k] as number) & 1024) !== 0).length, 0, '其他 40 間不可被波及');
  });

  /** 同区 40 間 1K（賃料 80,000 前後、面積 20〜24㎡、管理費 5,000）當行情；extra 是要測的那幾間 */
  const market = (extra: (bid: string) => Unit[]): Listing => {
    const one = listing('suumo', 80_000);
    const admin5000 = (x: Unit): Unit => ({ ...x, monthly: { ...x.monthly, adminFee: known(yen(5000), 'measured', '5000円') } });
    return {
      ...one,
      units: [
        ...Array.from({ length: 40 }, (_, k) => admin5000(unit(one.building.id, `n${k}`, 80_000 + k * 100, 20 + k * 0.1))),
        ...extra(one.building.id),
      ],
    };
  };
  const withMoney = (x: Unit, over: { admin?: number; key?: number; deposit?: number }): Unit => {
    const m = (n: number): Field<Yen> => known(yen(n), 'measured', `${n}円`);
    return {
      ...x,
      monthly: over.admin === undefined ? x.monthly : { ...x.monthly, adminFee: m(over.admin) },
      initial: {
        ...x.initial,
        ...(over.key === undefined ? {} : { keyMoney: m(over.key) }),
        ...(over.deposit === undefined ? {} : { deposit: m(over.deposit) }),
      },
    };
  };
  const decodeAll = async (): Promise<{ rent: Array<number | null>; admin: Array<number | null>; flags: number[]; monthlyTier: number[]; initCashTier: number[] }> =>
    (decodeIndex(JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex) as unknown as {
      u: { rent: Array<number | null>; admin: Array<number | null>; flags: number[]; monthlyTier: number[]; initCashTier: number[] };
    }).u;

  test('同棟同房型、賃料相近的另一間管理費 7,500，這間 75,000（0.66 倍，比例門檻抓不到）→ adminSuspect、月額落 C 區', async () => {
    await only(market((bid) => [
      withMoney(unit(bid, 'ok', 113_500, 21.45), { admin: 7500 }),
      withMoney(unit(bid, 'slip', 114_500, 21.45), { admin: 75_000 }),
    ]));
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /sibling_admin_x10 ×1/);
    const u = await decodeAll();
    const slip = u.admin.indexOf(75_000);
    const ok = u.admin.indexOf(7500);
    assert.equal(u.admin[slip], 75_000, '原值照留');
    assert.equal((u.flags[slip] as number) & 16384, 16384);
    assert.equal(u.monthlyTier[slip], 2, '月額＝賃料＋管理費，管理費可疑月額就不能比');
    assert.notEqual(u.initCashTier[slip], 2, '初期費用不含管理費，不受影響');
    assert.equal((u.flags[ok] as number) & 1024, 0, '對的那一列不可被波及');
  });

  test('礼金 10 個月 → initialSuspect＋sunkSuspect，初期費用落 C 區、月額照常；只有敷金可疑時不打 sunkSuspect', async () => {
    await only(market((bid) => [
      withMoney(unit(bid, 'key', 81_050, 21), { key: 810_500 }),
      withMoney(unit(bid, 'dep', 82_050, 22), { deposit: 820_500 }),
    ]));
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /deposit_key_months ×2/);
    const u = await decodeAll();
    const key = u.rent.indexOf(81_050);
    const dep = u.rent.indexOf(82_050);
    assert.equal((u.flags[key] as number) & (8192 | 32768), 8192 | 32768);
    assert.equal(u.initCashTier[key], 2);
    assert.notEqual(u.monthlyTier[key], 2, '賃料與管理費沒問題，月額照常比');
    assert.equal((u.flags[dep] as number) & (8192 | 32768), 8192, '敷金可退，沒攤進實質月成本');
    assert.equal(u.initCashTier[dep], 2);
  });

  test('賃料少打一個 0（14,800）被判可疑後，不再拿它當尺量敷金：敷金 148,000 不可被連帶判成 10 個月', async () => {
    await only(market((bid) => [withMoney(unit(bid, 'typo', 14_800, 42.91), { deposit: 148_000 })]));
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /per_m2_outlier ×1/);
    assert.doesNotMatch(r.stdout, /deposit_key_months/);
    const u = await decodeAll();
    const typo = u.rent.indexOf(14_800);
    assert.equal((u.flags[typo] as number) & 2048, 2048);
    assert.equal((u.flags[typo] as number) & 8192, 0, '錯的是賃料，不是敷金');
  });

  test('徒歩 200 分 → walkYearSuspect，價格各區照常', async () => {
    await only(listing('suumo', 95000, 200));
    const r = await build();
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const u = await decodeAll();
    assert.equal((u.flags[0] as number) & (1024 | 65536), 1024 | 65536);
    assert.equal((u.flags[0] as number) & (2048 | 4096 | 8192 | 16384 | 32768), 0);
    assert.equal(u.monthlyTier[0], 0);
  });

  test('賃料 95,000 円、面積 20㎡ → 沒有任何可疑旗標', async () => {
    await only(listing('suumo', 95000));
    const r = await build();
    assert.equal(r.code, 0);
    const { u } = await decode();
    assert.equal((u.flags[0] as number) & (1024 | 2048 | 4096 | 8192), 0);
    assert.equal(u.monthlyTier[0], 0);
  });
});

describe('顯示字串拆到 names.json.gz：兩個檔案必須綁在一起', () => {
  /**
   * b.name／b.url 佔 index.json 的 46%，而且完全不參與篩選排序，所以拆成第二個檔。
   * 拆開之後最危險的失效模式是**序號錯位**：卡片掛上別棟的名字、
   * 「前往原站」連到別棟的頁面，而且沒有任何錯誤訊息。
   * 這裡實跑 build-data，證明兩個檔案帶著同一個 buildId、長度一致、內容對得上。
   */
  test('index.json.gz 不含 name/url；names.json.gz 帶得回原值，且 buildId 相同', async () => {
    await writeFile(path.join(dir, 'data', 'aliases', 'buildings.json'),
      JSON.stringify({ version: 1, groups: [] }), 'utf8');
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('suumo', 95000))}\n`, 'utf8')));
    await writeFile(path.join(dir, 'data', 'normalized', 'leopalace21.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('leopalace21', 80000))}\n`, 'utf8')));

    const r = await build();
    assert.equal(r.code, 0, `應該成功，stderr=${r.stderr}`);

    const encoded = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex;
    assert.equal(encoded.v, 'C4');
    assert.equal('name' in encoded.b, false, 'name 不該再出現在索引裡');
    assert.equal('url' in encoded.b, false, 'url 不該再出現在索引裡');

    const meta = encoded.meta as { buildId: string; buildings: number };
    assert.match(meta.buildId, /^[0-9a-f]{16}$/, 'buildId 應為 16 位十六進位');

    const names = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'names.json.gz'))).toString('utf8')) as EncodedNames;
    assert.equal(names.v, 'N2');
    assert.equal(names.buildId, meta.buildId, '兩個檔案必須帶同一個 buildId');
    assert.equal(names.n, meta.buildings, 'names 的筆數必須等於索引的建物數');

    const t = decodeNames(names);
    assert.equal(t.name.length, meta.buildings);
    assert.deepEqual(t.name, ['レオパレス閘門テスト', 'レオパレス閘門テスト']);
    assert.deepEqual(t.url, ['https://leopalace21.test/gate', 'https://suumo.test/gate']);
  });

  test('資料沒變時 buildId 不變（瀏覽器快取才有機會命中）', async () => {
    const read = async (): Promise<string> => {
      const e = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex;
      return (e.meta as { buildId: string }).buildId;
    };
    const first = await read();
    const r = await build();
    assert.equal(r.code, 0);
    assert.equal(await read(), first, 'generatedAt 每次都不同，但 buildId 只吃資料');
  });

  test('資料一變 buildId 就變（前端才換得掉舊的名稱檔）', async () => {
    const read = async (): Promise<string> => {
      const e = JSON.parse(gunzipSync(await readFile(path.join(dir, 'out', 'index.json.gz'))).toString('utf8')) as EncodedIndex;
      return (e.meta as { buildId: string }).buildId;
    };
    const before = await read();
    await writeFile(path.join(dir, 'data', 'normalized', 'suumo.ndjson.gz'),
      gzipSync(Buffer.from(`${JSON.stringify(listing('suumo', 96000))}\n`, 'utf8')));
    const r = await build();
    assert.equal(r.code, 0);
    assert.notEqual(await read(), before);
  });
});
