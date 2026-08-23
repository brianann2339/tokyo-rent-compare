import type { JSX } from 'react';
import { histogram, quantile, sortedAsc } from './stats.ts';

/**
 * 純 SVG 直方圖：競品分佈 ＋ p10–p90 區間帶 ＋ p50 ＋「我的房子」落點。
 * 顏色全部走 CSS 變數，跟著 style.css 的明暗主題走。
 */
export function Histogram(props: {
  values: readonly number[];
  marker?: number | null;
  formatX: (v: number) => string;
  title: string;
  width?: number;
  height?: number;
}): JSX.Element | null {
  const { values, marker = null, formatX, title, width = 520, height = 160 } = props;
  const s = sortedAsc(values);
  const n = s.length;
  if (n < 5) return null;

  const h = histogram(s);
  const p10 = quantile(s, 0.1) as number;
  const p50 = quantile(s, 0.5) as number;
  const p90 = quantile(s, 0.9) as number;
  const min = h.edges[0] as number;
  const max = h.edges[h.edges.length - 1] as number;
  const range = max - min;

  const pad = { l: 8, r: 8, t: 16, b: 22 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const x0 = pad.l;
  const x1 = pad.l + plotW;
  const baseY = pad.t + plotH;
  const x = (v: number): number => (range === 0 ? x0 + plotW / 2 : x0 + ((v - min) / range) * plotW);
  const clampX = (v: number): number => Math.min(x1, Math.max(x0, x(v)));
  const maxCount = Math.max(...h.counts);
  const y = (c: number): number => baseY - (c / maxCount) * plotH;

  const ticks: Array<{ v: number; anchor: 'start' | 'middle' | 'end' }> = [
    { v: p10, anchor: 'start' }, { v: p50, anchor: 'middle' }, { v: p90, anchor: 'end' },
  ];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ maxWidth: '100%', height: 'auto' }}
      role="img"
      aria-label={`${title}：n=${n}，中位數 ${formatX(p50)}`}
    >
      <title>{title}</title>
      <rect x={x(p10)} y={pad.t} width={Math.max(0, x(p90) - x(p10))} height={plotH} fill="var(--accent)" opacity={0.12} />
      {h.counts.map((c, k) => {
        const left = x(h.edges[k] as number);
        const right = x(h.edges[k + 1] as number);
        const w = Math.max(0, right - left - 1);
        return <rect key={k} x={left} y={y(c)} width={w} height={baseY - y(c)} fill="var(--accent)" opacity={0.7} />;
      })}
      <line x1={x(p50)} x2={x(p50)} y1={pad.t} y2={baseY} stroke="var(--accent)" strokeWidth={1.5} />
      {marker !== null && (
        <>
          <line x1={clampX(marker)} x2={clampX(marker)} y1={pad.t} y2={baseY} stroke="var(--warn)" strokeWidth={2} />
          <circle cx={clampX(marker)} cy={pad.t} r={4} fill="var(--warn)" />
        </>
      )}
      <line x1={x0} x2={x1} y1={baseY} y2={baseY} stroke="var(--muted)" strokeWidth={1} />
      {ticks.map((t) => (
        <g key={t.anchor}>
          <line x1={x(t.v)} x2={x(t.v)} y1={baseY} y2={baseY + 4} stroke="var(--muted)" strokeWidth={1} />
          <text x={x(t.v)} y={baseY + 15} textAnchor={t.anchor} fontSize={10} fill="var(--muted)">{formatX(t.v)}</text>
        </g>
      ))}
    </svg>
  );
}
