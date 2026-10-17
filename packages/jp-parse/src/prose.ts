/**
 * 物件自己的說明文裡「明寫免收」的初期費用（礼金／仲介手数料／契約手数料）。
 *
 * 為什麼要讀說明文：share house 聚合站（Tokyo Sharehouse、ひつじ）沒有這幾項的結構化欄位，
 * 運營者卻常在物件說明裡寫「礼金・仲介手数料・契約事務手数料はかかりません」。
 * 存成「此來源不公開這個欄位」等於對著一句明寫的話說「沒寫」——2026-10-17 驗證幫手抓到多筆。
 *
 * 為什麼只收「免收」、不收金額：說明文裡的金額幾乎都帶條件——稅別、活動期限、
 * 「３カ月以上入居条件」、房型差異（實測「(シェアハウスタイプ)礼金1か月 ・(マンションタイプ)敷金礼金1か月ずつ」）。
 * 抓成數字就是製造假精確度。「免收」這種斷言只有在前後文沒有任何條件字眼時才採用：
 * 前 200 字／後 120 字內出現「キャンペーン」「条件」「場合」「６ヶ月以上」「限定」「※」
 * 或 ①② 這種方案編號，就整句放棄（寧可漏，不可錯）。不只看單句，是因為實測
 * 「敷金、礼金、保証金無料! 事務手数料、保険義務もなし！(３カ月以上入居条件)」——
 * 條件寫在兩句之後；「①敷金・礼金なしの共益費込みで38,750円~」則是方案之一。
 *
 * 敷金／保証金刻意不在這裡處理：各站都有結構化的保証金欄，說明文的「敷金0」
 * 與結構化的保証金是不是同一筆錢，只看一句話判不出來。
 */

export type ProseFeeKey = 'keyMoney' | 'agencyFee' | 'contractFee' | 'fireInsurance' | 'keyExchangeFee';

/** 費用名詞。順序重要：長的先比，免得「仲介手数料」被「手数料」吃掉。 */
// 「再契約事務手数料」「解約事務手数料」要整個吃進去：只吃「契約事務手数料」那段的話，
// 前面的「再」就落在比對範圍外，TERM_OF 的否定後顧看不到它，續約手續費的免收會被當成入居時的契約手續費。
// 「契約時事務手数料」（TSH 2807，沒有の）、「契約料」（862「契約料:¥16,500」）、「契約金」（288）：2026-10-17 第十二輪驗證抓到的寫法
// 「入館料」「入居金」「施設利用料」（第三十一輪 TSH 113「敷金、礼金、仲介料、保証金、入館料、全てなしなし」）：清單裡夾著它們時整串照接
const ITEM = String.raw`(?:再契約事務手数料|再契約時事務手数料|再契約手数料|再契約料|解約事務手数料|解約手数料|更新事務手数料|契約時の?事務手数料|契約事務手数料|契約手数料|契約料|契約費(?!用)|契約金|入館料|入居金|施設利用料|仲介手数料|仲介料|事務手数料|更新手数料|更新料|手数料|礼金|敷金|保証金|保証料|保証人|鍵交換(?:費用?|代)?|鍵(?:の)?(?:発行)?手数料|鍵設定(?:費|料)?|鍵代|火災保険料?|家財保険料?|保険料|保険義務|消費税)`;
const SEP = String.raw`(?:[・、,，/／\s]|や|と|および|及び)`;
// 『』「」：TSH 2142「『敷金・礼金・更新料・保険料・消費税等』は不要です」
const GLUE = String.raw`(?:[\s・、：:『』「」]|は|も|が|全て|すべて|一切|など|等|ともに|共に)*`;
const ZERO = String.raw`(?:【\s*)?(?:無料|なし|無し|不要|ゼロ|0円|０円|ございません|かかりません|頂きません|いただきません|必要ありません|ありません|いりません|[0０](?![0-9０-９.,．万円かヶヵ]))`;
// 條列裡夾著不是費用名詞的項目（ひつじ 北千住龍田町「WI-FI、火災保険、管理費共用費すべて無料」）也照接下去；
// 取出的片段只有費用名詞會對上 TERM_OF，管理費／網路本身不會因此變 0
const LISTABLE = String.raw`(?:${ITEM}|管理費|共益費|共用費|共有費|Wi-?Fi|WI-?FI|WiFi|ＷｉＦｉ|インターネット|ネット)`;
const ZERO_LIST = new RegExp(`(${LISTABLE}(?:${SEP}*${LISTABLE})*)${GLUE}${ZERO}`, 'g');

/**
 * 條件字眼分兩類，看的範圍不同（2026-10-17 第二輪驗證後拆開）：
 *
 * CAMPAIGN（活動／方案）：出現在免收句前 200／後 120 字內就放棄——TSH 的活動標題常在四行之前
 *   （「☆★キャンペーン 割引中☆★ ↓↓↓ … 敷金、礼金不要！」）。
 *   「女性限定」「男性限定」講的是招募對象，不是活動，不算。
 * LOCAL（附帶條件）：只看免收句前 40／後 60 字——「(３カ月以上入居条件)」「※2年契約の場合」
 *   都緊跟在免收句後面。放到 200 字窗口會被無關的句子誤殺：TSH 4310 的「その他入居条件：日本語…」
 *   （那是標題）、2142 在 174 字前的「夏季・冬季は…となる場合があります」（講水電分攤）。
 *   「入居条件／賃貸条件」這種標題不算；「末まで」要帶月份（「入居日から月末までの日割り」不是活動期限）。
 * ※／＊ 註腳：只有註腳本身講到費用或帶條件字眼才算（2142 的「＊ デポジット＝一時預かり金的な性質です」不算）。
 * 「以上」「まで」只在帶數字時才算條件：「６ヶ月以上」「9/30まで」是條件，
 * 「それ以上」「新宿まで電車8分」不是。
 */
const CAMPAIGN = new RegExp([
  // 「オフ」只認接在金額後面的（「通常家賃より5,000円オフ」「初月賃料が50%オフ」「事務手数料¥10,000オフ」）：
  // 「都会の中でオンオフを分けて」（TSH 4394，擋掉同段的「敷金・礼金・仲介手数料0円」）「オフの日」「ブックオフ」不是活動
  // 「6名限定のアットホームなシェアハウス」（TSH 4513，第二十八輪）講的是住戶數，不是活動
  'キャンペーン', '期間限定', '(?<!女性|男性|女子|男子|社会人|学生|[0-9０-９]\\s*(?:名|人|室|部屋))限定', '割引', '半額', 'OFF', 'ＯＦＦ', '(?<=[0-9０-９%％円万]\\s*)オフ', '先着',
  '今なら', '今だけ', '特典',
  // 「プラン」：「※ご契約プランは1年または2年からお選びいただけます」（TSH 4394，講合約年限）、「住戸プランは2タイプから選べます」
  // （4321，講格局）不是活動；「プランドール池尻大橋」（504，建物名）「プランター」「エアプランツ」是別的字。
  // 「短期3ヶ月間の入居プラン」「入居者だけの特別プラン」「2年契約プランなら…」照舊算
  '(?<!住戸|間取り?)プラン(?![ドタツナ])(?<!契約プラン(?=は[^。]{0,20}?(?:お選び|選べ|選択)))',
  // ①② 只有後面緊接費用／優惠字眼才是方案編號（「①敷金・礼金なしの共益費込みで38,750円~」）；
  // 「★★BeGoodを表す3つの単語★★①管理力 ②清潔さ」是品牌條列（TSH 2427，曾擋掉「電気ガス水道…料金内に含まれ」）
  '[①-⑳](?=[^①-⑳。]{0,14}?(?:無料|割|円|[0０]|なし|無し|不要|OFF|ＯＦＦ|オフ|半額|プレゼント|フリーレント|込))',
].join('|'));
const LOCAL = new RegExp([
  // 「緊急連絡先に２親等以内の方を指定」（TSH 2196）是親屬範圍，不是條件
  '(?<!入居|賃貸|契約|募集|その他|ご|お)条件', '場合', '当日', '(?<!親等)以内', '除く', 'ただいま', '只今', '現在', '期限',
  '(?:[0-9０-９]+\\s*月|今月|来月|年度)末まで',
  '[0-9０-９一二三四五六七八九十]+\\s*(?:[ヶかカヵケ]?月|年|日|名|人|歳|才|万?円)?以上',
  '[0-9０-９]+\\s*[月日/／][^。、\\s]{0,6}まで',
].join('|'));
const MARKER = /[※*＊]/g;
const MONTHLY_FEE = /月額|毎月|月々|月払|[/／]\s*月(?!分)|[（(]\s*月\s*[）)]|円\s*\/\s*月/;
const OPTIONAL_FEE = /任意|希望者|希望の方|ご希望|オプション/;
/** 同一份說明文裡，這項費用有沒有任何一處寫成月費。 */
function monthlyAnywhere(ss: readonly string[], term: string, value: string): boolean {
  return ss.some((t) => {
    const m = new RegExp(`(?:${term})([^。]{0,25}?)${value}`).exec(t);
    return m !== null && MONTHLY_FEE.test(t.slice(m.index, m.index + m[0].length + 8));
  });
}
// 「家財保険…もハウス負担」（TSH 2699）「火災保険…はハウスが負担します」（3163）：營運方出也算
const OWNER_PAYS = /(?:全部|全て|すべて)?\s*(?:オーナー|大家|貸主|家主|ハウス|当社|弊社|運営会社|管理会社)(?:様|さん|側)?\s*(?:の|が)?\s*(?:費用)?\s*(?:ご)?負担/;
const MIN_TERM = /(?:最短|最低)\s*(?:の)?\s*(?:契約|入居)?期間|契約期間は?\s*(?:最短|最低)/;
const ITEM_RE = new RegExp(ITEM);
const FOOTNOTE_CONDITION = new RegExp(`${ITEM}|${CAMPAIGN.source}|${LOCAL.source}`);
const CONDITION = new RegExp(`${CAMPAIGN.source}|${LOCAL.source}|[※*＊]`);
const UTIL_FOOTNOTE = new RegExp(`ライフライン|水道|光熱|電気|ガス|${CAMPAIGN.source}|${LOCAL.source}`);

/** 句子裡有金額的樣子（數字、月數、半額）。 */
const AMOUNT_LIKE = /[0-9０-９]|半額|[かヶヵカケ]月|万円/;

const TERM_OF: Record<ProseFeeKey, RegExp> = {
  keyMoney: /礼金/,
  agencyFee: /仲介手数料|仲介料/,
  // 「再契約手数料」「解約事務手数料」「更新事務手数料」不是入居時的契約手續費
  // 第十七輪：「事務手数料：11,000円/入居時（税込）」（3599，入居時寫在後面）、房間備考「敷金30000円、火災保険11000円、
  // 事務手数料賃料1ヶ月」（3989，與入居費用並列）也算；寫成月費的「事務手数料：990円/月」（3477）由 proseFeeAmounts 的月費防線擋
  // 沒寫「契約」的「事務手数料」只在入居時的脈絡才算：「③事務手数料（初回）22,000円」（TSH 228，在【初回契約時費用】下）、
  // 「初期費用は…保証金(3万円)、事務手数料（1万円プラス税）」（2580）。「再契約時は事務手数料…かかりません」不算
  // 第三十二輪：「内見当日のお申し込みの方限定！事務手数料￥20,000円→タダ！」（783）「ご新規のお申込の方に限り事務手数料33,000円が0円」——申込也是入居時的脈絡
  // 2026-10-17 第十六輪起也讀火災保険與鍵交換（站上沒有欄位，原本一律「此來源不公開」——但說明文常寫「火災保険料 8,000円」
  //「鍵交換代 11,000円」，同 round 11 的契約手数料：明寫要付卻標不公開，初期費用會被誤排進「完整」區）
  fireInsurance: /火災保険|家財保険|借家人賠償(?:責任)?保険|住宅(?:総合)?保険|(?<!保証)保険料|(?<!保証)保険(?:の)?費用|保険義務|保険加入/,
  // 「鍵交換代18,000円（税抜）、保証人なしの場合…」（TSH 282）：名詞要吃掉「代／費用」，金額才算緊接（否則落到隔字規則、被句尾的「なし」擋掉）
  keyExchangeFee: /鍵(?:の)?交換(?:費用?|代|料)?|カギ交換(?:費用?|代)?|キー交換|鍵(?:の)?(?:発行)?手数料|鍵発行(?:費|代)|鍵代|鍵設定(?:費|料)?/,
  contractFee: /(?<![再解])契約(?:事務)?手数料|(?<![再解])契約時の?事務手数料|(?<![再解新])契約(?:料|費(?!用))|(?<!再契約|再契約時|解約|更新)事務手数料(?=\s*[（(]\s*初回)|(?<=(?:初期費用|初回|入居時|(?<!再)契約時|(?<!再契約の?お?|更新の?お?)お?申し?込み?)[^。]{0,40}?)(?<!再契約|再契約時|解約|更新|再契約時は|再契約は)事務手数料|(?<!再契約|再契約時|解約|更新|再契約時は|再契約は)事務手数料(?=[^。]{0,25}?(?:入居時|契約時|初回|初期費用))|(?<=(?:敷金|保証金|デポジット|火災保険|家財保険)[^。]{0,40}?)(?<!再契約|再契約時|解約|更新|再契約時は|再契約は)事務手数料|(?<!再契約|再契約時|解約|更新|再契約時は|再契約は)事務手数料(?=[^。]{0,40}?(?:敷金|保証金|デポジット|火災保険|家財保険))/,
};

/**
 * 不同區塊（物件介紹／note／房間備考／入居条件）接成一段文字時用的分界。判條件的前後文窗口不跨區塊：
 * 2026-10-17 第二十八輪 TSH 2428 介紹文最後一句「「家財保険」と「借家人賠償保険」をハウス負担」，
 * 被 60 字後房間備考的「条件付きで54,800円」（講房租）判成附條件。
 */
export const BLOCK_BREAK = '\u2029';

export function proseSentences(text: string): string[] {
  return text
    // <br> 斷在句子中間（TSH 2906「手数料も礼金も…全部オーナー様の<br>ご負担ですよ☆」）：行尾是格助詞、
    // 下一行不是條列記號或數字開頭，就接回同一句
    .replace(/(?<=[^\s。！!？?★☆■□◆◇●○][のがをにはとも])[ \t\r]*\n\s*(?=[^\s※*＊・■□◆◇●○★☆【\[［(（0-9０-９①-⑳\-ー－─━╭╰▼▽→⇒])/g, '')
    // 「空白＋※」是同一行裡的下一個條列（TSH 4027「…（返還なし） ※敷金、礼金…ありません」），
    // 記號留在新句句首；緊貼在字後面的「礼金0円※」是註腳指標，不切
    // 「…ペット可 / 子供・生活保護不可」（TSH 3481）：前後帶空白的半形斜線是條列分隔；「9/30」「1R/1K」不帶空白，不切
    // 括號裡的「●●」是「某某」的佔位寫法，不是條列記號（TSH 1532「「●●手数料」「●●保証料」「●●保険」等の費用は請求しません」，
    // 第三十輪）：先換成私用字元免得被切開，切完再換回
    .replace(/(?<=[「『])[●○]{2,}/g, (m) => '\uE001'.repeat(m.length))
    .split(/[。！!？?\n\u2029★☆■□◆◇●○＼／]+|\s+(?=[※*＊])|\s+\/\s+/)
    .map((s) => s.replace(/\uE001/g, '●').replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}

/**
 * 判條件用的前後文：免收句之前 200 字、之後 120 字（跨行）。
 * 用字數而不是「同一行」：Tokyo Sharehouse 的說明文每句各佔一行（<br>），活動區塊長這樣——
 *   「☆★キャンペーン 割引中☆★ ↓↓↓ 初月賃料は10,000円のみ！ 6ヶ月から入居可能です。 敷金、礼金不要！」
 * 標題在四行之前；只看同一行會把活動條款當成常態收費。反過來，ひつじ的說明文整篇一行，
 * 只看同一行會被八百字外的無關字眼誤殺。
 */
const BEFORE = 200;
const AFTER = 120;
const LOCAL_BEFORE = 40;
const LOCAL_AFTER = 60;

/**
 * 原狀回復的但書：「※ただし、壁に穴を開けた、タバコを吸った等の場合は修復にかかる実費を請求」（TSH 4027）。
 * 講的是退租時的損壞求償，不是入居費用免收的條件——它的「場合」不該讓旁邊的「敷金、礼金…ありません」作廢。
 * 只認沒提費用名詞、沒有活動字眼、沒有期間數字的句子（「6ヶ月以内の退去・破損の場合」照舊算條件）。
 */
function isDamageClause(t: string): boolean {
  return /破損|汚損|毀損|修復|修繕|原状回復|故意|過失|穴を開け|タバコ|喫煙/.test(t)
    && !ITEM_RE.test(t) && !CAMPAIGN.test(t) && !/[0-9０-９]/.test(t);
}

/**
 * 入居資格的條列（TSH 3921「■18歳以上の方」）：講的是住客年齡，不是旁邊「共益費電気・ガス・水道…」的條件。
 * 只認沒提費用名詞、水電詞、活動字眼、免收／含入字眼與金額的句子（「25歳以下の方は礼金無料」照舊算條件）。
 */
function isEligibilityClause(t: string): boolean {
  return /[0-9０-９]+\s*(?:歳|才)/.test(t) && !ITEM_RE.test(t) && !CAMPAIGN.test(t)
    && !/水道|光熱|電気|ガス|ライフライン|無料|円|込|含|免除|不要|なし|無し/.test(t);
}

type SentenceContext = { s: string; context: string; local: string; footnotes: string[] };

/** 【】［］〔〕＜＞ 小標開頭的句子：一段新內容的標題。 */
const SECTION_HEAD = /^[\s・]*[【［\[〔＜<]/;
/** 只講某一項費用的活動句（恰好一個費用名詞、而且這句沒提到它）：「★仲介手数料 半額キャンペーン中」。講初期費用、全部、等等的不算。 */
function feeScopedCampaign(t: string, s: string): boolean {
  if (!CAMPAIGN.test(t) || /初期費用|入居費用|すべて|全て|全部|など|等/.test(t)) return false;
  const items = new Set([...t.matchAll(new RegExp(ITEM, 'g'))].map((m) => m[0]));
  // 只講房租的活動（「★期間限定フリーレント1ヶ月★」）不放行：TSH 2531 緊接一行「★うれしい敷金・礼金０★」，
  // 讀不出那是常態還是同一波活動（第三十二輪曾放行，複查時收回；1575 的網路因此維持「頁面有提到、未採用」）
  if (items.size !== 1) return false;
  const [it] = [...items];
  return it !== undefined && !s.includes(it);
}

/**
 * 條列裡講別的費用的一項（「・６ヶ月未満で退去の場合：短期解約手数料５万円」，TSH 3392，第三十輪）：它的「場合」講的是那筆費用，
 * 不是同一串條列裡「・住宅保険料：不要 ・鍵発行手数料：不要」的條件。只認以條列記號開頭、提到費用名詞、而且這些名詞這句都沒提的。
 */
function otherFeeBullet(t: string, s: string): boolean {
  if (!/^[・■□◆◇●○※*＊\-ー]/.test(t)) return false;
  const items = [...t.matchAll(new RegExp(ITEM, 'g'))].map((m) => m[0]);
  return items.length > 0 && items.every((it) => !s.includes(it));
}

function sentencesWithContext(text: string): SentenceContext[] {
  if (text.includes(BLOCK_BREAK)) return text.split(BLOCK_BREAK).flatMap((b) => sentencesWithContext(b));
  const ss = proseSentences(text);
  const flat = ss.join(' ');
  const starts: number[] = [];
  let pos = 0;
  for (const s of ss) { starts.push(pos); pos += s.length + 1; }
  return ss.map((s, i) => {
    const a = starts[i] ?? 0;
    const b = a + s.length;
    const lo = Math.max(0, a - LOCAL_BEFORE);
    const hi = b + LOCAL_AFTER;
    // 只講某一項別的費用的活動句，以及緊接其後、補充那個活動的註腳（不提費用名詞，例「※割引は６ヵ月以上ご契約の場合適用されます」，
    // 第三十二輪）：講的是那個活動，三個窗口都不算這句的條件
    const scoped = new Set<number>();
    for (let j = 0; j < ss.length; j++) {
      const t = ss[j] ?? '';
      const ta = starts[j] ?? 0;
      if (j === i || ta + t.length < a - BEFORE || ta > b + AFTER) continue;
      if (feeScopedCampaign(t, s)) scoped.add(j);
      else if (scoped.has(j - 1) && /^[※*＊注]/.test(t) && !ITEM_RE.test(t)) scoped.add(j);
    }
    // 附帶條件看的窗口：單獨講最短租期、沒提任何費用的句子不算（TSH 4472「最短契約期間は6ヶ月以上となります」
    // 緊接在「敷金礼金保証金一切なし」後面——那是另一件事，不是免收的條件）
    const localParts: string[] = [];
    ss.forEach((t, j) => {
      const ta = starts[j] ?? 0;
      if (ta + t.length < lo || ta > hi) return;
      if (j !== i && MIN_TERM.test(t) && !ITEM_RE.test(t)) return;
      if (j !== i && (isDamageClause(t) || isEligibilityClause(t) || otherFeeBullet(t, s) || scoped.has(j))) return;
      localParts.push(t.slice(Math.max(0, lo - ta), Math.max(0, hi - ta)));
    });
    // 窗口內每個 ※／＊ 的註腳文字：記號後到句尾；記號單獨成句（「礼金0円※」）就接下一句
    const footnotes: string[] = [];
    ss.forEach((t, j) => {
      const ta = starts[j] ?? 0;
      if (ta + t.length < lo || ta > hi) return;
      if (j !== i && (isDamageClause(t) || isEligibilityClause(t) || scoped.has(j))) return;
      for (const m of t.matchAll(MARKER)) {
        // 句首的 ※ 是條列記號，不是指向別處的註腳——句子不會是自己的條件
        //（TSH 4027「※敷金、礼金、更新料、事務手数料などはありません」曾因自己提到費用而被判成附條件）
        if (j === i && (m.index ?? 0) === 0) continue;
        const at = ta + (m.index ?? 0);
        if (at < lo || at > hi) continue;
        let note = t.slice((m.index ?? 0) + 1);
        if (note.trim().length < 4) note += ` ${ss[j + 1] ?? ''}`;
        footnotes.push(note);
      }
    });
    // 活動前後文：後面出現【】小標就是另一段開始了（866「お部屋でWi-Fiが無料で利用できます」之後才是「【キャンペーン情報】」）；
    // 只講某一項別的費用的活動（2531「★仲介手数料 半額キャンペーン中」）不是這句的條件（第二十九輪）
    const clo = a - BEFORE;
    const chi = b + AFTER;
    const cparts: string[] = [];
    for (let j = 0; j < ss.length; j++) {
      const t = ss[j] ?? '';
      const ta = starts[j] ?? 0;
      if (ta + t.length < clo) continue;
      if (ta > chi) break;
      if (j > i && SECTION_HEAD.test(t)) break;
      if (scoped.has(j)) continue;
      cparts.push(t.slice(Math.max(0, clo - ta), Math.max(0, chi - ta)));
    }
    return {
      s,
      context: cparts.join(' '),
      local: localParts.join(' '),
      footnotes,
    };
  });
}

/**
 * 活動字眼看大窗口、附帶條件看前 40／後 60 字、註腳看內容（見 CAMPAIGN／LOCAL）。
 * 註腳要講到「同一類」東西才算：費用句看費用名詞，水電句看水電詞（UTIL_FOOTNOTE）——
 * TSH 4027 的條列「※水道光熱費、インターネット代込みです ※敷金、礼金…ありません」是並列的兩件事。
 */
function isConditional(c: SentenceContext, footnoteRe: RegExp = FOOTNOTE_CONDITION): boolean {
  return CAMPAIGN.test(c.context) || LOCAL.test(c.local) || c.footnotes.some((f) => footnoteRe.test(f));
}

/**
 * 回傳每個欄位「明寫免收」的那一句原文。找不到、或句子帶條件，就不會出現在結果裡。
 * 同一欄位只要有任何一句帶金額或條件地提到它（例「仲介手数料 賃料の0.5か月」），
 * 就不採用免收句——兩句說法並存時不替原站挑一個。
 */
export function proseZeroFees(text: string): Partial<Record<ProseFeeKey, string>> {
  // 第三十輪起舊欄位也用 ZERO_LIST_X：「★その他、諸経費・再契約手数料・鍵交換費用などの費用は頂戴しません！」（TSH 492）
  // 原本因「頂戴しません」「などの費用は」不在舊清單裡而漏判鍵交換費。
  //「「●●保険」等の費用は請求しません」（1532）：泛稱的保險費全免，同 2906「保険の費用も全部オーナー様のご負担」算火災保険 0
  return zeroStatements(text, TERM_OF, ZERO_LIST_X, placeholderSpans);
}
const placeholderSpans = (s: string): string[] => (placeholderWaived(s).includes('保険') ? ['保険の費用'] : []);

/** 寫了免收但沒採用的理由：conditional＝附近有條件或活動字眼；contested＝頁面另一處帶金額或條件地提到同一項費用。 */
export type UnadoptedZero = { sentence: string; reason: 'conditional' | 'contested' };

/**
 * 寫了免收、但沒採用的句子（第三十輪 TSH 492「★その他、諸経費・再契約手数料・鍵交換費用などの費用は頂戴しません！」
 * 前面是「デポジット2万円→今なら無料」「※入居のタイミングによっては…場合あり」；3392「・住宅保険料：不要」與
 *「光熱水等費16,000円 ※…家財保険が含まれています」並存）。值照舊未知，呼叫端用它把「此來源不公開」改成
 *「頁面有提到、未採用」——頁面明明談到了這筆費用。
 */
export function proseUnadoptedZeroFees(text: string): Partial<Record<ProseFeeKey, UnadoptedZero>> {
  const out: Partial<Record<ProseFeeKey, UnadoptedZero>> = {};
  zeroStatements(text, TERM_OF, ZERO_LIST_X, placeholderSpans, out);
  return out;
}

/**
 * 「敷金…なし」的明寫句。檔頭說過敷金不在這裡處理（各站都有結構化保証金欄，說明文的敷金 0 與保証金
 * 是不是同一筆錢判不出來）——這個函式只給「結構化保証金欄空白」的呼叫端用（TSH 4027：保証金欄空白，
 * 備考寫「※敷金、礼金、更新料、事務手数料などはありません」）。說明文另處只要帶金額或條件提到
 * 敷金／保証金／デポジット／預り金，就不採用。
 */
export function proseZeroDeposit(text: string): string | null {
  return zeroStatements(text, { deposit: /敷金|保証金|デポジット|預か?り金/ }).deposit ?? null;
}

/**
 * zeroList：第二十五輪新增的欄位（保証料、更新、清掃）用 ZERO_LIST_X，接得下「…などの費用は一切請求いたしません」；
 * 第三十輪起舊欄位（礼金等）也改用它（proseZeroFees）。押金（proseZeroDeposit）維持原本的 ZERO_LIST。
 * unadopted：有給就收「寫了免收、但沒採用」的句子與理由（proseUnadoptedZeroFees）。
 */
function zeroStatements<K extends string>(
  text: string, terms: Record<K, RegExp>, zeroList: RegExp = ZERO_LIST, extraSpans?: (s: string) => string[],
  unadopted?: Partial<Record<K, UnadoptedZero>>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  const zeroHit = new Map<K, string>();
  const otherMention = new Set<K>();

  for (const c of sentencesWithContext(text)) {
    const { s } = c;
    const conditional = isConditional(c);
    // extraSpans 給的是換過說法的名詞（「「●●保険」等の費用」→「保険の費用」），句子本身不一定對得上費用名詞
    const extra = extraSpans === undefined ? [] : extraSpans(s);
    const spans: string[] = [];
    for (const m of s.matchAll(zeroList)) if (m[1] !== undefined) spans.push(m[1]);
    spans.push(...extra);
    // 「手数料も礼金も鍵交換代も保険の費用も全部オーナー様のご負担ですよ」（TSH 2906）：屋主負擔＝住客不付。
    // 只認緊接在前的那一段（讀點、逗號、空白為界）——「礼金1ヶ月、鍵交換代はオーナー負担」的礼金不算
    const o = OWNER_PAYS.exec(s);
    if (o !== null) {
      const before = s.slice(0, o.index);
      const cut = Math.max(-1, ...[...before.matchAll(/[、，,\s]/g)].map((x) => x.index ?? -1));
      const seg = before.slice(cut + 1);
      spans.push(seg);
      // 主題與「負担」之間只隔一個讀點或理由子句（第三十一輪 TSH 2314「＊高額となる家財保険・借家人賠償保険は、オーナーが負担します」、
      // 2493「万が一の時の為の火災保険、家財保険、賠償保険は高額になる為、ハウス負担」）：緊接的那一段是空的，負擔的對象是「…は」的主題。
      // 主題從後往前只收費用名詞（不帶金額）——「礼金1ヶ月、火災保険は、オーナー負担」的礼金不算
      if (seg.trim() === '') {
        const topic = /([^。]*?)(?:は|も)(?:[^。、]{0,20}?(?:為|ため|ので))?[、,，]?\s*$/.exec(before)?.[1] ?? '';
        const items = topic.split(/[、，,・]/);
        let from = items.length;
        while (from > 0 && /保険|保証料|手数料|礼金|敷金|鍵/.test(items[from - 1] ?? '') && !AMOUNT_LIKE.test(items[from - 1] ?? '')) from -= 1;
        if (from < items.length) spans.push(items.slice(from).join('・'));
      }
    }
    const zeroSpans = conditional ? [] : spans;
    for (const key of Object.keys(terms) as K[]) {
      if (!terms[key].test(s) && !extra.some((span) => terms[key].test(span))) continue;
      if (zeroSpans.some((span) => terms[key].test(span))) {
        if (!zeroHit.has(key)) zeroHit.set(key, s);
      } else if (conditional || AMOUNT_LIKE.test(s)) {
        // 帶金額或條件地提到同一項費用：與免收句並存時不替原站挑一個。
        // 只是泛稱（「一般賃貸では、敷金・礼金や仲介手数料など…費用がかかります」）不算。
        // 附近有活動字眼、但本身就是同一項的免收句且不帶金額（第三十一輪 TSH 2314 介紹文與 note 各寫一次
        //「家財保険・借家人賠償保険は、オーナーが負担します」，介紹文那次緊接「家賃半額キャンペーン」）：兩處都說不收，不算另一種說法
        const zeroInCond = conditional && spans.some((span) => terms[key].test(span));
        if (!zeroInCond || AMOUNT_LIKE.test(s)) otherMention.add(key);
        if (zeroInCond && unadopted !== undefined) unadopted[key] ??= { sentence: s, reason: 'conditional' };
      }
    }
  }

  for (const [key, s] of zeroHit) {
    if (!otherMention.has(key)) out[key] = s;
    else if (unadopted !== undefined && unadopted[key] === undefined) unadopted[key] = { sentence: s, reason: 'contested' };
  }
  return out;
}

/**
 * 說明文對某項費用直接寫了非 0 金額的那一句（「契約手数料：40,000円」「礼金：賃料1ヶ月分」「仲介手数料 賃料の0.5か月」）。
 * 金額本身照樣不採用（理由見檔頭）；呼叫端用它把「此來源不公開」改成「原站明寫要付、金額未採用」——
 * 2026-10-17 第十一輪驗證：TSH 2800 說明文寫「契約手数料 … 個室・相部屋：40,000円」，我們卻標「此來源不公開」，
 * 初期費用因此被排進「完整」區。
 * 只認費用名詞**緊接**金額的寫法：「敷金・礼金・仲介手数料0円 … 火災保険料（月額￥700）」的 ￥700 不是仲介費，
 * 「…＋契約事務手数料 初回6ヶ月契約の場合 ¥11,000」中間隔著方案條件，也不認（漏標只是維持舊標籤）。
 */
export type ProseAmountKey = ProseFeeKey | 'otherInitial';

// 「５５，０００円」：全形逗號（TSH 288）
const VALUE = String.raw`(?:[1-9][0-9,，.]*\s*万円|[1-9][0-9,，]*\s*円|[￥¥]\s*[1-9]|(?!0(?:\.0+)?\s*[ヶかカヵケ]?月)\d+(?:\.\d+)?\s*[ヶかカヵケ]?月)`;
const AMOUNT = String.raw`\s*[：:=＝]?\s*(?:[（(]\s*(?:通常)?\s*)?(?:賃料|家賃)?\s*の?\s*${VALUE}`;
// 免收字眼：中間隔著別的字時，整句只要有一個就不認（「仲介手数料は6ヶ月以上の入居で無料」）
// 「礼金：無（礼1の場合賃料-4,000円）」（TSH 228）：單一個「無」也是免收
const ZERO_WORD = /無料|なし|無し|[：:]\s*無|不要|ゼロ|(?<![0-9,])0円|かかりません|ありません|いりません|頂きません|いただきません|免除/;

/** 前一句與這一句原本在同一行（只是被「！」「。」切開）：這一行裡、這一句前面有前一句的結尾。 */
function sameLine(text: string, prev: string, s: string): boolean {
  const t = text.replace(/[ \t\r　]+/g, ' ');
  const j = t.indexOf(s.slice(0, 10));
  if (j < 0 || prev === '') return false;
  return t.slice(t.lastIndexOf('\n', j) + 1, j).includes(prev.slice(-6));
}

/**
 * 費用小標：「初期費用：」「契約時費用：」「入居時費用：」「【初回契約時費用】」之後到句尾都是這張清單——
 * 遇到「┃」就是下一個條件欄了（「…┃初期費用：家賃1ヶ月分＋3万円（…）┃2人入居不可× ┃保証会社利用必須┃」的保證公司不在初期費用裡）。
 */
const COST_HEADER = /(?:初期費用|入居時費用|契約時費用|初回費用|入居時の費用|契約時の費用|初回契約時費用)\s*[】＞>]?\s*[：:][^。┃]*$/;
/** 清單裡的一項：以讀點、逗號（千分位除外）、全形空白、兩個以上空白、┃ 為界——「・」不切（「敷金・礼金・仲介手数料0円」是同一項）。 */
function listItem(s: string, from: number, to: number): string {
  let a = 0;
  for (const m of s.slice(0, from).matchAll(/[、┃　]|[，,](?![0-9])|\s{2,}/g)) a = (m.index ?? 0) + m[0].length;
  const e = s.slice(to).search(/[、┃　]|[，,](?![0-9])|\s{2,}/);
  return s.slice(a, e < 0 ? s.length : to + e);
}

const INITIAL_LUMP = new RegExp(String.raw`初期費用(?!合計|総額|総計|目安|概算|の目安|シミュレーション|試算|例)\s*(?:[（(][^）)]{0,8}[）)])?\s*[＞>】]?\s*(?:[：:]|は|として)?\s*(?:家賃|賃料)?\s*の?\s*(?:${VALUE}|[1-9][0-9.]*\s*万(?![円人]))`);

export function proseFeeAmounts(text: string): Partial<Record<ProseAmountKey, string>> {
  // 「契約金」可能是契約手續費，也可能是初期費用總額（TSH 288「契約金55,000円（税込）」、2021「初回契約時に契約金として40,000円必要」），
  // 分不出來——只說「有一筆契約時要付的錢」，歸到其他初期費用
  // 第十七輪：「初回に入居金16,500円／人」（BeGood 系列）「施設利用料 35,000円（新規契約時のみ)」「入館料3万円」也是入居時一次付的錢，
  // 分不進任何既有欄位——一樣歸其他初期費用。「ベッドパッド・シーツ 3,300円(ベッド利用の場合)」「布団代」常是選配，不收
  // 第三十三輪：「④携行品保証料（初回）9,600円（非課税）」（TSH 228、1864 等 Minoras 系列的【初回契約時費用】）——攜帶物品的保證費，
  // 不是火災／家財保険、也不是保證公司費用（見 NOT_GUARANTOR），歸其他初期費用；【再契約費用】那一條沒寫（初回），不收
  const terms: Record<ProseAmountKey, RegExp> = {
    ...TERM_OF, otherInitial: /(?<![再解新])契約金|入居金|入館料|施設利用料|携行品の?保証料(?=\s*[（(]\s*初回)/,
  };
  // 對比句（「一般的な賃貸では家賃の4〜5ヶ月分の初期費用がかかります」）講的不是這間房
  const GENERIC = /一般|通常の賃貸|普通の賃貸|他社|他の物件|相場/;
  // 同一項費用在好幾句都明寫要付時全部列出（最多 3 句）：TSH 3985「・(シェアハウスタイプ)礼金1か月」「・(マンションタイプ)敷金礼金1か月ずつ」
  // 分房型各寫一行，只引第一句會讓マンションタイプ的房引到別種房型那一行（第二十輪驗證）。
  // 第二句起只收乾淨的佐證：活動句（「内見当日申し込みで初回契約事務手数料：22,000円…が無料」）不當「要付」的證據
  const hits: Partial<Record<ProseAmountKey, string[]>> = {};
  const add = (key: ProseAmountKey, sentence: string): void => {
    const list = hits[key] ?? (hits[key] = []);
    if (list.length > 0 && (CAMPAIGN.test(sentence) || ZERO_WORD.test(sentence))) return;
    if (list.length < 3 && !list.includes(sentence)) list.push(sentence);
  };
  const half = toHalfDigits(text);
  const ss = proseSentences(half);
  ss.forEach((s, i) => {
    if (GENERIC.test(s)) return;
    // 只講某幾間房的（TSH 2746「※A～D号室は部屋はシャワー、トイレ、洗面付き<br>　保険加入必須（12,400円/2年）」）：
    // 不是整棟的費用，套到每間房會把 H 號房也標成要付。要是「〜号室は／のみ／に限り」這種範圍主題才算——
    // 句內有，或上一句有而這一句不是新的條列；「・敷金40,000円(301号室)」下一條「・火災保険¥7,500～」（2807）、
    //「※（201～204号室）2名入居の場合 28,700 円 火災保険 20,000円/2年」（2301）都照讀
    const ROOM_SCOPE = /号室(?:は|のみ|に限り|限定)/;
    if (ROOM_SCOPE.test(s) || (ROOM_SCOPE.test(ss[i - 1] ?? '') && !/^[・■□◆◇●○※*＊★☆【\-ー①-⑳(（]/.test(s))) return;
    for (const key of Object.keys(terms) as ProseAmountKey[]) {
      const term = terms[key].source;
      // 火災保険／鍵交換常寫成月費（「火災保険料（月額￥700）」「保険料 500円/月」）：那不是入居時的一次性費用，
      // 這兩項碰到月費寫法就不標「明寫要付」（維持原標籤）。同頁別處寫成月費也一樣——TSH 3921 摘要行寫
      //「家財保険料500円」，賃貸条件寫「家財保険加入/月額500円」。「鍵交換費用(20000円/任意)」（2903）是選配，也不標
      const newKey = key === 'fireInsurance' || key === 'keyExchangeFee';
      if (newKey && monthlyAnywhere(ss, term, VALUE)) continue;
      // 費用小標下的條列、沒寫金額（866「契約時費用：退去時クリーニング費用、賃貸住宅総合保険」，第二十九輪）：列在要付的清單裡＝明寫要付。
      // 那一項帶免收、月付、選配、條件字眼就不算（「初期費用：敷金・礼金・仲介手数料0円」的礼金是 0）
      const th = new RegExp(term).exec(s);
      if (th !== null && COST_HEADER.test(s.slice(0, th.index))) {
        const it = listItem(s, th.index, th.index + th[0].length);
        if (!ZERO_WORD.test(it) && !MONTHLY_FEE.test(it) && !OPTIONAL_FEE.test(it) && !/場合|条件|キャンペーン|割引|半額|込|含/.test(it)) { add(key, s); continue; }
      }
      // 「初回契約時に契約金として40,000円必要。」下一行「内訳：退去時清掃費30,000円+事務手数料10,000円)」（第三十一輪 TSH 2481、3363）：
      // 那筆錢已拆成各項、各項由自己的欄位讀，不再另記一筆其他初期費用（否則同一筆錢算兩次）
      // 括號直接列組成也一樣（3992、2021 房間備考「契約金40,000円(退去時清掃費+事務手数料)」）
      if (key === 'otherInitial' && th !== null && (/^[（(]?\s*内訳/.test(ss[i + 1] ?? '') || /内訳/.test(s.slice(th.index))
        || new RegExp(`^(?:${term})[^。（(]{0,20}?[（(][^）)]*(?:${ITEM}|${CLEAN_NOUN})`).test(s.slice(th.index)))) continue;
      // 「…内見当日のお申し込みの方限定！事務手数料￥20,000円→タダ！」（783，第三十二輪）：「！」把入居時的脈絡切到上一句——同一行就接回來看
      if (key === 'contractFee' && i > 0 && sameLine(half, ss[i - 1] ?? '', s)
        && /初期費用|初回|入居時|(?<!再)契約時|(?<!再契約の?お?|更新の?お?)申し?込/.test(ss[i - 1] ?? '')
        && new RegExp(`^[^。]{0,4}?(?<!再契約|再契約時|解約|更新)事務手数料${AMOUNT}`).test(s) && !MONTHLY_FEE.test(s)) { add(key, `${ss[i - 1] ?? ''}／${s}`); continue; }
      // 內訳列的「事務手数料10,000円」是上一行那筆初期費用的組成（2481：契約手数料原本因不在同一句而漏標）
      if (key === 'contractFee' && /^[（(]?\s*内訳/.test(s) && /(?<![再解新])契約金|初期費用|初回|入居時/.test(ss[i - 1] ?? '')
        && new RegExp(`(?<!再契約|再契約時|解約|更新)事務手数料${AMOUNT}`).test(s)) { add(key, `${ss[i - 1] ?? ''}／${s}`); continue; }
      const guarded = newKey || key === 'contractFee' || key === 'otherInitial';
      const monthly = (at: number, len: number) => guarded && (MONTHLY_FEE.test(s.slice(at, at + len + 8)) || OPTIONAL_FEE.test(s.slice(at, at + len + 8)));
      // 第二十七輪：「・初期費用：25,000円」（4331）「初期費用1.5万／保証料30％」（4361）「※入居時、初期費用として家賃1ヶ月分かかります（返還なし）」
      //（4027／4028）——總稱的初期費用、沒拆項目，一樣是「有一筆入居時要付的錢」，歸其他初期費用。
      // 「初期費用：事務手数料20,000円」金額前面是別的費用名詞，不算；合計／総額／目安是含押金房租的估算總額，不收；
      // 月費判斷只看金額後面到下一個分隔為止（3547「初期費用31,500円 、月額保証料1,124円」的月額講的是保證料）
      // 已拆項目的不算另一筆：「初期費用:25,000円（礼金1万、初回保証料1.5万）」「初期費用：家賃1ヶ月分＋3万円（契約事務手数料/…）」
      //「初期費用は17,000円（家賃以外） 内訳：退去時清掃費…」；「保証金は初期費用として30,000円のみ」講的是保證金；「期間中のみ初期費用30,000円割引」是活動
      if (key === 'otherInitial') {
        const l = INITIAL_LUMP.exec(s);
        if (l !== null) {
          const rest = s.slice(l.index + l[0].length);
          const clause = rest.split(/┃|\s・|\s{2,}/)[0] ?? '';
          const decomposed = new RegExp(`[（(][^）)]*(?:${ITEM})`).test(clause) || /内訳/.test(clause) || /^[（(]?\s*内訳/.test(ss[i + 1] ?? '');
          const ofItem = new RegExp(`(?:${ITEM})\\s*は\\s*$`).test(s.slice(0, l.index));
          // 同一行被「！」切開的前一句是活動（1408「1年以上のご入居でデポジット無料キャンペーン中！　初期費用6.9万円でご入居できます」，第二十八輪）
          const campaignLine = i > 0 && CAMPAIGN.test(ss[i - 1] ?? '') && sameLine(half, ss[i - 1] ?? '', s);
          if (!decomposed && !ofItem && !campaignLine && !CAMPAIGN.test(s) && !ZERO_WORD.test(l[0]) && !MONTHLY_FEE.test(rest.split(/[、,，\s／]/)[0] ?? '')) { add(key, s); continue; }
        }
      }
      const a = new RegExp(`(?:${term})${AMOUNT}`).exec(s);
      if (a !== null && !monthly(a.index, a[0].length)) { add(key, s); continue; }
      // 「入館料2万」（第三十一輪 TSH 113 note，沒寫「円」）：其他初期費用的名詞緊接「N万」也算
      const man = key === 'otherInitial' ? new RegExp(`(?:${term})\\s*[：:=＝]?\\s*[1-9][0-9.]*\\s*万(?![人件円])`).exec(s) : null;
      if (man !== null && !monthly(man.index, man[0].length)) { add(key, s); continue; }
      // 中間隔著方案條件（TSH 1927「…＋契約事務手数料 初回6ヶ月契約の場合 ¥11,000（税込）・初回3ヶ月契約の場合¥33,000」）：
      // 25 字內接金額、中間不夾別的費用名詞、從費用名詞到句尾沒有免收字眼，才算「明寫要付」
      const g = new RegExp(`(?:${term})([^。]{1,25}?)${VALUE}`).exec(s);
      if (g !== null && !ITEM_RE.test(g[1] ?? '') && !ZERO_WORD.test(s.slice(g.index)) && !monthly(g.index, g[0].length)) { add(key, s); continue; }
      // 必須加保險、沒寫金額（TSH 4414「・火災保険加入必須」、3547「要家財保険加入」）：一樣是明寫要付。
      // 選配（「(4)火災保険任意加入」）與附在保證公司裡的（2282「要火災保険加入（保証会社に付帯）」）不算
      // 「・別途家財保険加入 必須」（2179，第二十七輪）：「加入」和「必須」之間夾一個空白
      // 「保証会社・家財保険必須」（3481，第三十三輪）：沒寫「加入」
      if (key === 'fireInsurance' && /保険(?:への)?加入\s?(?:が)?\s?(?:必須|義務|必要)|要(?:火災|家財|住宅)?保険加入|(?:火災|家財|住宅)保険\s?(?:必須|義務)/.test(s)
        && !/任意|付帯|保証会社に/.test(s) && !ZERO_WORD.test(s)) { add(key, s); continue; }
      // 「家財保険に加入。2年￥5,000。」（TSH 2021 房間備考）：句號把名詞和金額切開——下一句開頭就是金額才接
      if (key === 'fireInsurance' && /保険(?:に|へ)加入(?:して(?:ください|頂きます|いただきます))?$/.test(s) && !/任意|付帯|保証会社/.test(s)) {
        const next = ss[i + 1] ?? '';
        if (new RegExp(`^[^。]{0,8}?${VALUE}`).test(next) && !ZERO_WORD.test(next) && !MONTHLY_FEE.test(next)) { add(key, `${s}／${next}`); continue; }
      }
      // 兩項合計一個金額（TSH 418「・住宅保険料（1年）+鍵発行手数料 13,500円」）：兩項都明寫要付
      const plus = new RegExp(`(?:${term})([^。＋+]{0,12}?[＋+][^。]{0,20}?)${VALUE}`).exec(s);
      if (plus !== null && !ZERO_WORD.test(plus[0]) && !monthly(plus.index, plus[0].length)) { add(key, s); continue; }
      // 總額括號（TSH 3179「初期費用：家賃1ヶ月分＋3万円（契約事務手数料/退去クリーニング費/鍵発行手数料/ベッドパット）」）：
      // 這一項是那筆錢的組成之一——明寫要付，只是沒有單獨金額
      if (new RegExp(`${VALUE}\\s*[（(][^）)]*(?:${term})[^）)]*[）)]`).test(s) && !ZERO_WORD.test(s)) { add(key, s); continue; }
      // 小標寫法（TSH 2800）：「契約手数料」單獨一行，下兩行內才寫「個室・相部屋：40,000円」
      if (new RegExp(`^[・■□◆【\\s]*(?:${term})[】：:\\s]*$`).test(s)) {
        const next = ss.slice(i + 1, i + 3).find((t) => new RegExp(`^[^。]{0,12}?${AMOUNT}`).test(t) && !ITEM_RE.test(t));
        if (next !== undefined) add(key, `${s}／${next}`);
      }
    }
  });
  const out: Partial<Record<ProseAmountKey, string>> = {};
  for (const [key, list] of Object.entries(hits) as Array<[ProseAmountKey, string[]]>) out[key] = list.join('／');
  return out;
}

/**
 * 說明文直接寫出的押金金額：「・保証金：10,000円(退去時50%＋消費税を媒介手数料として償却)」「保証金(60000円)」
 * 「デポジット￥20,000」「(2) デポジット（保証金）20,000円」「保証金1ヶ月分」。金額照樣不採用——呼叫端只用它判斷
 * 入居条件表的押金與說明文是否矛盾（存 conflicting），或表空白時標「原站明寫要付」。
 * 2026-10-17 第十五輪驗證：TSH 357 入居条件表寫「家賃1カ月分」，note 卻寫「保証金：10,000円」，我們只採表值。
 * 只認押金名詞緊接金額；帶條件的句子整句不算——別種房型、別種身分、別種方案的押金不是這間房的：
 * 「外国籍の方は保証金５００００円」「1F・２Fのアパートメントタイプのみ保証金は50,000円」「デポジット ドミトリー20,000円 個室30,000円」
 * 「敷金=家賃1ヶ月分(または30,000円)」「※ペット飼育の場合は保証金2ヶ月分」「デポジット2万円→今なら無料」。
 * 退租時扣多少（「保証金より設備補修費20,000円を精算」「保証金は清掃費として￥20000償却」）不是押金金額，不緊接所以不會中。
 * 鄰句的附帶條件（前 40／後 60 字窗口）不看：別的條件句自己就帶條件字眼，不會被當成押金句；
 * TSH 4043 的押金句前面是「１年以上の長期入居の方はフリーレント適用あり！」，講的是免租，不是押金的條件。
 */
/**
 * 說明文裡用「(〇〇タイプ)」限定房型的條列（TSH 3985「・(シェアハウスタイプ)礼金1か月」「・(マンションタイプ)敷金礼金1か月ずつ」，
 * 房間備考各寫「備考：マンションタイプ、…」）：這間房的備考寫了房型時，別種房型的那幾行不套用（整行拿掉）；
 * 同房型的行原文照留。備考沒寫房型就不動——判不出來，交給各規則原本的條件字眼處理。
 */
const TYPE_SCOPE = /^[\s・■□◆◇●○※*＊\-ー]*[（(【［\[]\s*([^）)】］\]\s]{1,15}?タイプ)\s*[）)】］\]]/;
export function roomTypesOf(remarks: string): string[] {
  return [...remarks.matchAll(/([^\s、，,。・:：（）()【】［］\[\]]{1,12}タイプ)/g)].map((m) => m[1] ?? '').filter((t) => t !== '');
}
export function scopeToRoomTypes(text: string, roomTypes: readonly string[]): string {
  if (roomTypes.length === 0) return text;
  return text.split('\n').filter((line) => {
    const t = TYPE_SCOPE.exec(line)?.[1];
    return t === undefined || roomTypes.includes(t);
  }).join('\n');
}

export function proseDepositAmounts(text: string, roomTypes: readonly string[] = []): Array<{ jpy?: number; months?: number; sentence: string }> {
  const TERM = String.raw`(?:敷金|保証金|デポジット|預か?り金)(?:\s*[（(](?:敷金|保証金|デポジット)[）)])?`;
  // 「敷金礼金1か月ずつ」「敷金・礼金各1ヶ月」：押金與礼金合寫一個金額，押金也是那個金額
  const RE = new RegExp(String.raw`${TERM}(?:\s*[・、]?\s*礼金\s*(?:各|とも(?:に)?|共に)?)?\s*(?:[：:＝=→➡]|は|として)?\s*[（(「]?\s*(?:[￥¥]\s*([1-9][0-9,，]*)|([1-9][0-9,，]*)\s*円|([1-9][0-9.]*)\s*万円|(?:家賃|賃料|利用料)?\s*の?\s*([1-9](?:\.[0-9]+)?)\s*[ヶかカヵケ]?月)`, 'g');
  const COND = /場合|方は|の方|タイプ|ドミトリー|相部屋|個室|号室|保証人|保証会社|ペット|学生|法人|外国|または|もしくは|又は|例えば|限り|一般|通常の賃貸|相場/;
  const ZERO_WORD = /無料|なし|無し|不要|ゼロ|(?<![0-9,])0円|免除/;
  const out: Array<{ jpy?: number; months?: number; sentence: string }> = [];
  for (const c of sentencesWithContext(toHalfDigits(text))) {
    const { s } = c;
    // 句首的「(マンションタイプ)」正好是這間房自己的房型（scopeToRoomTypes 已拿掉別種房型的行）：不算條件
    const t = TYPE_SCOPE.exec(s)?.[1];
    const condText = t !== undefined && roomTypes.includes(t) ? s.replace(TYPE_SCOPE, '') : s;
    if (COND.test(condText) || ZERO_WORD.test(s) || CAMPAIGN.test(c.context)) continue;
    for (const m of s.matchAll(RE)) {
      const yen = m[1] ?? m[2];
      if (yen !== undefined) out.push({ jpy: Number(yen.replace(/[,，]/g, '')), sentence: s });
      else if (m[3] !== undefined) out.push({ jpy: Math.round(Number(m[3]) * 10000), sentence: s });
      else if (m[4] !== undefined) out.push({ months: Number(m[4]), sentence: s });
    }
  }
  return out;
}

/** 改裝／重建類句子：裡面的年份與樓數可能是改裝的，不是建物本身的，整句不用。 */
const RENOVATION = /リノベ|改装|改築|リフォーム|建て替え|建替|増築/;

function toHalfDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 和暦（年號紀年）換成西元：「平成２４年１０月新築」（TSH 3328）→「2012年10月新築」。
 * 元年＝1。只換「年號＋數字＋年」這種完整寫法，不猜省略年號的「24年」。
 */
const ERA_BASE: Record<string, number> = { 令和: 2018, 平成: 1988, 昭和: 1925 };
function westernYears(s: string): string {
  // 「昭和３０年代」是十年區間，不是某一年（TSH 3432）——不換
  return toHalfDigits(s).replace(/(令和|平成|昭和)\s*(元|\d{1,2})\s*年(?!代)/g,
    (_, era: string, n: string) => `${(ERA_BASE[era] ?? 0) + (n === '元' ? 1 : Number(n))}年`);
}

/**
 * 說明文裡的築年。只認「建物何年蓋好」的寫法：
 *   `2015年築`、`築2015年`、`2017年8月に新築した`、`2019年新築の`、`2021年3月に…建てられた`、`2002年竣工`、
 *   `2012年2月3日竣工`（日也寫出來的；2026-10-17 驗證幫手抓到 i-be-house 漏收）、
 *   和暦 `平成24年10月新築`（換成西元再比對）
 * 刻意不收：
 *   「2014年8月 新築オープン」「2016年3月新築で誕生」——那是開幕日。日本的「新築」是完工一年內未入住，
 *   開幕月份的前一年完工也算新築，年份可能差一年（2026-10-17 ひつじ驗證的裁決者指出）。
 *   「2015年の築浅」「2021年3月OPEN」——不是築年。
 *   含リノベ／改装／リフォーム的句子——年份可能是改裝年。
 * 出現兩個不同年份就不採用（不替原站挑）。
 */
export function proseYearBuilt(text: string, maxYear: number): { year: number; sentence: string } | null {
  const PATTERNS = [
    // 年(?!代)：「1950年代に建てられた」是十年區間
    /((?:19|20)\d{2})\s*年(?!代)\s*築(?!浅)/,
    /築\s*((?:19|20)\d{2})\s*年/,
    /((?:19|20)\d{2})\s*年(?!代)\s*(?:\d{1,2}\s*月\s*(?:\d{1,2}\s*日\s*)?)?に?\s*新築(?!\s*で?\s*(?:オープン|OPEN|誕生|開業))/,
    /((?:19|20)\d{2})\s*年(?!代)\s*(?:\d{1,2}\s*月\s*(?:\d{1,2}\s*日\s*)?)?に?[^、。]{0,20}?建てられた/,
    /((?:19|20)\d{2})\s*年(?!代)\s*(?:\d{1,2}\s*月\s*(?:\d{1,2}\s*日\s*)?)?に?\s*(?:竣工|建築)/,
  ];
  const found = new Map<number, string>();
  // 比對用換成西元的句子，回傳原句——srcText 要是頁面上的字（3328 原文是「平成２４年１０月新築」）
  for (const original of proseSentences(text)) {
    const s = westernYears(original);
    if (RENOVATION.test(s)) continue;
    for (const re of PATTERNS) {
      const m = re.exec(s);
      const y = m?.[1] === undefined ? NaN : Number(m[1]);
      if (Number.isInteger(y) && y >= 1900 && y <= maxYear && !found.has(y)) found.set(y, original);
    }
  }
  const only = found.size === 1 ? [...found][0] : undefined;
  return only === undefined ? null : { year: only[0], sentence: only[1] };
}

/**
 * 說明文裡的地上樓數：`5階建て`、`4階建のビル`、`5F建て`、`地上3階建て`、`地下1階～5階建て`（取 5）。
 * 不收：`地下1階建` 這種地下層數、含メゾネット（房間內部樓層）或増築／建て替え／改築的句子（內裝改修不影響樓數）。
 * 出現兩個不同數字就不採用。
 */
/** 「二階建て一戸建て」（TSH 4526／4527）：漢字樓數換成阿拉伯數字，只換緊接「階建」「F建」的一～十九。 */
function kanjiFloors(s: string): string {
  const D: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return s.replace(/(十?[一二三四五六七八九]?|十)(?=\s*(?:階|F|Ｆ)\s*建)/g, (k: string) => {
    if (k === '') return k;
    const tens = k.startsWith('十') ? 10 : 0;
    const ones = D[k.replace('十', '')] ?? 0;
    return String(tens + ones);
  });
}

export function proseFloorsAboveGround(text: string): { floors: number; sentence: string } | null {
  const RE = /(?<!地下\s*)(?<![0-9])([0-9]{1,2})\s*(?:階|F|Ｆ)\s*建/g;
  const found = new Map<number, string>();
  // 比對用轉成阿拉伯數字的句子，回傳原句（srcText 要是頁面上的字）
  for (const original of proseSentences(text)) {
    const s = kanjiFloors(toHalfDigits(original));
    // 樓數只怕結構改變（増築／建て替え／改築）；リノベ／改装／リフォーム是內裝，不改樓數
    //（TSH 3052「地下1階、地上3階建てのリノベーション物件」舊版整句丟掉）
    if (/建て替え|建替|増築|改築/.test(s) || /メゾネット/.test(s)) continue;
    // 「ご近所は…大型スーパー5店、6階建て100均ダイソー…」：講周邊設施的樓數（ひつじ tokyo-professional）。
    // 講周邊的句子裡，只收緊接著房子本身的寫法（TSH 2665「周辺に…エリアにある2階建て一軒家タイプの…」）
    const neighbourhood = /ご?近所|周辺|近隣|付近/.test(s);
    for (const m of s.matchAll(RE)) {
      if (neighbourhood && !/^て?の?\s*(?:一軒家|一戸建|戸建|建物|物件|シェアハウス|ハウス|マンション|アパート|ビル)/
        .test(s.slice((m.index ?? 0) + m[0].length))) continue;
      const n = Number(m[1]);
      if (n >= 1 && n <= 60 && !found.has(n)) found.set(n, original);
    }
  }
  const only = found.size === 1 ? [...found][0] : undefined;
  return only === undefined ? null : { floors: only[0], sentence: only[1] };
}

/**
 * 說明文明寫「收不收外國人」。
 *   收：`外国人歓迎`、`外国人の方も大歓迎`、`外国人OK`、`外国人対応OK`、`外国籍の方も入居可能`、`国籍問わず`、
 *   `国籍問いません`、`外国籍の方、留学生も大歓迎`（TSH 282）、列舉 `外国籍(要保証会社)・学生・…・ペット可`（3481）
 *   不收：`外国人不可`、`Foreigner NG`、`Japanese only`、`日本人限定`
 * 帶附帶條件的不採用：`外国人：女性のみ可`、`募集中のお部屋は外国人男性不可`、
 * 句內同時有不可／NG／お断り的「收」也不採用。`外国人対応不可(英語サポートなし)` 講的是
 * 對應語言，不是收不收，也不採用。兩種說法都出現就回 'conflict'。
 */
export function proseForeignerWelcomed(text: string): { welcomed: boolean; sentence: string } | 'conflict' | null {
  // 後兩種（2026-10-17 第二輪驗證）：入居条件「45歳未満の日本人、外国人男女であること」把外國人列為資格內；
  // 「外国籍の方も安心してお住まい頂けます」是明寫可住。
  const YES = /(?:外国人|外国籍|外国の方)(?:の方)?[もは、の]?\s*(?:入居)?\s*(?:対応)?\s*(?:大)?(?:歓迎|ＯＫ|OK|可能|可(?![^\s、。）)]))|国籍(?:を)?問わず|国籍不問|日本人(?:の方)?(?:男女|男性|女性)?\s*[、・,，／/]\s*外国(?:人|籍)(?:の方)?(?:男女|男性|女性)?(?:で(?:ある|あれば)|の方|が対象|を対象|可)|外国(?:人|籍)の方も[^。]{0,8}(?:安心して|お住まい|ご入居|入居|住め|暮らせ)|国籍(?:は|を)?問いません|外国(?:人|籍)(?:の方)?[、・]\s*[^、。\s]{1,8}?(?:の方)?も\s*(?:大)?歓迎|外国(?:人|籍)(?:[（(][^）)]{1,12}[）)])?(?:・[^・／/。、\s]{1,16}){1,5}?可(?![^\s、。）)])/i;
  const NO = /(?:外国人|外国籍)(?:の方)?[のは]?\s*(?:入居)?\s*(?:不可|NG|ＮＧ|お断り)|foreigner\s*NG|japanese\s*only|日本人(?:の方)?(?:女性|男性)?(?:限定|のみ)/i;
  let yes: string | null = null;
  let no: string | null = null;
  for (const s of proseSentences(toHalfDigits(text))) {
    if (NO.test(s)) { no ??= s; continue; }
    // 只附日語能力的（4226「外国人OK（要：日本語日常会話・読み書き…）」、1428「日本語が話せれば、国籍問いません」）照收：
    // 日語是對所有住客的要求，不是對外國人的限制
    if (YES.test(s) && !/不可|NG|ＮＧ|お断り|のみ|限定/.test(s)) yes ??= s;
  }
  if (yes !== null && no !== null) return 'conflict';
  if (yes !== null) return { welcomed: true, sentence: yes };
  if (no !== null) return { welcomed: false, sentence: no };
  return null;
}

/**
 * 說明文明寫的水電基準：含在共益費裡，或另計（実費／別途）。
 *
 * 「含」只在**涵蓋水道**的寫法才算：ライフライン（水・電・瓦斯）、水道光熱、水光熱、光熱水、上下水道…電気。
 * 「光熱費込み」只講電與瓦斯，水費沒提——不算全含（實測 TSH 1697 介紹寫「共益費には光熱費、WIFI費用込み」，
 * note 才寫「上下水道料金・電気・ガス…が含まれます」）。
 * 一句含、另一句另計（「共益費にライフライン費用を含む。別途居室内電気使用料がかかります」）或
 * 「50KWまでは定額、超過分は実費」＝部分含，回 'partial'（呼叫端存「明寫另計但沒金額」，不是「來源沒提」——
 * 2026-10-17 驗證幫手指出 TSH 3880 存成 not_offered_by_source 與頁面不符）。
 * 「含」帶條件的前後文（見 CONDITION）不採用——把 0 存錯的代價大。
 * 「另計」只看**同一個分句**有沒有條件字：TSH 2493／2699 的備考「水光熱費実費　条件付きで23,800円」，
 * 「条件付き」講的是房租折扣，用 200 字窗口會連實費一起丟掉。另計句存的值仍是未知，誤收的代價小。
 * 「含まれます」可以離得很遠（1697：「共益費には上下水道料金・電気料金・
 * ガス料金・家財保険料・…・消耗品購入費 等が含まれます」），句內 80 字內都算。
 */
export function proseUtilities(text: string): { basis: 'included' | 'excluded' | 'partial'; sentence: string; someExcludedOnly?: true } | null {
  // 第 3 種：「電気・ガス・水道・インターネット（Wi-Fi対応）も全て込み」（TSH 2302）——列舉裡要有水道；「…無料」同義。
  // 第 4 種：「■共益費電気・ガス・水道・インターネット料/16,000円」（3921）——共益費的組成就是這幾項。
  // 「込」不可以是「申し込み」的込。
  const CONTAINER_NOT = String.raw`(?!(?:費用|費|料金|料|代)?\s*(?:に|には)(?!関|つい|も))`;
  const INCLUDED = new RegExp([
    // 水電詞緊接「に／には」時它是容器不是被含的那個：「※水光熱費にインターネット使用料が含まれます」（TSH 1409）
    String.raw`(?:ライフライン|水道光熱|水光熱|光熱水|上下水道[^。]{0,20}電気)(?!(?:費用|費|料金|料|代)?\s*(?:に|には)(?!関|つい|も))[^。]{0,80}?(?:含ま|含む|含め|含み(?!ません)|込み|ふくま)`,
    String.raw`(?:共益費|管理費)[（(][^）)]*(?:ライフライン|水道光熱|水光熱|光熱水)[^）)]*(?:含|込)`,
    // 括號只列組成、沒寫含（TSH 3879「共益費（水道光熱費インターネット等）：12,000円/月」）；括號裡有別／除／以外／実費就不算
    String.raw`(?:共益費|管理費)[（(](?![^）)]*(?:別|除|以外|実費|含まない|含みません))[^）)]*(?:ライフライン|水道光熱|水光熱|光熱水)[^）)]*[）)]`,
    // 「光熱費・水道代・Wi-Fi などの生活に必要な費用は含まれています」（TSH 3399）：光熱＝電＋瓦斯，再加水道才算全含
    // 任一個水電詞緊接「に／には」都是容器（「光熱費に水道代も含まれる」講的是光熱費的組成，不是含在房租裡）
    // 「無料」也算（TSH 2906「電気代・ガス代・水道代・インターネット無料のシェアハウスです」、389「電気、水道、ガス代もすべて無料です」）
    String.raw`(?:(?:電気|ガス|光熱)${CONTAINER_NOT}[^。]{0,12}水道|水道${CONTAINER_NOT}[^。]{0,12}(?:電気|ガス|光熱))${CONTAINER_NOT}[^。]{0,30}?(?:含ま|含む|含め|含み(?!ません)|ふくま|(?<!申し?)込み|(?<!申し?)込(?=です|[、。！!♪）)\s]|$)|無料)`,
    String.raw`(?:共益費|管理費)[：:\s]*(?:(?:電気|ガス|水道|光熱費?|インターネット|ネット|Wi-?Fi)(?:代|料|費)?[・、,／/\s]*){3,}`,
    // 「共益費12000円で、ガス、電気、水道、無線LAN、スカパー（リビングのみ）」（TSH 841 note，第三十四輪）：那筆共益費涵蓋的項目，列舉裡要有水道
    String.raw`(?=[^。]*水道)${FEE_COVERS}`,
  ].join('|'));
  // 第 3 種：「備考: 光熱費15,000円」（TSH 3145）——水電詞直接接一個非 0 金額、句內沒說含／込＝另收（金額不自動採用）
  const EXCLUDED = /(?:ライフライン|水道光熱|水光熱|光熱水?|電気|ガス|水道)[^。]{0,12}?(?:実費|別途|個別契約|個人契約|各自契約)|別途[^。]{0,12}(?:電気|ガス|水道|光熱)|(?:ライフライン|水道光熱|水光熱|光熱水?)(?:費用?|代|料金?)\s*[：:]?\s*(?:月額|毎月|月)?\s*[1-9][0-9,]*\s*円(?![^。]*(?:含|込|ふくま))/;
  // 「電気代が月5,000円を超えた分は実費」：超過分另計＝部分含
  // 「共益費（水道光熱費）は￥10000/月を前預かり後、年2回精算」（TSH 43）：預收後依實際用量精算，不是固定含在裡面
  // 「実費精算」只是照實際用量收（3595「電気代は各室使用分実費精算」，第三十一輪），不是預收後精算——交給另計的判讀
  const PARTIAL = /超過|超え|上回|オーバー|まで(?:は)?定額|上限|(?<!実費)精算/;
  // 「（水道,共有部分電気,ガス…を含む)」「水道光熱費(個室電気代以外)」（TSH 331）：含的只有共用部的電——個室電費另計
  const PARTIAL_INC = /(?:共有|共用)部?分?の?電気|(?:個室|居室|各部屋|お部屋)(?:内)?の?電気(?:代|料金?)?(?:以外|を除|は除|除く)/;
  const UTIL = /ライフライン|水道|光熱|電気|ガス/;
  let inc: string | null = null;
  let exc: string | null = null;
  const partials: string[] = [];
  // 有沒有「部分含」的寫法（超過分實費、共用部電費含在內）；只有「某一部分另計」（「電気代は各室使用分実費精算」）時，
  // 不能說「部分含在共益費」——原文沒寫其餘含不含
  let mixed = false;
  const cs = sentencesWithContext(text);
  for (const [i, c] of cs.entries()) {
    const { s } = c;
    // 「・光熱水等費16,000円」下一行「※電気・ガス・水道…が含まれています」（TSH 3392）：註腳講的是那筆水電費的組成，
    // 不是含在房租裡——前一句以水電費金額結尾時，緊接的 ※ 註腳不當「含」
    const prev = cs[i - 1]?.s ?? '';
    if (/^[※*＊]/.test(s) && /(?:光熱|水道|水光熱|ライフライン|電気|ガス)[^。]{0,10}[0-9][0-9,]*\s*円\s*$/.test(prev) && INCLUDED.test(s)) continue;
    // 部分含只會讓值變未知（保守方向），不受條件字眼開關——331 的「（水道,共有部分電気,ガス…を含む)」附近有條件字眼，
    // 被跳過後另一句「共益費1万円には水道光熱費…が含まれ」就把它判成全含
    if (UTIL.test(s) && (PARTIAL.test(s) || PARTIAL_INC.test(s))) { partials.push(s); mixed = true; continue; }
    const em = EXCLUDED.exec(s);
    if (em !== null) {
      // 句首的 ※ 是條列記號（4028「※個室内で使う電気、ガスは別途要契約」），不是條件
      if (CONDITION.test(clauseAround(s, em.index, em.index + em[0].length).replace(/^[※*＊]/, ''))) continue;
      // 「個室内電気代は実費請求」（TSH 376）「電気代は各室使用分実費精算」：只講電費，水與瓦斯沒說——部分另計。
      // 「※個室内で使う電気、ガスは別途要契約」（4028）：只講房內用量，共用部與水費不在這句——也是部分
      if ((/電気/.test(s) && !/水道|ガス|ライフライン|光熱/.test(s)) || /個室|居室|各部屋|お部屋|各室|室内/.test(s)) partials.push(s);
      else exc ??= s;
      continue;
    }
    // 「含在共益費」講的是那筆月費涵蓋什麼，條件只看這一句本身與註腳（同 proseInternet，第三十輪）：
    // 3399「🎉 初月50％割引中！🎉 6ヶ月以上のご入居で、初月賃料が半額になります！（条件あり） 👉 毎月のお支払いは、「賃料＋共益費」のみ。
    // 光熱費・水道代・Wi-Fi などの生活に必要な費用は含まれています」——活動與條件講的是房租
    if (INCLUDED.test(s) && !CONDITION.test(s.replace(/^[※*＊]/, '')) && !c.footnotes.some((f) => UTIL_FOOTNOTE.test(f))) inc ??= s;
  }
  // 部分含：既不是全含也不是全另計；相關的句子都留給看的人
  if (partials.length > 0 || (inc !== null && exc !== null)) {
    const all = [inc, exc, ...partials].filter((x): x is string => x !== null);
    // 第三十一輪 TSH 3595：只有「電気代は各室使用分実費精算」，卻被註成「部分含在共益費」
    const someExcludedOnly = inc === null && !mixed ? { someExcludedOnly: true as const } : {};
    return { basis: 'partial', sentence: [...new Set(all)].join('／'), ...someExcludedOnly };
  }
  if (inc !== null) return { basis: 'included', sentence: inc };
  if (exc !== null) return { basis: 'excluded', sentence: exc };
  return null;
}

/** 句子裡涵蓋 [from, to) 的分句（以讀點、逗號、空白為界往兩側延伸）。 */
function clauseAround(s: string, from: number, to: number): string {
  const SEP = /[、，,\s　]/;
  let a = from;
  while (a > 0 && !SEP.test(s[a - 1] ?? '')) a--;
  let b = to;
  while (b < s.length && !SEP.test(s[b] ?? '')) b++;
  return s.slice(a, b);
}

// ── 2026-10-17 第二十五輪：保証料／更新・再契約／清掃費／網路 ───────────────────────────────
/*
 * Tokyo Sharehouse 站上沒有這幾項的欄位，adapter 原本一律存「此來源不公開」。第二十五輪驗證抓到頁面明寫、
 * 我們卻說來源不提供：「※保証会社加入必須（初回保証料が別途発生します）」（1695）、「再契約手数料：1年おきに3万円」（3448）、
 * 「退去後クリーニング費20,000円(入居時前払い)」（3448）、「共益費（水光熱費・wi-fi・保険含む）」（3513）。
 * 規則來自 2026-10-17 對 1,694 棟說明文的全量掃描（保証 170 句、更新 113 句、清掃 204 句、網路 352 句，逐句看過）。
 * 金額照舊不採用（理由見檔頭）：明寫要付 → excluded_stated；明寫免收 → 0；含在別的費用裡 → included。
 * 舊欄位（礼金等）的判讀不經過這裡，維持原狀。
 */

const CLEAN_NOUN = String.raw`(?:退去時?の?|退室|退出時?の?|退居後?の?)?(?:室内|個室|ルーム|ハウス)?(?:クリーニング|清掃)(?:費用?|代|料)`;
// 新欄位的免收清單：多收「清掃費」「保証会社」當清單項，黏著字多收「…などの(入居)費用は」「）は」
//（TSH 1625「それ以外の面倒な費用（清掃代、保険料等）は一切請求いたしません」）
const LISTABLE_X = String.raw`(?:${ITEM}|${CLEAN_NOUN}|(?:家賃)?保証会社|管理費|共益費|共用費|共有費|Wi-?Fi|WI-?FI|WiFi|ＷｉＦｉ|インターネット|ネット)`;
const GLUE_X = String.raw`(?:[\s・、：:『』「」）)…]|は|も|が|全て|すべて|一切|など|等|ともに|共に|の(?:入居|初期)?(?:諸)?費用|(?:入居|初期)?(?:諸)?費用)*`;
// 「更新料：無」（TSH 489）：單一個「無」接在句尾或分隔符前
const ZERO_X = String.raw`(?:${ZERO}|有りません|請求(?:いた)?しません|頂戴(?:いた)?しません|お取りしません|発生(?:いた)?しません|かからず|無(?=\s*(?:$|[、。,，）)】・/／])))`;
const ZERO_LIST_X = new RegExp(`(${LISTABLE_X}(?:${SEP}*${LISTABLE_X})*)${GLUE_X}${ZERO_X}`, 'g');
// 「当シェアハウスでは「●●手数料」「●●保証料」「●●保険」等の費用は請求しません！！」（TSH 492、1532、2737 等同一業者）：
// 「●●」是「某某」，「●●保証料」＝各種保證費。只認括號裡的佔位清單緊接「等の費用は…しません」；回傳佔位後面的名詞
const PLACEHOLDER_WAIVER = /((?:[「『][●○]{2,}[^」』●○]{1,8}[」』]\s*[・、]?\s*)+)(?:等|など)の?(?:諸)?費用は(?:一切)?(?:請求|頂戴|徴収)(?:いた)?しません/;
function placeholderWaived(s: string): string[] {
  const m = PLACEHOLDER_WAIVER.exec(s);
  if (m === null) return [];
  return [...(m[1] ?? '').matchAll(/[「『][●○]{2,}([^」』●○]{1,8})[」』]/g)].map((x) => x[1] ?? '');
}
const ZERO_WORD_X = /無料|なし|無し|[：:]\s*無|不要|ゼロ|(?<![0-9,])0円|かかりません|かからず|ありません|有りません|いりません|頂きません|いただきません|請求(?:いた)?しません|免除/;
// 保証料常寫成百分比、「1.5万」（TSH 2975「初回保証料1.5万」）
const G_VALUE = String.raw`(?:[1-9][0-9,，.]*\s*万円?|[1-9][0-9,，]*\s*円|[￥¥]\s*[1-9]|[0-9]+(?:\.[0-9]+)?\s*[%％]|(?!0(?:\.0+)?\s*[ヶかカヵケ]?月)[0-9]+(?:\.[0-9]+)?\s*[ヶかカヵケ]?月)`;

/**
 * 共同前處理：全形數字轉半形；「16,500円／人」的全形斜線不是條列分隔（BeGood 系列 51 棟「初回に入居金16,500円／人、
 * クリーニング代16,500円／人…が別途掛かります」被切開後，清掃費就和「初回に」分家）；小標加下一行「・なし」併成一句
 *（TSH 4026「＜更新料、退去時のクリーニング費用等＞」下一行「・なし（ただし、壁に穴を開けた…場合は…）」），
 * 括號裡的損壞求償但書拿掉——那是退租時的修繕實費，不是這些費用的條件。
 */
// 「円／人」的斜線先換成私用字元（不是 proseSentences 的分句符號），輸出原句前再換回「／」，srcText 才對得上原文
const SLASH_PH = '\uE000';
const unprepX = (s: string): string => s.replace(/\uE000/g, '／');
function prepX(text: string): string {
  return toHalfDigits(text)
    // 「口座振替手数料￥550／月」（4509，第二十九輪）：金額後的全形斜線接單位，不是條列分隔
    .replace(/([0-9]\s*円|[￥¥]\s*[0-9][0-9,]*)／(?=人|名|部屋|室|回|月|年|週|日)/g, `$1${SLASH_PH}`)
    // 小標與下一行用「…」接（原文稽核把「…」當省略號）
    .replace(/[＜<【]([^＞>】\n]{1,40})[＞>】]\s*\n+\s*・?\s*(なし|無し|無料|不要)/g, '$1…$2')
    .replace(/[（(]\s*ただし[^）)]*?(?:穴|破損|汚損|毀損|故意|過失|タバコ|喫煙)[^）)]*[）)]/g, '');
}

/** 小標（「【初回契約時費用】」「＜初期費用＞」「[契約条件]」）：之後 10 句內的條列屬於這個小標。 */
const HEADER_RE = /^[\s・]*[【＜<［\[〔]\s*([^】＞>］\]〕]{1,30}?)\s*[】＞>］\]〕]\s*$/;
function headersOf(ss: readonly string[]): Array<string | null> {
  let cur: string | null = null;
  let since = 0;
  return ss.map((s) => {
    const h = HEADER_RE.exec(s)?.[1];
    if (h !== undefined) { cur = h; since = 0; return null; }
    since += 1;
    return since <= 10 ? cur : null;
  });
}
const INITIAL_HEADER = /初回|初期|入居時|(?<!再)契約時|新規/;
const RENEW_HEADER = /再契約|更新/;
const GENERIC_X = /一般|通常の賃貸|普通の賃貸|他社|他の物件|相場/;
const ROOM_SCOPE_X = /号室(?:は|のみ|に限り|限定)/;

/**
 * 說明文明寫要付的那幾句（最多 3 句）：費用名詞緊接金額、25 字內接金額（中間不夾別的費用名詞、從名詞到句尾沒有免收字眼）、
 * 總額括號（「3万円（契約事務手数料/退去クリーニング費/…）」）、金額在前（「更新時に20,000円の再契約手数料あり」）。
 */
function statedSentences(ss: readonly string[], term: string, value: string = VALUE): string[] {
  const out: string[] = [];
  ss.forEach((s, i) => {
    if (GENERIC_X.test(s)) return;
    if (ROOM_SCOPE_X.test(s) || (ROOM_SCOPE_X.test(ss[i - 1] ?? '') && !/^[・■□◆◇●○※*＊★☆【\-ー①-⑳(（]/.test(s))) return;
    const amount = String.raw`\s*[：:=＝]?\s*(?:[（(]\s*(?:通常)?\s*)?(?:賃料|家賃)?\s*の?\s*${value}`;
    const hit = new RegExp(`(?:${term})${amount}`).test(s)
      || (() => {
        const g = new RegExp(`(?:${term})([^。]{1,25}?)${value}`).exec(s);
        return g !== null && !ITEM_RE.test(g[1] ?? '') && !ZERO_WORD_X.test(s.slice(g.index));
      })()
      || (new RegExp(`${value}\\s*[（(][^）)]*(?:${term})[^）)]*[）)]`).test(s) && !ZERO_WORD_X.test(s))
      || new RegExp(`${value}\\s*の\\s*(?:${term})\\s*(?:あり|が(?:必要|かかり|発生))`).test(s);
    if (hit && out.length < 3 && !out.includes(s)) out.push(s);
  });
  return out;
}

// ── 保証会社初回保証料 ──

// 不是保證公司費用的「保証」：携行品保証料（物品保險，TSH 2517）、警備保証会社（2224）、押金的別名「デポジット（保証料）」（3580）、
// 「火災保険加入必須（上記保証料に含む）」（4436，講的是保險含在保證費裡）、「要火災保険加入（保証会社に付帯）」、「（保証会社不可）」（2665）
const NOT_GUARANTOR = /携行品の?保証料|警備保証会社|(?:デポジット|保証金|敷金)\s*[（(]\s*保証料\s*[）)]|(?:上記)?保証料に含む|保証会社に付帯|[（(]?\s*保証会社不可\s*[）)]?/g;
const GUARANTOR = /保証会社|保証料|保証委託|家賃保証/;
const GUARANTOR_INITIAL = new RegExp([
  String.raw`(?:初回|初期)の?保証料`,
  String.raw`保証料[：:\s]*(?:初回|初期)`,
  String.raw`保証会社[^。]{0,12}?(?:加入金|入会金|登録費|加入費用?|初期費用|初回費用)`,
  String.raw`(?:保証会社|保証料|保証委託)[^。]{0,20}?(?:初回|入居時|加入時|(?<!再)契約時)(?:のみ)?[^。]{0,8}?${G_VALUE}`,
  String.raw`初回保証料[^。]{0,6}?(?:別途)?(?:発生|必要|かかり)`,
].join('|'));
// 「1.初回事務手数料10,000円（保証会社加入費用込み）」（TSH 4070）
const GUARANTOR_INCLUDED = /保証会社(?:加入|利用)?(?:費用?|料)込み|保証料込み/;
// 「連帯保証人や保証会社は不要」「…保証会社への加入も必要有りません」「「保証会社無し」」「・家賃保証会社：不要（…）」
const GUARANTOR_NONE = /(?:家賃)?保証会社(?:への加入|の利用|加入|利用)?\s*(?:は|も|：|:)?\s*(?:不要|無し|なし|必要(?:有|あ)りません|いりません|必要ない)/;
// 保證公司照用、只有初回免收（4221「保証会社利用 : …（※保証料月額支払合計1．2％、※初期費用・更新費用なし）」）
// 「0円」前面不可以是數字：「保証会社初期費用20000円」（1748）的結尾不是 0 円
const GUARANTOR_ZERO_INITIAL = /(?:初回|初期)?保証料\s*(?:は|も|：|:)?\s*(?:無料|なし|無し|不要|(?<![0-9,，.])[0０]円)|保証会社[^。]{0,60}?初期費用[^。]{0,8}?(?:なし|無し|不要|(?<![0-9,，.])[0０]円)/;
// 「保証会社▶▶原則、不要ですが必要な場合もあり」（2315）、「連帯保証人様１名、もしくは賃貸保証会社への加入」：選項或例外，不是免收
const GUARANTOR_COND = /場合|原則|もしくは|又は|または|NG|方は|方の|可能|審査|利用可/;
// 「月額賃料30～50％」「月額総家賃の60％」的月額是基數，不是月付
const MONTHLY_G = /月額(?!賃料|家賃|総家賃|総賃料|賃料総額|金額|総費用|支払い?家賃|賃料等)|毎月|月々|[/／\uE000]\s*月|継続保証料|毎年|[/／\uE000]\s*年|次年度/;
const INITIAL_WORDS = /初回|初期費用|入居時|(?<!再)契約時|新規契約|前払|申し受け|入居費用/;
const BRACKET_COST_HEADER = /[【＜<]\s*(?:初期費用|入居時費用|契約時費用|初回費用|初回契約時費用)\s*[】＞>][^。┃]*$/;

/** 條列裡的一項：往前到上一個「・」「、」「，」「┃」或兩個空白，往後到下一個同樣的分隔（數字裡的千分位逗號不算）。 */
function itemAround(s: string, from: number, to: number): string {
  const before = s.slice(0, from);
  let a = 0;
  for (const m of before.matchAll(/[・、┃]|[，,](?![0-9])|\s{2,}/g)) a = (m.index ?? 0) + m[0].length;
  const e = s.slice(to).search(/[・、┃]|[，,](?![0-9])|\s{2,}/);
  return s.slice(a, e < 0 ? s.length : to + e);
}

/** 保證公司那一項：往前到上一個「・」「、」，往後到下一個「・」「、」或「）」後的空白。 */
function guarantorItem(s: string, from: number, to: number): string {
  const before = s.slice(0, from);
  const a = Math.max(before.lastIndexOf('・'), before.lastIndexOf('、'), before.lastIndexOf('┃')) + 1;
  const rest = s.slice(to);
  const end = rest.search(/[・、┃]|[）)]\s/);
  return s.slice(a, end < 0 ? s.length : to + end + 1);
}

export type FeeProse = { kind: 'zero' | 'stated' | 'included' | 'mentioned' | 'unadopted' | 'conflict'; sentence: string };

/**
 * 保證公司初回保証料。zero：明寫不用保證公司或初回保証料免收；stated：明寫初回／入居時要付（金額不採用）；
 * included：明寫含在別的費用裡；mentioned：提到保證公司（必須、月付、條件式）但沒寫初回要付多少——呼叫端存「這頁沒寫」而不是「來源不公開」；
 * conflict：免收與要付並存。沒提就回 null。
 */
export function proseGuarantorFee(text: string): FeeProse | null {
  const cs = sentencesWithContext(prepX(text));
  const flat = prepX(text).replace(/\s+/g, ' ');
  const headers = headersOf(cs.map((c) => c.s));
  // 別處寫成月付的同一個金額（3921「保証会社利用必須/月額800円」）：初期費用條列裡的「保証会社利用料800円」是第一個月的月費，不是初回保証料
  const monthlyAmounts = new Set<string>();
  for (const c of cs) {
    if (!GUARANTOR.test(c.s) || !MONTHLY_G.test(c.s)) continue;
    for (const m of c.s.matchAll(/([1-9][0-9,]*)\s*円/g)) monthlyAmounts.add((m[1] ?? '').replace(/,/g, ''));
  }
  let none: string | null = null;
  let zero: string | null = null;
  let included: string | null = null;
  const stated: string[] = [];
  const mentioned: string[] = [];
  cs.forEach((c, i) => {
    const s = c.s.replace(NOT_GUARANTOR, '');
    if (!GUARANTOR.test(s)) return;
    // 「当シェアハウスでは「●●手数料」「●●保証料」「●●保険」等の費用は請求しません」（1532，第三十輪）：各種保證費都不收。
    // 這句以前被「●」切成碎片、當成不是在講保證公司；分句不再切佔位符（proseSentences）
    if (placeholderWaived(s).includes('保証料') && !CAMPAIGN.test(c.context)) { zero ??= c.s; return; }
    // 條件只看保證公司那一項：3943「・家賃保証会社：不要（緊急連絡先に…） 更新料または再契約料 20,000円」的「または」講的是更新料
    const zeroAt = GUARANTOR_NONE.exec(s) ?? GUARANTOR_ZERO_INITIAL.exec(s);
    const item = zeroAt === null ? s : guarantorItem(s, zeroAt.index, zeroAt.index + zeroAt[0].length);
    const cond = GUARANTOR_COND.test(item) || CAMPAIGN.test(c.context);
    if (!cond && GUARANTOR_NONE.test(item)) { none ??= c.s; return; }
    if (!cond && GUARANTOR_ZERO_INITIAL.test(item)) { zero ??= c.s; return; }
    if (GUARANTOR_INCLUDED.test(s)) { included ??= c.s; return; }
    // 初期費用的條列裡寫了保證費、而且不是月付（「【初期費用】清掃費：22,000円/ 火災保険：…/ 家賃保証料：総賃料50％」）
    // 同一行用「／」並列的前一項是初期費用（4361「初期費用1.5万／保証料30％（最低1.2万）」，第二十七輪）：切句時被拆開，接回來看
    const prev = cs[i - 1]?.s ?? '';
    const slashJoined = prev !== '' && flat.includes(`${prev}／${c.s}`) && /初期費用/.test(prev);
    const initialCtx = INITIAL_WORDS.test(s) || INITIAL_HEADER.test(headers[i] ?? '') || slashJoined;
    // 費用小標下的條列、沒寫金額（4394「・初期費用：敷金・礼金・仲介手数料0円　初月・翌月分の賃料、火災保険料（月額￥700）、保証料（支払方法によって変動）」，第二十九輪）
    const gm = GUARANTOR.exec(s);
    // ※ 之後是另一條註記（4394「…保証料（支払方法によって変動）※ご契約プランは1年または2年からお選び…」的「または」講合約年限）
    const gItem = gm === null ? '' : (guarantorItem(s, gm.index, gm.index + gm[0].length).split('※')[0] ?? '');
    // 小標寫成「【初期費用】」不接冒號也算（2239「【初期費用】契約事務手数料 50,000円（税別）、保証金30,000円、…、保証会社加入必須」，第三十一輪 audit:why）
    const underHeader = gm !== null && (COST_HEADER.test(s.slice(0, gm.index)) || BRACKET_COST_HEADER.test(s.slice(0, gm.index)))
      && !MONTHLY_G.test(gItem) && !GUARANTOR_COND.test(gItem);
    // 金額後面的括號另寫之後的年費（4284「・家賃保証会社：10,000円（毎年更新：10,000円～15,000円）」、
    // 1264「・家賃保証会社:(家賃+共益費∔駐輪場)80％（次年度より保証委託料10,000円/年）」）：括號講續約年費，前面那筆是入居時付的
    const firstYear = new RegExp(`(?:保証会社|保証料|保証委託)\\s*[：:]?\\s*(?:[（(][^）)]{0,20}[）)])?\\s*${G_VALUE}\\s*[（(][^）)]*(?:毎年|次年度|翌年|2年目|更新)`).exec(s);
    if (firstYear !== null && !GUARANTOR_COND.test(guarantorItem(s, firstYear.index, firstYear.index + firstYear[0].length))) {
      if (stated.length < 3 && !stated.includes(c.s)) stated.push(c.s);
      return;
    }
    const near = new RegExp(`(?:保証会社|保証料|保証委託)[^。]{0,25}?${G_VALUE}`).exec(s);
    const nearAmount = near === null ? '' : (/([1-9][0-9,]*)\s*円/.exec(near[0])?.[1] ?? '').replace(/,/g, '');
    const nearMonthly = near !== null && (MONTHLY_G.test(s.slice(Math.max(0, near.index - 4), near.index + near[0].length + 4))
      || (nearAmount !== '' && monthlyAmounts.has(nearAmount)));
    if (GUARANTOR_INITIAL.test(s) || (initialCtx && near !== null && !nearMonthly) || underHeader) {
      if (stated.length < 3 && !stated.includes(c.s)) stated.push(c.s);
      return;
    }
    mentioned.push(c.s);
  });
  const r = ((): FeeProse | null => {
    if (none !== null) {
      const other = stated[0] ?? included ?? mentioned[0];
      return other === undefined ? { kind: 'zero', sentence: none } : { kind: 'conflict', sentence: `${none}／${other}` };
    }
    if (zero !== null) return stated.length > 0 ? { kind: 'conflict', sentence: `${zero}／${stated[0]}` } : { kind: 'zero', sentence: zero };
    if (stated.length > 0) return { kind: 'stated', sentence: stated.join('／') };
    if (included !== null) return { kind: 'included', sentence: included };
    if (mentioned.length > 0) return { kind: 'mentioned', sentence: mentioned[0] as string };
    return null;
  })();
  return r === null ? null : { ...r, sentence: unprepX(r.sentence) };
}

/**
 * 其他月費（第二十七輪後補）：說明文明寫、每月另付的兩種錢，歸其他月費（金額不採用）。
 * (1) 保證公司月費：「・月額保証料：1,830円」「・保証料月額（保証会社）：1,830円」「保証会社利用必須/月額800円」
 *    「（保証料月額支払合計1．2％）」「家賃保証加入必須（加入時￥37,000＋￥440/月）」「保証料：初回20,000円、毎月保証会社手数料」——
 *    不是初回保証料。只認真的月付（月額／毎月／月々／／月）：毎年、継続保証料、次年度是年費；「月額賃料30～50％」的月額是基數。
 * (2) 月付的事務手数料：「事務手数料：990円/月（税込）」（ソーシャルコート系列）——入居時的契約手数料不收它，這裡收。
 * (3) 其他具名的月付固定費（第二十八輪 3155「・月額あんしんサポート料1,500円（税込）」）：サポート料、町会費、家族会費、設備費、
 *    補償料、口座振替／賃料引落し手数料、寫成月付的家財保険（「【その他費用】家財保険：512円/月」——火災保険欄只收入居時一次付的）。
 *    停車、單車、音樂室這類用了才付的不收；任意、希望、オプション、場合、利用時也不收。
 * 條件式（場合、もしくは、原則、審査）與活動字眼只看那一項本身；保證公司不要的不收。
 */
const NAMED_MONTHLY = /(?:あんしん|安心|入居者|生活|24時間)?サポート(?:料|費)?|町内?会費|自治会費|家族会費|設備費|補償料|(?:口座振替|賃料引落し?|引落し?)(?:事務)?手数料|(?:共用部)?(?:家財|火災|住宅)保険料?/g;
// 「補償料月1500円」（TSH 2745 note，第三十輪）：費用名詞後直接「月＋金額」
const MONTHLY_MARK = /月額|毎月|月々|[/／\uE000]\s*月(?!分)|[（(]\s*月額?\s*[）)]|(?<![0-9０-９ヶヵかカケ今来先前翌初])月\s*[1-9][0-9,，]*\s*円/;
const OPTIONAL_X = /任意|希望|オプション|場合|利用時|利用料/;
const MONTHLY_ONLY_G = /月額(?!賃料|家賃|総家賃|総賃料|賃料総額|金額|総費用|支払い?家賃|賃料等)|毎月(?!家賃|賃料)|月々|[/／\uE000]\s*月(?!分)/;
const YEARLY_G = /毎年|[/／\uE000]\s*年|継続保証料|次年度|年毎|1\s*年ごと/;
const G_TERM_RE = /保証会社|保証料|保証委託|家賃保証/g;
export function proseOtherMonthly(text: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => { const u = unprepX(s); if (out.length < 3 && !out.includes(u)) out.push(u); };
  for (const c of sentencesWithContext(prepX(text))) {
    // 「事務\u200b手数料：990 円/月(税込)」（零寬空白夾在字中間）：比對時去掉，引句照原文
    const s = c.s.replace(NOT_GUARANTOR, '').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    // (2) 月付事務手数料：條件只看這一項（同句「ベッドパッド・シーツ(ベッド利用の場合)」講的是寢具）
    const adm = new RegExp(String.raw`事務手数料\s*[：:]?\s*${VALUE}\s*[（(]?\s*(?:税込)?\s*[）)]?\s*[/／]\s*月(?!分)`).exec(s);
    if (adm !== null && !/場合|オプション|任意/.test(itemAround(s, adm.index, adm.index + adm[0].length))) { push(c.s); continue; }
    // (3) 其他具名月付固定費
    let named3 = false;
    for (const m of s.matchAll(NAMED_MONTHLY)) {
      // ※ 之後是附註（「PLENDYサポート月額1,650円（税込）※キャンペーンで3ヶ月間無料」：活動只免頭幾個月，這筆月費照樣存在）
      const item = itemAround(s, m.index ?? 0, (m.index ?? 0) + m[0].length).split('※')[0] ?? '';
      if (!MONTHLY_MARK.test(item) || OPTIONAL_X.test(item) || GUARANTOR_COND.test(item) || ZERO_WORD_X.test(item)) continue;
      if (!new RegExp(VALUE).test(item) && !/(?:毎月|月額)[^。]{0,12}?(?:かかり|必要|発生|頂)/.test(item)) continue;
      named3 = true; break;
    }
    if (named3) { push(c.s); continue; }
    // (4) 押金名詞卻寫成月額（第三十一輪 TSH 3249 房間備考「保証金：月2,000円／原則保証会社が必須となります」）：
    // 押金不會按月付，這是每月要付的一筆錢——是不是保證公司月費分不出來，只記「原站明寫要付」，金額不採用
    const depMonthly = /(?:保証金|敷金|デポジット)\s*[：:]?\s*(?:月額?|毎月|月々)\s*[1-9][0-9,]*\s*円/.exec(s);
    if (depMonthly !== null && !/場合|オプション|任意/.test(itemAround(s, depMonthly.index, depMonthly.index + depMonthly[0].length))) { push(c.s); continue; }
    if (GUARANTOR_NONE.test(s)) continue;
    // 「月々のお支払いは賃料+共益費+保証会社利用料3%です」（2903）：整句講的是每月要付的
    const monthlySentence = /^月々の(?:お)?支払い?/.test(s);
    let hit = false;
    for (const g of s.matchAll(G_TERM_RE)) {
      const at = g.index ?? 0;
      const item = guarantorItem(s, at, at + g[0].length);
      if (GUARANTOR_COND.test(item) || CAMPAIGN.test(item)) continue;
      // 名詞本身就是月費、沒寫金額：「毎月保証会社手数料」「保証会社加入（月額支払い）」
      const named = /(?:毎月|月額|月々)の?(?:保証会社|保証料|保証委託)(?:手数料|利用料|料)?|(?:保証会社|保証料)[^。]{0,8}?[（(]\s*月額支払い?\s*[）)]/.exec(s.slice(Math.max(0, at - 3), at + g[0].length + 12));
      if (named !== null && !ZERO_WORD_X.test(s.slice(Math.max(0, at - 3) + named.index, Math.max(0, at - 3) + named.index + named[0].length + 8))) { hit = true; break; }
      // 名詞後 40 字內的每個金額：金額前 12 字、後 4 字內有月付字眼（「保証料月額（保証会社）：1,830円」），沒有年費字眼
      const win = s.slice(at, at + 40);
      for (const v of win.matchAll(new RegExp(G_VALUE, 'g'))) {
        const vi = at + (v.index ?? 0);
        const span = s.slice(Math.max(0, vi - 12), vi + v[0].length + 4);
        if ((monthlySentence || MONTHLY_ONLY_G.test(span)) && !YEARLY_G.test(span)) { hit = true; break; }
      }
      if (hit) break;
    }
    // 「保証会社加入要（初回保証料10,000円、毎月1500円が月額保証料として必要）」：保證那一項之後、緊接的下一段以月付開頭
    if (!hit && G_TERM_RE.test(s)) {
      G_TERM_RE.lastIndex = 0;
      const next = s.split(/[、,，](?![0-9])/).find((p, i) => i > 0 && /^\s*(?:以降|以後|その後)?\s*(?:毎月|月額|月々)/.test(p) && new RegExp(G_VALUE).test(p));
      if (next !== undefined && !GUARANTOR_COND.test(next) && !YEARLY_G.test(next) && /保証|以降|以後|その後/.test(next + s.slice(0, s.indexOf(next)).slice(-12))) hit = true;
    }
    G_TERM_RE.lastIndex = 0;
    if (hit) push(c.s);
  }
  return out;
}

// ── 更新料／更新事務手数料（含定期借家的再契約）──

// 字面對應：「〜料」＝更新料（renewalFee），「〜手数料」＝更新事務手数料（renewalAdminFee）；「再契約料（更新料）」原站自己就畫等號
const RENEWAL_FEE = String.raw`更新料|再契約料`;
// 「■再契約2回目から手料/5,500円」（3921，原站漏了「数」字，第二十九輪）
const RENEWAL_ADMIN = String.raw`更新(?:時の?)?(?:事務)?手数料|再契約(?:時の?)?(?:事務)?手数料|再契約時は事務手数料|再契約[0-9]*回目から手数?料`;
/**
 * 保證公司自己的續約費不是租約的更新料：「・保証会社加入必須（初回保証料 総賃料の50％～ 更新料10000円※1年毎）」（4317）、
 * 「・家賃保証会社：1万円（毎年更新料：1万円～1万5千円）」（1844）、「2.家賃保証会社…初回￥10000／年、更新時￥10000／年」（3666）。
 * 以保證公司開頭的條列整項拿掉，句中「保証会社…（…）」的括號也拿掉。
 */
function withoutGuarantorItems(text: string): string {
  return text.split('\n').map((line) => line
    // 括號收尾後隔空白接的是下一項（3943「・家賃保証会社：不要（緊急連絡先に…） 更新料または再契約料 20,000円」）
    .split(/(?=(?<![0-9])[0-9]{1,2}[.．](?![0-9]))|(?=[①-⑳・■●◆])|(?<=。)|(?<=[）)])(?=\s)/)
    // 拿掉的那一項留「…」：輸出的原句才看得出中間省略過（原文稽核把「…」當省略號）
    .map((seg) => (/^[\s・■●◆※*＊0-9.．、①-⑳()（）【】[\]]*(?:家賃)?保証(?:会社|料|委託)/.test(seg) ? ' …' : seg))
    .join('')
    .replace(/(?:保証会社|保証料|保証委託)[^（(\n、・,，]{0,20}[（(][^）)\n]*[）)]/g, ''))
    .join('\n');
}
// 「再契約時は事務手数料や更新料などの家賃・共益費以外の費用は一切かかりません」（17 棟）、「更新時には更新料などの費用は一切かからず」（1999）、
// 「※入居後の更新手続に関する費用は発生しません」（3423）、「再契約にかかる費用も０円♪」（1201）：兩項都免收
const RENEWAL_ALL_ZERO = new RegExp([
  String.raw`(?:再契約|更新)(?:時|の際)(?:に|は|も|には)?[^。]{0,40}?(?:費用|手数料|更新料)[^。]{0,30}?(?:一切)?(?:かかりません|かからず|不要|ありません|頂きません|いただきません|発生(?:いた)?しません|請求(?:いた)?しません)`,
  String.raw`(?:再契約|更新)(?:手続き?)?に(?:関する|かかる)費用[^。]{0,10}?(?:発生(?:いた)?しません|かかりません|ありません|不要|無料|[0０]円)`,
].join('|'));

export type RenewalProse = Partial<Record<'renewalFee' | 'renewalAdminFee', FeeProse>>;

export function proseRenewalFees(text: string): RenewalProse {
  const t = withoutGuarantorItems(prepX(text));
  const terms = { renewalFee: new RegExp(RENEWAL_FEE), renewalAdminFee: new RegExp(RENEWAL_ADMIN) };
  const zeros = zeroStatements(t, terms, ZERO_LIST_X, (s) => (RENEWAL_ALL_ZERO.test(s) ? ['更新料・更新事務手数料'] : []));
  const ss = proseSentences(t);
  const headers = headersOf(ss);
  // 「１年毎契約更新時 10,000円（火災保険料含む）」（2802）：沒寫名稱、緊接金額的「更新時」也是更新料
  const stated: Record<'renewalFee' | 'renewalAdminFee', string[]> = {
    renewalFee: statedSentences(ss, String.raw`${RENEWAL_FEE}|(?:契約)?更新時(?=\s*[：:]?\s*[￥¥0-9])`),
    renewalAdminFee: statedSentences(ss, RENEWAL_ADMIN),
  };
  const add = (k: 'renewalFee' | 'renewalAdminFee', s: string): void => {
    if (stated[k].length < 3 && !stated[k].includes(s)) stated[k].push(s);
  };
  const ownTerm = new RegExp(`${RENEWAL_FEE}|${RENEWAL_ADMIN}`);
  ss.forEach((s, i) => {
    if (GENERIC_X.test(s)) return;
    // 「※契約更新時：入館費相当額がかかります」（4301）「再契約の際、賃料の30,000円が発生いたします」（1748）：更新時要付一筆錢、沒寫名稱
    if (!ownTerm.test(s) && /(?:契約)?(?:更新|再契約)(?:時|の際)[^。]{0,24}?(?:かかります|かかる|必要(?:です|となります)|発生)/.test(s)
      && !ZERO_WORD_X.test(s) && !/不可|可能/.test(s)) add('renewalFee', s);
    // 單獨一行的費用名（「・再契約料（更新料）」下一行「※初回再契約時は免除」，3879）：原站把它列為一項費用
    const solo = new RegExp(`^[・〇○●◎■◆※\\s]*(?:再契約時|更新時)?(${RENEWAL_FEE}|${RENEWAL_ADMIN})(?:\\s*[（(][^）)]*[）)])?\\s*[※*＊]?$`).exec(s);
    if (solo !== null) {
      const next = ss[i + 1] ?? '';
      const nextZero = !/初回/.test(next) && ZERO_WORD_X.test(next);
      if (!nextZero && !new RegExp(VALUE).test(next)) add(new RegExp(`^(?:${RENEWAL_ADMIN})$`).test(solo[1] ?? '') ? 'renewalAdminFee' : 'renewalFee', s);
    }
    // 【再契約費用】小標下的「①事務手数料22,000円（税込）」（2517）
    const h = headers[i] ?? '';
    if (RENEW_HEADER.test(h) && !INITIAL_HEADER.test(h.replace(/再契約時?/g, '')) && new RegExp(`事務手数料[^。]{0,10}?${VALUE}`).test(s) && !ZERO_WORD_X.test(s)) {
      add('renewalAdminFee', `${h}／${s}`);
    }
  });
  const out: RenewalProse = {};
  for (const k of ['renewalFee', 'renewalAdminFee'] as const) {
    const z = zeros[k];
    if (z !== undefined && stated[k].length > 0) out[k] = { kind: 'conflict', sentence: unprepX(`${z}／${stated[k][0]}`) };
    else if (z !== undefined) out[k] = { kind: 'zero', sentence: unprepX(z) };
    else if (stated[k].length > 0) out[k] = { kind: 'stated', sentence: unprepX(stated[k].join('／')) };
  }
  return out;
}

// ── 清掃費（入居時收／退去時收）──

const CLEAN_TERM = new RegExp(`${CLEAN_NOUN}|(?:ルーム|ハウス)?クリーニング(?=\\s*[：:]\\s*[0-9])`);
// 不是住客要付的清掃費：洗衣店（「スーパー、クリーニング店」）、清掃服務、共用部清掃（含在共益費的組成裡）、冷氣清洗另列
const CLEAN_NOT_FEE = /クリーニング(?:店|屋|や|の手配)|清掃サービス|(?:共用部?分?|共有部?分?|館内|管理)の?(?:清掃|掃除)(?:費用?|代|料)?|エアコン(?:の)?(?:クリーニング|洗浄)(?:費用?|代)?|(?:清掃|クリーニング)[：:]\s*週|業者による(?:清掃|掃除)/g;
// 從押金扣的清掃費是押金不退的部分（depositNonRefundable），不是另一筆清掃費：
// 「保証金は退去時に清掃代5000円を差し引き、返却」「※デポジットは、退去時のクリーニング費用として償却します」「ドミトリー2万円（各 退去時清掃費として半額償却）」
const CLEAN_DEDUCT = /(?:保証金|デポジット|預か?り金|敷金)[^。]{0,40}?(?:償却|差し引|差引|控除|相殺|充当|引いて|を引き|焼却|引き)|(?:償却|差し引|差引|控除)[^。]{0,10}?(?:保証金|デポジット|預か?り金)|(?:清掃|クリーニング)(?:費用?|代|料)?として[^。]{0,15}?(?:償却|差し引|差引|控除|相殺|充当|引)/;
const EXIT_WORD = /退去|退室|退出|退居/;
// 明寫退租時才付：「※退去時にクリーニング費用 25,000円（税別）を頂戴しております」「ルームクリーニング代 16,500円（退去時支払い）」
const EXIT_PAY = /退去時(?:に|の)?(?:お?支払|払い(?!可))|退去時支払|退去時に[^。]{0,30}?(?:頂戴|請求|お支払|支払)/;

export type CleaningProse = Partial<Record<'cleaningFeeUpfront' | 'cleaningFeeOnExit', FeeProse & { timingUnstated?: boolean }>>;

/**
 * 清掃費要分「入居時收」與「退去時收」。
 * 入居時：費用名詞前後明寫 入居時／契約時／初回／前払（「退去後クリーニング費20,000円(入居時前払い)」），
 *   或在初期費用的條列裡（「初期費用：家賃1ヶ月分＋3万円（契約事務手数料/退去クリーニング費/…）」、小標【初回契約時費用】）。
 * 退去時：明寫退租時付，或名稱就是退去時清掃費、又沒寫入居時收。
 * 兩者都沒寫（「清掃費：39,600円(税込)」）：存入居時並註明「原文沒寫何時付」——寧可讓初期費用標成下界，不報成完整。
 */
export function proseCleaningFees(text: string): CleaningProse {
  const t = prepX(text);
  const zeros = zeroStatements(t, { cleaning: CLEAN_TERM }, ZERO_LIST_X);
  const ss = proseSentences(t);
  const headers = headersOf(ss);
  const up: string[] = [];
  const exit: string[] = [];
  const unsure: string[] = [];
  let included: string | null = null;
  const push = (list: string[], s: string): void => { if (list.length < 3 && !list.includes(s)) list.push(s); };
  ss.forEach((raw, i) => {
    const s = raw.replace(CLEAN_NOT_FEE, '');
    const m = CLEAN_TERM.exec(s);
    if (m === null || CLEAN_DEDUCT.test(s) || GENERIC_X.test(s)) return;
    // 「※事務手数料や個室清掃費などを含む契約時のみお支払い頂く料金です」接在「契約手数料」小標後（2564 等 27 棟）：含在契約手數料裡
    if (/(?:清掃|クリーニング)(?:費用?|代|料)[^。]{0,8}?を?含む[^。]{0,20}?(?:契約時|入居時|初回)/.test(s) && /契約手数料|事務手数料/.test(ss[i - 1] ?? '')) {
      included ??= raw;
      return;
    }
    const hasAmount = statedSentences([s], CLEAN_TERM.source).length > 0
      || new RegExp(`${VALUE}[^。、]{0,12}?(?:${CLEAN_TERM.source})`).test(s);
    // 沒寫金額時要明寫「要付」：「退去時にクリーニング費用がかかります」（3249）、「退去時クリーニング代・エアコン洗浄代あり」（2531）。
    // 帶條件的不算（「状態がひどい場合別途クリーニング費用をご負担頂きます」、「退去時に清掃代を請求する場合あり」）
    const after = s.slice(m.index, m.index + m[0].length + 20);
    // 費用小標下的條列（866「契約時費用：退去時クリーニング費用、賃貸住宅総合保険」，第二十九輪）：列在要付的清單裡就是要付
    const listedUnderCost = COST_HEADER.test(s.slice(0, m.index)) && !ZERO_WORD_X.test(listItem(s, m.index, m.index + m[0].length));
    const statedNoAmt = !hasAmount && ((/かかります|必要|発生|あり|頂戴|申し受け|請求/.test(after) && !/場合/.test(s) && !ZERO_WORD_X.test(after)) || listedUnderCost);
    if (!hasAmount && !statedNoAmt) return;
    const at = m.index;
    const before = s.slice(0, at);
    // 分句界線不含數字裡的千分位逗號（「清掃費:15,000円（ご契約時のみ）」）
    const clauseAfter = s.slice(at, at + m[0].length + 30).split(/、|[，,](?![0-9])|┃|\s{2,}/)[0] ?? '';
    // 初期費用的條列從「初期費用：」「初回に」「契約金」一路列到這一項，中間沒有關掉的括號
    //（「初期費用（礼金…、初回保証料…） 退去時クリーニング代」的清掃費不在括號裡）
    const listedInitial = /(?:初回|入居時|(?<!再)契約時|初期費用|入居時費用|(?<![再解新])契約金)(?:に|は|：|:|\/|／)?[^。）)]*$/.test(before);
    // 「初期費用は17，000円（家賃以外） 内訳：退去時清掃費10，000円と…」（1463）：內訳列的是初期費用
    const breakdown = /内訳[：:]?[^。）)]*$/.test(before) && INITIAL_WORDS.test(before);
    const initial = listedInitial || breakdown || INITIAL_WORDS.test(clauseAfter) || INITIAL_WORDS.test(s.slice(Math.max(0, at - 6), at))
      || INITIAL_HEADER.test(headers[i] ?? '') || (/^内訳/.test(s) && INITIAL_WORDS.test(ss[i - 1] ?? ''));
    const exitPay = EXIT_PAY.test(s.slice(Math.max(0, at - 12), at + m[0].length + 40));
    const exitNamed = EXIT_WORD.test(m[0]) || EXIT_WORD.test(s.slice(Math.max(0, at - 12), at)) || EXIT_WORD.test(clauseAfter);
    if (exitPay) push(exit, raw);
    else if (initial) push(up, raw);
    else if (exitNamed) push(exit, raw);
    else push(unsure, raw);
  });
  const out: CleaningProse = {};
  const z = zeros.cleaning === undefined ? undefined : unprepX(zeros.cleaning);
  for (const list of [up, exit, unsure]) list.forEach((x, j) => { list[j] = unprepX(x); });
  if (included !== null) included = unprepX(included);
  // 免收句只講退去時（4027／4028「＜更新料、退去時のクリーニング費用等＞・なし」）：只有退去清掃費是 0，入居時的頁面沒寫；
  // 只講入居時的反之。兩個都寫或都沒寫才兩欄一起 0（第二十七輪）
  const zExit = z !== undefined && EXIT_WORD.test(z) && !INITIAL_WORDS.test(z);
  const zUp = z !== undefined && INITIAL_WORDS.test(z) && !EXIT_WORD.test(z);
  if (z !== undefined && zExit) {
    if (exit.length > 0) out.cleaningFeeOnExit = { kind: 'conflict', sentence: `${z}／${exit[0]}` };
    else out.cleaningFeeOnExit = { kind: 'zero', sentence: z };
    if (up.length > 0) out.cleaningFeeUpfront = { kind: 'stated', sentence: up.join('／') };
    else if (unsure.length > 0) out.cleaningFeeUpfront = { kind: 'stated', sentence: unsure.join('／'), timingUnstated: true };
    else if (included !== null) out.cleaningFeeUpfront = { kind: 'included', sentence: included };
    return out;
  }
  if (z !== undefined && zUp) {
    const other = up[0] ?? unsure[0] ?? included;
    out.cleaningFeeUpfront = other === undefined || other === null ? { kind: 'zero', sentence: z } : { kind: 'conflict', sentence: `${z}／${other}` };
    if (exit.length > 0) out.cleaningFeeOnExit = { kind: 'stated', sentence: exit.join('／') };
    return out;
  }
  const anyStated = up.length + exit.length + unsure.length > 0;
  if (z !== undefined && !anyStated && included === null) {
    out.cleaningFeeUpfront = { kind: 'zero', sentence: z };
    out.cleaningFeeOnExit = { kind: 'zero', sentence: z };
    return out;
  }
  if (z !== undefined && anyStated) {
    const other = up[0] ?? exit[0] ?? unsure[0] ?? '';
    out.cleaningFeeUpfront = { kind: 'conflict', sentence: `${z}／${other}` };
    return out;
  }
  // 同棟已寫明退去時收、另幾句只是房型或人數的變體（700「※退去時にクリーニング費用 39,000円」與「※23㎡の居室クリーニング費用 45,000円」）：
  // 是同一筆退去清掃費，不另立一筆入居時的
  if (exit.length > 0 && up.length === 0) for (const s of unsure) push(exit, s);
  else if (up.length > 0) out.cleaningFeeUpfront = { kind: 'stated', sentence: up.join('／') };
  else if (unsure.length > 0) out.cleaningFeeUpfront = { kind: 'stated', sentence: unsure.join('／'), timingUnstated: true };
  else if (included !== null) out.cleaningFeeUpfront = { kind: 'included', sentence: included };
  if (exit.length > 0) out.cleaningFeeOnExit = { kind: 'stated', sentence: exit.join('／') };
  return out;
}

// ── 網路費 ──

// 「高速の光ネット無料」（2359）「光ネット入居中使い放題&無料」（2142）（第二十七輪）
/** 「共益費12000円で、ガス、電気、水道、無線LAN…」：「（金額）で、」後面只列那筆費用涵蓋的項目（TSH 841 note，第三十四輪）。 */
const FEE_COVERS = String.raw`(?:共益費|管理費)\s*[0-9０-９,，]+\s*円\s*で[、,]\s*(?:(?:電気|ガス|水道|光熱費?|インターネット|ネット|無線LAN|Wi-?Fi)(?:代|料|費)?[・、,／/\s]*){3,}`;
const NET = /インターネット|ｲﾝﾀｰﾈｯﾄ|Wi-?Fi|WI-?FI|WiFi|wifi|Wifi|ＷｉＦｉ|ｗｉｆｉ|ネット(?:代|料金?|使用料|利用料|環境|回線)|光ネット|光回線|無線LAN|有線LAN/i;
// 只講共用空間的網路（「インターネット共有部無料、専有部WIFI導入済み」809、「コミュニティスペース内のWi-Fi」3237）：房內網路要不要錢沒說
const NET_SHARED_ONLY = /(?:共有部|共用部|共有スペース|コミュニティスペース|リビング|ラウンジ)(?:内)?の?\s*(?:インターネット|Wi-?Fi|WiFi|wifi|ＷｉＦｉ)|(?:インターネット|Wi-?Fi|WiFi|wifi)\s*共有部/i;
const NET_INCLUDED = new RegExp([
  // 網路詞在前、含／込在後（「※水光熱費にインターネット使用料が含まれます」「水道光熱費インターネット込み」「水光熱費Wi-Fiコミコミ」）
  String.raw`(?:${NET.source})[^。]{0,80}?(?:含ま|含む|含め|含ん|含み(?!ません)|ふくま|コミコミ|込み込み|(?<!申し?)込み|(?<!申し?)込(?=です|[、。！!♪）)\s]|$))`,
  // 共益費的括號組成（「・共益費（水道光熱費インターネット等）：12,000円/月」3879、「※共益費内訳（電気・ガス・水道・wifi…」4471）
  String.raw`(?:共益費|管理費)(?:内訳)?[（(](?![^）)]*(?:別|除|以外|実費|個別))[^）)]*(?:${NET.source})[^）)]*[）)]`,
  // 「共益費電気・ガス・水道・インターネット料/16,000円」（3921）
  String.raw`(?:共益費|管理費)[：:\s]*(?:(?:電気|ガス|水道|光熱費?|インターネット|ネット|Wi-?Fi)(?:代|料|費)?[・、,／/\s]*){3,}`,
  // 「共益費12000円で、ガス、電気、水道、無線LAN、スカパー」（841，第三十四輪）
  String.raw`(?=[^。]*(?:${NET.source}))${FEE_COVERS}`,
].join('|'), 'i');
const NET_ZERO = new RegExp(String.raw`(?:${NET.source})[^。、]{0,14}?(?<!有)無料(?!サービス中)|無料(?:の)?\s*(?:光)?(?:${NET.source})`, 'i');
// 「ネットwi-fi使用は有料2,200円/月です」（1310）「インターネットは１,０００円です」（2150）「※個室の電気・インターネット料金は個別契約」（4219）
const NET_EXCLUDED = new RegExp(String.raw`(?:${NET.source})[^。]{0,20}?(?:${VALUE}|有料)|(?:${NET.source})[^。]{0,12}?(?:個別契約|個人契約|各自契約|実費|別途)`, 'i');

/**
 * 網路費。zero：明寫網路免費；included：明寫含在共益費／房租／水電費裡（金額不另計）；
 * stated：明寫另付（月費、個別契約；金額不採用）；conflict：兩種說法並存。
 * 選配（「WiFi 2,000円（オプション）」3375）、超額另收（「…インターネット、水道の合計が１人10,000円を超えた場合には追加徴収」2761）不算。
 */
export function proseInternet(text: string): FeeProse | null {
  let unadopted: string | null = null;
  let zero: string | null = null;
  let included: string | null = null;
  let stated: string | null = null;
  for (const c of sentencesWithContext(toHalfDigits(text))) {
    const { s } = c;
    if (!NET.test(s) || NET_SHARED_ONLY.test(s)) continue;
    // 「有線LANタイプ1,000円」（736）：可選的類型，同選配
    if (/超え|超過|上限|オプション|任意|希望者|タイプ/.test(s)) continue;
    // 條件只看網路那一段：「インターネット無料 条件付きで4.08万円」（3697 房間備考）的條件講的是房租
    const m = NET.exec(s);
    const clause = m === null ? s : clauseAround(s, m.index, m.index + m[0].length);
    const conditional = CAMPAIGN.test(c.context) || CONDITION.test(clause.replace(/^[※*＊]/, ''));
    // 「含在共益費」講的是那筆月費涵蓋什麼；活動只減免費用、不改涵蓋範圍——活動與條件只看這句本身。332「毎月のお支払い 家賃＋共益費：10,000円
    //（水道,共有部分電気,ガス,音楽スタジオ,Wi-Fi代などを含む)」前面同一段有「新規契約の方は…1万円キャッシュバック」（第三十輪）
    if (NET_INCLUDED.test(s)) { if (!CONDITION.test(s.replace(/^[※*＊]/, ''))) included ??= s; continue; }
    // 附條件的免收（「キャンペーン中はWi-Fi無料」）：值照舊未知，但頁面談到了網路，回報給呼叫端標「頁面有提到、未採用」（第三十二輪）
    if (NET_ZERO.test(s)) { if (!conditional) zero ??= s; else unadopted ??= s; continue; }
    // 「家賃にインターネット（無線 光）水光熱費など10000円」（3550）：講的是房租含網路，只是沒寫「含」——不當另付
    if (/(?:家賃|賃料|共益費|管理費)に\s*(?:インターネット|ネット|Wi-?Fi)/i.test(s)) continue;
    if (NET_EXCLUDED.test(s)) stated ??= s;
  }
  const free = included ?? zero;
  if (free !== null && stated !== null) return { kind: 'conflict', sentence: `${free}／${stated}` };
  if (included !== null) return { kind: 'included', sentence: included };
  if (zero !== null) return { kind: 'zero', sentence: zero };
  if (stated !== null) return { kind: 'stated', sentence: stated };
  if (unadopted !== null) return { kind: 'unadopted', sentence: unadopted };
  return null;
}

// ── 第三十輪補的三種寫法 ──

/**
 * 總括免收句：「家賃と共益費以外の費用が、かからないので、とてもリーズナブルです」（TSH 2227、2376、3441，同一業者）。
 * 原文明寫房租與共益費以外不收任何費用——呼叫端只用它補「頁面沒有其他說法」的費用欄（存 0）。
 * 只講再契約／更新時的（「再契約時は事務手数料や更新料などの家賃・共益費以外の費用は一切かかりません」）不算，那是更新費的事。
 */
export function proseOnlyRentAndCommonFee(text: string): { sentence: string; conditional: boolean } | null {
  const ALL_FREE = /(?:家賃|賃料)(?:と|・|＋|\+)共益費以外の(?:費用|お金|料金)(?:が|は)?[、,]?\s*(?:一切)?(?:かからない|かかりません|掛からない|掛かりません|不要)/;
  let cond: string | null = null;
  for (const c of sentencesWithContext(text)) {
    if (!ALL_FREE.test(c.s) || /再契約|更新/.test(c.s)) continue;
    // 附近有活動或條件字眼（2227 後面是「期間限定キャンペーン…お家賃半額キャンペーン」）：照舊不採用，但回報給呼叫端標「頁面有提到」
    if (isConditional(c)) { cond ??= c.s; continue; }
    return { sentence: c.s, conditional: false };
  }
  return cond === null ? null : { sentence: cond, conditional: true };
}

/**
 * 只寫「保険」含在共益費裡（「共益費（水光熱費・wi-fi・保険含む）」TSH 3513、3820、2574、4199）：
 * 沒寫是火災／家財保険還是共用部的建物保險——不當成火災保険已含（那會讓初期費用看起來比較完整），
 * 只回傳原句，讓呼叫端把「此來源不公開」改成「頁面提到、沒寫清楚」。
 */
export function proseBareInsuranceInCommonFee(text: string): string | null {
  const BARE = /(?:共益費|管理費)[^。]{0,40}?(?<![火災家財賠償住宅]|保証)保険(?!料|証|会社)[^。]{0,20}?(?:含|込)/;
  for (const s of proseSentences(text)) if (BARE.test(s) && !TERM_OF.fireInsurance.test(s)) return s;
  return null;
}

/**
 * 說明文寫保証金要償却（「保証金1ヶ月分（入居時50％償却）」TSH 282 note、「保証金は手数料として償却。」3565 note）。
 * 比例與基數都不自動採用（基數可能與入居条件表不同，見 3764）——呼叫端只在入居条件表沒寫償却時，
 * 把押金不退部分從「頁面沒寫」改成「原站明寫有、金額未採用」。
 */
export function proseDepositAmortized(text: string): string | null {
  for (const c of sentencesWithContext(text)) {
    if (/(?:保証金|敷金|デポジット)[^。]{0,30}?償却/.test(c.s) && !isConditional(c)) return c.s;
  }
  return null;
}

// ── 2026-10-17 第三十一輪：「初期費用は…のみ」「毎月の支払いは…のみ」型總括句 ───────────────────────────────

/** 括號內容換成等長的佔位（索引不變，引句照原文切）：「水道光熱費（実費。公平に案分。…）」裡的句號不算句尾。 */
function maskParens(s: string): string {
  return s.replace(/[（(][^（()）]*[）)]/g, (m) => `（${'＿'.repeat(Math.max(0, m.length - 2))}）`);
}
const ONLY_QUOTES = /[「」『』\s]/g;
const ONLY_AMOUNT = /[￥¥]?\s*[0-9][0-9,，.]*\s*万?円?|(?:家賃|賃料)?[0-9.]+\s*[ヶかカヵケ]月分?/g;
/** 房租／日割り／共益費（含「日割り賃料32800円÷31×12=12700円」這種算式）。 */
function rentPart(p: string): boolean {
  if (!/家賃|賃料|共益費|管理費/.test(p)) return false;
  return p.replace(ONLY_QUOTES, '')
    .replace(/入居(?:さ?れる|する)?(?:月|日)|初月|当月|翌月|月末まで|日割り?|前家賃|家賃|賃料|共益費|管理費|分|の|から|・/g, '')
    .replace(/[0-9,，.]+\s*円?|[÷×=＝*\/＋+\-－]/g, '') === '';
}
/** 押金（「返金可能なデポジット3万円」「保証金￥30000」「デポジットの20000円」）。 */
function depositPart(p: string): boolean {
  if (!/保証金|デポジット|敷金/.test(p)) return false;
  return p.replace(ONLY_QUOTES, '').replace(/保証金|デポジット|敷金/g, '').replace(ONLY_AMOUNT, '')
    .replace(/返金可能な|返金される|返還される|全額返金の?|返金あり|[=＝：:]|の/g, '') === '';
}
/** 帶金額的具名費用（「事務手数料1.5万円」）：回傳費用名詞；認不得回 null。 */
function namedFeePart(p: string): string | null {
  const t = p.replace(ONLY_QUOTES, '');
  const m = new RegExp(`${ITEM}|${CLEAN_NOUN}|(?:火災|家財)?保険料?`).exec(t);
  if (m === null || !/[0-9]/.test(t)) return null;
  const rest = t.replace(m[0], '').replace(ONLY_AMOUNT, '').replace(/[（(]?税(?:込|別|抜)[）)]?|初回|の|[：:]/g, '');
  return rest === '' ? m[0] : null;
}

/**
 * 「初期費用は…のみ」（3163「【初期費用】は「保証金￥30000」＋「入居する月の日割り賃料」のみ（その他の手数料等はナシ）」、
 * 332「初期費用は日割り家賃と返金可能なデポジット3万円のみ」、3275「初期費用：初月分の賃料日割りと事務手数料1.5万円のみ」），
 * 以及初期費用例後面的「それ以外にかかる費用は一切ございません」（2493、2220）：入居時除了清單上的錢，其他一律不收。
 * 清單每一項都要認得出來（房租／日割り／共益費、押金、帶金額的費用名詞、合計）；有一項認不得就整句不算——
 * 793「初期費用は3万円＋初回保証料1.5万円のみ」的 3万円、3500「初期費用①＋②のみ」不知道含了什麼。
 * 「保証金は初期費用として30,000円のみ」講的是押金、「入居時の初期費用にのみ事務手数料…」講的是那一項，都不是清單。
 * 回傳原句、清單裡出現的具名費用（呼叫端確認「明寫要付」的欄位都在清單裡才採用）、附近有沒有條件或活動字眼。
 */
export function proseInitialOnly(text: string): { sentence: string; listed: string[]; conditional: boolean } | null {
  // 「最初にお支払い頂く費用は、「デポジット＋入居される日から月末までの日割り賃料」のみでございます」（2142，▼初期費用▼ 小標下，第三十二輪）
  const HEAD = /(?:^|[【「『▼■・●◆\s])(?:初期費用|入居時の?費用|契約時の?費用|入居費用|最初にお?支払い?(?:頂|いただ)く(?:費用|お金|金額))\s*[】」』]?\s*(?:は|：|:)[、,]?\s*/;
  const REST = /^[※*＊・]?\s*(?:それ|上記|これ)以外に?(?:かかる|必要な|発生する)?(?:費用|お金|料金|初期費用)は(?:一切)?(?:ございません|ありません|かかりません|発生しません|不要)/;
  const HEADER_LINE = /初期費用例?\s*[▼▲】＞>]*\s*$/;
  let cond: { sentence: string; listed: string[]; conditional: boolean } | null = null;
  const blocks = text.split(BLOCK_BREAK);
  for (const block of blocks) {
    const cs = sentencesWithContext(block);
    for (const [i, c] of cs.entries()) {
      let hit: { sentence: string; listed: string[] } | null = null;
      const h = HEAD.exec(c.s);
      const only = h === null ? -1 : c.s.indexOf('のみ', h.index + h[0].length);
      if (h !== null && only > 0) {
        const list = c.s.slice(h.index + h[0].length, only);
        const parts = list.split(/[＋+、]|と|および|及び/).map((x) => x.trim()).filter((x) => x !== '');
        const listed: string[] = [];
        const ok = parts.length > 0 && parts.every((p) => {
          if (rentPart(p) || depositPart(p)) return true;
          const n = namedFeePart(p);
          if (n !== null) listed.push(n);
          return n !== null;
        });
        if (ok) hit = { sentence: c.s, listed };
      } else if (REST.test(c.s)) {
        // 往前找初期費用的小標，中間每一行都要是認得出來的組成（「日割り賃料32800円÷31×12=12700円 デポジット30000円 計42700円」）
        const lines: string[] = [];
        let found = false;
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          const t = cs[j]?.s ?? '';
          if (HEADER_LINE.test(t)) { lines.unshift(t); found = true; break; }
          const parts = t.split(/\s+/).filter((x) => x !== '');
          if (parts.length === 0 || !parts.every((p) => rentPart(p) || depositPart(p) || /^(?:合計|総額|計)[0-9,]+円$/.test(p))) break;
          lines.unshift(t);
        }
        if (found) hit = { sentence: [...lines, c.s].join('／'), listed: [] };
      }
      if (hit === null) continue;
      if (isConditional(c)) { cond ??= { ...hit, conditional: true }; continue; }
      return { ...hit, conditional: false };
    }
  }
  return cond;
}

/**
 * 「毎月の支払いは…のみ」（3163「【毎月かかる費用】は「賃料」＋「水道光熱費（実費。公平に案分。1カ月7000円～10000円が目安）」のみ」、
 * 3399「👉 毎月のお支払いは、「賃料＋共益費」のみ」）：每月除了清單上的錢，沒有其他月費。清單只認房租、共益費、水電、網路——
 * 有別的項目（保證公司月費等）就不算。條件只看這一句本身（同 proseUtilities 的「含」：3399 前面的活動講的是房租）。
 * 括號裡的句號不切句（3163）。回傳原文那一段與清單文字（呼叫端確認明寫另收的水電／網路都在清單裡才採用）。
 */
export function proseMonthlyOnly(text: string): { sentence: string; list: string; conditional: boolean } | null {
  const RE = /(?:【\s*)?(?:毎月(?:かかる|の)?|月々の?)(?:費用|お支払い?|支払い?)(?:\s*】)?\s*(?:は|：|:)[、,]?\s*([^。！!？?]{1,160}?)(?:のみ|だけ)/;
  const PART = /^(?:賃料|家賃|共益費|管理費|水道光熱費|水光熱費|光熱水費|光熱費|水道代|電気代|ガス代|インターネット(?:代|料|使用料)?|Wi-?Fi(?:代|料)?)$/;
  let cond: { sentence: string; list: string; conditional: boolean } | null = null;
  for (const line of text.split(/\n|\u2029/)) {
    const masked = maskParens(line);
    const m = RE.exec(masked);
    if (m === null || m[1] === undefined) continue;
    const parts = m[1].split(/[＋+・、と]/).map((p) => p.replace(ONLY_QUOTES, '').replace(/（＿*）/g, '')).filter((p) => p !== '');
    if (parts.length === 0 || !parts.every((p) => PART.test(p))) continue;
    const sentence = line.slice(m.index, m.index + m[0].length).trim();
    // 「のみ」「だけ」都是兩個字：清單在它們前面，索引與遮罩前相同
    const listAt = m.index + m[0].length - 2 - m[1].length;
    const list = line.slice(listAt, listAt + m[1].length);
    const conditional = CONDITION.test(sentence.replace(/^[※*＊]/, ''));
    if (conditional) { cond ??= { sentence, list, conditional }; continue; }
    return { sentence, list, conditional };
  }
  return cond;
}

/**
 * 說明文寫押金一毛不退（第三十一輪 TSH 1319 房間備考「※退室時、保証金返金はなし」，入居条件表卻寫「¥50,000（退去時¥20,000返却）」）。
 * 呼叫端只拿它和入居条件表比：表算出的不退金額不等於整筆押金時＝兩處說法不一。不退金額本身不從這句取。
 */
export function proseDepositNoRefund(text: string): string | null {
  const NO_REFUND = /(?:保証金|敷金|デポジット)[^。]{0,24}?(?:返金|返還|返却)(?:は|も)?\s*(?:なし|無し|ナシ|ありません|いたしません|致しません|しません|不可|できません|出来ません)/;
  for (const c of sentencesWithContext(text)) if (NO_REFUND.test(c.s) && !isConditional(c)) return c.s;
  return null;
}

/**
 * 引文換回原文寫法（第三十二輪 TSH 2062：「更新料全て【０円】」被引成「【0円】」）。判讀前會把全形數字轉成半形
 *（toHalfDigits、prepX），引文就跟原站對不上。srcText 裡每一段最外層「…」只要含數字，就在原文裡找「只差數字全半形與空白」
 * 的那一段換回原文；找不到（判讀時刪過字的，例如「（ただし…）」但書）就維持原樣。用「／」接起來的好幾句逐段找。
 */
export function verbatimQuotes(srcText: string, original: string): string {
  if (!/[0-9]/.test(srcText)) return srcText;
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[0-9]/g, (d) => `[${d}${String.fromCharCode(d.charCodeAt(0) + 0xfee0)}]`).replace(/\s+/g, '\\s+');
  const find = (q: string): string | null => {
    const body = q.trim();
    if (body === '' || !/[0-9]/.test(body)) return null;
    const m = new RegExp(esc(body)).exec(original);
    return m === null ? null : m[0].replace(/\s+/g, ' ');
  };
  const restore = (q: string): string => find(q) ?? q.split('／').map((p) => find(p) ?? p).join('／');
  let out = '';
  let depth = 0;
  let start = -1;
  for (let i = 0; i < srcText.length; i++) {
    const ch = srcText[i];
    if (ch === '「') { if (depth === 0) { start = i + 1; out += ch; } depth += 1; continue; }
    if (ch === '」' && depth > 0) {
      depth -= 1;
      if (depth === 0) { out += `${restore(srcText.slice(start, i))}」`; start = -1; }
      continue;
    }
    if (depth === 0) out += ch;
  }
  // 括號沒有收尾（被截斷的引文）：原樣接回
  return depth === 0 ? out : out + srcText.slice(start);
}
