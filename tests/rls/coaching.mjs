/**
 * Coaching access-control checks for `npm run test:rls` (called from run.mjs after the social suite).
 *
 * Covers brief §10 items 1–8 at the database level (RLS + definer RPCs + storage policies), with the actors
 * client, coach (approved), second coach, pending applicant, rejected applicant, suspended coach, social friend
 * of the client (friends, not coach), unrelated user, admin and anon. Nothing here depends on …03_ai_coach.sql.
 */
import { randomUUID } from 'node:crypto';

export async function coachingTests(h) {
  const { test, rpc, as, admin, ok, fails, eq, assert, count, adminCount, results } = h;

  /* ------------------------------------------------------------------ actors */
  const A = {
    client: randomUUID(), // Cl — has data, coached by `coach`
    coach: randomUUID(), // approved, listed, in-person + online (Reykjavík, with coordinates)
    coach2: randomUUID(), // approved, online only
    coach3: randomUUID(), // approved, in-person only (Akureyri, no coordinates)
    pending: randomUUID(), // submitted, never reviewed
    rejected: randomUUID(), // rejected applicant
    susp: randomUUID(), // approved, later suspended
    friend: randomUUID(), // social friend of client, NOT a coach
    stranger: randomUUID(), // unrelated user
    cadmin: randomUUID(), // app admin
    client2: randomUUID(), // client of the suspended coach
    client3: randomUUID(), // ends coaching with coach2; later deletes account
    client4: randomUUID(), // blocks coach
    unlisted: randomUUID(), // approved but unlisted
  };
  const NAMES = Object.fromEntries(Object.entries(A).map(([k, v]) => [v, k]));
  for (const [name, id] of Object.entries(A)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `co_${name}@example.test`]);
  }
  await admin.query(`insert into public.app_roles (user_id, role) values ($1, 'admin')`, [A.cadmin]);
  const R = (actor, fn, args) => rpc(actor === 'anon' ? 'anon' : A[actor] ?? actor, fn, args);
  const Q = (actor, sql, params) => as(actor === 'anon' ? 'anon' : A[actor] ?? actor, sql, params);
  const C = (actor, sql, params) => count(actor === 'anon' ? 'anon' : A[actor] ?? actor, sql, params);

  await test('coaching', 'every coaching actor creates a social profile (needed for in-app notifications)', async () => {
    for (const name of Object.keys(A)) {
      ok(await R(name, 'save_my_profile', { p_username: `co_${name}`, p_display_name: `Co ${name}` }), name);
    }
  });

  const ts = Date.now();
  const bio = 'Strength coach with ten years of experience helping busy people get stronger.';
  const profile = (over = {}) => ({
    displayName: 'Coach', bio, experience: '10 years', experienceYears: 10, specialties: ['strength'], goals: ['build_strength'],
    languages: ['en', 'is'], city: 'Reykjavík', region: 'Höfuðborgarsvæðið', country: 'IS', formats: ['in_person', 'online'],
    acceptingClients: true, listed: true,
    serviceAreas: [{ kind: 'city', city: 'Reykjavík', country: 'IS', lat: 64.14661, lng: -21.94264, radiusKm: 20, label: 'Reykjavík, Iceland' }],
    qualifications: [], ...over,
  });
  let matrixRel; // the client's current relationship with `coach` (set by the switching test)
  const ALL = ['client', 'coach', 'coach2', 'pending', 'rejected', 'susp', 'friend', 'stranger', 'cadmin', 'anon'];

  /* ================================================== §1 applications */
  await test('coach §1', 'submit is validated (bio ≥ 40 chars, specialty, language, country, format, service area)', async () => {
    ok(await R('pending', 'save_my_coach_profile', { p: profile({ displayName: 'Pending P', bio: 'too short', specialties: [], serviceAreas: [] }) }), 'save draft');
    const r = await R('pending', 'submit_coach_application');
    fails(r, 'invalid submit', /bio of at least 40.*specialty.*service area/);
    const p = ok(await R('pending', 'get_my_coach_profile'), 'get');
    eq(p.status, 'draft', 'still draft');
  });
  await test('coach §1', 'applicant submits; event logged; re-submitting while submitted is a no-op', async () => {
    ok(await R('pending', 'save_my_coach_profile', { p: profile({ displayName: 'Pending P' }) }), 'save');
    eq(ok(await R('pending', 'submit_coach_application'), 'submit').status, 'submitted', 'status');
    eq(ok(await R('pending', 'submit_coach_application'), 'again').status, 'submitted', 'idempotent');
    const ev = ok(await R('pending', 'my_coach_review_events'), 'events');
    eq(ev.map((e) => e.action), ['submitted'], 'one submitted event');
    assert(ok(await R('cadmin', 'list_notifications'), 'admin n').some((n) => n.type === 'coach_application' && n.coach_id === A.pending), 'admin notified of new application');
  });
  await test('coach §1', 'applicants cannot change approval/suspension fields (direct write, extra JSON keys, admin RPC)', async () => {
    fails(await Q('pending', `update public.coach_profiles set status = 'approved' where user_id = $1`, [A.pending]), 'direct update');
    fails(await Q('pending', `insert into public.coach_review_events (coach_id, action) values ($1, 'approve')`, [A.pending]), 'forge event');
    ok(await R('pending', 'save_my_coach_profile', { p: { ...profile({ displayName: 'Pending P' }), status: 'approved', suspended: false, latestFeedback: 'ok', approvedAt: 'now' } }), 'save with extra keys');
    eq(ok(await R('pending', 'get_my_coach_profile'), 'get').status, 'submitted', 'unchanged');
    fails(await R('pending', 'admin_review_coach', { p_coach: A.pending, p_action: 'approve' }), 'self-approve', /Only admins/);
    fails(await R('pending', 'admin_list_coach_applications'), 'list', /Only admins/);
    fails(await Q('pending', `insert into public.app_roles (user_id, role) values ($1, 'admin')`, [A.pending]), 'self-grant admin');
    eq(ok(await R('pending', 'my_roles'), 'roles'), { admin: false, moderator: false }, 'roles');
    eq(ok(await R('cadmin', 'my_roles'), 'roles'), { admin: true, moderator: false }, 'admin roles');
  });
  await test('coach §1', 'reject needs a reason; rejected applicant edits and resubmits (logged, notified each time)', async () => {
    ok(await R('rejected', 'save_my_coach_profile', { p: profile({ displayName: 'Rejected R' }) }), 'save');
    ok(await R('rejected', 'submit_coach_application'), 'submit');
    fails(await R('cadmin', 'admin_review_coach', { p_coach: A.rejected, p_action: 'reject' }), 'no reason', /reason/);
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.rejected, p_action: 'reject', p_reason: 'Not enough detail' }), 'reject');
    const p = ok(await R('rejected', 'get_my_coach_profile'), 'get');
    eq([p.status, p.latest_feedback], ['rejected', 'Not enough detail'], 'state');
    ok(await R('rejected', 'save_my_coach_profile', { p: profile({ displayName: 'Rejected R', bio: `${bio} Updated.` }) }), 'edit');
    eq(ok(await R('rejected', 'submit_coach_application'), 'resubmit').status, 'submitted', 'resubmitted');
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.rejected, p_action: 'reject', p_reason: 'Still not enough' }), 'reject again');
    const app = ok(await R('cadmin', 'admin_get_coach_application', { p_coach: A.rejected }), 'admin get');
    eq(app.events.map((e) => e.action).reverse(), ['submitted', 'reject', 'resubmitted', 'reject'], 'event log');
    const rej = app.events.find((e) => e.action === 'reject');
    assert(rej.actor_id === A.cadmin && rej.reason && rej.created_at && rej.from_status && rej.to_status === 'rejected', 'who/when/why recorded');
    const n = ok(await R('rejected', 'list_notifications'), 'n').filter((x) => x.type === 'coach_application');
    eq(n.length, 2, 'applicant notified of each admin action');
  });
  await test('coach §1', 'changes requested → resubmit → approve; coach2/coach3/susp/unlisted approved', async () => {
    ok(await R('coach', 'save_my_coach_profile', { p: profile({ displayName: 'Anna Coach' }) }), 'save');
    ok(await R('coach', 'submit_coach_application'), 'submit');
    fails(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'request_changes' }), 'no reason', /what to change/);
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'request_changes', p_reason: 'Add your experience' }), 'request');
    eq(ok(await R('coach', 'get_my_coach_profile'), 'get').status, 'changes_requested', 'state');
    fails(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'approve' }), 'approve before resubmit', /submitted/);
    ok(await R('coach', 'submit_coach_application'), 'resubmit');
    eq(ok(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'approve' }), 'approve').status, 'approved', 'approved');
    const setup = [
      ['coach2', profile({ displayName: 'Bjorn Online', formats: ['online'], languages: ['en'], city: null, region: null, serviceAreas: [] })],
      ['coach3', profile({ displayName: 'Cara North', formats: ['in_person'], languages: ['is'], city: 'Akureyri', region: null,
        serviceAreas: [{ kind: 'city', city: 'Akureyri', country: 'IS' }] })],
      ['susp', profile({ displayName: 'Sam Suspended' })],
      ['unlisted', profile({ displayName: 'Una Unlisted', listed: false })],
    ];
    for (const [name, p] of setup) {
      ok(await R(name, 'save_my_coach_profile', { p }), `${name} save`);
      ok(await R(name, 'submit_coach_application'), `${name} submit`);
      ok(await R('cadmin', 'admin_review_coach', { p_coach: A[name], p_action: 'approve' }), `${name} approve`);
    }
  });
  await test('coach §1', 'admins cannot review their own application', async () => {
    ok(await R('cadmin', 'save_my_coach_profile', { p: profile({ displayName: 'Admin A' }) }), 'save');
    ok(await R('cadmin', 'submit_coach_application'), 'submit');
    fails(await R('cadmin', 'admin_review_coach', { p_coach: A.cadmin, p_action: 'approve' }), 'self review', /own application/);
  });

  const Q1 = randomUUID();
  const docPath = `${A.coach}/${Q1}/certificate.pdf`;
  const put = (actor, bucket, name, mime = 'image/jpeg') =>
    Q(actor, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4::jsonb) returning id`,
      [bucket, name, A[actor] ?? null, JSON.stringify({ size: 1000, mimetype: mime })]);
  const see = (actor, bucket, name) => Q(actor, `select id from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]);

  await test('coach §1', 'qualification documents: applicant uploads in own folder; readable only by applicant + admins', async () => {
    ok(await put('coach', 'coach-docs', docPath, 'application/pdf'), 'upload');
    fails(await put('coach', 'coach-docs', `${A.stranger}/${Q1}/x.pdf`, 'application/pdf'), 'other folder');
    fails(await put('stranger', 'coach-docs', docPath.replace('certificate', 'other'), 'application/pdf'), 'stranger into coach folder');
    ok(await R('coach', 'save_my_coach_profile', { p: profile({ displayName: 'Anna Coach',
      qualifications: [{ id: Q1, title: 'Level 2 Strength Coach', issuer: 'ISSA', year: 2020, documentPath: docPath, documentName: 'certificate.pdf' }] }) }), 'save qual');
    fails(await R('coach', 'save_my_coach_profile', { p: profile({ qualifications: [{ id: Q1, title: 'x', documentPath: `${A.stranger}/${Q1}/a.pdf` }] }) }), 'foreign doc path', /document path/);
    for (const a of ALL) {
      const r = await see(a, 'coach-docs', docPath);
      const want = a === 'coach' || a === 'cadmin';
      assert((r.rows.length === 1) === want, `${a} ${want ? 'should' : 'should not'} see the document`);
    }
  });
  await test('coach §1', 'approved claims are public; editing a reviewed claim returns it to pending (not public) — coach stays approved', async () => {
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'approve_qualification', p_qualification: Q1 }), 'approve qual');
    let d = ok(await R('client', 'get_coach', { p_coach: A.coach }), 'detail');
    eq(d.approved_qualifications.map((q) => q.title), ['Level 2 Strength Coach'], 'public claim');
    assert(!JSON.stringify(d).includes('certificate.pdf'), 'no document path in public detail');
    ok(await R('coach', 'save_my_coach_profile', { p: profile({ displayName: 'Anna Coach',
      qualifications: [{ id: Q1, title: 'Level 3 Strength Coach', issuer: 'ISSA', year: 2021, documentPath: docPath, documentName: 'certificate.pdf' }] }) }), 'edit claim');
    const me = ok(await R('coach', 'get_my_coach_profile'), 'me');
    eq([me.status, me.qualifications[0].review_status], ['approved', 'pending'], 'coach approved, claim pending');
    d = ok(await R('client', 'get_coach', { p_coach: A.coach }), 'detail');
    eq(d.approved_qualifications, [], 'changed claim not public');
    assert(ok(await R('cadmin', 'admin_list_coach_applications', { p_filter: 'qualifications_pending' }), 'queue').some((x) => x.user_id === A.coach), 'in review queue');
    assert(ok(await R('coach', 'my_coach_review_events'), 'ev').some((e) => e.action === 'qualifications_changed'), 'change logged');
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.coach, p_action: 'approve_qualification', p_qualification: Q1 }), 're-approve');
    eq(ok(await R('client', 'get_coach', { p_coach: A.coach }), 'detail').approved_qualifications.length, 1, 'public again');
  });
  await test('coach §1', 'pending and rejected applicants: absent from search, no detail page, cannot receive requests', async () => {
    const ids = ok(await R('client', 'search_coaches', { p: {} }), 'search').items.map((c) => c.user_id);
    assert(!ids.includes(A.pending) && !ids.includes(A.rejected), 'not listed');
    eq(ok(await R('client', 'get_coach', { p_coach: A.pending }), 'detail'), null, 'pending detail hidden');
    eq(ok(await R('client', 'get_coach', { p_coach: A.rejected }), 'detail'), null, 'rejected detail hidden');
    fails(await R('client', 'request_coaching', { p_id: randomUUID(), p_coach: A.pending, p_intake: {}, p_message: 'hi', p_scopes: {} }), 'request pending', /isn't available/);
    fails(await R('client', 'request_coaching', { p_id: randomUUID(), p_coach: A.rejected, p_intake: {}, p_message: 'hi', p_scopes: {} }), 'request rejected', /isn't available/);
    eq(ok(await R('pending', 'my_coaching_relationships'), 'rels'), [], 'pending has no clients');
  });

  /* ================================================== §3 directory search */
  const items = (r) => ok(r, 'search').items;
  const byId = (list) => Object.fromEntries(list.map((c) => [NAMES[c.user_id], c]));
  const neverListed = (list, what) => {
    for (const bad of ['pending', 'rejected', 'unlisted', 'friend', 'stranger']) {
      assert(!list.some((c) => c.user_id === A[bad]), `${what}: ${bad} must not appear`);
    }
  };
  await test('coach §3', 'city search (case/diacritic-insensitive): local coach first, online coach as remote, no invented distance', async () => {
    for (const city of ['Reykjavík', 'REYKJAVIK', 'reykjavik ']) {
      const r = ok(await R('stranger', 'search_coaches', { p: { city, country: 'is' } }), city);
      const m = byId(r.items);
      eq([m.coach?.match, m.coach?.distance_km, m.coach2?.match, m.coach2?.distance_km], ['local', null, 'remote', null], `${city} matches`);
      assert(!m.coach3, 'Akureyri coach not local to Reykjavík');
      eq(r.distance_available, false, 'no distance without coordinates');
      assert(r.items.findIndex((c) => c.match === 'remote') > r.items.findIndex((c) => c.match === 'local'), 'local before remote');
      neverListed(r.items, city);
    }
  });
  await test('coach §3', 'geolocation search: rounded distance only where the area has geocoder coordinates', async () => {
    const r = ok(await R('stranger', 'search_coaches', { p: { lat: 64.13, lng: -21.9 } }), 'geo');
    const m = byId(r.items);
    eq(m.coach?.match, 'local', 'Reykjavík coach local');
    assert(Number.isInteger(m.coach.distance_km) && m.coach.distance_km >= 1 && m.coach.distance_km <= 5, `distance ${m.coach.distance_km}`);
    eq(r.distance_available, true, 'distance available');
    assert(!m.coach3, 'coach without coordinates is not matched by coordinates');
    eq([m.coach2?.match, m.coach2?.distance_km], ['remote', null], 'online coach remote');
    const area = m.coach.service_areas[0];
    eq([area.lat, area.lng], [64.15, -21.94], 'public coordinates rounded to 2 decimals');
  });
  await test('coach §3', 'radius filter: out-of-radius in-person area is not local; no matched coordinates → distance_available false', async () => {
    const r = ok(await R('stranger', 'search_coaches', { p: { lat: 65.68, lng: -18.09, radiusKm: 30 } }), 'akureyri geo');
    const m = byId(r.items);
    eq(m.coach?.match, 'remote', 'Reykjavík coach (also online) only as remote');
    assert(r.items.every((c) => c.distance_km === null), 'no distances');
    eq(r.distance_available, false, 'distance_available');
    assert(!m.coach3, 'coordinate-less area not matched by coordinates');
  });
  await test('coach §3', 'denied geolocation → manual town search still works (coach without coordinates: local, distance null)', async () => {
    const r = ok(await R('stranger', 'search_coaches', { p: { city: 'akureyri', country: 'IS' } }), 'manual');
    const m = byId(r.items);
    eq([m.coach3?.match, m.coach3?.distance_km], ['local', null], 'Akureyri coach local');
    eq(r.distance_available, false, 'no distance');
  });
  await test('coach §3', 'format / language / specialty / accepting filters; online-only browse; limit ≤ 50; private columns never returned', async () => {
    let r = items(await R('stranger', 'search_coaches', { p: { city: 'Reykjavik', format: 'in_person' } }));
    eq(r.map((c) => NAMES[c.user_id]).sort(), ['coach', 'susp'], 'in-person Reykjavík');
    r = items(await R('stranger', 'search_coaches', { p: { format: 'online' } }));
    assert(r.every((c) => c.match === 'remote' && c.formats.includes('online')) && !r.some((c) => c.user_id === A.coach3), 'online browse');
    r = items(await R('stranger', 'search_coaches', { p: { language: 'is', city: 'Akureyri' } }));
    assert(r.some((c) => c.user_id === A.coach3) && !r.some((c) => c.user_id === A.coach2), 'language filter');
    r = items(await R('stranger', 'search_coaches', { p: { specialty: 'STRENGTH' } }));
    assert(r.length >= 1, 'specialty filter');
    r = items(await R('stranger', 'search_coaches', { p: { limit: 500 } }));
    assert(r.length <= 50, 'limit clamp');
    const keys = new Set(r.flatMap((c) => Object.keys(c)));
    for (const k of ['suspended', 'suspended_reason', 'latest_feedback', 'status', 'qualifications', 'document_path']) {
      assert(!keys.has(k), `card leaks ${k}`);
    }
    fails(await R('anon', 'search_coaches', { p: {} }), 'anon search');
    eq(await C('stranger', `select count(*) n from public.coach_profiles where user_id <> $1`, [A.stranger]), 0, 'no direct read of other coach rows');
  });

  /* ============================================= §4 consent-scoped access */
  // client data
  const S = randomUUID();
  const PR = randomUUID();
  const sessionP = { id: S, name: 'Lower A', status: 'completed', date: new Date().toISOString().slice(0, 10), timeZone: 'UTC', startedAt: ts - 3600e3,
    endedAt: ts, pausedTotalMs: 0, createdAt: ts, updatedAt: ts,
    exercises: [{ id: 'e1', exerciseId: 'barbell-back-squat', order: 0, sets: [{ id: 's1', type: 'normal', weightKg: 100, reps: 5, completed: true, completedAt: ts }] }] };
  const version = (n) => ({ version: n, createdAt: ts, reason: `v${n}`, weeks: 8, reviewWeek: 4, rationale: [], warnings: [],
    templates: [{ id: 't1', name: 'Full body', focus: 'Full', kind: 'strength', estimatedMinutes: 60,
      exercises: [{ id: 'x1', exerciseId: 'barbell-back-squat', sets: 3, repMin: 5, repMax: 8, targetRir: 2, restSec: 180, warmup: '', priority: 1, alternatives: [] }] }],
    schedule: [{ weekday: 1, templateId: 't1' }, { weekday: 4, templateId: 't1' }] });
  const programP = (cur) => ({ id: PR, name: 'My plan', source: 'manual', startDate: '2026-09-01', active: true, currentVersion: cur,
    versions: Array.from({ length: cur }, (_, i) => version(i + 1)), rotationIndex: 0, overrides: [], createdAt: ts, updatedAt: ts + cur });
  const MS = randomUUID();
  const FL = randomUUID();
  const GL = randomUUID();
  let progVersion;
  let sessVersion;
  await test('coach §4', 'client stores workout, program, measurement, food log, goal and private account state', async () => {
    sessVersion = ok(await R('client', 'sync_push', { p_entity: 'sessions', p_id: S, p_op: 'upsert', p_base_version: null, p_payload: sessionP }), 's').version;
    progVersion = ok(await R('client', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: null, p_payload: programP(1) }), 'p').version;
    ok(await R('client', 'sync_push', { p_entity: 'measurements', p_id: MS, p_op: 'upsert', p_base_version: null, p_payload: { id: MS, kind: 'bodyweight', date: '2026-10-20', value: 80 } }), 'm');
    ok(await R('client', 'sync_push', { p_entity: 'food_logs', p_id: FL, p_op: 'upsert', p_base_version: null, p_payload: { id: FL, date: '2026-10-27', meal: 'lunch', name: 'Skyr', protein: 20, kcal: 150 } }), 'f');
    ok(await R('client', 'sync_push', { p_entity: 'goals', p_id: GL, p_op: 'upsert', p_base_version: null, p_payload: { id: GL, title: 'Squat 140', kind: 'exercise_load', target: 140 } }), 'g');
    ok(await R('client', 'sync_push', { p_entity: 'account_state', p_id: A.client, p_op: 'upsert', p_base_version: null,
      p_payload: { id: 'account', profile: { injuryNotes: 'Knee surgery 2019' }, settings: {} } }), 'a');
    // client ↔ friend are social friends (friendship must never grant coaching access)
    const fr = ok(await R('friend', 'send_friend_request', { p_target: A.client }), 'fr').id;
    ok(await R('client', 'respond_friend_request', { p_request_id: fr, p_accept: true }), 'accept');
  });

  const REL = randomUUID();
  const clientRows = {
    workout_sessions: `select id from public.workout_sessions where owner_id = $1`,
    session_sets: `select id from public.session_sets where owner_id = $1`,
    programs: `select id from public.programs where owner_id = $1`,
    program_versions: `select version_no from public.program_versions where owner_id = $1`,
    goals: `select id from public.goals where owner_id = $1`,
    measurements: `select id from public.measurements where owner_id = $1`,
    food_logs: `select id from public.food_logs where owner_id = $1`,
    account_state: `select id from public.account_state where owner_id = $1`,
  };
  const visible = async (actor, table, owner = A.client) => (await Q(actor, clientRows[table], [owner])).rows.length > 0;

  await test('coach §4', 'request: idempotent on id, intake allow-listed, coach notified once; coach cannot create requests for users', async () => {
    const args = { p_id: REL, p_coach: A.coach, p_intake: { goal: 'strength', daysPerWeek: 3, evil: '<script>' }, p_message: 'Hi Anna, can you help me squat more?',
      p_scopes: { training: true, measurements: false, nutrition: false, checkins: true } };
    const r1 = ok(await R('client', 'request_coaching', args), 'request');
    const r2 = ok(await R('client', 'request_coaching', args), 'retry');
    eq([r1.id, r2.id, r1.status], [REL, REL, 'requested'], 'same request');
    eq(Object.keys(r1.intake).sort(), ['daysPerWeek', 'goal'], 'intake keys');
    eq(await adminCount(`select count(*) n from public.coaching_relationships where client_id = $1`, [A.client]), 1, 'rows');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'coach_request'`, [A.coach]), 1, 'one notification');
    fails(await R('coach', 'request_coaching', { ...args, p_id: REL }), 'coach reusing the id', /not found/);
    fails(await R('client', 'request_coaching', { ...args, p_id: randomUUID(), p_coach: A.client }), 'self', /yourself/);
    fails(await R('client', 'request_coaching', { ...args, p_id: randomUUID() }), 'duplicate pending', /pending request/);
    fails(await R('stranger', 'request_coaching', { ...args, p_id: randomUUID(), p_coach: A.unlisted }), 'unlisted coach', /isn't available/);
    fails(await Q('coach', `insert into public.coaching_relationships (id, coach_id, client_id, status) values ($1, $2, $3, 'active')`, [randomUUID(), A.coach, A.stranger]), 'direct insert');
    fails(await R('client', 'respond_coaching_request', { p_id: REL, p_accept: true }), 'client accepts own request', /not found/);
  });
  await test('coach §4', 'pending: coach sees only the relationship (intake + intro); no client records, no chat', async () => {
    const o = ok(await R('coach', 'coach_client_overview', { p_id: REL }), 'overview');
    eq([o.relationship.status, o.relationship.intro_message.length > 0, o.training, o.measurements, o.nutrition, o.checkins],
      ['requested', true, null, null, null, null], 'panels');
    for (const t of Object.keys(clientRows)) assert(!(await visible('coach', t)), `pending coach must not read ${t}`);
    fails(await R('coach', 'list_coach_messages', { p_relationship: REL }), 'list messages');
    fails(await R('client', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL, p_body: 'hello?' }), 'send while pending', /read-only/);
  });
  await test('coach §4', 'accept → active; client notified; coach reads exactly the consented scopes', async () => {
    eq(ok(await R('coach', 'respond_coaching_request', { p_id: REL, p_accept: true, p_message: 'Welcome!' }), 'accept').status, 'active', 'active');
    assert(ok(await R('client', 'list_notifications'), 'n').some((n) => n.type === 'coach_request_accepted' && n.relationship_id === REL), 'notified');
    for (const t of ['workout_sessions', 'session_sets', 'programs', 'program_versions', 'goals']) assert(await visible('coach', t), `coach reads ${t}`);
    for (const t of ['measurements', 'food_logs', 'account_state']) assert(!(await visible('coach', t)), `coach must not read ${t}`);
    const o = ok(await R('coach', 'coach_client_overview', { p_id: REL }), 'overview');
    assert(o.training && o.training.recent_sessions.length === 1 && o.training.active_program.id === PR, 'training panel');
    eq(o.training.recent_sessions[0].working_sets, 1, 'working sets');
    assert(Number.isInteger(o.training.planned_last28), 'planned from schedule');
    eq([o.measurements, o.nutrition], [null, null], 'unconsented panels null');
    eq(o.checkins, [], 'checkins panel (consented, empty)');
  });
  await test('coach §4', 'scope changes apply to the very next query (grant measurements, then revoke)', async () => {
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: true, measurements: true, nutrition: false, checkins: true } }), 'grant');
    assert(await visible('coach', 'measurements'), 'now visible');
    eq(ok(await R('coach', 'coach_client_overview', { p_id: REL }), 'o').measurements.length, 1, 'panel');
    fails(await R('coach', 'set_coaching_scopes', { p_id: REL, p_scopes: { nutrition: true } }), 'coach cannot change scopes');
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: true, measurements: false, nutrition: false, checkins: true } }), 'revoke');
    assert(!(await visible('coach', 'measurements')), 'hidden again');
  });
  await test('coach §4', 'coach can never write client records (no grants; sync_push only ever writes the caller’s own rows)', async () => {
    fails(await Q('coach', `update public.workout_sessions set payload = '{}' where owner_id = $1`, [A.client]), 'update');
    fails(await Q('coach', `delete from public.session_sets where owner_id = $1`, [A.client]), 'delete');
    fails(await Q('coach', `insert into public.measurements (owner_id, id, version, payload) values ($1, gen_random_uuid(), 1, '{}')`, [A.client]), 'insert');
    ok(await R('coach', 'sync_push', { p_entity: 'sessions', p_id: S, p_op: 'upsert', p_base_version: sessVersion, p_payload: { ...sessionP, name: 'hacked' } }), 'push');
    const r = await admin.query(`select name, version from public.workout_sessions where owner_id = $1 and id = $2`, [A.client, S]);
    eq([r.rows[0].name, Number(r.rows[0].version)], ['Lower A', Number(sessVersion)], 'client row untouched');
  });

  /* ============================================ §5 nobody else can read */
  await test('coach §5', 'other coach / social friend / unrelated / pending / rejected / admin / anon read none of the client’s records', async () => {
    for (const a of ['coach2', 'friend', 'stranger', 'pending', 'rejected', 'susp', 'cadmin', 'anon']) {
      for (const t of Object.keys(clientRows)) assert(!(await visible(a, t)), `${a} must not read ${t}`);
      fails(await R(a, 'coach_client_overview', { p_id: REL }), `${a} overview`);
      fails(await R(a, 'list_coach_messages', { p_relationship: REL }), `${a} messages`);
      eq(await C(a, `select count(*) n from public.coaching_relationships where id = $1`, [REL]) > 0, false, `${a} relationship row`);
    }
  });

  /* ================================================== §8 messaging */
  const M1 = randomUUID();
  const M2 = randomUUID();
  let m1;
  await test('coach §8', 'messages persist with server seq; retry with the same id returns the stored row, no duplicate, no 2nd notification', async () => {
    await admin.query(`update public.notifications set read_at = now() where recipient_id = $1`, [A.coach]);
    m1 = ok(await R('client', 'send_coach_message', { p_id: M1, p_relationship: REL, p_body: 'Squats felt heavy today' }), 'send');
    const nBefore = await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'coach_message'`, [A.coach]);
    const tBefore = (await admin.query(`select max(created_at) t from public.notifications where recipient_id = $1 and type = 'coach_message'`, [A.coach])).rows[0].t;
    const again = ok(await R('client', 'send_coach_message', { p_id: M1, p_relationship: REL, p_body: 'Squats felt heavy today' }), 'retry');
    eq([again.id, again.seq, again.created_at, again.status], [m1.id, m1.seq, m1.created_at, 'sent'], 'same row');
    eq(await adminCount(`select count(*) n from public.coach_messages where id = $1`, [M1]), 1, 'one row');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'coach_message'`, [A.coach]), nBefore, 'no duplicate notification');
    eq((await admin.query(`select max(created_at) t from public.notifications where recipient_id = $1 and type = 'coach_message'`, [A.coach])).rows[0].t?.toISOString(), tBefore?.toISOString(), 'not bumped');
    fails(await R('stranger', 'send_coach_message', { p_id: M1, p_relationship: REL, p_body: 'x' }), 'id hijack');
  });
  await test('coach §8', 'ordering by seq, after_seq paging, unread counts and mark-read', async () => {
    ok(await R('coach', 'send_coach_message', { p_id: M2, p_relationship: REL, p_body: 'Drop 5 kg next session.' }), 'reply');
    const list = ok(await R('client', 'list_coach_messages', { p_relationship: REL }), 'list');
    eq(list.map((m) => m.id), [M1, M2], 'order');
    assert(Number(list[1].seq) > Number(list[0].seq), 'seq increases');
    eq(ok(await R('client', 'list_coach_messages', { p_relationship: REL, p_after_seq: list[0].seq }), 'page').map((m) => m.id), [M2], 'after_seq');
    eq(ok(await R('coach', 'unread_coaching_count'), 'unread'), 1, 'coach unread');
    ok(await R('coach', 'mark_coach_messages_read', { p_relationship: REL, p_upto: list[1].seq }), 'read');
    eq(ok(await R('coach', 'unread_coaching_count'), 'unread'), 0, 'coach read all');
    const n = await admin.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'notifications'`);
    assert(!n.rows.some((c) => /body|text|content|message/.test(c.column_name)), 'notifications have no text column');
    assert(!JSON.stringify(ok(await R('client', 'list_notifications'), 'n')).includes('Drop 5 kg'), 'no message text in notifications');
    for (const a of ['friend', 'stranger', 'coach2', 'cadmin']) {
      eq(await C(a, `select count(*) n from public.notifications where recipient_id = $1`, [A.client]), 0, `${a} reads client notifications`);
    }
  });
  const M3 = randomUUID();
  const MEDIA = randomUUID();
  const mediaPath = `${REL}/${M3}/${MEDIA}.jpg`;
  await test('coach §8', 'photo message: awaiting_media until finalized (service only); upload only by sender; fresh seq when sent', async () => {
    const m = ok(await R('client', 'send_coach_message', { p_id: M3, p_relationship: REL, p_body: '', p_media: [{ id: MEDIA, width: 800, height: 600 }] }), 'send');
    eq(m.status, 'awaiting_media', 'status');
    assert(!ok(await R('coach', 'list_coach_messages', { p_relationship: REL }), 'coach list').some((x) => x.id === M3), 'hidden from coach');
    fails(await put('coach', 'coach-media', mediaPath), 'coach cannot upload into client message');
    fails(await put('stranger', 'coach-media', mediaPath), 'stranger upload');
    fails(await put('client', 'coach-media', `${REL}/${M3}/${randomUUID()}.jpg`), 'undeclared media id');
    ok(await put('client', 'coach-media', mediaPath), 'image');
    ok(await put('client', 'coach-media', mediaPath.replace('.jpg', '_thumb.jpg')), 'thumb');
    eq((await see('coach', 'coach-media', mediaPath)).rows.length, 0, 'coach cannot sign before sent');
    fails(await R('client', 'finalize_coach_message', { p_message: M3, p_user: A.client, p_media: [] }), 'client cannot finalize');
    fails(await R('service', 'finalize_coach_message', { p_message: M3, p_user: A.coach, p_media: [{ id: MEDIA, width: 800, height: 600 }] }), 'wrong sender');
    fails(await R('service', 'finalize_coach_message', { p_message: M3, p_user: A.client, p_media: [] }), 'incomplete', /finished uploading/);
    const f = ok(await R('service', 'finalize_coach_message', { p_message: M3, p_user: A.client, p_media: [{ id: MEDIA, width: 640, height: 480 }] }), 'finalize');
    eq([f.status, f.already, f.media[0].width], ['sent', false, 640], 'sent');
    eq(ok(await R('service', 'finalize_coach_message', { p_message: M3, p_user: A.client, p_media: [] }), 'again').already, true, 'idempotent');
    const list = ok(await R('coach', 'list_coach_messages', { p_relationship: REL }), 'coach list');
    eq(list.at(-1).id, M3, 'sorted last (fresh seq)');
    eq((await see('coach', 'coach-media', mediaPath)).rows.length, 1, 'coach can sign now');
    eq((await Q('client', `update storage.objects set metadata = '{"size":1}' where bucket_id = 'coach-media' and name = $1`, [mediaPath])).rowCount, 0, 'no overwrite after sent');
    for (const a of ['coach2', 'friend', 'stranger', 'cadmin', 'anon', 'pending']) {
      eq((await see(a, 'coach-media', mediaPath)).rows.length, 0, `${a} cannot sign chat media`);
    }
  });
  await test('coach §8', 'message rate limit (120/hour) and reports (admins see only the reported message)', async () => {
    const r = await Q('client', `do $$ begin for i in 1..125 loop perform public.send_coach_message(gen_random_uuid(), '${REL}', 'spam ' || i); end loop; end $$`);
    fails(r, '121st message', /very quickly/);
    ok(await R('coach', 'report_coaching_content', { p_relationship: REL, p_message: M1, p_reason: 'other', p_details: 'test report' }), 'report');
    ok(await R('coach', 'report_coaching_content', { p_relationship: REL, p_message: M1, p_reason: 'other' }), 'duplicate is a no-op');
    fails(await R('stranger', 'report_coaching_content', { p_relationship: REL, p_message: M1, p_reason: 'spam' }), 'outsider report');
    fails(await R('coach', 'admin_list_coaching_reports'), 'coach lists reports', /Only admins/);
    const reps = ok(await R('cadmin', 'admin_list_coaching_reports'), 'admin list');
    eq([reps.length, reps[0].message_body], [1, 'Squats felt heavy today'], 'report with message');
    ok(await R('cadmin', 'admin_resolve_coaching_report', { p_id: reps[0].id, p_action: 'dismiss' }), 'resolve');
    eq(ok(await R('cadmin', 'admin_list_coaching_reports'), 'open').length, 0, 'resolved');
  });

  /* ============================================ §7 programs via proposals */
  const P1 = randomUUID();
  const P2 = randomUUID();
  const P3 = randomUUID();
  const P4 = randomUUID();
  const proposed = (name) => ({ ...version(1), name, version: undefined, createdAt: undefined, progressionNotes: 'Add 2.5 kg when all reps done' });
  await test('coach §7', 'coach drafts a revision of the client program; drafts are invisible to the client; invalid programs refused', async () => {
    const d = ok(await R('coach', 'save_program_proposal', { p: { id: P1, relationshipId: REL, baseProgramId: PR, baseVersion: 1, program: proposed('Coach plan'), changeSummary: ['More squats'] } }), 'draft');
    eq([d.status, d.revision, d.author_kind], ['draft', 1, 'coach'], 'draft');
    eq(ok(await R('client', 'get_program_proposal', { p_id: P1 }), 'client get'), null, 'draft hidden');
    eq(ok(await R('client', 'list_program_proposals', { p: { mine: true } }), 'client list'), [], 'draft not listed');
    eq(await C('client', `select count(*) n from public.program_proposals where id = $1`, [P1]), 0, 'direct select hides draft');
    fails(await R('coach', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL, program: { name: 'x', templates: [] } } }), 'invalid', /at least one session/);
    fails(await R('coach', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL, program: { ...proposed('x'), templates: [{ id: 't1', name: 'A', exercises: [{ id: 'q', exerciseId: 'made-up-lift', sets: 3, repMin: 5, repMax: 8, restSec: 60 }] }] } } }), 'unknown exercise', /Unknown exercise/);
    fails(await R('client', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL, program: proposed('self') } }), 'client cannot author coach proposals');
    fails(await R('coach2', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL, program: proposed('x') } }), 'other coach');
  });
  await test('coach §7', 'send → client notified; a newer revision supersedes the older sent one; revisions increment', async () => {
    eq(ok(await R('coach', 'send_program_proposal', { p_id: P1 }), 'send').status, 'sent', 'sent');
    ok(await R('coach', 'send_program_proposal', { p_id: P1 }), 'idempotent');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'coach_proposal' and proposal_id = $2`, [A.client, P1]), 1, 'one notification');
    const d2 = ok(await R('coach', 'save_program_proposal', { p: { id: P2, relationshipId: REL, baseProgramId: PR, baseVersion: 1, program: proposed('Coach plan v2'), changeSummary: ['Even more squats'] } }), 'draft 2');
    eq(d2.revision, 2, 'revision 2');
    ok(await R('coach', 'send_program_proposal', { p_id: P2 }), 'send 2');
    eq(ok(await R('client', 'get_program_proposal', { p_id: P1 }), 'p1').status, 'superseded', 'older superseded');
    eq(ok(await R('client', 'list_program_proposals', { p: { mine: true, status: ['sent'] } }), 'list').map((p) => p.id), [P2], 'one open');
  });
  await test('coach §7', 'stale proposals are rejected; accept needs the applied ids; only the client responds', async () => {
    fails(await R('client', 'respond_program_proposal', { p_id: P2, p_accept: true }), 'no ids', /program id and version/);
    fails(await R('coach', 'respond_program_proposal', { p_id: P2, p_accept: true, p_program_id: PR, p_version: 2 }), 'coach cannot accept');
    // the client edits their plan themselves → server copy is now at version 2
    progVersion = ok(await R('client', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: progVersion, p_payload: programP(2) }), 'self edit').version;
    const r = await R('client', 'respond_program_proposal', { p_id: P2, p_accept: true, p_program_id: PR, p_version: 3 });
    fails(r, 'stale accept', /stale/);
    eq(ok(await R('client', 'get_program_proposal', { p_id: P2 }), 'p2').status, 'sent', 'still open, not applied');
  });
  await test('coach §7', 'revision on the current version is accepted: applied ids recorded, coach notified; history unchanged', async () => {
    const d3 = ok(await R('coach', 'save_program_proposal', { p: { id: P3, relationshipId: REL, baseProgramId: PR, baseVersion: 2, program: proposed('Coach plan v3'), changeSummary: ['Rebased on v2'], effectiveDate: '2026-11-02' } }), 'draft 3');
    eq(d3.revision, 3, 'revision 3');
    ok(await R('coach', 'send_program_proposal', { p_id: P3 }), 'send');
    fails(await R('client', 'respond_program_proposal', { p_id: P3, p_accept: true, p_program_id: randomUUID(), p_version: 3 }), 'other plan', /different plan/);
    fails(await R('client', 'respond_program_proposal', { p_id: P3, p_accept: true, p_program_id: PR, p_version: 2 }), 'not a new version', /new version/);
    const a = ok(await R('client', 'respond_program_proposal', { p_id: P3, p_accept: true, p_program_id: PR, p_version: 3 }), 'accept');
    eq([a.status, a.applied_program_id, a.applied_version], ['accepted', PR, 3], 'applied');
    ok(await R('client', 'respond_program_proposal', { p_id: P3, p_accept: true, p_program_id: PR, p_version: 3 }), 'idempotent');
    fails(await R('client', 'respond_program_proposal', { p_id: P3, p_accept: false }), 'cannot flip an answered proposal', /no longer open/);
    assert(ok(await R('coach', 'list_notifications'), 'n').some((n) => n.type === 'coach_proposal_response' && n.proposal_id === P3), 'coach notified');
    // the client applies it locally (new version 3) and syncs it — the coach never writes it
    ok(await R('client', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: progVersion, p_payload: { ...programP(3), managedBy: { kind: 'coach', relationshipId: REL, proposalId: P3 } } }), 'apply');
    const o = ok(await R('coach', 'coach_client_overview', { p_id: REL }), 'overview');
    eq([o.training.active_program.current_version, o.training.active_program.managed_by], [3, 'coach'], 'coach sees the accepted plan');
    const s = await admin.query(`select version, payload from public.workout_sessions where owner_id = $1 and id = $2`, [A.client, S]);
    eq([Number(s.rows[0].version), s.rows[0].payload.exercises[0].sets[0].weightKg], [Number(sessVersion), 100], 'recorded results unchanged');
  });
  await test('coach §7', 'withdraw; withdrawn proposals cannot be accepted; proposal rate limit (20/day/coach)', async () => {
    ok(await R('coach', 'save_program_proposal', { p: { id: P4, relationshipId: REL, baseProgramId: PR, baseVersion: 3, program: proposed('v4') } }), 'draft');
    ok(await R('coach', 'send_program_proposal', { p_id: P4 }), 'send');
    ok(await R('coach', 'withdraw_program_proposal', { p_id: P4 }), 'withdraw');
    fails(await R('client', 'respond_program_proposal', { p_id: P4, p_accept: true, p_program_id: PR, p_version: 4 }), 'accept withdrawn', /no longer open/);
    const prog = JSON.stringify(proposed('bulk')).replace(/'/g, "''");
    const r = await Q('coach', `do $$ begin for i in 1..20 loop perform public.save_program_proposal(jsonb_build_object('id', gen_random_uuid(), 'relationshipId', '${REL}', 'program', '${prog}'::jsonb)); end loop; end $$`);
    fails(r, '21st proposal today', /many program proposals/);
  });

  /* ========================================= feedback + check-ins (scope) */
  await test('coach §4', 'feedback and check-ins: participants only; coach needs the checkins scope', async () => {
    const F = randomUUID();
    ok(await R('coach', 'add_coach_feedback', { p_id: F, p_relationship: REL, p_session: S, p_body: 'Great depth!' }), 'feedback');
    ok(await R('coach', 'add_coach_feedback', { p_id: F, p_relationship: REL, p_session: S, p_body: 'Great depth!' }), 'idempotent');
    eq(ok(await R('client', 'list_coach_feedback', { p_relationship: REL }), 'list').length, 1, 'client sees it');
    fails(await R('stranger', 'list_coach_feedback', { p_relationship: REL }), 'stranger');
    fails(await R('client', 'add_coach_feedback', { p_id: randomUUID(), p_relationship: REL, p_session: null, p_body: 'x' }), 'client cannot add coach feedback');
    const K = randomUUID();
    ok(await R('client', 'submit_checkin', { p_id: K, p_relationship: REL, p_answers: { energy: 4, sleep: 9, wins: 'PR!' }, p_note: 'good week' }), 'check-in');
    const ans = ok(await R('coach', 'list_checkins', { p_relationship: REL }), 'coach list')[0].answers;
    eq([ans.energy, ans.wins, 'sleep' in ans], [4, 'PR!', false], 'sanitized answers (out-of-range sleep dropped)');
    ok(await R('coach', 'respond_checkin', { p_id: K, p_response: 'Nice work' }), 'respond');
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: true, checkins: false } }), 'revoke checkins');
    fails(await R('coach', 'list_checkins', { p_relationship: REL }), 'coach list without scope');
    eq(await C('coach', `select count(*) n from public.coach_checkins where relationship_id = $1`, [REL]), 0, 'direct read without scope');
    fails(await R('coach', 'respond_checkin', { p_id: K, p_response: 'again' }), 'respond without scope');
    eq(ok(await R('client', 'list_checkins', { p_relationship: REL }), 'client list').length, 1, 'client keeps access');
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: true, checkins: true } }), 'restore');
  });

  /* ================================ §6 revocation / termination / blocking */
  await test('coach §6', 'revoked scope: coach reads and session-feedback writes fail immediately', async () => {
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: false, checkins: true } }), 'revoke training');
    assert(!(await visible('coach', 'workout_sessions')), 'no workouts');
    eq(ok(await R('coach', 'coach_client_overview', { p_id: REL }), 'o').training, null, 'training panel null');
    fails(await R('coach', 'add_coach_feedback', { p_id: randomUUID(), p_relationship: REL, p_session: S, p_body: 'queued feedback' }), 'queued feedback on session', /Workout not found/);
    ok(await R('client', 'set_coaching_scopes', { p_id: REL, p_scopes: { training: true, checkins: true } }), 'restore');
  });
  const REL3 = randomUUID();
  await test('coach §6', 'termination: queued writes from either side fail; history stays read-only for both', async () => {
    ok(await R('client3', 'request_coaching', { p_id: REL3, p_coach: A.coach2, p_intake: {}, p_message: 'Hi', p_scopes: { training: true } }), 'request');
    ok(await R('coach2', 'respond_coaching_request', { p_id: REL3, p_accept: true }), 'accept');
    ok(await R('client3', 'sync_push', { p_entity: 'sessions', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: { ...sessionP, id: undefined } }).then((x) => x), 'session');
    ok(await R('client3', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL3, p_body: 'Hello coach' }), 'msg');
    const draft = randomUUID();
    ok(await R('coach2', 'save_program_proposal', { p: { id: draft, relationshipId: REL3, program: proposed('x') } }), 'draft');
    ok(await R('client3', 'end_coaching', { p_id: REL3, p_reason: 'Moving on' }), 'end');
    assert(ok(await R('coach2', 'list_notifications'), 'n').some((n) => n.type === 'coach_ended' && n.relationship_id === REL3), 'coach notified');
    fails(await R('coach2', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL3, p_body: 'queued' }), 'coach queued msg', /read-only/);
    fails(await R('client3', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL3, p_body: 'queued' }), 'client queued msg', /read-only/);
    fails(await R('coach2', 'send_program_proposal', { p_id: draft }), 'queued proposal send');
    fails(await R('coach2', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL3, program: proposed('x') } }), 'new proposal');
    fails(await R('coach2', 'add_coach_feedback', { p_id: randomUUID(), p_relationship: REL3, p_session: null, p_body: 'x' }), 'feedback');
    fails(await R('client3', 'submit_checkin', { p_id: randomUUID(), p_relationship: REL3, p_answers: {} }), 'check-in');
    assert(!(await visible('coach2', 'workout_sessions', A.client3)), 'no record access');
    eq(ok(await R('coach2', 'list_coach_messages', { p_relationship: REL3 }), 'coach history').length, 1, 'coach reads history');
    eq(ok(await R('client3', 'list_coach_messages', { p_relationship: REL3 }), 'client history').length, 1, 'client reads history');
    eq((await admin.query(`select status from public.program_proposals where id = $1`, [draft])).rows[0].status, 'withdrawn', 'open proposals withdrawn');
  });
  const REL4 = randomUUID();
  await test('coach §6', 'blocking ends coaching (either direction) and stops reads and queued writes; unblocking does not restore it', async () => {
    ok(await R('client4', 'request_coaching', { p_id: REL4, p_coach: A.coach, p_intake: {}, p_message: 'Hi', p_scopes: { training: true } }), 'request');
    ok(await R('coach', 'respond_coaching_request', { p_id: REL4, p_accept: true }), 'accept');
    ok(await R('client4', 'sync_push', { p_entity: 'sessions', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: { ...sessionP, id: undefined } }), 'session');
    assert(await visible('coach', 'workout_sessions', A.client4), 'coach reads before block');
    ok(await R('client4', 'block_user', { p_other: A.coach }), 'block');
    eq((await admin.query(`select status from public.coaching_relationships where id = $1`, [REL4])).rows[0].status, 'ended', 'ended');
    assert(!(await visible('coach', 'workout_sessions', A.client4)), 'no reads');
    fails(await R('coach', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL4, p_body: 'queued' }), 'queued send');
    fails(await R('coach', 'request_coaching', { p_id: randomUUID(), p_coach: A.coach, p_intake: {}, p_message: '', p_scopes: {} }), 'n/a');
    fails(await R('client4', 'request_coaching', { p_id: randomUUID(), p_coach: A.coach, p_intake: {}, p_message: 'again', p_scopes: {} }), 'blocked request', /isn't available/);
    ok(await R('client4', 'unblock_user', { p_other: A.coach }), 'unblock');
    eq((await admin.query(`select status from public.coaching_relationships where id = $1`, [REL4])).rows[0].status, 'ended', 'still ended');
    assert(!(await visible('coach', 'workout_sessions', A.client4)), 'still no reads');
    // block while pending → request cancelled
    const pend = randomUUID();
    ok(await R('client4', 'request_coaching', { p_id: pend, p_coach: A.coach3, p_intake: {}, p_message: 'Hi', p_scopes: {} }), 'request coach3');
    ok(await R('coach3', 'block_user', { p_other: A.client4 }), 'coach blocks');
    eq((await admin.query(`select status from public.coaching_relationships where id = $1`, [pend])).rows[0].status, 'cancelled', 'cancelled');
    fails(await R('coach3', 'respond_coaching_request', { p_id: pend, p_accept: true }), 'accept after block');
  });
  await test('coach §6', 'friendship never grants or affects coaching access (unfriend is a no-op for coaching)', async () => {
    const fr = ok(await R('coach', 'send_friend_request', { p_target: A.client }), 'fr').id;
    ok(await R('client', 'respond_friend_request', { p_request_id: fr, p_accept: true }), 'accept');
    ok(await R('client', 'remove_friend', { p_other: A.coach }), 'unfriend');
    assert(await visible('coach', 'workout_sessions'), 'coach access unchanged');
    assert(!(await visible('friend', 'workout_sessions')), 'friend still has none');
  });

  /* ======================================================= §2 suspension */
  const REL2 = randomUUID();
  await test('coach §2', 'approval enables listing only when the coach publishes it; listing/accepting are coach-controlled', async () => {
    let ids = items(await R('stranger', 'search_coaches', { p: {} })).map((c) => c.user_id);
    assert(!ids.includes(A.unlisted), 'approved but unlisted is hidden');
    ok(await R('unlisted', 'set_coach_listing', { p_listed: true, p_accepting: false }), 'publish');
    ids = items(await R('stranger', 'search_coaches', { p: {} })).map((c) => c.user_id);
    assert(ids.includes(A.unlisted), 'now listed');
    assert(!items(await R('stranger', 'search_coaches', { p: { acceptingOnly: true } })).some((c) => c.user_id === A.unlisted), 'accepting filter');
    fails(await R('stranger', 'request_coaching', { p_id: randomUUID(), p_coach: A.unlisted, p_intake: {}, p_message: '', p_scopes: {} }), 'not accepting', /accepting new clients/);
    ok(await R('unlisted', 'set_coach_listing', { p_listed: false, p_accepting: false }), 'unpublish');
  });
  await test('coach §2', 'suspension: listing removed; reads, overview, chat and writes fail at once for an existing session; clients told', async () => {
    ok(await R('client2', 'request_coaching', { p_id: REL2, p_coach: A.susp, p_intake: { goal: 'x' }, p_message: 'Hi', p_scopes: { training: true, checkins: true } }), 'request');
    ok(await R('susp', 'respond_coaching_request', { p_id: REL2, p_accept: true }), 'accept');
    ok(await R('client2', 'sync_push', { p_entity: 'sessions', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: { ...sessionP, id: undefined } }), 'session');
    ok(await R('client2', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL2, p_body: 'Hi' }), 'msg');
    assert(await visible('susp', 'workout_sessions', A.client2), 'reads before suspension');
    fails(await R('cadmin', 'admin_review_coach', { p_coach: A.susp, p_action: 'suspend' }), 'reason required', /reason/);
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.susp, p_action: 'suspend', p_reason: 'Under investigation' }), 'suspend');
    // same JWT claims as before (an "open session")
    assert(!(await visible('susp', 'workout_sessions', A.client2)), 'no reads');
    fails(await R('susp', 'coach_client_overview', { p_id: REL2 }), 'overview', /isn't active/);
    fails(await R('susp', 'list_coach_messages', { p_relationship: REL2 }), 'chat read');
    fails(await R('susp', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL2, p_body: 'queued' }), 'chat send');
    fails(await R('susp', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: REL2, program: proposed('x') } }), 'proposal');
    eq(ok(await R('susp', 'my_coaching_relationships'), 'rels')[0].intake, {}, 'intake hidden from suspended coach');
    assert(!items(await R('stranger', 'search_coaches', { p: { city: 'Reykjavik' } })).some((c) => c.user_id === A.susp), 'not listed');
    eq(ok(await R('stranger', 'get_coach', { p_coach: A.susp }), 'detail'), null, 'detail hidden');
    fails(await R('client', 'request_coaching', { p_id: randomUUID(), p_coach: A.susp, p_intake: {}, p_message: '', p_scopes: {} }), 'request', /isn't available/);
    assert(ok(await R('client2', 'list_notifications'), 'n').some((n) => n.type === 'coach_status' && n.coach_id === A.susp), 'client told');
    const rel = ok(await R('client2', 'my_coaching_relationships'), 'client rels')[0];
    eq([rel.status, rel.coach.suspended], ['active', true], 'client sees suspended state');
    eq(ok(await R('client2', 'list_coach_messages', { p_relationship: REL2 }), 'client history').length, 1, 'client keeps history');
    assert(await visible('client2', 'workout_sessions', A.client2), 'client data preserved');
    eq(ok(await R('susp', 'get_my_coach_profile'), 'me').suspended_reason, 'Under investigation', 'coach sees reason');
  });
  await test('coach §2', 'reinstate restores access; suspend again (suspended-coach actor for the matrix)', async () => {
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.susp, p_action: 'reinstate', p_reason: 'Cleared' }), 'reinstate');
    assert(await visible('susp', 'workout_sessions', A.client2), 'reads again');
    ok(await R('susp', 'send_coach_message', { p_id: randomUUID(), p_relationship: REL2, p_body: 'Back!' }), 'send');
    const ev = ok(await R('cadmin', 'admin_get_coach_application', { p_coach: A.susp }), 'events').events.map((e) => e.action);
    assert(ev.includes('suspend') && ev.includes('reinstate'), 'logged');
    ok(await R('cadmin', 'admin_review_coach', { p_coach: A.susp, p_action: 'suspend', p_reason: 'Again' }), 'suspend again');
    eq(ok(await R('cadmin', 'admin_list_coach_applications', { p_filter: 'suspended' }), 'list').map((c) => c.user_id), [A.susp], 'suspended filter');
  });
  await test('coach §2', 'admins get no access to client health records or private conversations', async () => {
    for (const t of Object.keys(clientRows)) assert(!(await visible('cadmin', t)), `admin must not read ${t}`);
    eq(await C('cadmin', `select count(*) n from public.coach_messages`), 0, 'no chat reads');
    fails(await R('cadmin', 'coach_client_overview', { p_id: REL }), 'no overview');
  });

  /* =============================== switching coaches (explicit flow) */
  await test('coach §5', 'one primary coach: accepting a new coach ends the previous one (old coach notified, access gone)', async () => {
    const RELB = randomUUID();
    ok(await R('client', 'request_coaching', { p_id: RELB, p_coach: A.coach2, p_intake: {}, p_message: 'Switching', p_scopes: { training: true } }), 'request');
    assert(await visible('coach', 'workout_sessions'), 'old coach still active while pending');
    ok(await R('coach2', 'respond_coaching_request', { p_id: RELB, p_accept: true }), 'accept');
    const old = (await admin.query(`select status, end_reason from public.coaching_relationships where id = $1`, [REL])).rows[0];
    eq([old.status, old.end_reason], ['ended', 'switched coach'], 'old ended');
    assert(ok(await R('coach', 'list_notifications'), 'n').some((n) => n.type === 'coach_ended' && n.relationship_id === REL), 'old coach notified');
    assert(!(await visible('coach', 'workout_sessions')), 'old coach access gone');
    assert(await visible('coach2', 'workout_sessions'), 'new coach access');
    // restore the original pairing for the matrix: back to `coach`
    const RELC = randomUUID();
    ok(await R('client', 'request_coaching', { p_id: RELC, p_coach: A.coach, p_intake: {}, p_message: 'Back', p_scopes: { training: true, checkins: true } }), 'request back');
    ok(await R('coach', 'respond_coaching_request', { p_id: RELC, p_accept: true }), 'accept back');
    matrixRel = RELC;
  });

  /* ============================================================ matrix */
  const MM = randomUUID();
  const MMEDIA = randomUUID();
  const mpath = () => `${matrixRel}/${MM}/${MMEDIA}.jpg`;
  await test('coach matrix', 'fixtures: a sent photo message + check-in in the current relationship', async () => {
    ok(await R('client', 'send_coach_message', { p_id: MM, p_relationship: matrixRel, p_body: 'pic', p_media: [{ id: MMEDIA }] }), 'send (dimensions optional)');
    ok(await put('client', 'coach-media', mpath()), 'upload');
    ok(await R('service', 'finalize_coach_message', { p_message: MM, p_user: A.client, p_media: [{ id: MMEDIA, width: 10, height: 10 }] }), 'finalize');
    ok(await R('client', 'submit_checkin', { p_id: randomUUID(), p_relationship: matrixRel, p_answers: { energy: 3 } }), 'check-in');
  });
  const rowsCan = async (actor, sql, params) => (await Q(actor, sql, params)).rows.length > 0;
  const rpcCan = async (actor, fn, args) => !(await R(actor, fn, args)).error;
  const resources = [
    ['client workout_sessions', ['client', 'coach'], (a) => visible(a, 'workout_sessions')],
    ['client session_sets', ['client', 'coach'], (a) => visible(a, 'session_sets')],
    ['client programs/versions', ['client', 'coach'], (a) => visible(a, 'program_versions')],
    ['client measurements (no scope)', ['client'], (a) => visible(a, 'measurements')],
    ['client food_logs (no scope)', ['client'], (a) => visible(a, 'food_logs')],
    ['client account_state', ['client'], (a) => visible(a, 'account_state')],
    ['relationship row', ['client', 'coach'], (a) => rowsCan(a, `select id from public.coaching_relationships where id = $1`, [matrixRel])],
    ['coach_client_overview', ['coach'], (a) => rpcCan(a, 'coach_client_overview', { p_id: matrixRel })],
    ['messages (table)', ['client', 'coach'], (a) => rowsCan(a, `select id from public.coach_messages where relationship_id = $1`, [matrixRel])],
    ['list_coach_messages', ['client', 'coach'], (a) => rpcCan(a, 'list_coach_messages', { p_relationship: matrixRel })],
    ['chat media (sign)', ['client', 'coach'], (a) => rowsCan(a, `select id from storage.objects where bucket_id = 'coach-media' and name = $1`, [mpath()])],
    ['check-ins (table)', ['client', 'coach'], (a) => rowsCan(a, `select id from public.coach_checkins where relationship_id = $1`, [matrixRel])],
    ['client notifications', ['client'], (a) => rowsCan(a, `select id from public.notifications where recipient_id = $1`, [A.client])],
    ['qualification document', ['coach', 'cadmin'], (a) => rowsCan(a, `select id from storage.objects where bucket_id = 'coach-docs' and name = $1`, [docPath])],
    ['pending application row', ['pending', 'cadmin'], (a) => rowsCan(a, `select user_id from public.coach_profiles where user_id = $1`, [A.pending])],
    ['admin application queue', ['cadmin'], (a) => rpcCan(a, 'admin_list_coach_applications', {})],
    ['coaching reports', ['cadmin'], (a) => rpcCan(a, 'admin_list_coaching_reports', {})],
  ];
  const matrix = [];
  for (const [label, allowed, probe] of resources) {
    const row = { label, cells: [] };
    for (const a of ALL) {
      const can = await probe(a);
      const want = allowed.includes(a);
      row.cells.push({ allowed: can, want });
      results.push({ area: 'coach matrix', name: `${label} — ${a} ${want ? 'CAN' : 'CANNOT'} read`, ok: can === want,
        err: can === want ? undefined : `${a}: expected ${want ? 'access' : 'no access'}, got ${can ? 'access' : 'no access'}` });
    }
    matrix.push(row);
  }

  /* ============================================================ cleanup / deletion */
  await test('coaching', 'deleting a client account cascades relationships, messages, scopes and coaching notifications', async () => {
    await admin.query(`delete from auth.users where id = $1`, [A.client3]);
    eq(await adminCount(`select count(*) n from public.coaching_relationships where id = $1`, [REL3]), 0, 'relationship');
    eq(await adminCount(`select count(*) n from public.coach_messages where relationship_id = $1`, [REL3]), 0, 'messages');
    eq(await adminCount(`select count(*) n from public.coaching_scopes where relationship_id = $1`, [REL3]), 0, 'scopes');
    eq(await adminCount(`select count(*) n from public.notifications where relationship_id = $1`, [REL3]), 0, 'notifications');
  });
  await test('coaching', 'service-only coaching RPCs are not callable by clients', async () => {
    fails(await R('client', 'coach_media_pending', { p_message: MM, p_user: A.client }), 'pending');
    fails(await R('client', 'finalize_coach_message', { p_message: MM, p_user: A.client, p_media: [] }), 'finalize');
    fails(await R('anon', 'my_roles'), 'anon');
  });

  return { matrix, actors: ALL.map((a) => [a, a]) };
}
