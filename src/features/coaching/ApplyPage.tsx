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
import { COACH_GOALS, SPECIALTIES, countryFromTimeZone, countryOptions, formatLabel, languageName, languageOptions, specialtyLabel } from '@/domain/coaching/options';
import { useT } from '@/i18n';
import { CoachPhoto, CoachingAccessNotice, coachingError, useCoachingAccess, useLoad } from './directory/common';
import { ServiceAreasEditor } from './directory/ServiceAreasEditor';
import { QualificationsEditor } from './directory/QualificationsEditor';

export default function ApplyPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const { t } = useT();
  const profile = useLoad(() => coachingApi.getMyCoachProfile(), [], { enabled: access === 'ok', fallback: t('coaching.apply.couldnt_load_your_application') });
  const title = profile.data?.status === 'approved' ? t('coaching.apply.coach_profile') : t('coaching.editor.apply_to_be_listed');
  return (
    <Page
      title={title}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
          <ChevronLeft />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : profile.loading && profile.data === undefined ? (
        <Spinner label={t('coaching.apply.loading_your_application')} />
      ) : profile.error && profile.data === undefined ? (
        <ErrorState title={t('coaching.apply.couldnt_load_your_application')} message={profile.error} onRetry={profile.reload} />
      ) : (
        <ApplyForm initial={profile.data ?? null} />
      )}
    </Page>
  );
}

const sameInput = (a: ApplicationForm, b: ApplicationForm) => JSON.stringify(formToInput(a)) === JSON.stringify(formToInput(b));

function ApplyForm({ initial }: { initial: CoachProfile | null }) {
  const toast = useToast();
  const { t, tp, language } = useT();
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
      setPhotoError(e instanceof MediaError ? mediaErrorMessage(e) : coachingError(e, t('coaching.apply.photo_upload_failed')));
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
        toast.show(approved ? t('coaching.apply.profile_saved') : t('coaching.apply.draft_saved'), { tone: 'success' });
      }
    } catch (e) {
      setServerError(coachingError(e, t('coaching.apply.couldnt_save_please_try_again')));
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
      toast.show(status === 'changes_requested' || status === 'rejected' ? t('coaching.apply.application_resubmitted') : t('coaching.apply.application_submitted_for_review'), { tone: 'success' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setServerError(coachingError(e, t('coaching.apply.couldnt_submit_your_application')));
    } finally {
      setSubmitting(false);
    }
  };

  const countries = useMemo(() => countryOptions(language), [language]);
  const languages = useMemo(() => languageOptions(language), [language]);
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

      <SectionTitle>{t('nav.profile')}</SectionTitle>
      <div className="flex items-center gap-4">
        <div className="relative">
          <CoachPhoto name={form.displayName || '?'} url={photoPreview ?? (form.photoPath && form.photoPath === original?.photoPath ? original?.photoUrl : null)} size={80} />
          {photoBusy && (
            <span className="absolute inset-0 rounded-2xl bg-bg/60 flex items-center justify-center">
              <Loader2 className="size-6 animate-spin" aria-label={t('coaching.apply.uploading_photo')} />
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" icon={<Camera className="size-4" />} disabled={photoBusy || busy} onClick={() => fileRef.current?.click()}>
            {form.photoPath ? t('coaching.apply.change_photo') : t('coaching.apply.add_photo')}
          </Button>
          {form.photoPath && (
            <Button size="sm" variant="ghost" disabled={photoBusy || busy} onClick={() => { set('photoPath', null); setPhotoPreview(null); }}>
              {t('coaching.apply.remove_photo')}
            </Button>
          )}
          <p className="text-xs text-muted">{t('coaching.apply.a_clear_photo_of_you_location')}</p>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {photoError && <p role="alert" className="text-xs text-danger mt-2">{photoError}</p>}
      <div className="flex flex-col gap-4 mt-4">
        <Input label={t('coaching.apply.name_shown_to_clients')} value={form.displayName} maxLength={LIMITS.displayName} onChange={(e) => set('displayName', e.target.value)} error={err('displayName')} autoComplete="name" />
        <Textarea
          label={t('coaching.apply.about_you_and_how_you_coach')}
          value={form.bio}
          maxLength={LIMITS.bio}
          onChange={(e) => set('bio', e.target.value)}
          error={err('bio')}
          hint={t('coaching.apply.x_x_at_least_x_to', { count: form.bio.length, max: LIMITS.bio, min: LIMITS.bioMinToSubmit })}
          className="min-h-32"
        />
      </div>

      <SectionTitle>{t('onboarding.experience.group')}</SectionTitle>
      <div className="flex flex-col gap-4">
        <NumberInput label={t('coaching.apply.years_coaching')} value={form.experienceYears} decimals={false} min={0} max={LIMITS.experienceYears} onChange={(v) => set('experienceYears', v)} error={err('experienceYears')} className="max-w-40" suffix={t('coaching.apply.years_suffix')} />
        <Textarea label={t('coaching.apply.experience_optional')} value={form.experience} maxLength={LIMITS.experience} onChange={(e) => set('experience', e.target.value)} error={err('experience')} hint={t('coaching.apply.who_youve_coached_settings_youve_worked', { count: form.experience.length, max: LIMITS.experience })} className="min-h-28" />
      </div>

      <SectionTitle>{t('coaching.directory.specialties')}</SectionTitle>
      <ChipGroup label={t('coaching.directory.specialties')} values={form.specialties} onChange={(v) => set('specialties', v.slice(0, LIMITS.specialties))} options={specialtyOptions} />
      <FieldError msg={err('specialties')} />
      <p className="text-xs text-muted mt-1 px-1">{t('coaching.apply.selected_count', { count: form.specialties.length, max: LIMITS.specialties })}</p>

      <SectionTitle>{t('coaching.apply.goals_you_help_with')}</SectionTitle>
      <ChipGroup label={t('coaching.apply.goals_you_help_with')} values={form.goals} onChange={(v) => set('goals', v.slice(0, LIMITS.goals))} options={COACH_GOALS} />
      <FieldError msg={err('goals')} />

      <SectionTitle>{t('coaching.directory.languages')}</SectionTitle>
      {form.languages.length > 0 ? (
        <ChipGroup
          label={t('coaching.apply.languages_you_coach_in_tap_to')}
          values={form.languages}
          onChange={(v) => set('languages', v)}
          options={form.languages.map((l) => ({ value: l, label: languageName(l, language) }))}
        />
      ) : (
        <p className="text-sm text-muted px-1">{t('coaching.apply.add_the_languages_you_can_coach')}</p>
      )}
      <Select
        className="mt-3"
        label={t('coaching.apply.add_a_language')}
        value=""
        disabled={form.languages.length >= LIMITS.languages}
        onChange={(e) => e.target.value && set('languages', [...form.languages, e.target.value])}
        error={err('languages')}
      >
        <option value="">{t('coaching.apply.choose')}</option>
        {languages
          .filter((l) => !form.languages.includes(l.value))
          .map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
      </Select>

      <SectionTitle>{t('coaching.admin.business_location')}</SectionTitle>
      <p className="text-sm text-muted px-1 mb-3">{t('coaching.apply.where_youre_based_as_a_coach')}</p>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label={t('coaching.directory.city_or_town')} value={form.city} maxLength={LIMITS.place} onChange={(e) => set('city', e.target.value)} error={err('city')} />
          <Input label={t('coaching.directory.region_optional')} value={form.region} maxLength={LIMITS.place} onChange={(e) => set('region', e.target.value)} error={err('region')} />
        </div>
        <Select label={t('coaching.directory.country')} value={form.country} onChange={(e) => set('country', e.target.value)} error={err('country')}>
          <option value="">{t('coaching.apply.choose')}</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <SectionTitle>{t('coaching.apply.how_you_coach')}</SectionTitle>
      <ChipGroup<CoachFormat>
        label={t('coaching.apply.coaching_formats')}
        values={form.formats}
        onChange={(v) => set('formats', v)}
        options={(['in_person', 'online'] as CoachFormat[]).map((f) => ({ value: f, label: formatLabel(f, language) }))}
      />
      <FieldError msg={err('formats')} />

      <SectionTitle>{t('coaching.admin.service_areas')}</SectionTitle>
      <ServiceAreasEditor areas={form.serviceAreas} onChange={(a) => set('serviceAreas', a)} errors={errors} inPerson={form.formats.includes('in_person')} defaultCountry={form.country || defaultCountry} disabled={busy} />

      <SectionTitle>{t('coaching.apply.availability')}</SectionTitle>
      {approved && original && !original.suspended ? (
        <ListingControls profile={original} onSaved={(p) => { setOriginal(p); setForm((f) => ({ ...f, listed: p.listed, acceptingClients: p.acceptingClients })); }} />
      ) : (
        <Card className="px-4 py-1 divide-y divide-line">
          <Toggle label={t('coaching.apply.accepting_new_clients')} description={t('coaching.apply.you_can_change_this_anytime_existing')} checked={form.acceptingClients} onChange={(v) => set('acceptingClients', v)} />
          <Toggle
            label={t('coaching.apply.show_me_in_the_coach_directory')}
            description={t('coaching.apply.takes_effect_only_once_your_application')}
            checked={form.listed}
            onChange={(v) => set('listed', v)}
          />
        </Card>
      )}

      <SectionTitle>{t('coaching.admin.qualifications')}</SectionTitle>
      <QualificationsEditor rows={form.qualifications} onChange={(q) => set('qualifications', q)} errors={errors} disabled={busy} />
      {approved && (
        <Notice tone={changedQuals.length ? 'warn' : 'info'} className="mt-3">
          {t('coaching.apply.changing_the_title_issuer_year_or')}
        </Notice>
      )}

      <ReviewHistory events={events.data} loading={events.loading} error={events.error} onRetry={events.reload} />

      <div ref={errorRef} tabIndex={-1} className="outline-none">
        {errorList.length > 0 && (
          <Notice tone="danger" className="mt-6">
            <p className="font-medium mb-1">{t('coaching.apply.please_fix_the_following')}</p>
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
            {status === 'changes_requested' || status === 'rejected' ? t('coaching.apply.resubmit_for_review') : t('coaching.apply.submit_for_review')}
          </Button>
        )}
        <Button type="submit" variant={canSubmitFrom(status) ? 'secondary' : 'primary'} block loading={saving} disabled={submitting || photoBusy || (!dirty && !!original)}>
          {approved || status === 'submitted' ? t('workout.custom.saveChanges') : t('coaching.apply.save_draft')}
        </Button>
        {!dirty && original && <p className="text-xs text-muted text-center">{t('coaching.apply.all_changes_saved')}</p>}
        {status === 'submitted' && <p className="text-xs text-muted text-center">{t('coaching.apply.your_application_is_being_reviewed_changes')}</p>}
      </div>

      <ConfirmDialog
        open={confirmQualChange !== null}
        title={t('coaching.apply.send_qualifications_back_for_review')}
        body={tp('coaching.apply.reviewed_qualifications_changed', changedQuals.length)}
        confirmLabel={t('coaching.apply.save_and_send_for_review')}
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
        title={t('coaching.apply.leave_without_saving')}
        body={t('coaching.apply.you_have_unsaved_changes_to_your')}
        confirmLabel={t('coaching.apply.leave')}
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
  const { t, language } = useT();
  if (!profile) {
    return (
      <Notice className="mt-2">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
          <span>{t('coaching.apply.tell_clients_about_yourself_and_how')}</span>
        </span>
      </Notice>
    );
  }
  const s = profile.status;
  return (
    <Card className="p-4 mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted">{t('sync.status')}</span>
        <span className="flex gap-1.5">
          <Badge tone={STATUS_TONE[s]}>{STATUS_LABELS[s]}</Badge>
          {profile.suspended && <Badge tone="danger">{t('coaching.admin.suspended')}</Badge>}
        </span>
      </div>
      {profile.suspended ? (
        <p className="text-sm">
          {profile.suspendedReason ? t('coaching.apply.suspended_with_reason', { reason: profile.suspendedReason }) : t('coaching.apply.suspended_no_reason')}
        </p>
      ) : s === 'draft' ? (
        <p className="text-sm text-muted">{t('coaching.apply.not_submitted_yet_finish_your_profile')}</p>
      ) : s === 'submitted' ? (
        <p className="text-sm text-muted">{t('coaching.apply.submitted_x_youll_get_a_notification', { date: dateText(profile.submittedAt, false, language) })}</p>
      ) : s === 'changes_requested' ? (
        <>
          <p className="text-sm">{t('coaching.apply.reviewers_asked_for_changes_update_your')}</p>
          {profile.latestFeedback && <blockquote className="text-sm border-l-2 border-warn pl-3 whitespace-pre-line">{profile.latestFeedback}</blockquote>}
        </>
      ) : s === 'rejected' ? (
        <>
          <p className="text-sm">{t('coaching.apply.your_application_wasnt_approved_you_can')}</p>
          {profile.latestFeedback && <blockquote className="text-sm border-l-2 border-danger pl-3 whitespace-pre-line">{t('coaching.apply.reason')} {profile.latestFeedback}</blockquote>}
        </>
      ) : (
        <p className="text-sm text-muted">{t('coaching.apply.youre_an_approved_coach_changes_to')}</p>
      )}
    </Card>
  );
}

function ListingControls({ profile, onSaved }: { profile: CoachProfile; onSaved: (p: CoachProfile) => void }) {
  const toast = useToast();
  const { t } = useT();
  const [busy, setBusy] = useState<null | 'listed' | 'accepting'>(null);
  const change = async (listed: boolean, accepting: boolean, which: 'listed' | 'accepting') => {
    setBusy(which);
    try {
      await coachingApi.setListing(listed, accepting);
      onSaved({ ...profile, listed, acceptingClients: accepting });
      toast.show(
        which === 'listed' ? (listed ? t('coaching.apply.youre_listed_in_the_directory') : t('coaching.apply.your_listing_is_hidden')) : accepting ? t('coaching.apply.accepting_new_clients') : t('coaching.apply.not_accepting_new_clients'),
        { tone: 'success' },
      );
    } catch (e) {
      toast.show(coachingError(e, t('coaching.apply.couldnt_update_your_listing')), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="px-4 py-1 divide-y divide-line">
      <Toggle
        label={t('coaching.apply.show_me_in_the_coach_directory')}
        description={t('coaching.apply.turn_off_to_pause_discovery_your')}
        checked={profile.listed}
        disabled={busy !== null}
        onChange={(v) => void change(v, profile.acceptingClients, 'listed')}
      />
      <Toggle
        label={t('coaching.apply.accepting_new_clients')}
        description={t('coaching.apply.when_off_people_can_see_your')}
        checked={profile.acceptingClients}
        disabled={busy !== null}
        onChange={(v) => void change(profile.listed, v, 'accepting')}
      />
    </Card>
  );
}

function ReviewHistory({ events, loading, error, onRetry }: { events: ReviewEvent[] | undefined; loading: boolean; error: string | null; onRetry: () => void }) {
  const { t, language } = useT();
  if (loading && !events) return null;
  if (error && !events) {
    return (
      <>
        <SectionTitle>{t('coaching.apply.review_history')}</SectionTitle>
        <p className="text-sm text-muted px-1">
          {t('coaching.apply.couldnt_load_the_review_history')}{' '}
          <button type="button" className="text-accent font-medium min-h-11" onClick={onRetry}>
            {t('common.retry')}
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
          <History className="size-4" aria-hidden /> {t('coaching.apply.review_history')}
        </span>
      </SectionTitle>
      <Card className="overflow-hidden">
        <ol className="divide-y divide-line">
          {sorted.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                <time dateTime={e.createdAt} className="text-xs text-muted">
                  {dateText(e.createdAt, true, language)}
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
