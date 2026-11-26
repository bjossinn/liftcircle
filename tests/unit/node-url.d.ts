/** Minimal typing for the one Node helper the unit tests use (the app tsconfig doesn't load @types/node). */
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
