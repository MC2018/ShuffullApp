// Pure logic behind auto-downloads (ShuffullApp#225, epic shuffull-workspace#150). No React Native imports, so it can
// be unit-tested (tests/autoDownloads.test.ts). The runner (services/downloader/autoDownloader.ts) reads the database,
// calls these, and writes back what they decide.
//
// The shape is the house's derived reconciler: the rules say which songs this device WANTS offline, the database says
// which it HAS (downloaded or queued), and the difference is the work. Nothing remembers "what I did last time", so a
// failed run just finds the same difference on the next one.
//
// The one piece of state is the pending-difference table, and it exists only to give the delay: a difference has to
// hold for AUTO_DOWNLOAD_DELAY_MS before anything happens. A like, dislike, Keep or playlist delete that is undone
// inside that window leaves no trace, because the difference vanishes and its pending row is dropped with it.

/** The ladder. Each step includes the ones before it. Off (the default) wants nothing, so an install changes nothing until opted in. */
export type AutoDownloadTier = "off" | "loved" | "liked" | "library" | "all";
export const AUTO_DOWNLOAD_TIERS: readonly AutoDownloadTier[] = ["off", "loved", "liked", "library", "all"];

/** Where a download or queue row came from. A hand-picked (`manual`) one is never removed by the rules. */
export type DownloadSource = "manual" | "auto";

export interface AutoDownloadSettings {
    tier: AutoDownloadTier;
    /** How many of the latest weeks of audition mixes to keep, 0-10. */
    mixWeeks: number;
    /** Keep only the mix songs not played yet, plus any kept or liked. */
    mixUnheardOnly: boolean;
    /** Keep the big Subscriptions audition playlist. */
    subscriptions: boolean;
    /** Playlists the user picked to keep offline, whatever the tier. */
    playlistIds: string[];
    /** Auto downloads don't start when they'd leave less free space than this. Hand-picked ones ignore it. */
    freeFloorBytes: number;
}

export const MAX_MIX_WEEKS = 10;
export const DEFAULT_FREE_FLOOR_BYTES = 5 * 1024 ** 3;

export const DEFAULT_AUTO_DOWNLOAD_SETTINGS: AutoDownloadSettings = {
    tier: "off",
    mixWeeks: 0,
    mixUnheardOnly: false,
    subscriptions: false,
    playlistIds: [],
    freeFloorBytes: DEFAULT_FREE_FLOOR_BYTES,
};

/** How long a difference must hold before a download is queued or removed: the window to undo a mis-tap. */
export const AUTO_DOWNLOAD_DELAY_MS = 10 * 60 * 1000;
/** How often the runner reconciles while the app runs (it also runs after every sync). */
export const AUTO_DOWNLOAD_INTERVAL_MS = 5 * 60 * 1000;

/** Whether the settings want anything at all. When not, the runner still removes earlier auto downloads (after the delay). */
export function wantsAnything(settings: AutoDownloadSettings): boolean {
    return settings.tier !== "off" || settings.mixWeeks > 0 || settings.subscriptions || settings.playlistIds.length > 0;
}

/** Fills any missing or out-of-range field with its default, so a row written by another build can't break a run. */
export function normalizeSettings(raw: Partial<AutoDownloadSettings> | undefined): AutoDownloadSettings {
    const tier = AUTO_DOWNLOAD_TIERS.includes(raw?.tier as AutoDownloadTier) ? raw!.tier! : DEFAULT_AUTO_DOWNLOAD_SETTINGS.tier;
    const mixWeeks = Number.isFinite(raw?.mixWeeks) ? Math.max(0, Math.min(MAX_MIX_WEEKS, Math.floor(raw!.mixWeeks!))) : 0;
    const freeFloorBytes = Number.isFinite(raw?.freeFloorBytes) && raw!.freeFloorBytes! >= 0 ? raw!.freeFloorBytes! : DEFAULT_FREE_FLOOR_BYTES;
    return {
        tier,
        mixWeeks,
        mixUnheardOnly: raw?.mixUnheardOnly === true,
        subscriptions: raw?.subscriptions === true,
        playlistIds: Array.isArray(raw?.playlistIds) ? raw!.playlistIds!.filter((x): x is string => typeof x === "string") : [],
        freeFloorBytes,
    };
}

// ── The wanted set ───────────────────────────────────────────────────────────────────────────────────────────────

// LikeStatus values (app/services/db/types.ts), repeated here so this file stays free of app imports.
const LIKE = 1;
const LOVE = 2;
const DISLIKE = 3;

/** A song on this device, as the active user sees it. */
export interface CandidateSong {
    songId: string;
    exploratory: boolean;
    /** Null when the user has no user_songs row for it. */
    likeStatus: number | null;
    /** Epoch ms, or null with no user_songs row. */
    lastPlayedMs: number | null;
    /** Hidden by one of the user's duplicate reports: the user asked not to hear this copy. */
    hidden: boolean;
}

export interface CandidatePlaylist {
    playlistId: string;
    name: string;
    isExploratory: boolean;
    songIds: string[];
}

/** The name of the funnel's big audition playlist of subscription uploads. */
export const SUBSCRIPTIONS_PLAYLIST_NAME = "Subscriptions";

// "Discover Mix · Nov 23" / "New Release Mix · Nov 23": the funnel's weekly cohort playlists (YtmMixes.CohortPlaylistName,
// "{base} · {MMM d}", the UTC Monday of the week, no year).
const MIX_NAME = /^(.+) · ([A-Z][a-z]{2}) (\d{1,2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// A mix is named for the Monday that starts its week, so its date is never far ahead of now. A date further ahead
// than this belongs to last year.
const MIX_FUTURE_SLACK_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * The week a mix playlist belongs to, as the epoch ms of its (UTC) date, or undefined when the name isn't a mix's.
 * The name has no year, so the year is the one that puts the date at or before now (plus a little slack).
 */
export function mixWeekOf(name: string, nowMs: number): number | undefined {
    const match = MIX_NAME.exec(name);
    if (!match) {
        return undefined;
    }
    const month = MONTHS.indexOf(match[2]);
    const day = Number(match[3]);
    if (month < 0 || day < 1 || day > 31) {
        return undefined;
    }
    const year = new Date(nowMs).getUTCFullYear();
    for (const y of [year + 1, year, year - 1]) {
        const date = Date.UTC(y, month, day);
        if (date <= nowMs + MIX_FUTURE_SLACK_MS) {
            return date;
        }
    }
    return undefined;
}

/** The epoch ms before which a lastPlayed means "never played" (the app stores never-played as the epoch). */
const UNHEARD_BEFORE_MS = Date.UTC(1971, 0, 1);

export function isUnheard(song: CandidateSong): boolean {
    return song.lastPlayedMs == null || song.lastPlayedMs < UNHEARD_BEFORE_MS;
}

function matchesTier(song: CandidateSong, tier: AutoDownloadTier): boolean {
    const liked = song.likeStatus === LIKE || song.likeStatus === LOVE;
    switch (tier) {
        case "off":
            return false;
        case "loved":
            return song.likeStatus === LOVE;
        case "liked":
            return liked;
        case "library":
            return !song.exploratory || liked;
        case "all":
            return true;
    }
}

// Better songs queue first, so a floor reached halfway through still leaves the ones that matter most offline.
function rankOf(song: CandidateSong): number {
    if (song.likeStatus === LOVE) {
        return 0;
    }
    if (song.likeStatus === LIKE) {
        return 1;
    }
    if (!song.exploratory) {
        return 2;
    }
    return 3;
}

/**
 * The songs this device should keep offline, best first. Never a disliked song, nor one the user hid as a
 * duplicate, whatever rule would otherwise pick it. A playlist song this device has no song row for is skipped:
 * there is nothing to download it from.
 */
export function wantedSongIds(input: {
    settings: AutoDownloadSettings;
    songs: readonly CandidateSong[];
    playlists: readonly CandidatePlaylist[];
    nowMs: number;
}): string[] {
    const { settings, songs, playlists, nowMs } = input;
    const byId = new Map(songs.map((x) => [x.songId, x]));
    const wanted = new Set<string>();

    for (const song of songs) {
        if (matchesTier(song, settings.tier)) {
            wanted.add(song.songId);
        }
    }

    const addPlaylist = (playlist: CandidatePlaylist, keep: (song: CandidateSong) => boolean = () => true) => {
        for (const songId of playlist.songIds) {
            const song = byId.get(songId);
            if (song && keep(song)) {
                wanted.add(songId);
            }
        }
    };

    if (settings.mixWeeks > 0) {
        const mixes = playlists
            .filter((x) => x.isExploratory)
            .map((x) => ({ playlist: x, week: mixWeekOf(x.name, nowMs) }))
            .filter((x): x is { playlist: CandidatePlaylist; week: number } => x.week != undefined);
        const latestWeeks = new Set([...new Set(mixes.map((x) => x.week))].sort((a, b) => b - a).slice(0, settings.mixWeeks));
        const keep = settings.mixUnheardOnly
            ? (song: CandidateSong) => isUnheard(song) || matchesTier(song, "library")
            : undefined;
        for (const mix of mixes.filter((x) => latestWeeks.has(x.week))) {
            addPlaylist(mix.playlist, keep);
        }
    }

    if (settings.subscriptions) {
        for (const playlist of playlists.filter((x) => x.isExploratory && x.name === SUBSCRIPTIONS_PLAYLIST_NAME)) {
            addPlaylist(playlist);
        }
    }

    if (settings.playlistIds.length > 0) {
        const chosen = new Set(settings.playlistIds);
        for (const playlist of playlists.filter((x) => chosen.has(x.playlistId))) {
            addPlaylist(playlist);
        }
    }

    return [...wanted]
        .map((songId) => byId.get(songId)!)
        .filter((song) => song.likeStatus !== DISLIKE && !song.hidden)
        .sort((a, b) => rankOf(a) - rankOf(b) || (a.songId < b.songId ? -1 : a.songId > b.songId ? 1 : 0))
        .map((x) => x.songId);
}

// ── The difference, and the delay ────────────────────────────────────────────────────────────────────────────────

export type PendingAction = "add" | "remove";

export interface PendingDifference {
    songId: string;
    action: PendingAction;
    /** When this difference was first seen. The delay counts from here. */
    firstSeenAt: number;
}

export interface Difference {
    songId: string;
    action: PendingAction;
}

/**
 * What differs between the wanted set and what this device has.
 *   add    - wanted, and neither downloaded nor queued (by either source).
 *   remove - downloaded or queued by the rules (`auto`), and no longer wanted. Never a `manual` one, and never a
 *            protected song (playing now, queued to play next, or lined up as the next shuffle picks).
 * Adds come out in wanted order, so the best songs queue first.
 */
export function diffAutoDownloads(input: {
    wanted: readonly string[];
    downloaded: ReadonlyMap<string, DownloadSource>;
    queued: ReadonlyMap<string, DownloadSource>;
    protectedIds: ReadonlySet<string>;
}): Difference[] {
    const { wanted, downloaded, queued, protectedIds } = input;
    const wantedSet = new Set(wanted);
    const differences: Difference[] = [];

    for (const songId of wanted) {
        if (!downloaded.has(songId) && !queued.has(songId)) {
            differences.push({ songId, action: "add" });
        }
    }

    const removable = new Set<string>();
    for (const map of [downloaded, queued]) {
        for (const [songId, source] of map) {
            if (source === "auto" && !wantedSet.has(songId) && !protectedIds.has(songId)) {
                removable.add(songId);
            }
        }
    }
    // A song both downloaded by hand and queued by the rules (or the reverse) is the user's: leave it be.
    for (const songId of removable) {
        if (downloaded.get(songId) !== "manual" && queued.get(songId) !== "manual") {
            differences.push({ songId, action: "remove" });
        }
    }

    return differences;
}

export interface ReconcilePlan {
    /** Pending rows to insert. Existing ones whose difference still holds are left as they are, clock running. */
    insertPending: PendingDifference[];
    /** Pending rows to drop: the difference vanished or flipped (an undo), or it is being acted on now. */
    deletePending: string[];
    /** Songs to queue as auto downloads, best first. */
    enqueue: string[];
    /** Songs whose auto download or auto queue row is to go. */
    remove: string[];
}

/**
 * Applies the delay. A difference seen for the first time gets a pending row and waits. One that has held for
 * `delayMs` since it was first seen is acted on, and its row goes. A pending row whose difference has gone, or turned
 * into the opposite one, is dropped: that is how an undo inside the window leaves nothing behind. A flip starts a new
 * clock, so a like, then an un-like five minutes later, then a re-like waits a full window from the re-like.
 */
export function planReconcile(input: {
    differences: readonly Difference[];
    pending: readonly PendingDifference[];
    nowMs: number;
    delayMs?: number;
}): ReconcilePlan {
    const delayMs = input.delayMs ?? AUTO_DOWNLOAD_DELAY_MS;
    const pendingById = new Map(input.pending.map((x) => [x.songId, x]));
    const current = new Map(input.differences.map((x) => [x.songId, x.action]));
    const plan: ReconcilePlan = { insertPending: [], deletePending: [], enqueue: [], remove: [] };

    for (const row of input.pending) {
        if (current.get(row.songId) !== row.action) {
            plan.deletePending.push(row.songId);
        }
    }

    for (const difference of input.differences) {
        const row = pendingById.get(difference.songId);
        const held = row != undefined && row.action === difference.action;
        const firstSeenAt = held ? row.firstSeenAt : input.nowMs;
        if (input.nowMs - firstSeenAt >= delayMs) {
            // A zero delay (the developer hook) acts on first sight, with no pending row at all.
            (difference.action === "add" ? plan.enqueue : plan.remove).push(difference.songId);
            if (held) {
                plan.deletePending.push(difference.songId);
            }
        } else if (!held) {
            plan.insertPending.push({ songId: difference.songId, action: difference.action, firstSeenAt });
        }
    }

    return plan;
}

/**
 * Which of the songs being removed can have their files deleted. Files are named by hash, so two song rows with the
 * same audio share one file: a file another kept download still uses stays on disk.
 */
export function fileHashesToDelete(input: {
    removing: readonly { songId: string; fileHash: string }[];
    keptFileHashes: ReadonlySet<string>;
}): Set<string> {
    const hashes = new Set<string>();
    for (const song of input.removing) {
        if (!input.keptFileHashes.has(song.fileHash)) {
            hashes.add(song.fileHash);
        }
    }
    return hashes;
}

// ── The free-space floor ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether an auto download may start. Fails closed: with free space unknown, it doesn't. A hand-picked download
 * never asks.
 */
export function autoDownloadFits(input: { freeBytes: number | undefined; songBytes: number; floorBytes: number }): boolean {
    if (input.freeBytes == undefined || !Number.isFinite(input.freeBytes)) {
        return false;
    }
    return input.freeBytes - input.songBytes >= input.floorBytes;
}

/**
 * How big a song is, for the floor. The average for now; the settings screen (ShuffullApp#226) swaps in the real
 * sizes once the API serves them (Shuffull#150) by calling `setSongSizeSource`.
 */
export interface SongSizeSource {
    bytesFor(songId: string): number;
}

/** Measured on prod 2026-11-19: 3.57 MB per song on average. */
export const AVERAGE_SONG_BYTES = Math.round(3.6 * 1024 * 1024);

export const averageSongSize: SongSizeSource = { bytesFor: () => AVERAGE_SONG_BYTES };

let songSizeSource: SongSizeSource = averageSongSize;

export function setSongSizeSource(source: SongSizeSource): void {
    songSizeSource = source;
}

export function getSongSizeSource(): SongSizeSource {
    return songSizeSource;
}
