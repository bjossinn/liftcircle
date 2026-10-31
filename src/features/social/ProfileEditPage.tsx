import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Camera, Check, ChevronLeft, Loader2, Plus, ShieldCheck, X } from 'lucide-react';
import { Button, ChipGroup, ErrorState, IconButton, Input, Notice, Page, SectionTitle, Spinner, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import { useApp } from '@/state/app';
import { friendlyError } from '@/social/pendingPosts';
import { mediaErrorMessage, processAvatar } from '@/social/media';
import { AccessNotice, Avatar, usernameProblem, useSocialAccess } from './common';
import { setMyProfileCache, useMyProfile } from './useMyProfile';

const DISPLAY_MAX = 50;
const BIO_MAX = 160;
const MAX_INTERESTS = 8;
const INTEREST_MAX = 24;
const PRESET_INTERESTS = ['Strength', 'Muscle building', 'Powerlifting', 'Running', 'Cycling', 'Walking', 'Hiking', 'Swimming', 'Mobility', 'Yoga', 'Calisthenics', 'Conditioning', 'Sports'];

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'error';

export default function ProfileEditPage() {
  const nav = useNavigate();
  const { access, meId } = useSocialAccess();
  const me = useMyProfile(access === 'ok' ? meId : undefined);
  return (
    <Page
      title={me.profile ? 'Edit profile' : 'Create profile'}
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <AccessNotice access={access} what="Editing your profile" />
      ) : me.loading ? (
        <Spinner label="Loading your profile" />
      ) : me.error && !me.known ? (
        <ErrorState title="Couldn’t load your profile" message={me.error} onRetry={me.reload} />
      ) : (
        <ProfileForm meId={meId!} key={me.profile?.id ?? 'new'} />
      )}
    </Page>
  );
}

function ProfileForm({ meId }: { meId: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const { account, updateAccount } = useApp();
  const { profile } = useMyProfile(meId);
  const original = profile?.username ?? '';

  const [username, setUsername] = useState(original);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? account.profile.displayName ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [interests, setInterests] = useState<string[]>(profile?.interests ?? []);
  const [customInterest, setCustomInterest] = useState('');
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? account.settings.social.discoverable);
  const [availability, setAvailability] = useState<Availability>('idle');
  const [usernameServerError, setUsernameServerError] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [touchedUsername, setTouchedUsername] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (avatarPreview && URL.revokeObjectURL(avatarPreview)), [avatarPreview]);

  // Debounced availability check.
  const problem = usernameProblem(username);
  useEffect(() => {
    setUsernameServerError(null);
    if (problem || username === original) {
      setAvailability('idle');
      return;
    }
    setAvailability('checking');
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const ok = await socialApi.isUsernameAvailable(username);
        if (!stale) setAvailability(ok ? 'available' : 'taken');
      } catch {
        if (!stale) setAvailability('error');
      }
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [username, original, problem]);

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const blob = await processAvatar(file);
      setAvatarBlob(blob);
      setAvatarPreview(URL.createObjectURL(blob));
    } catch (e) {
      setAvatarError(mediaErrorMessage(e));
    } finally {
      setAvatarBusy(false);
    }
  };

  const addCustom = () => {
    const v = customInterest.trim().replace(/\s+/g, ' ').slice(0, INTEREST_MAX);
    if (!v) return;
    if (interests.length >= MAX_INTERESTS) {
      setCustomInterest('');
      return;
    }
    if (!interests.some((i) => i.toLowerCase() === v.toLowerCase())) setInterests([...interests, v]);
    setCustomInterest('');
  };

  const usernameError = (touchedUsername || username !== original) && problem ? problem : availability === 'taken' ? 'That username is taken.' : usernameServerError;

  const save = async () => {
    setTouchedUsername(true);
    setFormError(null);
    const name = displayName.trim().replace(/\s+/g, ' ');
    const dErr = !name ? 'Add a display name.' : name.length > DISPLAY_MAX ? `At most ${DISPLAY_MAX} characters.` : null;
    setDisplayError(dErr);
    if (problem || dErr || availability === 'taken' || availability === 'checking' || avatarBusy) return;
    setSaving(true);
    try {
      let saved = await socialApi.saveMyProfile({ username, displayName: name, bio: bio.trim() || undefined, interests, discoverable });
      if (avatarBlob) {
        try {
          saved = await socialApi.uploadAvatar(avatarBlob);
        } catch (e) {
          toast.show(`Profile saved, but the photo didn’t upload. ${friendlyError(e, '')}`.trim(), { tone: 'warn' });
        }
      }
      setMyProfileCache(meId, saved);
      if (account.settings.social.discoverable !== discoverable) {
        await updateAccount((a) => ({ ...a, settings: { ...a.settings, social: { ...a.settings.social, discoverable } } })).catch(() => {});
      }
      toast.show(profile ? 'Profile updated' : 'Profile created', { tone: 'success' });
      nav('/profile', { replace: true });
    } catch (e) {
      const msg = friendlyError(e, 'Couldn’t save your profile. Please try again.');
      if (/username/i.test(msg) || /duplicate|unique|taken/i.test(e instanceof Error ? e.message : '')) {
        setUsernameServerError(/taken|duplicate|unique/i.test(e instanceof Error ? e.message : msg) ? 'That username is taken.' : msg);
        setAvailability('idle');
      } else setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const interestOptions = [...PRESET_INTERESTS, ...interests.filter((i) => !PRESET_INTERESTS.includes(i))].map((i) => ({ value: i, label: i }));
  const shown = avatarPreview ? { displayName, username, avatarUrl: avatarPreview } : { displayName, username, avatarUrl: profile?.avatarUrl };

  return (
    <form
      className="flex flex-col"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col items-center gap-2 pt-2">
        <div className="relative">
          <Avatar profile={shown} size={96} />
          {avatarBusy && (
            <span className="absolute inset-0 rounded-full bg-bg/60 flex items-center justify-center">
              <Loader2 className="size-6 animate-spin" aria-label="Preparing photo" />
            </span>
          )}
        </div>
        <Button size="sm" icon={<Camera className="size-4" />} onClick={() => fileRef.current?.click()} disabled={avatarBusy || saving}>
          {profile?.avatarUrl || avatarPreview ? 'Change photo' : 'Add photo'}
        </Button>
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => {
          void pickAvatar(e.target.files?.[0]);
          e.target.value = '';
        }} />
        {avatarError && (
          <p role="alert" className="text-xs text-danger text-center">
            {avatarError}
          </p>
        )}
      </div>

      <SectionTitle>About you</SectionTitle>
      <div className="flex flex-col gap-4">
        <Input
          label="Username"
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          inputMode="text"
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
          onBlur={() => setTouchedUsername(true)}
          error={usernameError}
          hint={
            availability === 'checking' ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Checking…
              </span>
            ) : availability === 'available' ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Check className="size-3" aria-hidden /> Available
              </span>
            ) : availability === 'error' ? (
              'Couldn’t check right now. We’ll check when you save.'
            ) : (
              '3–20 characters: lowercase letters, numbers, underscores. Friends find you by this exact name.'
            )
          }
        />
        <Input label="Display name" value={displayName} maxLength={DISPLAY_MAX} autoComplete="nickname" onChange={(e) => setDisplayName(e.target.value)} error={displayError} />
        <Textarea label="Bio (optional)" value={bio} maxLength={BIO_MAX} onChange={(e) => setBio(e.target.value)} hint={`${bio.length}/${BIO_MAX}`} className="min-h-20" />
      </div>

      <SectionTitle>Training interests</SectionTitle>
      <ChipGroup
        label="Training interests"
        values={interests}
        onChange={(v) => setInterests(v.slice(0, MAX_INTERESTS))}
        options={interestOptions}
      />
      <div className="flex gap-2 mt-3 items-end">
        <div className="flex-1">
        <Input
          label="Add your own"
          value={customInterest}
          maxLength={INTEREST_MAX}
          onChange={(e) => setCustomInterest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          disabled={interests.length >= MAX_INTERESTS}
        />
        </div>
        <IconButton label="Add interest" onClick={addCustom} disabled={!customInterest.trim() || interests.length >= MAX_INTERESTS} className="border border-line">
          <Plus className="size-5" />
        </IconButton>
      </div>
      <p className="text-xs text-muted mt-1">
        {interests.length}/{MAX_INTERESTS} selected
        {interests.filter((i) => !PRESET_INTERESTS.includes(i)).length > 0 && ' · tap a chip to remove it'}
      </p>

      <SectionTitle>Privacy</SectionTitle>
      <Toggle
        label="Let people find me by username"
        description="When off, people can’t look you up by username or profile link. Your friends still see your profile."
        checked={discoverable}
        onChange={setDiscoverable}
      />
      <Notice className="mt-3">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
          <span>Your profile only shows what’s on this page. Your email, age, weight, measurements, health notes and food logs are never shown.</span>
        </span>
      </Notice>

      {formError && (
        <p role="alert" className="text-sm text-danger mt-4">
          {formError}
        </p>
      )}
      <div className="flex gap-2 mt-6">
        <Button variant="ghost" icon={<X className="size-4" />} onClick={() => nav(-1)} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" block loading={saving} disabled={avatarBusy}>
          {profile ? 'Save profile' : 'Create profile'}
        </Button>
      </div>
    </form>
  );
}
