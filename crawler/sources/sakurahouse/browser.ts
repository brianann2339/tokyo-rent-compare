/**
 * Sakura House 專用的瀏覽器取頁器（CDP，零外部相依）。
 *
 * 為什麼不能用專案的 HttpFetcher：www.sakura-house.com 在 Cloudflare 後面，
 * 純 HTTP 客戶端（curl／fetch）取首頁與 /sitemap.xml 一律 403 + managed challenge
 * （2026-08-16 實測）。真實瀏覽器載入則直接放行、不需要任何人機驗證。
 *
 * ⚠️ 這裡**沒有**、也不可以有任何繞過 challenge 的手段：
 * 不偽造 TLS 指紋、不抽 cf_clearance、不呼叫 cloudscraper／FlareSolverr、
 * 不完成任何驗證碼。唯一做的事就是「開一個真的 Chrome 把網址打開」。
 * 若哪天真的跳出需要點選的驗證畫面，capture() 會因為等不到資料而丟例外，
 * 那時要停手問人，不是想辦法點掉它。
 *
 * ⚠️ 必須跑 headed（看得到視窗）。`--headless=new` 實測會卡在 Cloudflare 的
 * 「請稍候…」中介頁 60 秒不動（驗證訊息顯示已通過，但頁面不前進）——
 * 這不是我們該去解的問題，改用一般視窗即可。CI 上要跑就得有 X server／實體桌面。
 *
 * 為什麼用 CDP 而不是 Playwright：專案目前零執行期相依，
 * 為了一個來源引入 Playwright（含瀏覽器下載）代價太大。
 * Node 有內建 WebSocket，spawn 系統 Chrome 再走 DevTools Protocol 就夠了。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(): string {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    '找不到 Chrome。設定 CHROME_PATH 指向瀏覽器執行檔，或安裝 Google Chrome。'
    + `已找過：${CHROME_CANDIDATES.join(', ')}`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type CdpMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
};

type Waiter = { resolve(v: unknown): void; reject(e: Error): void };

/** 一次頁面載入的產物。 */
export type PageCapture = {
  readonly url: string;
  /** 渲染後的 document.documentElement.outerHTML */
  readonly html: string;
  /** 頁面自己向後端要的 GraphQL 回應原文（我們沒有另外發請求） */
  readonly graphql: readonly string[];
  /** 房間清單區塊展開後的可見文字，用來佐證「水電含在賃料內」等聲明 */
  readonly roomListText: string;
};

export type CaptureOptions = {
  /** 等到這個 JS 運算式為 true 才算載好 */
  readonly readyExpression: string;
  /** 展開房間清單（點各樓層標題）後再取文字 */
  readonly expandRooms: boolean;
  readonly timeoutMs: number;
};

export class ChromeSession {
  proc: ChildProcess;
  socket: WebSocket;
  userDataDir: string;
  sessionId: string;
  nextId: number;
  waiters: Map<number, Waiter>;
  graphqlRequestIds: string[];

  constructor(proc: ChildProcess, socket: WebSocket, userDataDir: string) {
    this.proc = proc;
    this.socket = socket;
    this.userDataDir = userDataDir;
    this.sessionId = '';
    this.nextId = 0;
    this.waiters = new Map();
    this.graphqlRequestIds = [];
  }

  static async launch(): Promise<ChromeSession> {
    const bin = findChrome();
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'sakurahouse-'));
    const proc = spawn(bin, [
      // 刻意不加 --headless：見檔頭說明
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1400,1000',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        const m = /ws:\/\/[^\s]+/.exec(buf);
        if (m !== null) {
          proc.stderr?.off('data', onData);
          resolve(m[0]);
        }
      };
      proc.stderr?.on('data', onData);
      proc.once('exit', (code) => reject(new Error(`Chrome 提前結束（exit ${String(code)}）：${buf.slice(0, 400)}`)));
      setTimeout(() => reject(new Error(`等不到 Chrome 的 DevTools 端點：${buf.slice(0, 400)}`)), 30_000);
    });

    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = (): void => resolve();
      socket.onerror = (): void => reject(new Error(`連不上 DevTools：${wsUrl}`));
    });

    const s = new ChromeSession(proc, socket, userDataDir);
    socket.onmessage = (ev: MessageEvent): void => s.onMessage(String(ev.data));

    const target = await s.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const attached = await s.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId: string };
    s.sessionId = attached.sessionId;
    await s.send('Page.enable', {}, s.sessionId);
    await s.send('Runtime.enable', {}, s.sessionId);
    await s.send('Network.enable', {}, s.sessionId);
    return s;
  }

  onMessage(data: string): void {
    const msg = JSON.parse(data) as CdpMessage;
    if (msg.id !== undefined) {
      const w = this.waiters.get(msg.id);
      if (w === undefined) return;
      this.waiters.delete(msg.id);
      if (msg.error !== undefined) w.reject(new Error(`CDP 錯誤：${JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const res = msg.params?.['response'] as { url?: string } | undefined;
      const requestId = msg.params?.['requestId'];
      if (typeof res?.url === 'string' && res.url.includes('/graphql') && typeof requestId === 'string') {
        this.graphqlRequestIds.push(requestId);
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payload['sessionId'] = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`CDP 逾時：${method}`));
      }, 60_000);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    ) as { result?: { value?: unknown } };
    return r.result?.value;
  }

  async capture(url: string, opts: CaptureOptions): Promise<PageCapture> {
    this.graphqlRequestIds = [];
    await this.send('Page.navigate', { url }, this.sessionId);

    const deadline = Date.now() + opts.timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (await this.evaluate(opts.readyExpression) === true) { ready = true; break; }
    }
    if (!ready) {
      // 停在 Cloudflare 的中介頁也會走到這裡。大聲失敗，不要默默產出空資料。
      const title = String(await this.evaluate('document.title'));
      throw new Error(`${url} 在 ${opts.timeoutMs}ms 內沒有載出預期內容（document.title=${JSON.stringify(title)}）`);
    }

    let roomListText = '';
    if (opts.expandRooms) {
      await this.evaluate(
        '[...document.querySelectorAll("[class*=RoomListView__UnitHeader]")].forEach((e) => e.click()), true',
      );
      // 展開是純前端動作（資料在載入時就拿到了），等它把 DOM 畫完即可
      let prev = -1;
      for (let i = 0; i < 20; i++) {
        await sleep(800);
        const len = Number(await this.evaluate(
          '(document.querySelector("#embed-room-list-view")?.innerHTML.length ?? 0)',
        ));
        if (len === prev && len > 0) break;
        prev = len;
      }
      roomListText = String(await this.evaluate(
        '(document.querySelector("#embed-room-list-view")?.innerText ?? "")',
      ));
    }

    const html = String(await this.evaluate('document.documentElement.outerHTML'));
    const graphql: string[] = [];
    for (const requestId of this.graphqlRequestIds) {
      try {
        const r = await this.send('Network.getResponseBody', { requestId }, this.sessionId) as { body?: string };
        if (typeof r.body === 'string') graphql.push(r.body);
      } catch {
        // 回應主體已被瀏覽器丟棄（多半是分析用的小請求），不是故障
      }
    }
    return { url, html, graphql, roomListText };
  }

  close(): void {
    try { this.socket.close(); } catch { /* 已關閉 */ }
    this.proc.kill();
    try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* 暫存目錄清不掉不影響結果 */ }
  }
}
