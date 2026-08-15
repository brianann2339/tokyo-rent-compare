/**
 * 反虛構的型別基礎。
 *
 * 這個檔案存在的唯一理由：讓「編造一個數字」在型別層就做不到。
 * 兩個設計決定，都是為了對抗 JavaScript 的預設行為：
 *
 * 1. 金額用物件包裝（Yen），不是裸 number。
 *    因為 `null + 5 === 5`、`Math.min(null, 100) === 0`——用裸 number | null
 *    表示「不知道」，任何一次忘記檢查的算術都會靜默地把未知變成 0。
 *    包成物件後，裸的 `a + b` 直接編譯失敗。
 *
 * 2. Field<T> 是判別式聯集，不是 { value: T | null }。
 *    沒有值的時候「根本沒有 .v 這個屬性」，未檢查就存取是編譯錯誤；
 *    就算繞過型別，執行期得到的是 undefined + 5 = NaN（大聲失敗），
 *    而不是 null + 5 = 5（靜默造假）。
 */

/** 日圓。名義型別：包成物件，讓裸算術編譯失敗，強迫所有加總走 sumYen。 */
export type Yen = { readonly jpy: number };

export function yen(jpy: number): Yen {
  if (!Number.isFinite(jpy)) throw new Error(`yen() 收到非有限數：${jpy}`);
  return { jpy };
}

export const ZERO_YEN: Yen = { jpy: 0 };

/**
 * 這個值「為什麼是這個值」——決定它能不能被拿去比較。
 *
 * included_stated 是關鍵：原站明寫「光熱費込み」時，水電費 = 0 是
 * 一個真實的、有來源的事實，不是虛構。它跟「不知道水電多少」
 * 必須是兩件不同的事，否則 share house 與一般物件永遠無法正確比較。
 */
export type Basis =
  | 'measured'          // 原站明寫金額
  | 'included_stated'   // 原站明寫「込み／含む」→ 該項金額為 0 是合法事實
  | 'excluded_stated'   // 原站明寫「別途」但沒給金額 → 值必然未知
  | 'unstated'          // 原站完全沒提
  | 'legal_cap';        // 由法規上限推得的界，只能用於上界模式，絕不當作值

/** 沒有值的原因。只有 unparsed 與 conflicting 是故障訊號，其餘是正常狀態。 */
export type Why =
  | 'not_offered_by_source' // 來源根本沒有這個欄位（例：Couverture 全站無礼金）
  | 'not_listed_on_page'    // 來源有這欄位，但這一頁沒寫
  | 'unparsed'              // 有文字但解析不出來 ← 要告警
  | 'conflicting';          // 多層解析結果不一致 ← 要人看

export type Field<T> =
  | { readonly known: true; readonly v: T; readonly basis: Basis; readonly srcText: string }
  | { readonly known: false; readonly why: Why; readonly basis: Basis; readonly srcText: string };

export function known<T>(v: T, basis: Basis, srcText: string): Field<T> {
  return { known: true, v, basis, srcText };
}

export function unknown<T>(why: Why, basis: Basis = 'unstated', srcText = ''): Field<T> {
  return { known: false, why, basis, srcText };
}

/** 來源根本不提供這個欄位——不是故障，健康檢查不該對它告警。 */
export function notOffered<T>(): Field<T> {
  return { known: false, why: 'not_offered_by_source', basis: 'unstated', srcText: '' };
}

/** 頁面上沒寫。正常狀態，計入統計但不告警。 */
export function notListed<T>(srcText = ''): Field<T> {
  return { known: false, why: 'not_listed_on_page', basis: 'unstated', srcText };
}

/** 有文字但解不出來。這是唯一代表「我們的解析器壞了」的狀態。 */
export function unparsed<T>(srcText: string): Field<T> {
  return { known: false, why: 'unparsed', basis: 'unstated', srcText };
}

/**
 * 「明寫含在別的費用裡」——值為 0 且這個 0 是真的。
 * 建置期閘門只允許在這個 basis 下出現金額 0。
 */
export function includedInOther(srcText: string): Field<Yen> {
  return { known: true, v: ZERO_YEN, basis: 'included_stated', srcText };
}

export type Completeness = 'COMPLETE' | 'LOWER_BOUND' | 'INSUFFICIENT';

export type YenSum = {
  /** 已知成分的合計。因為所有成分都 ≥ 0，這恆為真值的下界。 */
  readonly lower: Yen;
  /** 哪些成分是未知的。呼叫端不可能拿到一個數字卻不知道漏了什麼。 */
  readonly missing: readonly string[];
  readonly completeness: Completeness;
};

/**
 * 全專案唯一允許加總金額的入口。
 *
 * 它強制回傳 missing 清單——這是這個設計的重點：
 * 不是「禁止你算錯」，而是讓「算了但不知道漏什麼」在型別上不存在。
 */
export function sumYen(entries: ReadonlyArray<readonly [string, Field<Yen>]>): YenSum {
  let total = 0;
  const missing: string[] = [];
  for (const [id, f] of entries) {
    if (f.known) {
      total += f.v.jpy;
    } else {
      missing.push(id);
    }
  }
  return {
    lower: { jpy: total },
    missing,
    completeness: missing.length === 0 ? 'COMPLETE' : 'LOWER_BOUND',
  };
}

/** 供 UI 顯示：未知時回傳 null，呼叫端必須自己處理。刻意不提供預設值參數。 */
export function valueOrNull<T>(f: Field<T>): T | null {
  return f.known ? f.v : null;
}

export function isFaultSignal<T>(f: Field<T>): boolean {
  return !f.known && (f.why === 'unparsed' || f.why === 'conflicting');
}
