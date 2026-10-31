#!/usr/bin/env node
/**
 * Hard Earned — authorization checks against a DEPLOYED Supabase project over HTTPS
 * (PostgREST tables + RPCs, Storage, Edge Functions). See tests/live/README.md for setup.
 *
 *   node tests/live/backend-live.mjs                 # read env, run everything that has credentials
 *   LC_LIVE_ONLY=social,coach node tests/live/backend-live.mjs
 *
 * Credentials come ONLY from environment variables ("email:password"); nothing is written to disk.
 * Every check prints PASS / FAIL / BLOCKED (missing credentials or an optional component not deployed).
 * Exit code 1 if any check FAILs. The script creates test data in the test accounts and cleans up what it can
 * (posts deleted, coaching ended); it never deletes accounts unless LC_LIVE_DELETE_ACCOUNT=1.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.LC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.LC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const ONLY = (process.env.LC_LIVE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROLES = {
  member: 'LC_MEMBER', // client: has private records, shares a post, requests coaching
  friend: 'LC_FRIEND', // accepted social friend of member
  stranger: 'LC_STRANGER', // unrelated account
  applicant: 'LC_APPLICANT', // applies as a coach during the run, gets approved by admin → the journey's coach
  coachB: 'LC_COACH_B', // second coach (multiple pending requests, former coach); approved by admin if needed
  admin: 'LC_ADMIN', // has app_roles.role = 'admin' (granted once in the SQL editor)
};

/* ------------------------------------------------------------------ tiny runner */
const results = [];
const want = (area) => ONLY.length === 0 || ONLY.includes(area);
async function check(area, label, fn) {
  if (!want(area)) return;
  try {
    const r = await fn();
    if (r && r.blocked) {
      results.push({ s: 'BLOCKED', area, label, why: r.blocked });
    } else results.push({ s: 'PASS', area, label });
  } catch (e) {
    results.push({ s: 'FAIL', area, label, why: e?.message ?? String(e) });
  }
}
const blocked = (why) => ({ blocked: why });
function assert(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function okRpc(c, fn, args, what = fn) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}
async function failRpc(c, fn, args, pattern, what = fn) {
  const { error } = await c.rpc(fn, args);
  if (!error) throw new Error(`${what}: expected an error, it succeeded`);
  if (pattern && !pattern.test(`${error.message} ${error.hint ?? ''} ${error.code ?? ''}`)) throw new Error(`${what}: wrong error "${error.message}"`);
}
async function rows(c, table, filter) {
  let q = c.from(table).select('*');
  for (const [k, v] of Object.entries(filter ?? {})) q = q.eq(k, v);
  const { data, error } = await q.limit(50);
  return error ? -1 : data.length; // -1 = permission error (also a denial)
}
const denied = async (c, table, filter, what) => { const n = await rows(c, table, filter); assert(n <= 0, `${what}: ${n} rows visible`); };

/* ------------------------------------------------------------------ clients */
const TIMEOUT = Number(process.env.LC_LIVE_TIMEOUT_MS || 20000);
const tfetch = (u, o = {}) => fetch(u, { ...o, signal: o.signal ?? AbortSignal.timeout(TIMEOUT) });
const mk = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: tfetch } });
const S = {}; // role → { c, id }
async function signIn(role) {
  const v = process.env[ROLES[role]];
  if (!v || !v.includes(':')) return null;
  const i = v.indexOf(':');
  const c = mk();
  const { data, error } = await c.auth.signInWithPassword({ email: v.slice(0, i), password: v.slice(i + 1) });
  if (error) throw new Error(`${role}: sign-in failed: ${error.message}`);
  return { c, id: data.user.id, token: data.session.access_token };
}
const need = (...roles) => {
  const miss = roles.filter((r) => !S[r]);
  return miss.length ? blocked(`missing credentials: ${miss.map((r) => ROLES[r]).join(', ')}`) : null;
};

let sharp = null;
async function jpeg(w, h, color = '#4fbf7f') {
  if (!sharp) sharp = (await import('sharp')).default;
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

/* ================================================================== main */
async function main() {
  if (!URL_ || !KEY) {
    results.push({ s: 'BLOCKED', area: 'setup', label: 'project URL + publishable key', why: 'set LC_SUPABASE_URL and LC_SUPABASE_ANON_KEY (or VITE_*)' });
    return;
  }
  for (const role of Object.keys(ROLES)) {
    try { S[role] = await signIn(role); } catch (e) { results.push({ s: 'FAIL', area: 'setup', label: `sign in ${role}`, why: e.message }); }
  }
  const anon = mk();
  const today = new Date().toISOString().slice(0, 10);
  const ts = Date.now();
  const tag = randomUUID().slice(0, 6);

  await check('setup', 'every signed-in account has a social profile (needed for notifications)', async () => {
    const b = need('member'); if (b) return b;
    for (const [role, s] of Object.entries(S)) {
      if (!s) continue;
      const me = await okRpc(s.c, 'get_my_profile', {});
      if (!me) await okRpc(s.c, 'save_my_profile', { p_username: `lc_${role.toLowerCase()}_${s.id.slice(0, 6)}`, p_display_name: `Live ${role}` });
    }
  });

  /* ------------------------------------------------------------ anon + grants */
  await check('anon', 'signed-out: no private tables, no RPCs, no feed, no coach search, no export', async () => {
    for (const t of ['workout_sessions', 'measurements', 'food_logs', 'account_state', 'profiles', 'posts', 'coach_profiles', 'coach_messages', 'ai_messages', 'app_roles']) {
      await denied(anon, t, null, `anon ${t}`);
    }
    for (const [fn, args] of [['get_feed', {}], ['search_coaches', { p: {} }], ['export_my_data', {}], ['sync_pull', { p_since: 0 }], ['my_roles', {}]]) {
      await failRpc(anon, fn, args, null, `anon ${fn}`);
    }
    const { data } = await anon.from('ref_exercises').select('id').limit(1);
    assert(data?.length === 1, 'reference catalog is public (expected)');
  });
  await check('anon', 'Edge Functions refuse calls without a user JWT', async () => {
    for (const f of ['finalize-post', 'delete-account', 'finalize-coach-media', 'geocode', 'ai-coach']) {
      const r = await tfetch(`${URL_}/functions/v1/${f}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}' });
      assert(r.status === 401 || r.status === 403, `${f}: HTTP ${r.status}`);
    }
    const r = await tfetch(`${URL_}/functions/v1/cleanup-media`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    assert(r.status === 401 || r.status === 403, `cleanup-media with the publishable key: HTTP ${r.status}`);
  });

  /* ------------------------------------------------------------ private records */
  const W = randomUUID();
  const MS = randomUUID();
  const session = (id, name) => ({ id, name, status: 'completed', date: today, timeZone: 'UTC', startedAt: ts - 3600e3, endedAt: ts, pausedTotalMs: 0, createdAt: ts, updatedAt: ts,
    exercises: [{ id: 'e1', exerciseId: 'barbell-back-squat', order: 0, sets: [{ id: 's1', type: 'normal', weightKg: 100, reps: 5, completed: true, completedAt: ts }] }] });
  await check('private', 'member’s workouts / measurements / food logs / account state are invisible to friend, stranger, admin, coach (no relationship), anon', async () => {
    const b = need('member', 'friend', 'stranger'); if (b) return b;
    const m = S.member.c;
    eq((await okRpc(m, 'sync_push', { p_entity: 'sessions', p_id: W, p_op: 'upsert', p_base_version: null, p_payload: session(W, `Live ${tag}`) })).status, 'ok', 'push session');
    eq((await okRpc(m, 'sync_push', { p_entity: 'measurements', p_id: MS, p_op: 'upsert', p_base_version: null, p_payload: { id: MS, kind: 'bodyweight', date: today, value: 80 } })).status, 'ok', 'push measurement');
    assert((await rows(m, 'workout_sessions', { id: W })) === 1, 'owner reads own');
    for (const r of ['friend', 'stranger', 'admin', 'applicant', 'coachB']) {
      if (!S[r]) continue;
      for (const t of ['workout_sessions', 'session_sets', 'measurements', 'food_logs', 'account_state', 'programs']) await denied(S[r].c, t, { owner_id: S.member.id }, `${r} ${t}`);
    }
    const { data } = await S.member.c.from('posts').select('id').eq('author_id', S.member.id).ilike('caption', `%${tag}%`);
    eq(data?.length ?? 0, 0, 'syncing a finished workout never creates a post');
  });

  /* ------------------------------------------------------------ social journey */
  const P = randomUUID();
  const MD = randomUUID();
  const img = () => `${S.member.id}/${P}/${MD}.jpg`;
  const thumb = () => `${S.member.id}/${P}/${MD}_thumb.jpg`;
  await check('social', 'member and friend are friends (request is idempotent; stranger cannot accept)', async () => {
    const b = need('member', 'friend', 'stranger'); if (b) return b;
    const r = await okRpc(S.member.c, 'send_friend_request', { p_target: S.friend.id });
    if (r.status !== 'accepted') {
      await failRpc(S.stranger.c, 'respond_friend_request', { p_request_id: r.id, p_accept: true }, null, 'stranger accepts');
      await okRpc(S.friend.c, 'respond_friend_request', { p_request_id: r.id, p_accept: true });
    }
    eq((await okRpc(S.member.c, 'send_friend_request', { p_target: S.friend.id })).status, 'accepted', 'idempotent');
  });
  await check('social', 'share a finished workout (Friends) with a photo: path rules, finalize-post, idempotent retries', async () => {
    const b = need('member', 'friend'); if (b) return b;
    const m = S.member.c;
    const args = { p_id: P, p_kind: 'workout', p_audience: 'friends', p_caption: `Live share ${tag}`,
      p_snapshot: { title: 'Lower A', kind: 'workout', date: today, durationSec: 3600 }, p_media: [{ id: MD, position: 0, width: 800, height: 600, description: 'test' }] };
    await okRpc(m, 'create_post_draft', args);
    await okRpc(m, 'create_post_draft', args); // retry
    const image = await jpeg(800, 600);
    const th = await jpeg(240, 180);
    const bad = await m.storage.from('post-media').upload(`${S.member.id}/${P}/${randomUUID()}.jpg`, th, { contentType: 'image/jpeg', upsert: true });
    assert(bad.error, 'upload at an undeclared media id must be refused');
    const other = await S.friend.c.storage.from('post-media').upload(img(), th, { contentType: 'image/jpeg', upsert: true });
    assert(other.error, 'friend cannot upload into the member’s folder');
    for (const [p, body] of [[thumb(), th], [img(), image]]) {
      const { error } = await m.storage.from('post-media').upload(p, body, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error(`upload ${p}: ${error.message}`);
    }
    const f1 = await m.functions.invoke('finalize-post', { body: { postId: P } });
    if (f1.error) throw new Error(`finalize-post: ${f1.error.message}`);
    const f2 = await m.functions.invoke('finalize-post', { body: { postId: P } });
    if (f2.error) throw new Error(`finalize-post retry: ${f2.error.message}`);
    eq((await okRpc(m, 'create_post_draft', args)).status, 'published', 'draft retry after publish is a no-op');
    const { data } = await m.from('posts').select('id').eq('id', P);
    eq(data.length, 1, 'one post');
  });
  await check('social', 'friend: feed card + signed media; stranger + anon: nothing; like/comment retries do not duplicate', async () => {
    const b = need('member', 'friend', 'stranger'); if (b) return b;
    const feed = await okRpc(S.friend.c, 'get_feed', { p_limit: 20 });
    const card = feed.items.find((x) => x.id === P);
    assert(card && card.snapshot?.title === 'Lower A' && card.media?.[0]?.image_path === img(), 'feed card');
    const s1 = await S.friend.c.storage.from('post-media').createSignedUrl(thumb(), 60);
    assert(!s1.error && s1.data?.signedUrl, 'friend signs thumb');
    const got = await tfetch(s1.data.signedUrl);
    assert(got.ok, `signed URL fetch HTTP ${got.status}`);
    const s2 = await S.stranger.c.storage.from('post-media').createSignedUrl(img(), 60);
    assert(s2.error || !s2.data?.signedUrl, 'stranger must not sign');
    eq(await okRpc(S.stranger.c, 'get_post', { p_post_id: P }), null, 'stranger get_post');
    const cid = randomUUID();
    for (let i = 0; i < 2; i++) {
      await okRpc(S.friend.c, 'like_post', { p_post_id: P });
      await okRpc(S.friend.c, 'add_comment', { p_post_id: P, p_id: cid, p_body: 'Nice!' });
    }
    const post = await okRpc(S.friend.c, 'get_post', { p_post_id: P });
    eq([post.like_count, post.comment_count], [1, 1], 'counts after retries');
    const n = (await okRpc(S.member.c, 'list_notifications', { p_limit: 50 })).filter((x) => x.post_id === P);
    eq([n.filter((x) => x.type === 'like').length, n.filter((x) => x.type === 'comment').length], [1, 1], 'one notification each');
    await failRpc(S.stranger.c, 'add_comment', { p_post_id: P, p_id: randomUUID(), p_body: 'x' }, /not found/i, 'stranger comment');
  });
  await check('social', 'Friends → Only me: friend loses post, comments (even own), media rows and new signed URLs at once', async () => {
    const b = need('member', 'friend'); if (b) return b;
    const before = await S.friend.c.storage.from('post-media').createSignedUrl(img(), 60);
    await okRpc(S.member.c, 'update_post', { p_post_id: P, p_audience: 'only_me' });
    eq(await okRpc(S.friend.c, 'get_post', { p_post_id: P }), null, 'get_post');
    eq(await okRpc(S.friend.c, 'list_comments', { p_post_id: P }), [], 'comments');
    eq(await rows(S.friend.c, 'post_media', { post_id: P }), 0, 'media rows');
    const after = await S.friend.c.storage.from('post-media').createSignedUrl(img(), 60);
    assert(after.error || !after.data?.signedUrl, 'no new signed URL');
    if (before.data?.signedUrl) {
      const r = await tfetch(before.data.signedUrl);
      console.log(`  info: a URL signed before the change still returns HTTP ${r.status} until it expires (documented limit, ≤ 300 s in the app)`);
    }
    await okRpc(S.member.c, 'update_post', { p_post_id: P, p_audience: 'friends' });
  });

  /* ------------------------------------------------------------ coach application + directory */
  const Q1 = randomUUID();
  const coachProfile = (name) => ({ displayName: name, bio: 'Live-test strength coach helping busy people train consistently and get stronger.',
    experience: '5 years', experienceYears: 5, specialties: ['strength'], goals: ['build_strength'], languages: ['en'], city: 'Reykjavík', region: null,
    country: 'IS', formats: ['online', 'in_person'], acceptingClients: true, listed: true,
    serviceAreas: [{ kind: 'city', city: 'Reykjavík', country: 'IS' }], qualifications: [] });
  await check('coach', 'application: applicant submits; restricted document readable only by applicant + admin; not in the directory yet', async () => {
    const b = need('applicant', 'stranger'); if (b) return b;
    const a = S.applicant.c;
    const cur = await okRpc(a, 'get_my_coach_profile', {});
    if (cur?.status === 'approved') return; // re-run: already approved
    const doc = `${S.applicant.id}/${Q1}/certificate.pdf`;
    const up = await a.storage.from('coach-docs').upload(doc, new Blob(['%PDF-1.4 live test'], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(`doc upload: ${up.error.message}`);
    await okRpc(a, 'save_my_coach_profile', { p: { ...coachProfile('Live Coach'), qualifications: [{ id: Q1, title: 'Level 1', issuer: 'Test', year: 2024, documentPath: doc, documentName: 'certificate.pdf' }] } });
    const st = await okRpc(a, 'submit_coach_application', {});
    assert(['submitted', 'approved'].includes(st.status), `status ${st.status}`);
    const s = await S.stranger.c.storage.from('coach-docs').createSignedUrl(doc, 60);
    assert(s.error || !s.data?.signedUrl, 'stranger must not sign the document');
    if (S.member) { const m = await S.member.c.storage.from('coach-docs').createSignedUrl(doc, 60); assert(m.error || !m.data?.signedUrl, 'member must not sign the document'); }
    if (S.admin) { const d = await S.admin.c.storage.from('coach-docs').createSignedUrl(doc, 60); assert(!d.error && d.data?.signedUrl, 'admin signs the document'); }
    const items = (await okRpc(S.stranger.c, 'search_coaches', { p: {} })).items;
    assert(!items.some((c) => c.user_id === S.applicant.id), 'not listed before approval');
    await failRpc(S.applicant.c, 'admin_review_coach', { p_coach: S.applicant.id, p_action: 'approve' }, /admins/i, 'self-approval');
  });
  await check('coach', 'admin approves (admin RPC; admin role granted once in the SQL editor); coach B approved too', async () => {
    const b = need('applicant'); if (b) return b;
    for (const r of ['applicant', 'coachB']) {
      if (!S[r]) continue;
      let p = await okRpc(S[r].c, 'get_my_coach_profile', {});
      if (p?.status === 'approved') continue;
      if (r === 'coachB') { await okRpc(S[r].c, 'save_my_coach_profile', { p: coachProfile('Live Coach B') }); await okRpc(S[r].c, 'submit_coach_application', {}); }
      if (!S.admin) return blocked(`approve ${r} in the SQL editor (README step 4) or provide LC_ADMIN`);
      await okRpc(S.admin.c, 'admin_review_coach', { p_coach: S[r].id, p_action: 'approve' });
      p = await okRpc(S[r].c, 'get_my_coach_profile', {});
      eq(p.status, 'approved', `${r} approved`);
    }
    eq((await okRpc(S.admin?.c ?? S.applicant.c, 'my_roles', {})).admin, !!S.admin, 'admin role visible via my_roles only');
    if (S.admin) await denied(S.admin.c, 'workout_sessions', { owner_id: S.member?.id ?? S.admin.id }, 'admin reads health records');
  });
  await check('coach', 'directory: town search (geolocation denied → text only, no invented distance) and remote listing; no private columns', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    const r = await okRpc(S.member.c, 'search_coaches', { p: { city: 'reykjavik', country: 'IS' } });
    const me = r.items.find((c) => c.user_id === S.applicant.id);
    assert(me && me.match === 'local' && me.distance_km === null, `local match without distance (${JSON.stringify(me)})`);
    const online = await okRpc(S.member.c, 'search_coaches', { p: { format: 'online' } });
    assert(online.items.some((c) => c.user_id === S.applicant.id && c.match === 'remote'), 'remote listing');
    const keys = new Set(r.items.flatMap((c) => Object.keys(c)));
    for (const k of ['suspended', 'suspended_reason', 'latest_feedback', 'document_path', 'qualifications']) assert(!keys.has(k), `card leaks ${k}`);
    const d = await okRpc(S.member.c, 'get_coach', { p_coach: S.applicant.id });
    assert(d && !JSON.stringify(d).includes('certificate.pdf'), 'detail has no document path');
  });

  /* ------------------------------------------------------------ coaching journey */
  const REL = randomUUID();
  const RELB = randomUUID();
  const PR = randomUUID();
  let progV;
  const program = (cur, managed) => ({ id: PR, name: `Live plan ${tag}`, source: 'manual', startDate: today, active: true, currentVersion: cur,
    managedBy: managed ? { kind: managed } : undefined, rotationIndex: 0, overrides: [], createdAt: ts, updatedAt: ts + cur,
    versions: Array.from({ length: cur }, (_, i) => ({ version: i + 1, createdAt: ts, reason: `v${i + 1}`, weeks: 8, reviewWeek: 4, rationale: [], warnings: [],
      templates: [{ id: 't1', name: 'Full body', focus: 'Full', kind: 'strength', estimatedMinutes: 60,
        exercises: [{ id: 'x1', exerciseId: 'barbell-back-squat', sets: 3, repMin: 5, repMax: 8, targetRir: 2, restSec: 180, warmup: '', priority: 1, alternatives: [] }] }],
      schedule: [{ weekday: 1, templateId: 't1' }] })) });
  const coach = () => S.applicant.c;
  await check('coaching', 'request with category consent (training + check-ins, not measurements): idempotent; pending coach sees intake only', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    const rels = await okRpc(S.member.c, 'my_coaching_relationships', {});
    for (const r of rels.filter((x) => x.status === 'active' || x.status === 'requested')) {
      if (r.status === 'active') await okRpc(S.member.c, 'end_coaching', { p_id: r.id, p_reason: 'live test reset' });
      else await okRpc(S.member.c, 'cancel_coaching_request', { p_id: r.id });
    }
    const args = { p_id: REL, p_coach: S.applicant.id, p_intake: { goal: 'strength', daysPerWeek: 3 }, p_message: 'Live test request', p_scopes: { training: true, measurements: false, nutrition: false, checkins: true } };
    await okRpc(S.member.c, 'request_coaching', args);
    eq((await okRpc(S.member.c, 'request_coaching', args)).id, REL, 'idempotent');
    if (S.coachB) await okRpc(S.member.c, 'request_coaching', { ...args, p_id: RELB, p_coach: S.coachB.id });
    const o = await okRpc(coach(), 'coach_client_overview', { p_id: REL });
    eq([o.relationship.status, o.training, o.measurements], ['requested', null, null], 'pending: no panels');
    await denied(coach(), 'workout_sessions', { owner_id: S.member.id }, 'pending coach reads workouts');
    await failRpc(coach(), 'list_coach_messages', { p_relationship: REL }, null, 'pending chat');
  });
  await check('coaching', 'acceptance: coach reads exactly the consented categories; the other pending request is cancelled and can no longer be accepted', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    eq((await okRpc(coach(), 'respond_coaching_request', { p_id: REL, p_accept: true, p_message: 'Welcome' })).status, 'active', 'accepted');
    assert((await rows(coach(), 'workout_sessions', { owner_id: S.member.id })) > 0, 'coach reads workouts');
    await denied(coach(), 'measurements', { owner_id: S.member.id }, 'coach reads measurements without consent');
    await denied(coach(), 'account_state', { owner_id: S.member.id }, 'coach reads account_state');
    if (S.friend) await denied(S.friend.c, 'workout_sessions', { owner_id: S.member.id }, 'friend');
    if (!S.coachB) return blocked('LC_COACH_B not set: multiple-pending-request check skipped');
    await failRpc(S.coachB.c, 'respond_coaching_request', { p_id: RELB, p_accept: true }, /no longer pending/, 'old request accepted after another coach');
    const rels = await okRpc(S.member.c, 'my_coaching_relationships', {});
    eq([rels.find((r) => r.id === REL)?.status, rels.find((r) => r.id === RELB)?.status], ['active', 'cancelled'], 'states');
  });
  await check('coaching', 'private messages: idempotent send, notifications without text, photo via finalize-coach-media', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    const id = randomUUID();
    const m1 = await okRpc(S.member.c, 'send_coach_message', { p_id: id, p_relationship: REL, p_body: `secret text ${tag}` });
    const m2 = await okRpc(S.member.c, 'send_coach_message', { p_id: id, p_relationship: REL, p_body: `secret text ${tag}` });
    eq([m2.id, m2.seq], [m1.id, m1.seq], 'retry returns the stored row');
    await okRpc(coach(), 'send_coach_message', { p_id: randomUUID(), p_relationship: REL, p_body: 'Coach reply' });
    const n = await okRpc(coach(), 'list_notifications', { p_limit: 50 });
    assert(!JSON.stringify(n).includes(`secret text ${tag}`), 'no message text in notifications');
    for (const r of ['friend', 'stranger', 'admin', 'coachB']) if (S[r]) await failRpc(S[r].c, 'list_coach_messages', { p_relationship: REL }, null, `${r} reads chat`);
    const mid = randomUUID();
    const media = randomUUID();
    await okRpc(S.member.c, 'send_coach_message', { p_id: mid, p_relationship: REL, p_body: '', p_media: [{ id: media }] });
    const base = `${REL}/${mid}/${media}`;
    for (const [p, w] of [[`${base}_thumb.jpg`, 200], [`${base}.jpg`, 800]]) {
      const { error } = await S.member.c.storage.from('coach-media').upload(p, await jpeg(w, w), { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error(`upload: ${error.message}`);
    }
    const f = await S.member.c.functions.invoke('finalize-coach-media', { body: { messageId: mid } });
    if (f.error) throw new Error(`finalize-coach-media: ${f.error.message}`);
    const s = await coach().storage.from('coach-media').createSignedUrl(`${base}.jpg`, 60);
    assert(!s.error && s.data?.signedUrl, 'coach signs the chat photo');
    if (S.stranger) { const x = await S.stranger.c.storage.from('coach-media').createSignedUrl(`${base}.jpg`, 60); assert(x.error || !x.data?.signedUrl, 'stranger must not sign'); }
  });
  await check('coaching', 'program proposal → client acceptance (new version, stale-safe) → workout completion → coach sees authorized progress', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    progV = (await okRpc(S.member.c, 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: null, p_payload: program(1) })).version;
    const pid = randomUUID();
    const proposed = { ...program(1).versions[0], name: `Coach plan ${tag}` };
    await okRpc(coach(), 'save_program_proposal', { p: { id: pid, relationshipId: REL, baseProgramId: PR, baseVersion: 1, program: proposed, changeSummary: ['Live test'] } });
    eq(await okRpc(S.member.c, 'get_program_proposal', { p_id: pid }), null, 'draft invisible to the client');
    await okRpc(coach(), 'send_program_proposal', { p_id: pid });
    await failRpc(coach(), 'respond_program_proposal', { p_id: pid, p_accept: true, p_program_id: PR, p_version: 2 }, null, 'coach cannot accept');
    eq((await okRpc(S.member.c, 'respond_program_proposal', { p_id: pid, p_accept: true, p_program_id: PR, p_version: 2 })).status, 'accepted', 'accepted');
    progV = (await okRpc(S.member.c, 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: progV, p_payload: program(2, 'coach') })).version;
    const W2 = randomUUID();
    await okRpc(S.member.c, 'sync_push', { p_entity: 'sessions', p_id: W2, p_op: 'upsert', p_base_version: null, p_payload: session(W2, `Coach plan session ${tag}`) });
    const o = await okRpc(coach(), 'coach_client_overview', { p_id: REL });
    assert(o.training?.active_program?.id === PR && o.training.active_program.current_version === 2 && o.training.active_program.managed_by === 'coach', 'coach sees the accepted plan');
    assert(o.training.recent_sessions.some((s) => s.id === W2), 'coach sees the completed workout');
    eq(o.measurements, null, 'measurements panel stays null without consent');
    const stale = randomUUID();
    await okRpc(coach(), 'save_program_proposal', { p: { id: stale, relationshipId: REL, baseProgramId: PR, baseVersion: 1, program: proposed } });
    await okRpc(coach(), 'send_program_proposal', { p_id: stale });
    await failRpc(S.member.c, 'respond_program_proposal', { p_id: stale, p_accept: true, p_program_id: PR, p_version: 3 }, /stale/, 'stale proposal');
  });
  await check('coaching', 'revocation with the coach’s session still open: scope off → next query denied; end → read-only history, queued writes refused', async () => {
    const b = need('member', 'applicant'); if (b) return b;
    await okRpc(S.member.c, 'set_coaching_scopes', { p_id: REL, p_scopes: { training: false, checkins: true } });
    await denied(coach(), 'workout_sessions', { owner_id: S.member.id }, 'after revoking training');
    eq((await okRpc(coach(), 'coach_client_overview', { p_id: REL })).training, null, 'training panel');
    await okRpc(S.member.c, 'end_coaching', { p_id: REL, p_reason: 'live test done' });
    await failRpc(coach(), 'send_coach_message', { p_id: randomUUID(), p_relationship: REL, p_body: 'queued' }, /read-only/, 'queued message');
    await failRpc(coach(), 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL, program: { ...program(1).versions[0], name: 'x' } } }, null, 'new proposal');
    assert((await okRpc(coach(), 'list_coach_messages', { p_relationship: REL })).length >= 2, 'coach keeps read-only history');
  });
  await check('export', 'export_my_data contains own coaching (client + coach side) and AI sections (needs migration 20261030000003)', async () => {
    const b = need('member'); if (b) return b;
    const e = await okRpc(S.member.c, 'export_my_data', {});
    if (!e.coaching) return blocked('deployed export_my_data has no coaching/ai sections: apply 20261030000003_authz_fixes.sql');
    assert(e.coaching.relationships_as_client.some((r) => r.id === REL), 'relationship as client');
    assert(e.coaching.messages_sent.some((m) => m.body === `secret text ${tag}`), 'own message');
    assert(!JSON.stringify(e.coaching.messages_sent).includes('Coach reply'), 'not the coach’s messages');
    assert('settings' in e.ai && Array.isArray(e.ai.messages), 'ai section');
    if (S.applicant) {
      const c = await okRpc(S.applicant.c, 'export_my_data', {});
      const r = c.coaching.relationships_as_coach.find((x) => x.id === REL);
      assert(r && !('intake' in r), 'coach export: relationship without client intake');
      eq(c.workout_sessions.filter((w) => w.id === W).length, 0, 'coach export has no client workouts');
    }
  });

  /* ------------------------------------------------------------ AI (optional, costs tokens) */
  await check('ai', 'ai-coach status reachable with a user JWT; secrets never returned', async () => {
    const b = need('member'); if (b) return b;
    const r = await S.member.c.functions.invoke('ai-coach', { body: { action: 'status' } });
    if (r.error) return blocked(`ai-coach not deployed/configured: ${r.error.message}`);
    const txt = JSON.stringify(r.data);
    assert(!/sk-|sb_secret|service_role/.test(txt), 'status leaks a secret');
    console.log(`  info: ai-coach status ${txt.slice(0, 200)}`);
  });
  await check('ai', 'live AI journey incl. the two-session case (LC_LIVE_AI=1; judge the reply text manually)', async () => {
    if (process.env.LC_LIVE_AI !== '1') return blocked('set LC_LIVE_AI=1 (consented member, provider key configured)');
    const b = need('member'); if (b) return b;
    const id = randomUUID();
    const r = await S.member.c.functions.invoke('ai-coach', { body: { action: 'send', id, text: 'I can only train twice this week', mode: 'chat' } });
    if (r.error) throw new Error(`send: ${r.error.message}`);
    const again = await S.member.c.functions.invoke('ai-coach', { body: { action: 'send', id, text: 'I can only train twice this week', mode: 'chat' } });
    eq(again.data?.reply?.id, r.data?.reply?.id, 'idempotent resend (no second charge)');
    console.log(`  info: reply → ${String(r.data?.reply?.content ?? '').slice(0, 600)}`);
  });

  /* ------------------------------------------------------------ cleanup */
  await check('cleanup', 'delete the test post (media stops being signable)', async () => {
    const b = need('member'); if (b) return b;
    await okRpc(S.member.c, 'delete_post', { p_post_id: P });
    if (S.friend) { const s = await S.friend.c.storage.from('post-media').createSignedUrl(img(), 60); assert(s.error || !s.data?.signedUrl, 'signable after delete'); }
  });
  if (process.env.LC_LIVE_DELETE_ACCOUNT === '1') {
    await check('cleanup', 'delete-account removes the stranger account (auth user, rows, storage folders)', async () => {
      const b = need('stranger'); if (b) return b;
      const r = await S.stranger.c.functions.invoke('delete-account', { body: {} });
      if (r.error) throw new Error(r.error.message);
      const again = await S.stranger.c.rpc('sync_pull', { p_since: 0 });
      assert(again.error || again.data.changes.length === 0, 'old JWT sees no data');
    });
  }
}

try {
  await main();
} catch (e) {
  results.push({ s: 'FAIL', area: 'harness', label: 'unexpected error', why: e.stack || e.message });
}
for (const r of results) console.log(`${r.s.padEnd(7)} ${r.area.padEnd(9)} ${r.label}${r.why ? `\n          → ${r.why}` : ''}`);
const n = (s) => results.filter((r) => r.s === s).length;
console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('BLOCKED')} blocked`);
process.exit(n('FAIL') ? 1 : 0);
