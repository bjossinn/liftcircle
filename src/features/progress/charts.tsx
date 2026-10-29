/* Shared chart plumbing for Progress: theme-token colours, accessible figure wrapper, tooltip. */
import { useEffect, useState, type ReactNode } from 'react';
import type { TooltipPayloadEntry } from 'recharts';
import { formatDate } from '@/lib/dates';
import type { ISODate } from '@/domain/types';

export interface ChartColors {
  accent: string;
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
  const fallback: ChartColors = {
    accent: '#4fbf7f', accentSoft: 'rgba(79,191,127,0.14)', info: '#6fa8dc', warn: '#e6b450', danger: '#f07167', text: '#eef1ef', muted: '#9aa3a0', faint: '#6c7572', line: '#2e343b', surface: '#171a1e', surface3: '#282d33',
  };
  if (typeof document === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    accent: v('--c-accent', fallback.accent),
    accentSoft: v('--c-accent-soft', fallback.accentSoft),
    info: v('--c-info', fallback.info),
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

/** Small inline legend; identity never relies on colour alone (names are always shown). */
export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-1 mb-1 text-xs text-muted" aria-hidden>
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: i.dashed ? 'transparent' : i.color, borderTop: i.dashed ? `2px dashed ${i.color}` : undefined }} />
          {i.label}
        </li>
      ))}
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
