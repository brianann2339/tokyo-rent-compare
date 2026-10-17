import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { daysSince, sourceFreshness, STALE_DAYS, type Wire } from '../src/data.ts';

/**
 * 「確認於」與「可能已出租」：兩個月前抓的房與今天抓的房，在卡片上必須看得出不一樣。
 * Sakura House 只能人在場用真實瀏覽器抓，其他來源自動刷新之後它就會落後——
 * 沒有這個標示，使用者會把兩個月前的空房當成現況。
 */

describe('daysSince', () => {
  const now = new Date('2026-10-17T09:00:00+09:00'); // UTC 10-17 00:00

  test('同一天是 0、前一天是 1，跨月照算', () => {
    assert.equal(daysSince('2026-10-17', now), 0);
    assert.equal(daysSince('2026-10-16', now), 1);
    assert.equal(daysSince('2026-08-16', now), 62);
  });

  test('格式不對回 null，不猜一個天數', () => {
    for (const bad of ['', '2026/10/17', '2026-10', undefined, '10-17']) assert.equal(daysSince(bad, now), null, String(bad));
  });

  test('門檻：剛好 14 天不算舊，15 天才算', () => {
    assert.equal(STALE_DAYS, 14);
    assert.ok(!((daysSince('2026-10-03', now) as number) > STALE_DAYS));
    assert.ok((daysSince('2026-10-02', now) as number) > STALE_DAYS);
  });
});

describe('sourceFreshness', () => {
  test('每個來源取它所有建物抓取日的最大值；沒有建物的來源不列', () => {
    const w = {
      dict: { sources: ['suumo', 'sakurahouse', 'jkk'] },
      b: { src: [0, 1, 0, 1], fetchedAt: ['2026-10-16', '2026-08-16', '2026-10-17', '2026-08-15'] },
    } as unknown as Wire;
    assert.deepEqual(sourceFreshness(w), [
      { src: 'suumo', latest: '2026-10-17' },
      { src: 'sakurahouse', latest: '2026-08-16' },
    ]);
  });
});
