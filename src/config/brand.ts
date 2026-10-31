/**
 * Branding lives here so the product name and colours are easy to change. Source of truth: brand/hard-earned/
 * (Hard_Earned_Brand_Guide.txt, hard-earned-tokens.css). vite.config.ts reads this file to build the web manifest.
 */
export const BRAND = {
  name: 'Hard Earned',
  shortName: 'Hard Earned',
  /** The wordmark is set in capitals (Barlow Semi Condensed 700, the .wordmark class). */
  wordmark: 'HARD EARNED',
  /** Primary line: brand moments only (welcome, install page, About). */
  tagline: 'Your work, made visible.',
  description: 'Track workouts and weight. Build a record of the work you put in.',
  /** Dark (flagship) canvas: PWA theme and background colour. */
  themeColor: '#17191B',
  backgroundColor: '#17191B',
  /** Vivid ember. */
  accent: '#FF694F',
} as const;
