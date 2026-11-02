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
/** How often the request list re-reads its statuses while it is on screen and something is still open. */
export const SONG_REQUEST_POLL_MS = 5_000;

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

export function songRequestsCapability(outcome: { capabilities: Capabilities } | { error: unknown }): SongRequestsCapability {
    if ("capabilities" in outcome) {
        return outcome.capabilities.songRequests ? "on" : "off";
    }
    return outcome.error instanceof ApiStatusFailureError && outcome.error.status === HttpStatusCode.NotFound ? "off" : "unknown";
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

/** Still alive on the server, so its status can change: the producer may move it on, and a late import completes even a Failed one. */
export function isOpenSongRequest(status: number): boolean {
    return status === SongRequestStatus.Pending
        || status === SongRequestStatus.Accepted
        || status === SongRequestStatus.Downloading
        || status === SongRequestStatus.Retrying
        || status === SongRequestStatus.Failed;
}

/** Poll only while something can still change. Every change after that is this device's own, and refreshes the list itself. */
export function shouldPollSongRequests(requests: readonly SongRequest[]): boolean {
    return requests.some(r => isOpenSongRequest(r.status));
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
