/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Feature flags (src/config/featureFlags.ts): "true"/"1"/"yes"/"on" switches the area on. Default off. */
  readonly VITE_ENABLE_COACH_MARKETPLACE?: string;
  readonly VITE_ENABLE_SOCIAL_FEED?: string;
}
