/**
 * UR賃貸住宅 adapter 測試。
 * 字串全部取自 2026-08-16 對 chintai.r6.ur-net.go.jp API 的實際回應。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseUrAccess, splitBuildingId, decodeEntities } from '../sources/ur/index.ts';

describe('建物 id 拆解', () => {
  test('20_2550 → shisya=20 danchi=255 shikibetu=0', () => {
    assert.deepEqual(splitBuildingId('20_2550'), { shisya: '20', danchi: '255', shikibetu: '0' });
  });
  test('20_3820 → danchi=382', () => {
    assert.deepEqual(splitBuildingId('20_3820'), { shisya: '20', danchi: '382', shikibetu: '0' });
  });
  test('格式不符 → null（不猜）', () => {
    assert.equal(splitBuildingId('abc'), null);
  });
});

describe('HTML 實體解碼', () => {
  test('&#13217; 就是 ㎡（U+33A1）', () => {
    assert.equal(decodeEntities('48&#13217;'), '48㎡');
  });
});

describe('access 欄位解析（UR 專用格式）', () => {
  test('多站：路線與站名要分得開，不可把路線吃進站名', () => {
    const s = parseUrAccess(
      '<li>都営新宿線｢小川町｣駅 徒歩2分</li><li>東京メトロ千代田線｢新御茶ノ水｣駅 徒歩2分</li><li>東京メトロ丸ノ内線｢淡路町｣駅 徒歩3分</li>',
    );
    assert.equal(s.length, 3);
    assert.equal(s[0]?.station, '小川町');
    assert.equal(s[0]?.line, '都営新宿線');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 2);
    assert.equal(s[2]?.station, '淡路町');
  });

  test('全形數字「徒歩８分」', () => {
    const s = parseUrAccess('<li>都営大江戸線「勝どき」駅 徒歩８分</li>');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 8);
  });

  test('需搭公車時，徒歩分不可當步行距離', () => {
    const s = parseUrAccess('<li>東京メトロ銀座線ほか「銀座」駅 バス１５分徒歩１分</li>');
    assert.equal(s[0]?.station, '銀座');
    assert.equal(s[0]?.walkMinutes.known, false);
    assert.ok(s[0]?.walkMinutes.srcText.includes('公車'));
  });

  test('範圍「徒歩8～9分」取下界', () => {
    const s = parseUrAccess('<li>東京メトロ有楽町線「月島」駅 徒歩8～9分</li>');
    assert.equal(s[0]?.walkMinutes.known && s[0].walkMinutes.v, 8);
  });

  test('同名車站但不同路線視為兩筆；完全相同才去重', () => {
    const s = parseUrAccess(
      '<li>東京メトロ有楽町線「月島」駅 徒歩8分</li><li>都営大江戸線「月島」駅 徒歩8分</li><li>都営大江戸線「月島」駅 徒歩8分</li>',
    );
    assert.equal(s.length, 2);
  });

  test('路線後綴「ほか」保留在路線而非站名', () => {
    const s = parseUrAccess('<li>JR山手線ほか｢鶯谷｣駅 徒歩5分</li>');
    assert.equal(s[0]?.station, '鶯谷');
    assert.equal(s[0]?.line, 'JR山手線ほか');
  });

  test('空字串 → 空陣列，不丟例外', () => {
    assert.deepEqual(parseUrAccess(''), []);
  });
});
