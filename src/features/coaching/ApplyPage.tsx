import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router';
import { Camera, ChevronLeft, History, Loader2, ShieldCheck } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { CoachFormat, CoachProfile, ReviewEvent } from '@/backend/coachingContract';
import { Badge, Button, Card, ChipGroup, ConfirmDialog, ErrorState, IconButton, Input, Notice, NumberInput, Page, SectionTitle, Select, Spinner, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { MediaError, mediaErrorMessage, processAvatar } from '@/social/media';
import {
  LIMITS, canSubmitFrom, changedApprovedQualifications, formFromProfile, formToInput, submitProblems, validateDraft, type ApplicationForm, type FormErrors,
} from '@/domain/coaching/application';
import { EVENT_LABELS, STATUS_LABELS, STATUS_TONE, dateText } from '@/domain/coaching/display';
import { COACH_GOALS, FORMAT_LABELS, SPECIALTIES, countryFromTimeZone, countryOptions, languageName, languageOptions, specialtyLabel } from '@/domain/coaching/options';
import { CoachPhoto, CoachingAccessNotice, coachingError, useCoachingAccess, useLoad } from './directory/common';
import { ServiceAreasEditor } from './directory/ServiceAreasEditor';
import { QualificationsEditor } from './directory/QualificationsEditor';

export default function ApplyPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const profile = useLoad(() => coachingApi.getMyCoachProfile(), [], { enabled: access === 'ok', fallback: 'Couldn’t load your application.' });
  const title = profile.data?.status === 'approved' ? 'Coach profile' : 'Apply to be listed';
  return (
    <Page
      title={title}
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : profile.loading && profile.data === undefined ? (
        <Spinner label="Loading your application" />
      ) : profile.error && profile.data === undefined ? (
        <ErrorState title="Couldn’t load your application" message={profile.error} onRetry={profile.reload} />
      ) : (
        <ApplyForm initial={profile.data ?? null} />
      )}
    </Page>
  );
}

const sameInput = (a: ApplicationForm, b: ApplicationForm) => JSON.stringify(formToInput(a)) === JSON.stringify(formToInput(b));

function ApplyForm({ initial }: { initial: CoachProfile | null }) {
  const toast = useToast();
  const { account } = useApp();
  const defaultCountry = useMemo(() => countryFromTimeZone(account.settings.timeZone), [account.settings.timeZone]);
  const [original, setOriginal] = useState<CoachProfile | null>(initial);
  const baseline = useMemo(() => formFromProfile(original, { displayName: account.profile.displayName, country: defaultCountry }), [original, account.profile.displayName, defaultCountry]);
  const [form, setForm] = useState<ApplicationForm>(baseline);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmQualChange, setConfirmQualChange] = useState<null | 'save' | 'submit'>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const events = useLoad(() => coachingApi.myReviewEvents(), [original?.updatedAt ?? '', original?.status ?? '']);

  useEffect(() => () => void (photoPreview && URL.revokeObjectURL(photoPreview)), [photoPreview]);

  const status = original?.status ?? null;
  const approved = status === 'approved';
  const dirty = !sameInput(form, baseline);
  const changedQuals = changedApprovedQualifications(form, original);
  const busy = saving || submitting;
  const set = <K extends keyof ApplicationForm>(k: K, v: ApplicationForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !busy && currentLocation.pathname !== nextLocation.pathname);

  const showErrors = (errs: FormErrors) => {
    setErrors(errs);
    if (Object.keys(errs).length) requestAnimationFrame(() => errorRef.current?.focus());
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const blob = await processAvatar(file);
      const path = await coachingApi.uploadCoachPhoto(blob);
      setPhotoPreview(URL.createObjectURL(blob));
      set('photoPath', path);
    } catch (e) {
      setPhotoError(e instanceof MediaError ? mediaErrorMessage(e) : coachingError(e, 'The photo couldn’t be uploaded. Please try again.'));
    } finally {
      setPhotoBusy(false);
    }
  };

  /** Saves when there are changes; returns the latest profile or null on failure. */
  const persist = async (): Promise<CoachProfile | null> => {
    if (!dirty && original) return original;
    const errs = validateDraft(form);
    if (Object.keys(errs).length) {
      showErrors(errs);
      return null;
    }
    const saved = await coachingApi.saveMyCoachProfile(formToInput(form));
    setOriginal(saved);
    setForm(formFromProfile(saved));
    return saved;
  };

  const save = async (confirmed = false) => {
    setServerError(null);
    if (!confirmed && changedQuals.length) return setConfirmQualChange('save');
    setSaving(true);
    try {
      const saved = await persist();
      if (saved) {
        setErrors({});
        toast.show(approved ? 'Profile saved' : 'Draft saved', { tone: 'success' });
      }
    } catch (e) {
      setServerError(coachingError(e, 'Couldn’t save. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const submit = async (confirmed = false) => {
    setServerError(null);
    const errs = submitProblems(form);
    if (Object.keys(errs).length) return showErrors(errs);
    if (!confirmed && changedQuals.length) return setConfirmQualChange('submit');
    setSubmitting(true);
    try {
      const saved = await persist();
      if (!saved) return;
      const submitted = await coachingApi.submitApplication();
      setOriginal(submitted);
      setForm(formFromProfile(submitted));
      setErrors({});
      toast.show(status === 'changes_requested' || status === 'rejected' ? 'Application resubmitted' : 'Application submitted for review', { tone: 'success' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setServerError(coachingError(e, 'Couldn’t submit your application. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const countries = useMemo(countryOptions, []);
  const languages = useMemo(languageOptions, []);
  const specialtyOptions = [...SPECIALTIES, ...form.specialties.filter((s) => !SPECIALTIES.some((o) => o.value === s)).map((s) => ({ value: s, label: specialtyLabel(s) }))];
  const errorList = Object.entries(errors);
  const err = (k: string) => errors[k] ?? null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col"
    >
      <StatusBanner profile={original} />

      <SectionTitle>Profile</SectionTitle>
      <div className="flex items-center gap-4">
        <div className="relative">
          <CoachPhoto name={form.displayName || '?'} url={photoPreview ?? (form.photoPath && form.photoPath === original?.photoPath ? original?.photoUrl : null)} size={80} />
          {photoBusy && (
            <span className="absolute inset-0 rounded-2xl bg-bg/60 flex items-center justify-center">
              <Loader2 className="size-6 animate-spin" aria-label="Uploading photo" />
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" icon={<Camera className="size-4" />} disabled={photoBusy || busy} onClick={() => fileRef.current?.click()}>
            {form.photoPath ? 'Change photo' : 'Add photo'}
          </Button>
          {form.photoPath && (
            <Button size="sm" variant="ghost" disabled={photoBusy || busy} onClick={() => { set('photoPath', null); setPhotoPreview(null); }}>
              Remove photo
            </Button>
          )}
          <p className="text-xs text-muted">A clear photo of you. Location data is removed.</p>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {photoError && <p role="alert" className="text-xs text-danger mt-2">{photoError}</p>}
      <div className="flex flex-col gap-4 mt-4">
        <Input label="Name shown to clients" value={form.displayName} maxLength={LIMITS.displayName} onChange={(e) => set('displayName', e.target.value)} error={err('displayName')} autoComplete="name" />
        <Textarea
          label="About you and how you coach"
          value={form.bio}
          maxLength={LIMITS.bio}
          onChange={(e) => set('bio', e.target.value)}
          error={err('bio')}
          hint={`${form.bio.length}/${LIMITS.bio} · at least ${LIMITS.bioMinToSubmit} to submit`}
          className="min-h-32"
        />
      </div>

      <SectionTitle>Experience</SectionTitle>
      <div className="flex flex-col gap-4">
        <NumberInput label="Years coaching" value={form.experienceYears} decimals={false} min={0} max={LIMITS.experienceYears} onChange={(v) => set('experienceYears', v)} error={err('experienceYears')} className="max-w-40" suffix="yrs" />
        <Textarea label="Experience (optional)" value={form.experience} maxLength={LIMITS.experience} onChange={(e) => set('experience', e.target.value)} error={err('experience')} hint={`Who you’ve coached, settings you’ve worked in. ${form.experience.length}/${LIMITS.experience}`} className="min-h-28" />
      </div>

      <SectionTitle>Specialties</SectionTitle>
      <ChipGroup label="Specialties" values={form.specialties} onChange={(v) => set('specialties', v.slice(0, LIMITS.specialties))} options={specialtyOptions} />
      <FieldError msg={err('specialties')} />
      <p className="text-xs text-muted mt-1 px-1">{form.specialties.length}/{LIMITS.specialties} selected</p>

      <SectionTitle>Goals you help with</SectionTitle>
      <ChipGroup label="Goals you help with" values={form.goals} onChange={(v) => set('goals', v.slice(0, LIMITS.goals))} options={COACH_GOALS} />
      <FieldError msg={err('goals')} />

      <SectionTitle>Languages</SectionTitle>
      {form.languages.length > 0 ? (
        <ChipGroup
          label="Languages you coach in (tap to remove)"
          values={form.languages}
          onChange={(v) => set('languages', v)}
          options={form.languages.map((l) => ({ value: l, label: languageName(l) }))}
        />
      ) : (
        <p className="text-sm text-muted px-1">Add the languages you can coach in.</p>
      )}
      <Select
        className="mt-3"
        label="Add a language"
        value=""
        disabled={form.languages.length >= LIMITS.languages}
        onChange={(e) => e.target.value && set('languages', [...form.languages, e.target.value])}
        error={err('languages')}
      >
        <option value="">Choose…</option>
        {languages
          .filter((l) => !form.languages.includes(l.value))
          .map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
      </Select>

      <SectionTitle>Business location</SectionTitle>
      <p className="text-sm text-muted px-1 mb-3">Where you’re based as a coach. A town or region, or your gym’s town. Never enter your home address; it’s shown on your public profile.</p>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="City or town" value={form.city} maxLength={LIMITS.place} onChange={(e) => set('city', e.target.value)} error={err('city')} />
          <Input label="Region (optional)" value={form.region} maxLength={LIMITS.place} onChange={(e) => set('region', e.target.value)} error={err('region')} />
        </div>
        <Select label="Country" value={form.country} onChange={(e) => set('country', e.target.value)} error={err('country')}>
          <option value="">Choose…</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <SectionTitle>How you coach</SectionTitle>
      <ChipGroup<CoachFormat>
        label="Coaching formats"
        values={form.formats}
        onChange={(v) => set('formats', v)}
        options={(Object.keys(FORMAT_LABELS) as CoachFormat[]).map((f) => ({ value: f, label: FORMAT_LABELS[f] }))}
      />
      <FieldError msg={err('formats')} />

      <SectionTitle>Service areas</SectionTitle>
      <ServiceAreasEditor areas={form.serviceAreas} onChange={(a) => set('serviceAreas', a)} errors={errors} inPerson={form.formats.includes('in_person')} defaultCountry={form.country || defaultCountry} disabled={busy} />

      <SectionTitle>Availability</SectionTitle>
      {approved && original && !original.suspended ? (
        <ListingControls profile={original} onSaved={(p) => { setOriginal(p); setForm((f) => ({ ...f, listed: p.listed, acceptingClients: p.acceptingClients })); }} />
      ) : (
        <Card className="px-4 py-1 divide-y divide-line">
          <Toggle label="Accepting new clients" description="You can change this anytime; existing clients aren’t affected." checked={form.acceptingClients} onChange={(v) => set('acceptingClients', v)} />
          <Toggle
            label="Show me in the coach directory"
            description="Takes effect only once your application is approved. Until then nobody can find you in search."
            checked={form.listed}
            onChange={(v) => set('listed', v)}
          />
        </Card>
      )}

      <SectionTitle>Qualifications</SectionTitle>
      <QualificationsEditor rows={form.qualifications} onChange={(q) => set('qualifications', q)} errors={errors} disabled={busy} />
      {approved && (
        <Notice tone={changedQuals.length ? 'warn' : 'info'} className="mt-3">
          Changing the title, issuer, year or document of a reviewed qualification sends it back for review. It’s hidden from your profile until it’s reviewed again.
        </Notice>
      )}

      <ReviewHistory events={events.data} loading={events.loading} error={events.error} onRetry={events.reload} />

      <div ref={errorRef} tabIndex={-1} className="outline-none">
        {errorList.length > 0 && (
          <Notice tone="danger" className="mt-6">
            <p className="font-medium mb-1">Please fix the following:</p>
            <ul className="list-disc pl-5 flex flex-col gap-0.5">
              {errorList.map(([k, m]) => (
                <li key={k}>{m}</li>
              ))}
            </ul>
          </Notice>
        )}
        {serverError && (
          <p role="alert" className="text-sm text-danger mt-4">
            {serverError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 mt-6">
        {canSubmitFrom(status) && (
          <Button variant="primary" size="lg" block loading={submitting} disabled={saving || photoBusy} onClick={() => void submit()}>
            {status === 'changes_requested' || status === 'rejected' ? 'Resubmit for review' : 'Submit for review'}
          </Button>
        )}
        <Button type="submit" variant={canSubmitFrom(status) ? 'secondary' : 'primary'} block loading={saving} disabled={submitting || photoBusy || (!dirty && !!original)}>
          {approved || status === 'submitted' ? 'Save changes' : 'Save draft'}
        </Button>
        {!dirty && original && <p className="text-xs text-muted text-center">All changes saved.</p>}
        {status === 'submitted' && <p className="text-xs text-muted text-center">Your application is being reviewed. Changes you save are seen by reviewers.</p>}
      </div>

      <ConfirmDialog
        open={confirmQualChange !== null}
        title="Send qualifications back for review?"
        body={`${changedQuals.length === 1 ? 'A reviewed qualification has' : `${changedQuals.length} reviewed qualifications have`} changed. ${changedQuals.length === 1 ? 'It' : 'They'} will be hidden from your public profile until reviewed again.`}
        confirmLabel="Save and send for review"
        onCancel={() => setConfirmQualChange(null)}
        onConfirm={() => {
          const which = confirmQualChange;
          setConfirmQualChange(null);
          if (which === 'submit') void submit(true);
          else void save(true);
        }}
      />
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        title="Leave without saving?"
        body="You have unsaved changes to your coach profile."
        confirmLabel="Leave"
        danger
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </form>
  );
}

function FieldError({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="alert" className="text-xs text-danger mt-2 px-1">
      {msg}
    </p>
  );
}

function StatusBanner({ profile }: { profile: CoachProfile | null }) {
  if (!profile) {
    return (
      <Notice className="mt-2">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
          <span>Tell clients about yourself and how you coach. Save a draft anytime; when you submit, our team reviews your application. You won’t appear in search or work with clients until you’re approved.</span>
        </span>
      </Notice>
    );
  }
  const s = profile.status;
  return (
    <Card className="p-4 mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted">Status</span>
        <span className="flex gap-1.5">
          <Badge tone={STATUS_TONE[s]}>{STATUS_LABELS[s]}</Badge>
          {profile.suspended && <Badge tone="danger">Suspended</Badge>}
        </span>
      </div>
      {profile.suspended ? (
        <p className="text-sm">
          Your coach account is suspended{profile.suspendedReason ? `: ${profile.suspendedReason}` : '.'} Your listing is hidden and you can’t use coaching tools. Your clients’ workouts and programs are kept.
        </p>
      ) : s === 'draft' ? (
        <p className="text-sm text-muted">Not submitted yet. Finish your profile and submit it when you’re ready.</p>
      ) : s === 'submitted' ? (
        <p className="text-sm text-muted">Submitted {dateText(profile.submittedAt)}. You’ll get a notification when it’s reviewed.</p>
      ) : s === 'changes_requested' ? (
        <>
          <p className="text-sm">Reviewers asked for changes. Update your application and resubmit.</p>
          {profile.latestFeedback && <blockquote className="text-sm border-l-2 border-warn pl-3 whitespace-pre-line">{profile.latestFeedback}</blockquote>}
        </>
      ) : s === 'rejected' ? (
        <>
          <p className="text-sm">Your application wasn’t approved. You can edit it and apply again.</p>
          {profile.latestFeedback && <blockquote className="text-sm border-l-2 border-danger pl-3 whitespace-pre-line">Reason: {profile.latestFeedback}</blockquote>}
        </>
      ) : (
        <p className="text-sm text-muted">You’re an approved coach. Changes to your profile show in the directory after you save.</p>
      )}
    </Card>
  );
}

function ListingControls({ profile, onSaved }: { profile: CoachProfile; onSaved: (p: CoachProfile) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<null | 'listed' | 'accepting'>(null);
  const change = async (listed: boolean, accepting: boolean, which: 'listed' | 'accepting') => {
    setBusy(which);
    try {
      await coachingApi.setListing(listed, accepting);
      onSaved({ ...profile, listed, acceptingClients: accepting });
      toast.show(which === 'listed' ? (listed ? 'You’re listed in the directory' : 'Your listing is hidden') : accepting ? 'Accepting new clients' : 'Not accepting new clients', { tone: 'success' });
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t update your listing.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="px-4 py-1 divide-y divide-line">
      <Toggle
        label="Show me in the coach directory"
        description="Turn off to pause discovery. Your existing clients aren’t affected. Saves immediately."
        checked={profile.listed}
        disabled={busy !== null}
        onChange={(v) => void change(v, profile.acceptingClients, 'listed')}
      />
      <Toggle
        label="Accepting new clients"
        description="When off, people can see your profile but can’t send requests. Saves immediately."
        checked={profile.acceptingClients}
        disabled={busy !== null}
        onChange={(v) => void change(profile.listed, v, 'accepting')}
      />
    </Card>
  );
}

function ReviewHistory({ events, loading, error, onRetry }: { events: ReviewEvent[] | undefined; loading: boolean; error: string | null; onRetry: () => void }) {
  if (loading && !events) return null;
  if (error && !events) {
    return (
      <>
        <SectionTitle>Review history</SectionTitle>
        <p className="text-sm text-muted px-1">
          Couldn’t load the review history.{' '}
          <button type="button" className="text-accent font-medium min-h-11" onClick={onRetry}>
            Try again
          </button>
        </p>
      </>
    );
  }
  if (!events || events.length === 0) return null;
  const sorted = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <History className="size-4" aria-hidden /> Review history
        </span>
      </SectionTitle>
      <Card className="overflow-hidden">
        <ol className="divide-y divide-line">
          {sorted.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                <time dateTime={e.createdAt} className="text-xs text-muted">
                  {dateText(e.createdAt, true)}
                </time>
              </div>
              {e.reason && <p className="text-sm text-muted mt-1 whitespace-pre-line break-words">{e.reason}</p>}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
