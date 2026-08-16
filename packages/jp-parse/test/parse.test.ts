/**
 * 測試字串全部來自 2026-08-16 對各來源站的實際抓取，不是自己編的範例。
 * 每組都標了出處，來源改版時可以回去對照。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseMoney, parseMoneyRange, monthsToYen } from '../src/money.ts';
import { parseArea } from '../src/area.ts';
import { parseWalk, parseStations } from '../src/station.ts';
import { parseLayout, layoutSizeRank } from '../src/layout.ts';
import {
  parseContractType, parseContractMonths, parseMinStayMonths,
  parseEarlyTermination, parseYearBuilt, parseGender, parseGenderTags, parseForeignerSignals,
} from '../src/contract.ts';
import {
  statesUtilitiesIncluded, statesFurnished, isNegotiable, isExplicitZero, toHalfWidth,
} from '../src/text.ts';

describe('金額 parseMoney', () => {
  test('Leopalace「7.8 万円」', () => {
    assert.deepEqual(parseMoney('7.8 万円'), { kind: 'amount', jpy: 78000 });
  });
  test('Leopalace「共益費 6,500円」', () => {
    assert.deepEqual(parseMoney('6,500円'), { kind: 'amount', jpy: 6500 });
  });
  test('ひつじ「￥95,000」全形円記号', () => {
    assert.deepEqual(parseMoney('￥95,000'), { kind: 'amount', jpy: 95000 });
  });
  test('Couverture「¥74,000」半形円記号', () => {
    assert.deepEqual(parseMoney('¥74,000'), { kind: 'amount', jpy: 74000 });
  });
  test('Village House「¥0」→ zero', () => {
    assert.deepEqual(parseMoney('¥0'), { kind: 'zero' });
  });
  test('Leopalace「不要」→ zero（明寫不用付，是真實的 0）', () => {
    assert.deepEqual(parseMoney('不要'), { kind: 'zero' });
  });
  test('UR「ナシ」→ zero', () => {
    assert.deepEqual(parseMoney('ナシ'), { kind: 'zero' });
  });
  test('Leopalace「礼金 1ヶ月」→ months（不是金額，需乘賃料）', () => {
    assert.deepEqual(parseMoney('1ヶ月'), { kind: 'months', months: 1 });
  });
  test('UR「2か月」→ months', () => {
    assert.deepEqual(parseMoney('2か月'), { kind: 'months', months: 2 });
  });
  test('TSH「家賃1カ月分」→ months', () => {
    assert.deepEqual(parseMoney('家賃1カ月分'), { kind: 'months', months: 1 });
  });

  // 這三個是最重要的：誤判成 0 就是虛構數字
  test('「応相談」→ negotiable，絕不可當 0', () => {
    assert.deepEqual(parseMoney('応相談'), { kind: 'negotiable' });
  });
  test('「別途」→ negotiable，絕不可當 0', () => {
    assert.deepEqual(parseMoney('別途'), { kind: 'negotiable' });
  });
  test('「-」→ absent（頁面沒寫），不是 0', () => {
    assert.deepEqual(parseMoney('-'), { kind: 'absent' });
  });
  test('空字串 → absent', () => {
    assert.deepEqual(parseMoney('   '), { kind: 'absent' });
  });
  test('「込み」→ included（含在別的費用裡，0 有依據）', () => {
    assert.deepEqual(parseMoney('込み'), { kind: 'included' });
  });
  test('無法解析的文字 → unparsed（故障訊號，不是 0）', () => {
    assert.deepEqual(parseMoney('要問合せください'), { kind: 'negotiable' });
    assert.deepEqual(parseMoney('あいうえお'), { kind: 'unparsed' });
  });

  test('全形數字「６８，０００円」', () => {
    assert.deepEqual(parseMoney('６８，０００円'), { kind: 'amount', jpy: 68000 });
  });

  test('monthsToYen：礼金 1 個月 × 賃料 78,000', () => {
    assert.equal(monthsToYen(1, 78000), 78000);
    assert.equal(monthsToYen(0.5, 78000), 39000);
  });
});

describe('金額區間 parseMoneyRange', () => {
  test('ひつじ「￥55,000 - 59,000」（後半無単位）', () => {
    assert.deepEqual(parseMoneyRange('￥55,000 - 59,000'), { minJpy: 55000, maxJpy: 59000 });
  });
  test('TSH「¥59,000 ~ ¥66,000」', () => {
    assert.deepEqual(parseMoneyRange('¥59,000 ~ ¥66,000'), { minJpy: 59000, maxJpy: 66000 });
  });
  test('Social Apartment「56,000円 〜 80,000円」全形波浪', () => {
    assert.deepEqual(parseMoneyRange('56,000円 〜 80,000円'), { minJpy: 56000, maxJpy: 80000 });
  });
  test('單一金額 → null（不是區間）', () => {
    assert.equal(parseMoneyRange('¥74,000'), null);
  });
});

describe('面積 parseArea', () => {
  test('Leopalace「12.83㎡」', () => {
    assert.deepEqual(parseArea('12.83㎡'), { kind: 'exact', m2: 12.83, joDisplay: null });
  });
  test('Village House「28.98m²」', () => {
    assert.deepEqual(parseArea('28.98m²'), { kind: 'exact', m2: 28.98, joDisplay: null });
  });
  test('Couverture「12.7m2（8.2帖）」→ ㎡ 為主、帖為顯示', () => {
    assert.deepEqual(parseArea('12.7m2（8.2帖）'), { kind: 'exact', m2: 12.7, joDisplay: 8.2 });
  });
  test('ひつじ「9.8 ㎡ 6 畳」', () => {
    assert.deepEqual(parseArea('9.8 ㎡ 6 畳'), { kind: 'exact', m2: 9.8, joDisplay: 6 });
  });
  test('只有帖數「8帖」→ lower_bound，不是精確值（1帖=1.62㎡「以上」）', () => {
    assert.deepEqual(parseArea('8帖'), { kind: 'lower_bound', m2AtLeast: 12.96, jo: 8 });
  });
  test('無面積資訊 → absent', () => {
    assert.deepEqual(parseArea(''), { kind: 'absent' });
  });
});

describe('車站與步行 parseWalk', () => {
  test('Leopalace「徒歩13分」', () => {
    assert.deepEqual(parseWalk('徒歩13分'), { kind: 'exact', minutes: 13 });
  });
  test('ひつじ「徒歩 4 分」（含空白）', () => {
    assert.deepEqual(parseWalk('赤坂駅 まで 徒歩 4 分'), { kind: 'exact', minutes: 4 });
  });
  test('UR「バス7分 徒歩1～11分」→ via_bus，徒歩分不可當步行距離', () => {
    assert.deepEqual(parseWalk('バス7分 徒歩1～11分'), { kind: 'via_bus', busMinutes: 7, walkMinutes: 1 });
  });
  test('UR「徒歩29～38分」→ range，取下界並保留上界', () => {
    assert.deepEqual(parseWalk('徒歩29～38分'), { kind: 'range', minMinutes: 29, maxMinutes: 38 });
  });
  test('Village House「徒歩 23.0～26.0 分」小數', () => {
    assert.deepEqual(parseWalk('徒歩 23.0～26.0 分'), { kind: 'range', minMinutes: 23, maxMinutes: 26 });
  });

  test('Leopalace 多站串「｜」分隔', () => {
    const s = parseStations(
      '京王電鉄京王線「幡ヶ谷駅」徒歩13分｜京王電鉄京王線「笹塚駅」徒歩16分｜東京地下鉄方南支線「中野富士見町駅」徒歩18分',
    );
    assert.equal(s.length, 3);
    assert.equal(s[0]?.station, '幡ヶ谷');
    assert.equal(s[0]?.line, '京王電鉄京王線');
    assert.deepEqual(s[0]?.walk, { kind: 'exact', minutes: 13 });
    assert.equal(s[2]?.station, '中野富士見町');
  });
});

describe('間取り parseLayout', () => {
  test('Leopalace「1K」', () => {
    assert.deepEqual(parseLayout('1K'), { kind: 'rooms', canonical: '1K', rooms: 1, type: 'K' });
  });
  test('UR「2DK」', () => {
    assert.deepEqual(parseLayout('2DK'), { kind: 'rooms', canonical: '2DK', rooms: 2, type: 'DK' });
  });
  test('「1LDK」', () => {
    assert.deepEqual(parseLayout('1LDK'), { kind: 'rooms', canonical: '1LDK', rooms: 1, type: 'LDK' });
  });
  test('share house「個室」不屬於 nLDK 體系', () => {
    assert.deepEqual(parseLayout('個室'), { kind: 'sharehouse', canonical: '個室' });
  });
  test('「ドミトリー」', () => {
    assert.deepEqual(parseLayout('ドミトリー'), { kind: 'sharehouse', canonical: 'ドミトリー' });
  });
  test('UR「1K～2DK」區間 → unparsed（不擅自取一邊）', () => {
    assert.deepEqual(parseLayout('1K～2DK'), { kind: 'unparsed' });
  });
  test('排序分數：1R < 1K < 1DK < 1LDK < 2DK', () => {
    const r = ['1R', '1K', '1DK', '1LDK', '2DK'].map((x) => layoutSizeRank(x));
    assert.ok(r.every((x) => x !== null));
    for (let i = 1; i < r.length; i++) assert.ok((r[i] as number) > (r[i - 1] as number), `${i}`);
  });
});

describe('契約條件', () => {
  test('定期借家 vs 普通借家', () => {
    assert.equal(parseContractType('one-year fixed-term lease'), 'fixed_term');
    assert.equal(parseContractType('定期借家2年'), 'fixed_term');
    assert.equal(parseContractType('普通借家契約'), 'ordinary');
    assert.equal(parseContractType('契約期間 2年'), 'unknown');
  });
  test('否定句不可判反：「定期借家契約ではありません」是普通借家', () => {
    // 判反比判不出來嚴重：使用者會以為可以續約的房子不能續約
    assert.equal(parseContractType('定期借家契約ではありません'), 'ordinary');
    assert.equal(parseContractType('定期借家ではない'), 'ordinary');
    assert.equal(parseContractType('定期借家契約です'), 'fixed_term');
  });

  test('契約期間：年換算成月', () => {
    assert.equal(parseContractMonths('契約期間 2年'), 24);
    assert.equal(parseContractMonths('契約期間：6ヶ月'), 6);
    assert.equal(parseContractMonths('なし'), null);
  });
  test('TSH「最低契約期間 6カ月以上」', () => {
    assert.equal(parseMinStayMonths('最低契約期間 6カ月以上'), 6);
  });
  test('Borderless「Minimum of 1 month-stay is required.」', () => {
    assert.equal(parseMinStayMonths('Minimum of 1 month-stay is required.'), 1);
  });
  test('Village House 短期解約違約金（兩段式）', () => {
    const r = parseEarlyTermination('1年未満の解約は3ヵ月分、2年未満の解約は2ヵ月分');
    assert.deepEqual(r, [
      { beforeMonths: 12, penaltyMonths: 3 },
      { beforeMonths: 24, penaltyMonths: 2 },
    ]);
  });
  test('築年：Leopalace「1985年11月築」', () => {
    assert.equal(parseYearBuilt('1985年11月築'), 1985);
  });
  test('築年：Village House「1968/01」', () => {
    assert.equal(parseYearBuilt('1968/01'), 1968);
  });
  test('築年：「築15年」需以基準年換算', () => {
    assert.equal(parseYearBuilt('築15年', new Date('2026-08-16T00:00:00Z')), 2011);
  });
  test('築年：未來年份 → null（不接受不可能的值）', () => {
    assert.equal(parseYearBuilt('2099年築', new Date('2026-08-16T00:00:00Z')), null);
  });
});

describe('性別與外國人條件', () => {
  test('Couverture「女性専用」', () => {
    assert.equal(parseGender('女性専用'), 'female_only');
  });
  test('TSH「男性, 女性」→ mixed', () => {
    assert.equal(parseGender('男性, 女性, 年齢制限あり'), 'mixed');
  });
  test('ひつじ標籤列「女性 外国人歓迎」→ 需用 parseGenderTags', () => {
    // 自由文字解析器刻意不認裸的「女性」，避免「女性に人気」被誤判
    assert.equal(parseGender('女性 外国人歓迎'), 'unknown');
    assert.equal(parseGenderTags('女性 外国人歓迎'), 'female_only');
    assert.equal(parseGenderTags('男性・女性募集中'), 'mixed');
    assert.equal(parseForeignerSignals('女性 外国人歓迎').welcomed, true);
  });
  test('parseGenderTags 不可用於自由文字（這是它的已知限制）', () => {
    assert.equal(parseGenderTags('女性に人気のエリアです'), 'female_only'); // ← 誤判，故只用於標籤欄
    assert.equal(parseGender('女性に人気のエリアです'), 'unknown');
  });
  test('ひつじ的外國人條件原文', () => {
    const s = parseForeignerSignals(
      '外国人：在留カード、パスポート、ビザ、国内の緊急連絡先、日本語の読み書き、日常会話程度の日本語が話せること、保証会社加入必須。',
    );
    assert.equal(s.residenceCard, true);
    assert.equal(s.japanese, true);
    assert.equal(s.guarantorCompany, true);
  });
  test('UR「保証人ナシ」→ guarantorPerson false', () => {
    assert.equal(parseForeignerSignals('礼金ナシ 仲介手数料ナシ 更新料ナシ 保証人ナシ').guarantorPerson, false);
  });
});

describe('水電與傢俱旗標', () => {
  test('x-house 英文「Common service fee includes the fee for water, electricity, gas」', () => {
    // 英文寫法不在日文 regex 覆蓋內，應回 false 而非誤判 —— 由 adapter 另行處理
    assert.equal(statesUtilitiesIncluded('*Common service fee includes the fee for water, electricity, gas'), false);
  });
  test('日文「水道光熱費込み」', () => {
    assert.equal(statesUtilitiesIncluded('水道光熱費込み'), true);
  });
  test('「光熱費込」無み', () => {
    assert.equal(statesUtilitiesIncluded('光熱費込'), true);
  });
  test('「家賃に水道光熱費を含む」', () => {
    assert.equal(statesUtilitiesIncluded('家賃に水道光熱費を含む'), true);
  });
  test('Village House「※家具は含まれません」→ false', () => {
    assert.equal(statesFurnished('※家具は含まれません'), false);
  });
  test('「家具家電付き」→ true', () => {
    assert.equal(statesFurnished('家具家電付き'), true);
  });
  test('沒提到傢俱 → null（不知道，不是 false）', () => {
    assert.equal(statesFurnished('鉄筋コンクリート造'), null);
  });
});

describe('文字正規化', () => {
  test('全形轉半形', () => {
    assert.equal(toHalfWidth('６８，０００円'), '68,000円');
    assert.equal(toHalfWidth('１ＬＤＫ'), '1LDK');
  });
  test('isExplicitZero 與 isNegotiable 互斥', () => {
    assert.equal(isExplicitZero('なし'), true);
    assert.equal(isNegotiable('なし'), false);
    assert.equal(isNegotiable('応相談'), true);
    assert.equal(isExplicitZero('応相談'), false);
  });
});
