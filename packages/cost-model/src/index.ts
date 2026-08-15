/**
 * 費用比較模型。
 *
 * 這一層的存在理由：「月租 55,000」和「月租 62,000 含水電免禮金」無法直接比。
 * 但把它們變成可比的過程中，最容易犯的錯就是替缺漏的欄位填一個數字——
 * 所以這裡的每一個函式都寧可回報「不可比」，也不生一個數字出來。
 *
 * 三個設計決定：
 *  1. 敷金不是成本（是押金，多數會退）→ 初期現金需求 與 初期沉沒成本 分開算。
 *  2. 缺值不混算 → A/B/C 分區，缺值物件降級而非取得排序優勢。
 *  3. 日割家賃取決於入住日，不是物件屬性 → 入住日是呼叫端傳入的參數。
 */

import {
  type Field, type Yen, type Completeness, sumYen, yen,
} from '../../schema/src/field.ts';
import type { Unit } from '../../schema/src/model.ts';

export type Horizon = 12 | 24 | 48;

/** 月額成分。所有成分皆 ≥ 0，所以已知成分的合計恆為真值下界。 */
export function monthlyBreakdown(u: Unit): ReadonlyArray<readonly [string, Field<Yen>]> {
  return [
    ['rent', u.monthly.rent],
    ['adminFee', u.monthly.adminFee],
    ['utilities', u.monthly.utilities],
    ['internet', u.monthly.internet],
    ['otherMonthly', u.monthly.otherMonthly],
  ];
}

/**
 * 初期「現金需求」：簽約當下要掏出來的錢，含押金。
 * 這是「我戶頭裡要有多少錢才搬得進去」的答案。
 */
export function initialCashBreakdown(u: Unit): ReadonlyArray<readonly [string, Field<Yen>]> {
  return [
    ['deposit', u.initial.deposit],
    ['keyMoney', u.initial.keyMoney],
    ['agencyFee', u.initial.agencyFee],
    ['guarantorInitialFee', u.initial.guarantorInitialFee],
    ['fireInsurance', u.initial.fireInsurance],
    ['keyExchangeFee', u.initial.keyExchangeFee],
    ['contractFee', u.initial.contractFee],
    ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront],
    ['otherInitial', u.initial.otherInitial],
  ];
}

/**
 * 初期「沉沒成本」：確定拿不回來的錢。**不含敷金本體**，只含敷引／償却部分。
 *
 * 這個區別是必要的：把敷金整筆算成成本，會讓「敷2礼0」看起來比「敷0礼1」貴，
 * 但實際上前者的沉沒成本可能更低。
 */
export function initialSunkBreakdown(u: Unit): ReadonlyArray<readonly [string, Field<Yen>]> {
  return [
    ['depositNonRefundable', u.initial.depositNonRefundable],
    ['keyMoney', u.initial.keyMoney],
    ['agencyFee', u.initial.agencyFee],
    ['guarantorInitialFee', u.initial.guarantorInitialFee],
    ['fireInsurance', u.initial.fireInsurance],
    ['keyExchangeFee', u.initial.keyExchangeFee],
    ['contractFee', u.initial.contractFee],
    ['cleaningFeeUpfront', u.initial.cleaningFeeUpfront],
  ];
}

export type Metric = {
  /** 已知成分的合計，恆為真值下界 */
  readonly lower: Yen;
  readonly missing: readonly string[];
  readonly completeness: Completeness;
  /** 額外的警語，例如「敷金可能有部分不退，原站未載明」 */
  readonly caveats: readonly string[];
};

const EMPTY: readonly string[] = [];

function withCaveats(base: { lower: Yen; missing: readonly string[]; completeness: Completeness }, caveats: readonly string[]): Metric {
  return { lower: base.lower, missing: base.missing, completeness: base.completeness, caveats };
}

/**
 * 每月固定支出＝賃料＋管理費／共益費（＋明確載明的定額水電與網路）。
 *
 * **完整性判定刻意不把「水電未知」算成缺項**，理由：
 * 日本房源慣例的「月額」就是賃料＋管理費/共益費；水電是按用量計的生活費，
 * 幾乎沒有任何網站會逐物件報價。拿一個沒有來源會提供的項目去判定完整性，
 * 會讓每一筆都落入「僅有下限」——一個永遠相同的訊號不帶任何資訊，
 * 反而讓真正該被標示的「缺賃料／缺管理費」被淹沒。
 *
 * 水電的不確定性改由兩個更精準的機制承擔：
 *   1. `utilitiesBasis` 是一等篩選器與卡片上的標籤（含水電／另計／未提供）
 *   2. 結果集混合兩種基準時，列表頂端出現警示橫幅
 */
export function monthlyCost(u: Unit): Metric {
  const s = sumYen(monthlyBreakdown(u));
  const caveats: string[] = [];
  if (u.utilitiesBasis === 'unknown' && !u.monthly.utilities.known) {
    caveats.push('原站未說明水電是否含在月額內');
  }
  if (u.utilitiesBasis === 'excluded' && !u.monthly.utilities.known) {
    caveats.push('水電需另付，原站未載明金額');
  }
  const missing = s.missing.filter((m) => m !== 'utilities');
  return {
    lower: s.lower,
    missing,
    completeness: missing.length === 0 ? 'COMPLETE' : 'LOWER_BOUND',
    caveats,
  };
}

export function initialCash(u: Unit): Metric {
  return withCaveats(sumYen(initialCashBreakdown(u)), EMPTY);
}

export function initialSunk(u: Unit): Metric {
  const s = sumYen(initialSunkBreakdown(u));
  const caveats: string[] = [];
  // 有敷金但不知道敷引多少 → 沉沒成本只能是下界
  if (u.initial.deposit.known && u.initial.deposit.v.jpy > 0 && !u.initial.depositNonRefundable.known) {
    caveats.push('敷金可能有部分不退（敷引／償却），原站未載明');
  }
  return withCaveats(s, caveats);
}

/**
 * N 個月視野的總支出與實質月成本。
 *
 * moveInDate 為 null 時不計日割家賃，並在 caveats 說明——
 * 刻意不套「假設 1 號入住」，因為那會產生一個編出來的數字。
 */
export function totalOverHorizon(u: Unit, horizon: Horizon, moveInDate: Date | null): Metric {
  const monthly = monthlyCost(u);
  const sunk = initialSunk(u);

  const missing = [...sunk.missing, ...monthly.missing.map((m) => `monthly:${m}`)];
  const caveats = [...sunk.caveats, ...monthly.caveats];

  let total = sunk.lower.jpy + monthly.lower.jpy * horizon;

  // 更新料：每 24 個月一次，第一次發生在第 24 個月
  const renewals = Math.floor(horizon / 24);
  if (renewals > 0) {
    if (u.deferred.renewalFee.known) {
      total += u.deferred.renewalFee.v.jpy * renewals;
    } else {
      missing.push('renewalFee');
      caveats.push(`${horizon / 12} 年視野會遇到 ${renewals} 次更新，但原站未載明更新料`);
    }
    if (u.deferred.renewalAdminFee.known) {
      total += u.deferred.renewalAdminFee.v.jpy * renewals;
    }
  }

  if (moveInDate === null) {
    caveats.push('未指定入住日，未計入日割家賃');
  } else if (u.monthly.rent.known) {
    total += proratedRent(u.monthly.rent.v.jpy, moveInDate).jpy;
  }

  return {
    lower: yen(Math.round(total)),
    missing,
    completeness: missing.length === 0 ? 'COMPLETE' : 'LOWER_BOUND',
    caveats,
  };
}

/**
 * 日割家賃：入住日到當月月底。
 * 計算慣例用「當月實際天數」為分母；部分契約用固定 30 日，
 * 這點各站幾乎都不載明，所以結果一律附註為概算。
 */
export function proratedRent(rentJpy: number, moveInDate: Date): Yen {
  const y = moveInDate.getFullYear();
  const m = moveInDate.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const remaining = daysInMonth - moveInDate.getDate() + 1;
  return yen(Math.round((rentJpy / daysInMonth) * remaining));
}

/** 實質月成本 = N 個月總支出 / N。 */
export function effectiveMonthly(u: Unit, horizon: Horizon, moveInDate: Date | null): Metric {
  const t = totalOverHorizon(u, horizon, moveInDate);
  return { ...t, lower: yen(Math.round(t.lower.jpy / horizon)) };
}

/**
 * 排序分區。
 *
 * A 完整可比：所有成分皆已知 → 顯示確切金額，排最上面
 * B 僅有下限：賃料已知但有成分缺 → 顯示 ≥ 金額，區內排序
 * C 資料不足：連賃料都缺 → 不參與任何排序
 *
 * 這樣缺值物件永遠不會跟資料完整的物件比大小，缺值是降級而不是優勢。
 */
export type Tier = 'A' | 'B' | 'C';

export function tierOf(u: Unit, metric: Metric): Tier {
  if (!u.monthly.rent.known) return 'C';
  return metric.completeness === 'COMPLETE' ? 'A' : 'B';
}

export type Ranked<T> = {
  readonly tier: Tier;
  readonly item: T;
  readonly metric: Metric;
};

/**
 * 依分區排序。A 全部在前、其次 B、最後 C；每區內部按 lower 排序。
 * C 區不排序（保持輸入順序），因為它的 lower 沒有意義。
 */
export function rankByTier<T>(
  items: readonly T[],
  unitOf: (t: T) => Unit,
  metricOf: (u: Unit) => Metric,
): readonly Ranked<T>[] {
  const rows = items.map((item) => {
    const u = unitOf(item);
    const metric = metricOf(u);
    return { tier: tierOf(u, metric), item, metric };
  });
  const order: Record<Tier, number> = { A: 0, B: 1, C: 2 };
  return rows.sort((x, y) => {
    if (order[x.tier] !== order[y.tier]) return order[x.tier] - order[y.tier];
    if (x.tier === 'C') return 0;
    return x.metric.lower.jpy - y.metric.lower.jpy;
  });
}

export function tierCounts(rows: readonly Ranked<unknown>[]): Record<Tier, number> {
  const c: Record<Tier, number> = { A: 0, B: 0, C: 0 };
  for (const r of rows) c[r.tier] += 1;
  return c;
}

/**
 * 使用者自填的水電假設。
 *
 * 這不是虛構，因為它是**使用者自己的**數字：值存在 URL、永不寫入資料檔，
 * 產生的指標名稱與原指標不同，UI 上必須明顯標示。
 */
export function monthlyWithUserAssumption(u: Unit, assumedUtilitiesJpy: number): Metric {
  const base = monthlyCost(u);
  if (u.utilitiesBasis === 'included' || u.monthly.utilities.known) {
    // 已經含水電或已知金額，不套用假設
    return base;
  }
  return {
    lower: yen(base.lower.jpy + assumedUtilitiesJpy),
    missing: base.missing.filter((m) => m !== 'utilities'),
    completeness: base.missing.filter((m) => m !== 'utilities').length === 0 ? 'COMPLETE' : 'LOWER_BOUND',
    caveats: [...base.caveats, `已加入你設定的水電假設 ¥${assumedUtilitiesJpy.toLocaleString('ja-JP')}／月`],
  };
}
