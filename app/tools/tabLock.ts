/**
 * Calls `onAcquired` once this copy of the app may play as the device, and returns the release. A native app is the
 * only copy on its device, so it is the device at once. `tabLock.web.ts` is the web (browser and desktop) build, where
 * several tabs share one device id.
 */
export function acquireTabLock(_name: string, onAcquired: () => void): () => void {
    onAcquired();
    return () => undefined;
}
