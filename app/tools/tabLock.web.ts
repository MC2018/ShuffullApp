/**
 * Web/desktop build of `tabLock.ts`. Metro picks this over `tabLock.ts` for the web platform.
 *
 * Tabs of the web app share one device id, so only one may play as it: `onAcquired` runs once this tab holds the Web
 * Lock `name`, which it keeps until the returned release. The lock passes to another tab when this one closes. A
 * browser without Web Locks makes every tab the device, as before this lock existed.
 */
export function acquireTabLock(name: string, onAcquired: () => void): () => void {
    if (typeof navigator === "undefined" || !("locks" in navigator)) {
        onAcquired();
        return () => undefined;
    }

    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController();
    navigator.locks.request(name, { signal: abort.signal }, async () => {
        onAcquired();
        await held;
    }).catch(() => undefined);
    return () => {
        abort.abort();
        release();
    };
}
