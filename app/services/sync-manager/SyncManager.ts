import { ApiClient } from "@/app/services/api/ApiClient";
import DbQueries from "@/app/services/db/queries";
import * as DbModels from "@/app/services/db/models";
import * as ApiModels from "@/app/services/api/models";
import { deterministicId, distinctBy, distinctByLast, generateId } from "@/app/tools";
import axios, { HttpStatusCode } from "axios";
import { RequestType } from "@/app/enums";
import { ApiStatusFailureError, statusOfFailure } from "@/app/services/api/errors";
import { GenericDb } from "@/app/services/db/GenericDb";
import { Downloader } from "@/app/services/downloader/Downloader";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { advanceSongCursor, collectNewSongIds, failedKeeps, groupRequestsIntoBatches, partitionRejectedRequests, playlistDeleteHold, playlistsToFetch, summarizeRetagFailures, toRetagItems, withoutPendingDeletes } from "@/app/services/sync-manager/syncLogic";

/** What one outbox batch came back with: the status sync() acts on, and the error text when it failed. */
interface RunResult {
    statusCode: number;
    reason?: string;
}

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
            const requestBatches = groupRequestsIntoBatches(unorderedRequests);

            let endedPrematurely = false;

            // Run all pushing requests
            for (const requestBatch of requestBatches) {
                if (requestBatch[0]?.requestType == RequestType.DeletePlaylist) {
                    // Read fresh: a Keep sent earlier in this flush may have just been recorded or dead-lettered.
                    const hold = playlistDeleteHold(
                        await DbQueries.getRequests(this.db),
                        await DbQueries.getDeadLetterRequests(this.db));
                    if (hold) {
                        console.warn(`[sync] Holding playlist delete ${requestBatch[0].playlistId}: ${hold}.`);
                        continue;
                    }
                }

                const { statusCode, reason } = await this.runRequests(requestBatch);

                if (statusCode == HttpStatusCode.Unauthorized) {
                    await this.logout();
                    return;
                } else if (200 <= statusCode && statusCode <= 299) {
                    // TODO: move this to DbQueries?
                    await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestId));
                } else if (400 <= statusCode && statusCode <= 499) {
                    // Client error: replaying the same payload usually won't fix it — but deleting the rows
                    // outright is how queued work used to vanish with nothing logged. Keep them for a bounded
                    // window so a transient cause (a stale token, a server-side fix) recovers by itself, then
                    // move them to the dead-letter table with the reason. Either way, say so out loud.
                    const { abandon, keep } = partitionRejectedRequests(requestBatch, new Date());
                    console.warn(
                        `[sync] ${statusCode} on ${requestBatch.length} request(s) of type ` +
                        `${requestBatch[0]?.requestType}: retaining ${keep.length} for retry, ` +
                        `dead-lettering ${abandon.length} past the retry window. ${reason ?? ""}`);
                    await DbQueries.deadLetterRequests(this.db, abandon.map(request => ({
                        request,
                        reason: `Rejected with ${statusCode} for longer than the retry window. ${reason ?? ""}`.trim(),
                    })));
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
    
    private async runRequests(requests: DbModels.Request[]): Promise<RunResult> {
        const singleRequest = requests[0];
        const requestType = singleRequest.requestType as RequestType;

        switch (requestType) {
            case RequestType.UpdateSongLastPlayed:
                return await this.attempt(() => this.api.userSongUpdateLastPlayed(requests as DbModels.UpdateSongLastPlayedRequest[]));
            case RequestType.OverallSync:
                return { statusCode: await this.overallSync() };
            case RequestType.CreateUserSong:
                return await this.attempt(() => this.api.userSongCreateMany((requests as DbModels.CreateUserSongRequest[]).map(x => x.songId)));
            case RequestType.SetSongLikeStatus:
                // Processed individually, so each batch is a single song; loop defensively all the same.
                return await this.attempt(async () => {
                    for (const request of requests as DbModels.SetSongLikeStatusRequest[]) {
                        await this.api.userSongSetLikeStatus(request.songId, request.likeStatus);
                    }
                });
            case RequestType.FlagSongForReplacement:
                // Batched: one idempotent POST per flagged song (server skips songs already queued).
                return await this.attempt(async () => {
                    for (const request of requests as DbModels.FlagSongForReplacementRequest[]) {
                        await this.api.flagSongForReplacement(request.songId);
                    }
                });
            case RequestType.UpdateSongMetadata:
                // Processed individually, so each batch is a single song; loop defensively all the same.
                return await this.attempt(async () => {
                    for (const request of requests as DbModels.UpdateSongMetadataRequest[]) {
                        await this.api.songUpdate(request.songId, request.payload);
                    }
                });
            case RequestType.SongRetag:
                return await this.attempt(() => this.keepAndRetag(requests as DbModels.SongRetagRequest[]));
            case RequestType.DeletePlaylist:
                // Processed individually, so each batch is a single playlist; loop defensively all the same. The
                // local rows were already removed optimistically when the user deleted; this just tells the server
                // (which also purges the un-kept audition songs). sync() holds these while any Keep is unrecorded.
                return await this.attempt(async () => {
                    for (const request of requests as DbModels.DeletePlaylistRequest[]) {
                        await this.api.playlistDelete(request.playlistId);
                    }
                });
            default:
                throw new Error("A request type has no method to call.");
        }
    }

    // Runs one batch's calls and reports the status sync() acts on, plus the error text for the log and any
    // dead-letter row. statusOfFailure is the one place a thrown error becomes a status.
    private async attempt(send: () => Promise<unknown>): Promise<RunResult> {
        try {
            await send();
            return { statusCode: HttpStatusCode.Ok };
        } catch (e) {
            return { statusCode: statusOfFailure(e), reason: e instanceof Error ? e.message : String(e) };
        }
    }

    // A queued SongRetag row is a Keep (weak) or a like-promotion (strong). Either way the user's decision is
    // recorded FIRST, through /songs/keep, which any user may call and which runs no AI. Only then, and only for a
    // curator, is re-tagging attempted. /retag is curator-only, so routing a non-curator's Keep through it is
    // what left their Keeps unrecorded and their songs purgeable.
    private async keepAndRetag(requests: DbModels.SongRetagRequest[]): Promise<void> {
        const songIds = [...new Set(requests.map(x => x.songId).filter(Boolean))];
        const response = songIds.length ? await this.api.songKeep(songIds) : undefined;

        // A 200 only means the POST landed; the per-item outcomes say whether each Keep was recorded. A song the
        // server didn't keep is dead-lettered with its reason. Deleting it would be another silent loss, and
        // retrying it would replay a verdict on the song, not a transient fault.
        const failures = failedKeeps(requests, response?.results);
        if (failures.length) {
            console.warn(
                `[sync] ${failures.length}/${requests.length} keep(s) not recorded, dead-lettered: ` +
                `${[...new Set(failures.map(x => x.reason))].join("; ")}`);
            await DbQueries.deadLetterRequests(this.db, failures);
        }

        const user = await DbQueries.getUser(this.db, this.userId);
        if (!user?.isCurator) {
            return;
        }

        const failed = new Set(failures.map(x => x.request.requestId));
        const items = toRetagItems(requests.filter(x => !failed.has(x.requestId)));
        if (!items.length) {
            return;
        }

        // Enrichment is optional: the Keeps above are already durable, so a failure here costs tags, never the
        // decision, and it must not keep these rows queued. The songs stay findable server-side (they match the
        // stale-song query), but nothing drains that query automatically today, so these warnings are the only
        // signal that tags are owed.
        try {
            const retag = await this.api.songRetag(items);
            const { songIds: notEnriched, reasons } = summarizeRetagFailures(retag?.results);
            if (notEnriched.length) {
                console.warn(
                    `[sync] ${notEnriched.length}/${items.length} re-tag(s) did not enrich: ` +
                    `${reasons.join("; ")}`);
            }
        } catch (e) {
            console.warn(`[sync] Re-tag after keep failed with ${statusOfFailure(e)}; the keeps are recorded.`, e);
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
            // A playlist deleted here but not yet deleted on the server (queued, or held behind a Keep) stays gone.
            const accessiblePlaylists = withoutPendingDeletes(
                await this.api.playlistGetAll(),
                await DbQueries.getRequests(this.db));

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
            const fetchedUserSongs: ApiModels.UserSong[] = [];
            while (!endOfList) {
                const paginatedResponse = await this.api.userSongGetAll(afterDate);
                fetchedUserSongs.push(...paginatedResponse.items);
                endOfList = paginatedResponse.endOfList;
                if (!endOfList && paginatedResponse.items.length) {
                    afterDate = paginatedResponse.items[paginatedResponse.items.length - 1].version;
                }
            }

            // Consecutive pages OVERLAP by design, so the concatenation above can hold the same user song
            // twice. The server pages on `Version > afterDate` using a .NET DateTime (100-nanosecond ticks),
            // but the cursor round-trips through a JS Date, which only has millisecond resolution. The
            // truncated cursor is fractionally EARLIER than the row it came from, so that row still satisfies
            // the filter and is re-sent at the top of the next page — one duplicate per page boundary.
            //
            // (user_id, song_id) is the primary key, so those duplicates make the whole multi-row INSERT
            // fail, and with it the entire sync: the library stayed empty on any device whose first sync was
            // large enough to paginate (>500 user songs). Collapse them, newest wins.
            const updatedUserSongs = distinctByLast(fetchedUserSongs, x => `${x.userId}\0${x.songId}`);

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
            const fetchedChangedSongs: ApiModels.ChangedSong[] = [];
            if (songCursorRaw != null) {
                const localSongIdSet = new Set(localSongIds);
                let songAfterDate = new Date(songCursorRaw);
                let songEndOfList = false;
                while (!songEndOfList) {
                    const page = await this.api.songGetChanged(songAfterDate);
                    for (const changed of page.items) {
                        // Only refresh songs we hold locally; brand-new ones are handled by the fetch above.
                        if (localSongIdSet.has(changed.songId)) {
                            fetchedChangedSongs.push(changed);
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

            // Same overlapping-page caveat as the user songs above: songId is this table's primary key, so a
            // row repeated across a page boundary would break the whole insert. Newest wins.
            const changedLocalSongs = distinctByLast(fetchedChangedSongs, x => x.songId);

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
            if (e instanceof ApiStatusFailureError || axios.isAxiosError(e)) {
                return statusOfFailure(e);
            }

            // A NON-API failure here (a bad write, a driver that rejects a statement, a null deref) used to be
            // indistinguishable from "the server is down": it collapsed into a bare 500 that the caller only
            // logs as a status number, so the sync silently failed every 10s forever and the only symptom was
            // an empty library. Log the actual error — it is the difference between a diagnosable bug and a
            // mystery on every platform.
            console.error("Overall sync failed:", e);
            return HttpStatusCode.InternalServerError;
        }
    }
}