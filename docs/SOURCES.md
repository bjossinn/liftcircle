# Sources, assumptions, licensing and limitations

Hard Earned separates **evidence-backed guidance** from **adjustable product defaults**. Everything the app prescribes
is a starting point the user can change.

## Training

| Topic | What the app does | Status |
|---|---|---|
| Resistance-training guidance | Sessions cover squat/lunge, hinge, horizontal & vertical push/pull and trunk; major muscles ~2×/week when the schedule allows; conservative volumes. Reference from the product brief: ACSM resistance-training guideline update (2026), https://acsm.org/resistance-training-guidelines-update-2026/ — the specific numbers below are our product defaults, not quotations from it | Evidence-informed |
| Split by lifting days | 1 full body · 2 A/B · 3 A/B/C · 4 upper/lower ×2 · 5 upper/lower + PPL (if experience fits) · 6 PPL ×2 (experienced) | **Product default** |
| Sets/reps | Beginners 2–3 working sets; muscle ~8–12, accessories ~10–15; experienced strength main lifts 3–6; RIR start 2–3 | **Product default** |
| Progression | Double progression: top of range on all working sets at target effort in two comparable sessions → smallest practical increase, then aim for the bottom of the range | **Product default** |
| Starting loads | Never inferred from age/bodyweight; known comfortable load or calibration session | Safety rule |
| Estimated 1RM | Epley `w × (1 + r/30)`, only loaded free-weight lifts at 1–10 reps, always labelled "estimated" | Common estimate |
| Volume | weight × reps × implements (per-hand pairs ×2), unilateral ×2; machines and added-bodyweight load kept separate; assisted/bodyweight counted as reps | **Product convention** (shown in UI) |
| Working sets per muscle | primary = 1, secondary = 0.5 | **Product convention** |

No recovery scores, no claims about muscle gained from volume, no injury/overtraining diagnoses.

## Nutrition

| Topic | Implementation | Source |
|---|---|---|
| Protein | 1.6–2.2 g/kg/day practical planning range for healthy adults building muscle; 1.8 g/kg editable default; reference weight = current, explicitly chosen goal, or custom (never an "ideal weight"). 100 kg × 1.8 = 180 g. | Morton et al. 2018, BJSM — https://bjsm.bmj.com/content/52/6/376.full |
| Resting energy | Mifflin–St Jeor: male `10w + 6.25h − 5a + 5`, female `10w + 6.25h − 5a − 161` | Mifflin et al. 1990 — https://pubmed.ncbi.nlm.nih.gov/2305711/ |
| Activity factor | 1.2 / 1.375 / 1.55 / 1.725 / 1.9, shown separately and editable | Standard multipliers — **assumption** |
| Goal adjustment | maintenance; ≈ +5 % muscle gain; ≈ −10 % fat loss (clamped −20…+15 %); no guaranteed rate | **Product default** |
| Macros | protein from target; fat = max(27.5 % kcal, 0.6 g/kg); carbs = remainder; 4/4/9 reconciliation; incompatible targets flagged | **Product default** |
| Exercise calories | not eaten back automatically | Product rule |
| Food data | per-100 g values for 124 generic ingredients based on USDA FoodData Central SR Legacy typical values (FDC IDs cited where verified); a few branded-style items use typical label values and are marked as such; dry vs cooked distinguished | USDA FDC — https://fdc.nal.usda.gov/ (public domain) |
| Under 18 / individualized | no automatic calorie, weight-loss or protein prescription; logging + manual targets | Safety rule |

Recipe nutrition is **computed from ingredients**, so it's an estimate. Allergen tags derive from generic ingredient
data and cannot guarantee safety; users are prompted to verify packaged-food labels.

### Ingredients added with the November 2026 recipe pack

28 generic ingredients, per 100 g in the stated state, from USDA FoodData Central SR Legacy typical values
(https://fdc.nal.usda.gov/, public domain). FDC IDs are not cited for these, so each `source` string reads
"Typical value (USDA FDC generic, approximate)" plus the SR Legacy description below. Carbohydrate is "by difference"
(includes fibre).

| Ingredient id | SR Legacy description |
|---|---|
| `haddock-raw` | Fish, haddock, raw |
| `smoked-salmon` | Fish, salmon, chinook, smoked |
| `sardines-canned` | Fish, sardine, Atlantic, canned in oil, drained solids with bone |
| `lamb-mince-raw` | Lamb, ground, raw |
| `turkey-mince-raw` | Turkey, ground, raw |
| `pork-tenderloin-raw` | Pork, fresh, loin, tenderloin, separable lean only, raw |
| `mozzarella-light` | Cheese, mozzarella, part skim milk |
| `parmesan` | Cheese, parmesan, hard |
| `tortilla-corn` | Tortillas, ready-to-bake or -fry, corn |
| `rice-cakes` | Snacks, rice cakes, brown rice, plain |
| `pita-wholewheat` | Bread, pita, whole-wheat |
| `couscous-dry` | Couscous, dry |
| `rice-noodles-cooked` | Rice noodles, cooked |
| `kidney-beans-cooked` | Beans, kidney, red, mature seeds, cooked, boiled, without salt |
| `white-beans-cooked` | Beans, white, mature seeds, cooked, boiled, without salt |
| `cabbage` | Cabbage, raw |
| `green-beans` | Beans, snap, green, raw |
| `cauliflower` | Cauliflower, raw |
| `spring-onion` | Onions, spring or scallions (includes tops and bulb), raw |
| `ginger` | Ginger root, raw |
| `raspberries` | Raspberries, raw |
| `raisins` | Raisins, seedless |
| `lime-juice` | Lime juice, raw |
| `cashews` | Nuts, cashew nuts, raw |
| `sunflower-seeds` | Seeds, sunflower seed kernels, dried |
| `sesame-oil` | Oil, sesame, salad or cooking |
| `maple-syrup` | Syrups, maple |
| `cocoa-powder` | Cocoa, dry powder, unsweetened (USDA uses food-specific energy factors, so kcal sits well below 4/4/9) |

### Ingredients added with recipe pack 3 (November 2026)

22 generic ingredients, per 100 g in the stated state. 20 use USDA FoodData Central SR Legacy typical values
(https://fdc.nal.usda.gov/, public domain), with `source` reading "Typical value (USDA FDC generic, approximate)" plus
the description below. The two protein powders have no USDA or ÍSGEM entry and use typical label values of
unflavoured products (marked "Typical label value"); light coconut milk too. Brands vary: check your own labels.

| Ingredient id | Source description |
|---|---|
| `beef-steak-raw` | Beef, top sirloin, steak, separable lean only, trimmed to 1/8" fat, choice, raw |
| `pork-loin-raw` | Pork, fresh, loin, center loin (chops), boneless, separable lean only, raw |
| `ham-sliced` | Ham, sliced, pre-packaged, deli meat (96% fat free, water added) |
| `lamb-leg-raw` | Lamb, leg, whole (shank and sirloin), separable lean only, trimmed to 1/4" fat, choice, raw |
| `turkey-breast-raw` | Turkey, breast, meat only, raw |
| `saithe-raw` | Fish, pollock, Atlantic, raw (saithe/ufsi is the Atlantic pollock sold in Iceland) |
| `mackerel-canned` | Fish, mackerel, jack, canned, drained solids |
| `mussels-cooked` | Mollusks, mussel, blue, cooked, moist heat |
| `squid-raw` | Mollusks, squid, mixed species, raw |
| `whey-protein` | Typical label value: whey protein concentrate powder, unflavoured |
| `pea-protein` | Typical label value: pea protein isolate powder, unflavoured |
| `ricotta` | Cheese, ricotta, part skim milk |
| `bulgur-dry` | Bulgur, dry |
| `egg-noodles-dry` | Noodles, egg, dry, enriched |
| `sweetcorn-canned` | Corn, sweet, yellow, canned, whole kernel, drained solids |
| `rocket` | Arugula, raw |
| `aubergine` | Eggplant, raw |
| `leek` | Leeks, (bulb and lower leaf-portion), raw |
| `kale` | Kale, raw |
| `mango` | Mangos, raw |
| `passata` | Tomato products, canned, puree, without salt added |
| `coconut-milk-light` | Typical label value: light coconut milk, canned (about 7 % fat) |

**Protein groups.** Every protein food carries a `proteinGroup` (`PROTEIN_GROUP_OF` in src/data/ingredients.ts) used for
"proteins I like / not for me". Milk and butter are deliberately untagged: the dairy group means the protein-rich dairy
foods (skyr, yogurt, cottage cheese, cheese); avoiding all milk is the dairy-free diet or the milk allergy.

## Content licensing

- All 105 exercise descriptions, cues and mistakes, and all 275 recipes (24 starters, 60 added in pack 2 and 191 in pack 3, November 2026), were written for this project (original text). Nothing was copied from websites or books.
- No third-party exercise photos/videos are bundled or hot-linked; each exercise shows an original line glyph for its
  movement pattern. Adding media later requires a licence that permits it and attribution in this file.
- Icons: `lucide-react` (ISC licence). App mark and launcher icons: the approved Hard Earned assets from
  `brand/hard-earned/assets/` (see its asset-manifest.json), copied unchanged by `scripts/copy-brand-icons.mjs`.
- Fonts (self-hosted Latin subsets, SIL Open Font License 1.1, licence texts in `src/assets/fonts/`): Inter
  (© The Inter Project Authors, via @fontsource-variable/inter 5.3.0) and Barlow Semi Condensed 700 (© The Barlow
  Project Authors, via @fontsource/barlow-semi-condensed 5.3.0).
- USDA FoodData Central data is in the public domain (U.S. Government work).
- No live food database or barcode provider is integrated; adding one needs a working integration and attribution.

## Browser and platform limitations

- **Storage:** IndexedDB can be cleared by the user or evicted by the browser under pressure. The app requests
  persistent storage (`navigator.storage.persist()`), explains the risk, and provides backups and cloud sync.
  (MDN: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- **Timers:** browsers throttle or suspend timers in background tabs and locked screens. Rest/interval timers store
  deadlines and recalculate on return; audible/vibration alerts while locked are not guaranteed.
  (MDN setTimeout: https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout)
- **Vibration** is unavailable on iOS Safari; **Wake Lock** depends on browser support and can be refused (e.g. low power).
- **Install:** Chromium browsers show an install prompt; iOS requires Safari → Share → Add to Home Screen (Open as Web App).
  Apple: https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios · MDN: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- **Updates:** Workbox "prompt" strategy; the new version activates only when the user taps Update and never during an
  active workout (https://developer.chrome.com/docs/workbox/handling-service-worker-updates).
- **Photos:** HEIC/AVIF only where the browser can decode them; animated GIFs become stills.
- **Revocation:** after unfriending/blocking/audience changes, no new signed URLs are issued, but a URL already
  downloaded stays valid until it expires (≤ 5 minutes) and images already shown may remain in that device's memory.
- **Push notifications** are not implemented (in-app notifications only).
- **GPS tracking and wearables** are not implemented (manual activity logging only).

## Backend references

- Supabase row-level security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase private storage buckets: https://supabase.com/docs/guides/storage/buckets/fundamentals
