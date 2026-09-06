/**
 * 顯示用字串（建物名、原站 URL）的獨立檔案編碼。
 *
 * ── 為什麼要拆出去 ──────────────────────────────────────────
 * 首屏索引 2,338 KB gzip 裡，`b.name` 佔 669 KB、`b.url` 佔 407 KB，合計 **46%**。
 * 這兩欄**完全不參與**篩選、排序、統計——它們只在畫卡片時被讀一次。
 * 拆出去之後，索引降到約 1,262 KB，篩選器／筆數／行情分佈／百分位工具
 * 在少載 46% 的位元組之後就能用了。
 *
 * ── 這個檔案最危險的失效模式：序號錯位 ─────────────────────────
 * 這裡的每一格都以**建物序號**與 index.json 對齊。錯開一格，
 * 全站每張卡片都會掛上另一棟的名字、「前往原站」連到另一棟的頁面——
 * 而且完全沒有任何錯誤訊息。那是比解析錯誤更嚴重的虛構：
 * 使用者看到的是一個「看起來完全合理」的錯誤答案。
 * 所以：
 *   1. `buildId` 綁定兩個檔案，對不上就**拒絕使用**（寧可沒有名字，不可以有錯的名字）。
 *   2. `n` 必須等於索引的建物數，長度不符即丟例外。
 *   3. build-data 的閘門對每一格做 `Object.is` 比對，不符就不產檔。
 *
 * ── 編碼手法 ────────────────────────────────────────────────
 * 名稱：SUUMO 在屋主不公開物件名時會用樣板填一句描述
 * （`東急田園都市線 二子玉川駅 地下1地上3階建 築21年`），實測 86,755 棟裡有 31,288 棟是這種。
 * 它們以單一半形空格分成 3〜4 段，每段的相異值都很少（實測 62 / 468 / 201 / 82），
 * 所以走**分欄字典**；其餘 55,467 個真名維持字面值（實測全欄字典反而更大：826 KB vs 669 KB，
 * gzip 對重複字串的處理本來就比索引陣列好，只有分段之後才贏得了）。實測 669 → 570 KB。
 *
 * ⚠️ 判定樣板用的是**結構**（3〜4 段、第 3 段以「階建」結尾），
 * 刻意**不**用 `isGeneratedBuildingName()`。那是給前端決定「要不要印成物件名」的顯示語意，
 * 拿顯示語意當磁碟格式的分支條件，等於把兩個會各自演進的東西綁死——
 * 而且實測今天就已經有 1 筆通過偵測器卻不合抽取式。
 *
 * URL **不編碼**。實測骨架字典＋數字只從 407 KB 降到 342 KB（−16%），
 * 而 86,755 筆裡有 84,159 筆的數字段帶前導零（`jnc_000109401145`），
 * 用 `Number()` 存會靜默吃掉那些零、讓 97% 的連結指到不存在的頁面。
 * 為 65 KB 引進這種陷阱不划算——gzip 對這些隨機 12 位數 id 已經接近資訊熵下限（4.8 B/筆）。
 */

/** 與 index.json 建物序號一一對應的顯示字串。 */
export type NamesTable = {
  name: unknown[];
  url: unknown[];
};

export type EncodedNames = {
  v: 'N1';
  /** 必須與 index.json 的 `meta.buildId` 相同。不同就是兩個不同建置的檔案配在一起。 */
  buildId: string;
  /** 建物數。必須等於 index.json 的 `meta.buildings`。 */
  n: number;
  /** 每棟的名稱來自哪條路徑：0 = `lit` 的下一格，1 = `c` 的下一列。 */
  k: number[];
  /** 字面值名稱，依序 */
  lit: unknown[];
  /** 四段的字典 */
  d: [string[], string[], string[], string[]];
  /** 四段的字典索引，依序 */
  c: [number[], number[], number[], number[]];
  url: unknown[];
};

/** 樣板句的段數上限（`線 站 階建 屋齡`）。第 4 段可以不存在。 */
const SEGS = 4;

/**
 * 把名稱切成可還原的段。
 *
 * 條件寫得很緊，因為還原只是 `join(' ')`：
 *   - 只有 3 或 4 段（多一段少一段都不處理）
 *   - 沒有空段（連續空白、前後空白都會讓 join 還原不回去）
 *   - 其中一段以「階建」結尾（這才是 SUUMO 的樓層樣板，不是隨便一個有空白的名字）
 *
 * ⚠️ 「階建」不固定在第 3 段：沒有最寄駅時樣板改用地址，只有 3 段——
 * `東京都台東区清川１ 10階建 築2年` 的階建在第 2 段。寫死段號會讓這一整類
 * 安靜地掉回字面值（不會出錯，但白白少壓一批）。
 *
 * 不符就回 null，走字面值——**寧可存原字串，不可以存一個還原不回去的結構**。
 * 判準只決定「要不要試」，正確性由呼叫端的逐字元回比保證。
 */
function segsOf(name: unknown): string[] | null {
  if (typeof name !== 'string') return null;
  const p = name.split(' ');
  if (p.length !== 3 && p.length !== 4) return null;
  let hasFloors = false;
  for (const x of p) {
    if (x === '') return null;
    if (/階建$/.test(x)) hasFloors = true;
  }
  if (!hasFloors) return null;
  while (p.length < SEGS) p.push('');
  return p;
}

/** 段 → 原字串。空段只可能出現在尾端（segsOf 拒絕中間的空段）。 */
function joinSegs(p: readonly string[]): string {
  let s = '';
  for (const x of p) {
    if (x === '') continue;
    s = s === '' ? x : `${s} ${x}`;
  }
  return s;
}

export function encodeNames(t: NamesTable, buildId: string): EncodedNames {
  const n = t.name.length;
  if (t.url.length !== n) {
    throw new Error(`[names-codec] name 有 ${n} 格、url 有 ${t.url.length} 格，兩欄必須等長`);
  }
  if (typeof buildId !== 'string' || buildId === '') {
    throw new Error('[names-codec] buildId 不可為空——沒有它就沒辦法證明兩個檔案來自同一次建置');
  }

  const k: number[] = [];
  const lit: unknown[] = [];
  const dicts: Array<Map<string, number>> = [new Map(), new Map(), new Map(), new Map()];
  const cols: number[][] = [[], [], [], []];

  for (let i = 0; i < n; i++) {
    const v = t.name[i];
    const segs = segsOf(v);
    // 自我驗證：切完再組回去，逐字元不等於原值就退回字面值。
    // 這讓「無損」是結構上的保證，而不是「我的正則寫對了」的假設。
    if (segs === null || !Object.is(joinSegs(segs), v)) {
      k.push(0);
      lit.push(v);
      continue;
    }
    k.push(1);
    for (let c = 0; c < SEGS; c++) {
      const seg = segs[c] as string;
      const m = dicts[c] as Map<string, number>;
      let idx = m.get(seg);
      if (idx === undefined) { idx = m.size; m.set(seg, idx); }
      (cols[c] as number[]).push(idx);
    }
  }

  return {
    v: 'N1',
    buildId,
    n,
    k,
    lit,
    d: dicts.map((m) => [...m.keys()]) as EncodedNames['d'],
    c: cols as EncodedNames['c'],
    url: t.url,
  };
}

export function decodeNames(o: EncodedNames): NamesTable {
  if (o.v !== 'N1') throw new Error(`[names-codec] 認不得的版本 ${JSON.stringify(o.v)}`);
  const n = o.n;
  if (!Number.isInteger(n) || n < 0) throw new Error(`[names-codec] n 不是非負整數：${JSON.stringify(n)}`);
  if (o.k.length !== n) throw new Error(`[names-codec] k 有 ${o.k.length} 格，應為 ${n}`);
  if (o.url.length !== n) throw new Error(`[names-codec] url 有 ${o.url.length} 格，應為 ${n}`);

  const name = new Array<unknown>(n);
  let li = 0;
  let ti = 0;
  for (let i = 0; i < n; i++) {
    if (o.k[i] === 0) {
      if (li >= o.lit.length) throw new Error(`[names-codec] 第 ${i} 棟要讀 lit[${li}]，但 lit 只有 ${o.lit.length} 格`);
      name[i] = o.lit[li];
      li += 1;
      continue;
    }
    const segs: string[] = [];
    for (let c = 0; c < SEGS; c++) {
      const col = o.c[c] as number[];
      if (ti >= col.length) throw new Error(`[names-codec] 第 ${i} 棟要讀 c[${c}][${ti}]，但該欄只有 ${col.length} 格`);
      const idx = col[ti] as number;
      const dict = o.d[c] as string[];
      const seg = dict[idx];
      if (seg === undefined) throw new Error(`[names-codec] 第 ${i} 棟第 ${c} 段的字典索引 ${idx} 超出字典（${dict.length} 個）`);
      segs.push(seg);
    }
    ti += 1;
    name[i] = joinSegs(segs);
  }
  // 兩條稠密子陣列必須剛好被讀完——沒讀完代表 k 與資料對不上，那正是錯位的前兆
  if (li !== o.lit.length) throw new Error(`[names-codec] lit 有 ${o.lit.length} 格，但只用掉 ${li} 格`);
  const used = (o.c[0] as number[]).length;
  if (ti !== used) throw new Error(`[names-codec] 樣板欄有 ${used} 列，但只用掉 ${ti} 列`);
  for (let c = 1; c < SEGS; c++) {
    const col = o.c[c] as number[];
    if (col.length !== used) throw new Error(`[names-codec] c[${c}] 有 ${col.length} 列，c[0] 有 ${used} 列，四欄必須等長`);
  }

  return { name, url: o.url };
}

/**
 * 逐格 `Object.is` 比對。與 `assertLossless` 同一個角色：
 * 讓「解碼後的字串跟原值不一樣而且沒人會知道」在結構上不可能發生。
 */
export function assertNamesLossless(orig: NamesTable, back: NamesTable): { cells: number } {
  let cells = 0;
  for (const key of ['name', 'url'] as const) {
    const a = orig[key];
    const b = back[key];
    if (a.length !== b.length) throw new Error(`[names-codec] ${key} 長度 ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < a.length; i++) {
      cells += 1;
      if (!Object.is(a[i], b[i])) {
        throw new Error(`[names-codec] ${key}[${i}] 原值 ${JSON.stringify(a[i])} → 解碼 ${JSON.stringify(b[i])}`);
      }
    }
  }
  return { cells };
}
