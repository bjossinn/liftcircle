/**
 * Supabase implementation of CoachingApi (see coachingContract.ts and docs/COACHING_INTERFACES.md). Online-only.
 *
 * Every write goes through a security-definer RPC (supabase/migrations/20261029000002_coaching_rpcs.sql) that takes
 * the acting user from the access token and re-checks the CURRENT relationship / coach status, so a queued offline
 * write after revocation, ending, blocking or suspension is refused by the server. Photos and documents live in
 * PRIVATE buckets; this module signs short-lived URLs for whatever the caller may currently read.
 */
import type { ID } from '@/domain/types';
import type {
  ApplicationStatus, CheckIn, ClientOverview, CoachCard, CoachDetail, CoachFeedback, CoachFormat, CoachingApi,
  CoachingIntake, CoachingRelationship, CoachMessage, CoachProfile, CoachSearch, GeocodeResult, ProgramProposal,
  ProposedProgram, ProposalStatus, Qualification, RelationshipStatus, ReviewEvent, ServiceArea, SharingScopes,
} from './coachingContract';
import { requireSupabase } from './supabase';
import { BackendError, toBackendError } from './syncRemote';
import { uuid } from '@/lib/id';

/** Signed URL lifetimes (seconds). Short on purpose: revoked access stops working within this window. */
export const COACH_SIGNED_URL_TTL = 300;
export const COACH_DOCUMENT_URL_TTL = 60;
const PHOTO_BUCKET = 'coach-public';
const DOCS_BUCKET = 'coach-docs';
const MEDIA_BUCKET = 'coach-media';
const AVATAR_BUCKET = 'avatars';

/* ------------------------------------------------------------------ helpers */

async function call<T>(fn: string, args?: Record<string, unknown>, fallback?: string): Promise<T> {
  let res: { data: unknown; error: unknown };
  try {
    res = await requireSupabase().rpc(fn, args);
  } catch (e) {
    throw toBackendError(e, fallback);
  }
  if (res.error) throw toBackendError(res.error, fallback);
  return res.data as T;
}

async function session() {
  const { data } = await requireSupabase().auth.getSession();
  const s = data.session;
  if (!s) throw new BackendError('You need to be signed in.', 'auth', 401);
  return s;
}

const signedCache = new Map<string, { url: string; exp: number }>();

/** Signs many paths in one request per bucket. Paths the caller may not read come back missing. */
async function signPaths(bucket: string, paths: (string | null | undefined)[], ttl = COACH_SIGNED_URL_TTL): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(paths.filter((x): x is string => Boolean(x)))];
  if (!wanted.length) return out;
  const uid = (await requireSupabase().auth.getSession()).data.session?.user.id ?? 'anon';
  const now = Date.now();
  const todo: string[] = [];
  for (const p of wanted) {
    const hit = signedCache.get(`${uid}:${bucket}/${p}`);
    if (hit && hit.exp - now > 60_000) out.set(p, hit.url);
    else todo.push(p);
  }
  if (!todo.length) return out;
  try {
    const { data, error } = await requireSupabase().storage.from(bucket).createSignedUrls(todo, ttl);
    if (error || !data) return out; // images are optional: placeholders instead of failing the page
    for (const row of data) {
      const url = row.signedUrl;
      if (row.path && url && !row.error) {
        out.set(row.path, url);
        signedCache.set(`${uid}:${bucket}/${row.path}`, { url, exp: now + ttl * 1000 });
      }
    }
  } catch {
    /* network hiccup: no images this time */
  }
  return out;
}

/** Forget cached signed URLs (call on sign-out / account switch). */
export function clearCoachingUrlCache() {
  signedCache.clear();
}

/** Readable message from a failed functions.invoke (FunctionsHttpError carries the Response). */
async function functionError(error: unknown, fallback: string): Promise<BackendError> {
  const ctx = (error as { context?: unknown })?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string; details?: unknown };
      return new BackendError(body.error || fallback, ctx.status === 401 ? 'auth' : `http_${ctx.status}`, ctx.status, body.details);
    } catch {
      return new BackendError(fallback, `http_${ctx.status}`, ctx.status);
    }
  }
  const msg = String((error as Error)?.message ?? '') + String((error as Error)?.name ?? '');
  if (/FunctionsFetchError|FunctionsRelayError|Failed to send a request|failed to fetch/i.test(msg)) {
    return new BackendError('You appear to be offline. Check your connection and try again.', 'network');
  }
  return toBackendError(error, fallback);
}

function uploadError(error: { message?: string; statusCode?: string | number }, what: string): BackendError {
  const status = Number(error.statusCode ?? 0);
  const m = error.message ?? '';
  if (status === 413 || /too large|exceeded the maximum/i.test(m)) return new BackendError(`This ${what} is too large to upload.`, 'upload', 413);
  if (status === 415 || /mime|content type/i.test(m)) return new BackendError(`This ${what} format isn’t supported.`, 'upload', 415);
  if (status === 401 || /jwt|token/i.test(m)) return new BackendError('Your session has expired. Please sign in again.', 'auth', 401);
  if (status === 403 || /row-level security|unauthorized|policy/i.test(m)) {
    return new BackendError(`This ${what} can’t be uploaded here (the conversation may be read-only now).`, '42501', 403);
  }
  return new BackendError(m || `Upload failed. Please try again.`, 'upload', status || undefined);
}

async function upload(bucket: string, path: string, blob: Blob, contentType: string, what: string): Promise<void> {
  const { error } = await requireSupabase().storage.from(bucket).upload(path, blob, { upsert: true, contentType, cacheControl: '3600' });
  if (error) throw uploadError(error as { message?: string; statusCode?: string | number }, what);
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/* ------------------------------------------------------------- row types */

interface RawArea {
  id: ID;
  kind: ServiceArea['kind'];
  city: string | null;
  region: string | null;
  country: string;
  lat: number | string | null;
  lng: number | string | null;
  radius_km: number | null;
  label: string | null;
}
interface RawQual {
  id: ID;
  title: string;
  issuer: string | null;
  year: number | null;
  document_path?: string | null;
  document_name?: string | null;
  review_status?: Qualification['reviewStatus'];
  review_note?: string | null;
}
interface RawProfile {
  user_id: ID;
  display_name: string;
  photo_path: string | null;
  bio: string;
  experience_years: number | null;
  experience: string;
  specialties: string[];
  goals: string[];
  languages: string[];
  city: string | null;
  region: string | null;
  country: string | null;
  formats: CoachFormat[];
  accepting_clients: boolean;
  listed: boolean;
  status: ApplicationStatus;
  suspended: boolean;
  suspended_reason: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  latest_feedback: string | null;
  updated_at: string;
  service_areas: RawArea[];
  qualifications: RawQual[];
}
interface RawCard {
  user_id: ID;
  display_name: string;
  photo_path: string | null;
  bio: string;
  specialties: string[];
  goals: string[];
  languages: string[];
  city: string | null;
  region: string | null;
  country: string | null;
  formats: CoachFormat[];
  accepting_clients: boolean;
  service_areas: RawArea[];
  match: 'local' | 'remote';
  distance_km: number | null;
}
interface RawDetail extends RawCard {
  experience_years: number | null;
  experience: string;
  approved_qualifications: RawQual[];
  approved_since: string | null;
}
interface RawRelationship {
  id: ID;
  coach_id: ID;
  client_id: ID;
  coach: { user_id: ID; display_name: string; photo_path: string | null; suspended: boolean; approved: boolean } | null;
  client: { user_id: ID; display_name: string; avatar_path: string | null };
  status: RelationshipStatus;
  intake: CoachingIntake | null;
  intro_message: string | null;
  response_message: string | null;
  scopes: SharingScopes;
  requested_at: string;
  responded_at: string | null;
  ended_at: string | null;
  ended_by: ID | null;
  end_reason: string | null;
  unread: number;
  viewer_is_coach: boolean;
}
interface RawProposal {
  id: ID;
  author_kind: 'coach' | 'ai';
  relationship_id: ID | null;
  coach_id: ID | null;
  client_id: ID;
  status: ProposalStatus;
  base_program_id: ID | null;
  base_version: number | null;
  revision: number;
  program: ProposedProgram;
  change_summary: unknown;
  message: string | null;
  effective_date: string | null;
  target: 'apply' | 'for_coach_review';
  validation_errors: unknown;
  created_at: string;
  sent_at: string | null;
  responded_at: string | null;
  applied_program_id: ID | null;
  applied_version: number | null;
}
interface RawMessage {
  id: ID;
  relationship_id: ID;
  sender_id: ID;
  body: string;
  media: { id: ID; width: number | null; height: number | null }[];
  status: 'awaiting_media' | 'sent';
  shared_from_ai: boolean;
  seq: number | string;
  created_at: string;
}
interface RawFeedback {
  id: ID;
  relationship_id: ID;
  session_id: ID | null;
  body: string;
  created_at: string;
}
interface RawCheckIn {
  id: ID;
  relationship_id: ID;
  client_id: ID;
  created_at: string;
  answers: CheckIn['answers'] | null;
  note: string | null;
  coach_response: string | null;
  reviewed_at: string | null;
}
interface RawEvent {
  id: ID;
  coach_id: ID;
  actor_id: ID | null;
  actor_name: string | null;
  action: ReviewEvent['action'];
  reason: string | null;
  qualification_id: ID | null;
  from_status: string | null;
  to_status: string | null;
  created_at: string;
}
interface RawOverview {
  relationship: RawRelationship;
  training: null | {
    active_program: { id: ID; name: string; current_version: number; managed_by: string | null } | null;
    recent_sessions: { id: ID; date: string; name: string; status: string; duration_min: number | null; working_sets: number }[];
    planned_last28: number | null;
    completed_last28: number;
  };
  measurements: null | { date: string; kind: string; value: number | string }[];
  nutrition: null | { date: string; protein: number | string | null; kcal: number | string | null }[];
  checkins: null | RawCheckIn[];
}

/* --------------------------------------------------------------- mappers */

const mapArea = (a: RawArea): ServiceArea => ({
  id: a.id, kind: a.kind, city: a.city, region: a.region, country: a.country,
  lat: num(a.lat), lng: num(a.lng), radiusKm: a.radius_km, label: a.label,
});

const mapQual = (q: RawQual): Qualification => ({
  id: q.id, title: q.title, issuer: q.issuer, year: q.year, documentPath: q.document_path ?? null,
  documentName: q.document_name ?? null, reviewStatus: q.review_status ?? 'approved', reviewNote: q.review_note ?? null,
});

async function mapProfiles(list: RawProfile[]): Promise<CoachProfile[]> {
  const photos = await signPaths(PHOTO_BUCKET, list.map((p) => p.photo_path));
  return list.map((p) => ({
    userId: p.user_id,
    displayName: p.display_name,
    photoPath: p.photo_path,
    photoUrl: p.photo_path ? photos.get(p.photo_path) ?? null : null,
    bio: p.bio ?? '',
    experienceYears: p.experience_years,
    experience: p.experience ?? '',
    specialties: arr(p.specialties),
    goals: arr(p.goals),
    languages: arr(p.languages),
    city: p.city,
    region: p.region,
    country: p.country,
    formats: arr(p.formats),
    acceptingClients: Boolean(p.accepting_clients),
    listed: Boolean(p.listed),
    status: p.status,
    suspended: Boolean(p.suspended),
    suspendedReason: p.suspended_reason,
    submittedAt: p.submitted_at,
    reviewedAt: p.reviewed_at,
    latestFeedback: p.latest_feedback,
    serviceAreas: arr(p.service_areas).map(mapArea),
    qualifications: arr(p.qualifications).map(mapQual),
    updatedAt: p.updated_at,
  }));
}

function cardFields(c: RawCard, photos: Map<string, string>): CoachCard {
  return {
    userId: c.user_id,
    displayName: c.display_name,
    photoUrl: c.photo_path ? photos.get(c.photo_path) ?? null : null,
    bio: c.bio ?? '',
    specialties: arr(c.specialties),
    goals: arr(c.goals),
    languages: arr(c.languages),
    city: c.city,
    region: c.region,
    country: c.country,
    formats: arr(c.formats),
    acceptingClients: Boolean(c.accepting_clients),
    serviceAreas: arr(c.service_areas).map(mapArea),
    match: c.match,
    distanceKm: num(c.distance_km),
  };
}

async function mapRelationships(list: RawRelationship[]): Promise<CoachingRelationship[]> {
  const [photos, avatars] = await Promise.all([
    signPaths(PHOTO_BUCKET, list.map((r) => r.coach?.photo_path)),
    signPaths(AVATAR_BUCKET, list.map((r) => r.client?.avatar_path)),
  ]);
  return list.map((r) => ({
    id: r.id,
    coachId: r.coach_id,
    clientId: r.client_id,
    coach: {
      userId: r.coach_id,
      displayName: r.coach?.display_name || 'Coach',
      photoUrl: r.coach?.photo_path ? photos.get(r.coach.photo_path) ?? null : null,
      suspended: Boolean(r.coach?.suspended),
      approved: Boolean(r.coach?.approved),
    },
    client: {
      userId: r.client_id,
      displayName: r.client?.display_name || 'Hard Earned member',
      avatarUrl: r.client?.avatar_path ? avatars.get(r.client.avatar_path) ?? null : null,
    },
    status: r.status,
    intake: r.intake ?? {},
    introMessage: r.intro_message ?? '',
    scopes: {
      training: Boolean(r.scopes?.training), measurements: Boolean(r.scopes?.measurements),
      nutrition: Boolean(r.scopes?.nutrition), checkins: Boolean(r.scopes?.checkins),
    },
    requestedAt: r.requested_at,
    respondedAt: r.responded_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    endReason: r.end_reason,
    unread: Number(r.unread ?? 0),
    viewerIsCoach: Boolean(r.viewer_is_coach),
  }));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);

const mapProposal = (p: RawProposal): ProgramProposal => ({
  id: p.id,
  authorKind: p.author_kind,
  relationshipId: p.relationship_id,
  coachId: p.coach_id,
  clientId: p.client_id,
  status: p.status,
  baseProgramId: p.base_program_id,
  baseVersion: p.base_version,
  revision: Number(p.revision ?? 1),
  program: p.program,
  changeSummary: strings(p.change_summary),
  message: p.message,
  effectiveDate: p.effective_date,
  target: p.target,
  validationErrors: strings(p.validation_errors),
  createdAt: p.created_at,
  sentAt: p.sent_at,
  respondedAt: p.responded_at,
  appliedProgramId: p.applied_program_id,
  appliedVersion: p.applied_version,
});

const mediaPath = (relationshipId: ID, messageId: ID, mediaId: ID, thumb = false) =>
  `${relationshipId}/${messageId}/${mediaId}${thumb ? '_thumb' : ''}.jpg`;

async function mapMessages(list: RawMessage[]): Promise<CoachMessage[]> {
  const paths = list.flatMap((m) => arr(m.media).flatMap((x) => [mediaPath(m.relationship_id, m.id, x.id), mediaPath(m.relationship_id, m.id, x.id, true)]));
  const urls = await signPaths(MEDIA_BUCKET, paths);
  return list.map((m) => ({
    id: m.id,
    relationshipId: m.relationship_id,
    senderId: m.sender_id,
    body: m.body ?? '',
    media: arr(m.media).map((x) => ({
      id: x.id,
      width: Number(x.width ?? 0),
      height: Number(x.height ?? 0),
      url: urls.get(mediaPath(m.relationship_id, m.id, x.id)),
      thumbUrl: urls.get(mediaPath(m.relationship_id, m.id, x.id, true)),
    })),
    status: m.status,
    seq: Number(m.seq),
    createdAt: m.created_at,
    sharedFromAi: Boolean(m.shared_from_ai),
  }));
}

const mapFeedback = (f: RawFeedback): CoachFeedback => ({
  id: f.id, relationshipId: f.relationship_id, sessionId: f.session_id, body: f.body, createdAt: f.created_at,
});

const mapCheckIn = (k: RawCheckIn): CheckIn => ({
  id: k.id, relationshipId: k.relationship_id, clientId: k.client_id, createdAt: k.created_at, answers: k.answers ?? {},
  note: k.note, coachResponse: k.coach_response, reviewedAt: k.reviewed_at,
});

const mapEvent = (e: RawEvent): ReviewEvent => ({
  id: e.id, coachId: e.coach_id, actorId: e.actor_id ?? '', actorName: e.actor_name, action: e.action, reason: e.reason,
  qualificationId: e.qualification_id, fromStatus: e.from_status, toStatus: e.to_status, createdAt: e.created_at,
});

/** Filename safe for a storage key (keeps the extension). */
function safeFilename(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
  return (cleaned || 'document').slice(-120);
}

function documentContentType(file: Blob, filename: string): string {
  if (file.type) return file.type;
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

/* ===================================================================== api */

export const coachingApi: CoachingApi = {
  /* -------------------------------------------------------------- roles */
  async myRoles() {
    try {
      const r = await call<{ admin: boolean; moderator: boolean }>('my_roles');
      return { admin: Boolean(r?.admin), moderator: Boolean(r?.moderator) };
    } catch {
      return { admin: false, moderator: false };
    }
  },

  /* -------------------------------------------------- applicant / coach */
  async getMyCoachProfile() {
    const raw = await call<RawProfile | null>('get_my_coach_profile');
    return raw ? (await mapProfiles([raw]))[0] : null;
  },

  async saveMyCoachProfile(input) {
    const raw = await call<RawProfile>('save_my_coach_profile', {
      p: {
        displayName: input.displayName,
        photoPath: input.photoPath ?? null,
        bio: input.bio,
        experienceYears: input.experienceYears ?? null,
        experience: input.experience,
        specialties: input.specialties,
        goals: input.goals,
        languages: input.languages,
        city: input.city ?? null,
        region: input.region ?? null,
        country: input.country ?? null,
        formats: input.formats,
        acceptingClients: input.acceptingClients,
        listed: input.listed,
        serviceAreas: input.serviceAreas.map((a) => {
          const coords = a.lat !== null && a.lat !== undefined && a.lng !== null && a.lng !== undefined;
          return {
            id: (a as Partial<ServiceArea>).id ?? null,
            kind: a.kind,
            city: a.city ?? null,
            region: a.region ?? null,
            country: a.country,
            // Coordinates only come from geocode() results; the server stores them rounded to ~100 m.
            lat: coords ? a.lat : null,
            lng: coords ? a.lng : null,
            radiusKm: a.radiusKm ?? null,
            label: a.label ?? null,
          };
        }),
        qualifications: input.qualifications.map((q) => ({
          id: q.id, title: q.title, issuer: q.issuer ?? null, year: q.year ?? null,
          documentPath: q.documentPath ?? null, documentName: q.documentName ?? null,
        })),
      },
    }, 'Could not save your coach profile.');
    return (await mapProfiles([raw]))[0];
  },

  async submitApplication() {
    const raw = await call<RawProfile>('submit_coach_application', undefined, 'Could not submit your application.');
    return (await mapProfiles([raw]))[0];
  },

  async uploadCoachPhoto(blob) {
    const s = await session();
    const path = `${s.user.id}/photo_${uuid()}.jpg`;
    await upload(PHOTO_BUCKET, path, blob, blob.type || 'image/jpeg', 'photo');
    return path; // save it with saveMyCoachProfile({ photoPath })
  },

  async uploadQualificationDocument(qualificationId, file, filename) {
    const s = await session();
    const path = `${s.user.id}/${qualificationId}/${safeFilename(filename)}`;
    await upload(DOCS_BUCKET, path, file, documentContentType(file, filename), 'document');
    return path; // save it on the qualification (documentPath) with saveMyCoachProfile
  },

  async documentUrl(path) {
    const { data, error } = await requireSupabase().storage.from(DOCS_BUCKET).createSignedUrl(path, COACH_DOCUMENT_URL_TTL);
    if (error || !data?.signedUrl) throw new BackendError('This document isn’t available to you.', '42501', 403);
    return data.signedUrl;
  },

  async setListing(listed, acceptingClients) {
    await call('set_coach_listing', { p_listed: listed, p_accepting: acceptingClients }, 'Could not update your listing.');
  },

  async myReviewEvents() {
    return (await call<RawEvent[]>('my_coach_review_events')).map(mapEvent);
  },

  /* ------------------------------------------------------------ directory */
  async searchCoaches(q: CoachSearch) {
    const raw = await call<{ items: RawCard[]; distance_available: boolean }>('search_coaches', {
      p: {
        city: q.city?.trim() || null,
        region: q.region?.trim() || null,
        country: q.country?.trim() || null,
        lat: q.lat ?? null,
        lng: q.lng ?? null,
        radiusKm: q.radiusKm ?? null,
        format: q.format ?? 'any',
        specialty: q.specialty || null,
        goal: q.goal || null,
        language: q.language || null,
        acceptingOnly: Boolean(q.acceptingOnly),
        limit: q.limit ?? 20,
        offset: q.offset ?? 0,
      },
    }, 'Could not search coaches.');
    const items = arr(raw?.items);
    const photos = await signPaths(PHOTO_BUCKET, items.map((c) => c.photo_path));
    return { items: items.map((c) => cardFields(c, photos)), distanceAvailable: Boolean(raw?.distance_available) };
  },

  async getCoach(userId) {
    const raw = await call<RawDetail | null>('get_coach', { p_coach: userId });
    if (!raw) return null;
    const photos = await signPaths(PHOTO_BUCKET, [raw.photo_path]);
    const detail: CoachDetail = {
      ...cardFields(raw, photos),
      experienceYears: raw.experience_years,
      experience: raw.experience ?? '',
      approvedQualifications: arr(raw.approved_qualifications).map((x) => ({ id: x.id, title: x.title, issuer: x.issuer, year: x.year })),
      approvedSince: raw.approved_since,
    };
    return detail;
  },

  async geocode(query) {
    const unavailable = { available: false, results: [] as GeocodeResult[] };
    let res: { data: unknown; error: unknown };
    try {
      res = await requireSupabase().functions.invoke('geocode', { body: { query } });
    } catch {
      return unavailable;
    }
    if (res.error) {
      const e = await functionError(res.error, 'Location search is unavailable.');
      // Bad input and rate limits are the user's to fix; a missing function/provider is not an error.
      if (e.status === 400 || e.status === 429 || e.isAuth) throw e;
      return unavailable;
    }
    const data = res.data as { available?: boolean; results?: GeocodeResult[] } | null;
    if (!data?.available) return unavailable;
    return {
      available: true,
      results: arr(data.results).slice(0, 5).map((r) => ({
        label: r.label, city: r.city ?? null, region: r.region ?? null, country: r.country,
        lat: Math.round(Number(r.lat) * 1000) / 1000, lng: Math.round(Number(r.lng) * 1000) / 1000,
      })),
    };
  },

  /* -------------------------------------------------- relationships (client) */
  async requestCoaching(input) {
    const raw = await call<RawRelationship>('request_coaching', {
      p_id: input.id, p_coach: input.coachId, p_intake: input.intake ?? {}, p_message: input.introMessage ?? '', p_scopes: input.scopes,
    }, 'Could not send the coaching request.');
    return (await mapRelationships([raw]))[0];
  },

  async cancelRequest(relationshipId) {
    await call('cancel_coaching_request', { p_id: relationshipId }, 'Could not cancel the request.');
  },

  async endCoaching(relationshipId, reason) {
    await call('end_coaching', { p_id: relationshipId, p_reason: reason ?? null }, 'Could not end coaching.');
  },

  async setScopes(relationshipId, scopes) {
    await call('set_coaching_scopes', { p_id: relationshipId, p_scopes: scopes }, 'Could not update what you share.');
  },

  async myRelationships() {
    return mapRelationships(await call<RawRelationship[]>('my_coaching_relationships'));
  },

  /* --------------------------------------------------- relationships (coach) */
  async respondRequest(relationshipId, accept, message) {
    await call('respond_coaching_request', { p_id: relationshipId, p_accept: accept, p_message: message ?? null }, 'Could not respond to the request.');
  },

  async clientOverview(relationshipId) {
    const raw = await call<RawOverview>('coach_client_overview', { p_id: relationshipId }, 'Could not load this client.');
    const [relationship] = await mapRelationships([raw.relationship]);
    const t = raw.training;
    const overview: ClientOverview = {
      relationship,
      training: t
        ? {
            activeProgram: t.active_program
              ? { id: t.active_program.id, name: t.active_program.name ?? 'Program', currentVersion: Number(t.active_program.current_version ?? 1), managedBy: t.active_program.managed_by }
              : null,
            recentSessions: arr(t.recent_sessions).map((s) => ({
              id: s.id, date: s.date, name: s.name ?? 'Workout', status: s.status ?? '', durationMin: num(s.duration_min), workingSets: Number(s.working_sets ?? 0),
            })),
            plannedLast28: num(t.planned_last28),
            completedLast28: Number(t.completed_last28 ?? 0),
          }
        : null,
      measurements: raw.measurements ? raw.measurements.map((m) => ({ date: m.date, kind: m.kind, value: Number(m.value) })) : null,
      nutrition: raw.nutrition ? raw.nutrition.map((n) => ({ date: n.date, protein: num(n.protein), kcal: num(n.kcal) })) : null,
      checkins: raw.checkins ? raw.checkins.map(mapCheckIn) : null,
    };
    return overview;
  },

  /* ------------------------------------------------------------- programs */
  async saveProposal(input) {
    const raw = await call<RawProposal>('save_program_proposal', {
      p: {
        id: input.id,
        relationshipId: input.relationshipId,
        baseProgramId: input.baseProgramId ?? null,
        baseVersion: input.baseVersion ?? null,
        program: input.program,
        changeSummary: input.changeSummary ?? [],
        message: input.message ?? null,
        effectiveDate: input.effectiveDate ?? null,
      },
    }, 'Could not save the program proposal.');
    return mapProposal(raw);
  },

  async sendProposal(proposalId) {
    await call('send_program_proposal', { p_id: proposalId }, 'Could not send the proposal.');
  },

  async withdrawProposal(proposalId) {
    await call('withdraw_program_proposal', { p_id: proposalId }, 'Could not withdraw the proposal.');
  },

  async listProposals(filter) {
    const raw = await call<RawProposal[]>('list_program_proposals', {
      p: { relationshipId: filter.relationshipId ?? null, mine: Boolean(filter.mine), status: filter.status?.length ? filter.status : null },
    });
    return arr(raw).map(mapProposal);
  },

  async getProposal(id) {
    const raw = await call<RawProposal | null>('get_program_proposal', { p_id: id });
    return raw ? mapProposal(raw) : null;
  },

  async respondProposal(id, accept, applied) {
    if (accept && !applied) throw new BackendError('Choose where to apply this program first.', 'P0001', 400);
    await call('respond_program_proposal', {
      p_id: id, p_accept: accept, p_program_id: applied?.programId ?? null, p_version: applied?.version ?? null,
    }, 'Could not respond to the proposal.');
  },

  async addFeedback(input) {
    await call('add_coach_feedback', { p_id: input.id, p_relationship: input.relationshipId, p_session: input.sessionId ?? null, p_body: input.body },
      'Could not save your feedback.');
  },

  async listFeedback(relationshipId) {
    return arr(await call<RawFeedback[]>('list_coach_feedback', { p_relationship: relationshipId })).map(mapFeedback);
  },

  /* ------------------------------------------------------------- check-ins */
  async submitCheckIn(input) {
    await call('submit_checkin', { p_id: input.id, p_relationship: input.relationshipId, p_answers: input.answers ?? {}, p_note: input.note ?? null },
      'Could not send your check-in.');
  },

  async listCheckIns(relationshipId) {
    return arr(await call<RawCheckIn[]>('list_checkins', { p_relationship: relationshipId })).map(mapCheckIn);
  },

  async respondCheckIn(id, response) {
    await call('respond_checkin', { p_id: id, p_response: response }, 'Could not save your response.');
  },

  /* ------------------------------------------------------------- messaging */
  async listMessages(relationshipId, afterSeq = 0, limit = 100) {
    return mapMessages(await call<RawMessage[]>('list_coach_messages', { p_relationship: relationshipId, p_after_seq: afterSeq, p_limit: limit },
      'Could not load messages.'));
  },

  async sendMessage(input) {
    const raw = await call<RawMessage>('send_coach_message', {
      p_id: input.id,
      p_relationship: input.relationshipId,
      p_body: input.body ?? '',
      p_media: (input.mediaIds ?? []).map((id) => ({ id })),
      p_shared_from_ai: Boolean(input.sharedFromAi),
    }, 'Could not send the message.');
    return (await mapMessages([raw]))[0];
  },

  /**
   * Upload one photo (+ thumbnail) of a message created with sendMessage({ mediaIds }). Retries are safe (upsert).
   * After the upload it asks finalize-coach-media to validate the message; while other declared photos are still
   * missing that is a no-op, and after the last one the message becomes 'sent' (and the other side is notified).
   */
  async uploadMessageMedia(relationshipId, messageId, mediaId, image, thumb) {
    await upload(MEDIA_BUCKET, mediaPath(relationshipId, messageId, mediaId, true), thumb, thumb.type || 'image/jpeg', 'photo');
    await upload(MEDIA_BUCKET, mediaPath(relationshipId, messageId, mediaId), image, image.type || 'image/jpeg', 'photo');
    const { error } = await requireSupabase().functions.invoke('finalize-coach-media', { body: { messageId } });
    if (!error) return;
    const e = await functionError(error, 'Could not send the photo. Please try again.');
    const details = Array.isArray(e.details) ? (e.details as { problem?: string }[]) : [];
    if (e.status === 422 && details.length > 0 && details.every((d) => d.problem === 'not uploaded yet')) return; // more photos to come
    throw e;
  },

  async markRead(relationshipId, uptoSeq) {
    await call('mark_coach_messages_read', { p_relationship: relationshipId, p_upto: uptoSeq });
  },

  async unreadCoachingCount() {
    return Number((await call<number | null>('unread_coaching_count')) ?? 0);
  },

  async reportCoachingContent(input) {
    await call('report_coaching_content', {
      p_relationship: input.relationshipId, p_message: input.messageId ?? null, p_reason: input.reason, p_details: input.details ?? null,
    }, 'Could not send the report.');
  },

  /* ----------------------------------------------------------------- admin */
  async adminListApplications(status) {
    return mapProfiles(arr(await call<RawProfile[]>('admin_list_coach_applications', { p_filter: status ?? null }, 'Could not load applications.')));
  },

  async adminGetApplication(coachId) {
    const raw = await call<{ profile: RawProfile; events: RawEvent[] } | null>('admin_get_coach_application', { p_coach: coachId },
      'Could not load the application.');
    if (!raw) return null;
    const [profile] = await mapProfiles([raw.profile]);
    return { profile, events: arr(raw.events).map(mapEvent) };
  },

  async adminReview(coachId, action, reason, qualificationId) {
    await call('admin_review_coach', { p_coach: coachId, p_action: action, p_reason: reason ?? null, p_qualification: qualificationId ?? null },
      'Could not save the review.');
  },
};

/* ------------------------------------------ admin coaching reports (not yet in CoachingApi) */

export interface CoachingReport {
  id: ID;
  reporterId: ID;
  relationshipId: ID | null;
  messageId: ID | null;
  reportedUserId: ID | null;
  coachId: ID | null;
  reason: string;
  details: string | null;
  /** The reported message only (never the rest of the conversation). */
  messageBody: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: string;
}

export const coachingReportsApi = {
  async list(status: 'open' | 'actioned' | 'dismissed' | null = 'open'): Promise<CoachingReport[]> {
    const raw = await call<Record<string, unknown>[]>('admin_list_coaching_reports', { p_status: status }, 'Could not load reports.');
    return arr(raw).map((r) => ({
      id: r.id as ID, reporterId: r.reporter_id as ID, relationshipId: (r.relationship_id as ID) ?? null, messageId: (r.message_id as ID) ?? null,
      reportedUserId: (r.reported_user_id as ID) ?? null, coachId: (r.coach_id as ID) ?? null, reason: String(r.reason),
      details: (r.details as string) ?? null, messageBody: (r.message_body as string) ?? null,
      status: r.status as CoachingReport['status'], createdAt: String(r.created_at),
    }));
  },
  async resolve(reportId: ID, action: 'dismiss' | 'actioned' | 'remove_message'): Promise<void> {
    await call('admin_resolve_coaching_report', { p_id: reportId, p_action: action }, 'Could not resolve the report.');
  },
};

/* ------------------------------------------------- public (signed-out) preview */
/**
 * Read-only coach directory for signed-out visitors (supabase/migrations/20261030000004_public_coach_preview.sql):
 * approved, non-suspended, listed coaches with public listing fields only — no photos, coordinates or
 * distances. Works with just the publishable key. Requests, messages and everything private stay signed-in only.
 * Throws when the backend doesn't have the preview RPCs yet; callers fall back to the sign-in explanation.
 */
export const publicCoachDirectory = {
  async search(q: Pick<CoachSearch, 'city' | 'region' | 'country' | 'format' | 'specialty' | 'goal' | 'language' | 'acceptingOnly' | 'limit' | 'offset'>): Promise<{ items: CoachCard[]; hasMore: boolean }> {
    const raw = await call<{ items: RawCard[]; has_more: boolean }>('public_search_coaches', {
      p: {
        city: q.city?.trim() || null,
        region: q.region?.trim() || null,
        country: q.country?.trim() || null,
        format: q.format ?? 'any',
        specialty: q.specialty || null,
        goal: q.goal || null,
        language: q.language || null,
        acceptingOnly: Boolean(q.acceptingOnly),
        limit: Math.min(q.limit ?? 20, 20),
        offset: q.offset ?? 0,
      },
    }, 'Could not load coaches.');
    const none = new Map<string, string>();
    return { items: arr(raw?.items).map((c) => cardFields({ ...c, photo_path: null, distance_km: null }, none)), hasMore: Boolean(raw?.has_more) };
  },

  async get(userId: ID): Promise<CoachDetail | null> {
    const raw = await call<RawDetail | null>('public_get_coach', { p_coach: userId }, 'Could not load this coach.');
    if (!raw) return null;
    return {
      ...cardFields({ ...raw, photo_path: null, distance_km: null }, new Map()),
      experienceYears: raw.experience_years,
      experience: raw.experience ?? '',
      approvedQualifications: arr(raw.approved_qualifications).map((x) => ({ id: x.id, title: x.title, issuer: x.issuer, year: x.year })),
      approvedSince: raw.approved_since,
    };
  },
};
