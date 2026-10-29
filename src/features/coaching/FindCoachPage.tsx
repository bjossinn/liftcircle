import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronDown, Crosshair, Globe, Loader2, MapPin, Search, SlidersHorizontal, X } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { CoachCard, GeocodeResult } from '@/backend/coachingContract';
import { Button, EmptyState, ErrorState, IconButton, Input, Notice, Page, Segmented, Select, SectionTitle, Spinner, Toggle } from '@/components/ui';
import { useApp } from '@/state/app';
import { COACH_GOALS, SPECIALTIES, countryFromTimeZone, countryName, countryOptions, languageOptions } from '@/domain/coaching/options';
import {
  PAGE_SIZE, RADIUS_OPTIONS, decodeSearch, encodeSearch, mergePages, placeLabel, radiusUsable, requestDeviceLocation, searchPoint, splitResults, toCoachSearch,
  type DirectorySearchState, type FormatFilter, type SearchPoint,
} from '@/domain/coaching/search';
import { CoachCardView } from './directory/CoachCardView';
import { CoachingAccessNotice, coachingError, useCoachingAccess } from './directory/common';
import { PublicFindCoach } from './directory/PublicDirectory';

/** Per-session knowledge about optional server capabilities (null = not yet known). */
let geocodeAvailableCache: boolean | null = null;
let distanceAvailableCache: boolean | null = null;

interface NavState {
  devicePoint?: SearchPoint;
}

export default function FindCoachPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  return (
    <Page
      title="Find a coach"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access === 'guest' ? <PublicFindCoach /> : access !== 'ok' ? <CoachingAccessNotice access={access} /> : <FindContent />}
    </Page>
  );
}

interface Results {
  items: CoachCard[];
  distanceAvailable: boolean;
  hasMore: boolean;
}

export function FindContent() {
  const { account } = useApp();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const defaultCountry = useMemo(() => countryFromTimeZone(account.settings.timeZone), [account.settings.timeZone]);
  const applied = useMemo(() => decodeSearch(params, defaultCountry), [params, defaultCountry]);
  const navState = (location.state as NavState | null) ?? null;
  const appliedDevice = navState?.devicePoint ?? null;
  const appliedPoint = searchPoint(applied, appliedDevice);
  // Everything except the page count: changing it means a new search.
  const queryKey = `${encodeSearch({ ...applied, pages: 1 }).toString()}|${appliedDevice ? `${appliedDevice.lat},${appliedDevice.lng}` : ''}`;

  const [form, setForm] = useState<DirectorySearchState>(applied);
  const [device, setDevice] = useState<SearchPoint | null>(appliedDevice);
  const [filtersOpen, setFiltersOpen] = useState(() => !!(applied.specialty || applied.goal || applied.language || applied.acceptingOnly || applied.radiusKm));
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [distanceAvailable, setDistanceAvailable] = useState<boolean | null>(distanceAvailableCache);

  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  const [geocodeAvailable, setGeocodeAvailable] = useState<boolean | null>(geocodeAvailableCache);
  const [lookingUp, setLookingUp] = useState(false);
  const [suggestions, setSuggestions] = useState<GeocodeResult[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Back/forward restores the committed search into the form.
  useEffect(() => {
    setForm(applied);
    setDevice(appliedDevice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  // Run the committed search.
  useEffect(() => {
    if (!applied.searched) {
      setResults(null);
      setError(null);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    setMoreError(null);
    const limit = PAGE_SIZE * applied.pages;
    coachingApi
      .searchCoaches(toCoachSearch(applied, appliedPoint, { distanceAvailable: distanceAvailableCache === true, offset: 0, limit }))
      .then((r) => {
        if (stale) return;
        distanceAvailableCache = r.distanceAvailable;
        setDistanceAvailable(r.distanceAvailable);
        setResults({ items: r.items, distanceAvailable: r.distanceAvailable, hasMore: r.items.length >= limit });
      })
      .catch((e) => {
        if (!stale) setError(coachingError(e, 'Couldn’t search for coaches.'));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retryTick]);

  const commit = (next: DirectorySearchState, nextDevice: SearchPoint | null, replace = false) => {
    setSuggestions(null);
    setParams(encodeSearch({ ...next, searched: true, pages: 1 }), { replace, state: nextDevice ? ({ devicePoint: nextDevice } satisfies NavState) : null });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    commit(form, device);
  };

  const loadMore = async () => {
    if (!results) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await coachingApi.searchCoaches(toCoachSearch(applied, appliedPoint, { distanceAvailable: results.distanceAvailable, offset: results.items.length, limit: PAGE_SIZE }));
      setResults((prev) => (prev ? { ...prev, items: mergePages(prev.items, r.items), hasMore: r.items.length >= PAGE_SIZE } : prev));
      // Remember how far the list goes so "back" restores it (no new search).
      setParams(encodeSearch({ ...applied, pages: applied.pages + 1 }), { replace: true, state: navState });
    } catch (e) {
      setMoreError(coachingError(e, 'Couldn’t load more coaches.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const useMyLocation = async () => {
    setLocating(true);
    setGeoMessage(null);
    const outcome = await requestDeviceLocation(typeof navigator !== 'undefined' ? navigator.geolocation : undefined);
    setLocating(false);
    if (!outcome.ok) {
      setGeoMessage(outcome.message);
      return;
    }
    setDevice(outcome.point);
    const next = { ...form, place: null };
    setForm(next);
    commit(next, outcome.point);
  };

  const clearDevice = () => {
    setDevice(null);
    setGeoMessage(null);
    if (applied.searched) commit({ ...form, radiusKm: null }, null);
  };

  const placeQuery = [form.city.trim(), form.region.trim(), form.country ? countryName(form.country) : ''].filter(Boolean).join(', ');
  const lookUpPlace = async () => {
    if (!form.city.trim() && !form.region.trim()) {
      setLookupError('Type a city, town or region first.');
      return;
    }
    setLookingUp(true);
    setLookupError(null);
    setSuggestions(null);
    try {
      const r = await coachingApi.geocode(placeQuery);
      geocodeAvailableCache = r.available;
      setGeocodeAvailable(r.available);
      if (r.available) setSuggestions(r.results);
    } catch (e) {
      setLookupError(coachingError(e, 'Couldn’t look up that place. You can still search by name.'));
    } finally {
      setLookingUp(false);
    }
  };

  const pickSuggestion = (g: GeocodeResult) => {
    const next: DirectorySearchState = {
      ...form,
      city: g.city ?? form.city,
      region: g.region ?? form.region,
      country: g.country ? g.country.toUpperCase() : form.country,
      place: { lat: g.lat, lng: g.lng, label: g.label },
    };
    setForm(next);
    setDevice(null);
    commit(next, null);
  };

  // Typing a different place invalidates a picked suggestion's coordinates.
  const editPlace = (patch: Partial<Pick<DirectorySearchState, 'city' | 'region' | 'country'>>) => {
    setForm((f) => ({ ...f, ...patch, place: null }));
    setSuggestions(null);
    setLookupError(null);
  };

  const formPoint = searchPoint(form, device);
  const radiusOn = radiusUsable(formPoint, distanceAvailable === true);
  const countries = useMemo(countryOptions, []);
  const languages = useMemo(languageOptions, []);
  const activeFilters = [form.specialty, form.goal, form.language, form.acceptingOnly, radiusOn && form.radiusKm].filter(Boolean).length;
  const split = results ? splitResults(results.items) : null;
  const near = placeLabel(applied, appliedPoint, countryName);

  return (
    <>
      <form onSubmit={submit} noValidate aria-label="Search for coaches" className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="City or town" value={form.city} maxLength={80} autoComplete="address-level2" onChange={(e) => editPlace({ city: e.target.value })} />
          <Input label="Region (optional)" value={form.region} maxLength={80} autoComplete="address-level1" onChange={(e) => editPlace({ region: e.target.value })} />
        </div>
        <Select label="Country" value={form.country} onChange={(e) => editPlace({ country: e.target.value })}>
          <option value="">Any country</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>

        {form.place && (
          <p className="text-xs text-muted inline-flex items-center gap-1.5">
            <MapPin className="size-3.5 text-accent" aria-hidden /> Using {form.place.label}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {geocodeAvailable !== false && (
            <Button size="sm" variant="outline" icon={<MapPin className="size-4" />} loading={lookingUp} onClick={() => void lookUpPlace()}>
              Find this place
            </Button>
          )}
          {device ? (
            <Button size="sm" variant="outline" icon={<X className="size-4" />} onClick={clearDevice}>
              Stop using my location
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon={locating ? <Loader2 className="size-4 animate-spin" /> : <Crosshair className="size-4" />} disabled={locating} onClick={() => void useMyLocation()}>
              {locating ? 'Finding you…' : 'Use my location'}
            </Button>
          )}
        </div>
        {device && <p className="text-xs text-muted">Using your approximate location (about 1 km). It’s only used for this search and isn’t saved.</p>}
        {geoMessage && (
          <Notice tone="warn">
            <span role="status">{geoMessage}</span>
          </Notice>
        )}
        {geocodeAvailable === false && <p className="text-xs text-muted">Coaches are matched by the place names you type.</p>}
        {lookupError && (
          <p role="alert" className="text-xs text-danger">
            {lookupError}
          </p>
        )}
        {suggestions && (
          <div className="rounded-xl border border-line bg-surface overflow-hidden">
            {suggestions.length === 0 ? (
              <p className="text-sm text-muted p-3">No matching places found. You can still search by the name you typed.</p>
            ) : (
              <ul aria-label="Suggested places" className="divide-y divide-line">
                {suggestions.map((g, i) => (
                  <li key={`${g.lat},${g.lng},${i}`}>
                    <button type="button" onClick={() => pickSuggestion(g)} className="w-full text-left px-3 py-2.5 min-h-11 hover:bg-surface-2 flex items-center gap-2 text-sm">
                      <MapPin className="size-4 text-muted shrink-0" aria-hidden />
                      <span className="min-w-0">{g.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Segmented<FormatFilter>
          label="Coaching format"
          value={form.format}
          onChange={(v) => setForm((f) => ({ ...f, format: v }))}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'in_person', label: 'In person' },
            { value: 'online', label: 'Online' },
          ]}
        />

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-controls="coach-filters"
          className="flex items-center gap-2 min-h-11 text-sm font-medium text-ink"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          More filters{activeFilters ? ` (${activeFilters})` : ''}
          <ChevronDown className={`size-4 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        <div id="coach-filters" hidden={!filtersOpen} className="flex flex-col gap-3">
          <Select label="Specialty" value={form.specialty} onChange={(e) => setForm((f) => ({ ...f, specialty: e.target.value }))}>
            <option value="">Any specialty</option>
            {SPECIALTIES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Goal" value={form.goal} onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}>
            <option value="">Any goal</option>
            {COACH_GOALS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Language" value={form.language} onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}>
            <option value="">Any language</option>
            {languages.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Toggle label="Accepting new clients" description="Only show coaches who are taking on new clients now." checked={form.acceptingOnly} onChange={(v) => setForm((f) => ({ ...f, acceptingOnly: v }))} />
          <Select
            label="Distance"
            value={radiusOn && form.radiusKm != null ? String(form.radiusKm) : ''}
            disabled={!radiusOn}
            onChange={(e) => setForm((f) => ({ ...f, radiusKm: e.target.value ? Number(e.target.value) : null }))}
            hint={
              !formPoint
                ? 'To filter by distance, use your location or pick a suggested place.'
                : distanceAvailable === false
                  ? 'Distance search isn’t available — showing matches by place.'
                  : distanceAvailable == null
                    ? 'Search once to check whether distance filtering is available.'
                    : undefined
            }
          >
            <option value="">Any distance</option>
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                Within {r} km
              </option>
            ))}
          </Select>
        </div>

        <Button type="submit" variant="primary" block icon={<Search className="size-4" />} loading={loading && !results}>
          Search
        </Button>
      </form>

      <p className="text-xs text-muted mt-3 px-1">Every coach listed here has been approved by the LiftCircle team. Approval isn’t a check of qualifications unless a profile says a qualification was reviewed.</p>

      <div aria-live="polite" className="sr-only">
        {results && !loading ? `${results.items.length} coach${results.items.length === 1 ? '' : 'es'} found` : ''}
      </div>

      {!applied.searched ? (
        <EmptyState
          icon={<Search className="size-6" aria-hidden />}
          title="Search your area or anywhere"
          body="Type a city or region, or use your location. Online coaches can work with you wherever you are."
          action={
            <Button variant="outline" icon={<Globe className="size-4" />} onClick={() => commit({ ...form, format: 'online' }, device)}>
              Browse online coaches
            </Button>
          }
        />
      ) : error ? (
        <ErrorState title="Couldn’t search for coaches" message={error} onRetry={() => setRetryTick((n) => n + 1)} />
      ) : loading || !results || !split ? (
        <Spinner label="Searching" />
      ) : results.items.length === 0 ? (
        <EmptyState
          icon={<Search className="size-6" aria-hidden />}
          title="No coaches match yet"
          body="Try a nearby city or just the region, remove a filter, or include online coaches."
          action={
            applied.format !== 'any' || applied.specialty || applied.goal || applied.language || applied.acceptingOnly || applied.radiusKm ? (
              <Button
                variant="outline"
                onClick={() => {
                  const next = { ...form, format: 'any' as const, specialty: '', goal: '', language: '', acceptingOnly: false, radiusKm: null };
                  setForm(next);
                  commit(next, device);
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {appliedPoint && results.distanceAvailable === false && (
            <Notice className="mt-4">Distance search isn’t available — showing matches by place.</Notice>
          )}
          {split.local.length > 0 && (
            <section aria-labelledby="near-heading">
              <SectionTitle id="near-heading">{near ? `Near ${near}` : 'Coaches in your search area'}</SectionTitle>
              <ul className="flex flex-col gap-2">
                {split.local.map((c) => (
                  <CoachCardView key={c.userId} coach={c} />
                ))}
              </ul>
            </section>
          )}
          {split.remote.length > 0 && (
            <section aria-labelledby="online-heading">
              <SectionTitle id="online-heading">Online coaches</SectionTitle>
              <p className="text-xs text-muted px-1 -mt-1 mb-2">These coaches work with clients remotely, wherever you are.</p>
              <ul className="flex flex-col gap-2">
                {split.remote.map((c) => (
                  <CoachCardView key={c.userId} coach={c} />
                ))}
              </ul>
            </section>
          )}
          {split.local.length === 0 && near && applied.format !== 'online' && (
            <p className="text-sm text-muted px-1 mt-3">
              No coaches list {near} as a service area yet.
            </p>
          )}
          {moreError && (
            <p role="alert" className="text-sm text-danger mt-3 px-1">
              {moreError}
            </p>
          )}
          {results.hasMore && (
            <Button block className="mt-4" loading={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
        </>
      )}
    </>
  );
}
