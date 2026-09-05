/**
 * 真相層 `.ndjson.gz` 的逐行串流讀取。
 *
 * 為什麼不用 `gunzipSync(readFileSync(p)).toString('utf8').split('\n')`：
 * SUUMO 的真相層解壓後是 302 MB 文字，那一行就讓 rss 多吃 1,354 MB
 * （Buffer 一份、JS 字串一份、split 出來的陣列又一份），
 * 而真正活著的解析後物件只有 549 MB。擴到 23 区會直接撞破 CI runner 的記憶體。
 * 逐行讀的話同一時間只有一行在記憶體裡。
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';

export async function* readNdjsonGz<T>(filePath: string): AsyncGenerator<T> {
  const rl = readline.createInterface({
    input: createReadStream(filePath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue;
      yield JSON.parse(line) as T;
    }
  } finally {
    rl.close();
  }
}
