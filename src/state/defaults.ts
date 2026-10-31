import type { AccountState, NutritionTargets, PrivateProfile, Settings } from '@/domain/types';
import { deviceTimeZone } from '@/lib/dates';
import { ACCOUNT_ROW_ID } from '@/db/db';

export const DEFAULT_SHARE_FIELDS = { duration: true, exerciseNames: true, weightsReps: false, volume: false, records: true };

export function defaultSettings(): Settings {
  return {
    units: { weight: 'kg', length: 'cm', distance: 'km' },
    weekStart: 1,
    timeZone: deviceTimeZone(),
    language: 'en',
    rest: { defaultSec: 120, autoStart: true, sound: true, vibrate: true, keepAwake: true },
    workout: { showRir: false, defaultSets: 3, plateIncrementKg: 2.5, plateIncrementLb: 5 },
    notifications: { friendRequests: true, likes: true, comments: true, coaching: true },
    social: {
      discoverable: true,
      autoShare: { enabled: false, audience: 'friends', fields: { ...DEFAULT_SHARE_FIELDS } },
      defaultAudience: 'friends',
    },
    nutritionEnabled: false,
    demoData: false,
  };
}

export function defaultProfile(): PrivateProfile {
  return {
    displayName: '',
    limitations: [],
    diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
  };
}

export function defaultNutrition(): NutritionTargets {
  return { mode: 'none', proteinPerKg: 1.8, mealsPerDay: 3, updatedAt: Date.now() };
}

export function defaultAccountState(): AccountState {
  const now = Date.now();
  return {
    id: ACCOUNT_ROW_ID,
    createdAt: now,
    updatedAt: now,
    settings: defaultSettings(),
    profile: defaultProfile(),
    nutrition: defaultNutrition(),
    favorites: { exercises: [], recipes: [] },
  };
}
