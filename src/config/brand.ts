/**
 * Branding lives here so the product name and colours are easy to change.
 * vite.config.ts reads this file to build the web manifest.
 */
export const BRAND = {
  name: 'LiftCircle',
  shortName: 'LiftCircle',
  description: 'Workout tracker, training programs, nutrition targets and a friends feed.',
  themeColor: '#101215',
  backgroundColor: '#101215',
  accent: '#4fbf7f',
} as const;
