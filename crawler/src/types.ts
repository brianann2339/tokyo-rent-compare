import type { Listing, SourceId, AnyFieldId } from '../../packages/schema/src/model.ts';

/**
 * 取得方式只有三種。
 *
 * 注意「靜態 HTML」與「SSR Next.js」不是取得方式的差異——兩者都是一次 GET 拿完整 HTML，
 * 差別在 extractor。把它們分成兩種 transport 只會造出不必要的分支。
 */
export type TransportKind = 'http' | 'browser' | 'file';

export type Legal = {
  /** false 時來源可存在、可測試，但永不產生資料 */
  readonly enabled: boolean;
  readonly robotsCheckedAt: string;
  /** 上次查證時的 robots.txt sha256；每次執行比對，變動即停該來源 */
  readonly robotsSha256: string | null;
  readonly tosReviewed: 'yes' | 'no' | 'pending';
  /** 條款原文節錄與查證日期，存證用 */
  readonly notes: string;
};

export type Capabilities = {
  /** 這個來源會提供的欄位 */
  readonly provides: readonly AnyFieldId[];
  /**
   * 這個來源**根本沒有**的欄位（例：Couverture 全站無礼金／敷金）。
   * 這些欄位自動得到 why='not_offered_by_source'，健康檢查不對它們告警——
   * 否則會產生永遠 0% 成功率的假警報，警報疲勞會讓人乾脆關掉整個監控。
   */
  readonly neverProvides: readonly AnyFieldId[];
};

export type SourceManifest = {
  readonly id: SourceId;
  readonly name: string;
  readonly nameZh: string;
  readonly homepage: string;
  readonly origin: string;
  readonly transport: TransportKind;
  /**
   * 'page'：discover 只給 URL，由執行器抓詳情頁再 extract（多數來源）。
   * 'none'：資料在 discover 階段就備齊（例：UR 全部走 JSON API），
   *         不必再抓一次詳情頁——那會多打數百次大頁面請求，對對方是無謂負載。
   */
  readonly fetchMode?: 'page' | 'none';
  /** 單站單執行緒的請求間隔。robots.txt 有 Crawl-delay 時取兩者較大值。 */
  readonly crawlDelayMs: number;
  readonly capabilities: Capabilities;
  readonly legal: Legal;
};

export type TargetRef = {
  readonly url: string;
  /** 列表頁已經取得的摘要資料，可省去解析詳情頁 */
  readonly hint?: Record<string, unknown>;
};

export type RawDoc = {
  readonly url: string;
  readonly body: string;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly status: number;
  /** Next.js buildId 等改版指紋，用於早期預警 */
  readonly buildId?: string | undefined;
  /** 304 Not Modified：內容未變，可沿用上次結果 */
  readonly notModified: boolean;
};

export type ExtractContext = {
  readonly manifest: SourceManifest;
  readonly now: Date;
};

export type SourceAdapter = {
  readonly manifest: SourceManifest;
  /** 列舉房源詳情頁 */
  discover(ctx: ExtractContext, fetcher: Fetcher): AsyncGenerator<TargetRef>;
  /** 解析單一頁面。這是每個來源唯一需要自己實作的東西。 */
  extract(raw: RawDoc, ref: TargetRef, ctx: ExtractContext): Listing | null;
};

export type Fetcher = {
  get(url: string, opts?: { readonly headers?: Record<string, string> }): Promise<RawDoc>;
};
