/**
 * 來源註冊表：自動探索 `crawler/sources/*​/index.ts`。
 *
 * 之前每加一個來源要改三個檔（crawl / build-data / verify），
 * 漏改其中一個會讓那個來源默默不出現在網站上——而且不會有任何錯誤訊息。
 * 改成自動探索之後，「放進目錄」就是唯一的註冊動作。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SourceAdapter } from './types.ts';

const SOURCES_DIR = path.resolve(import.meta.dirname, '../sources');

type AdapterModule = { default?: SourceAdapter };

export async function loadAdapters(): Promise<SourceAdapter[]> {
  const entries = await readdir(SOURCES_DIR, { withFileTypes: true });
  const out: SourceAdapter[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const url = pathToFileURL(path.join(SOURCES_DIR, e.name, 'index.ts')).href;
    const mod: AdapterModule = await import(url);
    const adapter = mod.default;
    if (adapter === undefined || adapter.manifest === undefined) {
      throw new Error('[registry] ' + e.name + ' 缺少合法的 default export（SourceAdapter）');
    }
    out.push(adapter);
  }
  return out;
}

export async function loadSourceIds(): Promise<string[]> {
  const adapters = await loadAdapters();
  return adapters.map((a) => a.manifest.id);
}
