import { ApiClient } from "@/app/services/api/ApiClient";
import DbQueries from "@/app/services/db/queries";
import * as DbModels from "@/app/services/db/models";
import * as ApiModels from "@/app/services/api/models";
import { deterministicId, distinctBy, generateId } from "@/app/tools";
import { HttpStatusCode } from "axios";
import { RequestType, getProcessingMethod, ProcessingMethod } from "@/app/enums";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import { GenericDb } from "@/app/services/db/GenericDb";

export class SyncManager {
    db: GenericDb;
    api: ApiClient;
    userId: string;
    timerId: NodeJS.Timeout;
    syncing = false;
    logout: () => Promise<void>;
    
    constructor(db: GenericDb, api: ApiClient, userId: string, logout: () => Promise<void>) {
        this.db = db;
        this.api = api;
        this.userId = userId;
        this.logout = logout;
        this.timerId = setInterval(async () => {
            this.sync();
        }, 10000);

        this.sync();
    }

    async dispose() {
        clearInterval(this.timerId);
    }

    async submitRequests(requests: DbModels.Request[]) {
        try {
            await DbQueries.addRequests(this.db, requests);
        } catch (e) {
            console.log(e);
        }
    }

    private async sync() {
        if (this.syncing) {
            return;
        }
    
        this.syncing = true;

        try {
            const unorderedRequests = await DbQueries.getRequests(this.db);
            const requestBatches: DbModels.Request[][] = [];
            const onlyOnceRequests: RequestType[] = [];
            let lastRequestType: RequestType | null = null;

            for (const request of unorderedRequests) {
                const requestType = request.requestType as RequestType;
                const processingMethod = getProcessingMethod(requestType);

                switch (processingMethod) {
                    case ProcessingMethod.OnlyOnce:
                        if (onlyOnceRequests.includes(requestType)) {
                            continue;
                        }
    
                        requestBatches.push([request]);
                        onlyOnceRequests.push(requestType);
                        break;
                    case ProcessingMethod.Individual:
                        requestBatches.push([request]);
                        break;
                    case ProcessingMethod.Batch:
                        if (requestType != lastRequestType) {
                            requestBatches.push([request]);
                        } else {
                            requestBatches[requestBatches.length - 1].push(request);
                        }
                    case ProcessingMethod.None:
                    default:
                        break;
                }

                lastRequestType = request.requestType;
            }

            let endedPrematurely = false;

            // Run all pushing requests
            for (const requestBatch of requestBatches) {
                const statusCode = await this.runRequests(requestBatch);

                if (statusCode == HttpStatusCode.Unauthorized) {
                    await this.logout();
                    return;
                } else if (200 <= statusCode && statusCode <= 299) {
                    // TODO: move this to DbQueries?
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestId));
                } else if (400 <= statusCode && statusCode <= 499) {
                    // TODO: same as above
                    // TODO: I don't think this should always remove request
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestId));
                    break;
                } else if (500 <= statusCode) {
                    console.log(`Cannot access server. Status code: ${statusCode}`);
                    endedPrematurely = true;
                    return;
                }

                if (endedPrematurely) {
                    return;
                }
            }

            // Run all pulling changes
            const overallSyncRequest: DbModels.OverallSyncRequest = {
                requestId: generateId(),
                timeRequested: new Date(Date.now()),
                requestType: RequestType.OverallSync,
                userId: this.userId
            };
            const list = [overallSyncRequest];
            await this.runRequests(list);
        } catch (e) {
            console.log(e);
            throw e;
        } finally {
            this.syncing = false;
        }
    }
    
    private async runRequests(requests: DbModels.Request[]) {
        const singleRequest = requests[0];
        const requestType = singleRequest.requestType as RequestType;
        let statusCode: HttpStatusCode;

        switch (requestType) {
            case RequestType.UpdateSongLastPlayed:
                statusCode = await this.updateSongLastPlayed(requests as DbModels.UpdateSongLastPlayedRequest[]);
                break;
            case RequestType.OverallSync:
                statusCode = await this.overallSync();
                break;
            case RequestType.CreateUserSong:
                statusCode = await this.createUserSong(requests as DbModels.CreateUserSongRequest[]);
                break;
            default:
                throw new Error("A request type has no method to call.");
        }

        return statusCode;
    }

    private async updateSongLastPlayed(requests: DbModels.UpdateSongLastPlayedRequest[]) {
        try {
            await this.api.userSongUpdateLastPlayed(requests);
            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof ApiStatusFailureError) {
                return e.status;
            }

            return HttpStatusCode.InternalServerError;
        }
    }

    private async createUserSong(requests: DbModels.CreateUserSongRequest[]): Promise<HttpStatusCode> {
        try {
            const songIds = requests.map(x => x.songId);
            await this.api.userSongCreateMany(songIds);
            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof ApiStatusFailureError) {
                return e.status;
            }

            return HttpStatusCode.InternalServerError;
        }
    }

    private async overallSync(): Promise<HttpStatusCode> {
        try {
            this.db.transaction(async (tx) => {
                // Update user version
                const oldUser = await DbQueries.getUser(tx, this.userId);
                const user = await this.api.userGet();
                await DbQueries.updateUser(tx, user);

                // Refresh tags
                const tags = await this.api.tagGetAll();
                await DbQueries.updateTags(tx, tags);

                // Refresh playlists
                const accessiblePlaylists = await this.api.playlistGetAll();
                const playlistsToFetch: string[] = [];
                let updatedPlaylists: ApiModels.Playlist[] = [];

                // Remove playlists from local if they are no longer accessible
                await DbQueries.removeOldPlaylists(tx, accessiblePlaylists.map(x => x.playlistId));

                // Create a list of playlists that need updating
                const localPlaylists = await DbQueries.getPlaylists(tx, this.userId);

                for (const accessiblePlaylist of accessiblePlaylists) {
                    const localPlaylist = localPlaylists.filter(x => x.playlistId == accessiblePlaylist.playlistId);
                    
                    if (!localPlaylist.length || localPlaylist[0].version < accessiblePlaylist.version) {
                        playlistsToFetch.push(accessiblePlaylist.playlistId);
                    }
                }
                if (playlistsToFetch.length) {
                    updatedPlaylists = await this.api.playlistGetList(playlistsToFetch);

                    for (const updatedPlaylist of updatedPlaylists) {
                        await DbQueries.updatePlaylist(tx, updatedPlaylist);

                        // The API now returns membership as a flat songIds list; rebuild the local
                        // playlist_song join rows from it with stable, content-derived IDs.
                        const playlistSongs: DbModels.PlaylistSong[] = updatedPlaylist.songIds.map(songId => ({
                            playlistSongId: deterministicId("playlist-song", updatedPlaylist.playlistId, songId),
                            playlistId: updatedPlaylist.playlistId,
                            songId
                        }));
                        await DbQueries.updatePlaylistSongs(tx, updatedPlaylist.playlistId, playlistSongs);
                    }
                }

                // Refresh user songs
                let afterDate: Date;
                let endOfList = false;
                const updatedUserSongs: ApiModels.UserSong[] = [];

                if (oldUser != undefined) {
                    afterDate = oldUser.version;
                } else {
                    afterDate = new Date("0000-01-01T00:00:00Z")
                }

                while (!endOfList) {
                    const paginatedResponse = await this.api.userSongGetAll(afterDate);

                    const userSongs = paginatedResponse.items;
                    await DbQueries.updateUserSongs(tx, userSongs);
                    updatedUserSongs.push(...userSongs);
                    endOfList = paginatedResponse.endOfList;

                    if (!endOfList) {
                        afterDate = userSongs[userSongs.length - 1].version;
                    }
                }

                // Combine UserSongs+PlaylistSongs and cross-verify which songs aren't on the local device
                const localSongIds = await DbQueries.getAllSongIds(tx);
                const newSongIds = [
                    ...updatedPlaylists.flatMap(x => x.songIds),
                    ...updatedUserSongs.map(x => x.songId)
                ]
                .filter((value, index, self) => self.indexOf(value) === index)
                .filter(songId => songId && !localSongIds.includes(songId));

                // The API returns songs denormalized (artists/tags are plain name strings with no
                // IDs). Re-normalize them into the local artist/tag/join tables: synthesize a stable
                // artist ID from the name, and map tag names back onto local tag IDs (tags were just
                // refreshed above). Join-row IDs are content-derived so re-syncing stays idempotent.
                const localTags = await DbQueries.getTags(tx);
                const tagIdByName = new Map(localTags.map(tag => [tag.name, tag.tagId]));

                for (let i = 0; i * 500 < newSongIds.length; i++) {
                    const songIdsSubset = newSongIds.slice(i * 500, i * 500 + 500);
                    const newSongs = await this.api.songGetList(songIdsSubset);

                    await DbQueries.updateSongs(tx, newSongs);

                    const artists: DbModels.Artist[] = [];
                    const songArtists: DbModels.SongArtist[] = [];
                    const songTags: DbModels.SongTag[] = [];

                    for (const song of newSongs) {
                        for (const artistName of song.artists) {
                            const artistId = deterministicId("artist", artistName);
                            artists.push({ artistId, name: artistName });
                            songArtists.push({
                                songArtistId: deterministicId("song-artist", song.songId, artistId),
                                songId: song.songId,
                                artistId
                            });
                        }

                        for (const tagName of song.tags) {
                            const tagId = tagIdByName.get(tagName);

                            // Skip tag names the local tag list doesn't know about (e.g. a tag added
                            // server-side since the tag refresh); it'll link on the next full sync.
                            if (tagId == null) {
                                continue;
                            }

                            songTags.push({
                                songTagId: deterministicId("song-tag", song.songId, tagId),
                                songId: song.songId,
                                tagId
                            });
                        }
                    }

                    // Insert artists before the join rows that reference them.
                    const distinctArtists = distinctBy(artists, x => x.artistId);
                    const distinctSongArtists = distinctBy(songArtists, x => x.songArtistId);
                    const distinctSongTags = distinctBy(songTags, x => x.songTagId);

                    if (distinctArtists.length) {
                        await DbQueries.updateArtists(tx, distinctArtists);
                    }

                    if (distinctSongArtists.length) {
                        await DbQueries.updateSongArtists(tx, distinctSongArtists);
                    }

                    if (distinctSongTags.length) {
                        await DbQueries.updateSongTags(tx, distinctSongTags);
                    }
                }
            }, {
                behavior: "exclusive"
            });

            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof ApiStatusFailureError) {
                return e.status;
            }

            return HttpStatusCode.InternalServerError;
        }
    }
}