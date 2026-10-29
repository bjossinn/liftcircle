import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLog, Exercise, Settings, ShareFields, WorkoutSession } from '@/domain/types';
import type { NewPostInput as NewPostInputLike } from '@/backend/contract';

/* ---------------------------------------------------------------- socialApi mock */
const api = vi.hoisted(() => {
  const state = {
    drafts: new Map<string, unknown>(),
    uploaded: new Set<string>(),
    published: new Set<string>(),
    failUploadOnce: new Set<string>(),
    failPublish: false,
  };
  const socialApi = {
    createPostDraft: vi.fn(async (input: { id: string }) => {
      state.drafts.set(input.id, input); // idempotent upsert
    }),
    uploadPostMedia: vi.fn(async (postId: string, mediaId: string) => {
      if (state.failUploadOnce.has(mediaId)) {
        state.failUploadOnce.delete(mediaId);
        throw new Error('Failed to fetch');
      }
      state.uploaded.add(`${postId}/${mediaId}`);
    }),
    publishPost: vi.fn(async (postId: string) => {
      if (state.failPublish) throw new Error('Media missing');
      state.published.add(postId);
      return { id: postId };
    }),
    deletePost: vi.fn(async () => {}),
  };
  return { state, socialApi };
});
vi.mock('@/backend/social', () => ({ socialApi: api.socialApi }));

import { LiftDb } from '@/db/db';
import { buildActivitySnapshot, buildWorkoutSnapshot } from '@/social/snapshot';
import { fitWithin, hasExifOrGps, readImageDimensions, sniffImageType, checkInput, MediaError } from '@/social/media';
import { cancelPendingPost, processPendingPosts, queuePost, retryPendingPost, setPendingPostsAccount, friendlyError } from '@/social/pendingPosts';
import { maybeAutoShare } from '@/social/autoShare';
import { defaultSettings } from '@/state/defaults';

/* ---------------------------------------------------------------- fixtures */
const ex = (id: string, name: string, extra: Partial<Exercise> = {}): Exercise =>
  ({
    id, name, aliases: [], category: 'compound', primaryMuscles: ['chest'], secondaryMuscles: [], pattern: 'horizontal_push',
    equipment: ['barbell'], difficulty: 2, tracking: 'weight_reps', load: 'total', stresses: [], setup: '', execution: '',
    cues: [], mistakes: [], substitutions: [], ...extra,
  }) as Exercise;

const byId = new Map<string, Exercise>([
  ['bench', ex('bench', 'Barbell bench press')],
  ['db-curl', ex('db-curl', 'Dumbbell curl', { load: 'per_hand', implements: 2 })],
  ['plank', ex('plank', 'Plank', { tracking: 'duration', load: 'none' })],
]);

const session: WorkoutSession = {
  id: 'private-session-id-123',
  createdAt: 0,
  updatedAt: 0,
  name: 'Upper A',
  status: 'completed',
  programId: 'private-program-id',
  templateId: 'private-template-id',
  date: '2026-10-20',
  timeZone: 'UTC',
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 50 * 60_000 + 5 * 60_000,
  pausedTotalMs: 5 * 60_000,
  notes: 'knee felt weird — private note',
  exercises: [
    {
      id: 'se-1', exerciseId: 'bench', order: 0, notes: 'private exercise note',
      sets: [
        { id: 's0', type: 'warmup', weightKg: 40, reps: 10, completed: true },
        { id: 's1', type: 'normal', weightKg: 80, reps: 8, rpe: 8, completed: true },
        { id: 's2', type: 'normal', weightKg: 80, reps: 7, completed: true },
        { id: 's3', type: 'normal', weightKg: 80, reps: 6, completed: false },
      ],
    },
    { id: 'se-2', exerciseId: 'db-curl', order: 1, sets: [{ id: 's4', type: 'normal', weightKg: 12, reps: 10, completed: true }] },
    { id: 'se-3', exerciseId: 'plank', order: 2, sets: [{ id: 's5', type: 'timed', durationSec: 60, completed: true }] },
  ],
};

const activity: ActivityLog = {
  id: 'private-activity-id', createdAt: 0, updatedAt: 0, type: 'run', date: '2026-10-21', timeZone: 'UTC',
  durationSec: 1500, distanceM: 5000, avgHr: 163, notes: 'private', energyKcal: 432,
};

const NONE: ShareFields = { duration: false, exerciseNames: false, weightsReps: false, volume: false, records: false };
const ALL: ShareFields = { duration: true, exerciseNames: true, weightsReps: true, volume: true, records: true };
const allText = (o: unknown) => JSON.stringify(o);

/* ================================================================ snapshot */
describe('snapshot field selection', () => {
  it('includes nothing beyond title/kind/date when no fields are selected', () => {
    const s = buildWorkoutSnapshot(session, NONE, { byId, unit: 'kg', records: [{ exercise: 'Bench', label: 'Heaviest 80 kg' }] });
    expect(Object.keys(s).sort()).toEqual(['date', 'kind', 'title']);
    expect(s.title).toBe('Upper A');
  });

  it('omits unselected fields and never copies private ids or notes', () => {
    const s = buildWorkoutSnapshot(session, { ...NONE, duration: true, exerciseNames: true }, { byId, unit: 'kg' });
    expect(s.durationSec).toBe(50 * 60);
    expect(s.exercises?.map((e) => e.name)).toEqual(['Barbell bench press', 'Dumbbell curl', 'Plank']);
    expect(s.exercises?.every((e) => !('sets' in e))).toBe(true);
    expect('volume' in s).toBe(false);
    expect('records' in s).toBe(false);
    const text = allText(s);
    for (const secret of ['private-session-id-123', 'private-program-id', 'private-template-id', 'se-1', 's1', 'private', 'rpe']) {
      expect(text).not.toContain(secret);
    }
  });

  it('copies working sets, volume and records when selected', () => {
    const s = buildWorkoutSnapshot(session, ALL, { byId, unit: 'kg', records: [{ exercise: 'Barbell bench press', label: 'Heaviest: 80 kg' }] });
    expect(s.exercises?.[0].sets).toEqual([{ weight: '80 kg', reps: 8 }, { weight: '80 kg', reps: 7 }]); // warm-up & incomplete excluded
    expect(s.exercises?.[1].sets).toEqual([{ weight: '12 kg each', reps: 10 }]);
    expect(s.exercises?.[2].sets).toEqual([{ duration: '1:00' }]);
    expect(s.volume).toEqual({ value: 80 * 8 + 80 * 7 + 12 * 10 * 2, unit: 'kg', convention: 'Free-weight working sets' });
    expect(s.records).toEqual([{ exercise: 'Barbell bench press', label: 'Heaviest: 80 kg' }]);
    expect(allText(s)).not.toContain('private-session-id-123');
  });

  it('is a copy: later edits to the workout do not change it', () => {
    const copy = structuredClone(session);
    const s = buildWorkoutSnapshot(copy, ALL, { byId, unit: 'kg' });
    copy.exercises[0].sets[1].weightKg = 200;
    copy.name = 'Changed';
    expect(s.title).toBe('Upper A');
    expect(s.exercises?.[0].sets?.[0].weight).toBe('80 kg');
  });

  it('activity: distance needs volume, pace needs duration AND distance; private fields never copied', () => {
    const none = buildActivitySnapshot(activity, NONE, { distanceUnit: 'km' });
    expect(none.activity).toEqual({ type: 'run', label: 'Run' });
    expect('durationSec' in none).toBe(false);
    const distOnly = buildActivitySnapshot(activity, { ...NONE, volume: true }, { distanceUnit: 'km' });
    expect(distOnly.activity?.distance).toBe('5 km');
    expect(distOnly.activity?.pace).toBeUndefined();
    const full = buildActivitySnapshot(activity, ALL, { distanceUnit: 'km' });
    expect(full.durationSec).toBe(1500);
    expect(full.activity?.pace).toBe('5:00 /km');
    const text = allText(full);
    for (const secret of ['private-activity-id', 'private', '163', '432', 'avgHr', 'energy']) expect(text).not.toContain(secret);
  });
});

/* ================================================================ media */
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
const SOI = [0xff, 0xd8];
const SOS = seg(0xda, [1, 1, 0, 0, 0x3f, 0]);
const APP0 = seg(0xe0, [...str('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

describe('JPEG metadata detector', () => {
  it('clean JFIF header → false', () => {
    expect(hasExifOrGps(bytes(SOI, APP0, seg(0xdb, new Array(65).fill(1)), SOS, [0x12, 0x34, 0xff, 0xd9]))).toBe(false);
  });
  it('APP1 Exif → true', () => {
    expect(hasExifOrGps(bytes(SOI, seg(0xe1, [...str('Exif'), 0, 0, 0x4d, 0x4d, 0, 0x2a]), SOS))).toBe(true);
  });
  it('Exif after other segments and fill bytes → true', () => {
    expect(hasExifOrGps(bytes(SOI, APP0, [0xff], seg(0xe1, [...str('Exif'), 0, 0]), SOS))).toBe(true);
  });
  it('XMP packet → true', () => {
    expect(hasExifOrGps(bytes(SOI, seg(0xe1, [...str('http://ns.adobe.com/xap/1.0/'), 0, ...str('<x:xmpmeta/>')]), SOS))).toBe(true);
  });
  it('any APPn mentioning GPS → true; Photoshop IRB → true', () => {
    expect(hasExifOrGps(bytes(SOI, seg(0xe5, str('vendor GPSLatitude')), SOS))).toBe(true);
    expect(hasExifOrGps(bytes(SOI, seg(0xed, [...str('Photoshop 3.0'), 0]), SOS))).toBe(true);
  });
  it('GPS-looking bytes inside the entropy-coded scan are ignored', () => {
    expect(hasExifOrGps(bytes(SOI, APP0, SOS, str('GPSExif'), [0xff, 0xd9]))).toBe(false);
  });
  it('truncated or malformed headers fail safe (true); non-JPEG → false', () => {
    expect(hasExifOrGps(bytes(SOI, [0xff, 0xe0, 0x00, 0x40, 1, 2]))).toBe(true);
    expect(hasExifOrGps(bytes(SOI, [0x00, 0x11]))).toBe(true);
    expect(hasExifOrGps(bytes('\x89PNG\r\n\x1a\n'))).toBe(false);
  });
});

describe('media helpers', () => {
  it('sniffs formats by magic bytes', () => {
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImageType(bytes('GIF89a'))).toBe('gif');
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic'))).toBe('heic');
    expect(sniffImageType(bytes('%PDF-1.7'))).toBeNull();
  });
  it('reads PNG/GIF/JPEG dimensions from headers', () => {
    const png = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR', [0, 0, 0x1f, 0x40, 0, 0, 0x17, 0x70]);
    expect(readImageDimensions(png)).toEqual({ width: 8000, height: 6000 });
    expect(readImageDimensions(bytes('GIF89a', [0x40, 0x01, 0xf0, 0x00]))).toEqual({ width: 320, height: 240 });
    const jpg = bytes(SOI, APP0, seg(0xc0, [8, 0x0b, 0xb8, 0x0f, 0xa0, 3]), SOS);
    expect(readImageDimensions(jpg)).toEqual({ width: 4000, height: 3000 });
  });
  it('rejects oversize, unsupported and too-many-pixel inputs before decoding', () => {
    const png = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR', [0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10]); // 10000×10000
    expect(() => checkInput({ size: 26 * 1024 * 1024, type: 'image/jpeg' }, bytes([0xff, 0xd8, 0xff]))).toThrow(MediaError);
    expect(() => checkInput({ size: 100, type: 'application/pdf' }, bytes('%PDF'))).toThrow(/isn’t supported/);
    expect(() => checkInput({ size: 1000, type: 'image/png' }, png)).toThrow(/50 megapixels/);
    expect(checkInput({ size: 1000, type: 'image/heic' }, bytes('????'))).toBe('heic');
  });
  it('fits within the long edge without upscaling', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1000, 3000, 480)).toEqual({ width: 160, height: 480 });
    expect(fitWithin(300, 200, 2048)).toEqual({ width: 300, height: 200 });
  });
});

/* ================================================================ pending posts */
const ACCOUNT = 'user-abc';
let db: LiftDb;
let n = 0;
const photo = (id: string) => ({ id, blob: new Blob([new Uint8Array([0xff, 0xd8, 1])], { type: 'image/jpeg' }), thumb: new Blob([new Uint8Array([2])], { type: 'image/jpeg' }), width: 10, height: 10 });
const basePost = (id: string, photos = [photo('m1'), photo('m2')]) => ({
  id, kind: 'workout' as const, audience: 'friends' as const, caption: 'Leg day', snapshot: { title: 'Legs', kind: 'workout' as const, date: '2026-10-20' }, sourceRecordId: 'private-session-id-123', photos,
});
const setOnline = (v: boolean) => vi.stubGlobal('navigator', { onLine: v });

beforeEach(() => {
  db = new LiftDb(`${ACCOUNT}-${++n}`);
  setPendingPostsAccount(db.accountKey);
  setOnline(true);
  api.state.drafts.clear();
  api.state.uploaded.clear();
  api.state.published.clear();
  api.state.failUploadOnce.clear();
  api.state.failPublish = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
});

describe('pending posts', () => {
  it('offline → stays "waiting" and nothing is sent', async () => {
    setOnline(false);
    await queuePost(basePost('p1'), db);
    await processPendingPosts(db);
    const row = await db.pendingPosts.get('p1');
    expect(row?.status).toBe('waiting');
    expect(row?.attempts).toBe(0);
    expect(api.socialApi.createPostDraft).not.toHaveBeenCalled();
  });

  it('only processes for the same signed-in account', async () => {
    await queuePost(basePost('p1'), db);
    setPendingPostsAccount('someone-else');
    await processPendingPosts(db);
    expect(api.socialApi.createPostDraft).not.toHaveBeenCalled();
    setPendingPostsAccount(null);
    await processPendingPosts(db);
    expect(api.socialApi.createPostDraft).not.toHaveBeenCalled();
    await processPendingPosts(new LiftDb('guest'));
    expect(api.socialApi.createPostDraft).not.toHaveBeenCalled();
  });

  it('publishes draft → media → publish, and never sends sourceRecordId', async () => {
    await queuePost(basePost('p1'), db);
    await processPendingPosts(db);
    expect(await db.pendingPosts.get('p1')).toBeUndefined();
    expect(api.state.published.has('p1')).toBe(true);
    const draft = api.socialApi.createPostDraft.mock.calls[0][0] as unknown as NewPostInputLike;
    expect(allText(draft)).not.toContain('private-session-id-123');
    expect(draft.media.map((m) => [m.id, m.position])).toEqual([['m1', 0], ['m2', 1]]);
  });

  it('failure leaves status error with text, does not throw, and retry resumes without re-uploading', async () => {
    api.state.failUploadOnce.add('m2');
    await queuePost(basePost('p1'), db);
    await expect(processPendingPosts(db)).resolves.toBeUndefined();
    let row = await db.pendingPosts.get('p1');
    expect(row?.status).toBe('error');
    expect(row?.attempts).toBe(1);
    expect(row?.error).toMatch(/reach the server/);
    expect(row?.photos.map((p) => !!p.uploaded)).toEqual([true, false]);
    expect(api.socialApi.publishPost).not.toHaveBeenCalled();

    await retryPendingPost('p1', db);
    row = await db.pendingPosts.get('p1');
    expect(row).toBeUndefined();
    const uploads = api.socialApi.uploadPostMedia.mock.calls.map((c) => c[1]);
    expect(uploads).toEqual(['m1', 'm2', 'm2']); // m1 only once
    expect(api.state.published.has('p1')).toBe(true);
  });

  it('publish failure → error status; the workout record is untouched', async () => {
    await db.sessions.put(session);
    api.state.failPublish = true;
    await queuePost(basePost('p1', []), db);
    await processPendingPosts(db);
    expect((await db.pendingPosts.get('p1'))?.status).toBe('error');
    expect(await db.sessions.get(session.id)).toEqual(session);
  });

  it('is idempotent: same id queued twice and concurrent processing publish once', async () => {
    await queuePost(basePost('p1'), db);
    await queuePost(basePost('p1'), db);
    expect(await db.pendingPosts.count()).toBe(1);
    await Promise.all([processPendingPosts(db), processPendingPosts(db), processPendingPosts(db)]);
    expect(api.socialApi.createPostDraft).toHaveBeenCalledTimes(1);
    expect(api.socialApi.publishPost).toHaveBeenCalledTimes(1);
    // A re-publish with the same id (e.g. after a lost response) targets the same server post.
    await queuePost(basePost('p1'), db);
    await processPendingPosts(db);
    expect(new Set(api.socialApi.createPostDraft.mock.calls.map((c) => (c[0] as { id: string }).id))).toEqual(new Set(['p1']));
    expect(api.state.drafts.size).toBe(1);
  });

  it('on success links the post id to the local source record', async () => {
    await db.sessions.put(session);
    await queuePost(basePost('p1', []), db);
    await processPendingPosts(db);
    expect((await db.sessions.get(session.id))?.sharedPostIds).toEqual(['p1']);
  });

  it('cancel removes the pending post', async () => {
    await queuePost(basePost('p1'), db);
    await cancelPendingPost('p1', db);
    expect(await db.pendingPosts.count()).toBe(0);
  });

  it('friendlyError hides technical messages', () => {
    expect(friendlyError(new Error('duplicate key value violates unique constraint "x"'), 'Nope')).toBe('Nope');
    expect(friendlyError(new Error('That username is taken.'))).toBe('That username is taken.');
  });
});

/* ================================================================ auto share */
describe('autoShare', () => {
  const settingsWith = (enabled: boolean, fields: Partial<ShareFields> = {}): Settings => {
    const s = defaultSettings();
    s.social.autoShare = { enabled, audience: 'only_me', fields: { ...NONE, duration: true, ...fields } };
    return s;
  };

  it('does nothing unless opted in', async () => {
    setOnline(false);
    expect(await maybeAutoShare({ session }, { db, settings: settingsWith(false), byId })).toBe(false);
    expect(await db.pendingPosts.count()).toBe(0);
  });

  it('queues a photo-less snapshot with the stated audience and fields, once', async () => {
    setOnline(false);
    expect(await maybeAutoShare({ session }, { db, settings: settingsWith(true), byId })).toBe(true);
    expect(await maybeAutoShare({ session }, { db, settings: settingsWith(true), byId })).toBe(false);
    const rows = await db.pendingPosts.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].photos).toEqual([]);
    expect(rows[0].audience).toBe('only_me');
    expect(rows[0].snapshot?.durationSec).toBe(3000);
    expect(rows[0].snapshot?.exercises).toBeUndefined();
    expect(rows[0].sourceRecordId).toBe(session.id);
  });

  it('skips active sessions, guests and already-shared records', async () => {
    setOnline(false);
    const s = settingsWith(true);
    expect(await maybeAutoShare({ session: { ...session, status: 'active' } }, { db, settings: s, byId })).toBe(false);
    expect(await maybeAutoShare({ session: { ...session, sharedPostIds: ['x'] } }, { db, settings: s, byId })).toBe(false);
    const guest = new LiftDb('guest');
    expect(await maybeAutoShare({ session }, { db: guest, settings: s, byId })).toBe(false);
    guest.close();
    expect(await maybeAutoShare({ activity }, { db, settings: s, byId })).toBe(true);
  });
});
