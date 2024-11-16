import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { ApiClient } from "../services/api/apiClient";
import { artistTable, localSessionDataTable, playlistTable, songTable, userTable } from "../services/db/schema";
import { eq } from "drizzle-orm";
import * as DbExtensions from "../services/db/dbExtensions";
import * as DbModels from "../services/db/models";
import * as ApiModels from "../services/api/models";

export default class SyncManager {
    db: ExpoSQLiteDatabase;
    api: ApiClient;
    timerId: NodeJS.Timeout;
    userId: number;
    syncing = false;
    
    constructor(db: ExpoSQLiteDatabase, api: ApiClient, userId: number) {
        this.db = db;
        this.api = api;
        this.timerId = setInterval(async () => this.sync(), 10000);
        this.userId = userId;

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
            await this.overallSync();
        } catch (e) {
            console.log(e);
            throw e;
        } finally {
            this.syncing = false;
        }
    }
    
    // Not all tables are implemented yet (eg. artist sync)
    async overallSync() {
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
                const localPlaylists = await tx.select().from(playlistTable);

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
                //const existingArtistIds = new Set((await tx.select().from(artistTable)).map(x => x.artistId));
                
                for (let i = 0; i * 500 < newSongIds.length; i++) {
                    const songIdsSubset = newSongIds.slice(i * 500, i * 500 + 500);
                    const newSongs = await this.api.songGetList(songIdsSubset);
                    
                    await tx.insert(songTable).values(newSongs);
                }
            }, {
                behavior: "exclusive"
            });
        } catch (e) {
            console.log(e);
            throw e;
        }
    }
}