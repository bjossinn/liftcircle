// @vitest-environment jsdom
/**
 * Auth errors never show provider prose: known Supabase codes map to translated messages, unknown errors get a
 * localized fallback. Covers the expired recovery link and password-reuse rejection in Icelandic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sb = vi.hoisted(() => ({
  session: null as unknown,
  updateUser: async (_: unknown): Promise<{ error: unknown }> => ({ error: null }),
}));
vi.mock('@/backend/supabase', () => ({
  supabase: () => ({
    auth: {
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        if (sb.session) setTimeout(() => cb('PASSWORD_RECOVERY', sb.session), 0);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      getSession: async () => ({ data: { session: sb.session } }),
      updateUser: (x: unknown) => sb.updateUser(x),
    },
  }),
}));

import { ToastProvider } from '@/components/toast';
import AuthCallbackPage from '@/features/auth/AuthCallbackPage';
import { authErrorMessage, authRedirectError } from '@/features/auth/authErrors';
import { IS, LanguageProvider, setLanguage } from '@/i18n';

let root: Root | null = null;
let el: HTMLElement | null = null;
async function render(node: ReactElement, url: string) {
  setLanguage('is');
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, createElement(LanguageProvider, { language: 'is', children: node })))),
  );
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  sb.session = null;
  setLanguage('en');
});

describe('auth error mapping', () => {
  it('maps codes and legacy messages; unknown errors get the localized fallback', () => {
    setLanguage('is');
    expect(authErrorMessage({ code: 'same_password', message: 'New password should be different from the old password.' })).toBe(IS['auth.error.samePassword']);
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(IS['auth.wrongCredentials']);
    expect(authErrorMessage({ message: 'Email not confirmed' })).toBe(IS['auth.confirmEmailFirst']);
    expect(authErrorMessage({ status: 429, message: 'x' })).toBe(IS['auth.tooManyAttempts']);
    expect(authErrorMessage({ code: 'something_new', message: 'Database error saving new user' })).toBe(IS['auth.error.unknown']);
    expect(authErrorMessage(undefined)).toBe(IS['auth.error.unknown']);
    expect(authRedirectError(new URLSearchParams(''), '')).toBeNull();
    expect(authRedirectError(new URLSearchParams('error=server_error&error_description=Weird+provider+text'), '')).toBe(IS['auth.linkInvalid']);
    expect(authRedirectError(new URLSearchParams(''), '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).toBe(IS['auth.error.linkExpired']);
  });
});

describe('AuthCallbackPage in Icelandic', () => {
  it('an expired recovery link shows the Icelandic message, not the provider description', async () => {
    await render(createElement(AuthCallbackPage), '/auth/callback?next=reset&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(text()).toContain(IS['auth.error.linkExpired']);
    expect(text()).not.toContain('Email link is invalid');
  });

  it('reusing the current password is rejected with the Icelandic message', async () => {
    sb.session = { user: { id: 'u1' } };
    sb.updateUser = async () => ({ error: { code: 'same_password', status: 422, message: 'New password should be different from the old password.' } });
    await render(createElement(AuthCallbackPage), '/auth/callback?next=reset');
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'same-old-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(IS['auth.save_password']))!;
    await act(async () => {
      save.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text()).toContain(IS['auth.error.samePassword']);
    expect(text()).not.toContain('should be different');
  });
});
