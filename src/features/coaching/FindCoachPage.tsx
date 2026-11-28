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
import { useT } from '@/i18n';

/** Per-session knowledge about optional server capabilities (null = not yet known). */
let geocodeAvailableCache: boolean | null = null;
let distanceAvailableCache: boolean | null = null;

interface NavState {
  devicePoint?: SearchPoint;
}

export default function FindCoachPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const { t } = useT();
  return (
    <Page
      title={t('nav.findCoach')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
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
  const { t, tp, language } = useT();
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
        if (!stale) setError(coachingError(e, t('coaching.directory.couldnt_search_for_coaches')));
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
      setMoreError(coachingError(e, t('coaching.directory.couldnt_load_more_coaches')));
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

  // Geocoder query: country in English (a lookup string, not display text).
  const placeQuery = [form.city.trim(), form.region.trim(), form.country ? countryName(form.country, 'en') : ''].filter(Boolean).join(', ');
  const lookUpPlace = async () => {
    if (!form.city.trim() && !form.region.trim()) {
      setLookupError(t('coaching.directory.type_a_city_town_or_region_first'));
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
      setLookupError(coachingError(e, t('coaching.directory.couldnt_look_up_that_place_search_by_name')));
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
  const countries = useMemo(() => countryOptions(language), [language]);
  const languages = useMemo(() => languageOptions(language), [language]);
  const activeFilters = [form.specialty, form.goal, form.language, form.acceptingOnly, radiusOn && form.radiusKm].filter(Boolean).length;
  const split = results ? splitResults(results.items) : null;
  const near = placeLabel(applied, appliedPoint, (c) => countryName(c, language));

  return (
    <>
      <form onSubmit={submit} noValidate aria-label={t('coaching.directory.search_for_coaches')} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label={t('coaching.directory.city_or_town')} value={form.city} maxLength={80} autoComplete="address-level2" onChange={(e) => editPlace({ city: e.target.value })} />
          <Input label={t('coaching.directory.region_optional')} value={form.region} maxLength={80} autoComplete="address-level1" onChange={(e) => editPlace({ region: e.target.value })} />
        </div>
        <Select label={t('coaching.directory.country')} value={form.country} onChange={(e) => editPlace({ country: e.target.value })}>
          <option value="">{t('coaching.directory.any_country')}</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>

        {form.place && (
          <p className="text-xs text-muted inline-flex items-center gap-1.5">
            <MapPin className="size-3.5 text-accent" aria-hidden /> {t('coaching.directory.using_x', { place: form.place.label })}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {geocodeAvailable !== false && (
            <Button size="sm" variant="outline" icon={<MapPin className="size-4" />} loading={lookingUp} onClick={() => void lookUpPlace()}>
              {t('coaching.directory.find_this_place')}
            </Button>
          )}
          {device ? (
            <Button size="sm" variant="outline" icon={<X className="size-4" />} onClick={clearDevice}>
              {t('coaching.directory.stop_using_my_location')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon={locating ? <Loader2 className="size-4 animate-spin" /> : <Crosshair className="size-4" />} disabled={locating} onClick={() => void useMyLocation()}>
              {locating ? t('coaching.directory.finding_you') : t('coaching.directory.use_my_location')}
            </Button>
          )}
        </div>
        {device && <p className="text-xs text-muted">{t('coaching.directory.using_your_approximate_location_about_1')}</p>}
        {geoMessage && (
          <Notice tone="warn">
            <span role="status">{geoMessage}</span>
          </Notice>
        )}
        {geocodeAvailable === false && <p className="text-xs text-muted">{t('coaching.directory.coaches_are_matched_by_the_place')}</p>}
        {lookupError && (
          <p role="alert" className="text-xs text-danger">
            {lookupError}
          </p>
        )}
        {suggestions && (
          <div className="rounded-xl border border-line bg-surface overflow-hidden">
            {suggestions.length === 0 ? (
              <p className="text-sm text-muted p-3">{t('coaching.directory.no_matching_places_found_you_can')}</p>
            ) : (
              <ul aria-label={t('coaching.directory.suggested_places')} className="divide-y divide-line">
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
          label={t('coaching.directory.coaching_format')}
          value={form.format}
          onChange={(v) => setForm((f) => ({ ...f, format: v }))}
          options={[
            { value: 'any', label: t('coaching.directory.any') },
            { value: 'in_person', label: t('coaching.directory.in_person') },
            { value: 'online', label: t('coaching.directory.online') },
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
          {t('coaching.directory.more_filters')}
          {activeFilters ? ` (${activeFilters})` : ''}
          <ChevronDown className={`size-4 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        <div id="coach-filters" hidden={!filtersOpen} className="flex flex-col gap-3">
          <Select label={t('coaching.directory.specialty')} value={form.specialty} onChange={(e) => setForm((f) => ({ ...f, specialty: e.target.value }))}>
            <option value="">{t('coaching.directory.any_specialty')}</option>
            {SPECIALTIES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label={t('coaching.directory.goal')} value={form.goal} onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}>
            <option value="">{t('coaching.directory.any_goal')}</option>
            {COACH_GOALS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label={t('settings.languageTitle')} value={form.language} onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}>
            <option value="">{t('coaching.directory.any_language')}</option>
            {languages.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Toggle label={t('coaching.apply.accepting_new_clients')} description={t('coaching.directory.only_show_coaches_who_are_taking')} checked={form.acceptingOnly} onChange={(v) => setForm((f) => ({ ...f, acceptingOnly: v }))} />
          <Select
            label={t('workout.share.distance')}
            value={radiusOn && form.radiusKm != null ? String(form.radiusKm) : ''}
            disabled={!radiusOn}
            onChange={(e) => setForm((f) => ({ ...f, radiusKm: e.target.value ? Number(e.target.value) : null }))}
            hint={
              !formPoint
                ? t('coaching.directory.to_filter_by_distance_use_your')
                : distanceAvailable === false
                  ? t('coaching.directory.distance_search_isnt_available_showing_matches')
                  : distanceAvailable == null
                    ? t('coaching.directory.search_once_to_check_whether_distance')
                    : undefined
            }
          >
            <option value="">{t('coaching.directory.any_distance')}</option>
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {t('coaching.directory.within_x_km', { km: r })}
              </option>
            ))}
          </Select>
        </div>

        <Button type="submit" variant="primary" block icon={<Search className="size-4" />} loading={loading && !results}>
          {t('coaching.directory.search')}
        </Button>
      </form>

      <p className="text-xs text-muted mt-3 px-1">{t('coaching.directory.every_coach_listed_here_has_been')}</p>

      <div aria-live="polite" className="sr-only">
        {results && !loading ? tp('coaching.directory.coaches_found', results.items.length) : ''}
      </div>

      {!applied.searched ? (
        <EmptyState
          icon={<Search className="size-6" aria-hidden />}
          title={t('coaching.directory.search_your_area_or_anywhere')}
          body={t('coaching.directory.type_a_city_or_region_or')}
          action={
            <Button variant="outline" icon={<Globe className="size-4" />} onClick={() => commit({ ...form, format: 'online' }, device)}>
              {t('coaching.directory.browse_online_coaches')}
            </Button>
          }
        />
      ) : error ? (
        <ErrorState title={t('coaching.directory.couldnt_search_for_coaches')} message={error} onRetry={() => setRetryTick((n) => n + 1)} />
      ) : loading || !results || !split ? (
        <Spinner label={t('coaching.directory.searching')} />
      ) : results.items.length === 0 ? (
        <EmptyState
          icon={<Search className="size-6" aria-hidden />}
          title={t('coaching.directory.no_coaches_match_yet')}
          body={t('coaching.directory.try_a_nearby_city_or_just')}
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
                {t('coaching.directory.clear_filters')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {appliedPoint && results.distanceAvailable === false && (
            <Notice className="mt-4">{t('coaching.directory.distance_search_isnt_available_showing_matches')}</Notice>
          )}
          {split.local.length > 0 && (
            <section aria-labelledby="near-heading">
              <SectionTitle id="near-heading">{near ? t('coaching.directory.near_x', { place: near }) : t('coaching.directory.coaches_in_your_search_area')}</SectionTitle>
              <ul className="flex flex-col gap-2">
                {split.local.map((c) => (
                  <CoachCardView key={c.userId} coach={c} />
                ))}
              </ul>
            </section>
          )}
          {split.remote.length > 0 && (
            <section aria-labelledby="online-heading">
              <SectionTitle id="online-heading">{t('coaching.directory.online_coaches')}</SectionTitle>
              <p className="text-xs text-muted px-1 -mt-1 mb-2">{t('coaching.directory.these_coaches_work_with_clients_remotely')}</p>
              <ul className="flex flex-col gap-2">
                {split.remote.map((c) => (
                  <CoachCardView key={c.userId} coach={c} />
                ))}
              </ul>
            </section>
          )}
          {split.local.length === 0 && near && applied.format !== 'online' && (
            <p className="text-sm text-muted px-1 mt-3">
              {t('coaching.directory.no_coaches_list_x_as_a_service_area', { place: near })}
            </p>
          )}
          {moreError && (
            <p role="alert" className="text-sm text-danger mt-3 px-1">
              {moreError}
            </p>
          )}
          {results.hasMore && (
            <Button block className="mt-4" loading={loadingMore} onClick={() => void loadMore()}>
              {t('social.load_more')}
            </Button>
          )}
        </>
      )}
    </>
  );
}
