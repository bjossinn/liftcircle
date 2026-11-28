import { useMemo, useState } from 'react';
import { MapPin, Plus, Trash2, X } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { GeocodeResult } from '@/backend/coachingContract';
import { Button, Card, IconButton, Input, NumberInput, Segmented, Select } from '@/components/ui';
import { LIMITS, emptyArea, type AreaRow, type FormErrors } from '@/domain/coaching/application';
import { countryName, countryOptions } from '@/domain/coaching/options';
import { useT } from '@/i18n';
import { coachingError } from './common';

/** Session cache: whether the server has a geocoding provider configured (null = unknown). */
let geocodeAvailable: boolean | null = null;

export function ServiceAreasEditor({
  areas, onChange, errors, inPerson, defaultCountry, disabled,
}: {
  areas: AreaRow[];
  onChange: (a: AreaRow[]) => void;
  errors: FormErrors;
  inPerson: boolean;
  defaultCountry: string;
  disabled?: boolean;
}) {
  const { t, language } = useT();
  const [geoAvail, setGeoAvail] = useState<boolean | null>(geocodeAvailable);
  const countries = useMemo(() => countryOptions(language), [language]);
  const update = (key: string, patch: Partial<AreaRow>) => onChange(areas.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const remove = (key: string) => onChange(areas.filter((a) => a.key !== key));

  return (
    <div className="flex flex-col gap-3">
      {areas.length === 0 && <p className="text-sm text-muted px-1">{inPerson ? t('coaching.directory.add_the_towns_cities_or_regions') : t('coaching.directory.optional_for_online_coaching_add_places')}</p>}
      {areas.map((a, i) => (
        <AreaRowEditor
          key={a.key}
          index={i}
          area={a}
          countries={countries}
          errors={errors}
          inPerson={inPerson}
          geoAvail={geoAvail}
          onGeoAvail={(v) => {
            geocodeAvailable = v;
            setGeoAvail(v);
          }}
          onChange={(patch) => update(a.key, patch)}
          onRemove={() => remove(a.key)}
          disabled={disabled}
        />
      ))}
      {errors.serviceAreas && (
        <p role="alert" className="text-xs text-danger px-1">
          {errors.serviceAreas}
        </p>
      )}
      <Button size="sm" variant="outline" icon={<Plus className="size-4" />} disabled={disabled || areas.length >= LIMITS.serviceAreas} onClick={() => onChange([...areas, emptyArea(defaultCountry)])} className="self-start">
        {t('coaching.directory.add_service_area')}
      </Button>
      {geoAvail === false && (
        <p className="text-xs text-muted px-1">{t('coaching.directory.map_positions_arent_available_in_this')}</p>
      )}
    </div>
  );
}

function AreaRowEditor({
  index, area, countries, errors, inPerson, geoAvail, onGeoAvail, onChange, onRemove, disabled,
}: {
  index: number;
  area: AreaRow;
  countries: { value: string; label: string }[];
  errors: FormErrors;
  inPerson: boolean;
  geoAvail: boolean | null;
  onGeoAvail: (v: boolean) => void;
  onChange: (patch: Partial<AreaRow>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const e = (f: string) => errors[`serviceAreas.${index}.${f}`] ?? null;
  const hasGeo = area.lat != null && area.lng != null;
  // Edits to the place clear any attached position — it no longer matches what's typed.
  const editPlace = (patch: Partial<AreaRow>) => {
    setResults(null);
    onChange({ ...patch, lat: null, lng: null, radiusKm: null, label: null });
  };

  const query = [area.kind === 'city' ? area.city.trim() : '', area.kind !== 'country' ? area.region.trim() : '', area.country ? countryName(area.country, 'en') : ''].filter(Boolean).join(', ');
  const lookUp = async () => {
    if (!query || (area.kind === 'city' && !area.city.trim()) || (area.kind === 'region' && !area.region.trim())) {
      setLookupError(t('coaching.directory.fill_in_the_place_first'));
      return;
    }
    setBusy(true);
    setLookupError(null);
    try {
      const r = await coachingApi.geocode(query);
      onGeoAvail(r.available);
      setResults(r.available ? r.results : null);
    } catch (err) {
      setLookupError(coachingError(err, t('coaching.directory.couldnt_look_up_that_place')));
    } finally {
      setBusy(false);
    }
  };
  const pick = (g: GeocodeResult) => {
    setResults(null);
    onChange({
      city: area.kind === 'city' ? (g.city ?? area.city) : area.city,
      region: area.kind !== 'country' ? (g.region ?? area.region) : area.region,
      country: g.country ? g.country.toUpperCase() : area.country,
      lat: g.lat,
      lng: g.lng,
      label: g.label,
      radiusKm: area.radiusKm ?? (area.kind === 'city' ? 15 : null),
    });
  };

  return (
    <Card className="p-3 flex flex-col gap-3" role="group" aria-label={t('coaching.directory.service_area_x', { number: index + 1 })}>
      <div className="flex items-center gap-2">
        <Segmented<AreaRow['kind']>
          label={t('coaching.directory.service_area_x_type', { number: index + 1 })}
          size="sm"
          className="flex-1"
          value={area.kind}
          onChange={(kind) => editPlace({ kind })}
          options={[
            { value: 'city', label: t('coaching.directory.city_town') },
            { value: 'region', label: t('coaching.directory.region') },
            { value: 'country', label: t('coaching.directory.whole_country') },
          ]}
        />
        <IconButton label={t('coaching.directory.remove_service_area_x', { number: index + 1 })} onClick={onRemove} disabled={disabled} className="text-muted">
          <Trash2 className="size-5" />
        </IconButton>
      </div>
      {area.kind === 'city' && <Input label={t('coaching.directory.city_or_town')} value={area.city} maxLength={LIMITS.place} onChange={(ev) => editPlace({ city: ev.target.value })} error={e('city')} disabled={disabled} />}
      {area.kind !== 'country' && (
        <Input label={area.kind === 'city' ? t('coaching.directory.region_optional') : t('coaching.directory.region')} value={area.region} maxLength={LIMITS.place} onChange={(ev) => editPlace({ region: ev.target.value })} error={e('region')} disabled={disabled} />
      )}
      <Select label={t('coaching.directory.country')} value={area.country} onChange={(ev) => editPlace({ country: ev.target.value })} error={e('country')} disabled={disabled}>
        <option value="">{t('coaching.apply.choose')}</option>
        {countries.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>

      {hasGeo ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 border border-line p-3">
          <div className="flex items-start gap-2">
            <MapPin className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
            <p className="text-sm flex-1 min-w-0">
              {t('coaching.directory.map_position')} <span className="font-medium">{area.label}</span>
            </p>
            <IconButton size="sm" label={t('coaching.directory.remove_map_position')} onClick={() => onChange({ lat: null, lng: null, radiusKm: null, label: null })} disabled={disabled}>
              <X className="size-4" />
            </IconButton>
          </div>
          {inPerson && (
            <NumberInput
              label={t('coaching.directory.how_far_you_travel_for_in')}
              value={area.radiusKm}
              decimals={false}
              min={1}
              max={LIMITS.radiusKmMax}
              suffix={t('coaching.directory.km')}
              onChange={(v) => onChange({ radiusKm: v })}
              error={e('radiusKm')}
              hint={t('coaching.directory.used_for_distance_search_clients_see')}
            />
          )}
          {e('lat') && <p className="text-xs text-danger">{e('lat')}</p>}
        </div>
      ) : (
        geoAvail !== false && (
          <div className="flex flex-col gap-2">
            <Button size="sm" variant="ghost" className="self-start" icon={<MapPin className="size-4" />} loading={busy} onClick={() => void lookUp()} disabled={disabled}>
              {t('coaching.directory.find_on_map_data')}
            </Button>
            <p className="text-xs text-muted">{t('coaching.directory.optional_attach_a_map_position_so')}</p>
          </div>
        )
      )}
      {lookupError && (
        <p role="alert" className="text-xs text-danger">
          {lookupError}
        </p>
      )}
      {results && (
        <div className="rounded-xl border border-line overflow-hidden">
          {results.length === 0 ? (
            <p className="text-sm text-muted p-3">{t('coaching.directory.no_matching_places_found_the_place')}</p>
          ) : (
            <ul aria-label={t('coaching.directory.matching_places')} className="divide-y divide-line">
              {results.map((g, i) => (
                <li key={`${g.lat},${g.lng},${i}`}>
                  <button type="button" onClick={() => pick(g)} className="w-full text-left px-3 py-2.5 min-h-11 hover:bg-surface-2 text-sm">
                    {g.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
