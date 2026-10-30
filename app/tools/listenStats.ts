import type { MaybeDropRule } from "@/app/services/api/models";
import type { ListenStat } from "@/app/services/db/models";

// The pure parts of showing listen stats (ShuffullApp#115): when the sync asks the server for fresh ones, and how the
// screens put them into words. The numbers and the "maybe drop" flag are the server's (GET /api/v1/listens/stats);
// nothing here works them out again.

/** How often the stats are refreshed even with no new listens from this device: other devices play songs too. */
export const LISTEN_STATS_REFRESH_MS = 15 * 60_000;
/** The shortest gap between refreshes when this device just sent listens, so skipping through songs can't hammer it. */
export const LISTEN_STATS_MIN_GAP_MS = 60_000;

/** The last time the sync asked for the stats, and whether the server answered with them. */
export interface ListenStatsAttempt {
    at: number;
    ok: boolean;
}

/**
 * Whether this sync should fetch the stats. Always on the first sync of a run, then every LISTEN_STATS_REFRESH_MS.
 * Sooner (but not within LISTEN_STATS_MIN_GAP_MS) when this sync just recorded listens, since the numbers have
 * moved, but only if the last try worked: a server without the endpoint (404 before Shuffull#61 is deployed) is
 * asked once per interval, not after every song.
 */
export function listenStatsDue(last: ListenStatsAttempt | null, now: number, listensSent: boolean): boolean {
    if (last == null) {
        return true;
    }

    const since = now - last.at;
    if (since >= LISTEN_STATS_REFRESH_MS || since < 0) {
        return true;
    }
    return listensSent && last.ok && since >= LISTEN_STATS_MIN_GAP_MS;
}

/** A duration as m:ss, or h:mm:ss from an hour up. */
export function formatListenTime(totalSeconds: number): string {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** How long ago `then` was, in the largest whole unit: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function describeAgo(then: Date, now: Date): string {
    const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    const days = Math.floor(hours / 24);
    return days == 1 ? "1 day ago" : `${days} days ago`;
}

/** The rule in words, e.g. "Skipped in under 30 s on at least 3 of the last 5 plays." */
export function describeMaybeDropRule(rule: MaybeDropRule): string {
    return `Skipped in under ${rule.skippedUnderSeconds} s on at least ${rule.quickSkips} of the last ${rule.ofLastPlays} plays.`;
}

/** Why one song is flagged, from the server's own count, e.g. "4 of your last 5 plays skipped in under 30 s". */
export function describeQuickSkips(stat: Pick<ListenStat, "plays" | "recentQuickSkips">, rule: MaybeDropRule): string {
    const lookedAt = Math.min(stat.plays, rule.ofLastPlays);
    return `${stat.recentQuickSkips} of your last ${lookedAt} plays skipped in under ${rule.skippedUnderSeconds} s`;
}

/** The Library row's subtitle: null until the stats have synced once. */
export function describeMaybeDropRow(count: number | null): string {
    if (count == null) {
        return "Songs you keep skipping early";
    }
    if (count == 0) {
        return "No songs flagged";
    }
    return `${count} song${count == 1 ? "" : "s"} you keep skipping early`;
}

/** The rows of the song screen's "Your listening" section. */
export function listenStatFacts(stat: ListenStat, now: Date): { label: string; value: string }[] {
    return [
        { label: "Plays", value: String(stat.plays) },
        { label: "Skips", value: String(stat.skips) },
        { label: "Average listened", value: formatListenTime(stat.averageSecondsListened) },
        { label: "Completion", value: stat.completionPercent == null ? "—" : `${Math.round(stat.completionPercent)}%` },
        { label: "Last played", value: describeAgo(stat.lastPlayed, now) },
    ];
}
