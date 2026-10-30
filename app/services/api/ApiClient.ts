import axios, { AxiosHeaders, AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema, ChangedSongKeysSchema, ChangedSongPageSchema, CreatePlaylistResponseSchema, FeedCursor, KeepResponse, KeepResponseSchema, ListenStatsResponse, ListenStatsResponseSchema, Playlist, PlaylistListResponseSchema, RecordListensResponse, RecordListensResponseSchema, RetagResponse, RetagStaleResponse, SongListResponseSchema, SongRetagWireItem, Tag, TagListResponseSchema, UserResponseSchema, UserSongKeysSchema, UserSongPageSchema } from "./models";
import { ApiStatusFailureError } from "./errors";
import { RecordListenPayload, UpdateSongLastPlayedRequest, UpdateSongMetadataPayload } from "../db/models";

// How long a call may take before it counts as no answer (a 503 to the sync, which then backs off and retries).
// One 3 s limit for everything was too short for the big calls: a 500-id song list or a 200-song keep on a slow
// link could time out on every try, so the first sync never finished, and each retry replayed work the server had
// already done.
// - Single-item calls and logins get DEFAULT.
// - Calls that carry or return a whole list, page or batch (SONG_LIST_MAX_IDS, OUTBOX_MAX_BATCH_SIZE) get BULK.
// - Re-tags run the AI on each song before answering, so they get AI.
export const DEFAULT_TIMEOUT_MS = 10_000;
export const BULK_TIMEOUT_MS = 30_000;
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

    public async userAuthenticate(username: string, userHash: string): Promise<AuthenticateResponse> {
        const endpoint = "/api/v1/users/authenticate";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            // In the body, never the URL: the hash is all it takes to log in, and URLs end up in proxy logs.
            const response = await this.client.post(endpoint, { username, userHash });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return AuthenticateResponseSchema.parse(response.data);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async userCreate(username: string, userHash: string): Promise<AuthenticateResponse> {
        const endpoint = "/api/v1/users";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            // In the body, never the URL: the hash is all it takes to log in, and URLs end up in proxy logs.
            const response = await this.client.post(endpoint, { username, userHash });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            // Create returns the same { user, token, expiration } envelope as authenticate, so a
            // successful registration can log the user straight in.
            return AuthenticateResponseSchema.parse(response.data);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async tagGetAll(): Promise<Tag[]> {
        const endpoint = "/api/v1/tags";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, { timeout: BULK_TIMEOUT_MS });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return TagListResponseSchema.parse(response.data).tags;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async playlistGetAll() {
        const endpoint = "/api/v1/playlists";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, { timeout: BULK_TIMEOUT_MS });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return PlaylistListResponseSchema.parse(response.data).playlists;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async playlistGetList(playlistIds: string[]): Promise<Playlist[]> {
        const endpoint = "/api/v1/playlists/list";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const playlistIdsJson = JSON.stringify(playlistIds);
            const response = await this.client.post(endpoint, playlistIdsJson, {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return PlaylistListResponseSchema.parse(response.data).playlists;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async playlistCreate(name: string): Promise<Playlist> {
        const endpoint = "/api/v1/playlists";
        console.log(`[API] Calling endpoint: ${endpoint} (create)`);
        try {
            const response = await this.client.put(endpoint, null, { params: { name } });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            return CreatePlaylistResponseSchema.parse(response.data).playlist;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} (create) failed with error:`, error);
            throw error;
        }
    }

    public async playlistAddSong(playlistId: string, songId: string): Promise<void> {
        const endpoint = `/api/v1/playlists/${playlistId}/songs`;
        console.log(`[API] Calling endpoint: ${endpoint} (add)`);
        try {
            const response = await this.client.post(endpoint, null, { params: { songId } });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} (add) failed with error:`, error);
            throw error;
        }
    }

    public async playlistRemoveSong(playlistId: string, songId: string): Promise<void> {
        const endpoint = `/api/v1/playlists/${playlistId}/songs/${songId}`;
        console.log(`[API] Calling endpoint: ${endpoint} (remove)`);
        try {
            const response = await this.client.delete(endpoint);

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} (remove) failed with error:`, error);
            throw error;
        }
    }

    public async playlistDelete(playlistId: string): Promise<void> {
        const endpoint = `/api/v1/playlists/${playlistId}`;
        console.log(`[API] Calling endpoint: ${endpoint} (delete)`);
        try {
            const response = await this.client.delete(endpoint);

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} (delete) failed with error:`, error);
            throw error;
        }
    }

    // One page of the caller's user songs after `cursor`. The cursor is sent exactly as given (see FeedCursor).
    public async userSongGetAll(cursor: FeedCursor) {
        const endpoint = "/api/v1/user-songs";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, {
                timeout: BULK_TIMEOUT_MS,
                params: {
                    afterDate: cursor.afterDate,
                    afterId: cursor.afterId
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            // Keep the { items, endOfList } shape SyncManager consumes; the API key is `userSongs`.
            const page = UserSongPageSchema.parse(response.data);
            const keys = UserSongKeysSchema.parse(response.data).userSongs;
            return { items: page.userSongs, keys, endOfList: page.endOfList };
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async userSongCreateMany(songIds: string[]) {

        const endpoint = "/api/v1/user-songs";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const songIdsJson = JSON.stringify(songIds);
            const response = await this.client.put(endpoint, songIdsJson, {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async userSongUpdateLastPlayed(requests: UpdateSongLastPlayedRequest[]) {
        const endpoint = "/api/v1/user-songs/last-played";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const requestsJson = JSON.stringify(requests);
            const response = await this.client.post(endpoint, requestsJson, {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async userSongSetLikeStatus(songId: string, likeStatus: number) {
        const endpoint = `/api/v1/user-songs/${songId}/like`;
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            // The endpoint takes the LikeStatus enum as a JSON-encoded int in the body.
            const response = await this.client.post(endpoint, JSON.stringify(likeStatus), {
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async flagSongForReplacement(songId: string) {
        const endpoint = "/api/v1/replacements";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            // Flags a song's audio as poor quality so it gets queued for re-sourcing (global per song).
            const response = await this.client.post(endpoint, JSON.stringify({ songId }), {
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Curator-only metadata edit. The server gates this with the Curator role and bumps the song's version
    // so every client re-syncs the corrected record. Body matches the site's UpdateSongRequest.
    public async songUpdate(songId: string, payload: UpdateSongMetadataPayload) {
        const endpoint = `/api/v1/songs/${songId}`;
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.put(endpoint, JSON.stringify(payload), {
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Any user: record a Keep of audition songs in their library. Promotes them server-side (clears Exploratory) and
    // runs no AI, so the decision is durable whatever happens to tagging. Returns a per-song outcome.
    public async songKeep(songIds: string[]): Promise<KeepResponse> {
        const endpoint = "/api/v1/songs/keep";
        console.log(`[API] Calling endpoint: ${endpoint} (${songIds.length} songs)`);
        try {
            const response = await this.client.post(endpoint, JSON.stringify({ songIds }), {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return KeepResponseSchema.parse(response.data);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Any user: log finished listens (at most 200 per call, the server's MaxBatch). Returns one outcome per listen;
    // a resend of a stored listen comes back "duplicate".
    public async listenRecord(listens: RecordListenPayload[]): Promise<RecordListensResponse> {
        const endpoint = "/api/v1/listens";
        console.log(`[API] Calling endpoint: ${endpoint} (${listens.length} listens)`);
        try {
            const response = await this.client.post(endpoint, JSON.stringify({ listens }), {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return RecordListensResponseSchema.parse(response.data);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Any user: their own per-song listen stats and the "maybe drop this" flags (one row per song they ever played).
    // A server from before Shuffull#61 answers 404; SyncManager.refreshListenStats keeps the last synced stats then.
    public async listenStats(): Promise<ListenStatsResponse> {
        const endpoint = "/api/v1/listens/stats";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, { timeout: BULK_TIMEOUT_MS });
            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return ListenStatsResponseSchema.parse(response.data);
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Curator-only: force re-tag a specific set of songs from their stored inputs with the current strong model
    // (no re-download), regardless of staleness. Multi-id so the offline outbox can coalesce many queued
    // re-tags into one call. Returns a per-song outcome so the caller can mark items done / retry only failures.
    public async songRetag(items: SongRetagWireItem[]): Promise<RetagResponse> {
        const endpoint = `/api/v1/songs/retag`;
        console.log(`[API] Calling endpoint: ${endpoint} (${items.length} songs)`);
        try {
            // Per-item model tiers so one burst flushes a mixed weak/strong backlog; the server collapses
            // duplicate ids stronger-wins.
            const response = await this.client.post(endpoint, JSON.stringify({ items }), {
                timeout: AI_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return response.data as RetagResponse;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Curator-only: re-tag up to `limit` stale songs (weaker/older model than the current strong one). Returns
    // { enriched, failed, remaining, strongModel } so the caller can loop until remaining hits 0.
    public async songRetagStale(limit: number): Promise<RetagStaleResponse> {
        const endpoint = `/api/v1/songs/retag-stale`;
        console.log(`[API] Calling endpoint: ${endpoint}?limit=${limit}`);
        try {
            const response = await this.client.post(endpoint, null, { params: { limit }, timeout: AI_TIMEOUT_MS });
            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }
            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return response.data as RetagStaleResponse;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async songGetList(songIds: string[]) {
        const endpoint = "/api/v1/songs/list";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const songIdsJson = JSON.stringify(songIds);
            const response = await this.client.post(endpoint, songIdsJson, {
                timeout: BULK_TIMEOUT_MS,
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return SongListResponseSchema.parse(response.data).songs;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    // Songs whose server-side Version is after `cursor`, one page at a time. Used to refresh already-synced songs in
    // place — e.g. after a song is replaced with better-quality audio. The cursor is sent exactly as given.
    public async songGetChanged(cursor: FeedCursor) {
        const endpoint = "/api/v1/songs/changed";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, {
                timeout: BULK_TIMEOUT_MS,
                params: {
                    afterDate: cursor.afterDate,
                    afterId: cursor.afterId
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            const page = ChangedSongPageSchema.parse(response.data);
            const keys = ChangedSongKeysSchema.parse(response.data).songs;
            return { items: page.songs, keys, endOfList: page.endOfList };
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }

    public async userGet() {
        const endpoint = "/api/v1/users/me";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint);

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            return UserResponseSchema.parse(response.data).user;
        } catch (error) {
            console.log(`[API] Endpoint ${endpoint} failed with error:`, error);
            throw error;
        }
    }
}

function isSuccessfulStatus(status: number) {
    return 200 <= status && status < 300;
}

// A request that fails without an answer (offline, timeout) rejects with an AxiosError that carries its request
// config: the Authorization header, and for login and sign-up the password hash in the body. Callers log these
// errors whole, so both are stripped before the error leaves the client.
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
