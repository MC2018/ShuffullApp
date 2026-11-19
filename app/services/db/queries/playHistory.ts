import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { belongsInPlayHistory, PLAY_HISTORY_LIMIT } from "@/app/tools/playHistory";
import { GenericDb } from "../GenericDb";
import { Artist, PlayHistoryEntry, RecordListenPayload } from "../models";
import { artistTable, playHistoryTable, playlistTable, songArtistTable, songTable } from "../schema";
import { SongDetails } from "../types";
import { chunkIds } from "./_chunk";

/** One play on the Recently played screen: the song as it is now, and the playlist it came from if that still exists. */
export type PlayHistoryItem = SongDetails & { play: PlayHistoryEntry; playlistName: string | null };

/**
 * Records a closed listen in the play history, then trims the user's history back to PLAY_HISTORY_LIMIT. Called by
 * closeListen inside its transaction, so the history row and the outbox row land together or not at all. A listen
 * already recorded is left as it is, and one where nothing was heard (belongsInPlayHistory) is not recorded.
 */
export async function recordPlay(tx: GenericDb, listen: RecordListenPayload): Promise<void> {
    if (!belongsInPlayHistory(listen)) {
        return;
    }

    await tx.insert(playHistoryTable).values({
        listenId: listen.listenId,
        userId: listen.userId,
        songId: listen.songId,
        startedAt: new Date(listen.startedAt),
        endedAt: new Date(listen.endedAt),
        secondsListened: listen.secondsListened,
        songDurationSeconds: listen.songDurationSeconds,
        endReason: listen.endReason,
        context: listen.context,
        playlistId: listen.playlistId,
    }).onConflictDoNothing({ target: playHistoryTable.listenId });

    const newest = tx
        .select({ listenId: playHistoryTable.listenId })
        .from(playHistoryTable)
        .where(eq(playHistoryTable.userId, listen.userId))
        .orderBy(desc(playHistoryTable.startedAt))
        .limit(PLAY_HISTORY_LIMIT);
    await tx.delete(playHistoryTable).where(and(
        eq(playHistoryTable.userId, listen.userId),
        notInArray(playHistoryTable.listenId, newest),
    ));
}

/**
 * The user's plays, newest first, at most `limit`. A song no longer on this device is left out (purgeSongs removes its
 * rows too). A deleted playlist leaves the play with no playlist name rather than hiding it.
 */
export async function getPlayHistory(db: GenericDb, userId: string, limit: number = PLAY_HISTORY_LIMIT): Promise<PlayHistoryItem[]> {
    const rows = await db
        .select({ play: playHistoryTable, song: songTable, playlistName: playlistTable.name })
        .from(playHistoryTable)
        .innerJoin(songTable, eq(songTable.songId, playHistoryTable.songId))
        .leftJoin(playlistTable, eq(playlistTable.playlistId, playHistoryTable.playlistId))
        .where(eq(playHistoryTable.userId, userId))
        .orderBy(desc(playHistoryTable.startedAt))
        .limit(limit);

    // Artists in a second query: joining them above would multiply rows and break the limit.
    const artistsBySong = new Map<string, Artist[]>();
    const songIds = [...new Set(rows.map(x => x.song.songId))];
    for (const idChunk of chunkIds(songIds)) {
        const artistRows = await db
            .select({ songId: songArtistTable.songId, artist: artistTable })
            .from(songArtistTable)
            .innerJoin(artistTable, eq(artistTable.artistId, songArtistTable.artistId))
            .where(inArray(songArtistTable.songId, idChunk))
            .orderBy(asc(artistTable.name));
        for (const row of artistRows) {
            const list = artistsBySong.get(row.songId) ?? [];
            list.push(row.artist);
            artistsBySong.set(row.songId, list);
        }
    }

    return rows.map(x => ({
        play: x.play,
        song: x.song,
        artists: artistsBySong.get(x.song.songId) ?? [],
        playlistName: x.playlistName,
    }));
}
