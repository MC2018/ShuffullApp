import { ApiClient } from "@/app/services/api/ApiClient";
import DbQueries from "@/app/services/db/queries";
import * as DbModels from "@/app/services/db/models";
import * as ApiModels from "@/app/services/api/models";
import { deterministicId, distinctBy, generateId } from "@/app/tools";
import { HttpStatusCode } from "axios";
import { RequestType, getProcessingMethod, ProcessingMethod } from "@/app/enums";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import { GenericDb } from "@/app/services/db/GenericDb";
import { Downloader } from "@/app/services/downloader/Downloader";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { advanceSongCursor, collectNewSongIds, playlistsToFetch } from "@/app/services/sync-manager/syncLogic";

export class SyncManager {
    db: GenericDb;
    api: ApiClient;
    userId: string;
    timerId: ReturnType<typeof setInterval>;
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
                        break;
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
                    // Client error: retrying won't help, so drop just this batch — but keep processing the
                    // rest of the queue instead of stalling everything behind it. (A dead-letter store that
                    // records a reason would be the next step so these aren't silently lost.)
                    console.warn(`Dropping request batch after ${statusCode} (type ${requestBatch[0]?.requestType}).`);
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestId));
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
            case RequestType.SetSongLikeStatus:
                statusCode = await this.setSongLikeStatus(requests as DbModels.SetSongLikeStatusRequest[]);
                break;
            case RequestType.FlagSongForReplacement:
                statusCode = await this.flagSongForReplacement(requests as DbModels.FlagSongForReplacementRequest[]);
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

    private async setSongLikeStatus(requests: DbModels.SetSongLikeStatusRequest[]): Promise<HttpStatusCode> {
        try {
            // Processed individually, so each batch is a single song; loop defensively all the same.
            for (const request of requests) {
                await this.api.userSongSetLikeStatus(request.songId, request.likeStatus);
            }
            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof ApiStatusFailureError) {
                return e.status;
            }

            return HttpStatusCode.InternalServerError;
        }
    }

    private async flagSongForReplacement(requests: DbModels.FlagSongForReplacementRequest[]): Promise<HttpStatusCode> {
        try {
            // Batched: one idempotent POST per flagged song (server skips songs already queued).
            for (const request of requests) {
                await this.api.flagSongForReplacement(request.songId);
            }
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
            // ── Phase 1: read local state + fetch over the network (NO write transaction held) ──
            // Keeping network I/O out of the DB transaction is the point: an exclusive SQLite lock held
            // across slow/flaky round-trips would block playback, the progress writer, and downloads.
            const syncStartTime = new Date();
            const oldUser = await DbQueries.getUser(this.db, this.userId);
            const user = await this.api.userGet();
            const tags = await this.api.tagGetAll();
            const accessiblePlaylists = await this.api.playlistGetAll();

            // Decide which playlists changed (local read) and fetch just those.
            const localPlaylists = await DbQueries.getPlaylists(this.db, this.userId);
            const playlistIdsToFetch = playlistsToFetch(accessiblePlaylists, localPlaylists);
            const updatedPlaylists: ApiModels.Playlist[] = playlistIdsToFetch.length
                ? await this.api.playlistGetList(playlistIdsToFetch)
                : [];

            // User songs changed since our last known user version (incremental, paginated).
            // Year 0001, not 0000: the API binds afterDate to a .NET DateTime whose minimum is 0001-01-01,
            // so a year-0000 sentinel fails model binding (400) on a first/cleared sync.
            let afterDate: Date = oldUser != undefined ? oldUser.version : new Date("0001-01-01T00:00:00Z");
            let endOfList = false;
            const updatedUserSongs: ApiModels.UserSong[] = [];
            while (!endOfList) {
                const paginatedResponse = await this.api.userSongGetAll(afterDate);
                updatedUserSongs.push(...paginatedResponse.items);
                endOfList = paginatedResponse.endOfList;
                if (!endOfList && paginatedResponse.items.length) {
                    afterDate = paginatedResponse.items[paginatedResponse.items.length - 1].version;
                }
            }

            // Songs referenced by the updated playlists/user-songs that we don't have locally yet.
            const localSongIds = await DbQueries.getAllSongIds(this.db);
            const newSongIds = collectNewSongIds(
                updatedPlaylists.map(x => x.songIds),
                updatedUserSongs.map(x => x.songId),
                localSongIds
            );

            const songBatches: ApiModels.Song[][] = [];
            for (let i = 0; i * 500 < newSongIds.length; i++) {
                songBatches.push(await this.api.songGetList(newSongIds.slice(i * 500, i * 500 + 500)));
            }

            // ── Incremental refresh of songs we ALREADY hold whose server Version changed since last sync
            // (e.g. a song re-sourced in place with better audio). The very first sync seeds the cursor at
            // "now" and skips: the fetch above already pulled current data, and paging the whole library back
            // through the changes feed would be wasteful. ──
            const songCursorRaw = await AsyncStorage.getItem(STORAGE_KEYS.SONG_SYNC_CURSOR);
            let nextSongCursor: Date = songCursorRaw != null ? new Date(songCursorRaw) : syncStartTime;
            const changedLocalSongs: ApiModels.ChangedSong[] = [];
            if (songCursorRaw != null) {
                const localSongIdSet = new Set(localSongIds);
                let songAfterDate = new Date(songCursorRaw);
                let songEndOfList = false;
                while (!songEndOfList) {
                    const page = await this.api.songGetChanged(songAfterDate);
                    for (const changed of page.items) {
                        // Only refresh songs we hold locally; brand-new ones are handled by the fetch above.
                        if (localSongIdSet.has(changed.songId)) {
                            changedLocalSongs.push(changed);
                        }
                    }
                    songEndOfList = page.endOfList;
                    if (page.items.length) {
                        // Cursor advances by the newest Version on the page (across ALL changed songs, not just
                        // the local ones), so we never re-page changes we've already accounted for.
                        songAfterDate = advanceSongCursor(page.items, songAfterDate);
                        nextSongCursor = songAfterDate;
                    }
                }
            }

            // Of those, find the songs whose audio (fileHash) actually changed: their local files are now
            // orphaned and any "downloaded" flag is stale. Read the OLD records BEFORE the write below
            // overwrites them, so the now-orphaned file paths can be computed afterwards.
            const staleSongs: DbModels.Song[] = [];
            for (const changed of changedLocalSongs) {
                const oldSong = await DbQueries.getSong(this.db, changed.songId);
                if (oldSong != undefined && oldSong.fileHash !== changed.fileHash) {
                    staleSongs.push(oldSong);
                }
            }
            const changedSongIds = changedLocalSongs.map(x => x.songId);
            const staleSongIds = staleSongs.map(x => x.songId);

            // Refresh the changed songs through the same upsert path as new songs (updateSongs overwrites the
            // row; the join rebuild below re-links artists/tags). Their stale joins are cleared in the txn.
            if (changedLocalSongs.length) {
                songBatches.push(changedLocalSongs);
            }

            // The API returns songs denormalized (artists/tags are plain name strings); map tag names onto
            // tag IDs from the freshly-fetched tag list. Join-row IDs are content-derived (idempotent re-sync).
            const tagIdByName = new Map(tags.map(tag => [tag.name, tag.tagId]));

            // ── Phase 2: apply every write in a single short transaction (NO network inside) ──
            await this.db.transaction(async (tx) => {
                await DbQueries.updateUser(tx, user);
                await DbQueries.updateTags(tx, tags);

                await DbQueries.removeOldPlaylists(tx, accessiblePlaylists.map(x => x.playlistId));
                for (const updatedPlaylist of updatedPlaylists) {
                    await DbQueries.updatePlaylist(tx, updatedPlaylist);

                    const playlistSongs: DbModels.PlaylistSong[] = updatedPlaylist.songIds.map(songId => ({
                        playlistSongId: deterministicId("playlist-song", updatedPlaylist.playlistId, songId),
                        playlistId: updatedPlaylist.playlistId,
                        songId
                    }));
                    await DbQueries.updatePlaylistSongs(tx, updatedPlaylist.playlistId, playlistSongs);
                }

                await DbQueries.updateUserSongs(tx, updatedUserSongs);

                // Changed songs already have artist/tag joins; clear them so a changed set doesn't leave
                // stale links behind (the batch loop rebuilds them via insert-or-ignore). New songs have none.
                await DbQueries.deleteSongArtistsAndTags(tx, changedSongIds);

                for (const newSongs of songBatches) {
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

                            // Skip tag names the local tag list doesn't know about; links on a later sync.
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

                // Replaced songs' local audio no longer matches the new fileHash: drop the downloaded flag so
                // the user can re-download the new version (the orphaned files are removed after the txn).
                await DbQueries.removeDownloadedSongs(tx, staleSongIds);
            }, {
                behavior: "exclusive"
            });

            // Post-commit, outside the write txn: delete the now-orphaned local files (file I/O) and advance
            // the song-sync cursor. Both run only after the writes committed — a thrown sync leaves the cursor
            // untouched, so the same changes are retried next time.
            for (const staleSong of staleSongs) {
                await Downloader.deleteLocalSongFiles(staleSong);
            }
            await AsyncStorage.setItem(STORAGE_KEYS.SONG_SYNC_CURSOR, nextSongCursor.toISOString());

            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof ApiStatusFailureError) {
                return e.status;
            }

            return HttpStatusCode.InternalServerError;
        }
    }
}