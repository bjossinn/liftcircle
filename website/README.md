# Hard Earned website

The marketing site for Hard Earned. One static page, built with [Astro](https://astro.build) and deployed as
its **own Netlify site**, separate from the app. Nothing here is imported by the app, and the app's build,
code and deploy are unchanged.

- Output: plain HTML, one CSS file, one 1.6 KB (gzipped) script. No framework runtime, no third-party requests,
  no analytics, no cookies.
- Fonts (Inter, Barlow Semi Condensed, latin subsets), icons and screenshots are **copies** in this folder, taken
  from `brand/hard-earned/`, `src/assets/fonts/` and `docs/screenshots/hard-earned/`. Nothing links across
  folders at runtime.

Why Astro over Vite + vanilla TS: the page is mostly content that lives in one strings file, and Astro renders it
to static HTML at build time with zero client JS by default, plus AVIF/WebP image generation with `sharp`. A Vite
setup would need either client-side rendering of the strings (worse for SEO and speed) or a hand-rolled templating
step.

## Run, build, check

Node 22 or newer.

```bash
cd website
npm ci
npm run dev        # http://localhost:4321
npm run build      # writes dist/
npm run preview    # serves dist/ on http://localhost:4321
```

Checks (the browser-based ones need `npm run preview` running and Google Chrome installed):

```bash
npm run check:js        # total JS gzipped, fails over 50 KB
npm run check:contrast  # WCAG ratio of every colour pair the site uses
npm run check:a11y      # axe-core at 390 and 1440 px, with and without reduced motion, every install tab
npm run shots           # full-page screenshots (390 and 1440 px) into docs/
npm run record:demo     # docs/hero-demo.gif and .webp
npm run og              # regenerates public/og.png (1200×630) from the brand icon, fonts and a real screenshot
```

## Where things are

| Path | What |
|---|---|
| `src/config.ts` | `APP_URL` (every "Start tracking" link) and `CONTACT_URL`. Change the app URL here when a domain is bought. |
| `src/content/en.ts` | Every user-facing string, including the split catalog for the week builder. |
| `src/pages/index.astro` | The page. |
| `src/styles/global.css` | All styles. Colour values are the brand tokens. |
| `src/scripts/main.ts` | Reveals, parallax, hero demo, protein chips, install tabs. |
| `netlify.toml` | Build, headers (CSP, caching) and the ignore rule for this site. |
| `docs/` | Review screenshots and the hero demo recording. |

### Adding Icelandic later

Copy `src/content/en.ts` to `is.ts` with the same shape (`Content` type), add `src/pages/is/index.astro` that
imports it, add `/is` to `src/pages/sitemap.xml.ts`, and add `hreflang` links in `src/layouts/Base.astro`. Inter
and Barlow's latin subsets already cover Þ, Æ, Ð and the accented vowels.

### Fact sources

Every product claim was checked against the repo before it went in. If the app changes, recheck:

- Recipe count (275): `src/data/recipes.ts` plus the four `src/data/recipes/pack3-*.ts` files.
- Split names, session names and trade-offs: `src/domain/program/splits.ts` (strength table) and
  `src/domain/program/templates.ts`. Mirrored in `en.ts` under `plan.builder.splits`.
- Coach styles: `src/features/coaching/ai/model.ts`.
- Logging, nutrition, sharing, coaching, notifications, install, backups: `docs/USER_GUIDE.md`.
- Recipe names in the example meal plan are real recipe names from the data files.

## Deploying: the second Netlify site

The app keeps its existing Netlify site. The website is a **new site from the same repository**:

1. Netlify → **Add new site** → **Import an existing project** → GitHub → pick `bjossinn/liftcircle`.
2. Build settings:
   - **Base directory:** `website`
   - **Build command:** `npm ci && npm run build`
   - **Publish directory:** `website/dist` (Netlify shows it relative to the repo root; it's `dist` inside `website/netlify.toml`)
   - **Branch to deploy:** `main`
3. No environment variables are needed. `NODE_VERSION = 22` is set in `website/netlify.toml`.
4. Deploy. Then set the site name or a custom domain. Canonical, Open Graph and sitemap URLs come from Netlify's
   `URL` variable at build time, so they follow the site's primary domain automatically. Redeploy once after
   changing the domain.

Builds are skipped automatically when nothing relevant changed:

- `website/netlify.toml` builds the website only when something under `website/` changed.
- The app's root `netlify.toml` now has the matching rule: it skips app builds when **only** `website/` changed.
  Everything else about the app build is identical.
- Both rules still build when Netlify has no earlier deploy to compare with.

Headers (set in `website/netlify.toml`): a strict CSP (`'self'` only, no inline scripts or styles), HSTS, nosniff,
frame denial, referrer and permissions policies, immutable caching for hashed `/_astro/*` files and fonts, and
revalidation for HTML.

## Notes

- Screens on the site are the app's own screenshots from `docs/screenshots/hard-earned/`, which show the app's
  labelled demo dataset. The footer says so.
- The hero set logger, the share preview and the training assistant chat are illustrations, labelled as a demo,
  a preview and an example conversation.
- Motion stops completely with `prefers-reduced-motion`. The hero demo has a pause button (it also pauses the
  ticker), and the demo stops while off screen.
