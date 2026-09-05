import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadWire, type LoadProgress } from '../src/data.ts';

/**
 * 索引擴到 23 区後會是數 MB，載入進度是使用者唯一能分辨「還在下載」與「壞了」的訊號。
 * 這裡用假的 fetch 驗進度事件序列——尤其是 gzip 傳輸時**不可**拿 content-length 當分母
 * （那是壓縮後的位元組數，除下去會超過 100%）。
 */

const BODY = { meta: { units: 2 }, dict: {}, b: {}, u: {} };

function streamResponse(opts: { headers: Record<string, string>; chunks: string[]; ok?: boolean; status?: number }): Response {
  const enc = new TextEncoder();
  const parts = opts.chunks.map((c) => enc.encode(c));
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
    json: async () => JSON.parse(opts.chunks.join('')) as unknown,
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

describe('loadWire 的下載進度', () => {
  const json = JSON.stringify(BODY);

  test('未壓縮傳輸：content-length 可當分母，最後一次進度 loaded === total', async () => {
    const chunks = split(json, 4);
    globalThis.fetch = (async () => streamResponse({
      headers: { 'content-length': String(json.length) }, chunks,
    })) as typeof fetch;

    const seen: LoadProgress[] = [];
    const w = await loadWire((p) => seen.push({ ...p }));

    assert.deepEqual(w, BODY, '解析結果必須與原 JSON 完全相同');
    const dl = seen.filter((p) => p.phase === 'download');
    assert.equal(dl.length, chunks.length, '每個 chunk 一次進度');
    assert.ok(dl.every((p) => p.total === json.length));
    assert.equal(dl[dl.length - 1]?.loaded, json.length, '下載完成時 loaded 應等於 total');
    // loaded 必須單調遞增，否則進度條會倒退
    for (let k = 1; k < dl.length; k++) assert.ok((dl[k] as LoadProgress).loaded > (dl[k - 1] as LoadProgress).loaded);
    assert.equal(seen[seen.length - 1]?.phase, 'parse', '最後一個事件是 parse');
  });

  test('gzip 傳輸：total 必須是 null——header 是壓縮後大小，拿來當分母會超過 100%', async () => {
    // 真實情境：GitHub Pages 回 content-encoding: gzip，content-length 是壓縮後的位元組數。
    // 若誤用它當分母，解壓後的 loaded 會遠大於它。
    globalThis.fetch = (async () => streamResponse({
      headers: { 'content-encoding': 'gzip', 'content-length': String(Math.floor(json.length / 5)) },
      chunks: split(json, 3),
    })) as typeof fetch;

    const seen: LoadProgress[] = [];
    await loadWire((p) => seen.push({ ...p }));

    assert.ok(seen.length > 0);
    assert.ok(seen.every((p) => p.total === null), 'gzip 時 total 必須是 null，不可用壓縮後大小當分母');
    const last = seen.filter((p) => p.phase === 'download').pop() as LoadProgress;
    assert.equal(last.loaded, json.length, '仍要報得出已下載的解壓後位元組數');
  });

  test('沒有 content-length（chunked）：total 是 null 但仍報 loaded', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: split(json, 2) })) as typeof fetch;
    const seen: LoadProgress[] = [];
    await loadWire((p) => seen.push({ ...p }));
    assert.ok(seen.every((p) => p.total === null));
    assert.ok((seen[0] as LoadProgress).loaded > 0);
  });

  test('不傳 onProgress 時走原本的 res.json()，結果相同', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: [json] })) as typeof fetch;
    assert.deepEqual(await loadWire(), BODY);
  });

  test('HTTP 錯誤要丟例外，不可回半份資料', async () => {
    globalThis.fetch = (async () => streamResponse({ headers: {}, chunks: ['{}'], ok: false, status: 404 })) as typeof fetch;
    await assert.rejects(() => loadWire(() => {}), /HTTP 404/);
  });

  test('多位元組字元跨 chunk 邊界不可被截斷（日文建物名會踩到）', async () => {
    const ja = JSON.stringify({ meta: { units: 1 }, dict: { wards: ['文京区', '渋谷区'] }, b: {}, u: {} });
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
    assert.deepEqual(w.dict.wards, ['文京区', '渋谷区'], '日文不可因為 chunk 邊界而變成亂碼');
  });
});
