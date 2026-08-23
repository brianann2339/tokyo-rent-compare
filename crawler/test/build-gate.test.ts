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
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { known, notListed, notOffered, yen, type Field, type Yen } from '../../packages/schema/src/field.ts';
import type { Listing, Unit, SourceId } from '../../packages/schema/src/model.ts';

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
function listing(src: SourceId, rent: number): Listing {
  const id = `${src}:gate`;
  return {
    building: {
      id, sourceId: src, sourceKey: 'gate', sourceUrl: `https://${src}.test/gate`,
      name: 'レオパレス閘門テスト', kind: 'apartment', addressRaw: '東京都豊島区', prefecture: '東京都',
      ward: '豊島区', stations: [{ line: 'JR山手線', station: '大塚', walkMinutes: known(5, 'measured', '徒歩5分') }],
      structure: notListed(''), yearBuilt: notListed(''), floorsAboveGround: notListed(''),
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
  test('無 alias 檔 → exit 非零、不產出 index.json', async () => {
    const r = await build();
    assert.notEqual(r.code, 0, '應該以非零離開');
    assert.match(r.stderr, /\[閘門4\] 跨來源同房未審核：豊島区\|レオパレス閘門テスト/);
    assert.equal(existsSync(path.join(dir, 'out', 'index.json')), false, '不可產出 index.json');
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
    const idx = JSON.parse(await readFile(path.join(dir, 'out', 'index.json'), 'utf8')) as {
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

    const provFiles = await readdir(path.join(dir, 'out', 'prov'));
    const prov = JSON.parse(await readFile(path.join(dir, 'out', 'prov', provFiles[0] as string), 'utf8')) as
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
    const idx = JSON.parse(await readFile(path.join(dir, 'out', 'index.json'), 'utf8')) as {
      meta: { units: number; dedup: { crossSource: { groups: number; buildingOnlyCandidates: number } } };
    };
    assert.equal(idx.meta.units, 2, '兩間都要留著');
    assert.equal(idx.meta.dedup.crossSource.groups, 0);
    assert.equal(idx.meta.dedup.crossSource.buildingOnlyCandidates, 1);
  });
});
