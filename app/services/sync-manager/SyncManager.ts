import { ApiClient } from "@/app/services/api/ApiClient";
import DbQueries from "@/app/services/db/queries";
import * as DbModels from "@/app/services/db/models";
import * as ApiModels from "@/app/services/api/models";
import { chunk, deterministicId, distinctBy, distinctByLast, generateId } from "@/app/tools";
import axios, { HttpStatusCode } from "axios";
import { RequestType } from "@/app/enums";
import { ApiStatusFailureError, isUnreachableStatus, statusOfFailure } from "@/app/services/api/errors";
import { useServerReachability } from "@/app/services/connectivity/serverReachability";
import { GenericDb } from "@/app/services/db/GenericDb";
import { withTransaction } from "@/app/services/db/transaction";
import { Downloader } from "@/app/services/downloader/Downloader";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ListenStatsAttempt, listenStatsDue } from "@/app/tools/listenStats";
import { collectNewSongIds, FEED_START, failedKeeps, failedListens, groupRequestsIntoBatches, holdBehindRefused, keepsDueForRetry, markRefused, OUTBOX_MAX_BATCH_SIZE, pageFeed, partitionRejectedRequests, playlistDeleteHold, playlistsToFetch, pendingSongMisses, SONG_FIELDS_REVISION, SONG_LIST_MAX_IDS, songFeedStart, songReconcileDue, SongReconcileState, songsGoneFromServer, summarizeRetagFailures, SYNC_INTERVAL_MS, syncTicksToSkip, toRetagItems, withoutPendingDeletes } from "@/app/services/sync-manager/syncLogic";
import { log } from "@/app/tools/log";

/** What one outbox batch came back with: the status sync() acts on, and the error text when it failed. */
interface RunResult {
    statusCode: number;
    reason?: string;
}

/** The request types the outbox pushes. OverallSync is the pull, and nothing queues Authenticate. */
type PushedRequestType = Exclude<RequestType, RequestType.OverallSync | RequestType.Authenticate>;

/**
 * Thrown inside a sync whose SyncManager was disposed while it ran (see SyncManager.disposed), to stop it before its
 * next write. sync() swallows it: a stopped sync is neither a failure nor a backoff.
 */
class SyncStoppedError extends Error {
    constructor() {
        super("The sync was stopped because its account logged out.");
    }
}

/** Sends a batch's rows one call at a time, in queue order; the first failure stops the rest. */
async function eachInOrder<T>(requests: T[], send: (request: T) => Promise<unknown>): Promise<void> {
    for (const request of requests) {
        await send(request);
    }
}

export class SyncManager {
    db: GenericDb;
    api: ApiClient;
    userId: string;
    timerId: ReturnType<typeof setInterval>;
    syncing = false;
    logout: () => Promise<void>;
    // When each held Keep was last re-sent (see checkDeleteHold). In memory only: a restart just retries once.
    keepRetriedAt = new Map<string, number>();
    // Syncs in a row that couldn't reach the server, and how many interval ticks to sit out before the next (see
    // syncTicksToSkip).
    failedSyncs = 0;
    ticksToSkip = 0;
    // The last time the listen stats were fetched (see refreshListenStats). In memory only: a restart fetches once.
    listenStatsAttempt: ListenStatsAttempt | null = null;
    // Called after each sync that pulled, so what depends on the library (play-next) can see what just arrived. Optional:
    // the tests build a SyncManager without its constructor.
    onSynced?: () => void;
    // Set by dispose(). A sync still running checks it before each write and stops there, so an account that logged
    // out can't write into the next account's library (ShuffullApp#193). Unset, so false, in the tests' managers.
    private disposed?: boolean;
    // The sync running now, for stopAll to wait on.
    private running?: Promise<void>;
    // Every manager not yet disposed, plus any disposed one whose sync is still running: what stopAll stops.
    private static readonly live = new Set<SyncManager>();

    constructor(db: GenericDb, api: ApiClient, userId: string, logout: () => Promise<void>, onSynced?: () => void) {
        this.db = db;
        this.api = api;
        this.userId = userId;
        this.logout = logout;
        this.onSynced = onSynced;
        SyncManager.live.add(this);
        // sync() never rejects, so neither call can leave an unhandled rejection behind.
        this.timerId = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
        void this.sync();
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.timerId);
        if (!this.syncing) {
            SyncManager.live.delete(this);
        }
    }

    /**
     * Disposes every SyncManager and waits up to `timeoutMs` for a sync still running to end. For an account change
     * (services/auth/accountSwitch): the old account's sync must not write after its songs were cleared. Resolves
     * whether every sync ended in time. One that didn't writes nothing more anyway: it checks `disposed` inside its
     * write transactions, and the clear's transaction waits behind one it already started.
     */
    static async stopAll(timeoutMs: number): Promise<boolean> {
        const running: Promise<void>[] = [];
        for (const manager of [...SyncManager.live]) {
            manager.dispose();
            if (manager.running != undefined) {
                running.push(manager.running);
            }
        }
        if (!running.length) {
            return true;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
        try {
            return await Promise.race([Promise.all(running).then(() => true), timedOut]);
        } finally {
            clearTimeout(timer);
        }
    }

    // Syncs at once and drops any backoff, for when its cause has just gone away: the connection is back, or the app
    // is in front again. A phone offline for a few minutes would otherwise reach the 5-minute cap and sit out up to
    // 5 more after reconnecting, with its Keeps and likes still queued.
    syncNow() {
        this.failedSyncs = 0;
        this.ticksToSkip = 0;
        void this.sync();
    }

    async submitRequests(requests: DbModels.Request[]) {
        try {
            await DbQueries.addRequests(this.db, requests);
        } catch (e) {
            log.error("sync", "Could not add requests to the outbox.", e);
        }
    }

    // One sync, unless one is running, this manager was disposed, or this tick is sat out after failures. Never rejects:
    // a throw is logged and counted as a failure, so the interval that calls this has nothing to drop.
    private sync(): Promise<void> {
        if (this.syncing || this.disposed) {
            return Promise.resolve();
        }
        if (this.ticksToSkip > 0) {
            this.ticksToSkip--;
            return Promise.resolve();
        }

        this.syncing = true;
        SyncManager.live.add(this);
        this.running = this.syncOnce();
        return this.running;
    }

    private async syncOnce() {
        try {
            const { statusCode, loggedOut } = await this.pushAndPull();
            // A sync that logged out isn't the server failing, so it doesn't back off.
            this.failedSyncs = statusCode == HttpStatusCode.Ok || loggedOut ? 0 : this.failedSyncs + 1;
            useServerReachability.getState().setReachability(isUnreachableStatus(statusCode) ? "unreachable" : "reachable");
        } catch (e) {
            if (e instanceof SyncStoppedError) {
                log.info("sync", "Stopped the sync of an account that logged out before its next write.");
                return;
            }
            log.error("sync", "Sync failed:", e);
            this.failedSyncs++;
        } finally {
            this.ticksToSkip = syncTicksToSkip(this.failedSyncs);
            if (this.ticksToSkip > 0) {
                log.info("sync",
                    `${this.failedSyncs} failed syncs in a row; ` +
                    `next try in ${(this.ticksToSkip + 1) * SYNC_INTERVAL_MS / 1000}s.`);
            }
            this.syncing = false;
            this.running = undefined;
            if (this.disposed) {
                SyncManager.live.delete(this);
            }
        }
    }

    // Ends a sync whose manager was disposed while it ran (see `disposed`). Called before each write.
    private throwIfStopped() {
        if (this.disposed) {
            throw new SyncStoppedError();
        }
    }

    // Pushes the outbox in order, then pulls. Returns 200, or the status that stopped it: a 401 on a push or the pull
    // (logged out), or anything else when the server couldn't be reached or failed (no answer, a 5xx, a failed pull),
    // which backs the next sync off. A 4xx on one batch isn't that: the rest still goes, except rows about the same song
    // or playlist, which wait so they can't overtake it.
    private async pushAndPull(): Promise<{ statusCode: number; loggedOut?: boolean }> {
        const requestBatches = groupRequestsIntoBatches(await DbQueries.getRequests(this.db, this.userId));

        const refused = new Set<string>(); // songs and playlists with a row refused this sync, kept for retry
        let listensSent = false; // the stats have moved, so refreshListenStats needn't wait out its interval
        for (const queuedBatch of requestBatches) {
            // Between batches, never between a send and its delete, so nothing sent is sent again.
            this.throwIfStopped();
            const { ready: requestBatch, held } = holdBehindRefused(queuedBatch, refused);
            if (held.length) {
                log.warn("sync", `Holding ${held.length} request(s) behind a refused one for the same song or playlist.`);
            }
            if (!requestBatch.length) {
                continue;
            }

            if (requestBatch[0]?.requestType == RequestType.DeletePlaylist) {
                const { hold, statusCode } = await this.checkDeleteHold(requestBatch[0] as DbModels.DeletePlaylistRequest);
                if (statusCode) {
                    return await this.stopSync(statusCode);
                } else if (hold) {
                    log.warn("sync", `Holding playlist delete ${requestBatch[0].playlistId}: ${hold}.`);
                    continue;
                }
            }

            const { statusCode, reason } = await this.runRequests(requestBatch);

            if (statusCode == HttpStatusCode.Unauthorized) {
                return await this.stopSync(statusCode);
            } else if (200 <= statusCode && statusCode <= 299) {
                // By id: a row replaced while this batch was in flight (enqueueSongRetag) has a new id and stays.
                await DbQueries.deleteRequests(this.db, requestBatch.map(x => x.requestId));
                listensSent ||= requestBatch[0]?.requestType == RequestType.RecordListen;
            } else if (400 <= statusCode && statusCode <= 499) {
                // Client error: replaying the same payload usually won't fix it — but deleting the rows
                // outright is how queued work used to vanish with nothing logged. Keep them for a bounded
                // window so a transient cause (a stale token, a server-side fix) recovers by itself, then
                // move them to the dead-letter table with the reason. Either way, say so out loud.
                const { abandon, keep } = partitionRejectedRequests(requestBatch, new Date());
                log.warn("sync",
                    `${statusCode} on ${requestBatch.length} request(s) of type ` +
                    `${requestBatch[0]?.requestType}: retaining ${keep.length} for retry, ` +
                    `dead-lettering ${abandon.length} past the retry window. ${reason ?? ""}`);
                await DbQueries.deadLetterRequests(this.db, abandon.map(request => ({
                    request,
                    reason: `Rejected with ${statusCode} for longer than the retry window. ${reason ?? ""}`.trim(),
                })));
                // What's kept is retried next sync, so later rows about the same song or playlist wait behind it.
                markRefused(keep, refused);
            } else if (500 <= statusCode) {
                // Stops here, so nothing queued after this batch overtakes it.
                return await this.stopSync(statusCode);
            }
        }

        // Run all pulling changes
        const overallSyncRequest: DbModels.OverallSyncRequest = {
            requestId: generateId(),
            timeRequested: new Date(Date.now()),
            requestType: RequestType.OverallSync,
            userId: this.userId
        };
        this.throwIfStopped();
        const { statusCode } = await this.runRequests([overallSyncRequest]);
        if (statusCode != HttpStatusCode.Ok) {
            return await this.stopSync(statusCode, { quiet: true });
        }
        await this.reconcileSongs();
        this.throwIfStopped();
        await this.refreshListenStats(listensSent);
        this.onSynced?.();
        return { statusCode: HttpStatusCode.Ok };
    }

    // Ends this sync on a status that stops it. A 401 means the session is gone (revoked, expired, or the user deleted),
    // so it logs out, through the guard SyncManagerProvider passes in (logoutUnlessReplaced). Anything else is the
    // server being unreachable or failing, which sync() backs off from. The API answers 503, not 401, when it can't
    // check the session because its database is down (Shuffull#108), so an outage never logs out.
    private async stopSync(statusCode: number, { quiet = false } = {}): Promise<{ statusCode: number; loggedOut?: boolean }> {
        if (statusCode == HttpStatusCode.Unauthorized) {
            await this.logout();
            return { statusCode, loggedOut: true };
        }
        if (!quiet) {
            log.info("sync", `Cannot access server. Status code: ${statusCode}`);
        }
        return { statusCode };
    }

    private async runRequests(requests: DbModels.Request[]): Promise<RunResult> {
        const requestType = requests[0].requestType as RequestType;
        if (requestType == RequestType.OverallSync) {
            return { statusCode: await this.overallSync() };
        }

        const send = SyncManager.senders[requestType as PushedRequestType];
        if (!send) {
            throw new Error("A request type has no method to call.");
        }
        return await this.attempt(() => send(this, requests));
    }

    // What sends one batch of each queued request type. Every one runs inside attempt(), the one place a thrown error
    // becomes the status sync() acts on, so a sender only calls the API and throws. Static, so a SyncManager built
    // without its constructor (the tests) has it too.
    private static readonly senders: Record<PushedRequestType, (sync: SyncManager, requests: DbModels.Request[]) => Promise<unknown>> = {
        [RequestType.UpdateSongLastPlayed]: (sync, requests) =>
            sync.api.userSongUpdateLastPlayed(requests as DbModels.UpdateSongLastPlayedRequest[]),
        // No longer queued (last-played creates the server row, Shuffull#2). Kept so rows older builds queued
        // still drain; removing it is Shuffull#126.
        [RequestType.CreateUserSong]: (sync, requests) =>
            sync.api.userSongCreateMany((requests as DbModels.CreateUserSongRequest[]).map(x => x.songId)),
        // Processed individually, so each batch is a single song; loop defensively all the same.
        [RequestType.SetSongLikeStatus]: (sync, requests) => eachInOrder(requests as DbModels.SetSongLikeStatusRequest[],
            request => sync.api.userSongSetLikeStatus(request.songId, request.likeStatus)),
        // Batched: one idempotent POST per flagged song (server skips songs already queued).
        [RequestType.FlagSongForReplacement]: (sync, requests) => eachInOrder(requests as DbModels.FlagSongForReplacementRequest[],
            request => sync.api.flagSongForReplacement(request.songId)),
        // Processed individually, so each batch is a single song; loop defensively all the same.
        [RequestType.UpdateSongMetadata]: (sync, requests) => eachInOrder(requests as DbModels.UpdateSongMetadataRequest[],
            request => sync.api.songUpdate(request.songId, request.payload)),
        [RequestType.SongRetag]: (sync, requests) => sync.keepAndRetag(requests as DbModels.SongRetagRequest[]),
        // Processed individually, so each batch is a single playlist; loop defensively all the same. The local rows were
        // already removed optimistically when the user deleted; this just tells the server (which also purges the
        // un-kept audition songs). pushAndPull holds these while any Keep is unrecorded (checkDeleteHold).
        [RequestType.DeletePlaylist]: (sync, requests) => eachInOrder(requests as DbModels.DeletePlaylistRequest[],
            request => sync.api.playlistDelete(request.playlistId)),
        [RequestType.RecordListen]: (sync, requests) => sync.recordListens(requests as DbModels.RecordListenRequest[]),
    };

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

    // Why this delete must wait (see playlistDeleteHold), or no hold. Reads fresh: a Keep sent earlier in this flush
    // may have just been recorded or dead-lettered. A hold caused by dead-lettered Keeps re-sends them, at most once
    // per HELD_KEEP_RETRY_INTERVAL_MS each, which is its way out: once the server records them, the delete goes.
    // A 401 or 5xx from that re-send comes back as statusCode, for sync() to act on like any other batch's.
    private async checkDeleteHold(request: DbModels.DeletePlaylistRequest): Promise<{ hold: string | null; statusCode?: number }> {
        const outbox = await DbQueries.getRequests(this.db, this.userId);
        const hold = playlistDeleteHold(request, outbox, await DbQueries.getDeadLetterRequests(this.db, this.userId));
        const due = keepsDueForRetry(hold?.retrySongIds ?? [], this.keepRetriedAt, Date.now());
        if (!hold || !due.length) {
            return { hold: hold?.reason ?? null };
        }

        // Chunked: /songs/keep refuses more than OUTBOX_MAX_BATCH_SIZE ids, and an older delete row is held by every
        // dead-lettered Keep the user has.
        for (let i = 0; i < due.length; i += OUTBOX_MAX_BATCH_SIZE) {
            const chunk = due.slice(i, i + OUTBOX_MAX_BATCH_SIZE);
            try {
                const response = await this.api.songKeep(chunk);
                const kept = response.results.filter(x => x.outcome === "kept").map(x => x.songId);
                await DbQueries.removeDeadLetteredKeeps(this.db, this.userId, kept);
            } catch (e) {
                const statusCode = statusOfFailure(e);
                if (statusCode == HttpStatusCode.Unauthorized || statusCode >= 500) {
                    return { hold: hold.reason, statusCode };
                }
                log.warn("sync", `Re-sending dead-lettered keeps was rejected with ${statusCode}.`, e);
            }
            // Recorded only once the server answered, so an outage doesn't push the next try out by the interval.
            const now = Date.now();
            chunk.forEach(songId => this.keepRetriedAt.set(songId, now));
        }

        const after = playlistDeleteHold(request, outbox, await DbQueries.getDeadLetterRequests(this.db, this.userId));
        return { hold: after?.reason ?? null };
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
        // retrying it every flush would just replay a verdict on the song, not a transient fault. A delete held
        // behind it re-sends it now and then instead (checkDeleteHold), in case that verdict changes.
        const failures = failedKeeps(requests, response?.results);
        if (failures.length) {
            log.warn("sync",
                `${failures.length}/${requests.length} keep(s) not recorded, dead-lettered: ` +
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
                log.warn("sync",
                    `${notEnriched.length}/${items.length} re-tag(s) did not enrich: ` +
                    `${reasons.join("; ")}`);
            }
        } catch (e) {
            log.warn("sync", `Re-tag after keep failed with ${statusOfFailure(e)}; the keeps are recorded.`, e);
        }
    }

    // Sends one chunk of finished listens (groupRequestsIntoBatches caps it at the server's 200). A 200 only means the
    // POST landed: a listen the server rejected, or didn't answer for, is dead-lettered with its reason here, before
    // pushAndPull deletes the batch. A resend is safe, since a stored listen comes back "duplicate".
    private async recordListens(requests: DbModels.RecordListenRequest[]): Promise<void> {
        const response = await this.api.listenRecord(requests.map(x => x.payload));
        const failures = failedListens(requests, response.results);
        if (failures.length) {
            log.warn("sync",
                `${failures.length}/${requests.length} listen(s) not recorded, dead-lettered: ` +
                `${[...new Set(failures.map(x => x.reason))].join("; ")}`);
            await DbQueries.deadLetterRequests(this.db, failures);
        }
    }

    // The pull can't see a song the server deleted (see songsGoneFromServer), so now and then ask for every local song
    // by id and purge what the server no longer has. Derived, not a queue: a check that fails changes nothing, and the
    // next one finds the same songs. The 573 songs one phone held after their server rows were gone heal this way.
    // The same answer also refreshes the song fields the feed can't (backfillSongFields); a build that starts storing
    // a new one bumps SONG_FIELDS_REVISION, which brings the next full check forward.
    private async reconcileSongs() {
        const now = Date.now();
        const host = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        const pending = pendingSongMisses(await AsyncStorage.getItem(STORAGE_KEYS.SONG_RECONCILE_STATE), host, this.userId);
        const lastRaw = await AsyncStorage.getItem(STORAGE_KEYS.SONG_RECONCILE_AT);
        const fieldsBehind = (await AsyncStorage.getItem(STORAGE_KEYS.SONG_FIELDS_REVISION)) !== SONG_FIELDS_REVISION;
        if (!songReconcileDue(lastRaw == null ? null : Number(lastRaw), now, pending.length, fieldsBehind)) {
            return;
        }
        // Stamped before the fetch, so a check that fails waits out the interval instead of re-running every sync.
        this.throwIfStopped();
        await AsyncStorage.setItem(STORAGE_KEYS.SONG_RECONCILE_AT, String(now));

        try {
            // A confirming check asks only about the songs the last one missed that are still here.
            const localSongIds = await DbQueries.getAllSongIds(this.db);
            const local = new Set(localSongIds);
            const checkedSongIds = pending.length ? pending.filter(x => local.has(x)) : localSongIds;

            // Every call must succeed before anything counts as missing: a throw here leaves the misses untouched.
            const returnedSongs: Pick<ApiModels.Song, "songId" | "hookStartPercent">[] = [];
            for (const idChunk of chunk(checkedSongIds, SONG_LIST_MAX_IDS)) {
                returnedSongs.push(...(await this.api.songGetList(idChunk))
                    .map(x => ({ songId: x.songId, hookStartPercent: x.hookStartPercent })));
            }
            const returnedSongIds = returnedSongs.map(x => x.songId);

            const { purge, misses, implausible } = songsGoneFromServer(checkedSongIds, returnedSongIds, pending);
            const { purged, filesInUse } = await withTransaction(this.db, async (tx) => {
                this.throwIfStopped();
                const purged = await DbQueries.purgeSongs(tx, purge);
                await DbQueries.backfillSongFields(tx, returnedSongs);
                return { purged, filesInUse: await DbQueries.fileHashesInUse(tx, purged.map(x => x.fileHash)) };
            });
            const state: SongReconcileState = { host, userId: this.userId, misses };
            this.throwIfStopped();
            await AsyncStorage.setItem(STORAGE_KEYS.SONG_RECONCILE_STATE, JSON.stringify(state));
            // Only a full check has seen every held song.
            if (!pending.length) {
                await AsyncStorage.setItem(STORAGE_KEYS.SONG_FIELDS_REVISION, SONG_FIELDS_REVISION);
            }

            for (const song of purged.filter(x => !filesInUse.has(x.fileHash))) {
                await Downloader.deleteLocalSongFiles(song);
            }
            if (implausible) {
                log.warn("sync",
                    `The server has none of ${implausible}/${checkedSongIds.length} local songs. That looks like ` +
                    "a different or broken server, not deletions, so nothing was removed.");
            } else if (purged.length || misses.length) {
                log.warn("sync",
                    `${purged.length} local song(s) no longer exist on the server and were removed; ` +
                    `${misses.length} more are missing and go in an hour if still gone.`);
            }
        } catch (e) {
            if (e instanceof SyncStoppedError) {
                throw e;
            }
            log.warn("sync", `Checking local songs against the server failed with ${statusOfFailure(e)}; nothing removed.`, e);
        }
    }

    // Refreshes the local copy of the user's listen stats, which song details and the "Maybe drop this" list read, so
    // both work offline from the last answer. Optional: it never fails the sync or backs it off, and a failure leaves
    // the last stats in place. A server from before Shuffull#61 answers 404 to every call, so that is logged quietly
    // and asked again only once per LISTEN_STATS_REFRESH_MS (listenStatsDue).
    private async refreshListenStats(listensSent: boolean) {
        const now = Date.now();
        if (!listenStatsDue(this.listenStatsAttempt, now, listensSent)) {
            return;
        }

        try {
            const stats = await this.api.listenStats();
            await DbQueries.replaceListenStats(this.db, this.userId, stats, new Date(now));
            this.listenStatsAttempt = { at: now, ok: true };
        } catch (e) {
            this.listenStatsAttempt = { at: now, ok: false };
            const statusCode = statusOfFailure(e);
            if (statusCode == HttpStatusCode.NotFound) {
                log.info("sync", "This server has no listen stats yet (404); showing the last synced ones.");
            } else {
                log.warn("sync", `Refreshing listen stats failed with ${statusCode}; showing the last synced ones.`, e);
            }
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
                await DbQueries.getRequests(this.db, this.userId));

            // Decide which playlists changed (local read) and fetch just those.
            const localPlaylists = await DbQueries.getPlaylists(this.db, this.userId);
            const playlistIdsToFetch = playlistsToFetch(accessiblePlaylists, localPlaylists);
            const updatedPlaylists: ApiModels.Playlist[] = playlistIdsToFetch.length
                ? await this.api.playlistGetList(playlistIdsToFetch)
                : [];

            // User songs changed since our last known user version (incremental, paginated by pageFeed).
            const userSongFeed = await pageFeed(
                { afterDate: oldUser != undefined ? oldUser.version.toISOString() : FEED_START },
                cursor => this.api.userSongGetAll(cursor));
            if (userSongFeed.stalled) {
                log.error("sync", "The user-songs feed repeated a page; stopped paging it, and the user version stays put.");
            }

            // Consecutive pages can OVERLAP, so the concatenation above can hold the same user song twice: the
            // start cursor is the user's version, a JS Date kept to the millisecond, and between pages pageFeed
            // re-asks for rows tied on the last Version (see nextFeedCursor). (user_id, song_id) is the primary key,
            // so a duplicate makes the whole multi-row INSERT fail, and with it the entire sync: the library stayed
            // empty on any device whose first sync paginated (>500 user songs). Collapse them, newest wins.
            const updatedUserSongs = distinctByLast(userSongFeed.items, x => `${x.userId}\0${x.songId}`);

            // Songs referenced by the updated playlists/user-songs that we don't have locally yet.
            const localSongIds = await DbQueries.getAllSongIds(this.db);
            const newSongIds = collectNewSongIds(
                updatedPlaylists.map(x => x.songIds),
                updatedUserSongs.map(x => x.songId),
                localSongIds
            );

            const songBatches: ApiModels.Song[][] = [];
            for (const idChunk of chunk(newSongIds, SONG_LIST_MAX_IDS)) {
                songBatches.push(await this.api.songGetList(idChunk));
            }

            // ── Incremental refresh of songs we ALREADY hold whose server Version changed since last sync
            // (e.g. a song re-sourced in place with better audio). The very first sync seeds the cursor at
            // "now" and skips: the fetch above already pulled current data, and paging the whole library back
            // through the changes feed would be wasteful. ──
            const songFeedFrom = songFeedStart(
                await AsyncStorage.getItem(STORAGE_KEYS.SONG_SYNC_CURSOR),
                await AsyncStorage.getItem(STORAGE_KEYS.SONG_SYNC_KEY));
            const fetchedChangedSongs: ApiModels.ChangedSong[] = [];
            // Where the next sync starts: the last row this one received, across ALL changed songs (not just the local
            // ones), so changes already accounted for are never re-paged. Undefined leaves the stored cursor alone.
            let nextSongKey: ApiModels.FeedKey | undefined;
            if (songFeedFrom != null) {
                const localSongIdSet = new Set(localSongIds);
                const songFeed = await pageFeed(songFeedFrom, cursor => this.api.songGetChanged(cursor));
                if (songFeed.stalled) {
                    log.error("sync", "The changed-songs feed repeated a page; stopped paging it for this sync.");
                }
                // Only refresh songs we hold locally; brand-new ones are handled by the fetch above.
                fetchedChangedSongs.push(...songFeed.items.filter(changed => localSongIdSet.has(changed.songId)));
                nextSongKey = songFeed.last;
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
            // withTransaction, not db.transaction(): on the sync drivers the latter commits before an async body runs,
            // so none of this used to roll back (see transaction.ts).
            await withTransaction(this.db, async (tx) => {
                // First, inside the transaction: the account-change clear runs in one too, so this either finished
                // before it began or sees that its account logged out (see stopAll).
                this.throwIfStopped();
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

                // Last: the user's version is the cursor the next sync pages user songs from (afterDate above), so it
                // moves only once everything it covers is written. The transaction already guarantees that; writing it
                // last keeps it true if this ever silently stops being one, as it had (ShuffullApp#91).
                // A stalled user-songs feed never reached the rows the new version covers, so the next sync starts from
                // the old one again rather than skip them for good.
                await DbQueries.updateUser(tx, userSongFeed.stalled
                    ? { ...user, version: oldUser?.version ?? new Date(FEED_START) }
                    : user);
            });

            // Post-commit, outside the write txn: delete the now-orphaned local files (file I/O) and advance
            // the song-sync cursor. Both run only after the writes committed — a thrown sync leaves the cursor
            // untouched, so the same changes are retried next time.
            for (const staleSong of staleSongs) {
                await Downloader.deleteLocalSongFiles(staleSong);
            }
            // A new song's file can already be on disk: the local DB was rebuilt next to a full music folder, or another
            // song shares its audio. Record it now, not on the next launch (ShuffullApp#56). Never throws.
            if (newSongIds.length) {
                await Downloader.reconcileShared();
            }
            // The cursor describes the song cache, which an account change resets (see stopAll).
            this.throwIfStopped();
            if (nextSongKey != undefined) {
                // The key first: until the cursor matches it, songFeedStart ignores it and pages from the date alone.
                await AsyncStorage.setItem(STORAGE_KEYS.SONG_SYNC_KEY, JSON.stringify(nextSongKey));
                await AsyncStorage.setItem(STORAGE_KEYS.SONG_SYNC_CURSOR, nextSongKey.version);
            } else if (songFeedFrom == null) {
                await AsyncStorage.setItem(STORAGE_KEYS.SONG_SYNC_CURSOR, syncStartTime.toISOString());
            }

            return HttpStatusCode.Ok;
        } catch (e) {
            if (e instanceof SyncStoppedError) {
                throw e;
            }
            if (e instanceof ApiStatusFailureError || axios.isAxiosError(e)) {
                return statusOfFailure(e);
            }

            // A NON-API failure here (a bad write, a driver that rejects a statement, a null deref) used to be
            // indistinguishable from "the server is down": it collapsed into a bare 500 that the caller only
            // logs as a status number, so the sync silently failed every 10s forever and the only symptom was
            // an empty library. Log the actual error — it is the difference between a diagnosable bug and a
            // mystery on every platform.
            log.error("sync", "Overall sync failed:", e);
            return HttpStatusCode.InternalServerError;
        }
    }
}
