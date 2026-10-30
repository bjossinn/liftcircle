// @vitest-environment jsdom
/**
 * When the app looks for a new service worker (src/pwa/update.ts → watchForUpdates): hourly, and when the
 * page becomes visible again, at most once every 5 minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISIBLE_CHECK_MIN_MS, watchForUpdates } from '@/pwa/update';

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
