/**
 * Where to go after signing in / creating an account.
 *
 * Gates (Feed, Coaching…) link to `/auth?mode=signup&next=/feed`. The destination is:
 *  - kept in the URL while the person switches between "Sign in" and "Create account";
 *  - remembered on this device (localStorage, 24 h) so the email-confirmation link, which opens
 *    /auth/callback without our query parameters (the redirect URL must match the allow-list exactly),
 *    still returns to it;
 *  - only ever an in-app path (no other origins, no protocol-relative URLs, never back to /auth).
 */
const KEY = 'lc-auth-return';
const TTL_MS = 24 * 3600 * 1000;

export type AuthMode = 'signin' | 'signup';

/** A same-app path like '/feed' or '/coaching/find?x=1', or null. */
export function safeReturnPath(p: string | null | undefined): string | null {
  if (!p || typeof p !== 'string' || p.length > 300) return null;
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\s]/.test(p)) return null;
  if (/^\/auth(\/|\?|#|$)/.test(p)) return null;
  try {
    const u = new URL(p, 'https://app.invalid');
    if (u.origin !== 'https://app.invalid') return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** Link to the auth screen in the given mode that comes back to `next` afterwards. */
export function authHref(mode: AuthMode, next?: string | null): string {
  const q = new URLSearchParams();
  if (mode === 'signup') q.set('mode', 'signup');
  const safe = safeReturnPath(next);
  if (safe) q.set('next', safe);
  const s = q.toString();
  return s ? `/auth?${s}` : '/auth';
}

export function rememberReturn(path: string | null) {
  try {
    const safe = safeReturnPath(path);
    if (safe) localStorage.setItem(KEY, JSON.stringify({ path: safe, at: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the destination just isn't remembered across the email link */
  }
}

export function peekReturn(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { path?: string; at?: number };
    if (typeof v.at !== 'number' || now - v.at > TTL_MS) return null;
    return safeReturnPath(v.path);
  } catch {
    return null;
  }
}

/** Read and forget the remembered destination. */
export function takeReturn(): string | null {
  const p = peekReturn();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return p;
}
