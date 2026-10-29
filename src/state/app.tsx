import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ACCOUNT_ROW_ID, getDb, openAccountDb, requestPersistentStorage, type LiftDb } from '@/db/db';
import { saveRecord } from '@/db/repo';
import type { AccountState } from '@/domain/types';
import { defaultAccountState } from './defaults';
import { backendConfigured, supabase } from '@/backend/supabase';

export type AuthStatus = 'loading' | 'guest' | 'signed_in' | 'expired';
export interface AuthInfo {
  status: AuthStatus;
  userId?: string;
  email?: string;
}

interface AppCtx {
  db: LiftDb;
  auth: AuthInfo;
  account: AccountState;
  accountReady: boolean;
  online: boolean;
  backendConfigured: boolean;
  updateAccount: (fn: (a: AccountState) => AccountState) => Promise<void>;
  /** Called by the auth layer after explicit sign-out has handled unsynced data. */
  finishSignOut: () => void;
}

const Ctx = createContext<AppCtx | null>(null);
const LAST_ACCOUNT_KEY = 'lc-last-account';
export const DEMO_KEY = 'lc-demo';
export function isDemoMode(): boolean {
  try {
    return localStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

function readLastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}
function writeLastAccount(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_ACCOUNT_KEY, id);
    else localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    /* ignore */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo>(() => {
    if (!backendConfigured || isDemoMode()) return { status: 'guest' };
    const last = readLastAccount();
    // Optimistically open the previously signed-in account so offline logging works instantly.
    return last ? { status: 'loading', userId: last } : { status: 'loading' };
  });
  const [db, setDb] = useState<LiftDb>(() => openAccountDb(isDemoMode() ? 'demo' : (auth.userId ?? 'guest')));
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    void requestPersistentStorage();
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Auth wiring (Connected mode only).
  useEffect(() => {
    const sb = supabase();
    if (!sb) return;
    let cancelled = false;
    const apply = (userId: string | undefined, email: string | undefined, valid: boolean) => {
      if (cancelled) return;
      if (isDemoMode()) {
        // Demo data is isolated in its own local database and never mixed with an account:
        // while the demo is open the app behaves as signed out (no sync, no sharing).
        setAuth({ status: 'guest' });
        return;
      }
      if (userId) {
        writeLastAccount(userId);
        setDb(openAccountDb(userId));
        setAuth({ status: valid ? 'signed_in' : 'expired', userId, email });
        return;
      }
      const last = readLastAccount();
      if (last) {
        // Not explicitly signed out: keep using that account's local data, pause sync.
        setDb(openAccountDb(last));
        setAuth({ status: 'expired', userId: last });
      } else {
        setDb(openAccountDb('guest'));
        setAuth({ status: 'guest' });
      }
    };
    sb.auth.getSession().then(({ data }) => {
      const s = data.session;
      const valid = !!s && (s.expires_at ?? 0) * 1000 > Date.now();
      apply(s?.user.id, s?.user.email, valid);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return;
      if (session) {
        const last = readLastAccount();
        if (last && last !== session.user.id) {
          // A different account signed in. Its data lives in its own database;
          // queued ops of the previous account stay in theirs and are never sent with these credentials.
        }
        apply(session.user.id, session.user.email, true);
      } else if (event === 'SIGNED_OUT') {
        apply(undefined, undefined, false);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const accountRow = useLiveQuery(async () => (await db.account.get(ACCOUNT_ROW_ID)) ?? null, [db]);
  const account = useMemo(() => accountRow ?? defaultAccountState(), [accountRow]);

  // Apply theme.
  useEffect(() => {
    const t = account.settings.theme;
    const resolved = t === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
    document.documentElement.dataset.theme = resolved;
    try {
      localStorage.setItem('lc-theme', resolved);
    } catch {
      /* ignore */
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f4f6f5' : '#16191d');
  }, [account.settings.theme]);

  const updateAccount = useCallback(
    async (fn: (a: AccountState) => AccountState) => {
      const cur = (await db.account.get(ACCOUNT_ROW_ID)) ?? defaultAccountState();
      await saveRecord('account_state', fn(cur), db);
    },
    [db],
  );

  const finishSignOut = useCallback(() => {
    writeLastAccount(null);
    setDb(openAccountDb('guest'));
    setAuth({ status: 'guest' });
  }, []);

  const value: AppCtx = {
    db,
    auth,
    account,
    accountReady: accountRow !== undefined,
    online,
    backendConfigured,
    updateAccount,
    finishSignOut,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
export const useDb = () => useApp().db;
export const useSettings = () => useApp().account.settings;

/** For non-React modules. */
export { getDb };
