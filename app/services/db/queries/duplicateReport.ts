import { GenericDb } from "../GenericDb";
import { Request, Song, SongDuplicateReport } from "../models";
import {
    DUPLICATE_REPORT_MAX_NOTE_LENGTH,
    DuplicateReportKind,
    ReportDuplicatePayload,
    artistTable,
    requestTable,
    SONG_HIDDEN_STATUSES,
    songArtistTable,
    songDuplicateReportTable,
    songTable,
    userSongTable,
} from "../schema";
import type { DuplicateCandidate } from "@/app/tools/duplicatePicker";
import { withTransaction } from "../transaction";
import { chunkIds, chunkRows } from "./_chunk";
import { addRequests, deadLetterRequests, getRequests } from "./request";
import { RequestType } from "@/app/enums";
import type { SongDuplicateReport as ServerDuplicateReport } from "@/app/services/api/models";
import { hiddenSongOf, mergeDuplicateReports } from "@/app/services/sync-manager/syncLogic";
import { generateId } from "@/app/tools/pure";
import { and, asc, desc, eq, inArray, isNull, SQL, sql, SQLWrapper } from "drizzle-orm";

// Duplicate reports (ShuffullApp#219). Reporting a song hides one copy for this user alone, at once, on every screen
// that lists or picks songs. The report row and its outbox request are written in one transaction, so the hide is the
// user's own durable decision: it holds whether or not the server, or a curator, ever answers. It never touches the
// song's like status: a hidden duplicate is not a Dislike.

/**
 * A WHERE condition: the song in `songId` is not hidden from `userId` by one of their duplicate reports. Every query
 * that lists or picks songs for the user ANDs this in. `songId` is a column, or raw SQL for a hand-written query's alias.
 */
export function notHiddenAsDuplicate(userId: string, songId: SQLWrapper): SQL {
    return sql`NOT EXISTS (SELECT 1 FROM ${songDuplicateReportTable} WHERE ${songDuplicateReportTable.hiddenSongId} = ${songId}
        AND ${songDuplicateReportTable.userId} = ${userId}
        AND ${inArray(songDuplicateReportTable.status, [...SONG_HIDDEN_STATUSES])})`;
}

export interface NewDuplicateReport {
    userId: string;
    songId: string;
    // The song it duplicates. Null for "different version, hide this one".
    otherSongId: string | null;
    kind: DuplicateReportKind;
    // Which copy to keep: songId ("keep this one"), otherSongId ("keep the other"), or null ("let the curator decide").
    preferredSongId: string | null;
    note: string | null;
}

/**
 * Records a report on this device and queues it for the server, in one transaction. The hide applies from this
 * commit on. Checks what the server would refuse for good, so a report can't hide a song here that the server will
 * never hold: both songs must be in the user's library (a user_songs row), as the server requires.
 */
export async function reportDuplicate(db: GenericDb, input: NewDuplicateReport): Promise<SongDuplicateReport> {
    const otherSongId = input.otherSongId || null;
    const preferredSongId = input.preferredSongId || null;
    if (otherSongId === input.songId) {
        throw new Error("A song can't be a duplicate of itself.");
    }
    if (input.kind === "duplicate" && otherSongId == null) {
        throw new Error("A duplicate report needs the song it duplicates.");
    }
    if (preferredSongId != null && preferredSongId !== input.songId && preferredSongId !== otherSongId) {
        throw new Error("The song to keep must be one of the two songs.");
    }

    // The server trims the note and refuses one past its limit, which would leave the report here forever.
    const note = input.note?.replace(/\0/g, "").trim().slice(0, DUPLICATE_REPORT_MAX_NOTE_LENGTH) || null;
    const payload: ReportDuplicatePayload = {
        reportId: generateId(),
        songId: input.songId,
        otherSongId,
        kind: input.kind,
        preferredSongId,
        note,
    };
    const report: SongDuplicateReport = {
        ...payload,
        userId: input.userId,
        hiddenSongId: hiddenSongOf(input.songId, otherSongId, preferredSongId),
        status: "pending",
        createdAt: new Date(),
        version: null,
    };

    await withTransaction(db, async tx => {
        const songIds = otherSongId ? [input.songId, otherSongId] : [input.songId];
        const inLibrary = await tx.select({ songId: userSongTable.songId }).from(userSongTable)
            .where(and(eq(userSongTable.userId, input.userId), inArray(userSongTable.songId, songIds)));
        if (inLibrary.length < songIds.length) {
            throw new Error("Only songs in your library can be reported as a duplicate or hidden.");
        }
        await tx.insert(songDuplicateReportTable).values(report);
        await addRequests(tx, [{
            // The report id, so a resend after a lost response finds the same report on the server.
            requestId: payload.reportId,
            timeRequested: report.createdAt,
            requestType: RequestType.ReportDuplicate,
            userId: input.userId,
            songId: input.songId,
            payload,
        }]);
    });
    return report;
}

/**
 * Undo: withdraws every report that hides `hiddenSongId` from the user, on this device and (queued) on the server, in
 * one transaction. The song is back from this commit on. A withdraw is queued even for a report the server hasn't heard
 * yet: it goes after the report, so the server ends with the report withdrawn either way. Returns how many it withdrew.
 */
export async function withdrawDuplicateReports(db: GenericDb, userId: string, hiddenSongId: string): Promise<number> {
    return await withTransaction(db, async tx => {
        const reports = await getSongHidingReports(tx, userId, hiddenSongId);
        if (!reports.length) {
            return 0;
        }

        await tx.update(songDuplicateReportTable)
            .set({ status: "withdrawn" })
            .where(inArray(songDuplicateReportTable.reportId, reports.map(x => x.reportId)));
        const now = new Date();
        await addRequests(tx, reports.map(x => ({
            requestId: generateId(),
            timeRequested: now,
            requestType: RequestType.WithdrawDuplicateReport,
            userId,
            payload: { reportId: x.reportId },
        })));
        return reports.length;
    });
}

/** The user's reports that hide `songId` from them right now. */
export async function getSongHidingReports(db: GenericDb, userId: string, songId: string): Promise<SongDuplicateReport[]> {
    return await db.select().from(songDuplicateReportTable)
        .where(and(
            eq(songDuplicateReportTable.userId, userId),
            eq(songDuplicateReportTable.hiddenSongId, songId),
            inArray(songDuplicateReportTable.status, [...SONG_HIDDEN_STATUSES])))
        .orderBy(desc(songDuplicateReportTable.createdAt));
}

export async function isSongHiddenAsDuplicate(db: GenericDb, userId: string, songId: string): Promise<boolean> {
    return (await getSongHidingReports(db, userId, songId)).length > 0;
}

/** One hidden song in the settings list: the song (null when this device no longer has it) and its newest report. */
export interface HiddenDuplicate {
    hiddenSongId: string;
    song: Song | null;
    report: SongDuplicateReport;
    // The song the report names as the copy it duplicates, when there is one and this device has it.
    otherSong: Song | null;
}

/** The "Hidden duplicates" list: one row per hidden song, newest report first. */
export async function getHiddenDuplicates(db: GenericDb, userId: string): Promise<HiddenDuplicate[]> {
    const reports = await db.select().from(songDuplicateReportTable)
        .where(and(
            eq(songDuplicateReportTable.userId, userId),
            inArray(songDuplicateReportTable.status, [...SONG_HIDDEN_STATUSES])))
        .orderBy(desc(songDuplicateReportTable.createdAt));

    const newest = new Map<string, SongDuplicateReport>();
    for (const report of reports) {
        if (!newest.has(report.hiddenSongId)) {
            newest.set(report.hiddenSongId, report);
        }
    }

    const songIds = new Set<string>();
    for (const report of newest.values()) {
        songIds.add(report.hiddenSongId);
        const other = otherCopyOf(report);
        if (other) {
            songIds.add(other);
        }
    }
    const songs = new Map<string, Song>();
    for (const ids of chunkIds([...songIds])) {
        for (const song of await db.select().from(songTable).where(inArray(songTable.songId, ids))) {
            songs.set(song.songId, song);
        }
    }

    return [...newest.values()].map(report => {
        const other = otherCopyOf(report);
        return {
            hiddenSongId: report.hiddenSongId,
            song: songs.get(report.hiddenSongId) ?? null,
            report,
            otherSong: other ? songs.get(other) ?? null : null,
        };
    });
}

// The copy a report keeps: the one of its two songs it doesn't hide.
function otherCopyOf(report: SongDuplicateReport): string | null {
    if (report.otherSongId == null) {
        return null;
    }
    return report.hiddenSongId === report.songId ? report.otherSongId : report.songId;
}

/**
 * The songs the user may name as the copy a song duplicates (tools/duplicatePicker orders them): the songs in their
 * library, since the server refuses any other, minus the ones they've hidden.
 */
export async function getDuplicateCandidates(db: GenericDb, userId: string): Promise<DuplicateCandidate[]> {
    const rows = await db
        .select({
            songId: songTable.songId,
            name: songTable.name,
            lastPlayed: userSongTable.lastPlayed,
            artist: artistTable.name,
        })
        .from(userSongTable)
        .innerJoin(songTable, eq(songTable.songId, userSongTable.songId))
        .leftJoin(songArtistTable, eq(songArtistTable.songId, songTable.songId))
        .leftJoin(artistTable, eq(artistTable.artistId, songArtistTable.artistId))
        .where(and(eq(userSongTable.userId, userId), notHiddenAsDuplicate(userId, songTable.songId)))
        .orderBy(asc(songTable.name), asc(songTable.songId));

    const bySong = new Map<string, DuplicateCandidate>();
    for (const row of rows) {
        let candidate = bySong.get(row.songId);
        if (!candidate) {
            candidate = { songId: row.songId, name: row.name, artists: [], lastPlayed: row.lastPlayed };
            bySong.set(row.songId, candidate);
        }
        if (row.artist != null) {
            candidate.artists.push(row.artist);
        }
    }
    return [...bySong.values()];
}

export async function hasDuplicateReports(db: GenericDb, userId: string): Promise<boolean> {
    const rows = await db.select({ reportId: songDuplicateReportTable.reportId })
        .from(songDuplicateReportTable)
        .where(eq(songDuplicateReportTable.userId, userId))
        .limit(1);
    return rows.length > 0;
}

/** Writes reports as the server sent them, in chunked multi-row upserts. Queues nothing. */
export async function upsertDuplicateReports(db: GenericDb, userId: string, reports: ServerDuplicateReport[]): Promise<void> {
    const rows = reports.map((report): SongDuplicateReport => ({
        reportId: report.reportId,
        userId,
        songId: report.songId,
        otherSongId: report.otherSongId,
        kind: report.kind,
        preferredSongId: report.preferredSongId,
        hiddenSongId: report.hiddenSongId,
        status: report.status,
        note: report.note,
        createdAt: report.createdAt,
        version: report.version,
    }));
    for (const chunk of chunkRows(rows)) {
        await db.insert(songDuplicateReportTable).values(chunk).onConflictDoUpdate({
            target: songDuplicateReportTable.reportId,
            set: {
                userId: sql`excluded.user_id`,
                songId: sql`excluded.song_id`,
                otherSongId: sql`excluded.other_song_id`,
                kind: sql`excluded.kind`,
                preferredSongId: sql`excluded.preferred_song_id`,
                hiddenSongId: sql`excluded.hidden_song_id`,
                status: sql`excluded.status`,
                note: sql`excluded.note`,
                createdAt: sql`excluded.created_at`,
                version: sql`excluded.version`,
            },
        });
    }
}

/**
 * Applies the server's answer to a sent batch of reports (syncLogic.duplicateReportOutcomes), in one transaction,
 * before pushAndPull deletes the batch. A stored report replaces the local row with the server's. An "updated" one comes
 * back under the id of the user's earlier report of the same pair: the local row under the new id goes, and a withdraw
 * queued under it is moved to the server's id. A report the server didn't store is dead-lettered with its reason, and
 * its local row marked "rejected", which hides nothing: the server will never hold it.
 */
export async function applyDuplicateReportOutcomes(
    db: GenericDb,
    userId: string,
    sent: Request[],
    stored: { request: Request; report: ServerDuplicateReport }[],
    failed: { request: Request; reason: string }[],
): Promise<void> {
    await withTransaction(db, async tx => {
        if (failed.length) {
            await deadLetterRequests(tx, failed);
            // Only a report the server never held: a resend of a stored one that is now refused leaves the stored one.
            const ids = failed.map(x => (x.request.payload as ReportDuplicatePayload).reportId);
            for (const idChunk of chunkIds(ids)) {
                await tx.update(songDuplicateReportTable)
                    .set({ status: "rejected" })
                    .where(and(
                        inArray(songDuplicateReportTable.reportId, idChunk),
                        eq(songDuplicateReportTable.userId, userId),
                        isNull(songDuplicateReportTable.version)));
            }
        }

        const aliases = new Map<string, string>();
        for (const { request, report } of stored) {
            const sentId = (request.payload as ReportDuplicatePayload).reportId;
            if (sentId !== report.reportId) {
                aliases.set(sentId, report.reportId);
            }
        }
        if (aliases.size) {
            for (const idChunk of chunkIds([...aliases.keys()])) {
                await tx.delete(songDuplicateReportTable).where(and(
                    inArray(songDuplicateReportTable.reportId, idChunk),
                    eq(songDuplicateReportTable.userId, userId)));
            }
        }

        const sentIds = new Set(sent.map(x => x.requestId));
        const outbox = (await getRequests(tx, userId)).filter(x => !sentIds.has(x.requestId));
        for (const request of outbox) {
            const reportId = (request.payload as { reportId?: string } | null)?.reportId;
            const canonical = reportId == undefined ? undefined : aliases.get(reportId);
            if (request.requestType == RequestType.WithdrawDuplicateReport && canonical != undefined) {
                await tx.update(requestTable)
                    .set({ payload: { reportId: canonical } })
                    .where(eq(requestTable.requestId, request.requestId));
                request.payload = { reportId: canonical };
            }
        }

        await upsertDuplicateReports(tx, userId, mergeDuplicateReports(stored.map(x => x.report), outbox));
    });
}
