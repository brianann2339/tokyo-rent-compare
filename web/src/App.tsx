import { useEffect, useMemo, useState } from 'react';
import {
  loadWire, loadProv, query, queryToFilters, filtersToQuery, yen,
  GENDER, type Wire, type Filters, type Prov,
} from './data.ts';

const GENDER_ZH: Record<string, string> = {
  unknown: '未提供', mixed: '男女皆可', female_only: '女性專用', male_only: '男性專用',
};
const UTIL_ZH = ['未提供', '含水電', '水電另計'];
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

function Detail({ unitId, onClose }: { unitId: string; onClose: () => void }) {
  const [p, setP] = useState<Prov | null | 'loading'>('loading');
  useEffect(() => { void loadProv(unitId).then(setP); }, [unitId]);

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

export default function App() {
  const [wire, setWire] = useState<Wire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useHashFilters();
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);

  useEffect(() => {
    void loadWire().then(setWire).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => setLimit(60), [f]);

  const result = useMemo(() => (wire === null ? null : query(wire, f)), [wire, f]);

  if (err !== null) return <main className="wrap"><h1>東京租屋比價</h1><p className="error">{err}</p></main>;
  if (wire === null || result === null) return <main className="wrap"><h1>東京租屋比價</h1><p>載入中…</p></main>;

  const { rows, counts } = result;
  const { b, u, dict, meta } = wire;
  const set = (patch: Partial<Filters>): void => setF({ ...f, ...patch });

  // 篩選器在左側欄，捲下去就看不見，但結果數可能已經被砍掉九成——
  // 沒有生效條件的指示，使用者只會覺得「明明有 7,900 間卻只剩幾十筆」。
  const activeFilters: Array<{ key: string; label: string; clear: () => void }> = [];
  const addF = (key: string, label: string, patch: Partial<Filters>): void => {
    activeFilters.push({ key, label, clear: () => set(patch) });
  };
  if (f.q !== '') addF('q', `關鍵字「${f.q}」`, { q: '' });
  if (f.wards.length > 0) addF('ward', `區域 ${f.wards.length} 個`, { wards: [] });
  if (f.sources.length > 0) addF('src', `來源 ${f.sources.length} 個`, { sources: [] });
  if (f.maxMonthly !== null) addF('mm', `月額 ≤ ${yen(f.maxMonthly)}`, { maxMonthly: null });
  if (f.maxInitCash !== null) addF('mi', `初期現金 ≤ ${yen(f.maxInitCash)}`, { maxInitCash: null });
  if (f.minArea !== null) addF('ma', `面積 ≥ ${f.minArea}㎡`, { minArea: null });
  if (f.maxWalk !== null) addF('mw', `步行 ≤ ${f.maxWalk} 分`, { maxWalk: null });
  if (f.gender !== '') addF('g', GENDER_ZH[f.gender] ?? f.gender, { gender: '' });
  if (f.foreignerOnly) addF('fgn', '只看外國人可租', { foreignerOnly: false });
  if (f.noKeyMoney) addF('nk', '零禮金', { noKeyMoney: false });
  if (f.noDeposit) addF('nd', '零敷金', { noDeposit: false });
  if (f.utilIncluded) addF('ui', '明確含水電', { utilIncluded: false });
  if (!f.vacantOnly) addF('v', '含無空房', { vacantOnly: true });

  // 結果同時含「含水電」與「水電另計」時要警示——直接比會低估後者
  const mixedBasis = new Set(rows.slice(0, 400).map((r) => u.utilBasis[r.i])).size > 1;

  return (
    <div className="app">
      <header>
        <h1>東京租屋比價</h1>
        <p className="sub">
          把分散在各家網站的房源放到同一把尺上比較。資料更新於 {meta.generatedAt.slice(0, 10)}，
          共 {meta.buildings.toLocaleString()} 棟 / {meta.units.toLocaleString()} 間房。
        </p>
      </header>

      <div className="layout">
        <form className="filters" onSubmit={(e) => e.preventDefault()}>
          <label>關鍵字
            <input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="物件名、車站、區" />
          </label>

          <label>排序依據
            <select value={f.sort} onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}>
              <option value="eff12">實質月成本（一年攤平）</option>
              <option value="monthly">每月固定支出</option>
              <option value="initCash">初期現金需求</option>
              <option value="initSunk">初期沉沒成本（拿不回來的）</option>
              <option value="area">面積大→小</option>
            </select>
          </label>

          <label>月額上限
            <input type="number" step={5000} value={f.maxMonthly ?? ''} placeholder="不限"
              onChange={(e) => set({ maxMonthly: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label>初期現金上限
            <input type="number" step={10000} value={f.maxInitCash ?? ''} placeholder="不限"
              onChange={(e) => set({ maxInitCash: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label>面積下限 ㎡
            <input type="number" step={1} value={f.minArea ?? ''} placeholder="不限"
              onChange={(e) => set({ minArea: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label>步行分鐘上限
            <input type="number" step={1} value={f.maxWalk ?? ''} placeholder="不限"
              onChange={(e) => set({ maxWalk: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>

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
              {dict.wards.map((w) => <option key={w} value={w}>{w}</option>)}
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
            <span><b>{counts[0]}</b> 筆完整可比</span>
            <span><b>{counts[1]}</b> 筆僅有下限</span>
            <span><b>{counts[2]}</b> 筆資料不足</span>
          </div>
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
              const stIdx = b.station[bi] as number;
              const walk = b.walk[bi];
              const assumed = f.assumeUtil !== null && u.utilBasis[i] !== 1 && u.util[i] === null;
              const monthly = (u.monthlyLower[i] as number) + (assumed ? (f.assumeUtil as number) : 0);
              const tier = r.tier;
              return (
                <li key={u.id[i]} className={`card t${tier}`}>
                  <div className="head">
                    <h3>{b.name[bi]}</h3>
                    <span className="ward">
                      {dict.wards[b.ward[bi] as number]}
                      <span className="src">{srcName(dict, b.src[bi] as number)}</span>
                    </span>
                  </div>
                  <p className="station">
                    {stIdx >= 0 ? `${dict.stations[stIdx]}站` : '車站未提供'}
                    {walk !== null ? ` 徒步 ${walk} 分` : ''}
                    {u.room[i] !== null ? ` · ${u.room[i]} 號室` : ''}
                    {u.area[i] !== null ? ` · ${u.area[i]}㎡` : ''}
                    {u.layout[i] !== null ? ` · ${u.layout[i]}` : ''}
                  </p>

                  <div className="price">
                    {/* 賃料未知時（tier C）絕不顯示金額——只有管理費的合計會變成
                        一個看起來合理但完全錯誤的「月額」，那比留白危險得多。 */}
                    <div className="big">
                      {tier === 2
                        ? <span className="nodata">月額未提供</span>
                        : <>{tier === 1 && <span className="ge">≥</span>}{yen(monthly)}<small>／月</small></>}
                    </div>
                    <div className="parts">
                      賃料 {u.rent[i] === null ? <b className="nodata">未提供</b> : yen(u.rent[i])} ＋ 管理費 {yen(u.admin[i])}
                      {assumed && <> ＋ <b className="assumed">你的水電假設 {yen(f.assumeUtil)}</b></>}
                    </div>
                    <div className="parts">
                      初期現金 {yen(u.initCash[i])} · 拿不回來的 {yen(u.initSunk[i])}
                    </div>
                  </div>

                  <div className="chips">
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
                    {tier === 1 && <Chip tone="warn">費用資訊不全</Chip>}
                  </div>

                  <div className="actions">
                    <button type="button" onClick={() => setOpen(u.id[i] ?? null)}>費用拆解</button>
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

      {open !== null && <Detail unitId={open} onClose={() => setOpen(null)} />}

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
