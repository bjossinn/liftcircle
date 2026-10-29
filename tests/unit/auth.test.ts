// @vitest-environment jsdom
/**
 * Auth flows with a mocked Supabase client: Feed/Coaching gates open "Create account" and come back to
 * where the person was (through sign-up, email confirmation and sign-in); "Back to sign in" really
 * switches to sign-in; privacy information is reachable while creating an account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sb = vi.hoisted(() => {
  const state = { signUpSession: false, callbackSession: true };
  const auth = {
    signInWithPassword: vi.fn(async () => ({ data: { session: {} }, error: null })),
    signUp: vi.fn(async () => ({ data: { session: state.signUpSession ? {} : null }, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => {
      if (state.callbackSession) setTimeout(() => cb('SIGNED_IN', {}), 0);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }),
    getSession: vi.fn(async () => ({ data: { session: state.callbackSession ? {} : null } })),
    updateUser: vi.fn(async () => ({ error: null })),
  };
  return { state, auth };
});
vi.mock('@/backend/supabase', () => ({ supabase: () => ({ auth: sb.auth }) }));
vi.mock('@/backend/social', () => ({ socialApi: {} }));
vi.mock('@/backend/coaching', () => ({ coachingApi: {} }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: 'guest' }, online: true }),
}));

import AuthPage from '@/features/auth/AuthPage';
import AuthCallbackPage from '@/features/auth/AuthCallbackPage';
import { authHref, peekReturn, rememberReturn, safeReturnPath } from '@/features/auth/authReturn';
import { AccessNotice } from '@/features/social/common';
import { CoachingAccessNotice } from '@/features/coaching/tools/common';
import { ToastProvider } from '@/components/toast';

/* ------------------------------------------------------------ harness */
let root: Root | null = null;
let container: HTMLElement | null = null;
let currentUrl = '';
function LocationSpy() {
  const l = useLocation();
  currentUrl = l.pathname + l.search;
  return null;
}
function app(path: string) {
  const routes: ReactElement[] = [
    createElement(Route, { key: 'feed', path: '/feed', element: createElement('div', null, createElement('p', null, 'FEED PAGE'), createElement(AccessNotice, { access: 'guest' })) }),
    createElement(Route, { key: 'coach', path: '/coaching/my', element: createElement(CoachingAccessNotice, { access: 'guest' }) }),
    createElement(Route, { key: 'auth', path: '/auth', element: createElement(AuthPage) }),
    createElement(Route, { key: 'cb', path: '/auth/callback', element: createElement(AuthCallbackPage) }),
    createElement(Route, { key: 'home', path: '/', element: createElement('p', null, 'HOME PAGE') }),
    createElement(Route, { key: 'data', path: '/settings/data', element: createElement('p', null, 'DATA PAGE') }),
  ];
  return createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [path] }, createElement(LocationSpy), createElement(Routes, null, ...routes)));
}
async function render(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(app(path)));
}
const text = () => (container?.textContent ?? '').replace(/\s+/g, ' ');
const heading = () => container!.querySelector('h1')?.textContent ?? '';
function button(name: string | RegExp): HTMLElement {
  const b = [...container!.querySelectorAll('button')].find((x) => (typeof name === 'string' ? x.textContent?.trim() === name : name.test(x.textContent ?? '')));
  if (!b) throw new Error(`No button ${name} in: ${text().slice(0, 400)}`);
  return b;
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
function fill(label: string, value: string) {
  const lab = [...container!.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label));
  const input = (lab?.htmlFor ? document.getElementById(lab.htmlFor) : lab?.querySelector('input')) as HTMLInputElement | null;
  if (!input) throw new Error(`No input ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  sb.state.signUpSession = false;
  sb.state.callbackSession = true;
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

/* ------------------------------------------------------------ tests */
describe('return destination helpers', () => {
  it('accepts only in-app paths', () => {
    expect(safeReturnPath('/feed')).toBe('/feed');
    expect(safeReturnPath('/coaching/find?remote=1')).toBe('/coaching/find?remote=1');
    for (const bad of ['//evil.example', 'https://evil.example/feed', '/\\evil', 'javascript:alert(1)', '/auth', '/auth/callback', 'feed', '', null]) expect(safeReturnPath(bad)).toBeNull();
    expect(authHref('signup', '/feed')).toBe('/auth?mode=signup&next=%2Ffeed');
    expect(authHref('signin', '//evil')).toBe('/auth');
  });
  it('remembered destination expires', () => {
    rememberReturn('/feed');
    expect(peekReturn()).toBe('/feed');
    expect(peekReturn(Date.now() + 25 * 3600 * 1000)).toBeNull();
  });
});

describe('Feed and Coaching gates', () => {
  it('Feed "Create an account to share with friends" opens sign-up and returns to the Feed', async () => {
    sb.state.signUpSession = true; // project without email confirmation
    await render('/feed');
    await click(button('Create an account to share with friends'));
    expect(heading()).toBe('Create account');
    expect(currentUrl).toBe('/auth?mode=signup&next=%2Ffeed');
    fill('Email', 'ana@example.com');
    fill('Password', 'longenough');
    await submit();
    expect(sb.auth.signUp).toHaveBeenCalledTimes(1);
    expect(currentUrl).toBe('/feed');
  });

  it('Coaching gate opens sign-up and keeps the coaching destination', async () => {
    await render('/coaching/my');
    await click(button('Create an account'));
    expect(heading()).toBe('Create account');
    expect(currentUrl).toBe('/auth?mode=signup&next=%2Fcoaching%2Fmy');
  });

  it('sign-up with email confirmation → "Back to sign in" switches to sign-in → sign-in returns to the Feed', async () => {
    await render('/auth?mode=signup&next=%2Ffeed');
    fill('Email', 'ana@example.com');
    fill('Password', 'longenough');
    await submit();
    expect(heading()).toBe('Check your email');
    await click(button('Back to sign in'));
    expect(heading()).toBe('Sign in');
    expect(container!.querySelector('button[type="submit"]')!.textContent).toBe('Sign in');
    expect((container!.querySelector('input[type="password"]') as HTMLInputElement).value).toBe(''); // password cleared
    fill('Password', 'longenough');
    await submit();
    expect(sb.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'ana@example.com', password: 'longenough' });
    expect(currentUrl).toBe('/feed');
    expect(peekReturn()).toBeNull(); // consumed
  });

  it('the email confirmation link (opened later, without our query) still returns to the Feed', async () => {
    await render('/auth?mode=signup&next=%2Ffeed'); // remembers /feed on this device
    await act(async () => root?.unmount());
    container?.remove();
    await render('/auth/callback');
    await settle();
    expect(currentUrl).toBe('/feed');
    expect(peekReturn()).toBeNull();
  });

  it('recovery: "Back to sign in" after the reset link is sent switches to sign-in', async () => {
    await render('/auth');
    await click(button('Forgot password?'));
    expect(heading()).toBe('Reset password');
    fill('Email', 'ana@example.com');
    await submit();
    expect(heading()).toBe('Reset link sent');
    await click(button('Back to sign in'));
    expect(heading()).toBe('Sign in');
    expect(container!.querySelector('input[type="password"]')).not.toBeNull();
  });
});

describe('privacy information when creating an account', () => {
  it('is shown in sign-up mode, links to Your data, and makes no compliance claims', async () => {
    await render('/auth?mode=signup');
    const details = container!.querySelector('details[aria-label="How your data is handled"]');
    expect(details).not.toBeNull();
    const t = details!.textContent ?? '';
    expect(t).toMatch(/coach you approve/);
    expect(t).toMatch(/AI coach after you agree/);
    expect(t).not.toMatch(/GDPR|HIPAA|compliant|certified|encrypted|always private/i);
    const link = details!.querySelector('a[href="/settings/data"]');
    expect(link).not.toBeNull();
    await click(link as HTMLElement);
    expect(currentUrl).toBe('/settings/data');
  });

  it('is not shown on the sign-in form', async () => {
    await render('/auth');
    expect(container!.querySelector('details[aria-label="How your data is handled"]')).toBeNull();
  });
});
