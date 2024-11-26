import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { ApiClient } from "../services/api/apiClient";
import { playlistTable, requestTable, songTable, userTable } from "../services/db/schema";
import { eq, inArray } from "drizzle-orm";
import * as DbExtensions from "../services/db/dbExtensions";
import * as DbModels from "../services/db/models";
import * as ApiModels from "../services/api/models";
import { distinctBy } from "./utils";
import { HttpStatusCode } from "axios";
import uuid from "react-native-uuid";
import { RequestType } from "../enums/requestType";
import { getProcessingMethod, ProcessingMethod } from "../enums/processingMethod";

export default class SyncManager {
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
            if (this.loggingOut) {
                this.dispose();
                return;
            }

            this.sync();
        }, 10000);

        this.sync();
    }

    async dispose() {
        clearInterval(this.timerId);
    }

    async sync() {
        if (this.syncing) {
            return;
        }
    
        this.syncing = true;

        try {
            const unorderedRequests = await this.db.select().from(requestTable);
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
            }

            let endedPrematurely = false;

            // Run all pushing requests
            for (const requestBatch of requestBatches) {
                const statusCode = await this.runRequests(requestBatch);

                if (statusCode == HttpStatusCode.Unauthorized) {
                    this.loggingOut = true;
                    return;
                } else if (200 <= statusCode && statusCode <= 299) {
                    // TODO: move this to dbextensions?
                    await this.db.delete(requestTable).where(inArray(requestTable.requestGuid, requestBatch.map(x => x.requestGuid)));
                } else if (400 <= statusCode && statusCode <= 499) {
                    // TODO: same as above
                    // TODO: I don't think this should always remove request
                    await this.db.delete(requestTable).where(inArray(requestTable.requestGuid, requestBatch.map(x => x.requestGuid)));
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
                requestGuid: uuid.v4(),
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
    
    async runRequests(requests: DbModels.Request[]) {
        const singleRequest = requests[0];
        const requestType = singleRequest.requestType as RequestType;
        let statusCode: HttpStatusCode;

        switch (requestType) {
            case RequestType.UpdateSongLastPlayed:
                statusCode = HttpStatusCode.Ok;
                break;
            case RequestType.OverallSync:
                statusCode = await this.overallSync();
                break;
            case RequestType.CreateUserSong:
                statusCode = HttpStatusCode.Ok;
                break;
            default:
                throw new Error("A request type has no method to call.");
        }

        return statusCode;
    }

    async overallSync(): Promise<HttpStatusCode> {
        try {
            this.db.transaction(async (tx) => {
                // Update user version
                const oldUser = await tx.select().from(userTable).where(eq(userTable.userId, this.userId));
                const user = await this.api.userGet();
                DbExtensions.updateUser(tx, user);

                // Refresh tags
                const tags = await this.api.tagGetAll();
                await DbExtensions.updateTags(tx, tags);
                
                // Refresh playlists
                const accessiblePlaylists = await this.api.playlistGetAll();
                const playlistsToFetch: number[] = [];
                let updatedPlaylists: ApiModels.Playlist[] = [];

                // Remove playlists from local if they are no longer accessible
                DbExtensions.removeOldPlaylists(tx, accessiblePlaylists.map(x => x.playlistId));

                // Create a list of playlists that need updating
                const localPlaylists = await DbExtensions.getPlaylists(tx, this.userId);

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
                            DbExtensions.updatePlaylist(tx, updatedPlaylist);
                            DbExtensions.updatePlaylistSongs(tx, updatedPlaylist.playlistId, updatedPlaylist.playlistSongs);
                        }
                    }
                }

                // Refresh user songs
                let afterDate: Date;
                let endOfList = false;
                const updatedUserSongs: ApiModels.UserSong[] = [];

                if (oldUser.length) {
                    afterDate = oldUser[0].version;
                } else {
                    afterDate = new Date("0000-01-01T00:00:00Z")
                }

                while (!endOfList) {
                    const paginatedResponse = await this.api.userSongGetAll(afterDate);

                    const userSongs = paginatedResponse.items;
                    DbExtensions.updateUserSongs(tx, userSongs);
                    updatedUserSongs.push(...userSongs);
                    endOfList = paginatedResponse.endOfList;

                    if (!endOfList) {
                        afterDate = userSongs[userSongs.length - 1].version;
                    }
                }

                // Combine UserSongs+PlaylistSongs and cross-verify which songs aren't on the local device
                const localSongIds = (await tx.select({ songId: songTable.songId }).from(songTable)).map(x => x.songId);
                const newSongIds = [
                    ...updatedPlaylists.flatMap(x => x.playlistSongs?.map(song => song.songId)).filter(x => x != undefined),
                    ...updatedUserSongs.map(x => x.songId)
                ]
                .filter((value, index, self) => self.indexOf(value) === index)
                .filter(songId => songId && !localSongIds.includes(songId));
                
                for (let i = 0; i * 500 < newSongIds.length; i++) {
                    const songIdsSubset = newSongIds.slice(i * 500, i * 500 + 500);
                    const newSongs = await this.api.songGetList(songIdsSubset);
                    
                    DbExtensions.updateSongs(tx, newSongs);

                    const songArtists = distinctBy(newSongs.flatMap(x => x.songArtists), x => x?.songArtistId).filter(x => x != null);
                    const artists = distinctBy(songArtists.flatMap(x => x.artist), x => x?.artistId).filter(x => x != null);
                    const songTags = distinctBy(newSongs.flatMap(x => x.songTags), x => x?.songTagId).filter(x => x != null);

                    if (songArtists.length) {
                        DbExtensions.updateSongArtists(tx, songArtists);
                    }

                    if (artists.length) {
                        DbExtensions.updateArtists(tx, artists);
                    }

                    if (songTags.length) {
                        DbExtensions.updateSongTags(tx, songTags);
                    }
                }
            }, {
                behavior: "exclusive"
            });

            return HttpStatusCode.Ok;
        } catch (e) {
            console.log(e);
            return HttpStatusCode.InternalServerError;
        }
    }
}