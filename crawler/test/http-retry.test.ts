import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { describeFetchError, fetchRetrying } from '../src/http.ts';

/**
 * 重試只能用在「對方暫時過載」，不能變成「被擋了還一直敲」。
 * 這裡釘住兩件事：哪些狀態會重試、哪些絕對不重試。
 */

const BACKOFF = [10, 20, 30];

async function run(responses: Array<number | Error>): Promise<{ result: Response | Error; calls: number; waits: number[] }> {
  let calls = 0;
  const waits: number[] = [];
  const result = await fetchRetrying(async () => {
    const r = responses[calls] ?? 200;
    calls += 1;
    if (r instanceof Error) throw r;
    return new Response('body', { status: r });
  }, { backoffMs: BACKOFF, sleep: async (ms) => { waits.push(ms); }, onRetry: () => {} }).catch((e: Error) => e);
  return { result, calls, waits };
}

describe('暫時性失敗才重試', () => {
  test('503 一次後恢復 → 第二次就拿到 200，等過一次退避', async () => {
    const r = await run([503, 200]);
    assert.ok(r.result instanceof Response);
    assert.equal(r.result.status, 200);
    assert.equal(r.calls, 2);
    assert.deepEqual(r.waits, [10]);
  });

  test('502／504／連線錯誤也算暫時性', async () => {
    const r = await run([502, 504, new TypeError('fetch failed'), 200]);
    assert.ok(r.result instanceof Response);
    assert.equal(r.calls, 4);
    assert.deepEqual(r.waits, [10, 20, 30]);
  });

  test('退避用完仍失敗 → 丟例外，不回傳一個 503 讓呼叫端當成功', async () => {
    const r = await run([503, 503, 503, 503]);
    assert.ok(r.result instanceof Error);
    assert.match(r.result.message, /http 503.*重試 3 次仍失敗/);
    assert.equal(r.calls, 4);
  });
});

describe('對方可能在叫我們停的狀態，一次都不重試', () => {
  for (const status of [403, 429, 404, 500]) {
    test(`${status} 原樣交回呼叫端，不重試`, async () => {
      const r = await run([status, 200]);
      assert.ok(r.result instanceof Response);
      assert.equal(r.result.status, status);
      assert.equal(r.calls, 1);
      assert.deepEqual(r.waits, []);
    });
  }
});

describe('連線層錯誤要帶出 cause，否則無從診斷', () => {
  test('fetch failed 的 cause（含 code）接在訊息後面', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const e = new TypeError('fetch failed', { cause });
    assert.equal(describeFetchError(e), 'fetch failed（UND_ERR_SOCKET other side closed）');
  });

  test('沒有 cause 就只回原訊息；非 Error 轉字串', () => {
    assert.equal(describeFetchError(new Error('boom')), 'boom');
    assert.equal(describeFetchError('x'), 'x');
  });

  test('退避用完時的例外訊息也帶 cause', async () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const err = () => new TypeError('fetch failed', { cause });
    const r = await run([err(), err(), err(), err()]);
    assert.ok(r.result instanceof Error);
    assert.match(r.result.message, /fetch failed（ETIMEDOUT connect ETIMEDOUT）.*重試 3 次仍失敗/);
  });
});
