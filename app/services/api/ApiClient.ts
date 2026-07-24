import axios, { AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema, ChangedSongPageSchema, CreatePlaylistResponseSchema, Playlist, PlaylistListResponseSchema, RetagResponse, RetagStaleResponse, SongListResponseSchema, SongRetagWireItem, Tag, TagListResponseSchema, UserResponseSchema, UserSongPageSchema } from "./models";
import { ApiStatusFailureError } from "./errors";
import { UpdateSongLastPlayedRequest, UpdateSongMetadataPayload } from "../db/models";

export class ApiClient {
    private client: AxiosInstance;
    private url: string;

    constructor(url: string, token: string) {
        this.client = axios.create({
            baseURL: url,
            timeout: 3000
        });
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
            const response = await this.client.post(`${endpoint}?username=${username}&userHash=${userHash}`);

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
            const response = await this.client.post(`${endpoint}?username=${username}&userHash=${userHash}`);

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
            const response = await this.client.get(endpoint);

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
            const response = await this.client.get(endpoint);

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

    public async userSongGetAll(afterDate: Date) {
        const endpoint = "/api/v1/user-songs";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, {
                params: {
                    afterDate: afterDate.toISOString()
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            // Keep the { items, endOfList } shape SyncManager consumes; the API key is `userSongs`.
            const page = UserSongPageSchema.parse(response.data);
            return { items: page.userSongs, endOfList: page.endOfList };
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
            const response = await this.client.post(endpoint, null, { params: { limit } });
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

    // Songs whose server-side Version is newer than `afterDate` (exclusive), one page at a time. Used to
    // refresh already-synced songs in place — e.g. after a song is replaced with better-quality audio.
    public async songGetChanged(afterDate: Date) {
        const endpoint = "/api/v1/songs/changed";
        console.log(`[API] Calling endpoint: ${endpoint}`);
        try {
            const response = await this.client.get(endpoint, {
                params: {
                    afterDate: afterDate.toISOString()
                }
            });

            if (!isSuccessfulStatus(response.status)) {
                console.log(`[API] Endpoint ${endpoint} failed with status: ${response.status}`);
                throw new ApiStatusFailureError(endpoint, response);
            }

            console.log(`[API] Endpoint ${endpoint} succeeded`);
            const page = ChangedSongPageSchema.parse(response.data);
            return { items: page.songs, endOfList: page.endOfList };
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