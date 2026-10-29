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

const emailSchema = z.string().trim().email('Enter a valid email address');
const passwordSchema = z.string().min(8, 'Use at least 8 characters');

type Mode = 'signin' | 'signup' | 'forgot';

export default function AuthPage() {
  const nav = useNavigate();
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
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );

  if (!backendConfigured) {
    return (
      <Page title="Account" back={back}>
        <Card className="p-5 space-y-3">
          <p className="text-[15px]">Accounts, backup and friends aren’t enabled in this version of {BRAND.name}.</p>
          <p className="text-sm text-muted">Everything you log is saved on this device. You can export a backup anytime from Settings → Your data.</p>
          <Button variant="primary" onClick={() => nav('/')}>
            Continue
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
    if (!online) return setErrors({ form: 'You’re offline. Connect to the internet to sign in.' });
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
      const msg = (err as Error).message || 'Something went wrong';
      setErrors({
        form: /invalid login/i.test(msg)
          ? 'Email or password is incorrect.'
          : /not confirmed/i.test(msg)
            ? 'Please confirm your email first — check your inbox for the link.'
            : /rate|too many/i.test(msg)
              ? 'Too many attempts. Please wait a minute and try again.'
              : msg,
      });
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Page title={sent === 'verify' ? 'Check your email' : 'Reset link sent'} back={back}>
        <Card className="p-5 flex flex-col items-center text-center gap-3">
          <MailCheck className="size-8 text-accent" aria-hidden />
          <p className="text-[15px]">
            {sent === 'verify'
              ? `We sent a confirmation link to ${email}. Open it on this device to finish creating your account.`
              : `If an account exists for ${email}, you’ll get a link to choose a new password.`}
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
            Back to sign in
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Reset password' : 'Sign in'} back={back}>
      {reauth && (
        <Notice tone="warn" className="mb-4">
          Your session expired. Sign in with the same account{auth.email ? ` (${auth.email})` : ''} to resume backup. Workouts you logged meanwhile are kept on this device.
        </Notice>
      )}
      {mode !== 'forgot' && (
        <Segmented
          label="Sign in or create account"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setErrors({});
          }}
          options={[
            { value: 'signin', label: 'Sign in' },
            { value: 'signup', label: 'Create account' },
          ]}
          className="mb-5"
        />
      )}
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        {mode !== 'forgot' && (
          <Input
            label="Password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
          />
        )}
        {errors.form && (
          <Notice tone="danger">
            <span role="alert">{errors.form}</span>
          </Notice>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        {mode === 'signin' && (
          <button type="button" className="text-accent min-h-11" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        )}
        {mode === 'forgot' && (
          <button type="button" className="text-accent min-h-11" onClick={() => setMode('signin')}>
            Back to sign in
          </button>
        )}
        <Link to="/" className="text-muted min-h-11 inline-flex items-center">
          Continue without an account
        </Link>
      </div>
      {mode === 'signup' && <PrivacySummary />}
    </Page>
  );
}
