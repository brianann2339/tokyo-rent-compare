import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { loadWire, loadNames, type LoadProgress, type Wire } from '../src/data.ts';
import { encodeNames } from '../../packages/wire-codec/src/names.ts';
import { encodeIndex, decodeIndex, type ColumnIndex } from '../../packages/wire-codec/src/index.ts';

/**
 * 索引擴到 23 区後會是數 MB，載入進度是使用者唯一能分辨「還在下載」與「壞了」的訊號。
 * 這裡用假的 fetch 驗進度事件序列——尤其是伺服器加了 content-encoding 時**不可**拿
 * content-length 當分母（那是壓縮後的位元組數，除下去會超過 100%）。
 *
 * 自 C4 起索引是建置時預壓的 `index.json.gz`（Pages 送 application/gzip、不加 content-encoding），
 * 主路徑是「讀壓縮位元組報進度 → 看魔數 → 自己解壓」。
 *
 * 載體用**真的 C4 編碼檔**而不是隨手寫的物件：hydrate 現在會拒絕認不得的版本，
 * 用假載體測等於測一條實際上不存在的路徑。
 */

/** 一棟兩間的最小索引。欄位齊全才過得了 encodeIndex 的等長檢查。 */
function makeIndex(): ColumnIndex {
  return {
    meta: { buildId: 'testbuild0000003', provDir: 'testbuild0000003', buildings: 1, units: 2 },
    dict: { wards: ['文京区'] },
    b: {
      ward: [0], src: [0], kind: [1], also: [0], stc: [2], total: [10], yearBuilt: [2015],
      stn: [0, 1], stw: [5, null], btype: [0], fetchedAt: ['2026-09-06'],
    },
    u: {
      bid: [0, 0], room: ['101', null], layout: [0, 1], area: [20.5, 33], floor: [1, 2],
      rent: [80000, 120000], admin: [5000, 8000], util: [null, null], utilBasis: [2, 2],
      key: [80000, 0], dep: [160000, null], depNR: [null, null],
      gender: [1, 1], foreigner: [-1, 1], vacant: [1, 1],
      monthlyLower: [85000, 128000], monthlyTier: [0, 0],
      initCash: [240000, 0], initCashTier: [0, 1],
      initSunk: [80000, 0], effMonthly12: [91667, 128000],
      missing: [0, 3], flags: [0, 4], ads: [1, 2],
    },
  };
}

const ENCODED = encodeIndex(makeIndex());
/** loadWire 回傳的是解碼後的索引，所以期望值也要走同一條解碼路徑 */
const BODY = decodeIndex(JSON.parse(JSON.stringify(ENCODED)) as typeof ENCODED) as unknown as Record<string, unknown>;

function streamResponse(opts: { headers: Record<string, string>; chunks: Array<string | Uint8Array>; ok?: boolean; status?: number }): Response {
  const enc = new TextEncoder();
  const parts = opts.chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++] as Uint8Array);
      else ctrl.close();
    },
  });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => opts.headers[k.toLowerCase()] ?? null },
    body,
    json: async () => { throw new Error('loadWire 不應該呼叫 res.json()——它要自己讀位元組才報得出進度'); },
  } as unknown as Response;
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

/** 把 JSON 切成 n 段，模擬多個網路封包 */
function split(text: string, n: number): string[] {
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let k = 0; k < text.length; k += size) out.push(text.slice(k, k + size));
  return out;
}

/** 位元組版：預壓檔的封包邊界落在壓縮資料的任何位置 */
function splitBytes(b: Uint8Array, n: number): Uint8Array[] {
  const size = Math.ceil(b.length / n);
  const out: Uint8Array[] = [];
  for (let k = 0; k < b.length; k += size) out.push(b.slice(k, k + size));
  return out;
}

describe('loadWire 的下載進度', () => {
  const json = JSON.stringify(ENCODED);
  const gz = new Uint8Array(gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));

  test('預壓的 index.json.gz（主路徑）：content-length 就是壓縮後位元組數，進度能走到 100%，解出來與原檔相同', async () => {
    const chunks = splitBytes(gz, 4);
    let asked = '';
    globalThis.fetch = (async (u: string) => {
      asked = u;
      return streamResponse({ headers: { 'content-type': 'application/gzip', 'content-length': String(gz.byteLength) }, chunks });
    }) as unknown as typeof fetch;

    const seen: LoadProgress[] = [];
    const w = await loadWire((p) => seen.push({ ...p }));

    assert.ok(asked.endsWith('data/index.json.gz'), `應請求預壓檔，實際 ${asked}`);
    assert.deepEqual(w, BODY, '解壓＋解碼結果必須與原 JSON 完全相同');
    const dl = seen.filter((p) => p.phase === 'download');
    assert.equal(dl.length, chunks.length, '每個 chunk 一次進度');
    assert.ok(dl.every((p) => p.total === gz.byteLength));
    assert.equal(dl[dl.length - 1]?.loaded, gz.byteLength, '下載完成時 loaded 應等於 total');
    // loaded 必須單調遞增，否則進度條會倒退
    for (let k = 1; k < dl.length; k++) assert.ok((dl[k] as LoadProgress).loaded > (dl[k - 1] as LoadProgress).loaded);
    assert.equal(seen[seen.length - 1]?.phase, 'parse', '最後一個事件是 parse');
  });

  test('未壓縮傳輸（例如開發伺服器直接給 JSON）：看魔數就知道不必解壓', async () => {
    const chunks = split(json, 4);
    globalThis.fetch = (async () => streamResponse({
      // content-length 是**位元組**數。索引裡有日文，字元數會小於位元組數，
      // 拿字元數當分母會讓進度永遠到不了 100%。
      headers: { 'content-length': String(new TextEncoder().encode(json).byteLength) }, chunks,
    })) as typeof fetch;

    const seen: LoadProgress[] = [];
    const w = await loadWire((p) => seen.push({ ...p }));
    assert.deepEqual(w, BODY);
    const bytes = new TextEncoder().encode(json).byteLength;
    assert.equal(seen.filter((p) => p.phase === 'download').pop()?.loaded, bytes);
  });

  test('瀏覽器不支援 DecompressionStream → 明講原因，不丟一個看不懂的 JSON 語法錯誤', async () => {
    const saved = globalThis.DecompressionStream;
    (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
    try {
      globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: [gz] })) as typeof fetch;
      await assert.rejects(() => loadWire(), /不支援 DecompressionStream，無法讀取索引/);
    } finally {
      globalThis.DecompressionStream = saved;
    }
  });

  test('伺服器自己解壓（content-encoding: gzip）：total 必須是 null——header 是壓縮後大小，拿來當分母會超過 100%', async () => {
    // 情境：若伺服器對 .json.gz 加了 content-encoding，瀏覽器會先解掉，reader 讀到的是 JSON 本體，
    // content-length 卻還是壓縮後的位元組數。若誤用它當分母，解壓後的 loaded 會遠大於它。
    globalThis.fetch = (async () => streamResponse({
      headers: { 'content-encoding': 'gzip', 'content-length': String(Math.floor(json.length / 5)) },
      chunks: split(json, 3),
    })) as typeof fetch;

    const seen: LoadProgress[] = [];
    await loadWire((p) => seen.push({ ...p }));

    assert.ok(seen.length > 0);
    assert.ok(seen.every((p) => p.total === null), 'gzip 時 total 必須是 null，不可用壓縮後大小當分母');
    const last = seen.filter((p) => p.phase === 'download').pop() as LoadProgress;
    assert.equal(last.loaded, new TextEncoder().encode(json).byteLength, '仍要報得出已下載的解壓後位元組數');
  });

  test('沒有 content-length（chunked）：total 是 null 但仍報 loaded', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: split(json, 2) })) as typeof fetch;
    const seen: LoadProgress[] = [];
    await loadWire((p) => seen.push({ ...p }));
    assert.ok(seen.every((p) => p.total === null));
    assert.ok((seen[0] as LoadProgress).loaded > 0);
  });

  test('不傳 onProgress 時結果相同', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: [gz] })) as typeof fetch;
    assert.deepEqual(await loadWire(), BODY);
  });

  test('HTTP 錯誤要丟例外，不可回半份資料', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: ['{}'], ok: false, status: 404 })) as typeof fetch;
    await assert.rejects(() => loadWire(() => {}), /HTTP 404/);
  });

  test('多位元組字元跨 chunk 邊界不可被截斷（日文建物名會踩到）', async () => {
    const ja = json; // 真的 C4 檔，字典裡就有日文站名與区名
    const enc = new TextEncoder().encode(ja);
    // 刻意在多位元組字元中間切開
    const mid = Math.floor(enc.length / 2);
    const dec = new TextDecoder();
    const chunks = [dec.decode(enc.slice(0, mid), { stream: true }), dec.decode(enc.slice(mid))];
    // 上面的切法若正確，兩段接回來要等於原字串
    assert.equal(chunks.join(''), ja);

    // 真正的測試：直接餵 byte 級的切割
    let i = 0;
    const parts = [enc.slice(0, mid), enc.slice(mid)];
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) { if (i < parts.length) ctrl.enqueue(parts[i++] as Uint8Array); else ctrl.close(); },
    });
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      body,
      json: async () => JSON.parse(ja) as unknown,
    } as unknown as Response)) as typeof fetch;

    const w = await loadWire(() => {}) as { dict: { wards: string[] } };
    assert.deepEqual(w.dict.wards, (BODY as { dict: { wards: string[] } }).dict.wards,
      '日文不可因為 chunk 邊界而變成亂碼');
    assert.ok(w.dict.wards.includes('文京区'), 'fixture 必須真的含多位元組字元，否則這個測試沒在測東西');
  });
});

describe('loadNames：兩個檔案必須來自同一次建置', () => {
  const wire = BODY as unknown as Wire;

  const namesResponse = (payload: unknown): Response => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-encoding' ? 'gzip' : null) },
    body: null,
    json: async () => payload,
  } as unknown as Response);

  test('buildId 相同 → 正常拿到名稱與連結', async () => {
    const enc = encodeNames({ name: ['甲棟'], url: ['https://example.test/1'] }, wire.meta.buildId);
    let asked = '';
    globalThis.fetch = (async (u: string) => { asked = u; return namesResponse(enc); }) as unknown as typeof fetch;
    const n = await loadNames(wire);
    assert.deepEqual(n.name, ['甲棟']);
    assert.deepEqual(n.url, ['https://example.test/1']);
    assert.ok(asked.includes(`?v=${wire.meta.buildId}`),
      `網址要帶 buildId 才繞得開 GitHub Pages 那 10 分鐘的舊快取，實際 ${asked}`);
  });

  test('buildId 不同 → 丟例外，不回一份會張冠李戴的名單', async () => {
    const enc = encodeNames({ name: ['別棟'], url: ['https://example.test/9'] }, 'someotherbuild01');
    globalThis.fetch = (async () => namesResponse(enc)) as unknown as typeof fetch;
    await assert.rejects(() => loadNames(wire), /不是同一次建置/);
  });

  test('筆數與索引的建物數不符 → 丟例外', async () => {
    const enc = encodeNames({ name: ['甲', '乙'], url: ['a', 'b'] }, wire.meta.buildId);
    globalThis.fetch = (async () => namesResponse(enc)) as unknown as typeof fetch;
    await assert.rejects(() => loadNames(wire), /序號對不上/);
  });

  test('HTTP 錯誤要丟例外', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 404, headers: { get: () => null }, body: null, json: async () => ({}),
    } as unknown as Response)) as typeof fetch;
    await assert.rejects(() => loadNames(wire), /HTTP 404/);
  });
});
