/*
 * Shared chart plumbing for Progress: theme-token colours, accessible figure wrapper, tooltip. Series follow the Hard
 * Earned chart roles (--c-chart-1…5): each has its own colour, marker shape and line style, so identity never relies
 * on colour alone.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { TooltipPayloadEntry } from 'recharts';
import { formatDate } from '@/lib/dates';
import type { ISODate } from '@/domain/types';

export interface ChartColors {
  /** Series 1 (the main series). */
  accent: string;
  /** Series 1–5 colours (--c-chart-1…5). */
  series: [string, string, string, string, string];
  accentSoft: string;
  info: string;
  warn: string;
  danger: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  surface: string;
  surface3: string;
}

function readColors(): ChartColors {
  // Hard Earned dark-theme values, used only where CSS variables can't be read (tests, SSR).
  const fallback: ChartColors = {
    accent: '#ff694f', series: ['#ff694f', '#aee9dd', '#89bfff', '#c5a7f2', '#e9c16c'], accentSoft: '#392b29', info: '#aee9dd', warn: '#e9c16c', danger: '#ff9c91', text: '#f3efe7', muted: '#b7babb', faint: '#939a9d', line: '#3d4448', surface: '#202326', surface3: '#2d3135',
  };
  if (typeof document === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const series = fallback.series.map((fb, i) => v(`--c-chart-${i + 1}`, fb)) as ChartColors['series'];
  return {
    accent: series[0],
    series,
    accentSoft: v('--c-accent-soft', fallback.accentSoft),
    // "info" is the second data series in the charts (not the information status colour).
    info: series[1],
    warn: v('--c-warn', fallback.warn),
    danger: v('--c-danger', fallback.danger),
    text: v('--c-text', fallback.text),
    muted: v('--c-muted', fallback.muted),
    faint: v('--c-faint', fallback.faint),
    line: v('--c-border', fallback.line),
    surface: v('--c-surface', fallback.surface),
    surface3: v('--c-surface-3', fallback.surface3),
  };
}

/** Theme colours read from CSS variables; re-read when the theme changes. */
export function useChartColors(): ChartColors {
  const [c, setC] = useState(readColors);
  useEffect(() => {
    const obs = new MutationObserver(() => setC(readColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => obs.disconnect();
  }, []);
  return c;
}

export const axisProps = (c: ChartColors) => ({
  stroke: c.line,
  tick: { fill: c.muted, fontSize: 11 },
  tickLine: false,
  axisLine: false,
});

export const shortDate = (d: ISODate) => formatDate(d, { day: 'numeric', month: 'short' });
export const weekLabel = (d: ISODate) => `Week of ${formatDate(d, { day: 'numeric', month: 'short' })}`;

/** Accessible chart figure: visible summary caption + optional data table. */
export function ChartFigure({ title, summary, table, children, height = 200 }: {
  title: string;
  summary: string;
  table?: { headers: string[]; rows: (string | number)[][] };
  children: ReactNode;
  height?: number;
}) {
  return (
    <figure className="m-0">
      <figcaption className="text-sm font-medium px-1 mb-1">{title}</figcaption>
      <div role="img" aria-label={`${title}. ${summary}`} style={{ height }} className="w-full">
        {children}
      </div>
      <p className="text-xs text-muted px-1 mt-1">{summary}</p>
      {table && table.rows.length > 0 && (
        <details className="mt-1 px-1">
          <summary className="text-xs text-accent cursor-pointer min-h-11 inline-flex items-center">Show data table</summary>
          <div className="overflow-x-auto max-h-64 overflow-y-auto mt-1 rounded-lg border border-line">
            <table className="w-full text-xs tabular">
              <thead className="bg-surface-2 sticky top-0">
                <tr>
                  {table.headers.map((h) => (
                    <th key={h} scope="col" className="text-left font-medium text-muted px-2 py-1.5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((cell, j) => (
                      <td key={j} className="px-2 py-1.5">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

/** Tooltip body in UI-kit styling. Text uses text tokens; a swatch carries series identity. */
export function ChartTip({ active, payload, label, labelFmt, valueFmt }: {
  active?: boolean;
  payload?: ReadonlyArray<TooltipPayloadEntry>;
  label?: unknown;
  labelFmt?: (label: string) => string;
  valueFmt?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const l = label == null ? '' : String(label);
  return (
    <div className="rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs shadow-lg">
      {l && <div className="font-medium text-ink mb-1">{labelFmt ? labelFmt(l) : l}</div>}
      {payload
        .filter((p) => p.value != null)
        .map((p, i) => {
          const name = String(p.name ?? p.dataKey ?? '');
          const v = typeof p.value === 'number' ? p.value : Number(p.value);
          return (
            <div key={i} className="flex items-center gap-2 text-muted">
              <span className="inline-block size-2 rounded-full" style={{ background: p.color ?? (p.payload as { fill?: string } | undefined)?.fill }} aria-hidden />
              <span>{name}:</span>
              <span className="text-ink tabular">{valueFmt ? valueFmt(v, name) : String(p.value)}</span>
            </div>
          );
        })}
    </div>
  );
}

/** Visible cue per series (brand guide): 1 circle/solid, 2 square/dashed, 3 triangle/dotted, 4 diamond/dash-dot, 5 plus/long dash. */
export const SERIES: { shape: MarkerShape; dash?: string }[] = [
  { shape: 'circle' },
  { shape: 'square', dash: '8 4' },
  { shape: 'triangle', dash: '2 4' },
  { shape: 'diamond', dash: '8 3 2 3' },
  { shape: 'plus', dash: '12 5' },
];
export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'plus';

/** One marker, centred on (cx, cy). The outline in the surface colour keeps adjacent marks apart. */
export function Marker({ shape, cx, cy, r = 4, fill, stroke }: { shape: MarkerShape; cx: number; cy: number; r?: number; fill: string; stroke?: string }) {
  const sw = stroke ? 1.5 : 0;
  switch (shape) {
    case 'square':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'triangle':
      return <path d={`M${cx} ${cy - r - 1}L${cx + r + 1} ${cy + r}L${cx - r - 1} ${cy + r}Z`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'diamond':
      return <path d={`M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'plus':
      return <path d={`M${cx - r} ${cy}H${cx + r}M${cx} ${cy - r}V${cy + r}`} stroke={fill} strokeWidth={2.5} strokeLinecap="round" />;
    default:
      return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />;
  }
}

/** Recharts line props for series i: colour, line style and its marker shape as the dot. */
export function seriesLine(i: number, c: ChartColors) {
  const s = SERIES[i];
  const color = c.series[i];
  const dot = (p: { cx?: number; cy?: number; index?: number }) =>
    p.cx == null || p.cy == null ? <g key={p.index} /> : <Marker key={p.index} shape={s.shape} cx={p.cx} cy={p.cy} fill={color} stroke={c.surface} />;
  return { stroke: color, strokeDasharray: s.dash, dot, activeDot: { r: 6, fill: color, stroke: c.surface } };
}

/** Small inline legend; identity never relies on colour alone (names, line styles and marker shapes are shown). */
export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean; series?: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-1 mb-1 text-xs text-muted" aria-hidden>
      {items.map((i) => {
        const s = i.series != null ? SERIES[i.series] : undefined;
        const dash = s ? s.dash : i.dashed ? '4 3' : undefined;
        return (
          <li key={i.label} className="flex items-center gap-1.5">
            <svg width="22" height="10" viewBox="0 0 22 10" className="shrink-0">
              <line x1="1" y1="5" x2="21" y2="5" stroke={i.color} strokeWidth="2" strokeDasharray={dash} />
              {s && <Marker shape={s.shape} cx={11} cy={5} r={3} fill={i.color} />}
            </svg>
            {i.label}
          </li>
        );
      })}
    </ul>
  );
}

/** Respect reduced-motion preferences for chart animations. */
export function chartAnimation(): boolean {
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
