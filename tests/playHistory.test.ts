import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { RecordListenPayload, Song } from "@/app/services/db/models";
import { closeListen } from "@/app/services/db/queries/listen";
import { getPlayHistory, recordPlay } from "@/app/services/db/queries/playHistory";
import { removeAllRecentlyPlayedSongs } from "@/app/services/db/queries/recentlyPlayedSong";
import { purgeSongs } from "@/app/services/db/queries/song";
import { artistTable, playHistoryTable, playlistTable, songArtistTable, songTable, userTable } from "@/app/services/db/schema";
import {
    belongsInPlayHistory,
    describePlayDay,
    describePlayRow,
    formatPlayTime,
    groupPlaysByDay,
    PLAY_HISTORY_LIMIT,
} from "@/app/tools/playHistory";

// Recently played: every closed listen lands in a history that, unlike the player's back/forward list, outlives a
// change of playlist or audition.

const USER = "u1";
const T0 = Date.parse("2026-11-19T15:00:00.000Z");

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

function song(id: string): Song {
    return {
        songId: id, fileExtension: ".mp3", fileHash: `hash-${id}`, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false, hookStartPercent: null,
    };
}

let seq = 0;
function listen(songId: string, startedAtMs: number, over: Partial<RecordListenPayload> = {}): RecordListenPayload {
    seq++;
    return {
        listenId: `l${seq}`,
        songId,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(startedAtMs + 200_000).toISOString(),
        secondsListened: 200,
        songDurationSeconds: 200,
        endReason: "finished",
        context: "playlist",
        playlistId: "p1",
        platform: "android",
        userId: USER,
        ...over,
    };
}

describe("play history: recording", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await db.insert(userTable).values({ userId: USER, username: "u", version: new Date(T0), isCurator: false });
        await db.insert(songTable).values([song("a"), song("b"), song("c")]);
        await db.insert(artistTable).values([{ artistId: "x", name: "Xavier" }, { artistId: "y", name: "Ana" }]);
        await db.insert(songArtistTable).values([
            { songArtistId: "ax", songId: "a", artistId: "x" },
            { songArtistId: "ay", songId: "a", artistId: "y" },
        ]);
        await db.insert(playlistTable).values({ playlistId: "p1", userId: USER, name: "Chill", percentUntilReplayable: 0.5, version: new Date(T0), isExploratory: false });
    });

    it("closing a listen records it, newest first, with its song, artists and playlist", async () => {
        await closeListen(db, listen("a", T0));
        await closeListen(db, listen("b", T0 + 300_000, { endReason: "skipped", secondsListened: 42, context: "audition" }));

        const history = await getPlayHistory(db, USER);

        expect(history.map(x => x.song.songId)).toEqual(["b", "a"]);
        expect(history[0].play.endReason).toBe("skipped");
        expect(history[0].play.secondsListened).toBe(42);
        expect(history[1].artists.map(x => x.name)).toEqual(["Ana", "Xavier"]);
        expect(history[1].playlistName).toBe("Chill");
        expect(history[1].play.startedAt).toEqual(new Date(T0));
    });

    it("outlives the player's back/forward list being cleared by a new playlist or audition", async () => {
        await closeListen(db, listen("a", T0));
        await removeAllRecentlyPlayedSongs(db);

        expect((await getPlayHistory(db, USER)).map(x => x.song.songId)).toEqual(["a"]);
    });

    it("records a listen closed twice once", async () => {
        const once = listen("a", T0);
        await closeListen(db, once);
        await closeListen(db, once);

        expect(await getPlayHistory(db, USER)).toHaveLength(1);
    });

    it("leaves out a listen where nothing was heard, but keeps a song that played out", async () => {
        await closeListen(db, listen("a", T0, { endReason: "skipped", secondsListened: 0.4 }));
        await closeListen(db, listen("b", T0 + 1, { endReason: "stopped", secondsListened: 0 }));
        await closeListen(db, listen("c", T0 + 2, { endReason: "finished", secondsListened: 0 }));

        expect((await getPlayHistory(db, USER)).map(x => x.song.songId)).toEqual(["c"]);
    });

    it("keeps a play from a deleted playlist, with no playlist name", async () => {
        await closeListen(db, listen("a", T0, { playlistId: "gone" }));

        const [play] = await getPlayHistory(db, USER);
        expect(play.song.songId).toBe("a");
        expect(play.playlistName).toBeNull();
    });

    it("drops a purged song's plays", async () => {
        await closeListen(db, listen("a", T0));
        await closeListen(db, listen("b", T0 + 1));
        await purgeSongs(db, ["a"]);

        expect((await db.select().from(playHistoryTable)).map(x => x.songId)).toEqual(["b"]);
    });

    it("shows only the given user's plays", async () => {
        await closeListen(db, listen("a", T0));
        await closeListen(db, listen("b", T0 + 1, { userId: "someone-else" }));

        expect((await getPlayHistory(db, USER)).map(x => x.song.songId)).toEqual(["a"]);
    });

    it("keeps the newest PLAY_HISTORY_LIMIT plays per user and drops the oldest", async () => {
        for (let i = 0; i < PLAY_HISTORY_LIMIT + 3; i++) {
            await recordPlay(db, listen("a", T0 + i * 1000));
        }
        await recordPlay(db, listen("b", T0, { userId: "someone-else" }));

        const mine = await getPlayHistory(db, USER, PLAY_HISTORY_LIMIT + 10);
        expect(mine).toHaveLength(PLAY_HISTORY_LIMIT);
        expect(mine[mine.length - 1].play.startedAt).toEqual(new Date(T0 + 3000));
        expect(await getPlayHistory(db, "someone-else")).toHaveLength(1);
    });

    it("honours the limit", async () => {
        await closeListen(db, listen("a", T0));
        await closeListen(db, listen("b", T0 + 1));
        await closeListen(db, listen("c", T0 + 2));

        expect((await getPlayHistory(db, USER, 2)).map(x => x.song.songId)).toEqual(["c", "b"]);
    });
});

describe("play history: wording", () => {
    it("lists a song that played out, or one heard for a second or more", () => {
        expect(belongsInPlayHistory({ endReason: "finished", secondsListened: 0 })).toBe(true);
        expect(belongsInPlayHistory({ endReason: "skipped", secondsListened: 1 })).toBe(true);
        expect(belongsInPlayHistory({ endReason: "skipped", secondsListened: 0.9 })).toBe(false);
    });

    it("says how a play ended and where it came from, leaving out what says nothing", () => {
        expect(describePlayRow(["Ana", "Xavier"], "finished", 200, "playlist", "Chill")).toBe("Ana, Xavier · Chill");
        expect(describePlayRow([], "skipped", 42, "audition", "Week 46")).toBe("Unknown Artist · Skipped at 0:42 · Audition · Week 46");
        expect(describePlayRow(["Ana"], "previous", 70, "genreJam", null)).toBe("Ana · Went back at 1:10 · Genre Jam");
        expect(describePlayRow(["Ana"], "stopped", 5, "other", null)).toBe("Ana · Stopped at 0:05");
        expect(describePlayRow(["Ana"], "finished", 200, "playlist", null)).toBe("Ana");
    });

    it("formats the time of day on a 12-hour clock", () => {
        expect(formatPlayTime(new Date(2026, 10, 19, 0, 5))).toBe("12:05 AM");
        expect(formatPlayTime(new Date(2026, 10, 19, 12, 0))).toBe("12:00 PM");
        expect(formatPlayTime(new Date(2026, 10, 19, 15, 7))).toBe("3:07 PM");
    });

    it("names the day: today, yesterday, a weekday within the week, else the date", () => {
        const now = new Date(2026, 10, 19, 9, 0); // Thursday
        expect(describePlayDay(new Date(2026, 10, 19, 0, 1), now)).toBe("Today");
        expect(describePlayDay(new Date(2026, 10, 18, 23, 59), now)).toBe("Yesterday");
        expect(describePlayDay(new Date(2026, 10, 16, 12, 0), now)).toBe("Monday");
        expect(describePlayDay(new Date(2026, 10, 12, 12, 0), now)).toBe("Nov 12");
        expect(describePlayDay(new Date(2025, 11, 30, 12, 0), now)).toBe("Dec 30, 2025");
    });

    it("groups plays sorted newest first into one section per day, in order", () => {
        const now = new Date(2026, 10, 19, 9, 0);
        const plays = [
            new Date(2026, 10, 19, 8, 0),
            new Date(2026, 10, 19, 7, 0),
            new Date(2026, 10, 18, 22, 0),
            new Date(2026, 10, 16, 10, 0),
        ];

        const sections = groupPlaysByDay(plays, x => x, now);

        expect(sections.map(x => [x.title, x.data.length])).toEqual([["Today", 2], ["Yesterday", 1], ["Monday", 1]]);
    });
});
