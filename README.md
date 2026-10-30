# LiftCircle

A mobile-first fitness PWA with three parts in one app:

1. **Tracker** — fast weightlifting logger (one-tap sets, rest timer, supersets, warm-ups, history, records) and manual logging for runs, walks, rides, swims, classes, yoga and more.
2. **Plan** — an onboarding wizard that generates an editable, explainable training program, double-progression suggestions, and optional protein / calorie targets with 84 recipes, meal plans and a shopping list.
3. **Social** — mutual friends, a chronological feed of shared workouts and photos, likes, comments, notifications, reporting and blocking.
4. **Coaching** — a directory of approved human coaches (with admin review), consent-based coaching with messaging and program proposals, and an optional AI coach backed by the OpenAI or Anthropic API on the server.

It installs to an iPhone or Android home screen, runs standalone, and keeps logging workouts offline.

The name and colours live in `src/config/brand.ts`, so they're easy to change.

## Two modes

| | Personal mode | Connected mode |
|---|---|---|
| Needs | nothing | a Supabase project (free tier is fine) |
| Workouts, programs, nutrition, progress | ✅ on this device | ✅ + backed up and synced across devices |
| Friends, feed, photos, likes, comments | – (explained in-app) | ✅ |
| Human coaches, coach directory | – (explained in-app) | ✅ (after the coaching migrations) |
| AI coach | – | ✅ when an OpenAI or Anthropic API key is set as a function secret |
| Backup | JSON/CSV export | export + automatic cloud sync |

Without `.env.local` the app runs in Personal mode. Add the two publishable Supabase values to switch on Connected mode (see [docs/SETUP.md](docs/SETUP.md)).

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173  (Personal mode)
npm run build && npm run preview   # production build with the service worker, http://localhost:4173
```

Requires Node 20+ (22 recommended). `.npmrc` sets `legacy-peer-deps` to avoid an npm peer-resolution bug with Vitest 4.

## Tests

```bash
npm run typecheck   # TypeScript, app + tooling
npm test            # 251 unit tests: generator, progression, nutrition, stats, sync engine, backups, …
npm run test:rls    # 223 real-Postgres checks: RLS, RPCs, storage policies, access matrix (needs PostgreSQL 16 binaries)
npm run test:e2e    # 10 Playwright tests against the production build (onboarding, offline logging, units, backups, PWA)
npm run test:live   # optional: live two-account test against YOUR Supabase project (see tests/connected)
```

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — beginner-friendly setup: local, Supabase backend, auth redirects, storage, deployment to Netlify.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — onboarding, logging, sharing, installing on a phone, backups.
- [docs/BACKEND.md](docs/BACKEND.md) — schema, authorization model, access matrix, RPCs, storage, Edge Functions.
- [docs/SOURCES.md](docs/SOURCES.md) — evidence, formula assumptions, content licensing, browser limitations.
- [BUILD_STATUS.md](BUILD_STATUS.md) — what's done, what was tested and how, and what still needs external setup.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md), [docs/INTERFACES.md](docs/INTERFACES.md) — code layout for contributors.

## Project layout

```
src/
  domain/      pure logic: types, units, program generator, schedule, progression, stats, nutrition, session ops
  data/        bundled read-only catalogs: 105 exercises, 102 ingredients, 84 recipes
  db/          Dexie (IndexedDB) – one database per account ("guest", "demo", or the user id)
  sync/        outbox sync engine (server versions, compare-and-swap, conflicts, tombstones)
  backend/     Supabase client, SocialApi + SyncRemote implementations, API contract
  social/      photo pipeline (resize, EXIF strip), share snapshots, offline post queue
  features/    screens: today, train, program, onboarding, exercises, activities, progress, nutrition, social, settings, auth
  pwa/         service-worker registration, update banner, install prompt
supabase/      migrations, seed, Edge Functions, config.toml
tests/         unit (Vitest), rls (real Postgres), e2e (Playwright), connected (live)
```
