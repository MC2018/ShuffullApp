// The December recap (ShuffullApp#116): when its button shows, and the wording the recap screen needs. Pure, so the
// tests can run it with a faked clock.
import type { Recap, RecapSong } from "../services/api/models";

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"] as const;
export const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"] as const;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Whether it's recap season: 1 to 31 December, local time (user decision, 2026-10-23). Outside it the button is
 * gone; there's no year-round entry (also the user's call). Development builds can still open the screen from
 * Settings.
 */
export function isRecapSeason(now: Date = new Date()): boolean {
    return now.getMonth() === 11;
}

/** The year the recap covers: the local year it's opened in, so December's button opens that year's recap. */
export function recapYear(now: Date = new Date()): number {
    return now.getFullYear();
}

/** The home screen's recap button: December only, and only once the year has at least one listen. */
export function recapButtonVisible(now: Date, plays: number | null | undefined): boolean {
    return isRecapSeason(now) && (plays ?? 0) > 0;
}

/**
 * The zone to compute the recap in: the device's IANA zone, or its current offset ("+02:00") where the runtime
 * doesn't report one. The offset is a fallback only: it can't follow a DST change within the year.
 */
export function deviceTimeZone(now: Date = new Date()): string {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (zone) {
            return zone;
        }
    } catch {
        // No Intl time zone support: fall through to the offset.
    }
    return offsetTimeZone(now.getTimezoneOffset());
}

/** A Date#getTimezoneOffset value (minutes BEHIND UTC, so New York in winter is 300) as "+hh:mm" / "-hh:mm". */
export function offsetTimeZone(minutesBehindUtc: number): string {
    const ahead = -minutesBehindUtc;
    const abs = Math.abs(ahead);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${ahead < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "30 October", in the device's local calendar. */
export function formatDayMonth(date: Date): string {
    return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** "30 October 2026", in the device's local calendar. */
export function formatDay(date: Date): string {
    return `${formatDayMonth(date)} ${date.getFullYear()}`;
}

/** A local day the API sends as "YYYY-MM-DD" (a streak's ends), as "2 November". */
export function formatLocalDay(isoDay: string): string {
    const [, month, day] = isoDay.split("-").map(Number);
    return `${day} ${MONTH_NAMES[month - 1]}`;
}

/**
 * The line that says when stats started, so a first, partial year doesn't read as "you barely listened". Shown only
 * when the caller's first listen falls inside this recap's year; null for a full year, and for an API too old to send
 * firstListen.
 */
export function statsStartedLine(recap: Pick<Recap, "firstListen" | "from" | "to">): string | null {
    const first = recap.firstListen;
    if (!first || first.getTime() < recap.from.getTime() || first.getTime() >= recap.to.getTime()) {
        return null;
    }
    return `Your stats started on ${formatDay(first)}, with your first recorded listen. Nothing before that was counted.`;
}

/** Minutes as "45 min", "2 h 5 min" or "1,234 h". Rounded: the recap is a summary, not an invoice. */
export function formatMinutes(minutes: number): string {
    const total = Math.round(minutes);
    if (total < 60) {
        return `${total} min`;
    }
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours >= 100 || rest === 0) {
        return `${hours.toLocaleString("en-US")} h`;
    }
    return `${hours} h ${rest} min`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** A song's title, or a placeholder for one the server no longer has. */
export function songTitle(song: RecapSong): string {
    return song.name ?? "A song that's since been removed";
}

export function songArtists(song: RecapSong): string {
    return song.artists.length > 0 ? song.artists.join(", ") : "Unknown artist";
}

/** "winter" -> "Winter". */
export function seasonLabel(season: string): string {
    return season.charAt(0).toUpperCase() + season.slice(1);
}

/** The local hour as "9 am" / "11 pm". */
export function formatHour(hour: number): string {
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h} ${hour < 12 ? "am" : "pm"}`;
}

/** The busiest day-and-hour cell of the heatmap, or null when the year is empty. */
export function busiestHour(heatmap: number[][]): { day: number; hour: number; minutes: number } | null {
    let best: { day: number; hour: number; minutes: number } | null = null;
    heatmap.forEach((hours, day) => hours.forEach((minutes, hour) => {
        if (minutes > 0 && (best == null || minutes > best.minutes)) {
            best = { day, hour, minutes };
        }
    }));
    return best;
}

/** Each value as a share of the largest, 0 to 1, for drawing bars and heat cells. All zeroes stay zero. */
export function scaleToMax(values: number[]): number[] {
    const max = Math.max(0, ...values);
    return values.map(v => (max > 0 ? v / max : 0));
}

// The recap is kept per user and year, so it can still be shown offline.
export const RECAP_CACHE_PREFIX = "RECAP:";
export function recapCacheKey(userId: string, year: number): string {
    return `${RECAP_CACHE_PREFIX}${userId}:${year}`;
}

/** How long a saved recap counts as fresh for the home button, so the home screen doesn't ask on every visit. */
export const RECAP_BUTTON_REFRESH_MS = 6 * 60 * 60 * 1000;
