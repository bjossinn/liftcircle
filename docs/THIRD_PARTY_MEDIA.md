# Media sources

Every image, video or illustration the app bundles or loads is listed here with where it came from and on what
terms. Adding media from a new source needs an entry here **before** it ships.

**Third-party media currently bundled or hot-linked: none.**

## Exercise illustrations (first-party, AI-generated)

| | |
|---|---|
| What | One illustration per library exercise (all 105): an 800×800 two-panel image showing the start position on the left and the end position on the right, plus a 256×256 thumbnail |
| Origin | Generated with ChatGPT (OpenAI image generation) for Hard Earned, on the owner's instruction. The owner's position is that the output belongs to Hard Earned and needs no attribution |
| Where | `public/exercise-media/v2/<exercise id>/{full,thumb}.webp`, self-hosted, same origin (covered by the CSP's `img-src 'self'`). Imported from `hard-earned-exercise-media-v2.tar.gz` (sha256 `04e884e677a098eb4a34b758261f6d0c1bb9e800f33facc7d6b1b4129ce27036`, branch `ai-exercise-media-v2`); the archive itself is not committed to `main` |
| Mapping | None needed: every library exercise id resolves to its folder (`src/data/exerciseMedia.ts`). `tests/unit/exerciseMedia.test.ts` fails if any id is missing a file, a file has the wrong size, or a stray folder ships |
| Text | Technique cues are i18n strings (`exercise.cues.<id>.<n>`), not baked into the images, so they can be translated |

Owner notes: AI-generated images can contain anatomical or form mistakes, so each image should be checked against
its exercise before release (the folder name is the exercise id). Whether purely AI-generated images can be protected
by copyright depends on the jurisdiction; that affects whether others may reuse them, not whether we may use them.

## Earlier options, not used

- **Everkinetic line drawings (CC BY-SA 4.0).** Used in an earlier revision of this PR, with attribution and an in-app
  credits page. Replaced by the first-party illustrations above at the owner's request; nothing from Everkinetic ships.
- **yuhonas/free-exercise-db photos.** Rejected. They're labelled public domain (Unlicense), but the dataset doesn't
  say who took the photos, and at least one (`Leverage_Chest_Press/0.jpg` and `1.jpg`) shows a model in a
  "BODYBUILDING.COM" shirt, which points to a commercial site's exercise database. A public-domain dedication only
  counts if it comes from the copyright holder, so these files give no reliable permission for a commercial app.
