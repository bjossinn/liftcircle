import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Bot, X } from 'lucide-react';

export interface ToastOptions {
  tone?: 'info' | 'success' | 'error' | 'warn';
  action?: { label: string; onClick: () => void };
  duration?: number;
  /**
   * 'coach': a coach cheer from the workout logger — coach avatar, one line, tap to dismiss. Only one is shown at a
   * time (a new one replaces the old), it never takes focus, and it sits left of the set "Done" column and above
   * the rest timer so it never covers them.
   */
  variant?: 'coach';
}
interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}
const Ctx = createContext<{ show: (message: string, opts?: ToastOptions) => void; dismissCoach: () => void } | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const dismissCoach = useCallback(() => setItems((xs) => xs.filter((x) => x.variant !== 'coach')), []);
  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId++;
      setItems((xs) => {
        const plain = xs.filter((x) => x.variant !== 'coach');
        const coach = xs.filter((x) => x.variant === 'coach');
        return opts.variant === 'coach' ? [...plain, { id, message, ...opts }] : [...plain.slice(-2), ...coach, { id, message, ...opts }];
      });
      setTimeout(() => dismiss(id), opts.duration ?? (opts.action && opts.variant !== 'coach' ? 6000 : 3500));
    },
    [dismiss],
  );
  const plain = items.filter((t) => t.variant !== 'coach');
  const coach = items.filter((t) => t.variant === 'coach');
  return (
    <Ctx.Provider value={{ show, dismissCoach }}>
      {children}
      <div aria-live="polite" className="fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 pointer-events-none">
        {plain.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-1.5 text-sm shadow-lg max-w-md w-full bg-surface-3',
              t.tone === 'error' ? 'border-danger/50' : t.tone === 'success' ? 'border-accent/50' : t.tone === 'warn' ? 'border-warn/50' : 'border-line',
            )}
          >
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                className="font-semibold text-accent min-h-11 px-2"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" className="text-muted min-h-11 min-w-11 -mr-2 inline-flex items-center justify-center" onClick={() => dismiss(t.id)}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      {/* Coach cheers: above the rest timer and clear of the right-hand set "Done" column. */}
      <div aria-live="polite" data-coach-region className="fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-50 pointer-events-none">
        <div className="mx-auto max-w-2xl pl-3 pr-[5.5rem]">
          {coach.map((t) => (
            <div
              key={t.id}
              role="status"
              data-coach-cheer
              onClick={() => dismiss(t.id)}
              className="coach-pop pointer-events-auto flex items-center gap-2.5 rounded-2xl border border-accent/40 bg-surface-3 pl-2 pr-1 py-1 text-sm shadow-lg w-fit max-w-full cursor-pointer"
            >
              <span className="size-8 shrink-0 rounded-full bg-accent-soft text-accent flex items-center justify-center" aria-hidden>
                <Bot className="size-4" />
              </span>
              <span className="flex-1 py-1.5 pr-2">
                <span className="sr-only">Training assistant: </span>
                {t.message}
              </span>
              {t.action && (
                <button
                  className="font-semibold text-accent min-h-11 px-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
