import axios, { AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema, Playlist, PlaylistListResponseSchema, SongListResponseSchema, Tag, TagListResponseSchema, UserResponseSchema, UserSongPageSchema } from "./models";
import { ApiStatusFailureError } from "./errors";
import { UpdateSongLastPlayedRequest } from "../db/models";

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