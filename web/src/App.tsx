import { useEffect, useMemo, useState } from 'react';
import {
  loadWire, loadProv, query, queryToFilters, filtersToQuery, yen,
  buildingStations, lineBuildingCounts, kindGroup, monthlyWithAssumption, perM2Comparable,
  GENDER, type Wire, type Filters, type Prov, type MyProperty,
} from './data.ts';
import { summary, percentileRank, sortedAsc } from './stats.ts';
import { rowsToCsv, csvFileName, downloadCsv } from './csv.ts';
import { Histogram } from './Histogram.tsx';
import { layoutSizeRank } from '../../packages/jp-parse/src/layout.ts';

const GENDER_ZH: Record<string, string> = {
  unknown: '未提供', mixed: '男女皆可', female_only: '女性專用', male_only: '男性專用',
};
const UTIL_ZH = ['未提供', '含水電', '水電另計'];
const KIND_ZH: Record<string, string> = {
  unknown: '種類未知', apartment: '一般賃貸', sharehouse: '共居 share house', social: '共居 Social Residence', dormitory: '共居 多人房',
};
/**
 * 來源顯示名直接從資料的 dict.sourceMeta 讀（由各來源的 manifest.nameZh 產生），
 * 不在 UI 維護硬編碼對照表——否則每加一個來源就要記得改這裡，漏改會顯示成 id。
 */
const FIELD_ZH: Record<string, string> = {
  rent: '賃料', adminFee: '管理費／共益費', utilities: '水電費', internet: '網路費',
  otherMonthly: '其他月費', keyMoney: '禮金', deposit: '敷金（押金）',
  depositNonRefundable: '敷引（不退部分）', agencyFee: '仲介手數料',
  guarantorInitialFee: '保證公司初回', fireInsurance: '火災保險', keyExchangeFee: '換鎖費',
  contractFee: '契約手續費', cleaningFeeUpfront: '入住清潔費', otherInitial: '其他初期費用',
  renewalFee: '更新料', renewalAdminFee: '更新手續費', cleaningFeeOnExit: '退租清潔費',
  earlyTerminationPenalty: '短期解約違約金',
};
const WHY_ZH: Record<string, string> = {
  not_offered_by_source: '此來源不公開這個欄位',
  not_listed_on_page: '原站頁面未載明',
  unparsed: '解析失敗（有文字但讀不出來）',
  conflicting: '多處資料互相矛盾，不予採用',
};
/** 路線下拉：前 40 條常用線直接列，其餘收進「更多」 */
const TOP_LINES = 40;
/** A/B/C 三區的標籤：說的是「目前排序鍵」的完整度，所以文字跟著排序走。 */
const TIER_LABEL: Record<Filters['sort'], [string, string, string]> = {
  eff12: ['月額完整可比', '月額僅有下限', '月額資料不足'],
  monthly: ['月額完整可比', '月額僅有下限', '月額資料不足'],
  area: ['月額完整可比', '月額僅有下限', '月額資料不足'],
  initCash: ['初期費用完整', '初期費用僅有下限', '初期費用資料不足'],
  initSunk: ['初期費用完整', '初期費用僅有下限', '初期費用資料不足'],
  perM2: ['可算每㎡單價', '單價僅有下限', '算不出單價'],
};

function srcName(dict: Wire['dict'], srcIdx: number): string {
  const id = dict.sources[srcIdx] ?? '';
  return dict.sourceMeta[id]?.nameZh ?? id;
}

function useHashFilters(): [Filters, (f: Filters) => void] {
  const [f, setF] = useState<Filters>(() => queryToFilters(location.hash.slice(1)));
  useEffect(() => {
    const on = (): void => setF(queryToFilters(location.hash.slice(1)));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [f, (nf: Filters) => { location.hash = filtersToQuery(nf); }];
}

function Chip({ tone, children }: { tone?: 'good' | 'warn' | 'flat'; children: React.ReactNode }) {
  return <span className={`chip ${tone ?? 'flat'}`}>{children}</span>;
}

/** 多人房（床位）——面積是整間共用房，與單人賃料不同基準，所以不算每㎡單價。 */
function isDorm(w: Wire, i: number): boolean {
  const li = w.u.layout[i] as number;
  return (li >= 0 && w.dict.layouts[li] === 'ドミトリー')
    || w.dict.kinds[w.b.kind[w.u.bid[i] as number] as number] === 'dormitory';
}

/** 稀疏屬性標籤：只顯示來源「有寫」的，沒寫的不顯示也不暗示沒有。 */
function flagChips(w: Wire, flags: number): React.ReactNode[] {
  const fb = w.meta.flagBits;
  const has = (k: string): boolean => fb[k] !== undefined && (flags & (fb[k] as number)) !== 0;
  const out: React.ReactNode[] = [];
  if (has('petsYes')) out.push(<Chip key="pet" tone="good">可養寵物</Chip>);
  if (has('petsNo')) out.push(<Chip key="pet">不可養寵物</Chip>);
  if (has('furnishedYes')) out.push(<Chip key="fur" tone="good">附傢俱</Chip>);
  if (has('furnishedNo')) out.push(<Chip key="fur">無傢俱</Chip>);
  if (has('fixedTerm')) out.push(<Chip key="ct" tone="warn">定期借家（不可續約）</Chip>);
  if (has('ordinary')) out.push(<Chip key="ct">普通借家</Chip>);
  if (has('minStayKnown')) out.push(<Chip key="ms" tone="warn">有最短居住期間</Chip>);
  if (has('ageLimitKnown')) out.push(<Chip key="age" tone="warn">有年齡限制</Chip>);
  if (has('guarantorPersonYes')) out.push(<Chip key="gp" tone="warn">需連帶保證人</Chip>);
  if (has('guarantorPersonNo')) out.push(<Chip key="gp" tone="good">免連帶保證人</Chip>);
  return out;
}

function Detail({ wire, unitIdx, onClose }: { wire: Wire; unitIdx: number; onClose: () => void }) {
  const [p, setP] = useState<Prov | null | 'loading'>('loading');
  useEffect(() => { void loadProv(wire, unitIdx).then(setP); }, [wire, unitIdx]);

  return (
    <aside className="detail" role="dialog" aria-label="費用拆解">
      <button className="close" onClick={onClose} aria-label="關閉">✕</button>
      {p === 'loading' && <p>載入中…</p>}
      {p === null && <p>找不到這筆房源的明細。</p>}
      {p !== null && p !== 'loading' && (
        <>
          <h2>費用拆解</h2>
          <p className="muted">
            每一欄都標了「原站原文」。抓不到的欄位顯示為未提供，<b>不會用推估值填補</b>。
          </p>
          {p.caveats.length > 0 && (
            <ul className="caveats">{p.caveats.map((c) => <li key={c}>⚠️ {c}</li>)}</ul>
          )}
          <table className="breakdown">
            <thead><tr><th>項目</th><th>金額</th><th>原站原文／狀態</th></tr></thead>
            <tbody>
              {Object.entries(p.fields).map(([k, f]) => (
                <tr key={k} className={f.v === null ? 'unknown' : ''}>
                  <td>{FIELD_ZH[k] ?? k}</td>
                  <td className="num">
                    {f.v === null ? <span className="muted">未提供</span> : yen(f.v)}
                    {f.v !== null && f.basis === 'included_stated' && <Chip tone="good">已含</Chip>}
                  </td>
                  <td className="src">
                    {f.v === null
                      ? <span className="muted">{WHY_ZH[(f as { why: string }).why] ?? (f as { why: string }).why}</span>
                      : <code>{f.src || '—'}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(p.layoutRaw !== undefined || p.minStayMonths !== undefined || p.ageLimitRaw !== undefined) && (
            <>
              <h3>其他條件（原文）</h3>
              <ul>
                {p.layoutRaw !== undefined && <li>房型原站標示：<code>{p.layoutRaw}</code>（已正規化顯示）</li>}
                {p.minStayMonths !== undefined && <li>最短居住期間：{p.minStayMonths} 個月</li>}
                {p.ageLimitRaw !== undefined && <li>年齡限制：<code>{p.ageLimitRaw}</code></li>}
              </ul>
            </>
          )}
          {p.mergedFrom !== undefined && p.adCount !== undefined && (
            <>
              <h3>同一間房的其他刊登（{p.adCount} 家仲介）</h3>
              <p className="muted">
                同棟同層、房型・面積・賃料・管理費・敷金・禮金全部相同的刊登視為同一間房，只顯示一次。
                各家仲介的初期費用可能不同，建議都點開比較。
              </p>
              <ul>
                {p.mergedFrom.map((m) => (
                  <li key={m.unitKey}><a href={m.url} target="_blank" rel="noreferrer noopener">{m.url} ↗</a></li>
                ))}
              </ul>
            </>
          )}
          {p.alsoListed !== undefined && p.alsoListed.length > 0 && (
            <>
              <h3>也刊登在其他網站</h3>
              <ul>
                {p.alsoListed.map((a) => (
                  <li key={a.url}>
                    {wire.dict.sourceMeta[a.src]?.nameZh ?? a.src}：
                    <a href={a.url} target="_blank" rel="noreferrer noopener">{a.url} ↗</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {p.foreignerRaw !== '' && (
            <>
              <h3>外國人承租條件（原文）</h3>
              <pre className="raw">{p.foreignerRaw}</pre>
            </>
          )}
          {p.notes.length > 0 && (
            <>
              <h3>備註</h3>
              <ul>{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          )}
          <p className="muted">
            資料擷取時間：{p.fetchedAt.slice(0, 16).replace('T', ' ')} ·{' '}
            <a href={p.url} target="_blank" rel="noreferrer noopener">前往原站查看 ↗</a>
          </p>
        </>
      )}
    </aside>
  );
}

/** 「我的房子」面板：出租方把自己的物件放進目前條件的行情裡定位。全部都是使用者輸入。 */
function MyPropertyPanel(props: {
  wire: Wire; f: Filters; set: (patch: Partial<Filters>) => void;
  monthlies: number[]; perM2s: number[];
}) {
  const { wire, f, set, monthlies, perM2s } = props;
  const my: MyProperty = f.my ?? { rent: null, area: null, layout: '', ward: '' };
  const setMy = (patch: Partial<MyProperty>): void => set({ my: { ...my, ...patch } });
  const sm = useMemo(() => summary(monthlies), [monthlies]);
  const sp = useMemo(() => summary(perM2s), [perM2s]);
  const sortedM = useMemo(() => sortedAsc(monthlies), [monthlies]);
  const sortedP = useMemo(() => sortedAsc(perM2s), [perM2s]);
  const myPerM2 = my.rent !== null && my.area !== null && my.area > 0 ? my.rent / my.area : null;
  const rankM = my.rent !== null ? percentileRank(sortedM, my.rent) : null;
  const rankP = myPerM2 !== null ? percentileRank(sortedP, myPerM2) : null;
  const enough = sm.n >= 5;
  const layouts = wire.dict.layouts;

  return (
    <section className="my">
      <h2>我的房子在行情的哪裡？</h2>
      <p className="muted">
        輸入你要出租的物件，對照<b>目前篩選條件下</b>月額完整可比的房源（n={sm.n}）。
        這些數字只存在網址裡，不會寫進資料。
      </p>
      <div className="my-inputs">
        <label>預計月額（賃料＋管理費）
          <input type="number" step={1000} value={my.rent ?? ''} placeholder="例：120000"
            onChange={(e) => setMy({ rent: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
        <label>面積 ㎡
          <input type="number" step={0.5} value={my.area ?? ''} placeholder="例：25"
            onChange={(e) => setMy({ area: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
        <label>房型
          <select value={my.layout} onChange={(e) => setMy({ layout: e.target.value })}>
            <option value="">不指定</option>
            {layouts.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>区
          <select value={my.ward} onChange={(e) => setMy({ ward: e.target.value })}>
            <option value="">不指定</option>
            {wire.dict.wards.filter((w) => w !== '').map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <button type="button" className="apply" disabled={my.ward === '' && my.layout === '' && my.area === null}
          onClick={() => set({
            wards: my.ward === '' ? f.wards : [my.ward],
            layouts: my.layout === '' ? f.layouts : [my.layout],
            minArea: my.area === null ? f.minArea : Math.round(my.area * 0.8),
            maxArea: my.area === null ? f.maxArea : Math.round(my.area * 1.2),
          })}>
          套用為篩選條件（区・房型・面積 ±20%）
        </button>
      </div>
      {!enough && <p className="muted">樣本不足（完整可比者少於 5 筆），無法定位。放寬條件再試。</p>}
      {enough && (
        <div className="my-out">
          <table className="quart">
            <thead><tr><th></th><th>p25</th><th>中位數</th><th>p75</th><th>你的房子</th></tr></thead>
            <tbody>
              <tr>
                <td>月額</td>
                <td>{yen(Math.round(sm.p25 as number))}</td><td>{yen(Math.round(sm.p50 as number))}</td><td>{yen(Math.round(sm.p75 as number))}</td>
                <td>{my.rent === null ? '—' : <>{yen(my.rent)}（第 <b>{Math.round(rankM as number)}</b> 百分位）</>}</td>
              </tr>
              {sp.n >= 5 && (
                <tr>
                  <td>每㎡單價</td>
                  <td>{yen(Math.round(sp.p25 as number))}</td><td>{yen(Math.round(sp.p50 as number))}</td><td>{yen(Math.round(sp.p75 as number))}</td>
                  <td>{myPerM2 === null ? '—' : <>{yen(Math.round(myPerM2))}（第 <b>{Math.round(rankP as number)}</b> 百分位）</>}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="hists">
            <figure>
              <Histogram values={monthlies} marker={my.rent} formatX={(v) => yen(Math.round(v))} title={`月額分佈（n=${sm.n}）`} />
              <figcaption>月額分佈（n={sm.n}）· 帶＝p10–p90 · 線＝中位數{my.rent !== null && ' · 橘色＝你的房子'}</figcaption>
            </figure>
            {sp.n >= 5 && (
              <figure>
                <Histogram values={perM2s} marker={myPerM2} formatX={(v) => `${yen(Math.round(v))}/㎡`} title={`每㎡單價分佈（n=${sp.n}）`} />
                <figcaption>每㎡單價分佈（面積已知 n={sp.n}）</figcaption>
              </figure>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [wire, setWire] = useState<Wire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useHashFilters();
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(60);
  const [showMy, setShowMy] = useState(false);
  const [moreLines, setMoreLines] = useState(false);

  useEffect(() => {
    void loadWire().then(setWire).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => setLimit(60), [f]);
  useEffect(() => { if (f.my !== null) setShowMy(true); }, [f.my]);

  const result = useMemo(() => (wire === null ? null : query(wire, f)), [wire, f]);

  // 路線依棟數排序；車站清單依所選路線過濾
  const lineOrder = useMemo(() => {
    if (wire === null) return [];
    const c = lineBuildingCounts(wire);
    return wire.dict.lines.map((name, i) => ({ name, n: c[i] as number })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'));
  }, [wire]);
  const stationChoices = useMemo(() => {
    if (wire === null) return [];
    const li = f.line === '' ? -1 : wire.dict.lines.indexOf(f.line);
    if (li < 0) return [...wire.dict.stations].filter((s) => s !== '').sort((a, b) => a.localeCompare(b, 'ja'));
    return wire.dict.pairs.filter(([l]) => l === li).map(([, s]) => wire.dict.stations[s] ?? '').sort((a, b) => a.localeCompare(b, 'ja'));
  }, [wire, f.line]);
  const layoutChoices = useMemo(() => {
    if (wire === null) return [];
    return [...wire.dict.layouts].sort((a, b) => {
      const ra = layoutSizeRank(a); const rb = layoutSizeRank(b);
      if (ra !== null && rb !== null) return ra - rb;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return a.localeCompare(b, 'ja');
    });
  }, [wire]);

  // 出租方比較競品用：目前條件下的行情。
  // 只計「完整可比」者——把下限值混進統計會把中位數往下拉，
  // 得到一個看似真實其實偏低的行情。
  const stats = useMemo(() => {
    if (wire === null || result === null) return null;
    const { u } = wire;
    const monthlies: number[] = [];
    const perM2: number[] = [];
    for (const r of result.rows) {
      const i = r.i;
      if ((u.monthlyTier[i] as number) !== 0) continue;
      const m = monthlyWithAssumption(wire, i, f.assumeUtil);
      monthlies.push(m);
      if (perM2Comparable(wire, i)) perM2.push(m / (u.area[i] as number));
    }
    const sm = summary(monthlies);
    const sp = summary(perM2);
    return { monthlies, perM2, n: sm.n, medMonthly: sm.p50, nArea: sp.n, medPerM2: sp.p50 };
  }, [wire, result, f.assumeUtil]);

  if (err !== null) return <main className="wrap"><h1>東京租屋比價</h1><p className="error">{err}</p></main>;
  if (wire === null || result === null || stats === null) return <main className="wrap"><h1>東京租屋比價</h1><p>載入中…</p></main>;

  const { rows, counts, excluded } = result;
  const { b, u, dict, meta } = wire;
  const set = (patch: Partial<Filters>): void => setF({ ...f, ...patch });
  const thisYear = new Date().getFullYear();
  const stIdxSel = f.st === '' ? -1 : dict.stations.indexOf(f.st);

  // 篩選器在左側欄，捲下去就看不見，但結果數可能已經被砍掉九成——
  // 沒有生效條件的指示，使用者只會覺得「明明有 7,900 間卻只剩幾十筆」。
  const activeFilters: Array<{ key: string; label: string; clear: () => void }> = [];
  const addF = (key: string, label: string, patch: Partial<Filters>): void => {
    activeFilters.push({ key, label, clear: () => set(patch) });
  };
  if (f.q !== '') addF('q', `關鍵字「${f.q}」`, { q: '' });
  if (f.kind !== '') addF('kind', f.kind === 'apt' ? '一般賃貸' : '共居', { kind: '' });
  if (f.wards.length > 0) addF('ward', `區域 ${f.wards.length} 個`, { wards: [] });
  if (f.sources.length > 0) addF('src', `來源 ${f.sources.length} 個`, { sources: [] });
  if (f.layouts.length > 0) addF('lay', `房型 ${f.layouts.join('・')}`, { layouts: [] });
  if (f.line !== '') addF('line', `路線 ${f.line}`, { line: '', st: '' });
  if (f.st !== '') addF('st', `車站 ${f.st}`, { st: '' });
  if (f.maxMonthly !== null) addF('mm', `月額 ≤ ${yen(f.maxMonthly)}`, { maxMonthly: null });
  if (f.maxInitCash !== null) addF('mi', `初期現金 ≤ ${yen(f.maxInitCash)}`, { maxInitCash: null });
  if (f.minArea !== null) addF('ma', `面積 ≥ ${f.minArea}㎡`, { minArea: null });
  if (f.maxArea !== null) addF('mxa', `面積 ≤ ${f.maxArea}㎡`, { maxArea: null });
  if (f.maxWalk !== null) addF('mw', `${f.st !== '' ? `到${f.st}` : '任一站'}步行 ≤ ${f.maxWalk} 分`, { maxWalk: null });
  if (f.minFloor !== null) addF('fl', `${f.minFloor} 樓以上`, { minFloor: null });
  if (f.maxAge !== null) addF('age', `屋齡 ≤ ${f.maxAge} 年`, { maxAge: null });
  if (f.gender !== '') addF('g', GENDER_ZH[f.gender] ?? f.gender, { gender: '' });
  if (f.foreignerOnly) addF('fgn', '只看外國人可租', { foreignerOnly: false });
  if (f.noKeyMoney) addF('nk', '零禮金', { noKeyMoney: false });
  if (f.noDeposit) addF('nd', '零敷金', { noDeposit: false });
  if (f.utilIncluded) addF('ui', '明確含水電', { utilIncluded: false });
  if (!f.vacantOnly) addF('v', '含無空房', { vacantOnly: true });

  // 結果同時含「含水電」與「水電另計」時要警示——直接比會低估後者
  const mixedBasis = new Set(rows.slice(0, 400).map((r) => u.utilBasis[r.i])).size > 1;
  const toggleLayout = (l: string): void => {
    set({ layouts: f.layouts.includes(l) ? f.layouts.filter((x) => x !== l) : [...f.layouts, l] });
  };
  const exportCsv = (): void => {
    downloadCsv(rowsToCsv(wire, rows, { assumeUtil: f.assumeUtil }), csvFileName(rows.length));
  };

  return (
    <div className="app">
      <header>
        <h1>東京租屋比價</h1>
        <p className="sub">
          把分散在各家網站的房源放到同一把尺上比較。資料更新於 {meta.generatedAt.slice(0, 10)}，
          共 {meta.buildings.toLocaleString()} 棟 / {meta.units.toLocaleString()} 間房
          （已合併 SUUMO 多家仲介重複刊登 {meta.dedup.suumoWithin.removed.toLocaleString()} 筆、跨站重複 {meta.dedup.crossSource.removedUnits} 筆）。
        </p>
      </header>

      <div className="layout">
        <form className="filters" onSubmit={(e) => e.preventDefault()}>
          <label>關鍵字
            <input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="物件名、車站、區" />
          </label>

          <fieldset className="kind">
            <legend>種類</legend>
            {([['', '不限'], ['apt', '一般賃貸'], ['share', '共居（share house）']] as const).map(([v, label]) => (
              <label key={v} className="cb">
                <input type="radio" name="kind" checked={f.kind === v} onChange={() => set({ kind: v })} /> {label}
              </label>
            ))}
          </fieldset>

          <label>排序依據
            <select value={f.sort} onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}>
              <option value="eff12">實質月成本（一年攤平）</option>
              <option value="monthly">每月固定支出</option>
              <option value="initCash">初期現金需求</option>
              <option value="initSunk">初期沉沒成本（拿不回來的）</option>
              <option value="area">面積大→小</option>
              <option value="perM2">每㎡單價（比競品）</option>
            </select>
          </label>

          <fieldset>
            <legend>房型（可複選）</legend>
            <div className="layout-chips">
              {layoutChoices.map((l) => (
                <button key={l} type="button" className={`lchip ${f.layouts.includes(l) ? 'on' : ''}`} onClick={() => toggleLayout(l)}>{l}</button>
              ))}
            </div>
          </fieldset>

          <label>路線
            <select value={f.line} onChange={(e) => set({ line: e.target.value, st: '' })}>
              <option value="">不限</option>
              {lineOrder.slice(0, TOP_LINES).map((l) => <option key={l.name} value={l.name}>{l.name}（{l.n}）</option>)}
              {(moreLines || (f.line !== '' && lineOrder.slice(0, TOP_LINES).every((l) => l.name !== f.line))) && (
                <optgroup label="其他路線">
                  {lineOrder.slice(TOP_LINES).map((l) => <option key={l.name} value={l.name}>{l.name}（{l.n}）</option>)}
                </optgroup>
              )}
            </select>
            {!moreLines && lineOrder.length > TOP_LINES && (
              <button type="button" className="link" onClick={() => setMoreLines(true)}>顯示全部 {lineOrder.length} 條路線</button>
            )}
          </label>
          <label>車站
            <input list="station-list" value={f.st} placeholder={f.line === '' ? '輸入站名' : `${f.line} 上的站`}
              onChange={(e) => set({ st: e.target.value })} />
            <datalist id="station-list">
              {stationChoices.map((s) => <option key={s} value={s} />)}
            </datalist>
            {f.st !== '' && stIdxSel < 0 && <small className="warn">資料裡沒有「{f.st}」這個站名</small>}
          </label>
          <label>步行分鐘上限{f.st !== '' ? `（到 ${f.st}）` : '（任一站）'}
            <input type="number" step={1} value={f.maxWalk ?? ''} placeholder="不限"
              onChange={(e) => set({ maxWalk: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>

          <label>月額上限
            <input type="number" step={5000} value={f.maxMonthly ?? ''} placeholder="不限"
              onChange={(e) => set({ maxMonthly: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label>初期現金上限
            <input type="number" step={10000} value={f.maxInitCash ?? ''} placeholder="不限"
              onChange={(e) => set({ maxInitCash: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <div className="pair">
            <label>面積下限 ㎡
              <input type="number" step={1} value={f.minArea ?? ''} placeholder="不限"
                onChange={(e) => set({ minArea: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
            <label>面積上限 ㎡
              <input type="number" step={1} value={f.maxArea ?? ''} placeholder="不限"
                onChange={(e) => set({ maxArea: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
          </div>
          <div className="pair">
            <label>樓層下限
              <input type="number" step={1} value={f.minFloor ?? ''} placeholder="不限"
                onChange={(e) => set({ minFloor: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
            <label>屋齡上限（年）
              <input type="number" step={1} value={f.maxAge ?? ''} placeholder="不限"
                onChange={(e) => set({ maxAge: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
          </div>

          <label>性別條件
            <select value={f.gender} onChange={(e) => set({ gender: e.target.value })}>
              <option value="">不限</option>
              {GENDER.filter((g) => g !== 'unknown').map((g) => (
                <option key={g} value={g}>{GENDER_ZH[g]}</option>
              ))}
            </select>
          </label>

          <fieldset>
            <legend>條件</legend>
            <label className="cb"><input type="checkbox" checked={f.foreignerOnly}
              onChange={(e) => set({ foreignerOnly: e.target.checked })} /> 只看外國人可租</label>
            <label className="cb"><input type="checkbox" checked={f.noKeyMoney}
              onChange={(e) => set({ noKeyMoney: e.target.checked })} /> 零禮金</label>
            <label className="cb"><input type="checkbox" checked={f.noDeposit}
              onChange={(e) => set({ noDeposit: e.target.checked })} /> 零敷金</label>
            <label className="cb"><input type="checkbox" checked={f.utilIncluded}
              onChange={(e) => set({ utilIncluded: e.target.checked })} /> 明確含水電</label>
            <label className="cb"><input type="checkbox" checked={f.vacantOnly}
              onChange={(e) => set({ vacantOnly: e.target.checked })} /> 只看有空房</label>
          </fieldset>

          <label className="assume">水電假設（你自己的估計，¥／月）
            <input type="number" step={1000} value={f.assumeUtil ?? ''} placeholder="不套用"
              onChange={(e) => set({ assumeUtil: e.target.value === '' ? null : Number(e.target.value) })} />
            <small>套用後金額會標為「含你的假設」，這個數字<b>不會</b>寫進資料。</small>
          </label>

          <label>資料來源
            <select multiple size={3} value={f.sources}
              onChange={(e) => set({ sources: [...e.target.selectedOptions].map((o) => o.value) })}>
              {dict.sources.map((sid) => (
                <option key={sid} value={sid}>{dict.sourceMeta[sid]?.nameZh ?? sid}</option>
              ))}
            </select>
          </label>

          <label>區域
            <select multiple size={8} value={f.wards}
              onChange={(e) => set({ wards: [...e.target.selectedOptions].map((o) => o.value) })}>
              {dict.wards.map((w) => <option key={w} value={w}>{w === '' ? '（区未提供）' : w}</option>)}
            </select>
          </label>

          <button type="button" className="reset" onClick={() => { location.hash = ''; }}>清除全部條件</button>
        </form>

        <main>
          {activeFilters.length > 0 && (
            <div className="active">
              <span>已套用 {activeFilters.length} 個條件：</span>
              {activeFilters.map((a) => (
                <button key={a.key} type="button" className="pill" onClick={a.clear}>
                  {a.label} ✕
                </button>
              ))}
              <button type="button" className="pill clear" onClick={() => { location.hash = ''; }}>
                全部清除
              </button>
            </div>
          )}
          <div className="tiers">
            {/* 三區是「目前排序鍵」的完整度，不是月額的——按每㎡單價排序時，
                月額已知但算不出單價的房也會落在資料不足區。標籤要講清楚是哪個指標，
                否則會和下面「行情（僅計 N 筆完整可比者）」的月額口徑對不起來。 */}
            <span><b>{counts[0]}</b> 筆{TIER_LABEL[f.sort][0]}</span>
            <span><b>{counts[1]}</b> 筆{TIER_LABEL[f.sort][1]}</span>
            <span><b>{counts[2]}</b> 筆{TIER_LABEL[f.sort][2]}</span>
            <span className="tools">
              <button type="button" onClick={() => setShowMy(!showMy)}>{showMy ? '收起' : '我的房子定位'}</button>
              <button type="button" onClick={exportCsv} disabled={rows.length === 0}>匯出 CSV（{rows.length} 筆）</button>
            </span>
          </div>
          {(excluded.kindUnknown > 0 || excluded.ageUnknown > 0 || excluded.floorUnknown > 0) && (
            <p className="notice">
              {excluded.kindUnknown > 0 && <>另有 {excluded.kindUnknown.toLocaleString()} 間<b>種類未知</b>未計入（來源沒寫，不代表不符）。</>}
              {excluded.ageUnknown > 0 && <>另有 {excluded.ageUnknown.toLocaleString()} 間<b>築年未提供</b>未計入；屋齡以瀏覽器當年計，可能跨年差 1。</>}
              {excluded.floorUnknown > 0 && <>另有 {excluded.floorUnknown.toLocaleString()} 間<b>樓層未提供</b>未計入。</>}
            </p>
          )}
          {stats.medMonthly !== null && stats.n >= 3 && (
            <p className="stats">
              目前條件的行情（僅計 {stats.n} 筆月額完整可比者）：月額中位數 <b>{yen(Math.round(stats.medMonthly))}</b>
              {stats.medPerM2 !== null && (
                <>　·　每㎡單價中位數 <b>{yen(Math.round(stats.medPerM2))}／㎡</b>（可算單價 {stats.nArea} 筆，
                  不含面積未知與多人房）</>
              )}
            </p>
          )}
          {showMy && <MyPropertyPanel wire={wire} f={f} set={set} monthlies={stats.monthlies} perM2s={stats.perM2} />}
          {mixedBasis && (
            <p className="banner">
              結果同時包含「月額含水電」與「水電另計」的房源，直接比較會低估後者。
              可勾選「明確含水電」只看同一基準，或在左側填入你的水電假設。
            </p>
          )}

          {rows.length === 0 && <p>沒有符合條件的房源。</p>}

          <ul className="cards">
            {rows.slice(0, limit).map((r) => {
              const i = r.i;
              const bi = u.bid[i] as number;
              const sts = buildingStations(wire, bi);
              // 有選車站就顯示該站；否則顯示第一站
              const shown = stIdxSel >= 0 ? (sts.find((s) => s.name === f.st) ?? sts[0]) : sts[0];
              const assumed = f.assumeUtil !== null && u.utilBasis[i] !== 1 && u.util[i] === null;
              const monthly = monthlyWithAssumption(wire, i, f.assumeUtil);
              const tier = r.tier;
              // 價格顯示看**月額自己的區**，不是排序用的區。
              // 按「每㎡單價」排序時，算不出單價的房會被歸到排序的資料不足區——
              // 但它的月額可能是知道的，拿排序的區去決定要不要顯示金額會把已知的月額藏起來。
              const mTier = u.monthlyTier[i] as number;
              const layoutIdx = u.layout[i] as number;
              const layout = layoutIdx >= 0 ? dict.layouts[layoutIdx] : null;
              const kindName = dict.kinds[b.kind[bi] as number] ?? 'unknown';
              const year = b.yearBuilt[bi];
              const floor = u.floor[i];
              const ads = u.ads[i] as number;
              const alsoMask = b.also[bi] as number;
              const alsoNames = dict.sources.filter((_, k) => (alsoMask & (1 << k)) !== 0).map((sid) => dict.sourceMeta[sid]?.nameZh ?? sid);
              return (
                <li key={i} className={`card t${tier}`}>
                  <div className="head">
                    <h3>{b.name[bi]}</h3>
                    <span className="ward">
                      {dict.wards[b.ward[bi] as number] || '区未提供'}
                      <span className="src">{srcName(dict, b.src[bi] as number)}</span>
                    </span>
                  </div>
                  <p className="station">
                    {shown === undefined ? '車站未提供' : `${shown.name}站${shown.walk !== null ? ` 徒步 ${shown.walk} 分` : ''}`}
                    {sts.length > 1 && <span className="more-st" title={sts.map((s) => `${s.name}${s.walk !== null ? ` ${s.walk}分` : ''}`).join('／')}> +{sts.length - 1} 站</span>}
                    {u.room[i] !== null ? ` · ${u.room[i]} 號室` : ''}
                    {floor !== null && floor !== undefined ? ` · ${floor}F` : ''}
                    {u.area[i] !== null ? ` · ${u.area[i]}㎡` : ''}
                    {layout !== null && layout !== undefined ? ` · ${layout}` : ''}
                    {year !== null && year !== undefined ? ` · ${year}年築（${thisYear - year} 年）` : ''}
                  </p>

                  <div className="price">
                    {/* 賃料未知時（tier C）絕不顯示金額——只有管理費的合計會變成
                        一個看起來合理但完全錯誤的「月額」，那比留白危險得多。 */}
                    <div className="big">
                      {mTier === 2
                        ? <span className="nodata">月額未提供</span>
                        : <>{mTier === 1 && <span className="ge">≥</span>}{yen(monthly)}<small>／月</small></>}
                    </div>
                    <div className="parts">
                      賃料 {u.rent[i] === null ? <b className="nodata">未提供</b> : yen(u.rent[i])} ＋ 管理費 {yen(u.admin[i])}
                      {assumed && <> ＋ <b className="assumed">你的水電假設 {yen(f.assumeUtil)}</b></>}
                    </div>
                    <div className="parts">
                      初期現金 {yen(u.initCash[i])} · 拿不回來的 {yen(u.initSunk[i])}
                      {mTier === 0 && (perM2Comparable(wire, i)
                        ? <> · 單價 {yen(Math.round(monthly / (u.area[i] as number)))}／㎡</>
                        : isDorm(wire, i) && <> · <span className="muted">多人房不計每㎡單價（面積是整間共用）</span></>)}
                    </div>
                  </div>

                  <div className="chips">
                    <Chip tone={kindGroup(wire, b.kind[bi] as number) === 'share' ? 'warn' : 'flat'}>{KIND_ZH[kindName] ?? kindName}</Chip>
                    <Chip tone={u.key[i] === 0 ? 'good' : 'flat'}>
                      禮金 {u.key[i] === null ? '未提供' : u.key[i] === 0 ? '零' : yen(u.key[i])}
                    </Chip>
                    <Chip tone={u.dep[i] === 0 ? 'good' : 'flat'}>
                      敷金 {u.dep[i] === null ? '未提供' : u.dep[i] === 0 ? '零' : yen(u.dep[i])}
                    </Chip>
                    <Chip tone={u.utilBasis[i] === 1 ? 'good' : u.utilBasis[i] === 2 ? 'warn' : 'flat'}>
                      {UTIL_ZH[u.utilBasis[i] as number]}
                    </Chip>
                    {u.foreigner[i] === 1 && <Chip tone="good">外國人可租</Chip>}
                    <Chip>{GENDER_ZH[GENDER[u.gender[i] as number] ?? 'unknown']}</Chip>
                    {flagChips(wire, u.flags[i] as number)}
                    {ads > 1 && <Chip>{ads} 家仲介刊登</Chip>}
                    {alsoNames.length > 0 && <Chip tone="good">也可在 {alsoNames.join('、')} 申請</Chip>}
                    {mTier === 1 && <Chip tone="warn">費用資訊不全</Chip>}
                  </div>

                  <div className="actions">
                    <button type="button" onClick={() => setOpen(i)}>費用拆解</button>
                    <a href={b.url[bi]} target="_blank" rel="noreferrer noopener" className="primary">
                      前往原站 ↗
                    </a>
                    <span className="fresh">確認於 {b.fetchedAt[bi]}</span>
                  </div>
                </li>
              );
            })}
          </ul>

          {rows.length > limit && (
            <button type="button" className="more" onClick={() => setLimit(limit + 60)}>
              再顯示 60 筆（共 {rows.length} 筆）
            </button>
          )}
        </main>
      </div>

      {open !== null && <Detail wire={wire} unitIdx={open} onClose={() => setOpen(null)} />}

      <footer>
        <p>
          本站只做資訊彙整與比較，不承接交易。所有房源資料皆來自原站，
          點「前往原站」即可查看完整資訊並直接聯繫。金額以原站為準。
        </p>
        <p className="muted">
          資料來源：{dict.sources.map((sid) => dict.sourceMeta[sid]?.nameZh ?? sid).join('、')} · 產生於 {meta.generatedAt.slice(0, 16).replace('T', ' ')}
          {meta.violations > 0 && ` · ${meta.violations} 筆欄位因數值互相矛盾而未採用`}
        </p>
      </footer>
    </div>
  );
}
