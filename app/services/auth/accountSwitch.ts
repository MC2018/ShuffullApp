import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { GenericDb } from "@/app/services/db/GenericDb";
import { Song } from "@/app/services/db/models";
import { claimUnownedGenreJams } from "@/app/services/db/queries/genreJam";
import { resetPlaylistVersions } from "@/app/services/db/queries/playlist";
import { clearSongCache, getSongsWithLocalFiles } from "@/app/services/db/queries/song";
import { hasOtherUser, setAllUserVersions } from "@/app/services/db/queries/user";
import { withTransaction } from "@/app/services/db/transaction";
import { FEED_START } from "@/app/services/sync-manager/syncLogic";
import { log } from "@/app/tools/log";

/** The AsyncStorage calls this needs; a Map-backed fake in the tests. */
export interface AccountSwitchStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface AccountSwitchDeps {
    db: GenericDb;
    storage: AccountSwitchStorage;
    /** Stops the player and empties its queue, so nothing from the old library keeps playing. MediaManager.clear. */
    stopPlayback: () => Promise<void>;
    /**
     * Stops the old account's sync and waits, for a bounded time, for one still running to end, so it writes nothing
     * after the clear. SyncManager.stopAll.
     */
    stopSync: () => Promise<void>;
    /**
     * Empties the download queue and waits, for a bounded time, for downloads in flight to finish, so none lands after
     * its files were deleted. Resolves false if some were still running. Downloader.clearQueueAndSettleShared.
     */
    settleDownloads: () => Promise<boolean>;
    /** Removes one song's downloaded audio and album art. The app passes Downloader.deleteLocalSongFiles. */
    deleteSongFiles: (song: Song) => Promise<void>;
}

/** Files deleted at once: the deletes are independent native or IPC calls, and the login waits for all of them. */
const FILE_DELETE_CONCURRENCY = 8;

/**
 * The device-wide song-sync keys. They describe the song cache as a whole, so they reset with it and the next sync
 * starts like a first one.
 */
export const SONG_CACHE_STORAGE_KEYS = [
    STORAGE_KEYS.SONG_SYNC_CURSOR,
    STORAGE_KEYS.SONG_SYNC_KEY,
    STORAGE_KEYS.SONG_RECONCILE_AT,
    STORAGE_KEYS.SONG_RECONCILE_STATE,
    STORAGE_KEYS.SONG_FIELDS_REVISION,
] as const;

/**
 * Makes the local song cache belong to `userId` before that account's first sync (ShuffullApp#193).
 *
 * The songs, artists, tags and download tables have no user column, so one account's library stayed on the device
 * after another logged in, mixed into its Songs tab and shuffle. When the account logging in isn't the one the cache
 * was synced for, this empties those tables and deletes their files, and the new account's first sync fills them.
 * The same account logging back in changes nothing, so nothing is downloaded again.
 *
 * What it never touches is the previous account's own rows. Its outbox, dead letters and unfinished listens are user
 * decisions the server may not have yet. They are keyed by user id, and the outbox only ever sends the logged-in
 * user's rows, so they wait on the device and go out the next time that account logs in. None of them needs a local
 * song row to be sent: each carries its song id. Its genre jams stay too (ShuffullApp#199): they exist only on this
 * device, and they are read only for the account that made them, so the new account doesn't see them and the old one
 * gets them back when it returns.
 *
 * What it does reset is how far each account has synced. The user-songs feed and the playlist fetch are incremental:
 * a sync asks only for what changed since the user's stored version and fetches only playlists whose version moved,
 * and takes songs only from those. With the songs gone, an account coming back would get none of its unchanged
 * library again. So every user's version goes back to the start of the feed and every playlist's to 0, and each
 * account's next sync pages its whole library, like a first sync.
 *
 * It also resets the current playback scope, so the new account doesn't play on the old one's filters (ShuffullApp#204).
 *
 * Returns whether the cache was cleared.
 */
export async function claimSongCache(deps: AccountSwitchDeps, userId: string, hostAddress: string): Promise<boolean> {
    const { db, storage } = deps;
    const owner = await storage.getItem(STORAGE_KEYS.SONG_CACHE_USER_ID);

    // Before the owner can change: a jam from before jams had an account is the owner's. On a device that never
    // recorded one, it goes to whoever logs in first, who saw it before this build as every account did.
    await claimUnownedGenreJams(db, owner ?? userId);

    if (!(await belongsToAnotherAccount(db, owner, userId))) {
        await recordOwner(storage, userId, hostAddress);
        return false;
    }

    const ownerHost = await storage.getItem(STORAGE_KEYS.SONG_CACHE_HOST);
    // Before anything is read: a sync of the old account still running would otherwise write its songs back, and move
    // its version on, after they were cleared.
    await deps.stopSync();
    await deps.stopPlayback();

    // Which songs can have files: the queued ones are read before the queue is emptied, the downloaded ones after the
    // downloads in flight have landed and recorded themselves.
    const queued = await getSongsWithLocalFiles(db);
    if (!(await deps.settleDownloads())) {
        log.warn("auth", "Downloads were still running when the last account's songs were cleared; one that lands later stays on disk.");
    }
    const withFiles = [...queued, ...(await getSongsWithLocalFiles(db))];

    // Files first, while the rows still say which they are: a run that dies after this but before the transaction
    // leaves the rows, and the next login clears again. The other way round would orphan the files for good. Media is
    // stored by file hash, so songs that share audio share one file.
    const byFile = [...new Map(withFiles.map(song => [`${song.fileHash}${song.fileExtension}`, song])).values()];
    for (let i = 0; i < byFile.length; i += FILE_DELETE_CONCURRENCY) {
        await Promise.all(byFile.slice(i, i + FILE_DELETE_CONCURRENCY).map(song => deps.deleteSongFiles(song)));
    }

    let cleared = 0;
    await withTransaction(db, async (tx) => {
        cleared = await clearSongCache(tx);
        await setAllUserVersions(tx, new Date(FEED_START));
        await resetPlaylistVersions(tx);
    });

    for (const key of SONG_CACHE_STORAGE_KEYS) {
        await storage.removeItem(key);
    }
    // The playback scope is device-wide too, so the old account's would otherwise be the new one's next play: a genre
    // jam's filters would play A's jam for B and log B's listens as a jam B never chose (ShuffullApp#204), and a
    // playlist or artist scope names A's ids, gone with the clear. Every kind resets, not only a jam's: the next read
    // starts B on a fresh whole-library scope. Like the keys above it comes after stopPlayback and before the owner,
    // so a run that dies first resets it on the next login.
    await storage.removeItem(STORAGE_KEYS.CURRENT_SONG_FILTERS);
    // Last: a run that dies before this clears again on the next login, rather than leave the old account's songs.
    await recordOwner(storage, userId, hostAddress);

    log.info("auth",
        `Account changed on this device (${owner ?? "an earlier account"} on ${ownerHost ?? "an unknown host"} -> ` +
        `${userId} on ${hostAddress}): cleared ${cleared} cached song(s) and ${byFile.length} downloaded file(s). ` +
        "The previous account's queued requests and listens are kept for its next login.");
    return true;
}

/**
 * Records `userId` as the song cache's owner if no one is recorded yet. For a session restored at app start, which is
 * the account the cache has been syncing for. Without it, a device updated from a build before ShuffullApp#193 that
 * still holds another account's users row would clear on that same account's next login (belongsToAnotherAccount).
 *
 * Also hands the owner any genre jam that has no account yet: one made before ShuffullApp#199, or one a database
 * rebuild carried over from that older schema. Until then no account sees it.
 */
export async function adoptSongCache(
    db: GenericDb, storage: AccountSwitchStorage, userId: string, hostAddress: string,
): Promise<void> {
    const owner = await storage.getItem(STORAGE_KEYS.SONG_CACHE_USER_ID);
    await claimUnownedGenreJams(db, owner ?? userId);
    if (owner == null) {
        await recordOwner(storage, userId, hostAddress);
    }
}

/**
 * Whether the song cache holds another account's songs. A build from before ShuffullApp#193 never recorded whose
 * they are, so then any other account that has synced here (it has a users row) counts: its songs may be in there.
 */
async function belongsToAnotherAccount(db: GenericDb, owner: string | null, userId: string): Promise<boolean> {
    return owner != null ? owner !== userId : await hasOtherUser(db, userId);
}

async function recordOwner(storage: AccountSwitchStorage, userId: string, hostAddress: string): Promise<void> {
    await storage.setItem(STORAGE_KEYS.SONG_CACHE_USER_ID, userId);
    await storage.setItem(STORAGE_KEYS.SONG_CACHE_HOST, hostAddress);
}
