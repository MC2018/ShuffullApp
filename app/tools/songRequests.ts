import { HttpStatusCode } from "axios";
import { SongRequestStatus } from "../enums/SongRequestStatus";
import { ApiStatusFailureError, isUnreachableStatus, statusOfFailure } from "../services/api/errors";
import type { Capabilities, CreateSongRequestPayload, SongRequest, SongRequestSearchResult } from "../services/api/models";

// Song requests (ShuffullApp#107): search for a song the library doesn't have, request it, and follow it to Completed.
// The screen and its hooks call these; everything here is pure, so it is unit-tested on its own.

/** How long the search box waits after the last keystroke. The API allows a burst of 10 searches, then one a second. */
export const SEARCH_DEBOUNCE_MS = 600;
/** Fewer characters than this don't search. */
export const SEARCH_MIN_LENGTH = 2;
/** The API refuses longer search text (SearchSongRequestsValidator.MaxQueryLength). */
export const SEARCH_MAX_LENGTH = 200;
/** Results per search. The API allows 1 to 25. */
export const SEARCH_LIMIT = 15;
/** How often the request list re-reads its statuses while it is on screen and the producer is still working on one. */
export const SONG_REQUEST_POLL_MS = 5_000;
/** How often it tries again while its first read keeps failing. */
export const SONG_REQUEST_RETRY_MS = 60_000;

/** The text to search for, or null when there isn't enough of it yet. */
export function searchQuery(text: string): string | null {
    const query = text.trim();
    return query.length < SEARCH_MIN_LENGTH ? null : query.slice(0, SEARCH_MAX_LENGTH);
}

// ---- Capability gate ----

/**
 * Whether this server offers song requests, from one GET /capabilities.
 * - "on": it says songRequests: true.
 * - "off": it says false, or it answered 404 (an API from before the endpoint), which can't change until a redeploy.
 * - "unknown": no answer, or some other failure. The feature stays hidden, and the next screen that needs it asks again.
 */
export type SongRequestsCapability = "on" | "off" | "unknown";

export interface CapabilityAnswer {
    songRequests: SongRequestsCapability;
    /** When the answer was last known; null while it never has been. */
    askedAt: number | null;
}

export function songRequestsCapability(outcome: { capabilities: Capabilities } | { error: unknown }): SongRequestsCapability {
    if ("capabilities" in outcome) {
        return outcome.capabilities.songRequests ? "on" : "off";
    }
    return outcome.error instanceof ApiStatusFailureError && outcome.error.status === HttpStatusCode.NotFound ? "off" : "unknown";
}

/**
 * The answer after one more ask. A known answer replaces the last one. A failed ask keeps the last known answer and its
 * age, so a flaky connection doesn't hide the feature an hour in, and the next screen asks again.
 */
export function nextCapabilityAnswer(previous: CapabilityAnswer, outcome: { capabilities: Capabilities } | { error: unknown }, now: number): CapabilityAnswer {
    const songRequests = songRequestsCapability(outcome);
    return songRequests === "unknown" ? previous : { songRequests, askedAt: now };
}

/** How long a known answer stands before a screen asks again. The server's answer changes only with a redeploy. */
export const CAPABILITIES_REFRESH_MS = 60 * 60_000;

/** Whether to ask the server again: always while the answer is unknown, otherwise once it is CAPABILITIES_REFRESH_MS old. */
export function shouldAskCapabilities(capability: SongRequestsCapability, askedAt: number | null, now: number): boolean {
    return capability === "unknown" || askedAt == null || now - askedAt >= CAPABILITIES_REFRESH_MS;
}

// ---- Status mapping ----

export type SongRequestTone = "active" | "failed" | "done" | "muted";

export interface SongRequestView {
    /** What the row says: "Pending", "Downloading", "Failed: <reason>"... */
    label: string;
    tone: SongRequestTone;
    /** The API cancels only a request the producer hasn't picked up yet. */
    canCancel: boolean;
    /** A Failed request goes back to Pending when it is requested again. */
    canRetry: boolean;
}

/** How one request shows in the status list. */
export function describeSongRequest(request: Pick<SongRequest, "status" | "failureReason">): SongRequestView {
    const view = (label: string, tone: SongRequestTone, canCancel = false, canRetry = false) => ({ label, tone, canCancel, canRetry });
    switch (request.status) {
        case SongRequestStatus.Pending:
            return view("Pending", "active", true);
        case SongRequestStatus.Accepted:
            return view("Queued", "active");
        case SongRequestStatus.Downloading:
            return view("Downloading", "active");
        case SongRequestStatus.Retrying:
            return view("Retrying", "active");
        case SongRequestStatus.Failed: {
            const reason = request.failureReason?.trim();
            return view(reason ? `Failed: ${reason}` : "Failed", "failed", false, true);
        }
        case SongRequestStatus.Completed:
            return view("Added", "done");
        case SongRequestStatus.Cancelled:
            return view("Cancelled", "muted");
        default:
            // A status from a newer server. Shown, not acted on.
            return view("Unknown status", "muted");
    }
}

/** The producer still has it, so its status will change on its own. */
export function isInFlightSongRequest(status: number): boolean {
    return status === SongRequestStatus.Pending
        || status === SongRequestStatus.Accepted
        || status === SongRequestStatus.Downloading
        || status === SongRequestStatus.Retrying;
}

/**
 * Whether the list should read again, `sinceLastReadMs` after its last try (`requests` null while no read has worked).
 * Every SONG_REQUEST_POLL_MS while the producer is working on a request, every SONG_REQUEST_RETRY_MS while the first read
 * keeps failing, and otherwise not at all. That includes a Failed request: a late import can still complete it, but the
 * normal sync brings its song in anyway, and the list re-reads each time the screen comes back into focus.
 */
export function shouldPollSongRequests(requests: readonly SongRequest[] | null, sinceLastReadMs: number): boolean {
    if (requests == null) {
        return sinceLastReadMs >= SONG_REQUEST_RETRY_MS;
    }
    return requests.some(r => isInFlightSongRequest(r.status)) && sinceLastReadMs >= SONG_REQUEST_POLL_MS;
}

/** A Completed request for this search result: the song the user can play without requesting it again. */
export function completedRequestFor(requests: readonly SongRequest[] | null, externalSongId: string): (SongRequest & { songId: string }) | undefined {
    return requests?.find((r): r is SongRequest & { songId: string } =>
        r.externalSongId === externalSongId && r.status === SongRequestStatus.Completed && r.songId != null);
}

/**
 * A search result as the user's requests now stand, so it follows the list below it: in the library once a request for
 * it completed, Requested while one is open (Failed included: the API refuses a second until it is cancelled), and
 * requestable again once every request for it was cancelled. A result no request mentions keeps what the search said.
 */
export function resultWithRequests(result: SongRequestSearchResult, requests: readonly SongRequest[] | null): SongRequestSearchResult {
    const mine = requests?.filter(r => r.externalSongId === result.externalSongId) ?? [];
    if (mine.length === 0) {
        return result;
    }
    if (mine.some(r => r.status === SongRequestStatus.Completed)) {
        return { ...result, inLibrary: true, alreadyRequested: false };
    }
    const open = mine.some(r => isInFlightSongRequest(r.status) || r.status === SongRequestStatus.Failed);
    return { ...result, alreadyRequested: open };
}

/**
 * The requests that reached Completed since the last read, so the app syncs the new song in. Nothing on the first read
 * (previous null): those completed before the screen opened, and an earlier sync already has them. A completed request
 * not seen before counts, since it completed between the two reads.
 */
export function newlyCompletedRequests(previous: readonly SongRequest[] | null, next: readonly SongRequest[]): SongRequest[] {
    if (previous == null) {
        return [];
    }
    const before = new Map(previous.map(r => [r.songRequestId, r.status]));
    return next.filter(r => r.status === SongRequestStatus.Completed && before.get(r.songRequestId) !== SongRequestStatus.Completed);
}

/** The list as shown: a cancelled request is one the user withdrew, so it drops out. */
export function visibleSongRequests(requests: readonly SongRequest[]): SongRequest[] {
    return requests.filter(r => r.status !== SongRequestStatus.Cancelled);
}

/** `requests` with `changed` in place of its old copy, or first (newest) when it is new. */
export function withSongRequest(requests: readonly SongRequest[], changed: SongRequest): SongRequest[] {
    return requests.some(r => r.songRequestId === changed.songRequestId)
        ? requests.map(r => r.songRequestId === changed.songRequestId ? changed : r)
        : [changed, ...requests];
}

/** The create body for a search result, or for a Failed request being retried (the API matches it by source id). */
export function toCreateSongRequest(source: SongRequestSearchResult | SongRequest): CreateSongRequestPayload {
    return {
        externalSongId: source.externalSongId,
        title: source.title,
        artists: source.artists,
        durationSeconds: source.durationSeconds,
        thumbnailUrl: source.thumbnailUrl,
    };
}

// ---- Failure messages ----

/** The API's reason for a refusal, from its { error } body. */
function serverReason(error: unknown): string | undefined {
    if (!(error instanceof ApiStatusFailureError)) {
        return undefined;
    }
    const data: unknown = error.data;
    const reason = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
    return typeof reason === "string" && reason.trim().length ? reason.trim() : undefined;
}

/** What the search screen says when a search fails. */
export function describeSearchFailure(error: unknown): string {
    // The API answered 503 itself: it couldn't get an answer from the ingestion side, or search isn't set up.
    if (error instanceof ApiStatusFailureError && error.status === HttpStatusCode.ServiceUnavailable) {
        return "Search isn't available right now. Try again in a bit.";
    }
    const status = statusOfFailure(error);
    if (status === HttpStatusCode.TooManyRequests) {
        return "Too many searches. Wait a moment and try again.";
    }
    if (isUnreachableStatus(status)) {
        return "Can't reach the server. Check your connection and try again.";
    }
    return serverReason(error) ?? `Search failed (error ${status}). Try again.`;
}

/** What the screen says when requesting, retrying or cancelling fails. The API explains a 409 (already requested, too many open). */
export function describeRequestFailure(error: unknown): string {
    const status = statusOfFailure(error);
    if (isUnreachableStatus(status)) {
        return "Can't reach the server. Check your connection and try again.";
    }
    return serverReason(error) ?? `That didn't work (error ${status}). Try again.`;
}

/** m:ss, for a result's length. */
export function formatSongDuration(seconds: number | null): string | null {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
        return null;
    }
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
