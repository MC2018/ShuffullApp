import axios, { AxiosHeaders, AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema, Capabilities, CapabilitiesSchema, CreateSongRequestPayload, ChangedSongKeysSchema, ChangedSongPageSchema, CreatePlaylistResponseSchema, DeletedSongsPage, DeletedSongsPageSchema, FeedCursor, KeepResponse, KeepResponseSchema, ListenStatsResponse, ListenStatsResponseSchema, Playlist, PlaylistListResponseSchema, Recap, RecapSchema, RecordListensResponse, RecordListensResponseSchema, RetagResponse, RetagResponseSchema, RetagStaleResponse, RetagStaleResponseSchema, SongListResponseSchema, SongRequest, SongRequestListSchema, SongRequestSchema, SongRequestSearchResponseSchema, SongRequestSearchResult, SongRetagWireItem, Tag, TagListResponseSchema, UserDevice, UserDeviceSchema, UserResponseSchema, UserSongKeysSchema, UserSongPageSchema } from "./models";
import { DeviceCheckInBody } from "../../tools/device";
import { ApiStatusFailureError } from "./errors";
import { RecordListenPayload, UpdateSongLastPlayedRequest, UpdateSongMetadataPayload } from "../db/models";
import { log } from "../../tools/log";

// How long a call may take before it counts as no answer (a 503 to the sync, which then backs off and retries).
// One 3 s limit for everything was too short for the big calls: a 500-id song list or a 200-song keep on a slow
// link could time out on every try, so the first sync never finished, and each retry replayed work the server had
// already done.
// - Single-item calls and logins get DEFAULT.
// - Calls that carry or return a whole list, page or batch (SONG_LIST_MAX_IDS, OUTBOX_MAX_BATCH_SIZE) get BULK.
// - Re-tags run the AI on each song before answering, so they get AI.
// - A song search is relayed to the ingestion side and waits for its answer, so it gets SEARCH. The API gives up on
//   that hop after its own timeout (5 s by default) and answers 503, so this only has to outlast that plus the link.
export const DEFAULT_TIMEOUT_MS = 10_000;
export const BULK_TIMEOUT_MS = 30_000;
export const SEARCH_TIMEOUT_MS = 20_000;
export const AI_TIMEOUT_MS = 120_000;

export class ApiClient {
    private client: AxiosInstance;
    private url: string;

    constructor(url: string, token: string) {
        this.client = axios.create({
            baseURL: url,
            timeout: DEFAULT_TIMEOUT_MS,
            // Resolve every status rather than letting axios reject non-2xx. Its default rejection threw a bare
            // AxiosError, so the isSuccessfulStatus checks below never ran and ApiStatusFailureError was never
            // constructed — SyncManager saw an unrecognised error and reported it as a 500. That both hid the
            // real status and wedged the outbox, because a 500 aborts the whole sync while a 4xx/401 does not.
            validateStatus: () => true
        });
        this.client.interceptors.response.use(undefined, redactCredentials);
        this.updateAuthHeader(token);
        this.url = url;
    }

    public getBaseURL() {
        return this.url;
    }

    public updateAuthHeader(token: string) {
        this.client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    }

    // In the body, never the URL: the hash is all it takes to log in, and URLs end up in proxy logs.
    public async userAuthenticate(username: string, userHash: string): Promise<AuthenticateResponse> {
        return this.request("post", "/api/v1/users/authenticate", { body: { username, userHash }, schema: AuthenticateResponseSchema });
    }

    // Create returns the same { user, token, expiration } envelope as authenticate, so a successful registration can
    // log the user straight in. The hash goes in the body, as for authenticate.
    public async userCreate(username: string, userHash: string): Promise<AuthenticateResponse> {
        return this.request("post", "/api/v1/users", { body: { username, userHash }, schema: AuthenticateResponseSchema });
    }

    // Each hash is the same client argon2 of "username;password" that login sends. The server signs out every other
    // token the user holds and answers with a fresh session for this device. A wrong current password is a 400.
    public async userChangePassword(currentUserHash: string, newUserHash: string): Promise<AuthenticateResponse> {
        return this.request("post", "/api/v1/users/me/password", { body: { currentUserHash, newUserHash }, schema: AuthenticateResponseSchema });
    }

    // Any user: which optional features this server has set up. An API from before Shuffull#58 answers 404.
    public async capabilitiesGet(): Promise<Capabilities> {
        return this.request("get", "/api/v1/capabilities", { schema: CapabilitiesSchema });
    }

    // Any user: songs to request, searched on the ingestion side. 503 when that side is down or slow, 429 past the
    // caller's search allowance, 400 for empty or overlong text (see describeSearchFailure).
    public async songRequestSearch(query: string, limit: number): Promise<SongRequestSearchResult[]> {
        return this.request("get", "/api/v1/song-requests/search", {
            params: { q: query, limit }, timeout: SEARCH_TIMEOUT_MS, schema: SongRequestSearchResponseSchema
        });
    }

    // Any user: request a song by its source id. A direct call, not an outbox row: the user sees the outcome at once
    // and retries by hand. Requesting a song the server has completes at once; requesting a Failed one again retries
    // it. A 409 means it is already requested (or the user has too many open), with the reason in { error }.
    public async songRequestCreate(payload: CreateSongRequestPayload): Promise<SongRequest> {
        return this.request("post", "/api/v1/song-requests", { body: payload, schema: SongRequestSchema, note: "create" });
    }

    // Any user: one page of the songs they deleted, newest first (ShuffullApp#59). Pass the previous page's nextBefore
    // to get the next one. Read straight from the server, not synced: an API from before it answers 404.
    public async songGetDeleted(before?: string): Promise<DeletedSongsPage> {
        return this.request("get", "/api/v1/songs/deleted", {
            params: before != null ? { before } : undefined, timeout: BULK_TIMEOUT_MS, schema: DeletedSongsPageSchema
        });
    }

    // Any user: their most recent song requests (the API's last 50), newest first.
    public async songRequestListMine(): Promise<SongRequest[]> {
        return this.request("get", "/api/v1/song-requests", { schema: SongRequestListSchema });
    }

    // Any user: withdraw a request the producer hasn't picked up yet (Pending only; anything later is a 409).
    public async songRequestCancel(songRequestId: string): Promise<SongRequest> {
        return this.request("delete", `/api/v1/song-requests/${encodeURIComponent(songRequestId)}`, { schema: SongRequestSchema, note: "cancel" });
    }

    public async userGet() {
        return (await this.request("get", "/api/v1/users/me", { schema: UserResponseSchema })).user;
    }

    public async tagGetAll(): Promise<Tag[]> {
        return (await this.request("get", "/api/v1/tags", { timeout: BULK_TIMEOUT_MS, schema: TagListResponseSchema })).tags;
    }

    public async playlistGetAll() {
        return (await this.request("get", "/api/v1/playlists", { timeout: BULK_TIMEOUT_MS, schema: PlaylistListResponseSchema })).playlists;
    }

    public async playlistGetList(playlistIds: string[]): Promise<Playlist[]> {
        return (await this.request("post", "/api/v1/playlists/list", {
            body: playlistIds, timeout: BULK_TIMEOUT_MS, schema: PlaylistListResponseSchema
        })).playlists;
    }

    public async playlistCreate(name: string): Promise<Playlist> {
        return (await this.request("put", "/api/v1/playlists", { params: { name }, schema: CreatePlaylistResponseSchema, note: "create" })).playlist;
    }

    public async playlistAddSong(playlistId: string, songId: string): Promise<void> {
        await this.request("post", `/api/v1/playlists/${playlistId}/songs`, { params: { songId }, note: "add" });
    }

    public async playlistRemoveSong(playlistId: string, songId: string): Promise<void> {
        await this.request("delete", `/api/v1/playlists/${playlistId}/songs/${songId}`, { note: "remove" });
    }

    public async playlistDelete(playlistId: string): Promise<void> {
        await this.request("delete", `/api/v1/playlists/${playlistId}`, { note: "delete" });
    }

    // One page of the caller's user songs after `cursor`. The cursor is sent exactly as given (see FeedCursor).
    public async userSongGetAll(cursor: FeedCursor) {
        return this.request("get", "/api/v1/user-songs", {
            params: { afterDate: cursor.afterDate, afterId: cursor.afterId },
            timeout: BULK_TIMEOUT_MS,
            // Keep the { items, endOfList } shape SyncManager consumes; the API key is `userSongs`.
            schema: { parse: data => {
                const page = UserSongPageSchema.parse(data);
                return { items: page.userSongs, keys: UserSongKeysSchema.parse(data).userSongs, endOfList: page.endOfList };
            } },
        });
    }

    public async userSongCreateMany(songIds: string[]): Promise<void> {
        await this.request("put", "/api/v1/user-songs", { body: songIds, timeout: BULK_TIMEOUT_MS });
    }

    public async userSongUpdateLastPlayed(requests: UpdateSongLastPlayedRequest[]): Promise<void> {
        await this.request("post", "/api/v1/user-songs/last-played", { body: requests, timeout: BULK_TIMEOUT_MS });
    }

    // The endpoint takes the LikeStatus enum as a JSON-encoded int in the body.
    public async userSongSetLikeStatus(songId: string, likeStatus: number): Promise<void> {
        await this.request("post", `/api/v1/user-songs/${songId}/like`, { body: likeStatus });
    }

    // Flags a song's audio as poor quality so it gets queued for re-sourcing (global per song).
    public async flagSongForReplacement(songId: string): Promise<void> {
        await this.request("post", "/api/v1/replacements", { body: { songId } });
    }

    // Curator-only metadata edit. The server gates this with the Curator role and bumps the song's version
    // so every client re-syncs the corrected record. Body matches the site's UpdateSongRequest.
    public async songUpdate(songId: string, payload: UpdateSongMetadataPayload): Promise<void> {
        await this.request("put", `/api/v1/songs/${songId}`, { body: payload });
    }

    // Any user: record a Keep of audition songs in their library. Promotes them server-side (clears Exploratory) and
    // runs no AI, so the decision is durable whatever happens to tagging. Returns a per-song outcome.
    public async songKeep(songIds: string[]): Promise<KeepResponse> {
        return this.request("post", "/api/v1/songs/keep", {
            body: { songIds }, timeout: BULK_TIMEOUT_MS, schema: KeepResponseSchema, note: `${songIds.length} songs`
        });
    }

    // Curator-only: force re-tag a specific set of songs from their stored inputs with the current strong model
    // (no re-download), regardless of staleness. Multi-id so the offline outbox can coalesce many queued
    // re-tags into one call. Returns a per-song outcome so the caller can mark items done / retry only failures.
    // Per-item model tiers so one burst flushes a mixed weak/strong backlog; the server collapses duplicate ids
    // stronger-wins.
    public async songRetag(items: SongRetagWireItem[]): Promise<RetagResponse> {
        return this.request("post", "/api/v1/songs/retag", {
            body: { items }, timeout: AI_TIMEOUT_MS, schema: RetagResponseSchema, note: `${items.length} songs`
        });
    }

    // Curator-only: re-tag up to `limit` stale songs (weaker/older model than the current strong one). Returns
    // { enriched, failed, remaining, strongModel } so the caller can loop until remaining hits 0.
    public async songRetagStale(limit: number): Promise<RetagStaleResponse> {
        return this.request("post", "/api/v1/songs/retag-stale", {
            params: { limit }, timeout: AI_TIMEOUT_MS, schema: RetagStaleResponseSchema, note: `limit ${limit}`
        });
    }

    public async songGetList(songIds: string[]) {
        return (await this.request("post", "/api/v1/songs/list", {
            body: songIds, timeout: BULK_TIMEOUT_MS, schema: SongListResponseSchema
        })).songs;
    }

    // Songs whose server-side Version is after `cursor`, one page at a time. Used to refresh already-synced songs in
    // place — e.g. after a song is replaced with better-quality audio. The cursor is sent exactly as given.
    public async songGetChanged(cursor: FeedCursor) {
        return this.request("get", "/api/v1/songs/changed", {
            params: { afterDate: cursor.afterDate, afterId: cursor.afterId },
            timeout: BULK_TIMEOUT_MS,
            schema: { parse: data => {
                const page = ChangedSongPageSchema.parse(data);
                return { items: page.songs, keys: ChangedSongKeysSchema.parse(data).songs, endOfList: page.endOfList };
            } },
        });
    }

    // Any user: this install is open, under this name (Shuffull#132). Creates the caller's device row the first time,
    // then updates it in place. An API from before that answers 404, which the check-in logs and drops.
    public async deviceCheckIn(deviceId: string, body: DeviceCheckInBody): Promise<UserDevice> {
        return this.request("put", `/api/v1/devices/${encodeURIComponent(deviceId)}`, { body, schema: UserDeviceSchema });
    }

    // Any user: log finished listens (at most 200 per call, the server's MaxBatch). Returns one outcome per listen;
    // a resend of a stored listen comes back "duplicate".
    public async listenRecord(listens: RecordListenPayload[]): Promise<RecordListensResponse> {
        return this.request("post", "/api/v1/listens", {
            body: { listens }, timeout: BULK_TIMEOUT_MS, schema: RecordListensResponseSchema, note: `${listens.length} listens`
        });
    }

    // Any user: their own per-song listen stats and the "maybe drop this" flags (one row per song they ever played).
    // A server from before Shuffull#61 answers 404; SyncManager.refreshListenStats keeps the last synced stats then.
    public async listenStats(): Promise<ListenStatsResponse> {
        return this.request("get", "/api/v1/listens/stats", { timeout: BULK_TIMEOUT_MS, schema: ListenStatsResponseSchema });
    }

    // Any user: their recap of one year, computed on every call. timeZone is an IANA id or an offset like "+02:00".
    // An API without the endpoint yet answers 404 (ApiStatusFailureError), which the recap screen reports quietly.
    // BULK: the server adds up a whole year of listens before answering, and a timeout would read as being offline.
    public async recapGet(year: number, timeZone: string): Promise<Recap> {
        return this.request("get", `/api/v1/recap/${year}`, { params: { timeZone }, timeout: BULK_TIMEOUT_MS, schema: RecapSchema });
    }

    /**
     * Every call goes through here. It sends `body` as JSON, throws ApiStatusFailureError for any status outside 2xx
     * (the client resolves them all, see the constructor), and parses the answer with `schema`. Without a schema the
     * answer is ignored: a call that returns data must parse it, never cast it, so a 200 carrying some other body
     * (a proxy page, a renamed field) fails the call rather than reach the caller as undefined fields.
     *
     * A call that gets no answer rejects with the AxiosError, its credentials already stripped (redactCredentials).
     * Either way the error is logged and rethrown; statusOfFailure turns it into the status the outbox acts on.
     */
    private request<T>(method: HttpMethod, endpoint: string, options: RequestOptions & { schema: ResponseSchema<T> }): Promise<T>;
    // Without a schema the answer is void, so a method that declares a return value can't skip the parse.
    private request(method: HttpMethod, endpoint: string, options?: RequestOptions & { schema?: undefined }): Promise<void>;
    private async request<T>(method: HttpMethod, endpoint: string, options: RequestOptions & { schema?: ResponseSchema<T> } = {}): Promise<T | void> {
        const { body, params, timeout, schema, note } = options;
        const label = note ? `${endpoint} (${note})` : endpoint;
        log.info("API", `Calling endpoint: ${label}`);
        try {
            const response = await this.client.request({
                method,
                url: endpoint,
                params,
                timeout,
                // Stringified, with the type set, so a bare number or array goes out as JSON too: [FromBody] binds JSON only.
                ...(body === undefined ? {} : { data: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
            });

            if (!isSuccessfulStatus(response.status)) {
                log.info("API", `Endpoint ${label} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            log.info("API", `Endpoint ${label} succeeded`);
            return schema?.parse(response.data);
        } catch (error) {
            log.info("API", `Endpoint ${label} failed with error:`, error);
            throw error;
        }
    }
}

type HttpMethod = "get" | "post" | "put" | "delete";

/** Parses an answer: a zod schema, or `{ parse }` to reshape it. */
interface ResponseSchema<T> {
    parse(data: unknown): T;
}

interface RequestOptions {
    /** Sent as the JSON body. Leave out for a call without one. */
    body?: unknown;
    /** Query string parameters. Never credentials: URLs end up in proxy logs. */
    params?: Record<string, unknown>;
    /** Defaults to DEFAULT_TIMEOUT_MS; see the timeouts at the top for which calls need more. */
    timeout?: number;
    /** Added to the log line, to tell calls on one endpoint apart. */
    note?: string;
}

function isSuccessfulStatus(status: number) {
    return 200 <= status && status < 300;
}

// A request that fails without an answer (offline, timeout) rejects with an AxiosError that carries its request
// config: the Authorization header, and for login, sign-up and a password change the password hashes in the body.
// Callers log these errors whole, so both are stripped before the error leaves the client.
function redactCredentials(error: unknown) {
    if (axios.isAxiosError(error)) {
        if (error.config) {
            const headers = AxiosHeaders.from(error.config.headers);
            headers.delete("Authorization");
            error.config = { ...error.config, headers, data: undefined };
        }
        error.request = undefined;
    }
    return Promise.reject(error);
}
