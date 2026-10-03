// Pure formatting for the installed-build label. No React Native imports so it can be unit-tested (see
// tests/appVersion.test.ts).

export interface InstalledBuild {
    /** Launcher label: "Shuffull" (daily driver) or "Shuffull Dev" (dev client). */
    appName: string | null;
    /** Android versionName, e.g. "1.0.0+abc1234" — the commit the build came from (see android/app/build.gradle). */
    version: string | null;
    /** Android versionCode: the commit count, so a later build is always a higher number. */
    build: string | null;
}

/**
 * "Shuffull Dev · 1.0.0+abc1234 (412)" — enough to tell which app and which commit the phone is running.
 * Null when there is no native version to show (web and desktop builds).
 */
export function formatInstalledBuild({ appName, version, build }: InstalledBuild): string | null {
    if (!version) {
        return null;
    }
    const versionAndBuild = build ? `${version} (${build})` : version;
    return appName ? `${appName} · ${versionAndBuild}` : versionAndBuild;
}
