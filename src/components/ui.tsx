/**
 * Shared accessible UI primitives. Every feature uses these so the app reads as one system.
 * Conventions: touch targets ≥ 44px, visible focus, labels on every input. Colours come from the Hard Earned tokens in
 * src/styles.css: one ember primary action per section (charcoal label, 2 px charcoal outline), solid disabled states.
 */
import clsx from 'clsx';
import {
  forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react';

export { clsx as cx };

/**
 * Invisible touch-target extension: compact controls keep their look but get a ≥ 44 px hit area
 * (the ::after box belongs to the element, so taps on it activate the control).
 */
const hit = {
  y4: "relative after:absolute after:inset-x-0 after:-inset-y-1.5", // 36 px (34 inside a border) → ≥ 46 px tall
  y6: "relative after:absolute after:inset-x-0 after:-inset-y-1.5", // 32 px → 44 px tall
  y2: "relative after:absolute after:inset-x-0 after:-inset-y-1", // 40 px (38 inside its border) → ≥ 46 px tall
  all4: "relative after:absolute after:-inset-1", // 36×36 → 44×44
  sw: "relative after:absolute after:inset-x-0 after:-inset-y-2.5", // 28 px switch (26 px inside its border) → ≥ 44 px tall
};

/* --------------------------------------------------------------- Button */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}
const variants: Record<Variant, string> = {
  primary: 'ember-fill font-semibold',
  secondary: 'bg-surface-2 text-ink hover:bg-surface-3 border border-line-input',
  outline: 'border border-line-input text-ink hover:bg-surface-2',
  ghost: 'text-ink hover:bg-surface-2',
  // Kit destructive fill: charcoal label in dark, white in light. Pair it with destructive wording.
  danger: 'danger-fill font-semibold',
};
const sizes: Record<Size, string> = {
  sm: `min-h-9 px-3 text-sm rounded-lg gap-1.5 ${hit.y4}`,
  md: 'min-h-11 px-4 text-[15px] rounded-xl gap-2',
  lg: 'min-h-14 px-5 text-base rounded-xl gap-2',
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'pressable solid-disabled inline-flex items-center justify-center select-none disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(
  function IconButton({ label, className, children, size = 'md', type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={clsx(
          'pressable inline-flex items-center justify-center rounded-xl text-ink hover:bg-surface-2 disabled:text-disabled-ink disabled:hover:bg-transparent',
          size === 'md' ? 'size-11' : `size-9 ${hit.all4}`,
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

/* ----------------------------------------------------------------- Card */
/** `tint` adds a calm colour wash (summary cards); a card with onClick presses down slightly. */
export function Card({ className, children, as: As = 'div', tint, ...rest }: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' | 'li'; tint?: 'accent' | '2' | 'celebrate' | 'streak' } & Record<string, unknown>) {
  return (
    <As className={clsx('rounded-2xl bg-surface border border-line card-shadow', tint && `tint-${tint}`, typeof rest.onClick === 'function' && 'pressable cursor-pointer', className)} {...rest}>
      {children}
    </As>
  );
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between mt-6 mb-2 px-1">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-muted">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'info'; className?: string }) {
  const tones = {
    neutral: 'bg-surface-3 text-muted',
    accent: 'bg-accent-soft text-accent',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-surface-3 text-info',
  };
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

/* ----------------------------------------------------------------- Form */
export function Field({ label, hint, error, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const inputBase =
  'w-full min-h-11 rounded-xl bg-field border border-line-input px-3 text-[16px] text-ink placeholder:text-faint hover:border-muted focus:border-accent aria-[invalid=true]:border-danger disabled:bg-disabled disabled:text-disabled-ink disabled:border-disabled';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null; suffix?: ReactNode }>(
  function Input({ label, hint, error, suffix, className, id, ...rest }, ref) {
    const auto = useId();
    const iid = id ?? auto;
    const input = (
      <div className="relative">
        <input ref={ref} id={iid} aria-invalid={!!error || undefined} className={clsx(inputBase, suffix && 'pr-12', className)} {...rest} />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted pointer-events-none">{suffix}</span>}
      </div>
    );
    if (!label) return input;
    return (
      <Field label={label} hint={hint} error={error} htmlFor={iid}>
        {input}
      </Field>
    );
  },
);

/** Numeric input that brings up the numeric keypad and accepts comma decimals. */
export function NumberInput({
  value, onChange, label, hint, error, suffix, decimals = true, min, max, step, placeholder, className, id, ariaLabel, onEnter, inputClassName,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  suffix?: ReactNode;
  decimals?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  id?: string;
  ariaLabel?: string;
  onEnter?: () => void;
}) {
  const auto = useId();
  const iid = id ?? auto;
  const ref = useRef<HTMLInputElement>(null);
  // Keep the raw string while typing so "2." or "2," aren't clobbered.
  const raw = useRef<string>(value == null ? '' : String(value));
  if (ref.current && document.activeElement !== ref.current) raw.current = value == null ? '' : String(value);
  const el = (
    <div className={clsx('relative', className)}>
      <input
        ref={ref}
        id={iid}
        aria-label={ariaLabel}
        inputMode={decimals ? 'decimal' : 'numeric'}
        enterKeyHint="next"
        autoComplete="off"
        placeholder={placeholder}
        aria-invalid={!!error || undefined}
        className={clsx(inputBase, 'tabular text-center', suffix && 'pr-10', inputClassName)}
        defaultValue={value == null ? '' : String(value)}
        key={value == null ? 'empty' : String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
            onEnter?.();
          }
        }}
        onBlur={(e) => {
          const s = e.currentTarget.value.replace(',', '.').trim();
          if (s === '') return onChange(null);
          let n = Number(s);
          if (!isFinite(n)) {
            e.currentTarget.value = value == null ? '' : String(value);
            return;
          }
          if (!decimals) n = Math.round(n);
          if (min != null) n = Math.max(min, n);
          if (max != null) n = Math.min(max, n);
          if (n !== value) onChange(n);
          else e.currentTarget.value = String(n);
        }}
        data-step={step}
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">{suffix}</span>}
    </div>
  );
  if (!label) return el;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid}>
      {el}
    </Field>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null }>(
  function Textarea({ label, hint, error, className, id, ...rest }, ref) {
    const auto = useId();
    const iid = id ?? auto;
    const el = <textarea ref={ref} id={iid} aria-invalid={!!error || undefined} className={clsx(inputBase, 'py-2.5 min-h-24', className)} {...rest} />;
    if (!label) return el;
    return (
      <Field label={label} hint={hint} error={error} htmlFor={iid}>
        {el}
      </Field>
    );
  },
);

export function Select({ label, hint, error, className, id, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null }) {
  const auto = useId();
  const iid = id ?? auto;
  const el = (
    <select id={iid} className={clsx(inputBase, 'appearance-none pr-8', className)} {...rest}>
      {children}
    </select>
  );
  if (!label) return el;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid}>
      {el}
    </Field>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2 min-h-11">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[15px] text-ink">
          {label}
        </label>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('shrink-0 h-7 w-12 rounded-full transition-colors duration-[120ms] border solid-disabled', hit.sw, checked ? 'bg-ember border-edge' : 'bg-surface-3 border-line-input')}
      >
        <span className={clsx('absolute left-0 top-0.5 size-6 rounded-full shadow transition-transform duration-[120ms]', checked ? 'translate-x-5.5 bg-accent-ink' : 'translate-x-0.5 bg-ink')} />
      </button>
    </div>
  );
}

/** Segmented single choice (radio group semantics). */
export function Segmented<T extends string | number>({ value, onChange, options, label, className, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx('flex p-1 rounded-xl bg-surface-2 border border-line gap-1', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'flex-1 rounded-lg px-2 font-medium transition-colors duration-[120ms]',
            size === 'md' ? `min-h-9 text-sm ${hit.y4}` : `min-h-8 text-xs ${hit.y6}`,
            o.value === value ? 'bg-accent-soft text-ink font-semibold shadow-[inset_0_0_0_1.5px_var(--c-accent)]' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select chips (checkbox semantics). */
export function ChipGroup<T extends string | number>({ values, onChange, options, label, single }: { values: T[]; onChange: (v: T[]) => void; options: { value: T; label: ReactNode }[]; label: string; single?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            role={single ? 'radio' : 'checkbox'}
            aria-checked={on}
            onClick={() => onChange(single ? [o.value] : on ? values.filter((v) => v !== o.value) : [...values, o.value])}
            className={clsx(
              'pressable min-h-10 px-3.5 rounded-full border text-sm inline-flex items-center gap-1.5',
              hit.y2,
              on ? 'bg-accent-soft border-accent text-ink font-medium' : 'border-line-input text-ink hover:bg-surface-2',
            )}
          >
            {on && <Check className="size-3.5 text-accent shrink-0" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- States */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

/** `illustration` (src/components/illustrations.tsx) replaces the small icon tile with a friendly drawing. */
export function EmptyState({ icon, illustration, title, body, action }: { icon?: ReactNode; illustration?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-10 gap-3">
      {illustration ? <div className="w-36 max-w-[60%]">{illustration}</div> : icon && <div className="size-12 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">{icon}</div>}
      <h3 className="text-lg font-bold">{title}</h3>
      {body && <p className="text-sm text-muted max-w-xs">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center text-center px-6 py-8 gap-3">
      <AlertTriangle className="size-6 text-danger" aria-hidden />
      <h3 className="text-base font-semibold">{title}</h3>
      {message && <p className="text-sm text-muted max-w-xs">{message}</p>}
      {onRetry && (
        <Button onClick={onRetry} icon={<RefreshCw className="size-4" />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'danger' | 'accent'; children: ReactNode; className?: string }) {
  const t = { info: 'bg-surface-2 text-ink', warn: 'bg-warn-soft text-ink border-warn/30', danger: 'bg-danger-soft text-ink border-danger/30', accent: 'bg-success-soft text-ink border-success/40' };
  return <div className={clsx('rounded-xl border border-line px-3.5 py-3 text-sm', t[tone], className)}>{children}</div>;
}

/* ---------------------------------------------------------------- Sheet */
/**
 * Height of the on-screen keyboard (or other UI) covering the bottom of the layout viewport.
 * Browsers that resize only the visual viewport (iOS Safari, Android Chrome by default) would otherwise
 * leave a bottom sheet's fields and buttons under the keyboard.
 */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setInset(0);
    };
  }, [active]);
  return inset;
}

const SHEET_CLOSE_MS = 200;

/**
 * Bottom sheet on phones / centered dialog on larger screens, built on <dialog>
 * for native focus trapping, Escape handling and focus return on close.
 */
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const kb = useKeyboardInset(open);
  // Ignore insets too small to be a keyboard (browser toolbars collapsing etc.).
  const inset = kb > 80 ? kb : 0;
  // Keep the content for the closing slide-down (styles.css → dialog.sheet), then unmount it.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), SHEET_CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  const maxH = inset ? `calc(92dvh - ${inset}px)` : undefined;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      style={inset ? { marginBottom: inset, maxHeight: maxH } : undefined}
      className={clsx(
        'sheet m-0 mt-auto sm:m-auto w-full max-w-none sm:max-w-lg bg-surface text-ink border border-line p-0',
        'rounded-t-3xl sm:rounded-3xl max-h-[92dvh] backdrop:backdrop-blur-[1px]',
        wide && 'sm:max-w-2xl',
      )}
    >
      {(open || mounted) && (
        <div className="flex flex-col max-h-[92dvh]" style={maxH ? { maxHeight: maxH } : undefined}>
          <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
            <h2 id={titleId} className="font-display text-lg font-bold min-w-0 break-words">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose} size="sm" className="shrink-0">
              <X className="size-5" />
            </IconButton>
          </div>
          <div
            className="px-5 pb-4 overflow-y-auto overscroll-contain"
            onFocus={(e) => {
              // Keep the focused field visible above the keyboard once it has opened.
              const t = e.target as HTMLElement;
              if (t.matches?.('input, textarea, select, [contenteditable="true"]')) setTimeout(() => t.scrollIntoView?.({ block: 'nearest' }), 350);
            }}
          >
            {children}
          </div>
          {footer && <div className="px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-line flex flex-wrap gap-2 justify-end">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel, busy, children }: { open: boolean; title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; busy?: boolean; children?: ReactNode }) {
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-sm text-muted">{body}</div>}
      {children}
    </Sheet>
  );
}

/* --------------------------------------------------------------- Layout */
export function Page({ title, back, actions, children, className }: { title?: ReactNode; back?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('mx-auto w-full max-w-2xl px-4 pb-6', className)}>
      {(title || actions || back) && (
        <header className="flex items-center gap-2 pt-3 pb-2 min-h-14">
          {back}
          {title && <h1 className="text-[28px] leading-8 flex-1 min-w-0 truncate">{title}</h1>}
          {actions && <div className="flex items-center gap-1 ml-auto">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

export function ListRow({ title, subtitle, left, right, onClick, href, className }: { title: ReactNode; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode; onClick?: () => void; href?: string; className?: string }) {
  const inner = (
    <>
      {left && <div className="shrink-0">{left}</div>}
      <div className="min-w-0 flex-1 text-left">
        <div className="text-[15px] font-medium truncate">{title}</div>
        {subtitle && <div className="text-xs text-muted truncate mt-0.5">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0 text-muted">{right}</div>}
    </>
  );
  const cls = clsx('flex items-center gap-3 w-full px-4 py-3 min-h-14 hover:bg-surface-2 transition-colors', (href || onClick) && 'pressable', className);
  if (href)
    return (
      <a href={href} className={cls}>
        {inner}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xl font-semibold tabular">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

export function ProgressBar({ value, max, label, tone = 'accent' }: { value: number; max: number; label: string; tone?: 'accent' | 'warn' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 rounded-full bg-surface-3 overflow-hidden">
      <div className={clsx('h-full rounded-full transition-[width] duration-200', tone === 'accent' ? 'bg-ember' : 'bg-warn')} style={{ width: `${pct}%` }} />
    </div>
  );
}
