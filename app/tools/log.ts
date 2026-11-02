/**
 * The app's one way to write a log line: `log.warn("sync", "Holding 2 request(s)", e)` prints
 * `[sync] Holding 2 request(s)` followed by `e`, through `console.warn`.
 *
 * The tag is the area the line comes from (`API`, `sync`, `player`, `downloader`, ...). It is what you grep the
 * device log for, so keep an area's tag stable once it exists.
 *
 * Pick the level by what the reader should do about the line:
 * - `error`: something failed and nothing will retry it, or user data may be lost.
 * - `warn`: something failed but the app recovers or retries on its own.
 * - `info`: a normal event worth seeing in the log (a sync step, a song starting, an endpoint called).
 * - `debug`: detail only useful while working on that area.
 *
 * Every level reaches the device log: on Android React Native writes all of them to logcat under the `ReactNativeJS`
 * tag (debug at D, info at I, warn at W, error at E), and `adb logcat -s ReactNativeJS:*` reads every priority of
 * it. On desktop, Electron's main process forwards every renderer console level to the terminal.
 *
 * Each call looks the console method up when it runs, so a test's `vi.spyOn(console, "warn")` still sees it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The first argument every log line is written with. */
export function formatLogLine(tag: string, message: string): string {
    return `[${tag}] ${message}`;
}

function write(level: LogLevel, tag: string, message: string, details: unknown[]): void {
    console[level](formatLogLine(tag, message), ...details);
}

export const log = {
    debug: (tag: string, message: string, ...details: unknown[]) => write("debug", tag, message, details),
    info: (tag: string, message: string, ...details: unknown[]) => write("info", tag, message, details),
    warn: (tag: string, message: string, ...details: unknown[]) => write("warn", tag, message, details),
    error: (tag: string, message: string, ...details: unknown[]) => write("error", tag, message, details),
};
