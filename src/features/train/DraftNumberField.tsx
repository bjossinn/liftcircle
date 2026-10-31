import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { clearLocalDraft, formatNumber, parseNumberText, readLocalDraft, saveLocalDraft, useDraftRegistry } from './setDraft';

/**
 * Result of committing a value:
 * - true / undefined → handed to the save queue
 * - a string         → rejected by validation (not saved); shown as the field error, the draft stays
 * - false / Promise<false> → the save failed (storage error); the draft stays so nothing typed is lost
 */
export type CommitResult = void | boolean | string | Promise<boolean>;

export interface DraftNumberFieldProps {
  /** The saved value in display units (null = empty). */
  value: number | null;
  onCommit: (v: number | null) => CommitResult;
  ariaLabel?: string;
  label?: ReactNode;
  hint?: ReactNode;
  placeholder?: string;
  decimals?: boolean;
  min?: number;
  max?: number;
  className?: string;
  inputClassName?: string;
  /** Local-draft key (session:set:field). Enables restore after reload/close. */
  draftKey?: string;
  /** Lets the logger flush this set's fields before completing it. */
  setId?: string;
  /** Debounce before the typed value is written (ms). */
  debounceMs?: number;
  onEnter?: () => void;
  /** Validation error from the caller (e.g. after a failed "Done"). */
  error?: string | null;
}

export const DRAFT_DEBOUNCE_MS = 400;

/**
 * Controlled number field for workout logging. The typed text is kept as a draft (never clobbered while
 * focused, no remounts), mirrored to a local draft on every keystroke, saved after a short debounce, and
 * flushed on blur, Enter, unmount (navigation) and whenever the page asks (set completion, page hidden).
 * Unchanged values are never re-written, so a load entered in another unit keeps its exact physical value.
 */
export function DraftNumberField(props: DraftNumberFieldProps) {
  const { value, decimals = true, min, max, draftKey } = props;
  const auto = useId();
  const registry = useDraftRegistry();
  const [text, setTextState] = useState(() => formatNumber(value));
  const [localError, setLocalError] = useState<string | null>(null);
  const textRef = useRef(text);
  const dirty = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const opts = useRef({ decimals, min, max });
  opts.current = { decimals, min, max };

  const setText = (t: string) => {
    textRef.current = t;
    setTextState(t);
  };

  const flush = useCallback((): string | null => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return null;
    const p = parseNumberText(textRef.current, opts.current);
    if (p.kind === 'invalid') {
      setLocalError(p.reason);
      return p.reason;
    }
    const v = p.kind === 'empty' ? null : p.value;
    const key = propsRef.current.draftKey;
    dirty.current = false;
    if (v === propsRef.current.value) {
      if (key) clearLocalDraft(key);
      setLocalError(null);
      return null;
    }
    const textAtCommit = textRef.current;
    const res = propsRef.current.onCommit(v);
    if (typeof res === 'string') {
      dirty.current = true; // rejected by validation: keep the draft visible and unsaved
      setLocalError(res);
      return res;
    }
    setLocalError(null);
    void Promise.resolve(res).then((ok) => {
      if (ok === false) {
        if (textRef.current === textAtCommit) dirty.current = true; // save failed: keep the draft
        return;
      }
      if (key && !dirty.current) clearLocalDraft(key);
    });
    return null;
  }, []);

  // Follow the saved value unless the user has an unsaved draft (or is typing the same number).
  useEffect(() => {
    if (dirty.current) return;
    const p = parseNumberText(textRef.current, opts.current);
    const same = (p.kind === 'number' && p.value === value) || (p.kind === 'empty' && value == null);
    if (same && focused.current) return;
    if (!same || textRef.current !== formatNumber(value)) setText(formatNumber(value));
  }, [value]);

  // Restore a draft left behind by a reload / closed tab, then save it.
  useEffect(() => {
    if (!draftKey) return;
    const d = readLocalDraft(draftKey);
    if (d == null) return;
    const p = parseNumberText(d, opts.current);
    if ((p.kind === 'number' && p.value === propsRef.current.value) || (p.kind === 'empty' && propsRef.current.value == null)) {
      clearLocalDraft(draftKey);
      return;
    }
    setText(d);
    dirty.current = true;
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Register with the page so it can flush before completion / when hidden; flush on unmount (navigation).
  useEffect(() => {
    const off = registry?.register({ setId: propsRef.current.setId, flush });
    return () => {
      off?.();
      flush();
    };
  }, [registry, flush]);

  const error = localError ?? props.error ?? null;
  const input = (
    <input
      id={auto}
      aria-label={props.ariaLabel}
      inputMode={decimals ? 'decimal' : 'numeric'}
      enterKeyHint="next"
      autoComplete="off"
      placeholder={props.placeholder}
      aria-invalid={!!error || undefined}
      title={error ?? undefined}
      className={clsx(
        'w-full min-h-11 rounded-xl bg-field border border-line-input px-3 text-[16px] text-ink placeholder:text-faint focus:border-accent aria-[invalid=true]:border-danger tabular text-center',
        props.inputClassName,
      )}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onChange={(e) => {
        const t = e.currentTarget.value;
        setText(t);
        dirty.current = true;
        const p = parseNumberText(t, opts.current);
        setLocalError(p.kind === 'invalid' ? p.reason : null);
        if (propsRef.current.draftKey) saveLocalDraft(propsRef.current.draftKey, t);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          flush();
        }, propsRef.current.debounceMs ?? DRAFT_DEBOUNCE_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          flush();
          e.currentTarget.blur();
          propsRef.current.onEnter?.();
        }
      }}
      onBlur={() => {
        focused.current = false;
        flush();
        if (!dirty.current) {
          const p = parseNumberText(textRef.current, opts.current);
          if (p.kind === 'number' && p.value === propsRef.current.value) setText(formatNumber(propsRef.current.value));
        }
      }}
    />
  );
  if (!props.label)
    return (
      <div className={props.className}>
        {input}
        {localError && (
          <p role="alert" className="text-[11px] leading-tight text-danger mt-0.5">
            {localError}
          </p>
        )}
      </div>
    );
  return (
    <div className={props.className}>
      <label htmlFor={auto} className="block text-sm font-medium mb-1.5">
        {props.label}
      </label>
      {input}
      {error ? <p className="text-xs text-danger mt-1">{error}</p> : props.hint ? <p className="text-xs text-muted mt-1">{props.hint}</p> : null}
    </div>
  );
}
