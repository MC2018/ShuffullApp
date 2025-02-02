import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { ApiClient } from "../services/api/apiClient";
import { playlistTable, requestTable, songTable, userTable } from "../services/db/schema";
import { eq, inArray } from "drizzle-orm";
import * as DbQueries from "../services/db/queries";
import * as DbModels from "../services/db/models";
import * as ApiModels from "../services/api/models";
import { distinctBy, generateGuid } from "./utils";
import { HttpStatusCode } from "axios";
import { RequestType } from "../enums";
import { getProcessingMethod, ProcessingMethod } from "../enums";
import { ApiStatusFailureError } from "../services/api/errors";

let activeUuid: string | undefined = undefined;

export default class SyncManager {
    uuid = generateGuid();
    db: ExpoSQLiteDatabase;
    api: ApiClient;
    userId: number;
    timerId: NodeJS.Timeout;
    loggingOut = false;
    syncing = false;
    
    constructor(db: ExpoSQLiteDatabase, api: ApiClient, userId: number) {
        this.db = db;
        this.api = api;
        this.userId = userId;
        this.timerId = setInterval(async () => {
            if (activeUuid != this.uuid) {
                this.dispose();
                return;
            }

            this.sync();
        }, 10000);

        activeUuid = this.uuid;

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
                    this.loggingOut = true;
                    return;
                } else if (200 <= statusCode && statusCode <= 299) {
                    // TODO: move this to DbQueries?
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestGuid));
                } else if (400 <= statusCode && statusCode <= 499) {
                    // TODO: same as above
                    // TODO: I don't think this should always remove request
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestGuid));
                    break;
                } else if (500 <= statusCode) {
                    console.log("Cannot access server.");
                    endedPrematurely = true;
                    return;
                }

                if (endedPrematurely) {
                    return;
                }
            }

            // Run all pulling changes
            const overallSyncRequest: DbModels.OverallSyncRequest = {
                requestGuid: generateGuid(),
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
                const playlistsToFetch: number[] = [];
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
                        if (updatedPlaylist.playlistSongs != null) {
                            await DbQueries.updatePlaylist(tx, updatedPlaylist);
                            await DbQueries.updatePlaylistSongs(tx, updatedPlaylist.playlistId, updatedPlaylist.playlistSongs);
                        }
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
                    ...updatedPlaylists.flatMap(x => x.playlistSongs?.map(song => song.songId)).filter(x => x != undefined),
                    ...updatedUserSongs.map(x => x.songId)
                ]
                .filter((value, index, self) => self.indexOf(value) === index)
                .filter(songId => songId && !localSongIds.includes(songId));
                
                for (let i = 0; i * 500 < newSongIds.length; i++) {
                    const songIdsSubset = newSongIds.slice(i * 500, i * 500 + 500);
                    const newSongs = await this.api.songGetList(songIdsSubset);
                    
                    await DbQueries.updateSongs(tx, newSongs);

                    const songArtists = distinctBy(newSongs.flatMap(x => x.songArtists), x => x?.songArtistId).filter(x => x != null);
                    const artists = distinctBy(songArtists.flatMap(x => x.artist), x => x?.artistId).filter(x => x != null);
                    const songTags = distinctBy(newSongs.flatMap(x => x.songTags), x => x?.songTagId).filter(x => x != null);

                    if (songArtists.length) {
                        await DbQueries.updateSongArtists(tx, songArtists);
                    }

                    if (artists.length) {
                        await DbQueries.updateArtists(tx, artists);
                    }

                    if (songTags.length) {
                        await DbQueries.updateSongTags(tx, songTags);
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