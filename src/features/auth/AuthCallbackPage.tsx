import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Card, Input, Notice, Page, Spinner } from '@/components/ui';
import { supabase } from '@/backend/supabase';
import { useToast } from '@/components/toast';
import { authHref, peekReturn, takeReturn } from './authReturn';

/** Handles email confirmation and password-recovery redirects (PKCE code exchange happens in supabase-js). */
export default function AuthCallbackPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const wantsReset = params.get('next') === 'reset';
  const [state, setState] = useState<'waiting' | 'reset' | 'error'>('waiting');
  const [error, setError] = useState<string | null>(params.get('error_description'));
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sb = supabase();
    if (!sb) {
      void nav('/', { replace: true });
      return;
    }
    if (error) {
      setState('error');
      return;
    }
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (wantsReset && session)) setState('reset');
      else if (session && !wantsReset) nav(takeReturn() ?? '/', { replace: true });
    });
    const t = setTimeout(async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) {
        if (wantsReset) setState('reset');
        else nav(takeReturn() ?? '/', { replace: true });
      } else {
        setError('This link is invalid or has expired. Request a new one.');
        setState('error');
      }
    }, 2500);
    return () => {
      clearTimeout(t);
      sub.subscription.unsubscribe();
    };
  }, [nav, wantsReset, error]);

  if (state === 'waiting') return <Spinner label="Signing you in" />;
  if (state === 'error')
    return (
      <Page title="Sign-in link">
        <Notice tone="danger">{error}</Notice>
        <Button className="mt-4" onClick={() => nav(authHref('signin', peekReturn()))}>
          Back to sign in
        </Button>
      </Page>
    );
  return (
    <Page title="Choose a new password">
      <Card className="p-5 space-y-4">
        <Input label="New password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="At least 8 characters." error={error} />
        <Button
          variant="primary"
          block
          loading={busy}
          onClick={async () => {
            if (pw.length < 8) return setError('Use at least 8 characters');
            setBusy(true);
            const { error: err } = await supabase()!.auth.updateUser({ password: pw });
            setBusy(false);
            if (err) return setError(err.message);
            toast.show('Password updated', { tone: 'success' });
            nav(takeReturn() ?? '/', { replace: true });
          }}
        >
          Save password
        </Button>
      </Card>
    </Page>
  );
}
