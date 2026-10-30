import { getProcessingMethod, ProcessingMethod, RequestType } from "@/app/enums";
import type { FeedCursor, FeedKey } from "@/app/services/api/models";
import type { DeletePlaylistPayload } from "@/app/services/db/schema";

// Pure, dependency-free pieces lifted out of SyncManager.overallSync so they can be unit-tested without
// the surrounding native deps (expo-sqlite, async-storage, the API client). Behaviour is preserved
// exactly: SyncManager calls these in place of the inline logic it used to run.

// Minimal shapes these helpers need — kept local so the module imports nothing native. They are
// structurally compatible with ApiModels.Playlist / ApiModels.UserSong / ApiModels.ChangedSong.
export interface PlaylistVersionInfo {
    playlistId: string;
    version: Date;
}

// Which accessible playlists need a full re-fetch: ones we don't hold locally, or whose server
// `version` is newer than our local copy. Mirrors the original inline diff in overallSync.
export function playlistsToFetch(
    accessiblePlaylists: PlaylistVersionInfo[],
    localPlaylists: PlaylistVersionInfo[]
): string[] {
    const toFetch: string[] = [];

    for (const accessiblePlaylist of accessiblePlaylists) {
        const localPlaylist = localPlaylists.filter(x => x.playlistId == accessiblePlaylist.playlistId);
        if (!localPlaylist.length || localPlaylist[0].version < accessiblePlaylist.version) {
            toFetch.push(accessiblePlaylist.playlistId);
        }
    }

    return toFetch;
}

// Song IDs referenced by the updated playlists / user-songs that we don't already hold locally.
// De-duplicated (first occurrence wins) and filtered against the local set, exactly as overallSync did.
export function collectNewSongIds(
    updatedPlaylistSongIds: string[][],
    updatedUserSongIds: string[],
    localSongIds: string[]
): string[] {
    return [
        ...updatedPlaylistSongIds.flatMap(x => x),
        ...updatedUserSongIds,
    ]
        .filter((value, index, self) => self.indexOf(value) === index)
        .filter(songId => songId && !localSongIds.includes(songId));
}

// ── Paging the Version-ordered feeds ────────────────────────────────────────────────────────────────
// `/songs/changed` and `/user-songs` both page 500 rows at a time ordered by Version. Paging on `afterDate` alone
// loops forever once 500 or more rows share one Version: the next page is the same page (shuffull-workspace#38, the
// 2026-10-23 phone hang). The server now also takes `afterId` and then pages by the keyset (Version, SongId)
// (Shuffull#64). That needs the row's Version exactly: a JS Date keeps milliseconds and Version has microseconds.

/** One page of a feed: its rows, the key of each row (same order), and whether the server says it is the last. */
export interface FeedPage<T> {
    items: T[];
    keys: FeedKey[];
    endOfList: boolean;
}

/** 0001-01-01: the API binds afterDate to a .NET DateTime, so a year-0000 sentinel fails model binding (400). */
export const FEED_START = "0001-01-01T00:00:00.000Z";

const VERSION_PARTS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * A timestamp one microsecond before `version` (Postgres keeps microseconds), so `Version > result` still matches the
 * rows AT `version`. Digits past the sixth are dropped first, which only moves it further back.
 */
export function justBefore(version: string): string {
    const parts = VERSION_PARTS.exec(version);
    // No zone read as UTC, not local time: the server's Versions are UTC, and local would move this by hours.
    const secondMs = parts ? Date.parse(parts[1] + (parts[3] ?? "Z")) : NaN;
    if (!parts || Number.isNaN(secondMs)) {
        // Not the shape System.Text.Json writes. A millisecond back is still before it.
        return new Date(Date.parse(version) - 1).toISOString();
    }

    const micros = Number((parts[2] ?? "").slice(0, 6).padEnd(6, "0"));
    const [ms, before] = micros > 0 ? [secondMs, micros - 1] : [secondMs - 1000, 999_999];
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${String(before).padStart(6, "0")}Z`);
}

/**
 * Where the page after `keys` starts, or null if that is the request just sent (it would loop).
 *
 * The keyset form is only used when the whole page shares one Version, because a server from before Shuffull#64
 * ignores `afterId` and would read the exact Version as `Version > v`, skipping the rest of a tie that spans the
 * page boundary. Otherwise the cursor is just before the last Version, which both servers read the same way: the
 * tied rows already seen come back (callers dedupe them) and none are skipped. A whole page of one Version is the
 * one case where that makes no progress. There an old server skips the rest of the tie instead of looping forever.
 */
export function nextFeedCursor(keys: FeedKey[], sent: FeedCursor): FeedCursor | null {
    const last = keys[keys.length - 1];
    if (last == undefined) {
        return null;
    }

    const next: FeedCursor = keys.every(key => key.version === last.version)
        ? { afterDate: last.version, afterId: last.songId }
        : { afterDate: justBefore(last.version) };

    return next.afterDate === sent.afterDate && next.afterId === sent.afterId ? null : next;
}

/**
 * Pages a feed from `start` to its end. `last` is the key of the last row received (undefined if none), to store as the
 * next sync's start. `stalled` means a page made no progress and paging stopped early rather than loop.
 */
export async function pageFeed<T>(
    start: FeedCursor,
    fetchPage: (cursor: FeedCursor) => Promise<FeedPage<T>>,
): Promise<{ items: T[]; last: FeedKey | undefined; stalled: boolean }> {
    const items: T[] = [];
    let last: FeedKey | undefined;
    let cursor: FeedCursor | null = start;

    while (cursor) {
        const page: FeedPage<T> = await fetchPage(cursor);
        if (cursor.afterId != undefined && page.keys.length && page.keys[0].version !== cursor.afterDate) {
            // Either the tie ended exactly at the page boundary, or the server predates Shuffull#64: it ignored
            // `afterId`, read the request as `Version > afterDate`, and skipped the rest of the tie. Can't tell which.
            console.warn(`[sync] A feed page after ${cursor.afterDate}/${cursor.afterId} held no more rows at that Version. `
                + "If the API predates keyset paging (Shuffull#64), the rest of that tie was skipped.");
        }
        items.push(...page.items);
        last = page.keys[page.keys.length - 1] ?? last;
        if (page.endOfList) {
            return { items, last, stalled: false };
        }
        cursor = nextFeedCursor(page.keys, cursor);
    }

    return { items, last, stalled: true };
}

/**
 * Where the songs feed starts this sync, from the two stored values; null on the first sync (nothing stored).
 *
 * `cursorRaw` (SONG_SYNC_CURSOR) is the last Version seen; older builds read and write it as an ISO date.
 * `keyRaw` (SONG_SYNC_KEY) is the full key of that row. The key is used only when its Version is the stored cursor,
 * so a cursor an older build wrote since never pairs with a stale id. Either way the stored cursor came from the end of
 * a feed, where every row at that Version was received, so `afterDate` can be exact.
 */
export function songFeedStart(cursorRaw: string | null, keyRaw: string | null): FeedCursor | null {
    if (cursorRaw == null) {
        return null;
    }

    try {
        const key = keyRaw == null ? null : JSON.parse(keyRaw) as Partial<FeedKey> | null;
        if (key?.version === cursorRaw && typeof key.songId === "string") {
            return { afterDate: cursorRaw, afterId: key.songId };
        }
    } catch {
        // A malformed key just means paging from the date alone.
    }

    return { afterDate: cursorRaw };
}

/** The most ids `POST /api/v1/songs/list` takes in one call (the site's GetSongListValidator.MaxSongIds). */
export const SONG_LIST_MAX_IDS = 500;

/**
 * How often the app checks every song it holds against the server. Each check is a full `/songs/list` round trip
 * per 500 songs, artists, tags and lyrics included, for the ids alone, so it runs daily rather than every sync.
 */
export const SONG_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How soon the songs one check missed are asked about again. Only those, so this one is cheap. */
export const SONG_RECONFIRM_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A full check that misses more than this share of the library removes nothing. That answer is far likelier to be
 * a different server (logout keeps the local DB, and the login screen takes any host) or a broken one than real
 * deletions. The one real case seen, 573 ghosts in 4,259 songs, was 13%.
 */
export const SONG_RECONCILE_MAX_MISS_SHARE = 0.5;

/** The songs one check missed, and the server and account it asked. A miss counts only against the same pair. */
export interface SongReconcileState {
    host: string | null;
    userId: string;
    misses: string[];
}

/** Reads the stored state back, as no misses when it is absent, malformed, or from another server or account. */
export function pendingSongMisses(raw: string | null, host: string | null, userId: string): string[] {
    try {
        const state = raw == null ? null : JSON.parse(raw) as Partial<SongReconcileState> | null;
        if (state?.host !== host || state?.userId !== userId || !Array.isArray(state.misses)) {
            return [];
        }
        return state.misses.filter((x): x is string => typeof x === "string");
    } catch {
        return [];
    }
}

/** Whether a check is due: soon when the last one left misses to confirm, otherwise daily. */
export function songReconcileDue(lastCheckAt: number | null, now: number, pendingMisses: number): boolean {
    if (lastCheckAt == null || !Number.isFinite(lastCheckAt)) {
        return true;
    }
    const interval = pendingMisses ? SONG_RECONFIRM_INTERVAL_MS : SONG_RECONCILE_INTERVAL_MS;
    return now - lastCheckAt >= interval;
}

/**
 * Which local songs the server no longer has, from one check of `checkedSongIds` against `/songs/list`.
 *
 * The incremental pull can't carry a deletion: both feeds page on `Version`, and a hard-deleted row has no Version
 * left to bump, so it just stops appearing (ShuffullApp#87). `/songs/list` returns only the ids that exist, so a
 * song missing from a complete answer is gone. Removing it locally also removes its download, so one answer is not
 * enough, and nothing the incremental pull does brings a wrongly removed song back:
 *
 * - A full check (no `pendingMisses`) asks about every local song and only remembers what it missed. If it missed
 *   more than SONG_RECONCILE_MAX_MISS_SHARE of them, it remembers nothing and reports the count as `implausible`.
 * - A confirming check asks about the remembered songs alone, an hour later. The ones still missing are purged.
 */
export function songsGoneFromServer(
    checkedSongIds: string[],
    returnedSongIds: string[],
    pendingMisses: string[],
): { purge: string[]; misses: string[]; implausible: number } {
    const returned = new Set(returnedSongIds);
    const missing = checkedSongIds.filter(songId => !returned.has(songId));
    if (pendingMisses.length) {
        const pending = new Set(pendingMisses);
        return { purge: missing.filter(songId => pending.has(songId)), misses: [], implausible: 0 };
    }
    if (missing.length > checkedSongIds.length * SONG_RECONCILE_MAX_MISS_SHARE) {
        return { purge: [], misses: [], implausible: missing.length };
    }
    return { purge: [], misses: missing, implausible: 0 };
}

// One queued re-tag row's shape, as this helper needs it (structurally compatible with
// DbModels.SongRetagRequest). Absent payload (legacy row) means strong.
export interface QueuedRetag {
    songId: string | null;
    payload?: { model?: string } | null;
}

// Maps the queued re-tag rows to the wire's per-item shape ({songId, model}) for ONE burst call.
// Defensive stronger-wins dedupe: the enqueue helper already maintains one row per song, but legacy or
// hand-inserted duplicates must never demote a strong request (mirrors the server's collapse rule).
export function toRetagItems(requests: QueuedRetag[]): { songId: string; model: "weak" | "strong" }[] {
    const modelBySong = new Map<string, "weak" | "strong">();
    for (const request of requests) {
        if (!request.songId) {
            continue;
        }
        const model: "weak" | "strong" = request.payload?.model === "weak" ? "weak" : "strong";
        const existing = modelBySong.get(request.songId);
        if (existing === undefined || (existing === "weak" && model === "strong")) {
            modelBySong.set(request.songId, model);
        }
    }
    return [...modelBySong.entries()].map(([songId, model]) => ({ songId, model }));
}

// ── Outbox disposition ───────────────────────────────────────────────────────────────────────────────
// Deciding what happens to a queued row after the server answers. Pure so the rules can be tested without
// the SyncManager's native deps.

/** One per-song outcome from POST /songs/retag, as the reporting rule needs it. */
export interface RetagOutcomeRow {
    songId: string;
    outcome: "enriched" | "skipped" | "failed";
    error?: string | null;
}

/**
 * The songs a re-tag batch did NOT enrich, with their distinct reasons.
 *
 * The endpoint reports per-item outcomes INSIDE a 200 — the transport succeeding says nothing about the work
 * having run. Discarding that body is exactly how kept songs were lost: with the site's AI disabled every
 * item came back "failed", the outbox saw 200, and deleted the rows anyway with nothing logged.
 *
 * The server now promotes a song (clears Exploratory) BEFORE it enriches, so a 200 means the user's decision
 * is already durable and only the TAGS are outstanding. The song stays findable server-side (it matches the
 * stale-song query), so these are reported rather than re-queued here. Be aware that the sweep which drains
 * that query is currently curator-triggered, not automatic — so this warning is the signal that tags are owed.
 */
export function summarizeRetagFailures(results: RetagOutcomeRow[] | undefined | null): { songIds: string[]; reasons: string[] } {
    const failures = (results ?? []).filter(r => r?.outcome === "failed");
    const reasons = [...new Set(failures.map(r => r.error?.trim() || "(no reason given)"))];
    return { songIds: failures.map(r => r.songId), reasons };
}

/** An outbox row as the retention rule needs it. */
export interface AgedRequest {
    requestId: string;
    timeRequested: Date;
}

/**
 * How long a rejected (4xx) outbox row is kept before it is abandoned. Long enough for a transient cause — a
 * stale token, a server-side fix, a bad deploy rolled back — to clear on its own.
 */
export const REJECTED_REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Splits a rejected batch into rows still inside the retry window and rows old enough to abandon.
 *
 * Replaying the same payload after a 4xx usually won't help, but deleting the rows outright is how queued
 * work used to disappear without trace. Keeping them for a bounded window means a transient cause recovers by
 * itself, while a genuinely malformed row can still never wedge the queue forever.
 *
 * A row with an unparseable timestamp is treated as still fresh: when in doubt, keep the user's work.
 */
export function partitionRejectedRequests<T extends AgedRequest>(
    requests: T[],
    now: Date,
    maxAgeMs: number = REJECTED_REQUEST_MAX_AGE_MS,
): { abandon: T[]; keep: T[] } {
    const abandon: T[] = [];
    const keep: T[] = [];

    for (const request of requests) {
        const queuedAt = request.timeRequested?.getTime?.();
        const age = queuedAt == undefined || Number.isNaN(queuedAt) ? 0 : now.getTime() - queuedAt;
        (age > maxAgeMs ? abandon : keep).push(request);
    }

    return { abandon, keep };
}

/**
 * The largest number of queued rows the flush loop will put in one batched POST.
 *
 * Matches the tightest server-side cap — RetagSongsHandler.MaxBatch (200), which REJECTS an oversized request
 * rather than truncating it. Before this existed the outbox coalesced every consecutive same-type row into a
 * single call, so a big offline backlog produced a request the server could only refuse. That used to be
 * invisible (the 4xx branch deleted the batch); now that rejected rows are retained, an uncapped batch would
 * instead retry until it aged out. Capping is the actual fix.
 */
export const OUTBOX_MAX_BATCH_SIZE = 200;

/** An outbox row as the grouping rule needs it. */
export interface BatchableRequest {
    requestType: number;
}

/**
 * Groups queued rows into the batches the flush loop posts, preserving queue order.
 *
 * - `OnlyOnce` — at most one row per type per flush; later duplicates are dropped entirely.
 * - `Individual` — one row per batch (the endpoint is per-item).
 * - `Batch` — consecutive rows of the same type coalesce, up to `maxBatchSize`.
 * - `None` — never posted here (it is always run separately).
 */
export function groupRequestsIntoBatches<T extends BatchableRequest>(
    requests: T[],
    maxBatchSize: number = OUTBOX_MAX_BATCH_SIZE,
): T[][] {
    const batches: T[][] = [];
    const onlyOnceSeen: RequestType[] = [];
    let lastRequestType: RequestType | null = null;

    for (const request of requests) {
        const requestType = request.requestType as RequestType;

        switch (getProcessingMethod(requestType)) {
            case ProcessingMethod.OnlyOnce:
                if (onlyOnceSeen.includes(requestType)) {
                    // Skips the lastRequestType update below, so a dropped duplicate doesn't break up an
                    // otherwise-contiguous run of batchable rows around it.
                    continue;
                }

                batches.push([request]);
                onlyOnceSeen.push(requestType);
                break;
            case ProcessingMethod.Individual:
                batches.push([request]);
                break;
            case ProcessingMethod.Batch: {
                const current = batches[batches.length - 1];
                if (requestType == lastRequestType && current != undefined && current.length < maxBatchSize) {
                    current.push(request);
                } else {
                    batches.push([request]);
                }
                break;
            }
            case ProcessingMethod.None:
            default:
                break;
        }

        lastRequestType = requestType;
    }

    return batches;
}

/** One per-song outcome from POST /songs/keep. Outcome is a plain string: anything but "kept" is a failure. */
export interface KeepOutcomeRow {
    songId: string;
    outcome: string;
    error?: string | null;
}

/** A queued Keep row as the outcome rule needs it. */
export interface QueuedKeep {
    songId?: string | null;
}

/**
 * The queued Keep rows the server did NOT record, each with its reason.
 *
 * A row counts as kept only when the response names its song as "kept". Everything else — reported failed,
 * absent from the results, or a row with no song id — is returned here to be dead-lettered rather than deleted.
 */
export function failedKeeps<T extends QueuedKeep>(
    requests: T[],
    results: KeepOutcomeRow[] | undefined | null,
): { request: T; reason: string }[] {
    const outcomeBySong = new Map((results ?? []).map(r => [r.songId, r]));
    const failures: { request: T; reason: string }[] = [];

    for (const request of requests) {
        const outcome = request.songId ? outcomeBySong.get(request.songId) : undefined;
        if (outcome?.outcome !== "kept") {
            failures.push({ request, reason: keepFailureReason(request, outcome) });
        }
    }

    return failures;
}

function keepFailureReason(request: QueuedKeep, outcome: KeepOutcomeRow | undefined): string {
    if (!request.songId) {
        return "Keep row has no song id.";
    }

    if (outcome == undefined) {
        return "The server returned no outcome for this song.";
    }

    return outcome.error?.trim() || "The server reported the keep as failed, with no reason.";
}

/** A dead-lettered row as the hold rule needs it. */
export interface DeadLetteredRow extends BatchableRequest {
    songId?: string | null;
}

/** A queued playlist delete as the hold rule needs it. */
export interface QueuedPlaylistDelete {
    payload?: DeletePlaylistPayload | null;
}

/**
 * Why a queued playlist delete must wait, and which dead-lettered Keeps to re-send to lift the hold; null if it
 * may go.
 *
 * Deleting an audition playlist makes the server purge every song in it that is still Exploratory. A Keep the
 * server hasn't recorded leaves its song Exploratory, so sending the delete first is exactly how kept songs were
 * destroyed on 2026-08-22.
 *
 * - While any Keep is still queued, every delete waits. That lasts at most the retry window: a Keep rejected
 *   for longer is dead-lettered.
 * - A dead-lettered Keep holds only a delete whose playlist held that song (every delete, for an older row that
 *   doesn't record its songs). Its song is returned in `retrySongIds`, so the caller can re-send it and lift the
 *   hold once the server records it. Until then the delete waits: sending it would purge a song the user kept.
 *   A held delete loses nothing; the playlist just stays on the server.
 */
export function playlistDeleteHold(
    deleteRequest: QueuedPlaylistDelete,
    outbox: BatchableRequest[],
    deadLetters: DeadLetteredRow[],
): { reason: string; retrySongIds: string[] } | null {
    if (outbox.some(x => x.requestType == RequestType.SongRetag)) {
        return { reason: "a Keep is still waiting to be recorded", retrySongIds: [] };
    }

    const playlistSongIds = deleteRequest.payload?.songIds;
    const inPlaylist = playlistSongIds ? new Set(playlistSongIds) : undefined;
    const blocking = deadLetters
        .filter(x => x.requestType == RequestType.SongRetag && x.songId)
        .map(x => x.songId as string)
        .filter(songId => inPlaylist == undefined || inPlaylist.has(songId));

    if (!blocking.length) {
        return null;
    }

    const retrySongIds = [...new Set(blocking)];
    return { reason: `${retrySongIds.length} song(s) in it were kept but the Keep was never recorded`, retrySongIds };
}

/**
 * How long a delete held behind a dead-lettered Keep waits between re-sends of that Keep. The server's usual verdict
 * ("not in your library") rarely changes, so re-sending on every 10 s flush would only add load.
 */
export const HELD_KEEP_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** The held Keeps not re-sent within the interval, given when each was last re-sent. */
export function keepsDueForRetry(
    songIds: string[],
    lastRetriedAt: ReadonlyMap<string, number>,
    now: number,
    intervalMs: number = HELD_KEEP_RETRY_INTERVAL_MS,
): string[] {
    return songIds.filter(songId => {
        const at = lastRetriedAt.get(songId);
        return at == undefined || now - at >= intervalMs;
    });
}

/**
 * The server's playlists minus any the user has deleted locally but whose delete hasn't been sent yet.
 *
 * Without this a held (or merely not-yet-flushed) delete brings the playlist straight back on the next pull.
 */
export function withoutPendingDeletes<T extends { playlistId: string }>(
    playlists: T[],
    outbox: (BatchableRequest & { playlistId?: string | null })[],
): T[] {
    const pending = new Set(outbox
        .filter(x => x.requestType == RequestType.DeletePlaylist && x.playlistId)
        .map(x => x.playlistId));
    return playlists.filter(x => !pending.has(x.playlistId));
}
