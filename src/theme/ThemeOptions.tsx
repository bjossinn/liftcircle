/**
 * Theme choice UI shared by the first-launch picker and Settings → Appearance.
 * Previews are a miniature Today screen rendered with the theme's real tokens ([data-theme] on the preview element
 * scopes the CSS variables), so they always match the actual themes. They're decorative: the radio's name and
 * description carry the meaning for screen readers.
 */
import clsx from 'clsx';
import { Check, Dumbbell, Flame } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { THEME_OPTIONS, type ResolvedTheme, type ThemeChoice } from './theme';

export function MiniToday({ theme, large }: { theme: ResolvedTheme; large?: boolean }) {
  return (
    <div data-theme={theme} aria-hidden className={clsx('bg-bg text-ink rounded-xl border border-line overflow-hidden select-none', large ? 'p-3 space-y-2' : 'p-2 space-y-1.5')}>
      <div className="flex items-center justify-between">
        <div className={clsx('font-display font-extrabold leading-none', large ? 'text-base' : 'text-[11px]')}>Good morning</div>
        <span className={clsx('inline-flex items-center gap-0.5 rounded-full bg-streak-soft text-streak font-semibold', large ? 'px-1.5 py-0.5 text-[10px]' : 'px-1 text-[8px]')}>
          <Flame className={large ? 'size-3' : 'size-2'} /> 3
        </span>
      </div>
      <div className={clsx('rounded-lg bg-surface border border-line tint-accent card-shadow', large ? 'p-2.5' : 'p-1.5')}>
        <div className="flex items-center gap-1.5">
          <span className={clsx('rounded-md bg-accent-soft text-accent flex items-center justify-center', large ? 'size-6' : 'size-3.5')}>
            <Dumbbell className={large ? 'size-3.5' : 'size-2'} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={clsx('font-semibold truncate', large ? 'text-xs' : 'text-[8px]')}>Full body A</div>
            <div className={clsx('text-muted', large ? 'text-[10px]' : 'hidden')}>Today · 55 min</div>
          </div>
        </div>
        <div className={clsx('rounded-md bg-ember text-accent-ink font-semibold text-center', large ? 'mt-2 py-1.5 text-[11px]' : 'mt-1 py-0.5 text-[7px]')}>Start workout</div>
      </div>
      <div className={clsx('grid grid-cols-2', large ? 'gap-2' : 'gap-1')}>
        <div className={clsx('rounded-lg bg-surface border border-line tint-2', large ? 'p-2' : 'p-1')}>
          <div className={clsx('text-muted', large ? 'text-[9px]' : 'text-[6px]')}>Protein</div>
          <div className={clsx('font-bold tabular text-accent-2', large ? 'text-xs' : 'text-[8px]')}>96 g</div>
        </div>
        <div className={clsx('rounded-lg bg-surface border border-line tint-celebrate', large ? 'p-2' : 'p-1')}>
          <div className={clsx('text-muted', large ? 'text-[9px]' : 'text-[6px]')}>Records</div>
          <div className={clsx('font-bold tabular text-celebrate', large ? 'text-xs' : 'text-[8px]')}>2 new</div>
        </div>
      </div>
    </div>
  );
}

/** Match system: the two themes split diagonally, so it reads as "either". */
function SplitPreview({ large }: { large?: boolean }) {
  return (
    <div className="relative" aria-hidden>
      <MiniToday theme="dark" large={large} />
      <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
        <MiniToday theme="light" large={large} />
      </div>
    </div>
  );
}

/**
 * Radio group of the three choices with live previews (arrow keys move and select, like native radios).
 * `layout="cards"`: the picker (two big cards plus a smaller "Match my phone" row). `layout="compact"`: Settings.
 */
export function ThemeOptions({
  value, onChange, layout, systemLabel = 'Match my phone', labelledBy, systemTheme,
}: {
  value: ThemeChoice;
  onChange: (t: ThemeChoice) => void;
  layout: 'cards' | 'compact';
  systemLabel?: string;
  labelledBy?: string;
  /** The phone's current light/dark mode: while Match system is chosen, that theme's card is highlighted. */
  systemTheme?: ResolvedTheme;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const opts = THEME_OPTIONS.map((o) => (o.value === 'system' ? { ...o, label: systemLabel } : o));
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + opts.length) % opts.length;
    onChange(opts[next].value);
    refs.current[next]?.focus();
  };
  const radio = (o: (typeof opts)[number], i: number, className: string, children: ReactNode) => (
    <button
      key={o.value}
      ref={(el) => {
        refs.current[i] = el;
      }}
      type="button"
      role="radio"
      aria-checked={value === o.value}
      aria-label={o.label}
      aria-describedby={`theme-desc-${layout}-${o.value}`}
      tabIndex={value === o.value ? 0 : -1}
      onClick={() => onChange(o.value)}
      onKeyDown={(e) => onKey(e, i)}
      className={clsx(
        'pressable relative text-left rounded-2xl border-2 bg-surface min-h-11 focus-visible:outline-offset-4',
        value === o.value ? 'border-accent' : value === 'system' && systemTheme === o.value ? 'border-accent/50 border-dashed' : 'border-line hover:border-line-input',
        className,
      )}
    >
      {children}
      {value === o.value && (
        <span className="absolute top-2 right-2 size-6 rounded-full bg-ember text-accent-ink flex items-center justify-center shadow">
          <Check className="size-4" strokeWidth={3} aria-hidden />
        </span>
      )}
    </button>
  );
  const text = (o: (typeof opts)[number]) => (
    <>
      <span className="block font-semibold text-[15px]">{o.label}</span>
      <span id={`theme-desc-${layout}-${o.value}`} className="block text-xs text-muted">
        {o.description}
      </span>
    </>
  );

  if (layout === 'compact') {
    return (
      <div role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : 'Theme'} className="grid grid-cols-3 gap-2">
        {opts.map((o, i) =>
          radio(
            o,
            i,
            'p-2 flex flex-col gap-2',
            <>
              {o.value === 'system' ? <SplitPreview /> : <MiniToday theme={o.value} />}
              <span className="block font-semibold text-sm leading-tight">{o.label}</span>
              <span id={`theme-desc-${layout}-${o.value}`} className="sr-only">
                {o.description}
              </span>
            </>,
          ),
        )}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : 'Theme'} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-3">
        {opts.slice(0, 2).map((o, i) =>
          radio(
            o,
            i,
            'p-3 flex flex-col gap-3',
            <>
              <MiniToday theme={o.value as ResolvedTheme} large />
              <span>
                {text(o)}
                {value === 'system' && systemTheme === o.value && <span className="mt-1 inline-block rounded-full bg-accent-soft text-accent text-[11px] font-semibold px-2 py-0.5">Your phone now</span>}
              </span>
            </>,
          ),
        )}
      </div>
      {radio(
        opts[2],
        2,
        'px-4 py-3 flex items-center gap-3',
        <>
          <span className="w-24 shrink-0">
            <SplitPreview />
          </span>
          <span className="min-w-0 flex-1 pr-8">{text(opts[2])}</span>
        </>,
      )}
    </div>
  );
}
