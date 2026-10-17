/**
 * 2026-10-17 第二十五輪：保証料／更新・再契約／清掃費／網路的說明文判讀。
 * 每條測試的原文都是 Tokyo Sharehouse 頁面上的實際寫法（括號裡是物件編號）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  proseGuarantorFee, proseRenewalFees, proseCleaningFees, proseInternet, proseFeeAmounts, proseOtherMonthly, proseZeroFees, proseUtilities, BLOCK_BREAK,
  proseOnlyRentAndCommonFee, proseBareInsuranceInCommonFee, proseDepositAmortized, proseSentences, proseUnadoptedZeroFees,
  proseInitialOnly, proseMonthlyOnly, proseDepositNoRefund,
} from '../src/prose.ts';

describe('保証会社初回保証料', () => {
  test('明寫初回要付（沒寫金額也算）→ stated', () => {
    assert.equal(proseGuarantorFee('※保証会社加入必須（初回保証料が別途発生します）')?.kind, 'stated'); // 1695
    assert.equal(proseGuarantorFee('初期費用:25,000円（礼金1万、初回保証料1.5万）')?.kind, 'stated'); // 2024
    assert.equal(proseGuarantorFee('保証会社要加入 保証料：初回20,000円、毎月保証会社手数料')?.kind, 'stated'); // 389
    assert.equal(proseGuarantorFee('【初期費用】清掃費：22,000円/ 火災保険：20,000円（2年）/ 家賃保証料：総賃料50％')?.kind, 'stated'); // 282
  });
  test('「保証会社初期費用20000円」的結尾不是 0 円（1748）', () => {
    assert.equal(proseGuarantorFee('初期費用：46000円＋保証会社初期費用20000円')?.kind, 'stated');
  });
  test('明寫不用保證公司 → zero；條件只看保證公司那一項（3943 同句的「または」講的是更新料）', () => {
    assert.equal(proseGuarantorFee('連帯保証人や保証会社は不要')?.kind, 'zero'); // 3850
    assert.equal(proseGuarantorFee('・住宅保険料：不要 ・鍵発行手数料：不要 ・家賃保証会社：不要（緊急連絡先に２親等以内の方を指定） 更新料または再契約料 20,000円')?.kind, 'zero');
    assert.equal(proseGuarantorFee('保証会社▶▶原則、不要ですが必要な場合もあり')?.kind, 'mentioned'); // 2315
  });
  test('只寫必須或月付 → mentioned（存「這頁沒寫」，不是「來源不公開」也不是 0）', () => {
    assert.equal(proseGuarantorFee('保証会社加入必須')?.kind, 'mentioned');
    assert.equal(proseGuarantorFee('保証会社利用 : オリコフォレントインシュア（保証料月額支払合計1．2％）')?.kind, 'mentioned');
    // 3921：初期費用條列裡的 800 円在別處寫成月額，是第一個月的月費
    assert.equal(proseGuarantorFee('初回契約手数料33,000円家財保険料500円保証会社利用料800円\n保証会社利用必須/月額800円')?.kind, 'mentioned');
    // 月額在費用名詞前面（3547）
    assert.equal(proseGuarantorFee('初期費用31,500円 、月額保証料1,124円 、要家財保険加入')?.kind, 'mentioned');
  });
  test('不是保證公司的「保証」：携行品保証料、警備保証会社、押金別名、保險含在保證費', () => {
    assert.equal(proseGuarantorFee('④携行品保証料（初回）9,600円（非課税）'), null); // 2517
    assert.equal(proseGuarantorFee('警備保証会社、複製できないカード鍵を採用'), null); // 2224
    assert.equal(proseGuarantorFee('デポジット（保証料）：賃料の1ヶ月分 (保証人無しの場合、賃料の2ヶ月分）、退去時に50％償却'), null); // 3580
    assert.equal(proseGuarantorFee('・火災保険加入必須（上記保証料に含む）'), null); // 4436
  });
});

describe('更新料／更新事務手数料', () => {
  test('字面對應：〜料＝renewalFee，〜手数料＝renewalAdminFee；金額不採用', () => {
    const a = proseRenewalFees('再契約手数料：1年おきに3万円'); // 3448
    assert.equal(a.renewalAdminFee?.kind, 'stated');
    assert.equal(a.renewalFee, undefined);
    assert.equal(proseRenewalFees('再契約料 30,000円 中途解約手数料 15,000円').renewalFee?.kind, 'stated'); // 397
    assert.equal(proseRenewalFees('・更新時に20,000円の再契約手数料あり').renewalAdminFee?.kind, 'stated'); // 3985
    assert.equal(proseRenewalFees('※契約更新時：入館費相当額がかかります').renewalFee?.kind, 'stated'); // 4301
  });
  test('保證公司自己的續約費不是租約的更新料（4317、1844、3666）', () => {
    assert.deepEqual(proseRenewalFees('・保証会社加入必須（初回保証料 総賃料の50％～ 更新料10000円※1年毎）'), {});
    assert.deepEqual(proseRenewalFees('・家賃保証会社：1万円（毎年更新料：1万円～1万5千円）'), {});
    assert.deepEqual(proseRenewalFees('1.賃貸借契約の期間初回：6ヶ月間。2.家賃保証会社家賃保証会社利用料として初回￥10000／年、更新時￥10000／年。'), {});
    // 同一行裡保證公司那一項之後的更新料照讀（3943）
    assert.equal(proseRenewalFees('・家賃保証会社：不要（緊急連絡先に２親等以内の方を指定） 更新料または再契約料 20,000円').renewalFee?.kind, 'stated');
  });
  test('免收：清單、「再契約時は…一切かかりません」兩項都免、小標下一行「・なし」', () => {
    assert.equal(proseRenewalFees('※敷金、礼金、更新料、事務手数料などはありません').renewalFee?.kind, 'zero'); // 4027
    const all = proseRenewalFees('再契約時は事務手数料や更新料などの家賃・共益費以外の費用は一切かかりません'); // 2579
    assert.equal(all.renewalFee?.kind, 'zero');
    assert.equal(all.renewalAdminFee?.kind, 'zero');
    assert.equal(proseRenewalFees('＜更新料、退去時のクリーニング費用等＞\n\n・なし（ただし、壁に穴を開けた場合は修復実費を請求）').renewalFee?.kind, 'zero'); // 4026
  });
  test('漲租不是費用：「初回再契約時賃料5,000円UP」（2725）', () => {
    assert.deepEqual(proseRenewalFees('初回再契約時賃料5,000円UP'), {});
  });
  test('單獨一行的費用名、下一行「※初回再契約時は免除」→ 原站列為一項費用（3879）', () => {
    assert.equal(proseRenewalFees('・再契約料（更新料）\n※初回再契約時は免除').renewalFee?.kind, 'stated');
  });
});

describe('清掃費：入居時／退去時', () => {
  test('明寫入居時付的退去清掃費歸入居時（3448、3346、4284）', () => {
    const r = proseCleaningFees('初期費用：部屋家賃(共益費含めない)1ヶ月分＋鍵発行手数料5,000円＋退去後クリーニング費20,000円(入居時前払い)┃お部屋');
    assert.equal(r.cleaningFeeUpfront?.kind, 'stated');
    assert.equal(r.cleaningFeeOnExit, undefined);
    // 千分位逗號不是分句界線
    assert.equal(proseCleaningFees('・前払退出時清掃費:15,000円（ご契約時のみ）').cleaningFeeUpfront?.kind, 'stated');
    assert.equal(proseCleaningFees('・退室清掃代30,000円(税別）を契約時に戴きます').cleaningFeeUpfront?.kind, 'stated');
  });
  test('初期費用條列與小標：「初回に入居金16,500円／人、クリーニング代16,500円／人…」（BeGood 系列）、【初回契約時費用】下的⑤（2517）', () => {
    assert.equal(proseCleaningFees('初回に入居金16,500円／人、クリーニング代16,500円／人、家財保険代(1年間)7,000円／部屋が別途掛かります').cleaningFeeUpfront?.kind, 'stated');
    assert.equal(proseCleaningFees('【初回契約時費用】\n①契約月分の日割り家賃\n⑤クリーニング代（退去時使用）22,000円（税込）').cleaningFeeUpfront?.kind, 'stated');
  });
  test('明寫退租時付、或名稱是退去清掃費又沒寫入居時收 → 退去時；初期費用括號外的不算入居時（2282）', () => {
    assert.equal(proseCleaningFees('※退去時にクリーニング費用 25,000円（税別）を頂戴しております').cleaningFeeOnExit?.kind, 'stated');
    const r = proseCleaningFees('初期費用（礼金15,000円、初回保証料10,000円） 退去時クリーニング代 15,000円 要保証会社加入（月額1,830円）');
    assert.equal(r.cleaningFeeOnExit?.kind, 'stated');
    assert.equal(r.cleaningFeeUpfront, undefined);
  });
  test('同棟已寫退去時收，房型變體併入同一筆（700）', () => {
    const r = proseCleaningFees('※退去時にクリーニング費用 39,000円（税別）\n※23㎡の居室クリーニング費用 45,000円（税別）');
    assert.equal(r.cleaningFeeUpfront, undefined);
    assert.match(r.cleaningFeeOnExit?.sentence ?? '', /23㎡/);
  });
  test('都沒寫何時付 → 入居時並註明（初期費用寧可標下界）', () => {
    const r = proseCleaningFees('清掃費：39,600円～66,000円(税込)'); // 2301
    assert.equal(r.cleaningFeeUpfront?.kind, 'stated');
    assert.equal(r.cleaningFeeUpfront?.timingUnstated, true);
  });
  test('從押金扣的不是另一筆清掃費；洗衣店、共用部清掃、帶條件的不算', () => {
    assert.deepEqual(proseCleaningFees('保証金は退去時に清掃代5000円を差し引き、返却'), {});
    assert.deepEqual(proseCleaningFees('※デポジットは、退去時のクリーニング費用として償却しますので、ご返金はありません'), {});
    assert.deepEqual(proseCleaningFees('保証金：個室3万円 ドミトリー2万円（各 退去時清掃費として半額償却となります）'), {});
    assert.deepEqual(proseCleaningFees('スーパー、100均、コンビニ、クリーニング店があります'), {});
    assert.deepEqual(proseCleaningFees('共益費には、水道光熱費、インターネット使用料、共用部の清掃費用などが含まれます'), {});
    assert.deepEqual(proseCleaningFees('状態がひどい場合別途クリーニング費用をご負担頂きます'), {});
  });
  test('含在契約手数料裡（「契約手数料」小標後的「※事務手数料や個室清掃費などを含む契約時のみ…」）→ included', () => {
    assert.equal(proseCleaningFees('契約手数料\n※事務手数料や個室清掃費などを含む契約時のみお支払い頂く料金です。\n個室・相部屋：40,000円').cleaningFeeUpfront?.kind, 'included');
  });
  test('免收：「（清掃代、保険料等）は一切請求いたしません」（1625）→ 兩欄都 0', () => {
    const r = proseCleaningFees('それ以外の面倒な費用（清掃代、保険料等）は一切請求いたしません。');
    assert.equal(r.cleaningFeeUpfront?.kind, 'zero');
    assert.equal(r.cleaningFeeOnExit?.kind, 'zero');
  });
});

describe('網路費', () => {
  test('含在共益費／水電費裡 → included；明寫免費 → zero', () => {
    assert.equal(proseInternet('共益費（水光熱費・wi-fi・保険含む）')?.kind, 'included'); // 3513
    assert.equal(proseInternet('・共益費（水道光熱費インターネット等）：12,000円/月')?.kind, 'included'); // 3879
    assert.equal(proseInternet('共益費電気・ガス・水道・インターネット料/16,000円')?.kind, 'included'); // 3921
    assert.equal(proseInternet('インターネット無料')?.kind, 'zero');
    assert.equal(proseInternet('・インターネット回線 CATV （無料）')?.kind, 'zero'); // 261
  });
  test('條件只看網路那一段：「インターネット無料 条件付きで4.08万円」的條件講房租（3697）', () => {
    assert.equal(proseInternet('インターネット無料 条件付きで4.08万円')?.kind, 'zero');
  });
  test('另付 → stated；選配、超額另收、只限共用部、只說房租含 → 不判', () => {
    assert.equal(proseInternet('ネットwi-fi使用は有料2,200円/月です')?.kind, 'stated'); // 1310
    assert.equal(proseInternet('※個室の電気・インターネット料金は個別契約')?.kind, 'stated'); // 4219
    assert.equal(proseInternet('WiFi 2,000円（オプション）'), null); // 3375
    assert.equal(proseInternet('有線LANタイプ1,000円'), null); // 736
    assert.equal(proseInternet('人数割で電気、ガス、インターネット、水道の合計が１人10,000円を超えた場合には追加徴収あり'), null); // 2761
    assert.equal(proseInternet('インターネット共有部無料、専有部WIFI導入済み'), null); // 809
    assert.equal(proseInternet('家賃にインターネット（無線 光）水光熱費など10000円'), null); // 3550
  });
  test('免費與另付並存 → conflict', () => {
    assert.equal(proseInternet('インターネット無料\nインターネットは１,０００円です')?.kind, 'conflict');
  });
});

describe('第二十七輪驗證後的修正', () => {
  test('免收句只講退去時：只有退去清掃費是 0，入居時的不判（4027／4028）', () => {
    const c = proseCleaningFees('＜更新料、退去時のクリーニング費用等＞\n・なし（ただし、壁に穴を開けた、タバコを吸った等の場合は修復にかかる実費を請求）');
    assert.equal(c.cleaningFeeOnExit?.kind, 'zero');
    assert.equal(c.cleaningFeeUpfront, undefined);
  });
  test('「初期費用1.5万／保証料30％（最低1.2万）」被「／」切開也認得是初期費用條列裡的保證費（4361）', () => {
    assert.equal(proseGuarantorFee('水光熱費実費 インターネット無料 初期費用1.5万／保証料30％（最低1.2万）／※相談可')?.kind, 'stated');
  });
  test('光ネット無料／使い放題 → 0（2359、2142）', () => {
    assert.equal(proseInternet('掃除当番、ゴミ当番無し！高速の光ネット無料！ウォーターサーバー無料で飲み放題！')?.kind, 'zero');
    assert.equal(proseInternet('・光ネット入居中使い放題&無料。')?.kind, 'zero');
  });
  test('「保険加入 必須」中間夾空白也是明寫要付（2179）', () => {
    assert.ok(proseFeeAmounts('【各種条件】\n・別途家財保険加入 必須').fireInsurance !== undefined);
  });
  test('總稱的初期費用、沒拆項目 → 其他初期費用明寫要付（4331、4361、4027）', () => {
    assert.ok(proseFeeAmounts('・初期費用：25,000円').otherInitial !== undefined);
    assert.ok(proseFeeAmounts('初期費用1.5万／保証料30％（最低1.2万）').otherInitial !== undefined);
    assert.ok(proseFeeAmounts('※入居時、初期費用として家賃1ヶ月分かかります（返還なし）').otherInitial !== undefined);
    assert.ok(proseFeeAmounts('初期費用31,500円 、月額保証料1,124円 、要家財保険加入').otherInitial !== undefined); // 3547：月額講的是保證料
  });
  test('已拆項目、講的是保證金、活動、估算總額 → 不另立一筆', () => {
    assert.equal(proseFeeAmounts('初期費用:25,000円（礼金1万、初回保証料1.5万）').otherInitial, undefined); // 2024
    assert.equal(proseFeeAmounts('初期費用：家賃1ヶ月分＋3万円（契約事務手数料/退去クリーニング費/鍵発行手数料/ベッドパット）┃2人入居不可×').otherInitial, undefined); // 3179
    assert.equal(proseFeeAmounts('初期費用は17,000円（家賃以外） 内訳：退去時清掃費10,000円と家財保険7,000円です').otherInitial, undefined); // 1463
    assert.equal(proseFeeAmounts('保証金は初期費用として30,000円のみ→返金不可').otherInitial, undefined); // 1695
    assert.equal(proseFeeAmounts('期間中のみ初期費用30,000円割引').otherInitial, undefined); // 2029
    assert.equal(proseFeeAmounts('初期費用合計 約120,000円').otherInitial, undefined);
    assert.equal(proseFeeAmounts('初期費用 1,000円/月').otherInitial, undefined);
  });
});

describe('第二十八輪驗證後的修正', () => {
  test('「6名限定のアットホームなシェアハウス」不是活動（4513）', () => {
    assert.equal(proseInternet('―◆女性限定鍵付き個室36,800円～！◆―\n・インターネット無料\n・6名限定のアットホームなシェアハウス')?.kind, 'zero');
  });
  test('判條件的前後文不跨區塊：房間備考的「条件付きで54,800円」不讓介紹文的保險負擔句作廢（2428）', () => {
    const intro = 'ウォーターサーバー無料で飲み放題！通常は賃料とは別に発生する高額な「家財保険」と「借家人賠償保険」をハウス負担。グレードとコストパフォーマンスに優れたハウスでの新生活はいかがでしょうか！';
    const remark = '水光熱費実費 条件付きで54,800円。通常62800円。詳細お問合せください。';
    assert.equal(proseZeroFees(`${intro}\n${remark}`).fireInsurance, undefined); // 舊行為：跨進備考
    assert.ok(proseZeroFees(`${intro}\n${BLOCK_BREAK}\n${remark}`).fireInsurance !== undefined);
  });
  test('同一行被「！」切開的活動句：「…デポジット無料キャンペーン中！　初期費用6.9万円でご入居できます」不另立初期費用（1408）', () => {
    assert.equal(proseFeeAmounts('1年以上のご入居でデポジット無料キャンペーン中！　初期費用6.9万円でご入居できます').otherInitial, undefined);
  });
});

describe('第二十九輪驗證後的修正', () => {
  test('「共益費にライフライン料を含みます」＝含（4227）；「含みません」不算', () => {
    assert.equal(proseUtilities('共益費にライフライン料を含みます。補償料として毎月1100円かかります。')?.basis, 'included');
    assert.notEqual(proseUtilities('共益費にライフライン料を含みません。')?.basis, 'included');
  });
  test('只講別項費用的活動不是這句的條件（2531）；講同一項費用的照樣是', () => {
    const t = '★内見可能 ★敷金・礼金０ ★フリーレント1ヶ月 ★仲介手数料 半額キャンペーン中 ※初期費用の詳細は弊社までお問合せください。 エアコン・衣類ラックつき♪ 無料Wi-Fi完備、水道光熱費は定額制（共益費に込み）のため経済的です！';
    // 同句也寫了「（共益費に込み）」，網路判成含或免費都是 0（兩者都對）；重點是不再被活動句作廢
    assert.ok(['zero', 'included'].includes(proseInternet(t)?.kind ?? ''));
    assert.equal(proseUtilities(t)?.basis, 'included');
    assert.equal(proseZeroFees('★仲介手数料 半額キャンペーン中\n仲介手数料0円').agencyFee, undefined);
  });
  test('後面的【】小標是另一段：「【キャンペーン情報】」不讓前面的免費句作廢（866）', () => {
    assert.equal(proseInternet('お部屋でWi-Fiが無料で利用できます♪♪\n\n★オンラインでの内見もご相談可能！\n\n【キャンペーン情報】\n★賃料・水道光熱費1か月間0円キャンペーン中‼')?.kind, 'zero');
  });
  test('費用小標下的條列、沒寫金額＝明寫要付（866、4394）；那一項帶 0 円或月付不算；「┃」之後不屬於小標', () => {
    const t866 = '契約時費用：退去時クリーニング費用、賃貸住宅総合保険';
    assert.ok(proseFeeAmounts(t866).fireInsurance !== undefined);
    assert.equal(proseCleaningFees(t866).cleaningFeeUpfront?.kind, 'stated');
    const t4394 = '・初期費用：敷金・礼金・仲介手数料0円　初月・翌月分の賃料、火災保険料（月額￥700）、保証料（支払方法によって変動）※ご契約プランは1年または2年からお選びいただけます';
    assert.equal(proseGuarantorFee(t4394)?.kind, 'stated');
    assert.equal(proseFeeAmounts(t4394).keyMoney, undefined);
    assert.equal(proseFeeAmounts(t4394).fireInsurance, undefined);
    assert.equal(proseGuarantorFee('最低入居期間：6ヶ月以上┃初期費用：家賃1ヶ月分＋3万円（契約事務手数料/退去クリーニング費/鍵発行手数料/ベッドパット）┃2人入居不可× ┃保証会社利用必須┃')?.kind, 'mentioned');
  });
  test('「口座振替手数料￥550／月」的全形斜線不切句（4509）', () => {
    assert.equal(proseOtherMonthly('その他：口座振替手数料￥550／月、入居時鍵交換をご希望の場合は実費にて対応します。 保証会社利用￥10000／年').length, 1);
  });
  test('「■再契約2回目から手料/5,500円」（3921，原站漏字）→ 更新事務手数料', () => {
    assert.equal(proseRenewalFees('■再契■再契約2回目から手料/5,500円。').renewalAdminFee?.kind, 'stated');
  });
});

describe('其他月費：保證公司月費與月付事務手数料', () => {
  test('明寫月付 → 收（金額不採用）', () => {
    for (const t of [
      '・月額保証料：1,830円', // 2280
      '・保証料月額（保証会社）：1,830円', // 4331
      '保証会社利用必須/月額800円', // 3921
      '保証会社利用 : オリコフォレントインシュア（※保証料月額支払合計1．2％、※初期費用・更新費用なし）', // 4221
      '保証会社要加入 保証料：初回20,000円、毎月保証会社手数料', // 4433
      '家賃保証加入必須（加入時￥37,000＋￥440/月）', // 4233
      '保証会社加入要（初回保証料10,000円、毎月1500円が月額保証料として必要）', // 3787
      '月々のお支払いは賃料+共益費+保証会社利用料3%です', // 2903
      '事務手数料：990円/月（税込）、清掃費：36,300 円（税込）', // 3477
      '火災保険 20,000円/2年, 清掃費：36,300円(税込) 事務手数料 990円/月(税込), ベッドパッド・シーツ(ベッド利用の場合), 3,300円(税込)', // 2023：場合講的是寢具
      '事務\u200b手数料：990 円/月(税込)', // 零寬空白
      '・月額あんしんサポート料1,500円（税込）', // 3155（第二十八輪）
      '・【必須】PLENDYサポート月額1,650円（税込）※キャンペーンで3ヶ月間無料',
      '【その他費用】家財保険：512円/月',
      '別途 町会費200円/月',
      '補償料として毎月1100円かかります',
      '設備費8000円/月・荻窪家族会費3000円/月',
      '駐輪場利用時300円（月額）・口座振替手数料330円（月額）・事務手数料（家賃1ヶ月分＋税）',
      '火災保険料（月額￥700）、保証料（支払方法によって変動）', // 4394
    ]) assert.equal(proseOtherMonthly(t).length, 1, t);
  });
  test('基數、年費、條件、免收、入居時一次付 → 不收', () => {
    for (const t of [
      '・保証会社加入要（月額賃料30～50％）', // 3146：月額是基數
      '保証会社加入必須（初回保証料：月額総賃料の0.5ヶ月分、1年毎に10,000円の更新料がかかります）', // ひつじ
      '保証会社利用 : 初回保証料：月額支払い家賃の50％、翌年以降10,000円/年', // 687
      '外国籍の方は保証会社利用（月額1,000円）の場合あり',
      '・保証会社利用の場合は、保証委託金が毎月必要となります（賃料・管理費・光熱費の月間総賃料の3％）', // 3198
      '保証会社不要',
      '事務手数料：11,000円/入居時',
      '保証会社加入必須（初回保証料が別途発生します）',
      '音楽室利用条件 音楽室利用料2500円/月', // 用了才付
      '自転車 550円/月(税込), バイク 3,300円/月(税込)',
      '駐車場 11,000円/月(税込)',
      '家財保険は任意加入（月額500円）',
      '家財保険：2年 15,000円',
    ]) assert.deepEqual(proseOtherMonthly(t), [], t);
  });
});

describe('第三十輪驗證後的修正', () => {
  const PH = '【明朗会計がモットーです！】当シェアハウスでは「●●手数料」「●●保証料」「●●保険」等の費用は請求しません！！';
  test('「●●」是佔位寫法：不切句；各種保證費、保險費都不收（1532、492、2737）', () => {
    assert.ok(proseSentences(PH).some((x) => x.includes('「●●手数料」「●●保証料」「●●保険」等の費用は請求しません')));
    assert.equal(proseGuarantorFee(PH)?.kind, 'zero');
    const z = proseZeroFees(PH);
    assert.ok(z.fireInsurance?.includes('「●●保険」'));
    // 「●●手数料」是泛稱，分不出是不是契約手數料——不判
    assert.equal(z.contractFee, undefined);
    // 不是佔位、只是裝飾的「●●　必ずご確認下さい。　●●」（2806）照舊切開
    assert.equal(proseGuarantorFee('●●　必ずご確認下さい。　●●'), null);
  });
  test('舊欄位也認「頂戴しません」「などの費用は」（492 房間備考）', () => {
    const z = proseZeroFees('★その他、諸経費・再契約手数料・鍵交換費用などの費用は頂戴しません！');
    assert.ok(z.keyExchangeFee !== undefined);
    assert.equal(z.contractFee, undefined); // 再契約手数料不是入居時的契約手數料
  });
  test('「補償料月1500円」是月付固定費（2745 note）；年費不算', () => {
    assert.equal(proseOtherMonthly('補償料月1500円').length, 1);
    assert.equal(proseOtherMonthly('町会費：年1,200円').length, 0);
  });
  test('含在共益費的網路不受同段的房租活動影響（332）', () => {
    const t = '【入居条件とキャンペーンのご案内】\n新規契約の方は、2027年2月分家賃より\n1万円キャッシュバック\n毎月のお支払い\n家賃＋共益費：10,000円（水道,共有部分電気,ガス,音楽スタジオ,Wi-Fi代などを含む)';
    assert.equal(proseInternet(t)?.kind, 'included');
    // 活動寫在同一句的照舊不算
    assert.equal(proseInternet('キャンペーン期間中は共益費にWi-Fi代を含みます'), null);
  });
  test('總括免收句（3441）；附近有活動字眼的回報 conditional（2227）；只講再契約時的不算（2579）', () => {
    assert.equal(proseOnlyRentAndCommonFee('無線ＬＡＮは無料で生活備品も充実しています。家賃と共益費以外の費用が、かからないので、とてもリーズナブルです。')?.conditional, false);
    assert.equal(proseOnlyRentAndCommonFee('家賃と共益費以外の費用が、かからないので、とてもリーズナブルです\n最短契約期間6ヶ月～\n期間限定キャンペーン：最短契約期間3カ月以上')?.conditional, true);
    assert.equal(proseOnlyRentAndCommonFee('再契約時は事務手数料や更新料などの家賃・共益費以外の費用は一切かかりません。'), null);
  });
  test('免收句判成附條件時另外回報（492）；沒條件的不在這裡', () => {
    const t = 'デポジット2万円→今なら無料\n※入居のタイミングによっては翌月の家賃も含む場合あり\n★その他、諸経費・再契約手数料・鍵交換費用などの費用は頂戴しません！';
    assert.equal(proseZeroFees(t).keyExchangeFee, undefined);
    assert.equal(proseUnadoptedZeroFees(t).keyExchangeFee?.reason, 'conditional');
    assert.ok(proseUnadoptedZeroFees(t).keyExchangeFee?.sentence.includes('鍵交換費用'));
    assert.deepEqual(proseUnadoptedZeroFees('★その他、諸経費・再契約手数料・鍵交換費用などの費用は頂戴しません！'), {});
  });
  test('條列裡講別的費用的一項不是條件（3392）；與另一處帶金額的說法並存時回報 contested', () => {
    // 3392 note 一行＋房間備考（備考的「16,000円※…家財保険が含まれています」帶金額，與「住宅保険料：不要」並存）
    const t = '・住宅保険料：不要 ・鍵発行手数料：不要 ・家賃保証会社：不要（緊急連絡先に２親等以内の方を指定） 更新料または再契約料 20,000円(税込み22,000円)\n'
      + `・６ヶ月未満で退去の場合：短期解約手数料５万円（+消費税）\n${BLOCK_BREAK}\n`
      + '別途 光熱水等費 月額16,000円※電気・ガス・水道・共用部消耗品・インターネット使用料・家財保険が含まれています。';
    assert.ok(proseZeroFees(t).keyExchangeFee !== undefined);
    assert.equal(proseZeroFees(t).fireInsurance, undefined);
    assert.equal(proseUnadoptedZeroFees(t).fireInsurance?.reason, 'contested');
  });
  test('只寫「保険」含在共益費：回傳原句（不當火災保険已含）；寫明火災保険的不走這裡', () => {
    assert.ok(proseBareInsuranceInCommonFee('備考: 共益費（水光熱費・wi-fi・保険含む）') !== null); // 3513
    assert.equal(proseBareInsuranceInCommonFee('共益費（水光熱費・火災保険含む）'), null);
  });
  test('說明文寫保証金償却（282 note、3565 note）', () => {
    assert.ok(proseDepositAmortized('・保証金1ヶ月分（入居時50％償却）') !== null);
    assert.ok(proseDepositAmortized('保証金は手数料として償却。') !== null);
    assert.equal(proseDepositAmortized('保証金は退去時に全額返金します。'), null);
  });
});

describe('第三十一輪驗證後的修正', () => {
  test('屋主負擔的對象在「…は、」主題裡（2314、2493）；主題前面帶金額的項目不算', () => {
    assert.ok(proseZeroFees('＊家財保険・借家人賠償保険は、オーナーが負担します。').fireInsurance !== undefined);
    assert.ok(proseZeroFees('・ 万が一の時の為の火災保険、家財保険、賠償保険は高額になる為、ハウス負担').fireInsurance !== undefined);
    const t = '礼金1ヶ月、火災保険は、オーナー負担です。';
    assert.ok(proseZeroFees(t).fireInsurance !== undefined);
    assert.equal(proseZeroFees(t).keyMoney, undefined);
  });
  test('同一項免收句一處靠近活動、一處沒有，且都不帶金額：採用沒有活動的那一處（2314）', () => {
    const t = `＊高額となる家財保険・借家人賠償保険は、オーナーが負担します。\n★1カ月分の家賃半額キャンペーン中！★\n${BLOCK_BREAK}\n＊家財保険・借家人賠償保険は、オーナーが負担します。`;
    assert.ok(proseZeroFees(t).fireInsurance?.startsWith('＊家財保険'));
    // 活動句本身帶金額（「通常仲介手数料1ヶ月→今だけ無料」）仍算另一種說法
    const u = `★キャンペーン★通常仲介手数料1ヶ月→今だけ無料\n${BLOCK_BREAK}\n仲介手数料無料`;
    assert.equal(proseZeroFees(u).agencyFee, undefined);
  });
  test('清單裡夾「入館料」也整串接（113）：靠近活動 → 回報未採用', () => {
    const t = '★★★2026年キャンペーン初期費用を今だけなしなし★★★\n敷金、礼金、仲介料、保証金、入館料、全てなしなし';
    assert.equal(proseZeroFees(t).keyMoney, undefined);
    assert.equal(proseUnadoptedZeroFees(t).keyMoney?.reason, 'conditional');
    assert.equal(proseUnadoptedZeroFees(t).agencyFee?.reason, 'conditional');
  });
  test('「入館料2万」（沒寫円）也是其他初期費用（113 note）', () => {
    assert.ok(proseFeeAmounts('入館料2万\n家財保険18,000円（2年間）').otherInitial?.includes('入館料2万'));
    assert.equal(proseFeeAmounts('入館料は2万人の会員').otherInitial, undefined);
  });
  test('契約金後面接內訳（下一行或括號）：不另記其他初期費用；內訳的事務手数料算契約手数料（2481、3992）', () => {
    const t = '初回契約時に契約金として40,000円必要。\n内訳：退去時清掃費30,000円+事務手数料10,000円)';
    assert.equal(proseFeeAmounts(t).otherInitial, undefined);
    assert.ok(proseFeeAmounts(t).contractFee?.includes('内訳'));
    assert.equal(proseFeeAmounts('契約金40,000円(退去時清掃費+事務手数料)').otherInitial, undefined);
    assert.ok(proseFeeAmounts('契約金55,000円（税込）').otherInitial !== undefined, '括號只寫稅別不是內訳（288）');
  });
  test('押金名詞寫成月額（3249「保証金：月2,000円／原則保証会社が必須」）→ 其他月費明寫要付', () => {
    assert.equal(proseOtherMonthly('備考: 保証金：月2,000円／原則保証会社が必須となります 。').length, 1);
    assert.equal(proseOtherMonthly('保証金：30,000円').length, 0);
  });
  test('只寫部分水電另計：標記 someExcludedOnly（3595）；「実費精算」不是預收後精算', () => {
    const r = proseUtilities('電気代は各室使用分実費精算');
    assert.equal(r?.basis, 'partial');
    assert.equal(r?.someExcludedOnly, true);
    assert.equal(proseUtilities('共益費（水道光熱費）は￥10000/月を前預かり後、年2回精算')?.someExcludedOnly, undefined); // 43
    assert.equal(proseUtilities('水道光熱費は実費精算です')?.basis, 'excluded');
  });
  test('「初期費用は…のみ」：每一項都認得才算（3163、332、3275）；認不得的（793、3500）與講押金的不算', () => {
    assert.deepEqual(proseInitialOnly('【初期費用】は「保証金￥30000」＋「入居する月の日割り賃料」のみ（その他の手数料等はナシ）。')?.listed, []);
    assert.equal(proseInitialOnly('初期費用は日割り家賃と返金可能なデポジット3万円のみ。')?.conditional, false);
    assert.deepEqual(proseInitialOnly('初期費用：初月分の賃料日割りと事務手数料1.5万円のみ。')?.listed, ['事務手数料']);
    assert.equal(proseInitialOnly('初期費用は3万円＋初回保証料1.5万円のみ！'), null);
    assert.equal(proseInitialOnly('初期費用①＋②のみ!!'), null);
    assert.equal(proseInitialOnly('保証金は初期費用として30,000円のみ→返金不可'), null);
    assert.equal(proseInitialOnly('※入居時の初期費用にのみ事務手数料25.000円（税別）が別途必要です。'), null);
    assert.equal(proseInitialOnly('★キャンペーン中★初期費用は日割り家賃とデポジット3万円のみ。')?.conditional, true);
  });
  test('初期費用例後的「それ以外にかかる費用は一切ございません」（2493、2220）：中間每一行都要是認得出來的組成', () => {
    const t = '初期費用 \n\nAに5/20からご入居の初期費用例 \n\n日割り賃料32800円÷31×12=12700円 デポジット30000円 計42700円 \n\nそれ以外にかかる費用は一切ございません。';
    assert.ok(proseInitialOnly(t)?.sentence.endsWith('それ以外にかかる費用は一切ございません'));
    assert.equal(proseInitialOnly('家賃は45,000円です。\nそれ以外にかかる費用は一切ございません。'), null, '前面不是初期費用的清單');
    assert.equal(proseInitialOnly('初期費用例\n日割り賃料12700円 鍵交換代16500円\nそれ以外にかかる費用は一切ございません。'), null, '清單裡有認不得的項目');
  });
  test('「毎月の支払いは…のみ」：清單只認房租、共益費、水電、網路；括號裡的句號不切句（3163、3399）', () => {
    const r = proseMonthlyOnly('【毎月かかる費用】は「賃料」＋「水道光熱費（実費。公平に案分。1カ月7000円～10000円が目安）」のみ。');
    assert.equal(r?.list, '「賃料」＋「水道光熱費（実費。公平に案分。1カ月7000円～10000円が目安）」');
    assert.equal(proseMonthlyOnly('👉 毎月のお支払いは、「賃料＋共益費」のみ。')?.conditional, false);
    assert.equal(proseMonthlyOnly('毎月のお支払いは、賃料＋共益費＋保証会社月額のみ。'), null);
  });
  test('說明文寫押金一毛不退（1319 房間備考）', () => {
    assert.ok(proseDepositNoRefund('１Kタイプの家具家電付きアパート。光熱費は個人契約。※退室時、保証金返金はなし。') !== null);
    assert.equal(proseDepositNoRefund('保証金は退去時に全額返金します。'), null);
  });
  test('保證費：金額後括號另寫續約年費 → 前面那筆是入居時付的（4284、1844、1264）；【初期費用】小標下的「保証会社加入必須」也算', () => {
    assert.equal(proseGuarantorFee('・家賃保証会社：10,000円（毎年更新：10,000円～15,000円）')?.kind, 'stated');
    assert.equal(proseGuarantorFee('・家賃保証会社:(家賃+共益費∔駐輪場)80％（次年度より保証委託料10,000円/年）')?.kind, 'stated');
    assert.equal(proseGuarantorFee('【初期費用】契約事務手数料 50,000円（税別）、保証金30,000円、家財保険7,500円（1年間）、保証会社加入必須')?.kind, 'stated');
    assert.equal(proseGuarantorFee('保証会社利用￥10000／年')?.kind, 'mentioned', '只寫年費');
    assert.equal(proseGuarantorFee('保証会社：総賃料の50％～')?.kind, 'mentioned', '沒寫時點');
    assert.equal(proseGuarantorFee('・保証料月額（保証会社）：1,830円')?.kind, 'mentioned', '月付');
  });
});

describe('第三十三輪驗證後的修正', () => {
  test('「契約費」是契約手数料的寫法；「契約費用」是費用總稱、「再契約費」是再簽約，不算', () => {
    assert.ok(proseFeeAmounts('契約費30,000円').contractFee !== undefined);
    assert.equal(proseFeeAmounts('契約費用は30,000円です').contractFee, undefined);
    assert.equal(proseFeeAmounts('再契約費30,000円').contractFee, undefined);
  });
  test('「携行品保証料（初回）9,600円」→ 其他初期費用；再契約清單沒寫（初回）的不收', () => {
    assert.ok(proseFeeAmounts('④携行品保証料（初回）9,600円（非課税）').otherInitial !== undefined);
    assert.equal(proseFeeAmounts('②携行品保証料9,600円（非課税）～').otherInitial, undefined);
    assert.equal(proseFeeAmounts('④携行品保証料（初回）9,600円（非課税）').fireInsurance, undefined);
  });
  test('「保証会社・家財保険必須」→ 火災保険明寫要付；任意加入不算', () => {
    assert.ok(proseFeeAmounts('退去時清掃費15,000円 / 保証会社・家財保険必須 / 定期借家契約').fireInsurance !== undefined);
    assert.equal(proseFeeAmounts('家財保険任意').fireInsurance, undefined);
  });
});

describe('第三十四輪驗證後的修正', () => {
  test('「共益費12000円で、ガス、電気、水道、無線LAN」→ 水電、網路含在共益費；列舉沒有水道就不算水電全含', () => {
    assert.equal(proseUtilities('共益費12000円で、ガス、電気、水道、無線LAN、スカパー（リビングのみ）')?.basis, 'included');
    assert.equal(proseInternet('共益費12000円で、ガス、電気、水道、無線LAN、スカパー（リビングのみ）')?.kind, 'included');
    assert.equal(proseUtilities('共益費12000円で、ガス、電気、無線LAN'), null);
    assert.equal(proseUtilities('共益費12000円で、家具家電付き'), null);
  });
});

