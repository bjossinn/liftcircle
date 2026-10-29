/**
 * Public (signed-out) coach preview — supabase/migrations/20261030000004_public_coach_preview.sql.
 * Called from run.mjs after the coaching suites. Uses its own actors, created directly as the admin
 * (plays the dashboard), so it doesn't depend on the state the other suites leave behind.
 *
 * Asserts: anon can call ONLY the two preview RPCs; they return only approved + non-suspended + listed
 * coaches; only the allow-listed public fields (no photo path, coordinates, distance, status, review data,
 * documents); pending / rejected / draft / changes-requested / suspended / unlisted coaches are invisible
 * (search and detail); limits are capped; the full directory RPCs and coaching actions stay signed-in only.
 */
import { randomUUID } from 'node:crypto';

const CARD_KEYS = ['accepting_clients', 'bio', 'city', 'country', 'display_name', 'formats', 'goals', 'languages', 'match', 'region', 'service_areas', 'specialties', 'user_id'];
const DETAIL_KEYS = [...CARD_KEYS, 'approved_qualifications', 'approved_since', 'experience', 'experience_years'].sort();
const AREA_KEYS = ['city', 'country', 'id', 'kind', 'label', 'radius_km', 'region'];
const QUAL_KEYS = ['id', 'issuer', 'title', 'year'];

export async function publicCoachPreviewTests(h) {
  const { test, rpc, admin, ok, fails, eq, assert } = h;
  const P = {
    ok: randomUUID(), // approved, listed, in-person + online, Reykjavík (area WITH coordinates), photo, approved + pending quals
    online: randomUUID(), // approved, listed, online only
    unlisted: randomUUID(), // approved, not listed
    susp: randomUUID(), // approved, listed, suspended
    pending: randomUUID(), // submitted
    rejected: randomUUID(), // rejected (listed flag set to prove status wins)
    draft: randomUUID(),
    changes: randomUUID(), // changes_requested
    member: randomUUID(), // ordinary signed-in member
  };
  const NAME = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));
  const bio = 'Public preview test coach with years of experience helping people train consistently.';
  await test('public coach preview', 'setup: preview actors and coach profiles in every state', async () => {
    for (const [name, id] of Object.entries(P)) {
      await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `pv_${name}@example.test`]);
    }
    const ins = async (id, o) =>
      admin.query(
        `insert into public.coach_profiles (user_id, display_name, photo_path, bio, experience_years, experience, specialties, goals,
           languages, city, region, country, formats, accepting_clients, listed, status, suspended, suspended_reason,
           submitted_at, approved_at, latest_feedback)
         values ($1, $2, $3, $4, 7, 'Seven years in a gym', '{strength}', '{build_strength}', '{en,is}', 'Reykjavík',
                 'Höfuðborgarsvæðið', 'IS', $5, true, $6, $7, $8, $9, now(), $10, 'internal reviewer feedback')`,
        [id, o.name, `${id}/photo_${randomUUID()}.jpg`, bio, o.formats ?? '{in_person,online}', o.listed ?? true, o.status ?? 'approved',
          o.suspended ?? false, o.suspended ? 'Under investigation' : null, (o.status ?? 'approved') === 'approved' ? new Date() : null],
      );
    await ins(P.ok, { name: 'PV Approved' });
    await ins(P.online, { name: 'PV Online', formats: '{online}' });
    await ins(P.unlisted, { name: 'PV Unlisted', listed: false });
    await ins(P.susp, { name: 'PV Suspended', suspended: true });
    await ins(P.pending, { name: 'PV Pending', status: 'submitted' });
    await ins(P.rejected, { name: 'PV Rejected', status: 'rejected' });
    await ins(P.draft, { name: 'PV Draft', status: 'draft' });
    await ins(P.changes, { name: 'PV Changes', status: 'changes_requested' });
    for (const id of Object.values(P).filter((x) => x !== P.member && x !== P.online)) {
      await admin.query(
        `insert into public.coach_service_areas (coach_id, kind, city, country, lat, lng, radius_km, label, geo_source)
         values ($1, 'city', 'Reykjavík', 'IS', 64.1466, -21.9426, 20, 'Reykjavík, Iceland', 'geocoder')`,
        [id],
      );
    }
    await admin.query(
      `insert into public.coach_qualifications (id, coach_id, title, issuer, year, document_path, document_name, review_status, review_note)
       values ($1, $2, 'Approved cert', 'Issuer', 2020, $3, 'cert.pdf', 'approved', 'looked fine'),
              ($4, $2, 'Pending cert', 'Issuer', 2021, $5, 'pending.pdf', 'pending', null)`,
      [randomUUID(), P.ok, `${P.ok}/${randomUUID()}/cert.pdf`, randomUUID(), `${P.ok}/${randomUUID()}/pending.pdf`],
    );
  });

  const search = async (actor, p = {}) => ok(await rpc(actor, 'public_search_coaches', { p }), `search ${JSON.stringify(p)}`);
  const ids = (r) => r.items.map((c) => NAME[c.user_id]).filter(Boolean);

  await test('public coach preview', 'anon search returns only approved, non-suspended, listed coaches (online coaches without a place)', async () => {
    let r = await search('anon', { city: 'Reykjavík', country: 'IS' });
    const got = ids(r).sort();
    eq(got, ['ok', 'online'], 'visible set for a Reykjavík search');
    r = await search('anon', {});
    for (const hidden of ['unlisted', 'susp', 'pending', 'rejected', 'draft', 'changes']) assert(!ids(r).includes(hidden), `${hidden} hidden (no place)`);
    r = await search('anon', { city: 'Reykjavík', format: 'in_person' });
    eq(ids(r), ['ok'], 'in-person filter');
    eq(r.items[0].match, 'local', 'local match label');
  });

  await test('public coach preview', 'anon search exposes only public listing fields: no photo, coordinates, distance, status or review data', async () => {
    const r = await search('anon', { city: 'Reykjavík', country: 'IS' });
    for (const c of r.items.filter((x) => NAME[x.user_id])) {
      eq(Object.keys(c).sort(), CARD_KEYS, `card keys for ${NAME[c.user_id]}`);
      for (const a of c.service_areas) eq(Object.keys(a).sort(), AREA_KEYS, 'service area keys (no lat/lng)');
    }
    const text = JSON.stringify(r);
    for (const secret of ['photo_', '64.14', '-21.94', 'internal reviewer feedback', 'geocoder', 'Under investigation', 'pending.pdf', 'cert.pdf'])
      assert(!text.includes(secret), `search leaks "${secret}"`);
    assert(!('distance_available' in r), 'no distance information');
  });

  await test('public coach preview', 'anon detail: visible coach shows public fields + reviewed qualifications only; every other state is null', async () => {
    const d = ok(await rpc('anon', 'public_get_coach', { p_coach: P.ok }), 'detail');
    eq(Object.keys(d).sort(), DETAIL_KEYS, 'detail keys');
    eq(d.approved_qualifications.map((q) => q.title), ['Approved cert'], 'only reviewed qualifications');
    for (const q of d.approved_qualifications) eq(Object.keys(q).sort(), QUAL_KEYS, 'qualification keys (no document/review note)');
    const text = JSON.stringify(d);
    for (const secret of ['photo_', '64.14', 'internal reviewer feedback', 'looked fine', 'cert.pdf', 'Pending cert']) assert(!text.includes(secret), `detail leaks "${secret}"`);
    for (const hidden of ['unlisted', 'susp', 'pending', 'rejected', 'draft', 'changes', 'member'])
      eq(ok(await rpc('anon', 'public_get_coach', { p_coach: P[hidden] }), hidden), null, `${hidden} detail hidden`);
    eq(ok(await rpc('anon', 'public_get_coach', { p_coach: randomUUID() }), 'unknown'), null, 'unknown id');
  });

  await test('public coach preview', 'state changes apply at once: unlisting / suspending hides a coach from the public preview', async () => {
    await admin.query(`update public.coach_profiles set listed = false where user_id = $1`, [P.online]);
    assert(!ids(await search('anon', {})).includes('online'), 'unlisted after change');
    eq(ok(await rpc('anon', 'public_get_coach', { p_coach: P.online }), 'detail'), null, 'detail after unlisting');
    await admin.query(`update public.coach_profiles set listed = true, suspended = true where user_id = $1`, [P.online]);
    assert(!ids(await search('anon', {})).includes('online'), 'suspended');
    await admin.query(`update public.coach_profiles set suspended = false where user_id = $1`, [P.online]);
    assert(ids(await search('anon', {})).includes('online'), 'visible again');
  });

  await test('public coach preview', 'limits are capped (≤ 20 per call, no paging past 200) and bad input is ignored', async () => {
    const r = await search('anon', { limit: 500, offset: -5, country: 'not-a-country', format: 'drop table', lat: 64.1, lng: -21.9, radiusKm: 1 });
    assert(r.items.length <= 20, 'limit capped');
    const far = await search('anon', { offset: 100000 });
    eq(far.items.length, 0, 'offset capped to 200 (no results there)');
    eq(far.has_more, false, 'no paging beyond the cap');
  });

  await test('public coach preview', 'signed-in members can call the preview too; full directory and coaching actions stay signed-in only', async () => {
    assert(ids(await search(P.member, { city: 'Reykjavík' })).includes('ok'), 'member preview');
    fails(await rpc('anon', 'search_coaches', { p: {} }), 'anon full search');
    fails(await rpc('anon', 'get_coach', { p_coach: P.ok }), 'anon full detail');
    fails(await rpc('anon', 'request_coaching', { p_id: randomUUID(), p_coach: P.ok, p_intake: {}, p_message: 'hi', p_scopes: {} }), 'anon request');
    fails(await rpc('anon', 'my_relationships'), 'anon relationships');
  });

  await test('public coach preview', 'anon still cannot read coach tables or the coach-public photo objects directly', async () => {
    for (const t of ['coach_profiles', 'coach_service_areas', 'coach_qualifications']) {
      const r = await h.as('anon', `select count(*)::int n from public.${t}`);
      assert(r.error || r.rows[0].n === 0, `anon reads ${t}`);
    }
    const r = await h.as('anon', `select count(*)::int n from storage.objects where bucket_id = 'coach-public'`);
    assert(r.error || r.rows[0].n === 0, 'anon reads coach photos');
  });

  await test('public coach preview', 'preview RPCs are security definer; anon can execute nothing in schema private', async () => {
    const r = await admin.query(
      `select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('public_search_coaches', 'public_get_coach') and p.prosecdef`,
    );
    eq(r.rows.length, 2, 'both preview functions are security definer');
    const anonExec = await admin.query(
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and has_function_privilege('anon', p.oid, 'EXECUTE')
          and has_schema_privilege('anon', 'private', 'USAGE')`,
    );
    eq(anonExec.rows[0].n, 0, 'anon can execute nothing in private');
  });
}
