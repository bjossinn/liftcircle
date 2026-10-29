/**
 * Offline-health reporting (src/pwa/health.ts): storage failures are recognised and surfaced, unrelated
 * errors are ignored, and a browser without IndexedDB is reported instead of hanging on "Loading…".
 */
import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { classifyStorageError, getHealth, probeStorage, reportStorageError, reportSwError, reportSwReady, resetHealth } from '@/pwa/health';
import { LiftDb } from '@/db/db';
import { StorageWriteError } from '@/db/repo';

const named = (name: string, message = name) => Object.assign(new Error(message), { name });

afterEach(() => resetHealth());

describe('storage error classification', () => {
  it('recognises quota errors, also when wrapped by Dexie or by saveRecord', () => {
    expect(classifyStorageError(named('QuotaExceededError'))).toBe('quota');
    expect(classifyStorageError(named('AbortError', 'Transaction aborted: QuotaExceededError'))).toBe('quota');
    expect(classifyStorageError(Object.assign(named('AbortError'), { inner: named('QuotaExceededError') }))).toBe('quota');
    expect(classifyStorageError(new StorageWriteError(named('QuotaExceededError')))).toBe('quota');
  });

  it('recognises a missing / blocked / newer database', () => {
    expect(classifyStorageError(named('MissingAPIError'))).toBe('unavailable');
    expect(classifyStorageError(named('OpenFailedError'))).toBe('unavailable');
    expect(classifyStorageError(named('VersionError'))).toBe('unavailable');
    expect(classifyStorageError(Object.assign(named('DatabaseClosedError'), { inner: named('SecurityError') }))).toBe('unavailable');
    // generic DOMException names count only while opening the database
    expect(classifyStorageError(named('SecurityError'), true)).toBe('unavailable');
    expect(classifyStorageError(named('InvalidStateError'), true)).toBe('unavailable');
  });

  it('ignores unrelated errors and the normal "database closed" after an account switch', () => {
    expect(classifyStorageError(named('DatabaseClosedError'))).toBeNull();
    expect(classifyStorageError(named('SecurityError'))).toBeNull();
    expect(classifyStorageError(named('NotAllowedError'))).toBeNull(); // wake lock / clipboard
    expect(classifyStorageError(new TypeError('Failed to fetch'))).toBeNull();
    expect(classifyStorageError('boom')).toBeNull();
    expect(classifyStorageError(null)).toBeNull();
    expect(reportStorageError(new TypeError('x'))).toBe(false);
    expect(getHealth().storage).toBe('unknown');
  });

  it('a later quota error never hides "storage unavailable"', () => {
    reportStorageError(named('MissingAPIError'));
    reportStorageError(named('QuotaExceededError'));
    expect(getHealth().storage).toBe('unavailable');
  });
});

describe('probeStorage', () => {
  it('reports ok when the account database opens', async () => {
    const db = new LiftDb('health-probe-ok');
    expect(await probeStorage(() => db.open())).toBe('ok');
    db.close();
    await db.delete();
  });

  it('reports unavailable for any failure to open (e.g. SecurityError in a locked-down private window)', async () => {
    expect(await probeStorage(() => Promise.reject(named('SecurityError', 'The operation is insecure.')))).toBe('unavailable');
    resetHealth();
    expect(await probeStorage(() => Promise.reject(new Error('weird')))).toBe('unavailable');
  });

  it('a browser without IndexedDB is reported (Dexie MissingAPIError) instead of loading forever', async () => {
    const saved = Dexie.dependencies.indexedDB;
    try {
      (Dexie.dependencies as { indexedDB?: unknown }).indexedDB = undefined;
      const db = new LiftDb('health-probe-missing');
      expect(await probeStorage(() => db.open())).toBe('unavailable');
      expect(getHealth().storageError).toMatch(/MissingAPIError|IndexedDB/i);
    } finally {
      Dexie.dependencies.indexedDB = saved;
    }
  });
});

describe('service worker health', () => {
  it('records registration failures and keeps them over a later "ready"', () => {
    reportSwError(new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404)'));
    expect(getHealth()).toMatchObject({ sw: 'error' });
    expect(getHealth().swError).toMatch(/404/);
    reportSwReady();
    expect(getHealth().sw).toBe('error');
  });
});
