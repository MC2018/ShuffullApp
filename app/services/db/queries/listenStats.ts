import { and, asc, count, desc, eq, isNull, ne, or } from "drizzle-orm";
import { LikeStatus } from "@/app/enums";
import type { ListenStatsResponse, MaybeDropRule } from "@/app/services/api/models";
import { GenericDb } from "../GenericDb";
import { ListenStat, ListenStatsSync } from "../models";
import { artistTable, listenStatsSyncTable, listenStatTable, songArtistTable, songTable, userSongTable } from "../schema";
import { SongDetails } from "../types";
import { withTransaction } from "../transaction";
import { chunkRows } from "./_chunk";

/** The local copy of the stats as of `syncedAt`, and the rule the server flagged songs with. */
export interface ListenStatsSnapshot {
    syncedAt: Date;
    rule: MaybeDropRule;
}

export type MaybeDropSong = SongDetails & { stat: ListenStat };

// Replaces the user's cached stats with the server's answer, rows and sync stamp together, so a screen never sees one
// refresh's rows under another's rule. The server returns every song the user ever played, so a song missing from the
// answer has no listens (any more) and its old row goes.
export async function replaceListenStats(db: GenericDb, userId: string, response: ListenStatsResponse, syncedAt: Date): Promise<void> {
    const rows: ListenStat[] = response.songs.map(x => ({ ...x, userId }));
    const sync: ListenStatsSync = { userId, syncedAt, ...response.maybeDropRule };

    await withTransaction(db, async tx => {
        await tx.delete(listenStatTable).where(eq(listenStatTable.userId, userId));
        for (const rowChunk of chunkRows(rows)) {
            await tx.insert(listenStatTable).values(rowChunk);
        }
        await tx.insert(listenStatsSyncTable).values(sync).onConflictDoUpdate({
            target: listenStatsSyncTable.userId,
            set: { syncedAt: sync.syncedAt, skippedUnderSeconds: sync.skippedUnderSeconds, quickSkips: sync.quickSkips, ofLastPlays: sync.ofLastPlays },
        });
    });
}

/** When the stats were last synced and with which rule, or null if they never have been on this device. */
export async function getListenStatsSnapshot(db: GenericDb, userId: string): Promise<ListenStatsSnapshot | null> {
    const [sync] = await db.select().from(listenStatsSyncTable).where(eq(listenStatsSyncTable.userId, userId)).limit(1);
    if (sync == undefined) {
        return null;
    }
    const { syncedAt, skippedUnderSeconds, quickSkips, ofLastPlays } = sync;
    return { syncedAt, rule: { skippedUnderSeconds, quickSkips, ofLastPlays } };
}

/** One song's cached stats, or null if the last sync had no listens for it. */
export async function getSongListenStat(db: GenericDb, userId: string, songId: string): Promise<ListenStat | null> {
    const [stat] = await db.select().from(listenStatTable)
        .where(and(eq(listenStatTable.userId, userId), eq(listenStatTable.songId, songId)))
        .limit(1);
    return stat ?? null;
}

const userSongJoin = (userId: string) => and(eq(userSongTable.songId, listenStatTable.songId), eq(userSongTable.userId, userId));

const maybeDropWhere = (userId: string) => and(
    eq(listenStatTable.userId, userId),
    eq(listenStatTable.maybeDrop, true),
    or(isNull(userSongTable.likeStatus), ne(userSongTable.likeStatus, LikeStatus.Dislike)),
);

// The "Maybe drop this" list: songs the server flagged that this device has, most quick skips first, then the most
// recently played. A song the user already disliked is left out: they acted on it, it no longer plays in the shuffle,
// and with no new plays the server would flag it forever.
export async function getMaybeDropSongs(db: GenericDb, userId: string): Promise<MaybeDropSong[]> {
    const rows = await db
        .select({ song: songTable, artist: artistTable, stat: listenStatTable })
        .from(listenStatTable)
        .innerJoin(songTable, eq(songTable.songId, listenStatTable.songId))
        .leftJoin(userSongTable, userSongJoin(userId))
        .leftJoin(songArtistTable, eq(songArtistTable.songId, songTable.songId))
        .leftJoin(artistTable, eq(artistTable.artistId, songArtistTable.artistId))
        .where(maybeDropWhere(userId))
        // songId last, so a song's artist rows stay next to each other for the grouping below.
        .orderBy(desc(listenStatTable.recentQuickSkips), desc(listenStatTable.lastPlayed), asc(songTable.songId), asc(artistTable.name));

    const songs: MaybeDropSong[] = [];
    for (const row of rows) {
        let current = songs[songs.length - 1];
        if (current?.song.songId != row.song.songId) {
            current = { song: row.song, artists: [], stat: row.stat };
            songs.push(current);
        }
        if (row.artist != null) {
            current.artists.push(row.artist);
        }
    }
    return songs;
}

/** How many songs getMaybeDropSongs would list, without loading them. */
export async function countMaybeDropSongs(db: GenericDb, userId: string): Promise<number> {
    const [row] = await db
        .select({ n: count() })
        .from(listenStatTable)
        .innerJoin(songTable, eq(songTable.songId, listenStatTable.songId))
        .leftJoin(userSongTable, userSongJoin(userId))
        .where(maybeDropWhere(userId));
    return row?.n ?? 0;
}
