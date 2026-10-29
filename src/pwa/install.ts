/** Captures the install prompt early (it fires at load, before the Install screen is opened). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
export function initInstallCapture() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}
export const getInstallPrompt = () => deferred;
export const clearInstallPrompt = () => {
  deferred = null;
};
export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function isStandalone(): boolean {
  return (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
