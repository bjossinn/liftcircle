// @ts-check
import { defineConfig } from 'astro/config';

// Netlify sets URL to the site's primary address at build time. The fallback is only used for local builds.
const site = process.env.URL || 'https://hard-earned.netlify.app';

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
    // Keep every stylesheet and script as a file so the CSP can stay at 'self' with no inline hashes.
    inlineStylesheets: 'never',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
  devToolbar: { enabled: false },
});
