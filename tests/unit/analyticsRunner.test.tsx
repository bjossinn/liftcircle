// @vitest-environment jsdom
/**
 * AnalyticsRunner follows the consent setting from the live account record, so an opt-out arriving from any source
 * (Settings, sync from another device, a backup restore) deletes the queue and stops sending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, account: h.account, auth: { status: 'signed_in', userId: (h.db as { accountKey: string }).accountKey }, online: true }),
}));

import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { AnalyticsRunner, QUEUE_KEY, resetAnalyticsState, setAnalyticsTransport, trackWorkoutStarted, type WireEvent } from '@/analytics/analytics';

let root: Root;
let n = 0;
const sent: WireEvent[][] = [];
const render = () => act(async () => root.render(createElement(AnalyticsRunner)));
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

beforeEach(() => {
  h.db = new LiftDb(`runner-${++n}`);
  h.account = defaultAccountState();
  sent.length = 0;
  resetAnalyticsState();
  setAnalyticsTransport(async (e) => void sent.push(e));
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetAnalyticsState();
  setAnalyticsTransport(null);
  (h.db as LiftDb).close();
});

describe('AnalyticsRunner', () => {
  it('sends while consented; when the account record switches analytics off (e.g. via sync), deletes the queue', async () => {
    const db = h.db as LiftDb;
    await trackWorkoutStarted(db, 'empty');
    await render();
    await tick();
    expect(sent.flat().length).toBe(1);

    // Queue something while the transport is unavailable, then the opt-out arrives as a new account record.
    setAnalyticsTransport(async () => {
      throw new Error('Failed to fetch');
    });
    await trackWorkoutStarted(db, 'template');
    const acc = defaultAccountState();
    h.account = { ...acc, settings: { ...acc.settings, analytics: false } };
    await render();
    await tick();
    expect(await db.kv.get(QUEUE_KEY)).toBeUndefined();
  });
});
