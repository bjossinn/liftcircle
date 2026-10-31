import { useMemo, useState } from 'react';
import { MapPin, Plus, Trash2, X } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { GeocodeResult } from '@/backend/coachingContract';
import { Button, Card, IconButton, Input, NumberInput, Segmented, Select } from '@/components/ui';
import { LIMITS, emptyArea, type AreaRow, type FormErrors } from '@/domain/coaching/application';
import { countryName, countryOptions } from '@/domain/coaching/options';
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
  const [geoAvail, setGeoAvail] = useState<boolean | null>(geocodeAvailable);
  const countries = useMemo(countryOptions, []);
  const update = (key: string, patch: Partial<AreaRow>) => onChange(areas.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const remove = (key: string) => onChange(areas.filter((a) => a.key !== key));

  return (
    <div className="flex flex-col gap-3">
      {areas.length === 0 && <p className="text-sm text-muted px-1">{inPerson ? 'Add the towns, cities or regions where you meet clients in person.' : 'Optional for online coaching. Add places you’d like to be found for.'}</p>}
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
        Add service area
      </Button>
      {geoAvail === false && (
        <p className="text-xs text-muted px-1">Map positions aren’t available in this version, so clients find you by the place names you enter. Distance search will work once map data is available.</p>
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

  const query = [area.kind === 'city' ? area.city.trim() : '', area.kind !== 'country' ? area.region.trim() : '', area.country ? countryName(area.country) : ''].filter(Boolean).join(', ');
  const lookUp = async () => {
    if (!query || (area.kind === 'city' && !area.city.trim()) || (area.kind === 'region' && !area.region.trim())) {
      setLookupError('Fill in the place first.');
      return;
    }
    setBusy(true);
    setLookupError(null);
    try {
      const r = await coachingApi.geocode(query);
      onGeoAvail(r.available);
      setResults(r.available ? r.results : null);
    } catch (err) {
      setLookupError(coachingError(err, 'Couldn’t look up that place.'));
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
    <Card className="p-3 flex flex-col gap-3" role="group" aria-label={`Service area ${index + 1}`}>
      <div className="flex items-center gap-2">
        <Segmented<AreaRow['kind']>
          label={`Service area ${index + 1} type`}
          size="sm"
          className="flex-1"
          value={area.kind}
          onChange={(kind) => editPlace({ kind })}
          options={[
            { value: 'city', label: 'City / town' },
            { value: 'region', label: 'Region' },
            { value: 'country', label: 'Whole country' },
          ]}
        />
        <IconButton label={`Remove service area ${index + 1}`} onClick={onRemove} disabled={disabled} className="text-muted">
          <Trash2 className="size-5" />
        </IconButton>
      </div>
      {area.kind === 'city' && <Input label="City or town" value={area.city} maxLength={LIMITS.place} onChange={(ev) => editPlace({ city: ev.target.value })} error={e('city')} disabled={disabled} />}
      {area.kind !== 'country' && (
        <Input label={area.kind === 'city' ? 'Region (optional)' : 'Region'} value={area.region} maxLength={LIMITS.place} onChange={(ev) => editPlace({ region: ev.target.value })} error={e('region')} disabled={disabled} />
      )}
      <Select label="Country" value={area.country} onChange={(ev) => editPlace({ country: ev.target.value })} error={e('country')} disabled={disabled}>
        <option value="">Choose…</option>
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
              Map position: <span className="font-medium">{area.label}</span>
            </p>
            <IconButton size="sm" label="Remove map position" onClick={() => onChange({ lat: null, lng: null, radiusKm: null, label: null })} disabled={disabled}>
              <X className="size-4" />
            </IconButton>
          </div>
          {inPerson && (
            <NumberInput
              label="How far you travel for in-person sessions"
              value={area.radiusKm}
              decimals={false}
              min={1}
              max={LIMITS.radiusKmMax}
              suffix="km"
              onChange={(v) => onChange({ radiusKm: v })}
              error={e('radiusKm')}
              hint="Used for distance search. Clients see the place name and this distance, never an exact address."
            />
          )}
          {e('lat') && <p className="text-xs text-danger">{e('lat')}</p>}
        </div>
      ) : (
        geoAvail !== false && (
          <div className="flex flex-col gap-2">
            <Button size="sm" variant="ghost" className="self-start" icon={<MapPin className="size-4" />} loading={busy} onClick={() => void lookUp()} disabled={disabled}>
              Find on map data
            </Button>
            <p className="text-xs text-muted">Optional: attach a map position so clients nearby can find you by distance.</p>
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
            <p className="text-sm text-muted p-3">No matching places found. The place name alone still works for search.</p>
          ) : (
            <ul aria-label="Matching places" className="divide-y divide-line">
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
