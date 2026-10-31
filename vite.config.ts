import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { BRAND } from './src/config/brand';
import pkg from './package.json' with { type: 'json' };

/**
 * public/_headers ships a Content-Security-Policy that allows the inline theme script in index.html by hash.
 * Fail the build if an inline script's hash isn't in that policy (e.g. index.html was edited), printing the
 * hash to put there — otherwise the theme script would be silently blocked in production.
 */
function cspInlineScriptCheck(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hard-earned-csp-inline-script-check',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const htmlFile = path.join(outDir, 'index.html');
      const headersFile = path.join(outDir, '_headers');
      if (!fs.existsSync(htmlFile) || !fs.existsSync(headersFile)) return;
      const csp = fs.readFileSync(headersFile, 'utf8').match(/Content-Security-Policy:(.*)/)?.[1] ?? '';
      if (!csp) return;
      const html = fs.readFileSync(htmlFile, 'utf8');
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        const hash = `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`;
        if (!csp.includes(hash)) {
          throw new Error(`Inline script in index.html is not allowed by the CSP in public/_headers. Add ${hash} to script-src (and remove the old hash).`);
        }
      }
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    cspInlineScriptCheck(),
    VitePWA({
      // "prompt": we show our own "Update available" banner and only apply the
      // update when no workout is active (see src/pwa/update.ts).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/apple-touch-icon-180.png', 'icons/favicon-16.png', 'icons/favicon-32.png'],
      manifest: {
        id: '/',
        name: BRAND.name,
        short_name: BRAND.shortName,
        description: BRAND.description,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: BRAND.themeColor,
        background_color: BRAND.backgroundColor,
        categories: ['health', 'fitness', 'lifestyle'],
        icons: [
          // The approved Hard Earned exports (brand/hard-earned/assets), copied unchanged by scripts/copy-brand-icons.mjs.
          { src: '/icons/hard-earned-pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/hard-earned-pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/hard-earned-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell and bundled exercise/recipe data (they're JS chunks).
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/auth\/v1/, /^\/rest\/v1/, /^\/storage\/v1/, /^\/functions\/v1/],
        cleanupOutdatedCaches: true,
        // Deliberately NO runtimeCaching entries: Supabase auth, REST/RPC responses,
        // friends' photos and signed media URLs must never land in the SW cache.
        // Personal offline data lives in account-scoped IndexedDB instead.
        runtimeCaching: [],
        // Push + notificationclick handlers (public/push-sw.js). They add no routes or caching.
        importScripts: ['push-sw.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks: an app-only release changes the small app chunk, so installed PWAs
        // re-download ~70 KB (gzip) instead of the whole ~230 KB startup bundle.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|cookie|set-cookie-parser)\//.test(id)) return 'vendor-react';
          if (/\/node_modules\/(@supabase\/[^/]+|iceberg-js)\//.test(id)) return 'vendor-backend';
          if (/\/node_modules\/(dexie|dexie-react-hooks)\//.test(id)) return 'vendor-dexie';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['tests/unit/setup.ts'],
  },
} as import('vite').UserConfig);
