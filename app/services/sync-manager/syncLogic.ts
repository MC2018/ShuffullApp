import { getProcessingMethod, ProcessingMethod, RequestType } from "@/app/enums";

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

// Cursor advancement for the incremental "changed songs" feed: when a page has items, the cursor moves
// to the newest Version on the page (across ALL changed songs, not just the local ones), so already-seen
// changes are never re-paged. An empty page leaves the cursor where it was.
export function advanceSongCursor<T extends { version: Date }>(
    pageItems: T[],
    currentCursor: Date
): Date {
    if (pageItems.length) {
        return pageItems[pageItems.length - 1].version;
    }

    return currentCursor;
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
