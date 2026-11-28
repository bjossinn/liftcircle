import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ChevronLeft, MailCheck } from 'lucide-react';
import { Button, Card, IconButton, Input, Notice, Page, Segmented } from '@/components/ui';
import { useApp } from '@/state/app';
import { supabase } from '@/backend/supabase';
import { BRAND } from '@/config/brand';
import { rememberReturn, safeReturnPath } from './authReturn';
import { PrivacySummary } from './PrivacySummary';
import { t as translate, useT } from '@/i18n';

// Messages are read when validating, so they follow the current language.
const emailSchema = z.string().trim().email({ error: () => translate('auth.invalidEmail') });
const passwordSchema = z.string().min(8, { error: () => translate('auth.passwordTooShort') });

type Mode = 'signin' | 'signup' | 'forgot';

export default function AuthPage() {
  const nav = useNavigate();
  const { t } = useT();
  const [params] = useSearchParams();
  const { backendConfigured, auth, online } = useApp();
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState(auth.email ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | 'verify' | 'reset'>(null);
  const reauth = params.get('reauth') === '1';
  // Where to go afterwards (e.g. back to the Feed or Coaching gate that sent the person here).
  const next = safeReturnPath(params.get('next'));
  const done = () => {
    rememberReturn(null);
    nav(next ?? '/', { replace: true });
  };
  useEffect(() => {
    // Remembered on this device so the email-confirmation link (opened later) can come back here too.
    if (next) rememberReturn(next);
  }, [next]);
  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );

  if (!backendConfigured) {
    return (
      <Page title={t('settings.account')} back={back}>
        <Card className="p-5 space-y-3">
          <p className="text-[15px]">{t('auth.accounts_backup_and_friends_arent_enabled', { brand: BRAND.name })}</p>
          <p className="text-sm text-muted">{t('auth.everything_you_log_is_saved_on')}</p>
          <Button variant="primary" onClick={() => nav('/')}>
            {t('onboarding.continue')}
          </Button>
        </Card>
      </Page>
    );
  }

  const redirect = `${location.origin}/auth/callback`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    const em = emailSchema.safeParse(email);
    if (!em.success) errs.email = em.error.issues[0].message;
    if (mode !== 'forgot') {
      const pw = passwordSchema.safeParse(password);
      if (!pw.success) errs.password = pw.error.issues[0].message;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (!online) return setErrors({ form: t('auth.offline') });
    const sb = supabase()!;
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        done();
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirect } });
        if (error) throw error;
        if (data.session) done();
        else setSent('verify');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${redirect}?next=reset` });
        if (error) throw error;
        setSent('reset');
      }
    } catch (err) {
      const msg = (err as Error).message || t('common.error');
      setErrors({
        form: /invalid login/i.test(msg)
          ? t('auth.wrongCredentials')
          : /not confirmed/i.test(msg)
            ? t('auth.confirmEmailFirst')
            : /rate|too many/i.test(msg)
              ? t('auth.tooManyAttempts')
              : msg,
      });
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Page title={sent === 'verify' ? t('auth.check_your_email') : t('auth.reset_link_sent')} back={back}>
        <Card className="p-5 flex flex-col items-center text-center gap-3">
          <MailCheck className="size-8 text-accent" aria-hidden />
          <p className="text-[15px]">
            {sent === 'verify'
              ? t('auth.we_sent_a_confirmation_link_to', { email })
              : t('auth.if_an_account_exists_for_x', { email })}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              setSent(null);
              setMode('signin');
              setPassword('');
              setErrors({});
            }}
          >
            {t('auth.back_to_sign_in')}
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={mode === 'signup' ? t('settings.createAccount') : mode === 'forgot' ? t('auth.reset_password') : t('settings.signIn')} back={back}>
      {reauth && (
        <Notice tone="warn" className="mb-4">
          {auth.email ? t('auth.sessionExpiredWithEmail', { email: auth.email }) : t('auth.your_session_expired_sign_in_with')}
        </Notice>
      )}
      {mode !== 'forgot' && (
        <Segmented
          label={t('auth.sign_in_or_create_account')}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setErrors({});
          }}
          options={[
            { value: 'signin', label: t('settings.signIn') },
            { value: 'signup', label: t('settings.createAccount') },
          ]}
          className="mb-5"
        />
      )}
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label={t('auth.email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        {mode !== 'forgot' && (
          <Input
            label={t('auth.password')}
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            hint={mode === 'signup' ? t('auth.at_least_8_characters') : undefined}
          />
        )}
        {errors.form && (
          <Notice tone="danger">
            <span role="alert">{errors.form}</span>
          </Notice>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {mode === 'signup' ? t('settings.createAccount') : mode === 'forgot' ? t('auth.send_reset_link') : t('settings.signIn')}
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        {mode === 'signin' && (
          <button type="button" className="text-accent min-h-11" onClick={() => setMode('forgot')}>
            {t('auth.forgot_password')}
          </button>
        )}
        {mode === 'forgot' && (
          <button type="button" className="text-accent min-h-11" onClick={() => setMode('signin')}>
            {t('auth.back_to_sign_in')}
          </button>
        )}
        <Link to="/" className="text-muted min-h-11 inline-flex items-center">
          {t('auth.continue_without_an_account')}
        </Link>
      </div>
      {mode === 'signup' && <PrivacySummary />}
    </Page>
  );
}
