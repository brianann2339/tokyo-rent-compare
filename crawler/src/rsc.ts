/**
 * Next.js App Router 的 RSC flight payload 解析。
 *
 * 重要：**不解析 flight 協定本身**。
 * 協定裡的 chunk 編號、`$` 前綴哨兵、`I[...]` 模組參照、`$L1`/`$undefined` 編碼
 * 都是 React 內部細節，跨版本改過，綁上去就是把解析器綁在對方的 build 上。
 *
 * 改成兩步：
 *   1. 重組——抓出所有 `self.__next_f.push([1,"…"])` 的**字串字面值**，各自 JSON.parse
 *      後串接成一個大 buffer。這一步只依賴「有 __next_f.push」這一個事實。
 *   2. 錨定擷取——在 buffer 上用鍵名錨定 + 大括號配對掃描切出物件。
 *
 * 這樣協定改版不會弄壞我們，只有對方自己的資料欄位改名才會——
 * 而那會同時弄壞任何一種做法。
 */

const PUSH_RE = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;

/**
 * 把 flight payload 重組成一個可掃描的字串。
 *
 * 同一個路由有兩種回應格式，這個函式兩種都吃：
 *   - 一般 GET → HTML，payload 分散在多個 `self.__next_f.push([1,"…"])` 裡（需重組）
 *   - 帶 `RSC: 1` 標頭 → `text/x-component`，**payload 本身就是回應主體**（不需重組）
 * 實測（ひつじ不動産，2026-08-16）：同一頁 HTML 版只含 30 筆卡片，
 * RSC 版含全部 1,244 筆——差異很大，兩種都必須支援。
 */
export function reassembleFlight(input: string): string {
  let out = '';
  let found = false;
  for (const m of input.matchAll(PUSH_RE)) {
    const lit = m[1];
    if (lit === undefined) continue;
    found = true;
    try {
      out += JSON.parse(lit) as string;
    } catch {
      // 單一 chunk 解析失敗不該讓整頁失效
    }
  }
  // 沒有 push 呼叫 → 這已經是裸的 flight payload
  return found ? out : input;
}

type Bracket = '{' | '[';
const CLOSING: Record<Bracket, string> = { '{': '}', '[': ']' };

/**
 * 從 start 位置的括號開始做配對掃描，回傳完整的 JSON 片段。
 * 會正確跳過字串內的括號與跳脫字元。
 */
export function sliceBalanced(s: string, start: number): string | null {
  const open = s[start];
  if (open !== '{' && open !== '[') return null;
  const close = CLOSING[open as Bracket];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 以鍵名錨定擷取所有相符的物件。
 * anchor 是一個能唯一辨識該物件的正則（例：`/\{"id":\d+,"number":"/`）。
 */
export function extractObjects<T = unknown>(buf: string, anchor: RegExp): T[] {
  const re = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`);
  const out: T[] = [];
  for (const m of buf.matchAll(re)) {
    const frag = sliceBalanced(buf, m.index);
    if (frag === null) continue;
    try {
      out.push(JSON.parse(frag) as T);
    } catch {
      // 切出來不是合法 JSON：跳過，由健康檢查的填充率反映
    }
  }
  return out;
}

/** 取某個鍵之後緊接的陣列，例：`"singleRoom":[…]`。 */
export function extractArrayAfterKey<T = unknown>(buf: string, key: string): T[] {
  const needle = `"${key}":`;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(needle, from);
    if (i < 0) break;
    const bracket = buf.indexOf('[', i + needle.length - 1);
    if (bracket < 0 || bracket > i + needle.length + 2) { from = i + needle.length; continue; }
    const frag = sliceBalanced(buf, bracket);
    from = i + needle.length;
    if (frag === null) continue;
    try {
      const arr = JSON.parse(frag) as T[];
      out.push(...arr);
    } catch {
      /* 跳過 */
    }
  }
  return out;
}
