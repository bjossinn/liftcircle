// geocode — turns a typed place ("Reykjavík", "Akureyri, Iceland") into up to 5 candidate places with
// coordinates, so coach service areas and directory searches can use REAL coordinates (never invented ones).
//
// POST { query } with the user's access token → { available, results: GeocodeResult[], reason? }
//
// Env:
//   GEOCODER=nominatim|none            (default none → { available: false, results: [] })
//   GEOCODER_CONTACT_EMAIL=<email>     required for nominatim (OSMF usage policy: identify your app + contact)
//   NOMINATIM_URL=<base url>           optional, e.g. a self-hosted instance (default https://nominatim.openstreetmap.org)
//
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/): max 1 request/second, a valid
// User-Agent identifying the application, cache results, no bulk/auto-complete use. This function:
//   * throttles upstream calls per instance to ≥ 1.1 s apart (waits up to ~5 s, then answers 429),
//   * rate-limits each user (durable 60/hour via public.coaching_geocode_quota + 10/minute in memory),
//   * caches answers per instance for 24 h,
//   * only runs on an explicit search (the client must not call it per keystroke).
// Coordinates are rounded to 3 decimals (≈100 m) before they leave the function.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handler, HttpError, json, readJson } from '../_shared/http.ts';
import { publishableKey, requireUser, supabaseUrl } from '../_shared/supabase.ts';

interface GeocodeResult {
  label: string;
  city?: string | null;
  region?: string | null;
  country: string;
  lat: number;
  lng: number;
}

const PROVIDER = (Deno.env.get('GEOCODER') ?? 'none').trim().toLowerCase();
const CONTACT = (Deno.env.get('GEOCODER_CONTACT_EMAIL') ?? '').trim();
const BASE = (Deno.env.get('NOMINATIM_URL') ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const USER_AGENT = `LiftCircle/1.0 (coach directory geocoding; contact: ${CONTACT || 'unset'})`;

/* ---------------------------------------------------------------- throttle */
let nextSlot = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  if (at - now > 5000) throw new HttpError(429, 'Location search is busy right now. Please try again in a few seconds.');
  nextSlot = at + 1100;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/* ----------------------------------------------------- per-user (instance) */
const perUser = new Map<string, number[]>();
function userBurstLimit(uid: string) {
  const now = Date.now();
  const list = (perUser.get(uid) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 10) throw new HttpError(429, 'Too many location searches. Please wait a minute.');
  list.push(now);
  perUser.set(uid, list);
  if (perUser.size > 5000) perUser.clear();
}

/* ------------------------------------------------------------------- cache */
const cache = new Map<string, { at: number; results: GeocodeResult[] }>();
const CACHE_MS = 24 * 3600 * 1000;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface NominatimRow {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string | undefined>;
}

function mapRow(r: NominatimRow): GeocodeResult | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  const a = r.address ?? {};
  const country = (a.country_code ?? '').toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^[A-Z]{2}$/.test(country)) return null;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.suburb ?? null;
  const region = a.state ?? a.region ?? a.county ?? a.state_district ?? null;
  return {
    label: (r.display_name ?? [city, region, country].filter(Boolean).join(', ')).slice(0, 200),
    city: city ?? null,
    region: region ?? null,
    country,
    lat: round3(lat),
    lng: round3(lng),
  };
}

async function nominatim(query: string, lang: string | null): Promise<GeocodeResult[]> {
  const key = `${lang ?? ''}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  await throttle();
  const url = new URL(`${BASE}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('email', CONTACT);
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (lang) headers['Accept-Language'] = lang;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const rows = (await res.json()) as NominatimRow[];
  const results = (Array.isArray(rows) ? rows : []).map(mapRow).filter((x): x is GeocodeResult => x !== null).slice(0, 5);
  cache.set(key, { at: Date.now(), results });
  if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
  return results;
}

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const { query } = await readJson<{ query?: unknown }>(req);
  const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
  if (q.length < 2 || q.length > 200) throw new HttpError(400, 'Type a town, city or region (2–200 characters).');

  if (PROVIDER !== 'nominatim' || !CONTACT) {
    // No provider configured: the directory still works with town/region/country text matching.
    return json({ available: false, results: [], reason: 'not_configured' });
  }

  userBurstLimit(user.id);
  // Durable per-user quota, evaluated as the user (RLS / auth.uid()). A missing RPC never blocks the search.
  const userClient = createClient(supabaseUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });
  const quota = await userClient.rpc('coaching_geocode_quota');
  if (quota.error && (quota.error.code === 'PT429' || /too many/i.test(quota.error.message))) {
    throw new HttpError(429, quota.error.message || 'Too many location searches. Please wait a few minutes.');
  }

  const lang = req.headers.get('Accept-Language')?.split(',')[0]?.trim().slice(0, 20) || null;
  try {
    return json({ available: true, results: await nominatim(q, lang) });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('geocode upstream error', e);
    return json({ available: false, results: [], reason: 'provider_down' });
  }
}));
