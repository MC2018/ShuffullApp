import axios, { AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema, Playlist, PlaylistListSchema, SongListSchema, Tag, TagListSchema, TagSchema, UserSongListSchema } from "./models";
import { ApiStatusFailureError } from "./errors";

export class ApiClient {
    client: AxiosInstance;

    constructor(url: string, token: string) {
        this.client = axios.create({
            baseURL: url,
            timeout: 3000000
        });
        this.updateAuthHeader(token);
    }

    public updateAuthHeader(token: string) {
        this.client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    }

    public async userAuthenticate(username: string, userHash: string): Promise<AuthenticateResponse> {
        const endpoint = "/user/authenticate";
        const response = await this.client.post(`${endpoint}?username=${username}&userHash=${userHash}`);

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }

        return AuthenticateResponseSchema.parse(response.data);
    }

    public async tagGetAll(): Promise<Tag[]> {
        const endpoint = "/tag/getall";
        const response = await this.client.get(endpoint);

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }
        
        return TagListSchema.parse(response.data);
    }

    public async playlistGetAll() {
        const endpoint = "/playlist/getall";
        const response = await this.client.get(endpoint);

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }
        
        return PlaylistListSchema.parse(response.data);
    }

    public async playlistGetList(playlistIds: number[]): Promise<Playlist[]> {
        const endpoint = "/playlist/getlist";
        const playlistIdsJson = `[${playlistIds.join(",")}]`;
        const response = await this.client.post(endpoint, playlistIdsJson, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }

        return PlaylistListSchema.parse(response.data);
    }

    public async userSongGetAll() {
        const endpoint = "/usersong/getall";
        const response = await this.client.get(endpoint);

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }

        return UserSongListSchema.parse(response.data);
    }

    public async songGetList(songIds: number[]) {
        const endpoint = "/song/getlist";
        const songIdsJson = `[${songIds.join(",")}]`;
        const response = await this.client.post(endpoint, songIdsJson, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!isSuccessfulStatus(response.status)) {
            throw new ApiStatusFailureError(endpoint, response);
        }

        return SongListSchema.parse(response.data);
    }
}

function isSuccessfulStatus(status: number) {
    return 200 <= status && status < 300;
}