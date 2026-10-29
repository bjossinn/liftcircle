/**
 * Coach directory search: URL state, request building, geolocation outcomes and distance display.
 * Pure — no React, no network. The browser Geolocation object is injected so the denied path is testable.
 */
import type { CoachCard, CoachSearch } from '@/backend/coachingContract';
import { isCountryCode } from './options';

export const PAGE_SIZE = 20;
export const RADIUS_OPTIONS = [10, 25, 50, 100, 250] as const;
export type FormatFilter = 'any' | 'in_person' | 'online';

/** Where a search point came from. Device positions are never written into the URL. */
export interface SearchPoint {
  lat: number;
  lng: number;
  source: 'device' | 'place';
  label?: string;
}

export interface DirectorySearchState {
  /** true once the user has run a search (results are shown). */
  searched: boolean;
  city: string;
  region: string;
  country: string;
  format: FormatFilter;
  specialty: string;
  goal: string;
  language: string;
  acceptingOnly: boolean;
  radiusKm: number | null;
  /** A geocoded place the user picked (public place coordinates — safe in the URL). */
  place: { lat: number; lng: number; label: string } | null;
  /** Number of result pages loaded, so going back restores the same list length. */
  pages: number;
}

export const emptySearch = (country = ''): DirectorySearchState => ({
  searched: false,
  city: '',
  region: '',
  country,
  format: 'any',
  specialty: '',
  goal: '',
  language: '',
  acceptingOnly: false,
  radiusKm: null,
  place: null,
  pages: 1,
});

const clip = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Round a coordinate to 2 decimals (≈1 km) before it leaves the device. */
export function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseCoord(s: string | null, max: number): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return isFinite(n) && Math.abs(n) <= max ? roundCoord(n) : null;
}

/** State → query string params (only non-default values). */
export function encodeSearch(s: DirectorySearchState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.searched) p.set('s', '1');
  if (clip(s.city)) p.set('city', clip(s.city));
  if (clip(s.region)) p.set('region', clip(s.region));
  if (s.country) p.set('country', s.country.toUpperCase());
  if (s.format !== 'any') p.set('format', s.format);
  if (s.specialty) p.set('specialty', s.specialty);
  if (s.goal) p.set('goal', s.goal);
  if (s.language) p.set('lang', s.language);
  if (s.acceptingOnly) p.set('accepting', '1');
  if (s.radiusKm != null) p.set('radius', String(s.radiusKm));
  if (s.place) {
    p.set('plat', String(roundCoord(s.place.lat)));
    p.set('plng', String(roundCoord(s.place.lng)));
    p.set('plabel', clip(s.place.label, 120));
  }
  if (s.pages > 1) p.set('pages', String(s.pages));
  return p;
}

/** Query string → state. Invalid values fall back to defaults; never throws. */
export function decodeSearch(p: URLSearchParams, defaultCountry = ''): DirectorySearchState {
  const s = emptySearch(defaultCountry);
  s.searched = p.get('s') === '1';
  s.city = clip(p.get('city'));
  s.region = clip(p.get('region'));
  const c = p.get('country');
  if (c != null) s.country = isCountryCode(c) ? c.toUpperCase() : '';
  const f = p.get('format');
  if (f === 'in_person' || f === 'online') s.format = f;
  s.specialty = clip(p.get('specialty'), 40);
  s.goal = clip(p.get('goal'), 40);
  s.language = /^[a-z]{2}$/.test(p.get('lang') ?? '') ? p.get('lang')! : '';
  s.acceptingOnly = p.get('accepting') === '1';
  const r = Number(p.get('radius'));
  s.radiusKm = p.get('radius') && (RADIUS_OPTIONS as readonly number[]).includes(r) ? r : null;
  const lat = parseCoord(p.get('plat'), 90);
  const lng = parseCoord(p.get('plng'), 180);
  if (lat != null && lng != null) s.place = { lat, lng, label: clip(p.get('plabel'), 120) };
  const pages = Math.floor(Number(p.get('pages')));
  s.pages = isFinite(pages) && pages >= 1 ? Math.min(pages, 10) : 1;
  return s;
}

/** The point distance is measured from: a picked place wins over nothing; a device position wins when present. */
export function searchPoint(s: DirectorySearchState, device: SearchPoint | null): SearchPoint | null {
  if (device) return { ...device, lat: roundCoord(device.lat), lng: roundCoord(device.lng) };
  if (s.place) return { lat: s.place.lat, lng: s.place.lng, source: 'place', label: s.place.label };
  return null;
}

/**
 * Build the API request. Radius is sent only when there are real coordinates AND the server said distance
 * works; otherwise the search is by place names.
 */
export function toCoachSearch(s: DirectorySearchState, point: SearchPoint | null, opts: { distanceAvailable: boolean; offset?: number; limit?: number }): CoachSearch {
  const q: CoachSearch = {
    format: s.format,
    acceptingOnly: s.acceptingOnly || undefined,
    limit: opts.limit ?? PAGE_SIZE,
    offset: opts.offset ?? 0,
  };
  if (clip(s.city)) q.city = clip(s.city);
  if (clip(s.region)) q.region = clip(s.region);
  if (s.country) q.country = s.country;
  if (s.specialty) q.specialty = s.specialty;
  if (s.goal) q.goal = s.goal;
  if (s.language) q.language = s.language;
  if (point) {
    q.lat = roundCoord(point.lat);
    q.lng = roundCoord(point.lng);
    if (opts.distanceAvailable && s.radiusKm != null) q.radiusKm = s.radiusKm;
  }
  return q;
}

export function radiusUsable(point: SearchPoint | null, distanceAvailable: boolean): boolean {
  return !!point && distanceAvailable;
}

/** "about 12 km" — or null when the server could not calculate a distance. Never invented. */
export function distanceText(km: number | null | undefined): string | null {
  if (km == null || !isFinite(km) || km < 0) return null;
  if (km < 1) return 'less than 1 km away';
  const r = km < 10 ? Math.round(km) : km < 100 ? Math.round(km / 5) * 5 : Math.round(km / 10) * 10;
  return `about ${r} km away`;
}

export function splitResults(items: CoachCard[]): { local: CoachCard[]; remote: CoachCard[] } {
  const local: CoachCard[] = [];
  const remote: CoachCard[] = [];
  for (const c of items) (c.match === 'local' ? local : remote).push(c);
  return { local, remote };
}

/** De-duplicate when "Load more" pages overlap (e.g. a coach was added between requests). */
export function mergePages(prev: CoachCard[], next: CoachCard[]): CoachCard[] {
  const seen = new Set(prev.map((c) => c.userId));
  return [...prev, ...next.filter((c) => !seen.has(c.userId))];
}

export function placeLabel(s: DirectorySearchState, point: SearchPoint | null, countryName: (c: string) => string): string {
  if (point?.source === 'device') return 'your location';
  if (s.place?.label) return s.place.label;
  const parts = [clip(s.city), clip(s.region), s.country ? countryName(s.country) : ''].filter(Boolean);
  return parts.join(', ');
}

/* ------------------------------------------------------------ geolocation */
export type GeoOutcome =
  | { ok: true; point: SearchPoint }
  | { ok: false; reason: 'denied' | 'unavailable' | 'timeout' | 'unsupported'; message: string };

const GEO_MESSAGES: Record<Exclude<GeoOutcome, { ok: true }>['reason'], string> = {
  denied: 'Location permission was declined. You can still search by typing a city or region.',
  unavailable: 'Your location isn’t available right now. Type a city or region instead.',
  timeout: 'Finding your location took too long. Try again, or type a city or region.',
  unsupported: 'This browser can’t share your location. Type a city or region instead.',
};

export function geoFailure(reason: Exclude<GeoOutcome, { ok: true }>['reason']): GeoOutcome {
  return { ok: false, reason, message: GEO_MESSAGES[reason] };
}

/** Map a GeolocationPositionError code (1 denied, 2 unavailable, 3 timeout). */
export function geoErrorOutcome(code: number | undefined): GeoOutcome {
  return geoFailure(code === 1 ? 'denied' : code === 3 ? 'timeout' : 'unavailable');
}

/**
 * Ask for the device position ONCE (call only from a user tap). Coordinates are rounded to 2 decimals
 * immediately; the precise position is never kept.
 */
export function requestDeviceLocation(geo: Pick<Geolocation, 'getCurrentPosition'> | undefined | null, timeoutMs = 10_000): Promise<GeoOutcome> {
  if (!geo || typeof geo.getCurrentPosition !== 'function') return Promise.resolve(geoFailure('unsupported'));
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: GeoOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve(o);
    };
    // Some browsers never call back when the prompt is dismissed; don't leave the button spinning.
    const guard = setTimeout(() => finish(geoFailure('timeout')), timeoutMs + 2000);
    try {
      geo.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          if (!isFinite(lat) || !isFinite(lng)) return finish(geoFailure('unavailable'));
          finish({ ok: true, point: { lat: roundCoord(lat), lng: roundCoord(lng), source: 'device' } });
        },
        (err) => finish(geoErrorOutcome(err?.code)),
        { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: timeoutMs },
      );
    } catch {
      finish(geoFailure('unavailable'));
    }
  });
}
