/**
 * Device health for offline use: service-worker availability and local storage (IndexedDB) state.
 * Failures are recorded here and shown by <HealthBanner />; nothing in here ever throws, so a broken
 * service worker or blocked storage can never take the app down with it.
 */
type Listener = () => void;

export type SwHealth =
  | 'pending' // not known yet
  | 'ready' // a service worker controls (or will control) this app: offline works after first load
  | 'unsupported' // browser/private mode without service workers: works online only
  | 'error'; // registration or precache install failed
export type StorageHealth = 'ok' | 'unavailable' | 'quota' | 'unknown';

export interface Health {
  sw: SwHealth;
  swError?: string;
  storage: StorageHealth;
  storageError?: string;
  /** navigator.storage.persisted(): true = protected from eviction, false = best-effort, null = unknown/unsupported. */
  persisted: boolean | null;
}

let state: Health = { sw: 'pending', storage: 'unknown', persisted: null };
const listeners = new Set<Listener>();
const set = (patch: Partial<Health>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const getHealth = () => state;
export function subscribeHealth(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
/** Test helper. */
export function resetHealth() {
  state = { sw: 'pending', storage: 'unknown', persisted: null };
  listeners.forEach((l) => l());
}

const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? 'unknown error')).slice(0, 300);

export function reportSwReady() {
  if (state.sw !== 'error') set({ sw: 'ready', swError: undefined });
}
export function reportSwUnsupported() {
  set({ sw: 'unsupported' });
}
export function reportSwError(e: unknown) {
  set({ sw: 'error', swError: message(e) });
}

const QUOTA = /quota/i;
/** Errors that only IndexedDB/Dexie produce: always a storage failure. */
const DEXIE_ONLY = /^(MissingAPIError|OpenFailedError|VersionError)$/;
/** Generic DOMException names: a storage failure only while opening the database (probe), not from arbitrary code. */
const GENERIC = /^(InvalidStateError|SecurityError|UnknownError|AbortError)$/;

/**
 * Classify an IndexedDB/Dexie error. Returns null for errors that aren't storage failures.
 * `opening` = the error came from opening the database, so generic DOMException names count too.
 */
export function classifyStorageError(e: unknown, opening = false, depth = 0): Exclude<StorageHealth, 'ok' | 'unknown'> | null {
  if (!e || typeof e !== 'object' || depth > 3) return null;
  const err = e as { name?: string; message?: string; inner?: unknown; cause?: unknown };
  const name = err.name ?? '';
  if (QUOTA.test(name) || /QuotaExceeded/i.test(err.message ?? '')) return 'quota';
  if (DEXIE_ONLY.test(name)) return 'unavailable';
  // Wrapped errors: Dexie's `inner`, and `cause` (e.g. repo.ts StorageWriteError around a failed transaction).
  for (const wrapped of [err.inner, err.cause]) {
    const k = classifyStorageError(wrapped, opening || name === 'DatabaseClosedError', depth + 1);
    if (k) return k;
  }
  // After a failed open, Dexie rejects every query with DatabaseClosedError wrapping the cause. A bare
  // DatabaseClosedError (no inner) is the normal result of closing the previous account's database.
  if (name === 'DatabaseClosedError' && err.inner) return 'unavailable';
  if (opening && GENERIC.test(name)) return 'unavailable';
  return null;
}

/** Record a storage failure (safe to call with any error; non-storage errors are ignored). */
export function reportStorageError(e: unknown, opening = false): boolean {
  const kind = classifyStorageError(e, opening);
  if (!kind) return false;
  // "unavailable" is the more serious state; a later quota error must not hide it.
  if (state.storage === 'unavailable' && kind === 'quota') return true;
  set({ storage: kind, storageError: message(e) });
  return true;
}
export function reportStorageOk() {
  if (state.storage === 'unknown') set({ storage: 'ok' });
}
export function reportPersisted(p: boolean | null) {
  if (state.persisted !== p) set({ persisted: p });
}

/** Opens the current account database once to find out whether this browser lets us store data. */
export async function probeStorage(open: () => Promise<unknown>): Promise<StorageHealth> {
  try {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reportStorageError(Object.assign(new Error('IndexedDB API missing'), { name: 'MissingAPIError' }));
      return state.storage;
    }
    await open();
    reportStorageOk();
  } catch (e) {
    // Any failure to open the database means we can't keep data on this device.
    if (!reportStorageError(e, true)) reportStorageError(Object.assign(new Error(message(e)), { name: 'OpenFailedError' }));
  }
  try {
    const persisted = typeof navigator !== 'undefined' && navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    reportPersisted(persisted);
  } catch {
    reportPersisted(null);
  }
  return state.storage;
}

let globalHooked = false;
/** Catch storage failures that escape feature code (unhandled promise rejections from Dexie writes). */
export function watchUnhandledStorageErrors() {
  if (globalHooked || typeof window === 'undefined') return;
  globalHooked = true;
  window.addEventListener('unhandledrejection', (ev) => {
    reportStorageError(ev.reason);
  });
}
