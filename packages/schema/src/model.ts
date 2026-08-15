/**
 * 領域模型：Building（建物）+ Unit（房間）兩層。
 *
 * 為什麼 Day 1 就分兩層：share house 本質是「一棟建物、多個房間、共用設施」，
 * Couverture 是 25 棟 × 約 20 房、ひつじ 的詳情頁也是逐房間列價。
 * 扁平模型之後要改成兩層會動到 schema、adapter、去重、UI、URL，是傷筋動骨的重構。
 * 即使 Leopalace 平均只有 1.7 房/棟（東京 1,700 棟 / 2,881 房，2026-08-16 實測），也先分兩層。
 */

import type { Field, Yen } from './field.ts';

export type SourceId =
  | 'hituji'
  | 'leopalace21'
  | 'oakhouse'
  | 'ur'
  | 'couverture'
  | 'tokyosharehouse'
  | 'borderless'
  | 'socialapartment'
  | 'villagehouse'
  | 'sakurahouse'
  | 'manual';

/** 物件種類。share house 與一般物件的費用結構完全不同，必須能分辨。 */
export type PropertyKind =
  | 'sharehouse'   // 個室＋共用設施，月額通常含水電網路
  | 'dormitory'    // 多人房
  | 'apartment'    // 一般租賃住宅
  | 'social'       // Social Residence 等大型共居
  | 'unknown';

/** 契約種類。定期借家不能續約，是「綁約」篩選器的核心。 */
export type ContractType =
  | 'ordinary'     // 普通借家：可續約
  | 'fixed_term'   // 定期借家：期滿即終止，需重新締約
  | 'unknown';

/** 水電是否含在月額內。這是 share house 與一般物件可比性的關鍵旗標。 */
export type UtilitiesBasis = 'included' | 'excluded' | 'unknown';

export type GenderRestriction = 'female_only' | 'male_only' | 'mixed' | 'unknown';

/**
 * 外國人承租條件。各站揭露程度差異極大：
 * ひつじ與 Tokyo Sharehouse 逐物件刊登，UR 有官方資格條文，Village House 完全沒有。
 */
export type ForeignerPolicy = {
  /** 站方明示歡迎外國人（例：ひつじ的「外国人歓迎」標籤） */
  readonly welcomed: Field<boolean>;
  /** 需要在留卡／護照 */
  readonly residenceCardRequired: Field<boolean>;
  /** 需要日語能力 */
  readonly japaneseRequired: Field<boolean>;
  /** 需要保証会社 */
  readonly guarantorCompanyRequired: Field<boolean>;
  /** 需要連帶保証人（本人以外的擔保人） */
  readonly guarantorPersonRequired: Field<boolean>;
  /** 原文，供使用者自行判讀 */
  readonly rawText: string;
};

export type Station = {
  readonly line: string;
  readonly station: string;
  /** 步行分鐘。搭公車的情況存 null 並在 rawText 保留原文。 */
  readonly walkMinutes: Field<number>;
  readonly rawText: string;
};

export type Building = {
  readonly id: string;              // `${sourceId}:${sourceKey}`
  readonly sourceId: SourceId;
  readonly sourceKey: string;
  readonly sourceUrl: string;

  readonly name: string;
  readonly kind: PropertyKind;

  readonly addressRaw: string;
  readonly prefecture: string;
  readonly ward: string;            // 市区町村
  readonly stations: readonly Station[];

  readonly structure: Field<string>;    // 鉄筋コンクリート造 等
  readonly yearBuilt: Field<number>;
  readonly floorsAboveGround: Field<number>;
  readonly totalUnits: Field<number>;

  readonly imageUrls: readonly string[];

  readonly fetchedAt: string;           // ISO8601
  readonly sourceUpdatedAt: Field<string>;  // 來源自報的更新日（ひつじ/TSH 有）
  readonly htmlSha256: string;
};

/**
 * 一次性費用（簽約時支付）。
 * 注意 deposit 與 depositNonRefundable 是兩個欄位：
 * 敷金是押金、多數會退，只有敷引／償却的部分才是真正的成本。
 */
export type InitialCosts = {
  readonly keyMoney: Field<Yen>;             // 礼金（不退）
  readonly deposit: Field<Yen>;              // 敷金／保証金（押金，多數會退）
  readonly depositNonRefundable: Field<Yen>; // 敷引き／償却（敷金中確定不退的部分）
  readonly agencyFee: Field<Yen>;            // 仲介手数料
  readonly guarantorInitialFee: Field<Yen>;  // 保証会社初回料
  readonly fireInsurance: Field<Yen>;        // 火災保険料
  readonly keyExchangeFee: Field<Yen>;       // 鍵交換費
  readonly contractFee: Field<Yen>;          // 契約手数料／事務手数料／登録料
  readonly cleaningFeeUpfront: Field<Yen>;   // 入住時收的清掃費
  readonly otherInitial: Field<Yen>;
};

/** 每月固定支出。 */
export type MonthlyCosts = {
  readonly rent: Field<Yen>;
  readonly adminFee: Field<Yen>;        // 管理費／共益費（法律上無區別，合併處理）
  readonly utilities: Field<Yen>;       // 定額水道光熱費
  readonly internet: Field<Yen>;
  readonly otherMonthly: Field<Yen>;
};

/** 退租或續約時才發生的費用——第一年看不到，但會影響長期成本。 */
export type DeferredCosts = {
  readonly renewalFee: Field<Yen>;          // 更新料（通常 2 年一次）
  readonly renewalAdminFee: Field<Yen>;
  readonly cleaningFeeOnExit: Field<Yen>;   // 退去時清掃費（Village House 明列）
  /** 短期解約違約金，例：Village House「1年未満は3ヵ月分」 */
  readonly earlyTerminationPenalty: Field<Yen>;
};

export type Unit = {
  readonly id: string;              // `${buildingId}#${unitKey}`
  readonly buildingId: string;
  readonly unitKey: string;
  readonly sourceUrl: string;       // 可能與 building 相同（同頁多房）

  readonly roomNo: Field<string>;
  readonly layout: Field<string>;   // 1R / 1K / 1DK / 1LDK / 個室 …
  readonly areaM2: Field<number>;
  readonly floor: Field<number>;

  readonly monthly: MonthlyCosts;
  readonly initial: InitialCosts;
  readonly deferred: DeferredCosts;

  readonly utilitiesBasis: UtilitiesBasis;
  readonly furnished: Field<boolean>;
  readonly availableFrom: Field<string>;      // ISO8601 或 '随時'
  readonly isVacant: Field<boolean>;

  readonly contractType: ContractType;
  readonly contractMonths: Field<number>;
  readonly minStayMonths: Field<number>;

  readonly genderRestriction: GenderRestriction;
  readonly ageLimitRaw: Field<string>;
  readonly petsAllowed: Field<boolean>;
  readonly foreigner: ForeignerPolicy;

  readonly notes: readonly string[];
};

export type Listing = {
  readonly building: Building;
  readonly units: readonly Unit[];
};

/** 費用欄位的穩定 id，用於 missing 清單、健康報告與 capabilities 宣告。 */
export const COST_FIELD_IDS = [
  'rent', 'adminFee', 'utilities', 'internet', 'otherMonthly',
  'keyMoney', 'deposit', 'depositNonRefundable', 'agencyFee',
  'guarantorInitialFee', 'fireInsurance', 'keyExchangeFee',
  'contractFee', 'cleaningFeeUpfront', 'otherInitial',
  'renewalFee', 'renewalAdminFee', 'cleaningFeeOnExit', 'earlyTerminationPenalty',
] as const;

export type CostFieldId = (typeof COST_FIELD_IDS)[number];

/** 非費用欄位，同樣要納入填充率統計。 */
export const ATTR_FIELD_IDS = [
  'layout', 'areaM2', 'floor', 'roomNo', 'availableFrom', 'isVacant',
  'furnished', 'contractType', 'contractMonths', 'minStayMonths',
  'genderRestriction', 'ageLimitRaw', 'petsAllowed',
  'foreignerWelcomed', 'residenceCardRequired', 'japaneseRequired',
  'guarantorCompanyRequired', 'guarantorPersonRequired',
  'structure', 'yearBuilt', 'floorsAboveGround', 'totalUnits',
  'stations', 'sourceUpdatedAt',
] as const;

export type AttrFieldId = (typeof ATTR_FIELD_IDS)[number];
export type AnyFieldId = CostFieldId | AttrFieldId;
