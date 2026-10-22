/**
 * 統計離群：原站刊登者 key 錯、但沒有違反任何硬界線（invariants.ts）的值。
 *
 * invariants.ts 的界線都有法源或物理依據；這裡**沒有**——是拿「同区同類的中位數」比。
 * 所以命中只代表「可疑」，處置跟不變式一樣：值照原文保留、標記、不拿去比大小。
 *
 * 為什麼需要：SUUMO 一覧頁上有刊登者把萬位打錯的列，原站就照錯的印
 * （2026-10-17 抓的頁面，逐列核對過）：
 *   ザ・プレミアムキューブジー大崎 1K 22.05㎡「119.5万円」——同棟同面積另一列是「11.95万円」
 *   レジディアタワー上池袋 1LDK「敷金 313.29万円」——同棟其他列都是「17.6万円」（＝賃料 1 個月）
 *   ソルクレスト北烏山「1K 238m2」、パティーナ蒲田南DUO 1SLDK 42.91㎡「1.48万円」
 * 這些值都在 RENT_MIN_JPY／RENT_MAX_JPY／AREA_M2_MAX 之內（港区真的有月租 700 万的房），
 * 硬界線抓不到；但跟同区行情一比就差十倍。
 *
 * 門檻的根據寫在各常數上；改門檻前先重跑全量分布，看真實高價與誤植之間的斷層還在不在。
 */

import type { Violation } from './invariants.ts';

/** 種類群：一般賃貸跟共居的每㎡行情差一倍以上，混在一起比會把共居全判成偏高。 */
export type MarketGroup = 'apt' | 'share' | 'unk';

export type MarketRow = {
  readonly ward: string;
  readonly group: MarketGroup;
  /** 正規化後的房型（1K、2LDK、個室、ドミトリー…）；未知為 null */
  readonly layout: string | null;
  readonly rentJpy: number | null;
  readonly adminJpy: number | null;
  readonly areaM2: number | null;
  /** 能不能算每㎡（多人房的面積是整間共用房，不能拿床位賃料除） */
  readonly perM2Comparable: boolean;
  /** 房型的房間數（2LDK → 2）；1R・個室・未知為 null 或 1 */
  readonly rooms: number | null;
};

/**
 * 每㎡月額（賃料＋管理費）超過同区同種類群中位數的這個倍數 → 可疑。
 * 2026-10-17 全量 ≥ 6.26 倍的 22 間：21 間逐列對過原站一覧頁，全是誤植（另一間是 3LDK「1m2」）——多數同棟同面積就有一列
 * 是它的十分之一（竹ノ塚 1LDK 42.23m2「95万円」／同棟「9.5万円」、蔵前 1R「111万円」／「11.1万円」）。
 * 往下最高的是 5.60 倍（愛宕グリーンヒルズ 3SLDK「254万円」，面積跟同棟一間 1LDK 一樣，可疑但不確定）、
 * 5.17 倍（トフロム八重洲 1LDK「200万円」，判斷不了）、5.05 倍（三田ガーデンヒルズ「500万円」，
 * 同棟各列每㎡一致，是真的）；5.60 與 6.26 之間沒有任何一間。
 */
export const PER_M2_HIGH_RATIO = 6;
/**
 * 每㎡月額低於同区同種類群中位數的這個倍數 → 可疑。
 * 2026-10-17 全量：≤ 0.13 倍的兩間是誤植（1K「238m2」；1SLDK 42.91m2「1.48万円」，同棟同面積是「14.8万円」）。
 * 往上是 0.19 倍（北区 5DK 82.22m2「6.8万円」，整棟只有這一列，判斷不了），
 * 再往上是老透天、老公寓、多摩的 UR 團地。
 */
export const PER_M2_LOW_RATIO = 0.15;
/**
 * 敷金或礼金超過這麼多個月的賃料 → 可疑。
 * 2026-10-17 全量：港区高級物件的「敷金 6〜7.27 個月」看來是真的（多半同棟幾列一致）；
 * 下一個值就是 10 個月以上（「29万円」的房寫「敷金 841万円」＝29 個月），
 * (7.27, 10) 之間沒有任何一間。
 */
export const DEPOSIT_KEY_MONTHS_MAX = 8;

/**
 * 一般賃貸的管理費達到賃料的這個倍數 → 可疑。
 * 2026-10-17 SUUMO 全量 ≥ 0.8 倍的 24 間逐列看過同棟各列：17 間是誤植——同棟同賃料的列
 * 管理費是「9000円」、這一列是「90000円」，或乾脆把賃料抄進管理費欄（「19万円＋190000円」）；
 * 7 間判斷不了（多半同棟沒有可對照的列；MFビル 2LDK「12.7万円＋128000円」兩列一致、
 * 合計跟同棟另一列相近，可能真的是這樣拆）——所以命中只代表可疑，不代表錯。
 * 0.6〜0.8 倍之間也有誤植（同棟另一列就是十分之一，2026-10-22 看過 19 間），那些交給 checkSiblingSlips；
 * 比例門檻不往下降，因為這一段也有真的（同棟各列一致都是「30000円」、6〜7.5㎡ 的小房「16000円」）。
 */
export const ADMIN_RATIO_APT = 0.8;
/**
 * 共居的共益費常含水電網路，ドミトリー「賃料 23,000＋共益費 22,000」是真的（TSH ＴＣＲＥ葛西），
 * 所以門檻放寬。2026-10-17 全量共居最高的是 0.96 倍，下一個就是ひつじ Couverture 北大塚Ⅱ 202
 * 「共益費 150000」（2.5 倍）——Couverture 自家網站與 TSH 同一間都寫「共益費 ¥15,000」。
 */
export const ADMIN_RATIO_SHARE = 1.5;
/**
 * 兩房以上的房型，面積不到同房型中位數的這個比例 → 面積可疑。
 * 2026-10-17 SUUMO 實例：2LDK「15.8m2」（同棟 1K 的面積，同棟 2LDK 是 41.8〜50m2）、
 * 3LDK「28.69m2」（同棟同階同價的另一列是 89.01m2）、2DK「10.57m2」（同棟同價 2DK 都是 40.57〜40.7m2）。
 * 不到四成的 9 間裡，除了 6LDK「65m2」（整棟一列，判斷不了）都是誤植；0.404 倍的 2SLDK 28.76m2 不判。
 * 1R／1K 不判：3〜5㎡ 的超小套房是真的（SA-クロス「3.5m2」）。
 */
export const MULTIROOM_AREA_MIN_RATIO = 0.4;

/** 中位數要有這麼多筆才用；不夠就退回更粗的分組（只有一兩間的区不能當行情）。 */
const MIN_GROUP = 30;
const MIN_LAYOUT = 20;

export type MarketBaseline = {
  perM2(ward: string, group: MarketGroup): number | null;
  rent(ward: string, layout: string | null): number | null;
  area(layout: string | null): number | null;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function medians(m: Map<string, number[]>, min: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) if (v.length >= min) out.set(k, median(v));
  return out;
}

const add = (m: Map<string, number[]>, k: string, v: number): void => {
  const a = m.get(k);
  if (a === undefined) m.set(k, [v]); else a.push(v);
};

const perM2Of = (r: MarketRow): number | null =>
  (r.perM2Comparable && r.rentJpy !== null && r.areaM2 !== null && r.areaM2 > 0
    ? (r.rentJpy + (r.adminJpy ?? 0)) / r.areaM2
    : null);

/** 全量算一次行情：每㎡（区×種類群，不足退回種類群）、賃料（区×房型，不足退回房型）、面積（房型）。 */
export function marketBaseline(rows: Iterable<MarketRow>): MarketBaseline {
  const pmWG = new Map<string, number[]>();
  const pmG = new Map<string, number[]>();
  const rWL = new Map<string, number[]>();
  const rL = new Map<string, number[]>();
  const aL = new Map<string, number[]>();
  for (const r of rows) {
    const pm = perM2Of(r);
    if (pm !== null) { add(pmWG, `${r.ward}|${r.group}`, pm); add(pmG, r.group, pm); }
    if (r.layout !== null && r.rentJpy !== null) { add(rWL, `${r.ward}|${r.layout}`, r.rentJpy); add(rL, r.layout, r.rentJpy); }
    if (r.layout !== null && r.areaM2 !== null && r.areaM2 > 0) add(aL, r.layout, r.areaM2);
  }
  const pmWGm = medians(pmWG, MIN_GROUP);
  const pmGm = medians(pmG, MIN_GROUP);
  const rWLm = medians(rWL, MIN_LAYOUT);
  const rLm = medians(rL, MIN_LAYOUT);
  const aLm = medians(aL, MIN_LAYOUT);
  return {
    perM2: (ward, group) => pmWGm.get(`${ward}|${group}`) ?? pmGm.get(group) ?? null,
    rent: (ward, layout) => (layout === null ? null : rWLm.get(`${ward}|${layout}`) ?? rLm.get(layout) ?? null),
    area: (layout) => (layout === null ? null : aLm.get(layout) ?? null),
  };
}

const yen = (n: number): string => Math.round(n).toLocaleString('ja-JP');

/**
 * 每㎡月額跟同区行情差太多：賃料或面積其中一個打錯了。
 * 怪哪一個：看賃料偏離「同区同房型」、面積偏離「同房型」誰多（取對數比大小，
 * 10 倍與 1/10 倍一樣遠）。1K「238m2」賃料正常 → 怪面積；1K 22㎡「119.5万円」面積正常 → 怪賃料。
 * 任一邊沒有行情可比（房型未知、或該房型筆數不足）就分不出來——兩個都標，
 * 不然錯的那個會照樣參與排序（房型未知的「238m2」被怪到賃料，面積篩選反而用了 238）。
 */
export function checkPerM2Outlier(r: MarketRow, base: MarketBaseline): Violation | null {
  const pm = perM2Of(r);
  if (pm === null) return null;
  const med = base.perM2(r.ward, r.group);
  if (med === null || med <= 0) return null;
  const ratio = pm / med;
  if (ratio < PER_M2_HIGH_RATIO && ratio > PER_M2_LOW_RATIO) return null;
  const rb = base.rent(r.ward, r.layout);
  const ab = base.area(r.layout);
  const rr = rb !== null && r.rentJpy !== null && r.rentJpy > 0 ? r.rentJpy / rb : null;
  const ar = ab !== null && r.areaM2 !== null ? r.areaM2 / ab : null;
  const fmt = (x: number | null): string => (x === null ? '無行情可比' : `${x.toFixed(2)} 倍`);
  const blame: Array<'rent' | 'areaM2'> = rr === null || ar === null
    ? ['rent', 'areaM2']
    : [Math.abs(Math.log(ar)) > Math.abs(Math.log(rr)) ? 'areaM2' : 'rent'];
  const zh = blame.length === 2 ? '分不出是賃料還是面積，兩個都可疑' : blame[0] === 'areaM2' ? '面積可疑' : '賃料可疑';
  return {
    fieldIds: blame,
    rule: 'per_m2_outlier',
    detail: `每㎡月額 ${yen(pm)} 円是${r.ward}同類中位數 ${yen(med)} 円的 ${ratio.toFixed(2)} 倍`
      + `（門檻 ≥ ${PER_M2_HIGH_RATIO} 或 ≤ ${PER_M2_LOW_RATIO}）；賃料是同区同房型中位數的 ${fmt(rr)}、`
      + `面積是同房型中位數的 ${fmt(ar)} → ${zh}`,
  };
}

/** 管理費相對賃料過高：一般賃貸 ≥ ADMIN_RATIO_APT 倍、共居 > ADMIN_RATIO_SHARE 倍。 */
export function checkAdminVsRent(r: MarketRow): Violation | null {
  if (r.rentJpy === null || r.rentJpy <= 0 || r.adminJpy === null) return null;
  const ratio = r.adminJpy / r.rentJpy;
  const share = r.group === 'share';
  if (share ? ratio <= ADMIN_RATIO_SHARE : ratio < ADMIN_RATIO_APT) return null;
  return {
    fieldIds: ['adminFee'],
    rule: 'admin_vs_rent',
    detail: `管理費 ${yen(r.adminJpy)} 円是賃料 ${yen(r.rentJpy)} 円的 ${ratio.toFixed(2)} 倍`
      + `（${share ? `共居門檻 > ${ADMIN_RATIO_SHARE}` : `門檻 ≥ ${ADMIN_RATIO_APT}`} 倍）`,
  };
}

/** 兩房以上的房型面積不到同房型中位數的 MULTIROOM_AREA_MIN_RATIO。 */
export function checkMultiRoomArea(r: MarketRow, base: MarketBaseline): Violation | null {
  if (r.rooms === null || r.rooms < 2 || r.areaM2 === null) return null;
  const med = base.area(r.layout);
  if (med === null || r.areaM2 / med >= MULTIROOM_AREA_MIN_RATIO) return null;
  return {
    fieldIds: ['areaM2'],
    rule: 'multiroom_area_small',
    detail: `${r.layout ?? ''} 只有 ${r.areaM2}㎡，是同房型中位數 ${med}㎡ 的 ${(r.areaM2 / med).toFixed(2)} 倍（門檻 ${MULTIROOM_AREA_MIN_RATIO}）`,
  };
}

/**
 * 管理費「十倍差」至少要達到賃料的這個比例才判——同棟一列 7,500、一列 75,000，
 * 賃料 11.35 万時 75,000 是 0.66 倍，錯的顯然是大的。大的不到三成就分不出誰錯：
 * 2026-10-22 全量裡錯的常是小的那個（タスキsmart中野坂上II 1LDK 22 万「600円」、同棟其他列「6000円」），
 * 0.15〜0.3 倍兩邊都說得通（2LDK 19.9 万「30000円」對「3000円」）——不判，管理費差幾千円也不太影響排序。
 * 0.3 以上的 24 間（2026-10-22）幫手對原站一覧頁逐列核過，都判大的那列誤植；其中 12 間同棟同房型只有
 * 它跟那一列可比（一間是兩列對兩列），方向是靠常態推的（大的那個是賃料的 3〜8 成），不是同棟多數決。
 */
export const ADMIN_SLIP_MIN_RATIO = 0.3;
/** 「同一種房」的容差：面積 ±2%（同棟同型的列常差 0.04㎡）、賃料 ±5%（同型不同樓層的價差）。 */
const SAME_AREA = 0.02;
const SAME_RENT = 0.05;

/**
 * 同棟另一列正好是十分之一：刊登者多打或少打一個 0 最直接的證據，不必靠行情比。
 * 2026-10-22 灰色地帶（管理費 0.6〜0.8 倍賃料，比例門檻抓不到）實例：同棟 1K 21.45m2 賃料 11.35万円，
 * 一列「7500円」一列「75000円」；同棟 1LDK 40.34m2「15000円」與「150000円」。
 *
 * rows 是同一棟（同一來源）的所有房間；回傳與 rows 同序的違反清單。
 * 賃料十倍差時怪每㎡離同区行情較遠的那一列（119.5 万 vs 11.95 万怪大的；1.48 万 vs 14.8 万怪小的）。
 */
export function checkSiblingSlips(rows: readonly MarketRow[], base: MarketBaseline): Violation[][] {
  const out: Violation[][] = rows.map(() => []);
  const seen = rows.map(() => new Set<string>());
  const put = (k: number, v: Violation): void => {
    const rule = `${v.rule}|${v.fieldIds.join(',')}`;
    if (seen[k]?.has(rule)) return;
    seen[k]?.add(rule);
    out[k]?.push(v);
  };
  const pm = (r: MarketRow): number | null => perM2Of(r);
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i] as MarketRow;
    if (a.layout === null) continue;
    for (let j = 0; j < rows.length; j++) {
      const b = rows[j] as MarketRow;
      if (i === j || b.layout !== a.layout) continue;
      if (a.rentJpy !== null && b.rentJpy !== null && b.rentJpy > 0 && a.rentJpy === 10 * b.rentJpy
        && a.areaM2 !== null && b.areaM2 !== null
        && Math.abs(a.areaM2 - b.areaM2) <= SAME_AREA * Math.max(a.areaM2, b.areaM2)) {
        const med = base.perM2(a.ward, a.group);
        const pa = pm(a);
        const pb = pm(b);
        if (med !== null && pa !== null && pb !== null) {
          const wrongIsA = Math.abs(Math.log(pa / med)) >= Math.abs(Math.log(pb / med));
          const [w, ok] = wrongIsA ? [a, b] : [b, a];
          put(wrongIsA ? i : j, {
            fieldIds: ['rent'],
            rule: 'sibling_rent_x10',
            detail: `同棟同房型、面積相同的另一間賃料 ${yen(ok.rentJpy as number)} 円，這間 ${yen(w.rentJpy as number)} 円`
              + `差整整十倍 → 疑似${wrongIsA ? '多' : '少'}打一個 0`,
          });
        }
      }
      if (a.adminJpy !== null && b.adminJpy !== null && b.adminJpy > 0 && a.adminJpy === 10 * b.adminJpy
        && a.rentJpy !== null && b.rentJpy !== null && a.rentJpy > 0
        && Math.abs(a.rentJpy - b.rentJpy) <= SAME_RENT * a.rentJpy
        && a.adminJpy >= ADMIN_SLIP_MIN_RATIO * a.rentJpy) {
        put(i, {
          fieldIds: ['adminFee'],
          rule: 'sibling_admin_x10',
          detail: `同棟同房型、賃料相近的另一間管理費 ${yen(b.adminJpy)} 円，這間 ${yen(a.adminJpy)} 円差整整十倍 → 疑似多打一個 0`,
        });
      }
    }
  }
  return out;
}

/** 敷金／礼金超過 DEPOSIT_KEY_MONTHS_MAX 個月的賃料。 */
export function checkDepositKeyMonths(depositJpy: number | null, keyJpy: number | null, rentJpy: number): Violation[] {
  if (rentJpy <= 0) return [];
  const out: Violation[] = [];
  for (const [id, zh, v] of [['deposit', '敷金', depositJpy], ['keyMoney', '礼金', keyJpy]] as const) {
    if (v === null || v / rentJpy <= DEPOSIT_KEY_MONTHS_MAX) continue;
    out.push({
      fieldIds: [id],
      rule: 'deposit_key_months',
      detail: `${zh} ${yen(v)} 円＝賃料 ${yen(rentJpy)} 円的 ${(v / rentJpy).toFixed(2)} 個月（門檻 ${DEPOSIT_KEY_MONTHS_MAX} 個月）`,
    });
  }
  return out;
}
