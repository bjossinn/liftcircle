# Third-party media

Every image, video or illustration the app bundles or loads that Hard Earned did not create itself is listed here
with its source, licence and how we comply. Adding media from a new source needs an entry here **before** it ships.

## Exercise illustrations: Everkinetic (CC BY-SA 4.0)

| | |
|---|---|
| What | Start/end line drawings for 45 of the 105 library exercises (43 distinct illustrations) |
| Source | Everkinetic open data, https://github.com/everkinetic/data (commit `446bb9a3d0c3beb6b84f7c9d77dfc8af707a2ab6`, 20 Feb 2022), from the everkinetic.com exercise database created by Greg Priday |
| Licence | Creative Commons Attribution-ShareAlike 4.0 International (`LICENSE.md` in the source repository), https://creativecommons.org/licenses/by-sa/4.0/ |
| Commercial use | Allowed, with attribution and share-alike on the images themselves |
| Where | `public/exercise-media/v1/ek-<id>/{0,1,thumb}.webp`, self-hosted, same origin (covered by the CSP's `img-src 'self'`) |
| Mapping | `src/data/exerciseMedia.json` (library exercise id → Everkinetic id), read by `src/data/exerciseMedia.ts` |
| Build | `node scripts/build-exercise-media.mjs <everkinetic checkout>` |

**Changes we made (the licence asks for them to be indicated):** each source PNG was trimmed to the drawing, padded
to a square, resized (480 px frames, 96 px thumbnails) and converted to WebP with the white background turned into
transparency, so the drawing can sit on any theme surface. The dark theme also inverts the lines to light grey with a
CSS filter at display time. The adapted images are licensed under CC BY-SA 4.0, like the originals
(`public/exercise-media/LICENSE.txt`).

**How we comply:**

- *Attribution:* every illustration is shown with the credit "Illustration: Everkinetic, CC BY-SA 4.0"
  (`src/components/ExerciseVisual.tsx`). "Everkinetic" links to the in-app **Credits & licences** page (`/credits`,
  `src/features/settings/CreditsPage.tsx`; same origin, works offline), which gives the full attribution: creator
  (Everkinetic / everkinetic.com, created by Greg Priday), source repository link, licence name and link, and the notice
  of our changes. "CC BY-SA 4.0" links to the licence deed. Surfaces that only show 44 px thumbnails (exercise library
  and picker) end with a shared credit line linking to the same page, and Settings → Account lists it next to About. The
  logger's thumbnails expand into a credited illustration. This file and `public/exercise-media/LICENSE.txt` record the
  same source, licence and changes.
- *Share-alike:* applies to the images and our adaptations of them only. They are published under the same licence;
  the app's code and other content are a separate work that merely displays them and are not affected.
- *No additional restrictions:* the files are served as ordinary public images without DRM.

**Provenance check.** The illustrations are line drawings made for everkinetic.com and released by that project under
CC BY-SA; we found no third-party branding, watermarks or signs of copied photographs in any of the 43 illustrations we
use (each was reviewed by eye). As with any open licence, we rely on the licensor's statement that they hold the rights.

## Considered and rejected: yuhonas/free-exercise-db photos

The brief named the public-domain (Unlicense) free-exercise-db photos as the preferred source. They were **not used**:

- The repository and its upstream (`wrkout/exercises.json`) both declare the Unlicense, but neither documents who took
  the photos or that the uploader held the rights to dedicate them to the public domain.
- At least one photo (`Leverage_Chest_Press/0.jpg` and `/1.jpg`) shows a model wearing a "BODYBUILDING.COM" shirt in
  the photo, which points to the photos originating from a commercial website's exercise database rather than from
  the dataset's authors.
- A public-domain dedication is only valid from the copyright holder, so the Unlicense on these files gives us no
  reliable permission to bundle them in a commercial app.

If the owner obtains confirmation of the photos' provenance, the mapping/build pipeline can take a second source
(`source` field in `src/data/exerciseMedia.json`), but until then they must not be added.

## Exercises without an illustration

Custom exercises and the 60 library exercises with no matching, correctly licensed illustration keep the original Hard
Earned movement-pattern glyph (`src/components/ExerciseGlyph.tsx`). A near match was rejected when it showed a
different movement or grip (for example: an upright row for a band lateral raise, a bent-over cable raise for a
standing cable lateral raise, a dip machine for a bar dip, an incline press for a seated shoulder press). Two small,
labelled exceptions differ in load only ("Shown with a barbell" for the Bulgarian split squat, "Shown without added
weight" for weighted dips and weighted pull-ups).
