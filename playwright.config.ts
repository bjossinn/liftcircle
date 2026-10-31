import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the PRODUCTION build (vite preview) so the service worker,
 * manifest and offline behaviour are the real thing. Personal mode (no backend env vars).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
    // Every spec starts as a device that already picked a theme, so the first-launch picker doesn't cover the
    // screens under test. tests/e2e/first-run.spec.ts clears this to walk the first-launch path.
    storageState: { cookies: [], origins: [{ origin: 'http://localhost:4173', localStorage: [{ name: 'lc-theme-picked', value: '1' }] }] },
  },
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
