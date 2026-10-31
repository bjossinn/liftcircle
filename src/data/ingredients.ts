/**
 * Bundled generic ingredient reference data (read-only, works offline).
 *
 * Values are per 100 g in the stated state, taken from USDA FoodData Central (SR Legacy / Foundation)
 * typical values. Where we are confident of the exact FDC entry the description and fdcId are cited;
 * otherwise the source reads "Typical value (USDA FDC generic, approximate)". Items without a USDA
 * equivalent (skyr, oat drink, soy yogurt, stock) use typical label values of plain/unsweetened products.
 * Carbohydrate is USDA "carbohydrate by difference" (includes fibre). Brands vary: check your own labels.
 */
import type { Allergen, ID, Ingredient, ProteinGroup } from '@/domain/types';

type Diet = Ingredient['diet'];
const PLANT: Diet = { vegetarian: true, vegan: true, dairyFree: true, glutenFree: true, pescatarian: true };
const PLANT_GLUTEN: Diet = { ...PLANT, glutenFree: false };
const DAIRY: Diet = { vegetarian: true, vegan: false, dairyFree: false, glutenFree: true, pescatarian: true };
const EGG: Diet = { vegetarian: true, vegan: false, dairyFree: true, glutenFree: true, pescatarian: true };
const MEAT: Diet = { vegetarian: false, vegan: false, dairyFree: true, glutenFree: true, pescatarian: false };
const FISH: Diet = { vegetarian: false, vegan: false, dairyFree: true, glutenFree: true, pescatarian: true };
const HONEY: Diet = { ...PLANT, vegan: false };

const fdc = (desc: string, id: number) => `USDA FoodData Central SR Legacy: "${desc}" (fdcId ${id})`;
const typ = (desc: string) => `Typical value (USDA FDC generic, approximate): "${desc}"`;
const label = (desc: string) => `Typical label value (generic, approximate): ${desc}`;

function ing(
  id: ID,
  name: string,
  category: Ingredient['category'],
  state: Ingredient['state'],
  m: [kcal: number, protein: number, carbs: number, fat: number, fiber?: number],
  source: string,
  diet: Diet,
  costTier: 1 | 2 | 3,
  allergens: Allergen[] = [],
  units?: Ingredient['units'],
): Ingredient {
  const [kcal, protein, carbs, fat, fiber] = m;
  return { id, name, category, state, per100g: { kcal, protein, carbs, fat, ...(fiber != null ? { fiber } : {}) }, source, allergens, diet, units, costTier };
}

const INGREDIENT_LIST: Ingredient[] = [
  /* ---------------------------------------------------------- protein foods */
  ing('chicken-breast-raw', 'Chicken breast, skinless (raw)', 'protein', 'raw', [120, 22.5, 0, 2.62, 0],
    fdc('Chicken, broilers or fryers, breast, skinless, boneless, meat only, raw', 171077), MEAT, 2),
  ing('chicken-breast-cooked', 'Chicken breast, roasted (cooked)', 'protein', 'cooked', [165, 31.02, 0, 3.57, 0],
    fdc('Chicken, broilers or fryers, breast, meat only, cooked, roasted', 171477), MEAT, 2),
  ing('chicken-thigh-raw', 'Chicken thigh, skinless (raw)', 'protein', 'raw', [121, 19.66, 0, 4.12, 0],
    typ('Chicken, broilers or fryers, dark meat, thigh, meat only, raw'), MEAT, 2),
  ing('beef-mince-10-raw', 'Beef mince, 10% fat (raw)', 'protein', 'raw', [176, 20.0, 0, 10.0, 0],
    typ('Beef, ground, 90% lean meat / 10% fat, raw'), MEAT, 3),
  ing('cod-raw', 'Cod fillet (raw)', 'protein', 'raw', [82, 17.81, 0, 0.67, 0],
    typ('Fish, cod, Atlantic, raw'), FISH, 2, ['fish']),
  ing('salmon-raw', 'Salmon fillet, farmed (raw)', 'protein', 'raw', [208, 20.42, 0, 13.42, 0],
    typ('Fish, salmon, Atlantic, farmed, raw'), FISH, 3, ['fish']),
  ing('tuna-canned', 'Tuna in water, drained', 'protein', 'as_sold', [116, 25.51, 0, 0.82, 0],
    typ('Fish, tuna, light, canned in water, drained solids'), FISH, 2, ['fish'], { can: 120 }),
  ing('shrimp-cooked', 'Prawns/shrimp, cooked & peeled', 'protein', 'cooked', [99, 23.98, 0.2, 0.28, 0],
    typ('Crustaceans, shrimp, cooked'), FISH, 3, ['shellfish']),
  ing('egg', 'Egg, whole (raw)', 'protein', 'raw', [143, 12.56, 0.72, 9.51, 0],
    fdc('Egg, whole, raw, fresh', 171287), EGG, 1, ['egg'], { piece: 50 }),
  ing('egg-white', 'Egg white (raw)', 'protein', 'raw', [52, 10.9, 0.73, 0.17, 0],
    typ('Egg, white, raw, fresh'), EGG, 1, ['egg'], { piece: 33 }),
  ing('tofu-firm', 'Tofu, firm', 'protein', 'as_sold', [144, 17.27, 2.78, 8.72, 2.3],
    typ('Tofu, raw, firm, prepared with calcium sulfate'), PLANT, 1, ['soy']),
  ing('tempeh', 'Tempeh', 'protein', 'as_sold', [192, 20.29, 7.64, 10.8],
    typ('Tempeh'), PLANT, 3, ['soy']),

  /* ---------------------------------------------------- dairy & alternatives */
  ing('skyr-plain', 'Skyr, plain', 'dairy', 'as_sold', [63, 11.0, 3.9, 0.2, 0],
    label('plain unsweetened Icelandic skyr (no USDA entry)'), DAIRY, 1, ['milk'], { cup: 240 }),
  ing('greek-yogurt-0', 'Greek yogurt, plain, fat-free', 'dairy', 'as_sold', [59, 10.19, 3.6, 0.39, 0],
    fdc('Yogurt, Greek, plain, nonfat', 170894), DAIRY, 2, ['milk'], { cup: 227 }),
  ing('cottage-cheese', 'Cottage cheese, low-fat', 'dairy', 'as_sold', [81, 10.45, 4.76, 2.27, 0],
    typ('Cheese, cottage, lowfat, 2% milkfat'), DAIRY, 2, ['milk'], { cup: 226 }),
  ing('milk', 'Milk, semi-skimmed', 'dairy', 'as_sold', [50, 3.3, 4.8, 1.98, 0],
    typ('Milk, reduced fat, fluid, 2% milkfat'), DAIRY, 1, ['milk'], { cup: 244 }),
  ing('oat-drink', 'Oat drink', 'dairy', 'as_sold', [46, 1.0, 6.7, 1.5, 0.8],
    label('oat drink, unsweetened, calcium-fortified'), PLANT_GLUTEN, 2, ['gluten'], { cup: 240 }),
  ing('soy-drink', 'Soy drink, unsweetened', 'dairy', 'as_sold', [33, 3.0, 0.7, 1.8, 0.6],
    label('soy drink, unsweetened, calcium-fortified'), PLANT, 2, ['soy'], { cup: 243 }),
  ing('soy-yogurt', 'Soy yogurt, plain', 'dairy', 'as_sold', [55, 4.0, 3.0, 2.5, 0.9],
    label('plain soy yogurt alternative, unsweetened'), PLANT, 2, ['soy'], { cup: 240 }),
  ing('gouda', 'Cheese, gouda-style', 'dairy', 'as_sold', [356, 24.94, 2.22, 27.44, 0],
    typ('Cheese, gouda'), DAIRY, 2, ['milk'], { slice: 20 }),
  ing('feta', 'Feta cheese', 'dairy', 'as_sold', [264, 14.21, 4.09, 21.28, 0],
    typ('Cheese, feta'), DAIRY, 2, ['milk']),

  /* ------------------------------------------------------- grains & starches */
  ing('oats-dry', 'Rolled oats (dry)', 'grain', 'dry', [379, 13.15, 67.7, 6.52, 10.1],
    typ('Cereals, oats, regular and quick, not fortified, dry'), PLANT_GLUTEN, 1, ['gluten'], { cup: 81, tbsp: 5 }),
  ing('rice-white-dry', 'White rice (dry)', 'grain', 'dry', [365, 7.13, 79.95, 0.66, 1.3],
    typ('Rice, white, long-grain, regular, raw, enriched'), PLANT, 1, [], { cup: 185 }),
  ing('rice-white-cooked', 'White rice (cooked)', 'grain', 'cooked', [130, 2.69, 28.17, 0.28, 0.4],
    typ('Rice, white, long-grain, regular, enriched, cooked'), PLANT, 1, [], { cup: 158 }),
  ing('quinoa-dry', 'Quinoa (dry)', 'grain', 'dry', [368, 14.12, 64.16, 6.07, 7.0],
    typ('Quinoa, uncooked'), PLANT, 2, [], { cup: 170 }),
  ing('quinoa-cooked', 'Quinoa (cooked)', 'grain', 'cooked', [120, 4.4, 21.3, 1.92, 2.8],
    typ('Quinoa, cooked'), PLANT, 2, [], { cup: 185 }),
  ing('pasta-dry', 'Pasta (dry)', 'grain', 'dry', [371, 13.04, 74.67, 1.51, 3.2],
    typ('Pasta, dry, enriched'), PLANT_GLUTEN, 1, ['wheat', 'gluten']),
  ing('pasta-cooked', 'Pasta (cooked)', 'grain', 'cooked', [158, 5.8, 30.86, 0.93, 1.8],
    typ('Pasta, cooked, enriched, without added salt'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { cup: 140 }),
  ing('rye-bread', 'Rye bread', 'grain', 'as_sold', [259, 8.5, 48.3, 3.3, 5.8],
    typ('Bread, rye'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { slice: 32 }),
  ing('wholewheat-bread', 'Wholemeal bread', 'grain', 'as_sold', [247, 12.95, 41.29, 3.35, 6.8],
    typ('Bread, whole-wheat, commercially prepared'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { slice: 32 }),
  ing('tortilla-wheat', 'Wheat tortilla', 'grain', 'as_sold', [306, 8.2, 50.0, 8.0, 3.5],
    typ('Tortillas, ready-to-bake or -fry, flour'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { piece: 45 }),
  ing('rye-crispbread', 'Rye crispbread', 'grain', 'as_sold', [334, 9.6, 80.4, 0.9, 22.9],
    typ('Crackers, rye, wafers, plain'), PLANT_GLUTEN, 1, ['gluten'], { piece: 10 }),
  ing('potato-raw', 'Potatoes (raw)', 'grain', 'raw', [77, 2.05, 17.49, 0.09, 2.1],
    typ('Potatoes, flesh and skin, raw'), PLANT, 1, [], { piece: 213 }),
  ing('sweet-potato-raw', 'Sweet potato (raw)', 'grain', 'raw', [86, 1.57, 20.12, 0.05, 3.0],
    typ('Sweet potato, raw, unprepared'), PLANT, 2, [], { piece: 130 }),

  /* ----------------------------------------------------------------- legumes */
  ing('lentils-dry', 'Lentils, red or brown (dry)', 'legume', 'dry', [352, 24.63, 63.35, 1.06, 10.7],
    typ('Lentils, raw'), PLANT, 1, [], { cup: 192 }),
  ing('lentils-cooked', 'Lentils (cooked)', 'legume', 'cooked', [116, 9.02, 20.13, 0.38, 7.9],
    typ('Lentils, mature seeds, cooked, boiled, without salt'), PLANT, 1, [], { cup: 198 }),
  ing('chickpeas-cooked', 'Chickpeas, cooked or canned (drained)', 'legume', 'cooked', [164, 8.86, 27.42, 2.59, 7.6],
    typ('Chickpeas (garbanzo beans), mature seeds, cooked, boiled, without salt'), PLANT, 1, [], { can: 240, cup: 164 }),
  ing('black-beans-cooked', 'Black beans, cooked or canned (drained)', 'legume', 'cooked', [132, 8.86, 23.71, 0.54, 8.7],
    typ('Beans, black, mature seeds, cooked, boiled, without salt'), PLANT, 1, [], { can: 240, cup: 172 }),
  ing('edamame', 'Edamame, shelled (frozen, cooked)', 'legume', 'cooked', [121, 11.91, 8.91, 5.2, 5.2],
    typ('Edamame, frozen, prepared'), PLANT, 2, ['soy'], { cup: 155 }),
  ing('peas-green', 'Green peas (frozen)', 'legume', 'raw', [77, 5.22, 13.62, 0.4, 4.5],
    typ('Peas, green, frozen, unprepared'), PLANT, 1, [], { cup: 134 }),

  /* -------------------------------------------------------------- vegetables */
  ing('broccoli', 'Broccoli', 'vegetable', 'raw', [34, 2.82, 6.64, 0.37, 2.6],
    fdc('Broccoli, raw', 170379), PLANT, 1, [], { cup: 91 }),
  ing('spinach', 'Spinach', 'vegetable', 'raw', [23, 2.86, 3.63, 0.39, 2.2],
    fdc('Spinach, raw', 168462), PLANT, 2, [], { cup: 30 }),
  ing('tomato', 'Tomato', 'vegetable', 'raw', [18, 0.88, 3.89, 0.2, 1.2],
    fdc('Tomatoes, red, ripe, raw, year round average', 170457), PLANT, 1, [], { piece: 123 }),
  ing('tomatoes-canned', 'Chopped tomatoes (canned)', 'vegetable', 'as_sold', [18, 0.8, 3.5, 0.3, 1.0],
    typ('Tomatoes, red, ripe, canned, packed in tomato juice'), PLANT, 1, [], { can: 400 }),
  ing('cucumber', 'Cucumber', 'vegetable', 'raw', [15, 0.65, 3.63, 0.11, 0.5],
    typ('Cucumber, with peel, raw'), PLANT, 1, [], { piece: 300 }),
  ing('bell-pepper', 'Red bell pepper', 'vegetable', 'raw', [31, 0.99, 6.03, 0.3, 2.1],
    typ('Peppers, sweet, red, raw'), PLANT, 2, [], { piece: 119 }),
  ing('onion', 'Onion', 'vegetable', 'raw', [40, 1.1, 9.34, 0.1, 1.7],
    typ('Onions, raw'), PLANT, 1, [], { piece: 110 }),
  ing('carrot', 'Carrot', 'vegetable', 'raw', [41, 0.93, 9.58, 0.24, 2.8],
    fdc('Carrots, raw', 170393), PLANT, 1, [], { piece: 61 }),
  ing('garlic', 'Garlic', 'vegetable', 'raw', [149, 6.36, 33.06, 0.5, 2.1],
    typ('Garlic, raw'), PLANT, 1, [], { piece: 3 }),
  ing('lettuce', 'Lettuce, romaine', 'vegetable', 'raw', [17, 1.23, 3.29, 0.3, 2.1],
    typ('Lettuce, cos or romaine, raw'), PLANT, 1, [], { cup: 47 }),
  ing('zucchini', 'Courgette (zucchini)', 'vegetable', 'raw', [17, 1.21, 3.11, 0.32, 1.0],
    typ('Squash, summer, zucchini, includes skin, raw'), PLANT, 1, [], { piece: 196 }),
  ing('mushrooms', 'Mushrooms, white', 'vegetable', 'raw', [22, 3.09, 3.26, 0.34, 1.0],
    typ('Mushrooms, white, raw'), PLANT, 2, [], { cup: 70 }),
  ing('avocado', 'Avocado', 'vegetable', 'raw', [160, 2.0, 8.53, 14.66, 6.7],
    typ('Avocados, raw, all commercial varieties'), PLANT, 2, [], { piece: 140 }),

  /* ------------------------------------------------------------------- fruit */
  ing('banana', 'Banana', 'fruit', 'raw', [89, 1.09, 22.84, 0.33, 2.6],
    fdc('Bananas, raw', 173944), PLANT, 1, [], { piece: 118 }),
  ing('apple', 'Apple', 'fruit', 'raw', [52, 0.26, 13.81, 0.17, 2.4],
    fdc('Apples, raw, with skin', 171688), PLANT, 1, [], { piece: 182 }),
  ing('blueberries', 'Blueberries (fresh or frozen)', 'fruit', 'raw', [57, 0.74, 14.49, 0.33, 2.4],
    typ('Blueberries, raw'), PLANT, 2, [], { cup: 148 }),
  ing('strawberries', 'Strawberries (fresh or frozen)', 'fruit', 'raw', [32, 0.67, 7.68, 0.3, 2.0],
    typ('Strawberries, raw'), PLANT, 2, [], { cup: 152 }),
  ing('orange', 'Orange', 'fruit', 'raw', [47, 0.94, 11.75, 0.12, 2.4],
    typ('Oranges, raw, all commercial varieties'), PLANT, 1, [], { piece: 131 }),
  ing('lemon-juice', 'Lemon juice', 'fruit', 'raw', [22, 0.35, 6.9, 0.24, 0.3],
    typ('Lemon juice, raw'), PLANT, 1, [], { tbsp: 15 }),

  /* ------------------------------------------------------- fats, nuts, seeds */
  ing('olive-oil', 'Olive oil', 'fat', 'as_sold', [884, 0, 0, 100, 0],
    fdc('Oil, olive, salad or cooking', 171413), PLANT, 2, [], { tbsp: 13.5, tsp: 4.5 }),
  ing('rapeseed-oil', 'Rapeseed (canola) oil', 'fat', 'as_sold', [884, 0, 0, 100, 0],
    typ('Oil, canola'), PLANT, 1, [], { tbsp: 14, tsp: 4.7 }),
  ing('butter', 'Butter', 'fat', 'as_sold', [717, 0.85, 0.06, 81.11, 0],
    fdc('Butter, salted', 173430), DAIRY, 2, ['milk'], { tbsp: 14.2, tsp: 4.7 }),
  ing('peanut-butter', 'Peanut butter, smooth', 'nut_seed', 'as_sold', [588, 25.09, 19.56, 50.39, 6.0],
    typ('Peanut butter, smooth style, without salt'), PLANT, 1, ['peanuts'], { tbsp: 16 }),
  ing('almonds', 'Almonds', 'nut_seed', 'as_sold', [579, 21.15, 21.55, 49.93, 12.5],
    fdc('Nuts, almonds', 170567), PLANT, 3, ['tree_nuts'], { cup: 143, tbsp: 9 }),
  ing('walnuts', 'Walnuts', 'nut_seed', 'as_sold', [654, 15.23, 13.71, 65.21, 6.7],
    typ('Nuts, walnuts, english'), PLANT, 3, ['tree_nuts'], { cup: 100, tbsp: 7 }),
  ing('chia-seeds', 'Chia seeds', 'nut_seed', 'as_sold', [486, 16.54, 42.12, 30.74, 34.4],
    typ('Seeds, chia seeds, dried'), PLANT, 2, [], { tbsp: 12 }),
  ing('pumpkin-seeds', 'Pumpkin seeds', 'nut_seed', 'as_sold', [559, 30.23, 10.71, 49.05, 6.0],
    typ('Seeds, pumpkin and squash seed kernels, dried'), PLANT, 2, [], { tbsp: 9 }),
  ing('tahini', 'Tahini (sesame paste)', 'nut_seed', 'as_sold', [595, 17.0, 21.19, 53.76, 9.3],
    typ('Seeds, sesame butter, tahini, from roasted and toasted kernels'), PLANT, 2, ['sesame'], { tbsp: 15 }),
  ing('hummus', 'Hummus', 'legume', 'as_sold', [166, 7.9, 14.29, 9.6, 6.0],
    typ('Hummus, commercial'), PLANT, 2, ['sesame'], { tbsp: 15 }),

  /* -------------------------------------------------------------- condiments */
  ing('soy-sauce', 'Soy sauce', 'condiment', 'as_sold', [53, 8.14, 4.93, 0.57, 0.8],
    typ('Soy sauce made from soy and wheat (shoyu)'), PLANT_GLUTEN, 1, ['soy', 'wheat', 'gluten'], { tbsp: 16, tsp: 5.3 }),
  ing('honey', 'Honey', 'condiment', 'as_sold', [304, 0.3, 82.4, 0, 0.2],
    typ('Honey'), HONEY, 2, [], { tbsp: 21, tsp: 7 }),
  ing('mustard', 'Mustard, prepared', 'condiment', 'as_sold', [60, 3.74, 5.83, 3.34, 4.0],
    typ('Mustard, prepared, yellow'), PLANT, 1, ['mustard'], { tsp: 5, tbsp: 15 }),
  ing('vegetable-stock', 'Vegetable stock (prepared)', 'condiment', 'as_sold', [5, 0.2, 0.9, 0.1, 0],
    label('vegetable stock made from cube or concentrate; many contain celery'), PLANT, 1, ['celery'], { cup: 240 }),
  ing('spices', 'Herbs, spices, salt & pepper', 'condiment', 'as_sold', [0, 0, 0, 0, 0],
    'Treated as negligible energy at recipe quantities (a few grams)', PLANT, 1, [], { tsp: 2 }),

  /* ------------------------------------------- added Nov 2026 (recipe pack 2) */
  // protein foods
  ing('haddock-raw', 'Haddock fillet (raw)', 'protein', 'raw', [74, 16.32, 0, 0.45, 0],
    typ('Fish, haddock, raw'), FISH, 2, ['fish']),
  ing('smoked-salmon', 'Smoked salmon (cold-smoked)', 'protein', 'as_sold', [117, 18.28, 0, 4.32, 0],
    typ('Fish, salmon, chinook, smoked'), FISH, 3, ['fish']),
  ing('sardines-canned', 'Sardines in oil, drained', 'protein', 'as_sold', [208, 24.62, 0, 11.45, 0],
    typ('Fish, sardine, Atlantic, canned in oil, drained solids with bone'), FISH, 1, ['fish'], { can: 90 }),
  ing('lamb-mince-raw', 'Lamb mince (raw)', 'protein', 'raw', [282, 16.56, 0, 23.41, 0],
    typ('Lamb, ground, raw'), MEAT, 2),
  ing('turkey-mince-raw', 'Turkey mince (raw)', 'protein', 'raw', [148, 19.66, 0, 7.66, 0],
    typ('Turkey, ground, raw'), MEAT, 2),
  ing('pork-tenderloin-raw', 'Pork tenderloin (raw)', 'protein', 'raw', [120, 20.95, 0, 3.39, 0],
    typ('Pork, fresh, loin, tenderloin, separable lean only, raw'), MEAT, 2),
  // dairy
  ing('mozzarella-light', 'Mozzarella, reduced fat', 'dairy', 'as_sold', [254, 24.26, 2.77, 15.92, 0],
    typ('Cheese, mozzarella, part skim milk'), DAIRY, 2, ['milk'], { piece: 125 }),
  ing('parmesan', 'Parmesan-style hard cheese', 'dairy', 'as_sold', [392, 35.75, 3.22, 25.83, 0],
    typ('Cheese, parmesan, hard'), DAIRY, 3, ['milk'], { tbsp: 5 }),
  // grains & starches
  ing('tortilla-corn', 'Corn tortilla', 'grain', 'as_sold', [218, 5.7, 44.64, 2.85, 6.3],
    typ('Tortillas, ready-to-bake or -fry, corn'), PLANT, 2, [], { piece: 26 }),
  ing('rice-cakes', 'Rice cakes, plain', 'grain', 'as_sold', [387, 8.2, 81.5, 2.8, 4.2],
    typ('Snacks, rice cakes, brown rice, plain'), PLANT, 1, [], { piece: 9 }),
  ing('pita-wholewheat', 'Wholemeal pitta bread', 'grain', 'as_sold', [266, 9.8, 55.0, 2.6, 7.4],
    typ('Bread, pita, whole-wheat'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { piece: 64 }),
  ing('couscous-dry', 'Couscous (dry)', 'grain', 'dry', [376, 12.76, 77.43, 0.64, 5.0],
    typ('Couscous, dry'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { cup: 173 }),
  ing('rice-noodles-cooked', 'Rice noodles (cooked)', 'grain', 'cooked', [108, 1.79, 24.01, 0.2, 1.0],
    typ('Rice noodles, cooked'), PLANT, 1, [], { cup: 176 }),
  // legumes
  ing('kidney-beans-cooked', 'Red kidney beans, cooked or canned (drained)', 'legume', 'cooked', [127, 8.67, 22.8, 0.5, 6.4],
    typ('Beans, kidney, red, mature seeds, cooked, boiled, without salt'), PLANT, 1, [], { can: 240, cup: 177 }),
  ing('white-beans-cooked', 'White beans, cooked or canned (drained)', 'legume', 'cooked', [139, 9.73, 25.09, 0.35, 6.3],
    typ('Beans, white, mature seeds, cooked, boiled, without salt'), PLANT, 1, [], { can: 240, cup: 179 }),
  // vegetables
  ing('cabbage', 'Cabbage, white or green', 'vegetable', 'raw', [25, 1.28, 5.8, 0.1, 2.5],
    typ('Cabbage, raw'), PLANT, 1, [], { cup: 89 }),
  ing('green-beans', 'Green beans', 'vegetable', 'raw', [31, 1.83, 6.97, 0.22, 2.7],
    typ('Beans, snap, green, raw'), PLANT, 1, [], { cup: 100 }),
  ing('cauliflower', 'Cauliflower', 'vegetable', 'raw', [25, 1.92, 4.97, 0.28, 2.0],
    typ('Cauliflower, raw'), PLANT, 1, [], { cup: 107 }),
  ing('spring-onion', 'Spring onions (scallions)', 'vegetable', 'raw', [32, 1.83, 7.34, 0.19, 2.6],
    typ('Onions, spring or scallions (includes tops and bulb), raw'), PLANT, 1, [], { piece: 15 }),
  ing('ginger', 'Fresh ginger', 'vegetable', 'raw', [80, 1.82, 17.77, 0.75, 2.0],
    typ('Ginger root, raw'), PLANT, 1, [], { tsp: 2, tbsp: 6 }),
  // fruit
  ing('raspberries', 'Raspberries (fresh or frozen)', 'fruit', 'raw', [52, 1.2, 11.94, 0.65, 6.5],
    typ('Raspberries, raw'), PLANT, 2, [], { cup: 123 }),
  ing('raisins', 'Raisins', 'fruit', 'as_sold', [299, 3.07, 79.18, 0.46, 3.7],
    typ('Raisins, seedless'), PLANT, 1, [], { tbsp: 9, cup: 145 }),
  ing('lime-juice', 'Lime juice', 'fruit', 'raw', [25, 0.42, 8.42, 0.07, 0.4],
    typ('Lime juice, raw'), PLANT, 1, [], { tbsp: 15 }),
  // nuts, seeds, fats
  ing('cashews', 'Cashew nuts', 'nut_seed', 'as_sold', [553, 18.22, 30.19, 43.85, 3.3],
    typ('Nuts, cashew nuts, raw'), PLANT, 3, ['tree_nuts'], { cup: 137, tbsp: 9 }),
  ing('sunflower-seeds', 'Sunflower seeds', 'nut_seed', 'as_sold', [584, 20.78, 20.0, 51.46, 8.6],
    typ('Seeds, sunflower seed kernels, dried'), PLANT, 1, [], { tbsp: 9 }),
  ing('sesame-oil', 'Sesame oil', 'fat', 'as_sold', [884, 0, 0, 100, 0],
    typ('Oil, sesame, salad or cooking'), PLANT, 2, ['sesame'], { tbsp: 13.6, tsp: 4.5 }),
  // pantry
  ing('maple-syrup', 'Maple syrup', 'condiment', 'as_sold', [260, 0.04, 67.04, 0.06, 0],
    typ('Syrups, maple'), PLANT, 3, [], { tbsp: 20, tsp: 6.7 }),
  ing('cocoa-powder', 'Cocoa powder, unsweetened', 'condiment', 'as_sold', [228, 19.6, 57.9, 13.7, 37.0],
    typ('Cocoa, dry powder, unsweetened'), PLANT, 2, [], { tbsp: 5.4, tsp: 1.8 }),

  /* ------------------------------------------- added Nov 2026 (recipe pack 3) */
  // protein foods
  ing('beef-steak-raw', 'Beef sirloin steak, lean (raw)', 'protein', 'raw', [142, 22.03, 0, 5.4, 0],
    typ('Beef, top sirloin, steak, separable lean only, trimmed to 1/8" fat, choice, raw'), MEAT, 3),
  ing('pork-loin-raw', 'Pork loin chop, boneless, lean (raw)', 'protein', 'raw', [143, 21.43, 0, 5.66, 0],
    typ('Pork, fresh, loin, center loin (chops), boneless, separable lean only, raw'), MEAT, 2, [], { piece: 150 }),
  ing('ham-sliced', 'Ham, sliced, lean (deli)', 'protein', 'as_sold', [107, 16.85, 1.93, 3.73, 0],
    typ('Ham, sliced, pre-packaged, deli meat (96% fat free, water added)'), MEAT, 2, [], { slice: 15 }),
  ing('lamb-leg-raw', 'Lamb leg steak, lean (raw)', 'protein', 'raw', [134, 20.56, 0, 5.25, 0],
    typ('Lamb, leg, whole (shank and sirloin), separable lean only, trimmed to 1/4" fat, choice, raw'), MEAT, 3),
  ing('turkey-breast-raw', 'Turkey breast, skinless (raw)', 'protein', 'raw', [114, 23.66, 0.14, 1.48, 0],
    typ('Turkey, breast, meat only, raw'), MEAT, 2),
  ing('saithe-raw', 'Saithe / pollock fillet (raw)', 'protein', 'raw', [92, 19.44, 0, 0.98, 0],
    typ('Fish, pollock, Atlantic, raw'), FISH, 1, ['fish']),
  ing('mackerel-canned', 'Mackerel, canned, drained', 'protein', 'as_sold', [156, 23.19, 0, 6.3, 0],
    typ('Fish, mackerel, jack, canned, drained solids'), FISH, 1, ['fish'], { can: 125 }),
  ing('mussels-cooked', 'Mussels, cooked (shelled, frozen)', 'protein', 'cooked', [172, 23.8, 7.39, 4.48, 0],
    typ('Mollusks, mussel, blue, cooked, moist heat'), FISH, 2, ['shellfish']),
  ing('squid-raw', 'Squid rings (raw)', 'protein', 'raw', [92, 15.58, 3.08, 1.38, 0],
    typ('Mollusks, squid, mixed species, raw'), FISH, 2, ['shellfish']),
  ing('whey-protein', 'Whey protein powder, unflavoured', 'protein', 'as_sold', [400, 78.0, 8.0, 6.0, 0],
    label('whey protein concentrate powder, unflavoured (no USDA entry)'), DAIRY, 2, ['milk'], { tbsp: 8 }),
  ing('pea-protein', 'Plant protein powder (pea), unflavoured', 'protein', 'as_sold', [380, 80.0, 4.0, 6.5, 1.0],
    label('pea protein isolate powder, unflavoured (no USDA entry)'), PLANT, 2, [], { tbsp: 8 }),
  // dairy
  ing('ricotta', 'Ricotta, part-skim', 'dairy', 'as_sold', [138, 11.39, 5.14, 7.91, 0],
    typ('Cheese, ricotta, part skim milk'), DAIRY, 2, ['milk'], { tbsp: 15 }),
  // grains
  ing('bulgur-dry', 'Bulgur wheat (dry)', 'grain', 'dry', [342, 12.29, 75.87, 1.33, 12.5],
    typ('Bulgur, dry'), PLANT_GLUTEN, 1, ['wheat', 'gluten'], { cup: 140 }),
  ing('egg-noodles-dry', 'Egg noodles (dry)', 'grain', 'dry', [384, 14.16, 71.27, 4.44, 3.3],
    typ('Noodles, egg, dry, enriched'), { ...PLANT_GLUTEN, vegan: false }, 1, ['wheat', 'gluten', 'egg']),
  // vegetables
  ing('sweetcorn-canned', 'Sweetcorn, canned (drained)', 'vegetable', 'as_sold', [67, 2.29, 13.86, 1.22, 1.7],
    typ('Corn, sweet, yellow, canned, whole kernel, drained solids'), PLANT, 1, [], { can: 200, cup: 165 }),
  ing('rocket', 'Rocket (arugula)', 'vegetable', 'raw', [25, 2.58, 3.65, 0.66, 1.6],
    typ('Arugula, raw'), PLANT, 2, [], { cup: 20 }),
  ing('aubergine', 'Aubergine (eggplant)', 'vegetable', 'raw', [25, 0.98, 5.88, 0.18, 3.0],
    typ('Eggplant, raw'), PLANT, 1, [], { piece: 450 }),
  ing('leek', 'Leek', 'vegetable', 'raw', [61, 1.5, 14.15, 0.3, 1.8],
    typ('Leeks, (bulb and lower leaf-portion), raw'), PLANT, 1, [], { piece: 90 }),
  ing('kale', 'Kale', 'vegetable', 'raw', [35, 2.92, 4.42, 1.49, 4.1],
    typ('Kale, raw'), PLANT, 2, [], { cup: 21 }),
  // fruit
  ing('mango', 'Mango (fresh or frozen)', 'fruit', 'raw', [60, 0.82, 14.98, 0.38, 1.6],
    typ('Mangos, raw'), PLANT, 2, [], { cup: 165 }),
  // pantry
  ing('passata', 'Tomato passata', 'condiment', 'as_sold', [38, 1.65, 8.98, 0.21, 1.9],
    typ('Tomato products, canned, puree, without salt added'), PLANT, 1, [], { cup: 250 }),
  ing('coconut-milk-light', 'Coconut milk, light (canned)', 'condiment', 'as_sold', [73, 0.7, 2.6, 6.8, 0],
    label('light coconut milk, canned (about 7% fat)'), PLANT, 2, [], { can: 400, cup: 240 }),
];

/**
 * Protein group of each protein food (for "proteins I like / not for me"). Milk and butter are deliberately not tagged:
 * the dairy group means the protein-rich dairy foods (skyr, yogurt, cottage cheese, cheese); avoiding all milk is the
 * dairy-free diet or the milk allergy. Peas and nuts are not tagged either.
 */
export const PROTEIN_GROUP_OF: Partial<Record<ID, ProteinGroup>> = {
  'chicken-breast-raw': 'chicken',
  'chicken-breast-cooked': 'chicken',
  'chicken-thigh-raw': 'chicken',
  'turkey-mince-raw': 'turkey',
  'turkey-breast-raw': 'turkey',
  'beef-mince-10-raw': 'beef',
  'beef-steak-raw': 'beef',
  'pork-tenderloin-raw': 'pork',
  'pork-loin-raw': 'pork',
  'ham-sliced': 'pork',
  'lamb-mince-raw': 'lamb',
  'lamb-leg-raw': 'lamb',
  'cod-raw': 'white_fish',
  'haddock-raw': 'white_fish',
  'saithe-raw': 'white_fish',
  'salmon-raw': 'oily_fish',
  'smoked-salmon': 'oily_fish',
  'sardines-canned': 'oily_fish',
  'mackerel-canned': 'oily_fish',
  'tuna-canned': 'tuna',
  'shrimp-cooked': 'prawns',
  'mussels-cooked': 'shellfish',
  'squid-raw': 'shellfish',
  egg: 'eggs',
  'egg-white': 'eggs',
  'skyr-plain': 'dairy',
  'greek-yogurt-0': 'dairy',
  'cottage-cheese': 'dairy',
  gouda: 'dairy',
  feta: 'dairy',
  'mozzarella-light': 'dairy',
  parmesan: 'dairy',
  ricotta: 'dairy',
  'tofu-firm': 'tofu_tempeh',
  tempeh: 'tofu_tempeh',
  'lentils-dry': 'beans_lentils',
  'lentils-cooked': 'beans_lentils',
  'black-beans-cooked': 'beans_lentils',
  'kidney-beans-cooked': 'beans_lentils',
  'white-beans-cooked': 'beans_lentils',
  edamame: 'beans_lentils',
  'chickpeas-cooked': 'chickpeas',
  hummus: 'chickpeas',
  'whey-protein': 'whey',
  'pea-protein': 'plant_protein',
};

export const INGREDIENTS: Ingredient[] = INGREDIENT_LIST.map((i) => (PROTEIN_GROUP_OF[i.id] ? { ...i, proteinGroup: PROTEIN_GROUP_OF[i.id] } : i));

/** Singular/plural nouns for ingredients measured in pieces, used for friendly quantities. */
export const PIECE_LABELS: Partial<Record<ID, [string, string]>> = {
  egg: ['egg', 'eggs'],
  'egg-white': ['egg white', 'egg whites'],
  banana: ['banana', 'bananas'],
  apple: ['apple', 'apples'],
  orange: ['orange', 'oranges'],
  tomato: ['tomato', 'tomatoes'],
  'bell-pepper': ['pepper', 'peppers'],
  onion: ['onion', 'onions'],
  carrot: ['carrot', 'carrots'],
  garlic: ['clove', 'cloves'],
  avocado: ['avocado', 'avocados'],
  cucumber: ['cucumber', 'cucumbers'],
  zucchini: ['courgette', 'courgettes'],
  'potato-raw': ['potato', 'potatoes'],
  'sweet-potato-raw': ['sweet potato', 'sweet potatoes'],
  'tortilla-wheat': ['tortilla', 'tortillas'],
  'rye-crispbread': ['crispbread', 'crispbreads'],
  'tortilla-corn': ['corn tortilla', 'corn tortillas'],
  'rice-cakes': ['rice cake', 'rice cakes'],
  'pita-wholewheat': ['pitta', 'pittas'],
  'spring-onion': ['spring onion', 'spring onions'],
  'mozzarella-light': ['ball', 'balls'],
  'pork-loin-raw': ['chop', 'chops'],
  aubergine: ['aubergine', 'aubergines'],
  leek: ['leek', 'leeks'],
};

/**
 * Cooked/prepared items and the form you'd buy. Grams of purchase form ≈ grams × (prepared kcal ÷ purchase kcal),
 * because water is gained (grains, legumes) or lost (roast meat) while energy stays roughly constant.
 */
export const PURCHASE_FORM: Partial<Record<ID, ID>> = {
  'rice-white-cooked': 'rice-white-dry',
  'quinoa-cooked': 'quinoa-dry',
  'pasta-cooked': 'pasta-dry',
  'lentils-cooked': 'lentils-dry',
  'chicken-breast-cooked': 'chicken-breast-raw',
};

export const INGREDIENT_CATEGORY_LABELS: Record<Ingredient['category'], string> = {
  protein: 'Meat, fish, eggs & tofu',
  dairy: 'Dairy & alternatives',
  grain: 'Grains, bread & potatoes',
  legume: 'Beans & lentils',
  vegetable: 'Vegetables',
  fruit: 'Fruit',
  fat: 'Oils & fats',
  nut_seed: 'Nuts & seeds',
  condiment: 'Pantry & seasoning',
  other: 'Other',
};

export const INGREDIENTS_BY_ID: Map<ID, Ingredient> = new Map(INGREDIENTS.map((i) => [i.id, i]));
