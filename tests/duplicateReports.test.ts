import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { getRequests } from "@/app/services/db/queries/request";
import {
    applyDuplicateReportOutcomes,
    getDuplicateCandidates,
    getHiddenDuplicates,
    getHiddenSongIds,
    isSongHiddenAsDuplicate,
    reportDuplicate,
    upsertDuplicateReports,
    withdrawDuplicateReports,
} from "@/app/services/db/queries/duplicateReport";
import { getAllSongDetails, getRandomSongId } from "@/app/services/db/queries/song";
import { RequestType } from "@/app/enums";
import { ReportDuplicateRequest } from "@/app/services/db/models";
import {
    artistTable,
    deadLetterRequestTable,
    DUPLICATE_REPORT_MAX_NOTE_LENGTH,
    songArtistTable,
    songDuplicateReportTable,
    songTable,
    userSongTable,
    userTable,
} from "@/app/services/db/schema";
import type { SongDuplicateReport as ServerDuplicateReport } from "@/app/services/api/models";
import {
    duplicateReportFeedStart,
    duplicateReportOutcomes,
    FEED_START,
    hiddenSongOf,
    holdBehindRefused,
    markRefused,
    mergeDuplicateReports,
} from "@/app/services/sync-manager/syncLogic";
import { DuplicateCandidate, normalizeSongTitle, orderDuplicateCandidates } from "@/app/tools/duplicatePicker";

/** ShuffullApp#219: reporting a duplicate hides one copy for the reporter, through the outbox, with undo. */
const USER = "u1";

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    db.insert(userTable).values([USER, "u2"].map(userId => ({ userId, username: userId, version: new Date() }))).run();
    return db as unknown as GenericDb;
}

async function addSong(db: GenericDb, songId: string, name: string, opts: { artist?: string; lastPlayed?: Date; userId?: string; likeStatus?: number } = {}) {
    await db.insert(songTable).values({ songId, name, fileExtension: "mp3", fileHash: `hash-${songId}` });
    if (opts.artist) {
        await db.insert(artistTable).values({ artistId: `artist-${opts.artist}`, name: opts.artist }).onConflictDoNothing();
        await db.insert(songArtistTable).values({ songArtistId: `sa-${songId}`, songId, artistId: `artist-${opts.artist}` });
    }
    await db.insert(userSongTable).values({
        userId: opts.userId ?? USER,
        songId,
        lastPlayed: opts.lastPlayed ?? new Date(-62135596800000),
        version: new Date(),
        likeStatus: opts.likeStatus ?? 0,
    });
}

const serverReport = (overrides: Partial<ServerDuplicateReport> = {}): ServerDuplicateReport => ({
    reportId: "report-1",
    reporterUserId: USER,
    songId: "s1",
    otherSongId: "s2",
    kind: "duplicate",
    preferredSongId: null,
    hiddenSongId: "s1",
    status: "pending",
    note: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    resolvedAt: null,
    resolvedByUserId: null,
    version: "2026-11-01T00:00:00.123456Z",
    ...overrides,
});

describe("the Duplicate of… picker order", () => {
    const candidate = (songId: string, name: string, artists: string[] = [], lastPlayed: Date | null = null): DuplicateCandidate =>
        ({ songId, name, artists, lastPlayed });
    const song = { songId: "me", name: "Everybody Wants You (Official Video)", artists: ["Billy Squier"] };
    const neverPlayed = new Date(-62135596800000);

    const candidates = [
        candidate("me", "Everybody Wants You", ["Billy Squier"], new Date("2026-11-19")),
        candidate("same-title", "Everybody Wants You", ["Someone Else"]),
        candidate("same-artist", "The Stroke", ["Billy Squier"], neverPlayed),
        candidate("unrelated", "Blue Monday", ["New Order"]),
        candidate("old-play", "Song A", ["X"], new Date("2026-11-01")),
        candidate("new-play", "Song B", ["Y"], new Date("2026-11-18")),
        candidate("playing", "Song C", ["Z"], new Date("2026-11-20")),
    ];

    it("now playing, then recent plays newest first, then similar, then search matches; the reported song never shows", () => {
        const rows = orderDuplicateCandidates({ song, nowPlayingId: "playing", candidates, query: "blue" });

        expect(rows.map(x => [x.reason, x.candidate.songId])).toEqual([
            ["nowPlaying", "playing"],
            ["recent", "new-play"],
            ["recent", "old-play"],
            ["similar", "same-title"],
            ["similar", "same-artist"],
            ["search", "unrelated"],
        ]);
    });

    it("a song shows once, in the first section it fits", () => {
        const rows = orderDuplicateCandidates({
            song,
            nowPlayingId: "same-title",
            candidates: [candidate("same-title", "Everybody Wants You", ["Billy Squier"], new Date("2026-11-19"))],
            query: "everybody",
        });

        expect(rows.map(x => [x.reason, x.candidate.songId])).toEqual([["nowPlaying", "same-title"]]);
    });

    it("no now-playing row when the reported song is the one playing, or when nothing plays", () => {
        expect(orderDuplicateCandidates({ song, nowPlayingId: "me", candidates, query: "" })[0].reason).toBe("recent");
        expect(orderDuplicateCandidates({ song, nowPlayingId: undefined, candidates, query: "" })[0].reason).toBe("recent");
    });

    it("an empty search box shows no search rows, and search matches artists too", () => {
        expect(orderDuplicateCandidates({ song, nowPlayingId: undefined, candidates, query: "  " }).some(x => x.reason === "search")).toBe(false);
        expect(orderDuplicateCandidates({ song, nowPlayingId: undefined, candidates, query: "new order" })
            .filter(x => x.reason === "search").map(x => x.candidate.songId)).toEqual(["unrelated"]);
    });

    it("a never-played song (the server's DateTime.MinValue) is not a recent play", () => {
        const rows = orderDuplicateCandidates({ song, nowPlayingId: undefined, candidates, query: "" });
        expect(rows.find(x => x.candidate.songId === "same-artist")?.reason).toBe("similar");
    });

    it("normalises titles to what two uploads of one recording share", () => {
        expect(normalizeSongTitle("Beyoncé - Halo [Official Video] (HD)")).toBe("beyonce halo");
        expect(normalizeSongTitle("Everybody Wants You feat. Burnard")).toBe("everybody wants you");
        expect(normalizeSongTitle("夜に駆ける")).toBe("夜に駆ける");
    });
});

describe("hiddenSongOf: the copy a report hides", () => {
    it("hides the other song only on 'keep this one'; otherwise the reported song", () => {
        expect(hiddenSongOf("s1", "s2", "s1")).toBe("s2");
        expect(hiddenSongOf("s1", "s2", "s2")).toBe("s1");
        expect(hiddenSongOf("s1", "s2", null)).toBe("s1");
        expect(hiddenSongOf("s1", null, null)).toBe("s1");
    });
});

describe("reporting a duplicate", () => {
    let db: GenericDb;
    beforeEach(async () => {
        db = makeDb();
        await addSong(db, "s1", "Everybody Wants You", { likeStatus: 1 });
        await addSong(db, "s2", "Everybody Wants You (Live)");
    });

    it("writes the report and queues it in one go; the hidden copy leaves the library and shuffle at once", async () => {
        const report = await reportDuplicate(db, {
            userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: "s1", note: "  same upload  ",
        });

        expect(report).toMatchObject({ hiddenSongId: "s2", status: "pending", note: "same upload", version: null });
        expect((await getRequests(db, USER)).map(x => [x.requestId, x.requestType, x.songId, x.payload])).toEqual([[
            report.reportId,
            RequestType.ReportDuplicate,
            "s1",
            { reportId: report.reportId, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: "s1", note: "same upload" },
        ]]);
        expect(await isSongHiddenAsDuplicate(db, USER, "s2")).toBe(true);
        expect((await getAllSongDetails(db, USER)).map(x => x.song.songId)).toEqual(["s1"]);
        for (let i = 0; i < 20; i++) {
            expect(await getRandomSongId(db, USER)).toBe("s1");
        }
    });

    it("never writes a Dislike, or touches any like status", async () => {
        await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: null });
        await reportDuplicate(db, { userId: USER, songId: "s2", otherSongId: null, kind: "differentVersion", preferredSongId: null, note: null });

        const likes = await db.select({ songId: userSongTable.songId, likeStatus: userSongTable.likeStatus }).from(userSongTable);
        expect(likes).toEqual([{ songId: "s1", likeStatus: 1 }, { songId: "s2", likeStatus: 0 }]);
        expect((await getRequests(db, USER)).every(x => x.requestType === RequestType.ReportDuplicate)).toBe(true);
    });

    it("hides only for the reporter", async () => {
        for (const songId of ["s1", "s2"]) {
            await db.insert(userSongTable).values({ userId: "u2", songId, lastPlayed: new Date(0), version: new Date() });
        }
        await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: "s1", note: null });

        expect(await isSongHiddenAsDuplicate(db, "u2", "s2")).toBe(false);
        expect((await getAllSongDetails(db, "u2")).map(x => x.song.songId)).toContain("s2");
    });

    it("refuses what the server would refuse for good, and leaves nothing behind", async () => {
        await expect(reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s1", kind: "duplicate", preferredSongId: null, note: null })).rejects.toThrow();
        await expect(reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: null, kind: "duplicate", preferredSongId: null, note: null })).rejects.toThrow();
        await expect(reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: "s3", note: null })).rejects.toThrow();

        expect(await db.select().from(songDuplicateReportTable)).toEqual([]);
        expect(await getRequests(db, USER)).toEqual([]);
    });

    it("cuts a note to the server's limit", async () => {
        const report = await reportDuplicate(db, {
            userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: "a".repeat(DUPLICATE_REPORT_MAX_NOTE_LENGTH + 50),
        });
        expect(report.note).toHaveLength(DUPLICATE_REPORT_MAX_NOTE_LENGTH);
    });

    it("a report whose outbox row can't be written hides nothing", async () => {
        await db.run(sql`create trigger refuse_requests before insert on requests begin select raise(abort, 'outbox refused'); end`);

        await expect(reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: null })).rejects.toThrow();

        expect(await getHiddenSongIds(db, USER)).toEqual(new Set());
    });
});

describe("undo", () => {
    let db: GenericDb;
    beforeEach(async () => {
        db = makeDb();
        await addSong(db, "s1", "One");
        await addSong(db, "s2", "Two");
        await addSong(db, "s3", "Three");
    });

    it("withdraws every report hiding the song, queues a withdraw for each, and brings the song back", async () => {
        const a = await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: null });
        const b = await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: null, kind: "differentVersion", preferredSongId: null, note: null });
        await reportDuplicate(db, { userId: USER, songId: "s3", otherSongId: null, kind: "differentVersion", preferredSongId: null, note: null });

        expect(await withdrawDuplicateReports(db, USER, "s1")).toBe(2);

        expect(await isSongHiddenAsDuplicate(db, USER, "s1")).toBe(false);
        expect(await isSongHiddenAsDuplicate(db, USER, "s3")).toBe(true);
        expect((await getAllSongDetails(db, USER)).map(x => x.song.songId).sort()).toEqual(["s1", "s2"]);
        const withdraws = (await getRequests(db, USER)).filter(x => x.requestType === RequestType.WithdrawDuplicateReport);
        expect(withdraws.map(x => (x.payload as { reportId: string }).reportId).sort()).toEqual([a.reportId, b.reportId].sort());
    });

    it("does nothing for a song no report hides", async () => {
        expect(await withdrawDuplicateReports(db, USER, "s2")).toBe(0);
        expect(await getRequests(db, USER)).toEqual([]);
    });

    it("the settings list shows each hidden song once, with the copy it duplicates, and empties after undo", async () => {
        await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: "s2", note: null });

        const hidden = await getHiddenDuplicates(db, USER);
        expect(hidden.map(x => [x.hiddenSongId, x.song?.name, x.otherSong?.name])).toEqual([["s1", "One", "Two"]]);

        await withdrawDuplicateReports(db, USER, "s1");
        expect(await getHiddenDuplicates(db, USER)).toEqual([]);
    });
});

describe("the server's answer to a sent batch", () => {
    let db: GenericDb;
    beforeEach(async () => {
        db = makeDb();
        await addSong(db, "s1", "One");
        await addSong(db, "s2", "Two");
        await addSong(db, "s3", "Three");
    });

    const sentRequests = async () => (await getRequests(db, USER)).filter(x => x.requestType === RequestType.ReportDuplicate) as ReportDuplicateRequest[];

    it("a rejected report is dead-lettered with its reason and stops hiding the song", async () => {
        const report = await reportDuplicate(db, { userId: USER, songId: "s3", otherSongId: null, kind: "differentVersion", preferredSongId: null, note: null });
        const sent = await sentRequests();

        const { stored, failed } = duplicateReportOutcomes<ReportDuplicateRequest, ServerDuplicateReport>(sent, [
            { reportId: report.reportId, outcome: "rejected", error: "Song 's3' is not in your library.", report: null },
        ]);
        await applyDuplicateReportOutcomes(db, USER, sent, stored, failed);

        const deadLetters = await db.select().from(deadLetterRequestTable);
        expect(deadLetters.map(x => [x.requestId, x.requestType, x.reason])).toEqual([
            [report.reportId, RequestType.ReportDuplicate, "Song 's3' is not in your library."],
        ]);
        expect((await db.select().from(songDuplicateReportTable)).map(x => x.status)).toEqual(["rejected"]);
        expect(await isSongHiddenAsDuplicate(db, USER, "s3")).toBe(false);
    });

    it("a recorded report takes the server's row; it stays hidden", async () => {
        const report = await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: null });
        const sent = await sentRequests();
        const server = serverReport({ reportId: report.reportId, version: "2026-11-20T10:00:00.000001Z" });

        const { stored, failed } = duplicateReportOutcomes(sent, [{ reportId: report.reportId, outcome: "recorded", report: server }]);
        await applyDuplicateReportOutcomes(db, USER, sent, stored, failed);

        expect(await db.select().from(deadLetterRequestTable)).toEqual([]);
        expect((await db.select().from(songDuplicateReportTable)).map(x => [x.reportId, x.version, x.status]))
            .toEqual([[report.reportId, "2026-11-20T10:00:00.000001Z", "pending"]]);
        expect(await isSongHiddenAsDuplicate(db, USER, "s1")).toBe(true);
    });

    it("'updated' keeps the earlier report's id: the new row goes, and an undo queued since moves to the server's id", async () => {
        await upsertDuplicateReports(db, USER, [serverReport({ reportId: "earlier" })]);
        const report = await reportDuplicate(db, { userId: USER, songId: "s1", otherSongId: "s2", kind: "duplicate", preferredSongId: null, note: "again" });
        const sent = await sentRequests();
        await withdrawDuplicateReports(db, USER, "s1");

        const { stored, failed } = duplicateReportOutcomes(sent, [
            { reportId: report.reportId, outcome: "updated", report: serverReport({ reportId: "earlier", note: "again" }) },
        ]);
        await applyDuplicateReportOutcomes(db, USER, sent, stored, failed);

        const rows = await db.select().from(songDuplicateReportTable);
        expect(rows.map(x => [x.reportId, x.status])).toEqual([["earlier", "withdrawn"]]);
        const withdraws = (await getRequests(db, USER)).filter(x => x.requestType === RequestType.WithdrawDuplicateReport);
        expect(withdraws.map(x => (x.payload as { reportId: string }).reportId)).toEqual(["earlier", "earlier"]);
        expect(await isSongHiddenAsDuplicate(db, USER, "s1")).toBe(false);
    });
});

describe("duplicateReportOutcomes (a 200 does not mean the report was stored)", () => {
    const request = (reportId: string) => ({ payload: { reportId } });

    it("splits stored from failed, and gives every failure a reason", () => {
        const { stored, failed } = duplicateReportOutcomes(
            [request("a"), request("b"), request("c"), request("d"), request("e")],
            [
                { reportId: "a", outcome: "recorded", report: { id: "a" } },
                { reportId: "b", outcome: "updated", report: { id: "earlier" } },
                { reportId: "c", outcome: "rejected", error: "Not in your library." },
                { reportId: "d", outcome: "recorded", report: null },
            ] as never,
        );

        expect(stored.map(x => [x.request.payload.reportId, x.report])).toEqual([["a", { id: "a" }], ["b", { id: "earlier" }]]);
        expect(failed.map(x => [x.request.payload.reportId, x.reason])).toEqual([
            ["c", "Not in your library."],
            ["d", "The server reported the duplicate report as recorded but sent no report back."],
            ["e", "The server returned no outcome for this duplicate report."],
        ]);
    });

    it("an outcome this build doesn't know is a failure, not a success", () => {
        const { stored, failed } = duplicateReportOutcomes([request("a")], [{ reportId: "a", outcome: "deferred", report: { id: "a" } }]);
        expect(stored).toEqual([]);
        expect(failed[0].reason).toBe("The server reported the duplicate report as deferred, with no reason.");
    });

    it("a missing body fails every report rather than throwing", () => {
        expect(duplicateReportOutcomes([request("a")], undefined).failed).toHaveLength(1);
    });
});

describe("mergeDuplicateReports: the pull against what is still queued", () => {
    it("leaves a report with its own POST still queued as it is, and stores one with a withdraw queued as withdrawn", () => {
        const merged = mergeDuplicateReports(
            [{ reportId: "a", status: "pending" as const }, { reportId: "b", status: "pending" as const }, { reportId: "c", status: "keptBoth" as const }],
            [
                { requestType: RequestType.ReportDuplicate, payload: { reportId: "a" } },
                { requestType: RequestType.WithdrawDuplicateReport, payload: { reportId: "b" } },
                { requestType: RequestType.SetSongLikeStatus },
            ],
        );

        expect(merged).toEqual([{ reportId: "b", status: "withdrawn" }, { reportId: "c", status: "keptBoth" }]);
    });
});

describe("duplicateReportFeedStart", () => {
    const key = JSON.stringify({ userId: USER, version: "2026-11-01T00:00:00.123456Z", reportId: "r9" });

    it("pages on from this user's stored key", () => {
        expect(duplicateReportFeedStart(key, USER, true)).toEqual({ afterDate: "2026-11-01T00:00:00.123456Z", afterId: "r9" });
    });

    it("starts over for another account's key, a lost local table, no key, or a malformed one", () => {
        expect(duplicateReportFeedStart(key, "u2", true)).toEqual({ afterDate: FEED_START });
        expect(duplicateReportFeedStart(key, USER, false)).toEqual({ afterDate: FEED_START });
        expect(duplicateReportFeedStart(null, USER, true)).toEqual({ afterDate: FEED_START });
        expect(duplicateReportFeedStart("{nope", USER, true)).toEqual({ afterDate: FEED_START });
    });
});

describe("holdBehindRefused with duplicate reports", () => {
    it("a refused report holds its own withdraw and nothing else, not even a like on the same song", () => {
        const report = { id: "x", requestType: RequestType.ReportDuplicate, songId: "s1", payload: { reportId: "r1" } };
        const refused = new Set<string>();
        markRefused([report], refused);

        const { ready, held } = holdBehindRefused([
            { id: "a", requestType: RequestType.WithdrawDuplicateReport, payload: { reportId: "r1" } },
            { id: "b", requestType: RequestType.WithdrawDuplicateReport, payload: { reportId: "r2" } },
            { id: "c", requestType: RequestType.SetSongLikeStatus, songId: "s1" },
        ], refused);
        expect(held.map(x => x.id)).toEqual(["a"]);
        expect(ready.map(x => x.id)).toEqual(["b", "c"]);
    });
});

describe("getDuplicateCandidates", () => {
    it("offers only the user's library, minus what they've hidden, with every artist", async () => {
        const db = makeDb();
        await addSong(db, "s1", "One", { artist: "A" });
        await addSong(db, "s2", "Two", { artist: "B" });
        await addSong(db, "s3", "Three");
        await addSong(db, "theirs", "Theirs", { userId: "u2" });
        await reportDuplicate(db, { userId: USER, songId: "s3", otherSongId: null, kind: "differentVersion", preferredSongId: null, note: null });

        const candidates = await getDuplicateCandidates(db, USER);
        expect(candidates.map(x => [x.songId, x.artists])).toEqual([["s1", ["A"]], ["s2", ["B"]]]);
    });
});
