/**
 * 建物名正規化：跨來源比對同一棟樓用的鍵。
 * 刻意保守——只抹掉空白、括號與標點這類純寫法差異，不去品牌詞、不做模糊比對；
 * 寧可同一棟樓沒對上，也不能把兩棟不同的樓併成一棟。
 */

import { toHalfWidth } from './text.ts';

/** NFKC 會把「［］（）」轉成半形，所以兩種寫法都要收；「【】」不在 NFKC 範圍內。 */
const BRACKETED_RE = /[【［\[（(][^】］\]）)]*[】］\]）)]/g;
const NOISE_RE = /[・･\-‐―~～!！.。,、/／_"']/g;

export function normalizeBuildingName(s: string): string {
  return toHalfWidth(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/\s/g, '')
    .replace(BRACKETED_RE, '')
    .replace(NOISE_RE, '');
}

export function buildingMatchKey(ward: string, name: string): string {
  return `${ward}|${normalizeBuildingName(name)}`;
}

/**
 * 「這個字串其實不是物件名，是 SUUMO 代替名稱印出來的描述」。
 *
 * 屋主不公開物件名時，SUUMO 的一覧頁會用固定樣板生一個字串填在名稱欄：
 *   `東急田園都市線 駒沢大学駅 3階建 新築`
 *   `東京メトロ有楽町線 護国寺駅 地下1地上11階建 築27年`
 *   `東京都台東区清川１ 10階建 築2年`（沒有最寄駅時改用地址）
 *   `京成押上線 四ツ木駅 2階建 築99年以上`
 * 2026-09-06 全量實測：87,113 棟裡有 33,299 棟（38.2%）是這種樣板字串。
 *
 * 為什麼要分辨：把它當成物件名印在卡片標題上，使用者會以為那是樓的名字；
 * 而且同一條樣板會有十幾棟撞名（最多 15 棟叫「東急田園都市線 駒沢大学駅 3階建 新築」）。
 * 真相層照原文存（那確實是原站印的字），由前端決定怎麼呈現。
 *
 * 判準刻意寫得很緊：整串必須完全符合樣板才算。實測會**不**命中的真實例子：
 *   `エスト・フォンティーヌ　ＳＲＣ造１０階建て賃貸マンション`（有真名，且是「階建て」）
 *   `東新小岩3階建て一軒家`
 */
const GENERATED_NAME_RE =
  /^(?:\S+\s+\S+駅|東京都\S+)\s+(?:地下\d{1,2})?(?:地上)?\d{1,3}階建(?:\s+(?:新築|築\d{1,3}年(?:以上)?))?$/;

export function isGeneratedBuildingName(name: string): boolean {
  return GENERATED_NAME_RE.test(name.trim());
}
