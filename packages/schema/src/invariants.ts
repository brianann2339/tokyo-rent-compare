/**
 * 跨欄位不變式。違反者不是「數字比較怪」，是「至少有一個欄位解析錯了」，
 * 該欄位一律降為 conflicting（視為不知道），並計入健康報告。
 *
 * 這些界線全部有法源或物理依據，不是憑感覺設的門檻。
 */

/**
 * 仲介手数料法定上限：借賃 1 個月分的 1.1 倍（含稅）。
 * 依據：宅地建物取引業法 第46条 ＋ 昭和45年建設省告示第1552号 第四
 *   「…報酬の額…の合計額は、当該宅地又は建物の借賃の一月分の１．１倍に
 *     相当する金額以内とする。」
 * 未取得依頼者承諾時，單方上限為 0.55 倍。
 */
export const AGENCY_FEE_CAP_MULTIPLIER = 1.1;
/** 浮點與四捨五入的容差，避免剛好卡上限的合法值被誤判。 */
export const AGENCY_FEE_CAP_TOLERANCE = 1.01;

/**
 * 1帖（畳）= 1.62㎡「以上」。
 * 依據：不動産の表示に関する公正競争規約施行規則 第11条第16号
 *   ／近畿地区不動産公正取引協議会 近畿公取発第213号（平成23年11月25日）
 *   「一畳当たりの広さは、１．６２平方メートル（各室の壁心面積を畳数で除した数値）
 *     以上をいう。」
 * 這是**下限**不是等值：從帖反推㎡只能得到最小值，所以 ㎡ 才是主鍵，帖只作顯示。
 */
export const JO_TO_M2_MIN = 1.62;

/** 賃料的合理範圍。超出多半是把別的數字（面積、坪數、電話）當成賃料了。 */
export const RENT_MIN_JPY = 10_000;
export const RENT_MAX_JPY = 3_000_000;

/** 步行分鐘的合理範圍。超過 60 分多半是誤抓公車或開車時間。 */
export const WALK_MIN = 1;
export const WALK_MAX = 60;

export const AREA_M2_MIN = 3;
export const AREA_M2_MAX = 500;

export type Violation = {
  readonly fieldIds: readonly string[];
  readonly rule: string;
  readonly detail: string;
};

export function checkRentRange(rentJpy: number): Violation | null {
  if (rentJpy > RENT_MIN_JPY && rentJpy < RENT_MAX_JPY) return null;
  return {
    fieldIds: ['rent'],
    rule: 'rent_range',
    detail: `賃料 ${rentJpy} 円 超出合理範圍 (${RENT_MIN_JPY}, ${RENT_MAX_JPY})`,
  };
}

export function checkAgencyFeeCap(agencyFeeJpy: number, rentJpy: number): Violation | null {
  const cap = rentJpy * AGENCY_FEE_CAP_MULTIPLIER * AGENCY_FEE_CAP_TOLERANCE;
  if (agencyFeeJpy <= cap) return null;
  return {
    fieldIds: ['agencyFee'],
    rule: 'agency_fee_legal_cap',
    detail: `仲介手数料 ${agencyFeeJpy} 円 超過法定上限（賃料 ${rentJpy} × 1.1 = ${Math.round(rentJpy * AGENCY_FEE_CAP_MULTIPLIER)} 円）`,
  };
}

export function checkAreaVsJo(areaM2: number, jo: number): Violation | null {
  const min = jo * JO_TO_M2_MIN;
  // 容差 2%：原站的帖數常是四捨五入後的展示值
  if (areaM2 >= min * 0.98) return null;
  return {
    fieldIds: ['areaM2'],
    rule: 'area_vs_jo_floor',
    detail: `面積 ${areaM2}㎡ 小於 ${jo}帖 的法定下限 ${min.toFixed(2)}㎡`,
  };
}

export function checkAreaRange(areaM2: number): Violation | null {
  if (areaM2 >= AREA_M2_MIN && areaM2 <= AREA_M2_MAX) return null;
  return {
    fieldIds: ['areaM2'],
    rule: 'area_range',
    detail: `面積 ${areaM2}㎡ 超出合理範圍 [${AREA_M2_MIN}, ${AREA_M2_MAX}]`,
  };
}

export function checkWalkMinutes(minutes: number): Violation | null {
  if (Number.isInteger(minutes) && minutes >= WALK_MIN && minutes <= WALK_MAX) return null;
  return {
    fieldIds: ['stations'],
    rule: 'walk_minutes_range',
    detail: `徒歩 ${minutes} 分 超出合理範圍 [${WALK_MIN}, ${WALK_MAX}]`,
  };
}

export function checkYearBuilt(year: number, now: Date = new Date()): Violation | null {
  const current = now.getFullYear();
  if (year >= 1900 && year <= current) return null;
  return {
    fieldIds: ['yearBuilt'],
    rule: 'year_built_range',
    detail: `築年 ${year} 超出合理範圍 [1900, ${current}]`,
  };
}

/** 月額合計必然 ≥ 賃料，因為其餘成分都 ≥ 0。違反代表至少一項解析錯誤。 */
export function checkMonthlyAtLeastRent(monthlyLowerJpy: number, rentJpy: number): Violation | null {
  if (monthlyLowerJpy >= rentJpy) return null;
  return {
    fieldIds: ['rent', 'adminFee'],
    rule: 'monthly_lt_rent',
    detail: `月額下限 ${monthlyLowerJpy} 円 小於賃料 ${rentJpy} 円，邏輯上不可能`,
  };
}

/** 敷引不可能超過敷金本身。 */
export function checkDepositNonRefundable(nonRefundableJpy: number, depositJpy: number): Violation | null {
  if (nonRefundableJpy <= depositJpy) return null;
  return {
    fieldIds: ['depositNonRefundable'],
    rule: 'deposit_nonrefundable_gt_deposit',
    detail: `敷引 ${nonRefundableJpy} 円 大於敷金 ${depositJpy} 円`,
  };
}
