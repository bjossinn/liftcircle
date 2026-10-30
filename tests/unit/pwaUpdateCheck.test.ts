// @vitest-environment jsdom
/**
 * When the app looks for a new service worker (src/pwa/update.ts): hourly and when the page becomes visible again
 * (watchForUpdates, at most once every 5 minutes), and right away from Settings → Check for updates (checkForUpdates).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISIBLE_CHECK_MIN_MS, checkForUpdates, pwaState, resetPwaForTests, subscribePwa, watchForUpdates } from '@/pwa/update';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const MIN = 60 * 1000;

let update: ReturnType<typeof vi.fn>;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  update = vi.fn(async () => {});
  stop = watchForUpdates({ update } as unknown as ServiceWorkerRegistration);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('service-worker update checks', () => {
  it('checks hourly while the app is open', () => {
    vi.advanceTimersByTime(60 * MIN - 1);
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * MIN);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('checks when the page becomes visible again, at most once every 5 minutes', () => {
    expect(VISIBLE_CHECK_MIN_MS).toBe(5 * MIN);
    // right after registration (which already checked): no extra check
    setVisibility('hidden');
    setVisibility('visible');
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * MIN);
    setVisibility('hidden');
    expect(update).not.toHaveBeenCalled(); // going hidden never checks
    setVisibility('visible');
    expect(update).toHaveBeenCalledTimes(1);

    // switching back and forth quickly doesn't hammer the server
    vi.advanceTimersByTime(4 * MIN);
    setVisibility('hidden');
    setVisibility('visible');
    expect(update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1 * MIN);
    setVisibility('hidden');
    setVisibility('visible');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('the hourly check counts toward the 5-minute limit', () => {
    vi.advanceTimersByTime(60 * MIN);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * MIN);
    setVisibility('hidden');
    setVisibility('visible');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('a failed check is swallowed and stopping removes both triggers', async () => {
    update.mockRejectedValueOnce(new Error('offline'));
    vi.advanceTimersByTime(5 * MIN);
    setVisibility('visible');
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(120 * MIN);
    setVisibility('hidden');
    setVisibility('visible');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('manual "Check for updates" (checkForUpdates)', () => {
  class FakeWorker extends EventTarget {
    constructor(public state: ServiceWorkerState) {
      super();
    }
    become(s: ServiceWorkerState) {
      this.state = s;
      this.dispatchEvent(new Event('statechange'));
    }
  }
  const fakeReg = (onUpdate: (reg: { installing: FakeWorker | null; waiting: FakeWorker | null }) => void | Promise<void>) => {
    const reg = { installing: null as FakeWorker | null, waiting: null as FakeWorker | null, update: vi.fn(async () => onUpdate(reg)) };
    return reg;
  };
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });

  beforeEach(() => {
    vi.useRealTimers();
    online = true;
    resetPwaForTests();
  });

  it('no new version → "latest", and nothing is flagged', async () => {
    const reg = fakeReg(() => {});
    expect(await checkForUpdates(reg as never)).toBe('latest');
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(pwaState().needRefresh).toBe(false);
  });

  it('a new version downloads, then waits → "available", flagged for the banner (which shows again)', async () => {
    const w = new FakeWorker('installing');
    const reg = fakeReg((r) => {
      r.installing = w;
    });
    const seen: number[] = [];
    const off = subscribePwa(() => seen.push(pwaState().checkSeq));
    const p = checkForUpdates(reg as never);
    await Promise.resolve();
    await Promise.resolve();
    reg.installing = null;
    reg.waiting = w;
    w.become('installed');
    expect(await p).toBe('available');
    expect(pwaState().needRefresh).toBe(true);
    expect(seen).toEqual([1]);
    off();
  });

  it('an update already waiting is reported without asking the server again', async () => {
    const reg = fakeReg(() => {});
    reg.waiting = new FakeWorker('installed');
    expect(await checkForUpdates(reg as never)).toBe('available');
    expect(await checkForUpdates(reg as never)).toBe('available');
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(pwaState().checkSeq).toBe(2);
  });

  it('offline, no service worker, failed download or failed request → a clear result, never "available"', async () => {
    online = false;
    expect(await checkForUpdates(fakeReg(() => {}) as never)).toBe('offline');
    online = true;
    expect(await checkForUpdates(null)).toBe('unsupported');

    const w = new FakeWorker('installing');
    const p = checkForUpdates(fakeReg((r) => void (r.installing = w)) as never);
    await Promise.resolve();
    await Promise.resolve();
    w.become('redundant');
    expect(await p).toBe('error');

    const stuck = new FakeWorker('installing');
    expect(await checkForUpdates(fakeReg((r) => void (r.installing = stuck)) as never, 20)).toBe('error');

    expect(await checkForUpdates(fakeReg(() => Promise.reject(new Error('500'))) as never)).toBe('error');
    expect(pwaState().needRefresh).toBe(false);
  });
});
