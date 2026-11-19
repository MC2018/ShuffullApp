import type { ListenContext, ListenEndReason } from "@/app/services/db/schema";
import { formatListenTime } from "./listenStats";

// The pure parts of Recently played: which closed listens make the list, and how the screen puts them into words.
// The rows themselves are written by closeListen (db/queries/playHistory.ts).

/** Rows kept per user. Older ones are dropped as new ones arrive: this is "what did I just hear", not the recap. */
export const PLAY_HISTORY_LIMIT = 500;

/**
 * The fewest seconds of playback that make a listen worth listing. Below it nothing was heard: a song skipped the
 * instant it started, or one that failed to load. A song that played out is always listed.
 */
export const PLAY_HISTORY_MIN_SECONDS = 1;

export function belongsInPlayHistory(listen: { secondsListened: number; endReason: ListenEndReason }): boolean {
    return listen.endReason === "finished" || listen.secondsListened >= PLAY_HISTORY_MIN_SECONDS;
}

/** How the listen ended, e.g. "Skipped at 0:42". Null for one that played out: that is the normal case, so it says nothing. */
export function describePlayEnd(endReason: ListenEndReason, secondsListened: number): string | null {
    const at = formatListenTime(secondsListened);
    switch (endReason) {
        case "finished":
            return null;
        case "skipped":
            return `Skipped at ${at}`;
        case "previous":
            return `Went back at ${at}`;
        case "stopped":
            return `Stopped at ${at}`;
    }
}

/** Where the song was played from, or null when that says nothing useful. `playlistName` is null for a deleted playlist. */
export function describePlaySource(context: ListenContext, playlistName: string | null): string | null {
    switch (context) {
        case "audition":
            return playlistName != null ? `Audition · ${playlistName}` : "Audition";
        case "genreJam":
            return "Genre Jam";
        case "playlist":
            return playlistName;
        case "other":
            return null;
    }
}

/** A row's subtitle: artists, then how it ended, then where from. Empty parts are left out. */
export function describePlayRow(artists: string[], endReason: ListenEndReason, secondsListened: number, context: ListenContext, playlistName: string | null): string {
    return [
        artists.length > 0 ? artists.join(", ") : "Unknown Artist",
        describePlayEnd(endReason, secondsListened),
        describePlaySource(context, playlistName),
    ].filter((x): x is string => x != null && x.length > 0).join(" · ");
}

/** The time of day on the device's clock, e.g. "3:07 PM". */
export function formatPlayTime(date: Date): string {
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${h12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `then` to `now` on the device's clock: 0 today, 1 yesterday. Safe across DST changes. */
function daysBetween(then: Date, now: Date): number {
    return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/** A day's heading: "Today", "Yesterday", the weekday within the last week, else "Nov 12" (with the year if not this one). */
export function describePlayDay(date: Date, now: Date): string {
    const days = daysBetween(date, now);
    if (days <= 0) {
        return "Today";
    }
    if (days === 1) {
        return "Yesterday";
    }
    if (days < 7) {
        return WEEKDAYS[date.getDay()];
    }
    const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
    return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

export interface PlayDaySection<T> {
    title: string;
    data: T[];
}

/** Splits rows already sorted newest first into one section per calendar day, keeping their order. */
export function groupPlaysByDay<T>(plays: T[], startedAt: (play: T) => Date, now: Date): PlayDaySection<T>[] {
    const sections: PlayDaySection<T>[] = [];
    let lastDay: number | undefined;
    for (const play of plays) {
        const date = startedAt(play);
        const day = startOfDay(date);
        if (day !== lastDay) {
            sections.push({ title: describePlayDay(date, now), data: [] });
            lastDay = day;
        }
        sections[sections.length - 1].data.push(play);
    }
    return sections;
}
