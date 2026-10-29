import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export interface ToastOptions {
  tone?: 'info' | 'success' | 'error' | 'warn';
  action?: { label: string; onClick: () => void };
  duration?: number;
}
interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}
const Ctx = createContext<{ show: (message: string, opts?: ToastOptions) => void } | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId++;
      setItems((xs) => [...xs.slice(-2), { id, message, ...opts }]);
      setTimeout(() => dismiss(id), opts.duration ?? (opts.action ? 6000 : 3500));
    },
    [dismiss],
  );
  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div aria-live="polite" className="fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 pointer-events-none">
        {items.map((t) => (
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
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
