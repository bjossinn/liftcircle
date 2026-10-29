/**
 * Backend audit checks (repair brief 2026-10-29 §7) for `npm run test:rls`, run after the social and coaching
 * suites. Own actors (fresh uuids) so nothing depends on, or disturbs, the fixtures of the other suites.
 *
 * Areas:
 *   audit social    — full social journey at DB/storage level (share a finished workout, photo path rules, feed
 *                     card, like/comment, idempotent retries, edit, Friends → Only me, pagination, delete, block,
 *                     report/moderation) and "a private workout is never auto-published".
 *   audit coaching  — multiple pending requests (old request vs newer coach), concurrent acceptance (lock order),
 *                     pending vs active + consent edits, former coach + queued photo messages, suspended coach and
 *                     chat media with an open session.
 *   audit exercises — custom exercises: private catalogs stay private; what a proposal carries.
 *   audit programs  — coach vs AI proposals on the same plan (stale rejected both ways, coach-review target).
 *   audit export    — export_my_data includes own coaching (client + coach side) and AI data, nothing foreign.
 *   audit deletion  — deleting a coach account cascades coaching rows; client records intact.
 *
 * h: the helpers of run.mjs + `connect()` (extra `postgres` connections for concurrency checks).
 */
import { randomUUID } from 'node:crypto';

export async function auditTests(h) {
  const { test, rpc, as, admin, ok, fails, eq, assert, count, adminCount, connect } = h;

  const A = {
    mem: randomUUID(), // member / client: shares workouts, coached by coachA → coachB
    fr: randomUUID(), // accepted social friend of mem
    str: randomUUID(), // stranger
    mod: randomUUID(), // moderator
    adm: randomUUID(), // admin (coach applications)
    coachA: randomUUID(), // approved coach
    coachB: randomUUID(), // approved coach
    coachD: randomUUID(), // approved coach, suspended later, account deleted at the end
    appl: randomUUID(), // applicant (submitted, never approved)
    c2: randomUUID(), // client for the concurrent-acceptance check
    c3: randomUUID(), // client for the stale-request check
    c4: randomUUID(), // client of coachD
  };
  for (const [name, id] of Object.entries(A)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `au_${name}@example.test`]);
  }
  await admin.query(`insert into public.app_roles (user_id, role) values ($1, 'moderator'), ($2, 'admin')`, [A.mod, A.adm]);
  const R = (actor, fn, args) => rpc(actor === 'anon' || actor === 'service' ? actor : A[actor] ?? actor, fn, args);
  const Q = (actor, sql, params) => as(actor === 'anon' || actor === 'service' ? actor : A[actor] ?? actor, sql, params);
  const C = (actor, sql, params) => count(actor === 'anon' ? 'anon' : A[actor] ?? actor, sql, params);
  const put = (actor, bucket, name, mime = 'image/jpeg') =>
    Q(actor, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4::jsonb) returning id`,
      [bucket, name, A[actor] ?? null, JSON.stringify({ size: 1000, mimetype: mime })]);
  const see = async (actor, bucket, name) => (await Q(actor, `select id from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rows.length > 0;
  const status = async (rel) => (await admin.query(`select status from public.coaching_relationships where id = $1`, [rel])).rows[0]?.status;
  const ts = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  let relMem; // mem ↔ current coach (coachA)
  let relD; // c4 ↔ coachD

  await test('audit', 'fixtures: profiles, friendship mem↔fr, approved coaches A/B/D, submitted applicant', async () => {
    for (const name of Object.keys(A)) ok(await R(name, 'save_my_profile', { p_username: `au_${name.toLowerCase()}`, p_display_name: `Au ${name}` }), name);
    const f = ok(await R('fr', 'send_friend_request', { p_target: A.mem }), 'fr→mem').id;
    ok(await R('mem', 'respond_friend_request', { p_request_id: f, p_accept: true }), 'accept');
    const prof = (displayName) => ({
      displayName, bio: 'Strength coach with years of experience helping busy people get stronger and fitter.',
      experience: '8 years', experienceYears: 8, specialties: ['strength'], goals: ['build_strength'], languages: ['en'],
      city: 'Reykjavík', region: null, country: 'IS', formats: ['online', 'in_person'], acceptingClients: true, listed: true,
      serviceAreas: [{ kind: 'city', city: 'Reykjavík', country: 'IS' }], qualifications: [],
    });
    for (const c of ['coachA', 'coachB', 'coachD', 'appl']) {
      ok(await R(c, 'save_my_coach_profile', { p: prof(`Coach ${c}`) }), `${c} save`);
      ok(await R(c, 'submit_coach_application'), `${c} submit`);
      if (c !== 'appl') ok(await R('adm', 'admin_review_coach', { p_coach: A[c], p_action: 'approve' }), `${c} approve`);
    }
  });

  /* ================================================================ social journey */
  const W = randomUUID();
  const session = (id, name = 'Lower A') => ({
    id, name, status: 'completed', date: today, timeZone: 'UTC', startedAt: ts - 3600e3, endedAt: ts, pausedTotalMs: 0, createdAt: ts, updatedAt: ts,
    exercises: [{ id: 'e1', exerciseId: 'barbell-back-squat', order: 0, sets: [{ id: 's1', type: 'normal', weightKg: 100, reps: 5, completed: true, completedAt: ts }] }],
  });
  await test('audit social', 'finishing (syncing) a private workout never creates or publishes a post', async () => {
    eq(ok(await R('mem', 'sync_push', { p_entity: 'sessions', p_id: W, p_op: 'upsert', p_base_version: null, p_payload: session(W) }), 'push').status, 'ok', 'push');
    eq(await adminCount(`select count(*) n from public.posts where author_id = $1`, [A.mem]), 0, 'posts by mem');
    eq(ok(await R('fr', 'get_feed', { p_limit: 50 }), 'feed').items.filter((p) => p.author_id === A.mem).length, 0, 'friend feed');
    eq(await C('fr', `select * from public.workout_sessions where owner_id = $1`, [A.mem]), 0, 'friend cannot read the workout itself');
  });

  const P = randomUUID();
  const MD = randomUUID();
  const img = `${A.mem}/${P}/${MD}.jpg`;
  const thumb = `${A.mem}/${P}/${MD}_thumb.jpg`;
  const snap = { title: 'Lower A', kind: 'workout', date: today, durationSec: 3600, exercises: [{ name: 'Back squat', topSet: '100 kg × 5' }] };
  const draftArgs = { p_id: P, p_kind: 'workout', p_audience: 'friends', p_caption: 'Leg day', p_snapshot: snap,
    p_media: [{ id: MD, position: 0, width: 1200, height: 900, description: 'Squat lockout' }] };
  await test('audit social', 'share: draft under the chosen audience; photo upload path rules (exact {owner}/{post}/{media}[_thumb].jpg only)', async () => {
    eq(ok(await R('mem', 'create_post_draft', draftArgs), 'draft').status, 'draft', 'draft');
    for (const bad of [`${A.mem}/${P}/${MD}.png`, `${A.mem}/${P}/${MD}_thumb2.jpg`, `${A.mem}/${P}/x/${MD}.jpg`,
      `${A.mem}/${P}/../${randomUUID()}/${MD}.jpg`, `${A.mem}/${P}/${randomUUID()}.jpg`, `${A.mem}/${randomUUID()}/${MD}.jpg`]) {
      fails(await put('mem', 'post-media', bad), `bad path ${bad.slice(37)}`);
    }
    fails(await put('fr', 'post-media', img), 'friend uploads into the author’s draft');
    ok(await put('mem', 'post-media', thumb), 'thumb');
    ok(await put('mem', 'post-media', img), 'image');
    assert(!(await see('fr', 'post-media', img)), 'draft media not signable by the friend');
  });
  await test('audit social', 'publish (finalize-post service step) is idempotent; feed card has the shared summary, media paths and counts', async () => {
    eq(ok(await R('service', 'finalize_post_publish', { p_post_id: P, p_user_id: A.mem, p_media: [{ id: MD, width: 1200, height: 900 }] }), 'publish').already, false, 'first');
    eq(ok(await R('service', 'finalize_post_publish', { p_post_id: P, p_user_id: A.mem, p_media: [] }), 'retry').already, true, 'retry');
    eq(ok(await R('mem', 'create_post_draft', draftArgs), 'client retry').status, 'published', 'client retry after publish is a no-op');
    eq(await adminCount(`select count(*) n from public.posts where author_id = $1`, [A.mem]), 1, 'exactly one post');
    const card = ok(await R('fr', 'get_feed', { p_limit: 10 }), 'feed').items.find((p) => p.id === P);
    assert(card, 'friend sees the post');
    eq([card.kind, card.audience, card.caption, card.snapshot.title, card.author.username, card.media.map((m) => [m.image_path, m.thumb_path, m.status]), card.like_count, card.comment_count],
      ['workout', 'friends', 'Leg day', 'Lower A', 'au_mem', [[img, thumb, 'ready']], 0, 0], 'card');
    assert(!JSON.stringify(card).includes('weightKg') && !('session_id' in card), 'card carries only the shared summary');
    assert(await see('fr', 'post-media', img) && await see('fr', 'post-media', thumb), 'friend can sign image + thumb');
    assert(!(await see('str', 'post-media', img)), 'stranger cannot sign');
    assert(!ok(await R('str', 'get_feed', { p_limit: 50 }), 'str feed').items.some((p) => p.id === P), 'not in stranger feed');
    eq(ok(await R('str', 'get_post', { p_post_id: P }), 'str get'), null, 'stranger get_post');
    fails(await R('anon', 'get_feed', {}), 'anon feed');
    eq((await Q('mem', `update storage.objects set metadata = '{"size":1}' where bucket_id = 'post-media' and name = $1`, [img])).rowCount, 0, 'no overwrite after publish');
  });
  const CM = randomUUID();
  await test('audit social', 'like + comment retries: one like, one comment, one notification each; stranger cannot interact', async () => {
    await admin.query(`delete from public.notifications where recipient_id = $1`, [A.mem]);
    for (let i = 0; i < 3; i++) ok(await R('fr', 'like_post', { p_post_id: P }), `like ${i}`);
    for (let i = 0; i < 3; i++) ok(await R('fr', 'add_comment', { p_post_id: P, p_id: CM, p_body: 'Deep squats!' }), `comment ${i}`);
    eq(await adminCount(`select count(*) n from public.likes where post_id = $1`, [P]), 1, 'likes');
    eq(await adminCount(`select count(*) n from public.comments where post_id = $1`, [P]), 1, 'comments');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'like'`, [A.mem]), 1, 'like notifications');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id = $1 and type = 'comment'`, [A.mem]), 1, 'comment notifications');
    fails(await R('str', 'like_post', { p_post_id: P }), 'stranger like', /not found/);
    fails(await R('str', 'add_comment', { p_post_id: P, p_id: randomUUID(), p_body: 'hi' }), 'stranger comment', /not found/);
    fails(await R('str', 'add_comment', { p_post_id: P, p_id: CM, p_body: 'hijack' }), 'stranger reuses comment id', /in use/);
    const post = ok(await R('fr', 'get_post', { p_post_id: P }), 'get');
    eq([post.like_count, post.comment_count, post.liked_by_me], [1, 1, true], 'counts');
  });
  await test('audit social', 'edit caption (author only) → friend sees the edit; Friends → Only me hides post, comments (even own), likes, media rows, image + thumb, profile list', async () => {
    fails(await R('fr', 'update_post', { p_post_id: P, p_audience: 'only_me' }), 'friend cannot change audience', /not found/);
    ok(await R('mem', 'update_post', { p_post_id: P, p_caption: 'Leg day (edited)' }), 'edit');
    const e = ok(await R('fr', 'get_post', { p_post_id: P }), 'get');
    assert(e.caption === 'Leg day (edited)' && e.edited_at, 'edit visible + marked');
    ok(await R('mem', 'update_post', { p_post_id: P, p_audience: 'only_me' }), 'only me');
    eq(ok(await R('fr', 'get_post', { p_post_id: P }), 'get'), null, 'get_post');
    eq(await C('fr', `select * from public.posts where id = $1`, [P]), 0, 'row');
    eq(await C('fr', `select * from public.comments where post_id = $1`, [P]), 0, 'comments incl. own');
    eq(ok(await R('fr', 'list_comments', { p_post_id: P }), 'list'), [], 'list_comments');
    eq(await C('fr', `select * from public.likes where post_id = $1`, [P]), 0, 'likes');
    eq(await C('fr', `select * from public.post_media where post_id = $1`, [P]), 0, 'media rows');
    assert(!(await see('fr', 'post-media', img)) && !(await see('fr', 'post-media', thumb)), 'image + thumb no longer signable');
    eq(ok(await R('fr', 'get_user_posts', { p_user_id: A.mem }), 'profile list').items.length, 0, 'get_user_posts');
    fails(await R('fr', 'add_comment', { p_post_id: P, p_id: randomUUID(), p_body: 'still here?' }), 'new comment');
    fails(await R('fr', 'like_post', { p_post_id: P }), 'like');
    assert(await see('mem', 'post-media', img), 'author still signs own media');
    eq(ok(await R('mem', 'list_comments', { p_post_id: P }), 'author list').length, 1, 'author still sees the comment');
    ok(await R('mem', 'update_post', { p_post_id: P, p_audience: 'friends' }), 'back to friends');
    assert(await see('fr', 'post-media', thumb), 'restored for the friend');
  });
  await test('audit social', 'profile post list: keyset pagination, no repeats; Only-me posts never listed for the friend', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      ids.push(id);
      ok(await R('mem', 'create_post_draft', { p_id: id, p_kind: 'text', p_audience: i === 1 ? 'only_me' : 'friends', p_caption: `p${i}` }), 'draft');
      ok(await R('service', 'finalize_post_publish', { p_post_id: id, p_user_id: A.mem, p_media: [] }), 'publish');
    }
    const seen = [];
    let cur = null;
    for (let i = 0; i < 10; i++) {
      const r = ok(await R('fr', 'get_user_posts', { p_user_id: A.mem, p_cursor_created_at: cur?.created_at ?? null, p_cursor_id: cur?.id ?? null, p_limit: 2 }), 'page');
      seen.push(...r.items.map((p) => p.id));
      cur = r.next;
      if (!cur) break;
    }
    eq(seen.length, new Set(seen).size, 'no repeats');
    eq([...seen].sort(), [P, ids[0], ids[2], ids[3]].sort(), 'friend list (no only-me)');
    for (const id of ids) ok(await R('mem', 'delete_post', { p_post_id: id }), 'cleanup');
  });
  await test('audit social', 'report + moderation of a comment; stranger cannot report what they cannot see', async () => {
    fails(await R('str', 'report_content', { p_comment_id: CM, p_reason: 'spam' }), 'stranger', /not found/);
    ok(await R('mem', 'report_content', { p_comment_id: CM, p_reason: 'inappropriate' }), 'author reports');
    fails(await R('fr', 'list_reports'), 'non-moderator list', /moderators/);
    const rep = ok(await R('mod', 'list_reports', { p_status: 'open' }), 'mod list').find((x) => x.target_kind === 'comment' && x.content?.body === 'Deep squats!');
    assert(rep, 'moderator sees the reported comment text');
    eq(await C('mod', `select * from public.workout_sessions where owner_id = $1`, [A.mem]), 0, 'moderator has no private-record access');
    ok(await R('mod', 'resolve_report', { p_report_id: rep.id, p_action: 'remove_content' }), 'remove');
    eq(ok(await R('mem', 'list_comments', { p_post_id: P }), 'list'), [], 'comment removed');
    fails(await R('fr', 'add_comment', { p_post_id: P, p_id: CM, p_body: 'Deep squats!' }), 'retry cannot resurrect', /deleted/);
  });
  await test('audit social', 'block hides everything both ways; delete is final (rows, media, retries)', async () => {
    ok(await R('mem', 'block_user', { p_other: A.fr }), 'block');
    eq(ok(await R('fr', 'get_post', { p_post_id: P }), 'get'), null, 'blocked get');
    assert(!(await see('fr', 'post-media', img)), 'blocked sign');
    ok(await R('mem', 'unblock_user', { p_other: A.fr }), 'unblock');
    eq(ok(await R('fr', 'get_post', { p_post_id: P }), 'get'), null, 'unblock does not restore friendship');
    const f = ok(await R('fr', 'send_friend_request', { p_target: A.mem }), 're-friend').id;
    ok(await R('mem', 'respond_friend_request', { p_request_id: f, p_accept: true }), 'accept');
    assert(ok(await R('fr', 'get_post', { p_post_id: P }), 'get'), 'visible again after re-friending');
    ok(await R('mem', 'delete_post', { p_post_id: P }), 'delete');
    ok(await R('mem', 'delete_post', { p_post_id: P }), 'delete retry');
    eq(ok(await R('fr', 'get_post', { p_post_id: P }), 'get'), null, 'gone');
    assert(!(await see('fr', 'post-media', img)) && !(await see('mem', 'post-media', img)), 'media not signable by anyone');
    fails(await R('mem', 'create_post_draft', draftArgs), 'no resurrection by retry', /deleted/);
    fails(await R('fr', 'like_post', { p_post_id: P }), 'like deleted');
    eq(await adminCount(`select count(*) n from public.notifications where post_id = $1`, [P]), 0, 'notifications removed');
  });

  /* ================================================================ coaching: multiple requests */
  const req = (client, id, coach, scopes = { training: true }) =>
    R(client, 'request_coaching', { p_id: id, p_coach: A[coach], p_intake: { goal: 'strength' }, p_message: `Hi ${coach}`, p_scopes: scopes });
  const RA = randomUUID();
  const RB = randomUUID();
  await test('audit coaching', 'requests to A and B pending; B accepts → A’s request is cancelled, A cannot accept the old request, B stays active', async () => {
    ok(await req('mem', RA, 'coachA'), 'request A');
    ok(await req('mem', RB, 'coachB'), 'request B');
    ok(await R('coachB', 'respond_coaching_request', { p_id: RB, p_accept: true }), 'B accepts');
    eq([await status(RA), await status(RB)], ['cancelled', 'active'], 'after B');
    fails(await R('coachA', 'respond_coaching_request', { p_id: RA, p_accept: true }), 'A accepts the old request', /no longer pending/);
    eq([await status(RA), await status(RB)], ['cancelled', 'active'], 'B not replaced');
    assert(ok(await R('coachA', 'list_notifications'), 'n').some((n) => n.type === 'coach_request_cancelled' && n.relationship_id === RA), 'A told');
    eq(ok(await R('mem', 'request_coaching', { p_id: RA, p_coach: A.coachA, p_intake: {}, p_message: '', p_scopes: {} }), 'retry').status, 'cancelled',
      'retrying the old request id returns it cancelled (no resurrection)');
  });
  await test('audit coaching', 'legacy/raced state: an old pending request that predates the client’s current coach is refused (stale_request), never replaces the coach', async () => {
    // c3: active with coachB since now; an older pending request to coachA exists (as a race or a pre-fix row could leave it)
    const RB3 = randomUUID();
    ok(await req('c3', RB3, 'coachB'), 'request B');
    ok(await R('coachB', 'respond_coaching_request', { p_id: RB3, p_accept: true }), 'B accepts');
    const OLD = randomUUID();
    await admin.query(`insert into public.coaching_relationships (id, coach_id, client_id, status, intro_message, requested_at)
                       values ($1, $2, $3, 'requested', 'old', now() - interval '2 days')`, [OLD, A.coachA, A.c3]);
    await admin.query(`insert into public.coaching_scopes (relationship_id, training) values ($1, true)`, [OLD]);
    const r = await R('coachA', 'respond_coaching_request', { p_id: OLD, p_accept: true });
    fails(r, 'accept stale request', /out of date/);
    eq(r.error.hint, 'stale_request', 'hint');
    eq([await status(OLD), await status(RB3)], ['requested', 'active'], 'nothing changed');
    ok(await R('coachA', 'respond_coaching_request', { p_id: OLD, p_accept: false }), 'declining it still works');
    ok(await R('c3', 'end_coaching', { p_id: RB3 }), 'cleanup');
  });
  await test('audit coaching', 'explicit switch still works: a request sent WHILE B is active (client warned) → A accepts → B ended “switched coach”', async () => {
    const RA2 = randomUUID();
    ok(await req('mem', RA2, 'coachA', { training: true, checkins: true }), 'request A while B active');
    eq(await status(RB), 'active', 'B untouched while pending');
    ok(await R('coachA', 'respond_coaching_request', { p_id: RA2, p_accept: true }), 'A accepts');
    eq([await status(RA2), await status(RB)], ['active', 'ended'], 'switched');
    eq((await admin.query(`select end_reason from public.coaching_relationships where id = $1`, [RB])).rows[0].end_reason, 'switched coach', 'reason');
    relMem = RA2;
  });
  await test('audit coaching', 'concurrent acceptance of two pending requests: serialized, exactly one active, no deadlock (40P01)', async () => {
    const X = randomUUID();
    const Y = randomUUID();
    ok(await req('c2', X, 'coachA'), 'request A');
    ok(await req('c2', Y, 'coachB'), 'request B');
    const holder = await connect();
    const c1 = await connect();
    const c2 = await connect();
    try {
      const pid = async (c) => (await c.query('select pg_backend_pid() p')).rows[0].p;
      const p1 = await pid(c1);
      const p2 = await pid(c2);
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtextextended('coach-req:' || $1::text, 0))`, [A.c2]);
      const accept = async (c, coach, rel) => {
        await c.query('begin');
        try {
          await c.query('set local role authenticated');
          await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A[coach], role: 'authenticated' })]);
          await c.query(`select public.respond_coaching_request(p_id => $1, p_accept => true)`, [rel]);
          await c.query('commit');
          return { ok: true };
        } catch (e) {
          await c.query('rollback').catch(() => {});
          return { ok: false, code: e.code, message: e.message };
        }
      };
      const t1 = accept(c1, 'coachA', X);
      await new Promise((r) => setTimeout(r, 150));
      const t2 = accept(c2, 'coachB', Y);
      for (let i = 0; i < 50; i++) {
        const w = await admin.query(`select count(*)::int n from pg_stat_activity where pid = any($1) and wait_event_type = 'Lock'`, [[p1, p2]]);
        if (w.rows[0].n === 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query('commit');
      const [r1, r2] = await Promise.all([t1, t2]);
      const res = [r1, r2];
      assert(!res.some((x) => x.code === '40P01'), `deadlock: ${JSON.stringify(res)}`);
      eq(res.filter((x) => x.ok).length, 1, `exactly one acceptance succeeds (${JSON.stringify(res)})`);
      assert(res.some((x) => !x.ok && /no longer pending/.test(x.message)), 'the other is told the request is gone');
      eq(await adminCount(`select count(*) n from public.coaching_relationships where client_id = $1 and status = 'active'`, [A.c2]), 1, 'one active');
      eq(await adminCount(`select count(*) n from public.coaching_relationships where client_id = $1 and status = 'requested'`, [A.c2]), 0, 'none left pending');
    } finally {
      await holder.query('rollback').catch(() => {});
      for (const c of [holder, c1, c2]) await c.end().catch(() => {});
    }
  });

  /* ================================================================ consent, former coach, queued ops */
  const PR = randomUUID();
  const MS = randomUUID();
  const program = (cur, managed) => ({ id: PR, name: 'My plan', source: 'manual', startDate: '2026-09-01', active: true, currentVersion: cur,
    managedBy: managed ? { kind: managed } : undefined, rotationIndex: 0, overrides: [], createdAt: ts, updatedAt: ts + cur,
    versions: Array.from({ length: cur }, (_, i) => ({ version: i + 1, createdAt: ts, reason: `v${i + 1}`, weeks: 8, reviewWeek: 4, rationale: [], warnings: [],
      templates: [{ id: 't1', name: 'Full body', focus: 'Full', kind: 'strength', estimatedMinutes: 60,
        exercises: [{ id: 'x1', exerciseId: 'barbell-back-squat', sets: 3, repMin: 5, repMax: 8, targetRir: 2, restSec: 180, warmup: '', priority: 1, alternatives: [] }] }],
      schedule: [{ weekday: 1, templateId: 't1' }] })) });
  let progV;
  await test('audit coaching', 'pending request grants nothing even with scopes on; scope edits while pending are what the coach gets on acceptance', async () => {
    progV = ok(await R('mem', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: null, p_payload: program(1) }), 'program').version;
    ok(await R('mem', 'sync_push', { p_entity: 'measurements', p_id: MS, p_op: 'upsert', p_base_version: null, p_payload: { id: MS, kind: 'bodyweight', date: today, value: 81 } }), 'measurement');
    ok(await R('c4', 'sync_push', { p_entity: 'measurements', p_id: MS, p_op: 'upsert', p_base_version: null, p_payload: { id: MS, kind: 'bodyweight', date: today, value: 70 } }), 'c4 measurement');
    ok(await R('c4', 'sync_push', { p_entity: 'sessions', p_id: W, p_op: 'upsert', p_base_version: null, p_payload: session(W, 'C4 workout') }), 'c4 session');
    const RD = randomUUID();
    ok(await req('c4', RD, 'coachD', { training: true, measurements: true, nutrition: true, checkins: true }), 'request with everything');
    eq(await C('coachD', `select * from public.measurements where owner_id = $1`, [A.c4]), 0, 'pending: measurements');
    eq(await C('coachD', `select * from public.workout_sessions where owner_id = $1`, [A.c4]), 0, 'pending: workouts');
    ok(await R('c4', 'set_coaching_scopes', { p_id: RD, p_scopes: { training: true, measurements: false, checkins: true } }), 'narrow while pending');
    ok(await R('coachD', 'respond_coaching_request', { p_id: RD, p_accept: true }), 'accept');
    assert((await C('coachD', `select * from public.workout_sessions where owner_id = $1`, [A.c4])) > 0, 'training visible');
    eq(await C('coachD', `select * from public.measurements where owner_id = $1`, [A.c4]), 0, 'measurements (revoked while pending) not visible');
    relD = RD;
  });
  await test('audit coaching', 'former coach (after the switch): read-only history, no records; queued photo messages can no longer be uploaded or finalized', async () => {
    // build state: a fresh relationship mem ↔ coachB with photo messages queued on both sides, then mem switches back to A
    const RB2 = randomUUID();
    ok(await req('mem', RB2, 'coachB'), 'request B again');
    ok(await R('coachB', 'respond_coaching_request', { p_id: RB2, p_accept: true }), 'B accepts (A ended)');
    eq(await status(relMem), 'ended', 'A ended by the switch');
    const MB = randomUUID();
    const MBM = randomUUID();
    const MC = randomUUID();
    const MCM = randomUUID();
    ok(await R('coachB', 'send_coach_message', { p_id: MB, p_relationship: RB2, p_body: 'form check', p_media: [{ id: MBM }] }), 'coach photo msg (awaiting)');
    ok(await R('mem', 'send_coach_message', { p_id: MC, p_relationship: RB2, p_body: '', p_media: [{ id: MCM }] }), 'client photo msg (awaiting)');
    ok(await R('mem', 'send_coach_message', { p_id: randomUUID(), p_relationship: RB2, p_body: 'hello' }), 'text');
    // client switches back to A: B becomes the former coach while both uploads are still queued
    const RA3 = randomUUID();
    ok(await req('mem', RA3, 'coachA', { training: true, checkins: true }), 'request A');
    ok(await R('coachA', 'respond_coaching_request', { p_id: RA3, p_accept: true }), 'A accepts');
    relMem = RA3;
    eq(await status(RB2), 'ended', 'B ended');
    fails(await put('coachB', 'coach-media', `${RB2}/${MB}/${MBM}.jpg`), 'former coach upload');
    fails(await put('mem', 'coach-media', `${RB2}/${MC}/${MCM}.jpg`), 'client upload into ended conversation');
    fails(await R('service', 'coach_media_pending', { p_message: MB, p_user: A.coachB }), 'pending check', /read-only/);
    fails(await R('service', 'finalize_coach_message', { p_message: MC, p_user: A.mem, p_media: [{ id: MCM, width: 10, height: 10 }] }), 'finalize', /read-only/);
    fails(await R('coachB', 'send_coach_message', { p_id: randomUUID(), p_relationship: RB2, p_body: 'queued text' }), 'queued text', /read-only/);
    const retry = ok(await R('mem', 'send_coach_message', { p_id: MC, p_relationship: RB2, p_body: '', p_media: [{ id: MCM }] }), 'retry of the stored message id');
    eq(retry.status, 'awaiting_media', 'a retry returns the stored row, never sends it');
    eq(await C('coachB', `select * from public.workout_sessions where owner_id = $1`, [A.mem]), 0, 'former coach: no records');
    const fo = await R('coachB', 'coach_client_overview', { p_id: RB2 });
    assert(fo.error || [fo.value.training, fo.value.measurements, fo.value.nutrition, fo.value.checkins].every((x) => x === null), 'former coach overview has no data panels');
    const hist = ok(await R('coachB', 'list_coach_messages', { p_relationship: RB2 }), 'history');
    eq(hist.map((m) => m.body).filter((b) => b === 'hello').length, 1, 'read-only history kept');
    assert(!hist.some((m) => m.id === MC), 'the client’s never-finalized photo message is not shown to the coach');
    eq(await adminCount(`select count(*) n from public.notifications where relationship_id = $1 and type = 'coach_message' and recipient_id = $2`, [RB2, A.coachB]), 1, 'one collapsed message notification, no text');
  });
  await test('audit coaching', 'suspended coach with an open session: chat media and history unreadable at once; client keeps both; reinstate restores', async () => {
    const MM = randomUUID();
    const MMM = randomUUID();
    ok(await R('c4', 'send_coach_message', { p_id: MM, p_relationship: relD, p_body: 'pic', p_media: [{ id: MMM }] }), 'send');
    ok(await put('c4', 'coach-media', `${relD}/${MM}/${MMM}.jpg`), 'upload');
    ok(await R('service', 'finalize_coach_message', { p_message: MM, p_user: A.c4, p_media: [{ id: MMM, width: 10, height: 10 }] }), 'finalize');
    assert(await see('coachD', 'coach-media', `${relD}/${MM}/${MMM}.jpg`), 'coach signs before suspension');
    ok(await R('adm', 'admin_review_coach', { p_coach: A.coachD, p_action: 'suspend', p_reason: 'audit' }), 'suspend');
    assert(!(await see('coachD', 'coach-media', `${relD}/${MM}/${MMM}.jpg`)), 'no sign after suspension');
    fails(await R('coachD', 'list_coach_messages', { p_relationship: relD }), 'no history');
    eq(await C('coachD', `select * from public.workout_sessions where owner_id = $1`, [A.c4]), 0, 'no records');
    fails(await R('coachD', 'respond_coaching_request', { p_id: relD, p_accept: true }), 'no actions', /isn't active/);
    assert(await see('c4', 'coach-media', `${relD}/${MM}/${MMM}.jpg`), 'client keeps media');
    ok(await R('adm', 'admin_review_coach', { p_coach: A.coachD, p_action: 'reinstate', p_reason: 'ok' }), 'reinstate');
    assert(await see('coachD', 'coach-media', `${relD}/${MM}/${MMM}.jpg`), 'restored');
  });
  await test('audit coaching', 'applicant (submitted, not approved): not searchable, cannot be requested, reads nothing; anon cannot use coaching RPCs', async () => {
    assert(!ok(await R('str', 'search_coaches', { p: {} }), 's').items.some((c) => c.user_id === A.appl), 'not listed');
    fails(await R('str', 'request_coaching', { p_id: randomUUID(), p_coach: A.appl, p_intake: {}, p_message: '', p_scopes: {} }), 'request', /isn't available/);
    for (const t of ['workout_sessions', 'measurements', 'coach_messages', 'coaching_relationships']) {
      eq(await C('appl', `select * from public.${t} where ${t === 'coach_messages' ? 'sender_id' : t === 'coaching_relationships' ? 'client_id' : 'owner_id'} = $1`, [A.mem]), 0, t);
    }
    for (const fn of ['search_coaches', 'my_coaching_relationships', 'export_my_data']) fails(await R('anon', fn, fn === 'search_coaches' ? { p: {} } : {}), `anon ${fn}`);
  });

  /* ================================================================ custom exercises */
  const CX = randomUUID();
  const CXB = randomUUID();
  await test('audit exercises', 'custom exercise catalogs stay private: active coach (training scope) cannot read the client’s, client cannot read the coach’s', async () => {
    ok(await R('mem', 'sync_push', { p_entity: 'custom_exercises', p_id: CX, p_op: 'upsert', p_base_version: null, p_payload: { id: CX, name: 'Secret sled drag', tracking: 'reps' } }), 'client custom');
    ok(await R('coachA', 'sync_push', { p_entity: 'custom_exercises', p_id: CXB, p_op: 'upsert', p_base_version: null, p_payload: { id: CXB, name: 'Coach landmine twist', tracking: 'reps' } }), 'coach custom');
    eq(await C('coachA', `select * from public.custom_exercises where owner_id = $1`, [A.mem]), 0, 'coach reads client catalog');
    eq(await C('mem', `select * from public.custom_exercises where owner_id = $1`, [A.coachA]), 0, 'client reads coach catalog');
    for (const a of ['fr', 'str', 'adm', 'mod']) eq(await C(a, `select * from public.custom_exercises where owner_id = $1`, [A.mem]), 0, `${a}`);
    const o = ok(await R('coachA', 'coach_client_overview', { p_id: relMem }), 'overview');
    assert(o.training && !JSON.stringify(o).includes('Secret sled drag'), 'overview carries no custom definitions');
  });
  await test('audit exercises', 'a coach proposal carries exercise ids only: catalog ids pass, unknown slugs are refused, uuid-shaped (custom) ids are stored without definitions', async () => {
    const base = program(1).versions[0];
    const prop = (exerciseId) => ({ ...base, name: 'Coach plan', version: undefined, createdAt: undefined,
      templates: [{ ...base.templates[0], exercises: [{ ...base.templates[0].exercises[0], exerciseId }] }] });
    fails(await R('coachA', 'save_program_proposal', { p: { id: randomUUID(), relationshipId: relMem, program: prop('made-up-lift') } }), 'unknown slug', /Unknown exercise/);
    const id = randomUUID();
    const d = ok(await R('coachA', 'save_program_proposal', { p: { id, relationshipId: relMem, program: prop(CXB) } }), 'uuid id accepted');
    eq(d.program.templates[0].exercises[0].exerciseId, CXB, 'id stored as sent');
    assert(!JSON.stringify(d).includes('Coach landmine twist'), 'no definition travels with the proposal');
    ok(await R('coachA', 'withdraw_program_proposal', { p_id: id }), 'withdraw');
  });
  await test('audit programs', 'a coach draft withdrawn without ever being sent stays invisible to the client (ending/switching withdraws drafts the same way)', async () => {
    const base = program(1).versions[0];
    const id = randomUUID();
    ok(await R('coachA', 'save_program_proposal', { p: { id, relationshipId: relMem, program: { ...base, name: 'Private coach notes plan' } } }), 'draft');
    ok(await R('coachA', 'withdraw_program_proposal', { p_id: id }), 'withdraw unsent draft');
    eq(ok(await R('mem', 'get_program_proposal', { p_id: id }), 'get'), null, 'get_program_proposal');
    assert(!ok(await R('mem', 'list_program_proposals', { p: { mine: true } }), 'list').some((p) => p.id === id), 'list_program_proposals');
    eq(await C('mem', `select * from public.program_proposals where id = $1`, [id]), 0, 'direct select');
    // sent then withdrawn: the client saw it already, so it stays readable (as withdrawn)
    const sent = randomUUID();
    ok(await R('coachA', 'save_program_proposal', { p: { id: sent, relationshipId: relMem, program: { ...base, name: 'Sent plan' } } }), 'draft 2');
    ok(await R('coachA', 'send_program_proposal', { p_id: sent }), 'send');
    ok(await R('coachA', 'withdraw_program_proposal', { p_id: sent }), 'withdraw sent');
    eq(ok(await R('mem', 'get_program_proposal', { p_id: sent }), 'get sent').status, 'withdrawn', 'sent + withdrawn stays visible');
  });

  /* ================================================================ AI vs human proposals */
  const aiExchange = async (user, content, proposal) => {
    const r = await Q('service', `select public.ai_record_exchange($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb) v`, [user,
      JSON.stringify({ id: randomUUID(), content, mode: 'chat' }),
      JSON.stringify({ content: `reply: ${content}`, grounding: [], model: 'mock', inputTokens: 100, outputTokens: 50 }),
      proposal ? JSON.stringify(proposal) : null, JSON.stringify({ inputTokens: 100, outputTokens: 50 })]);
    return ok(r, 'ai exchange')[0].v;
  };
  const aiProgram = { name: 'AI plan', templates: [{ id: 't1', name: 'Full body', exercises: [] }], schedule: [], weeks: 4, reviewWeek: 4, rationale: [], warnings: [], reason: 'AI' };
  await test('audit programs', 'coach and AI proposals on the same base: whichever is applied first makes the other stale (both directions)', async () => {
    const base = program(1).versions[0];
    const coachProg = { ...base, name: 'Coach plan', version: undefined, createdAt: undefined };
    const CP1 = randomUUID();
    ok(await R('coachA', 'save_program_proposal', { p: { id: CP1, relationshipId: relMem, baseProgramId: PR, baseVersion: 1, program: coachProg } }), 'coach draft v1');
    ok(await R('coachA', 'send_program_proposal', { p_id: CP1 }), 'send');
    const ai1 = await aiExchange(A.mem, 'make it harder', { baseProgramId: PR, baseVersion: 1, program: aiProgram, changeSummary: ['x'], target: 'apply', validationErrors: [] });
    // client applies the AI suggestion as v2 and syncs it
    ok(await R('mem', 'respond_ai_proposal', { p_id: ai1.proposal.id, p_accept: true, p_program_id: PR, p_version: 2 }), 'accept AI');
    progV = ok(await R('mem', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: progV, p_payload: program(2, 'ai') }), 'sync v2').version;
    fails(await R('mem', 'respond_program_proposal', { p_id: CP1, p_accept: true, p_program_id: PR, p_version: 3 }), 'stale coach proposal', /stale/);
    // coach rebases on v2; client accepts (v3, coach-managed)
    const CP2 = randomUUID();
    ok(await R('coachA', 'save_program_proposal', { p: { id: CP2, relationshipId: relMem, baseProgramId: PR, baseVersion: 2, program: coachProg } }), 'coach draft v2');
    ok(await R('coachA', 'send_program_proposal', { p_id: CP2 }), 'send');
    const ai2 = await aiExchange(A.mem, 'another tweak', { baseProgramId: PR, baseVersion: 2, program: aiProgram, changeSummary: ['y'], target: 'apply', validationErrors: [] });
    ok(await R('mem', 'respond_program_proposal', { p_id: CP2, p_accept: true, p_program_id: PR, p_version: 3 }), 'accept coach');
    progV = ok(await R('mem', 'sync_push', { p_entity: 'programs', p_id: PR, p_op: 'upsert', p_base_version: progV, p_payload: program(3, 'coach') }), 'sync v3').version;
    fails(await R('mem', 'respond_ai_proposal', { p_id: ai2.proposal.id, p_accept: true, p_program_id: PR, p_version: 4 }), 'stale AI proposal', /stale|changed/);
    // the ai-coach function marks suggestions on a coach-managed plan for_coach_review → never applicable
    const ai3 = await aiExchange(A.mem, 'on the coach plan', { baseProgramId: PR, baseVersion: 3, program: aiProgram, changeSummary: ['z'], target: 'for_coach_review', validationErrors: [] });
    fails(await R('mem', 'respond_ai_proposal', { p_id: ai3.proposal.id, p_accept: true, p_program_id: PR, p_version: 4 }), 'coach review', /discuss with your coach/);
    const o = ok(await R('coachA', 'coach_client_overview', { p_id: relMem }), 'overview');
    eq([o.training.active_program.current_version, o.training.active_program.managed_by], [3, 'coach'], 'coach sees the plan it manages');
    fails(await R('coachA', 'respond_ai_proposal', { p_id: ai3.proposal.id, p_accept: false }), 'coach cannot answer AI proposals', /not found/i);
    eq(await C('coachA', `select * from public.program_proposals where id = $1`, [ai3.proposal.id]), 0, 'coach cannot read the client’s AI proposals');
  });

  /* ================================================================ export */
  await test('audit export', 'client export: own coaching (relationships + scopes, own messages only, check-ins, received proposals, feedback) and AI data', async () => {
    ok(await R('mem', 'save_ai_settings', { p: { enabled: true, acceptConsent: true, profileNotes: 'audit notes' } }), 'ai settings');
    ok(await R('mem', 'submit_checkin', { p_id: randomUUID(), p_relationship: relMem, p_answers: { energy: 4 }, p_note: 'good week' }), 'check-in');
    ok(await R('mem', 'send_coach_message', { p_id: randomUUID(), p_relationship: relMem, p_body: 'client says hi' }), 'msg');
    ok(await R('coachA', 'send_coach_message', { p_id: randomUUID(), p_relationship: relMem, p_body: 'coach private reply' }), 'coach msg');
    ok(await R('coachA', 'add_coach_feedback', { p_id: randomUUID(), p_relationship: relMem, p_session: W, p_body: 'Nice depth' }), 'feedback');
    const draft = randomUUID();
    ok(await R('coachA', 'save_program_proposal', { p: { id: draft, relationshipId: relMem, baseProgramId: PR, baseVersion: 3, program: { ...program(1).versions[0], name: 'Unsent draft' } } }), 'coach draft');
    const e = ok(await R('mem', 'export_my_data'), 'export');
    eq(e.version, 2, 'format version');
    const c = e.coaching;
    assert(c.relationships_as_client.some((r) => r.id === relMem && r.status === 'active' && r.scopes.training === true && r.intake.goal === 'strength'), 'relationship + scopes + own intake');
    assert(c.relationships_as_client.some((r) => r.id === RA && r.status === 'cancelled'), 'history incl. cancelled');
    assert(c.messages_sent.some((m) => m.body === 'client says hi'), 'own message');
    assert(!JSON.stringify(c).includes('coach private reply'), 'not the coach’s messages');
    assert(c.checkins_submitted.some((k) => k.note === 'good week'), 'check-in');
    assert(c.feedback_received.some((f) => f.body === 'Nice depth'), 'feedback about them');
    assert(c.proposals_received.length >= 2 && !c.proposals_received.some((p) => p.id === draft), 'received proposals, never the coach’s unsent draft');
    eq([c.coach_profile, c.relationships_as_coach.length, c.proposals_authored.length], [null, 0, 0], 'no coach-side data for a client');
    const ai = e.ai;
    assert(ai.settings?.enabled === true && ai.settings.profile_notes === 'audit notes' && !('user_id' in ai.settings), 'ai settings');
    assert(ai.messages.some((m) => m.role === 'user' && m.content === 'make it harder') && ai.messages.some((m) => m.role === 'assistant'), 'ai messages');
    assert(ai.usage.length >= 1 && Number(ai.usage[0].input_tokens) > 0, 'ai usage');
    assert(ai.proposals.length >= 3 && ai.proposals.every((p) => p.authorKind === 'ai' && p.clientId === A.mem), 'ai proposals');
    ok(await R('coachA', 'withdraw_program_proposal', { p_id: draft }), 'cleanup');
  });
  await test('audit export', 'coach export: coach profile + review events, relationships as coach WITHOUT client intake, own messages, authored proposals/feedback — no client records', async () => {
    const e = ok(await R('coachA', 'export_my_data'), 'export');
    const c = e.coaching;
    eq([c.coach_profile?.status, c.coach_review_events.map((x) => x.action)], ['approved', ['submitted', 'approve']], 'profile + events');
    const rel = c.relationships_as_coach.find((r) => r.id === relMem);
    assert(rel && !('intake' in rel) && !('intro_message' in rel), 'no client intake in the coach export');
    assert(c.messages_sent.some((m) => m.body === 'coach private reply') && !c.messages_sent.some((m) => m.body === 'client says hi'), 'own messages only');
    assert(c.proposals_authored.some((p) => p.program?.name === 'Unsent draft'), 'own drafts included');
    assert(c.feedback_written.some((f) => f.body === 'Nice depth'), 'feedback written');
    eq([e.workout_sessions.length, e.measurements.length, e.programs.length], [0, 0, 0], 'no client records in the coach export');
    assert(!JSON.stringify(e).includes('Secret sled drag') && e.custom_exercises.length === 1, 'only own custom exercise');
    eq(e.ai.settings, null, 'no AI settings');
    const s = ok(await R('str', 'export_my_data'), 'stranger export');
    assert(!JSON.stringify(s).includes(relMem) && s.coaching.messages_sent.length === 0 && s.ai.messages.length === 0, 'stranger export has nothing of others');
  });

  /* ================================================================ deletion */
  await test('audit deletion', 'deleting a coach account cascades the coach profile, relationships, messages, proposals, feedback; the client keeps own records', async () => {
    const before = await adminCount(`select count(*) n from public.workout_sessions where owner_id = $1`, [A.c4]);
    await admin.query(`delete from auth.users where id = $1`, [A.coachD]);
    for (const [t, col] of [['coach_profiles', 'user_id'], ['coach_service_areas', 'coach_id'], ['coach_review_events', 'coach_id'],
      ['coaching_relationships', 'coach_id'], ['coach_messages', 'sender_id'], ['program_proposals', 'coach_id'], ['coach_feedback', 'coach_id'],
      ['coach_checkins', 'coach_id']]) {
      eq(await adminCount(`select count(*) n from public.${t} where ${col} = $1`, [A.coachD]), 0, t);
    }
    eq(await adminCount(`select count(*) n from public.coach_messages where relationship_id = $1`, [relD]), 0, 'client messages of that conversation');
    eq(await adminCount(`select count(*) n from public.coaching_scopes where relationship_id = $1`, [relD]), 0, 'scopes');
    eq(await adminCount(`select count(*) n from public.workout_sessions where owner_id = $1`, [A.c4]), before, 'client workouts intact');
    eq(ok(await R('c4', 'my_coaching_relationships'), 'rels'), [], 'client sees no relationship');
    // storage objects are not FK-linked: the delete-account Edge Function removes {relationship_id}/… in coach-media
    // BEFORE deleting the user. Here (no function) the orphan must at least be unreadable for every API role.
    for (const a of ['c4', 'str', 'adm']) {
      eq((await Q(a, `select id from storage.objects where bucket_id = 'coach-media' and name like $1`, [`${relD}/%`])).rows.length, 0, `${a} orphan chat media`);
    }
    eq(ok(await R(A.coachD, 'my_coaching_relationships'), 'stale JWT'), [], 'stale JWT of the deleted coach sees nothing');
    fails(await R(A.coachD, 'send_coach_message', { p_id: randomUUID(), p_relationship: relMem, p_body: 'x' }), 'stale JWT cannot write');
  });
}
