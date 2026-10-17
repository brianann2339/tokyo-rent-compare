/**
 * 站名／路線比對鍵（2026-10-17）：各來源同一個站／線寫法不同，站名字典把它們當成不同的站，
 * 搜「大塚」會漏掉寫成「大塚(東京)」的 Oak House。這裡守兩件事：
 * 同一個站／線的寫法要合併；不同的站／線絕對不能被併在一起。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stationKey, lineKey } from '../src/station.ts';

const same = (f: (s: string) => string, xs: string[]) => {
  const k = f(xs[0] as string);
  for (const x of xs) assert.equal(f(x), k, `${x} 應與 ${xs[0]} 同鍵（得到 ${f(x)} vs ${k}）`);
};
const differ = (f: (s: string) => string, a: string, b: string) => assert.notEqual(f(a), f(b), `${a} 與 ${b} 不可同鍵`);

describe('stationKey', () => {
  test('括號註記、尾端「駅」、全半形、ケ／ヶ／が、ノ／の', () => {
    same(stationKey, ['大塚', '大塚(東京)', '大塚駅']);
    same(stationKey, ['押上', '押上〈スカイツリー前〉', '押上（スカイツリー前）']);
    same(stationKey, ['浅草', '浅草(つくばＥＸＰ)', '浅草(東武・都営・メトロ)']);
    same(stationKey, ['阿佐ケ谷', '阿佐ヶ谷']);
    same(stationKey, ['自由が丘', '自由ヶ丘', '自由が丘(東京)']);
    same(stationKey, ['竹ノ塚', '竹の塚']);
    same(stationKey, ['早稲田', '早稲田(メトロ)']);
  });
  test('不同的站不併', () => {
    differ(stationKey, '中野', '東中野');
    differ(stationKey, '浅草', '浅草橋');
    differ(stationKey, '新宿', '新宿三丁目');
    differ(stationKey, '雑司が谷', '都電雑司ヶ谷');
    differ(stationKey, '阿佐ケ谷', '南阿佐ケ谷');
  });
});

describe('lineKey', () => {
  test('營運商全名／簡稱、全半形、空白、區間或支線註記', () => {
    same(lineKey, ['ＪＲ山手線', 'JR山手線', 'JR 山手線', '山手線', 'JR線山手線']);
    same(lineKey, ['東京メトロ丸ノ内線', '東京地下鉄丸ノ内線', '丸ノ内線', '東京メトロ丸の内線', '東京メトロ丸ノ内線（方南町支線）']);
    same(lineKey, ['都営大江戸線', '東京都大江戸線', '大江戸線', '東京都営大江戸線']);
    same(lineKey, ['都営三田線', '都営地下鉄三田線', '都営地下鉄 三田線', '東京都三田線']);
    same(lineKey, ['京王線', '京王電鉄京王線']);
    same(lineKey, ['京王井の頭線', '京王電鉄井の頭線']);
    same(lineKey, ['小田急線', '小田急小田原線', '小田急電鉄小田原線', '小田原線']);
    same(lineKey, ['都電荒川線', '東京都荒川線', '東京さくらトラム（都電荒川線）']);
    same(lineKey, ['京急本線', '京浜急行本線', '京浜急行電鉄本線']);
    same(lineKey, ['JR京浜東北線', 'ＪＲ京浜東北・根岸線', '京浜東北・根岸線', '京浜東北線']);
    same(lineKey, ['日暮里・舎人ライナー', '日暮里舎人ライナー']);
    same(lineKey, ['JR中央線', 'JR中央線(快速)', 'ＪＲ中央線', '中央線']);
  });
  test('不同的線不併；有歧義的不補營運商', () => {
    differ(lineKey, '新宿線', '都営新宿線');
    differ(lineKey, '新宿線', '西武新宿線');
    differ(lineKey, '京王線', '京王新線');
    differ(lineKey, 'JR中央線', 'JR総武線');
    differ(lineKey, '小田急線', '小田急多摩線');
    differ(lineKey, '東京メトロ有楽町線', '東京メトロ有楽町線・副都心線');
    differ(lineKey, '西武池袋線', '西武有楽町線');
  });
});
