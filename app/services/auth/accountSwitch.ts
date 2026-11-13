import { ne } from "drizzle-orm";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { GenericDb } from "@/app/services/db/GenericDb";
import { Song } from "@/app/services/db/models";
import { clearSongCache } from "@/app/services/db/queries/song";
import { playlistTable, songTable, userTable } from "@/app/services/db/schema";
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
    /** Removes one song's downloaded audio and album art. The app passes Downloader.deleteLocalSongFiles. */
    deleteSongFiles: (song: Song) => Promise<void>;
}

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
 * song row to be sent: each carries its song id.
 *
 * What it does reset is how far each account has synced. The user-songs feed and the playlist fetch are incremental:
 * a sync asks only for what changed since the user's stored version and fetches only playlists whose version moved,
 * and takes songs only from those. With the songs gone, an account coming back would get none of its unchanged
 * library again. So every user's version goes back to the start of the feed and every playlist's to 0, and each
 * account's next sync pages its whole library, like a first sync.
 *
 * Returns whether the cache was cleared.
 */
export async function claimSongCache(deps: AccountSwitchDeps, userId: string, hostAddress: string): Promise<boolean> {
    const { db, storage } = deps;
    const owner = await storage.getItem(STORAGE_KEYS.SONG_CACHE_USER_ID);

    if (!(await belongsToAnotherAccount(db, owner, userId))) {
        await recordOwner(storage, userId, hostAddress);
        return false;
    }

    const ownerHost = await storage.getItem(STORAGE_KEYS.SONG_CACHE_HOST);
    await deps.stopPlayback();
    const songs = await db.select().from(songTable);

    // Files first, while the rows still say which they are: a run that dies after this but before the transaction
    // leaves the rows, and the next login clears again. The other way round would orphan the files for good. Media is
    // stored by file hash, so songs that share audio share one file.
    const byFile = new Map(songs.map(song => [`${song.fileHash}.${song.fileExtension}`, song]));
    for (const song of byFile.values()) {
        await deps.deleteSongFiles(song);
    }

    await withTransaction(db, async (tx) => {
        await clearSongCache(tx);
        await tx.update(userTable).set({ version: new Date(FEED_START) });
        await tx.update(playlistTable).set({ version: new Date(0) });
    });

    for (const key of SONG_CACHE_STORAGE_KEYS) {
        await storage.removeItem(key);
    }
    // Last: a run that dies before this clears again on the next login, rather than leave the old account's songs.
    await recordOwner(storage, userId, hostAddress);

    log.info("auth",
        `Account changed on this device (${owner ?? "an earlier account"} on ${ownerHost ?? "an unknown host"} -> ` +
        `${userId} on ${hostAddress}): cleared ${songs.length} cached song(s) and ${byFile.size} file(s). ` +
        "The previous account's queued requests and listens are kept for its next login.");
    return true;
}

/**
 * Whether the song cache holds another account's songs. A build from before ShuffullApp#193 never recorded whose
 * they are, so then any other account that has synced here (it has a users row) counts: its songs may be in there.
 */
async function belongsToAnotherAccount(db: GenericDb, owner: string | null, userId: string): Promise<boolean> {
    if (owner != null) {
        return owner !== userId;
    }
    const others = await db.select({ userId: userTable.userId }).from(userTable).where(ne(userTable.userId, userId)).limit(1);
    return others.length > 0;
}

async function recordOwner(storage: AccountSwitchStorage, userId: string, hostAddress: string): Promise<void> {
    await storage.setItem(STORAGE_KEYS.SONG_CACHE_USER_ID, userId);
    await storage.setItem(STORAGE_KEYS.SONG_CACHE_HOST, hostAddress);
}
