import { sql } from "drizzle-orm";
import { GenericDb } from "./GenericDb";
import { namedRows } from "./queries/_rawRow";

/**
 * Last-resort recovery when the on-device schema cannot be migrated: rebuild the database from scratch, but
 * carry the outbox across.
 *
 * The local database is mostly a cache of the server, and a re-sync restores it. The outbox is not: a queued
 * Keep, Like or playlist delete exists nowhere else until it is sent, and a dead-lettered row is the only record
 * that queued work did not happen. Deleting the file used to take both with it (ShuffullApp#92).
 *
 * Rows are copied RAW, column by column, rather than through the Drizzle schema, because the old table is by
 * definition on an older schema than the code. Only columns both sides have are copied; a column the fresh
 * table added takes its default.
 */
export const OUTBOX_TABLES = ["requests", "dead_letter_requests"] as const;

interface SavedTable {
    table: string;
    columns: string[];
    rows: Record<string, unknown>[];
}

export interface OutboxRestore {
    restored: number;
    // Rows that could not be written back. Logged in full, so they are at least recoverable from the device log.
    lost: { table: string; row: Record<string, unknown>; error: string }[];
}

async function columnsOf(db: GenericDb, table: string): Promise<string[]> {
    // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk. A missing table returns no rows.
    const rows = (await db.all(sql.raw(`PRAGMA table_info("${table}")`))) as unknown[];
    return namedRows<{ cid: number; name: string }>(rows, ["cid", "name"]).map((x) => x.name);
}

/**
 * Reads the outbox tables out of a database whose migration just failed. A table that is missing (a schema older
 * than the outbox) or unreadable contributes nothing rather than stopping the rebuild: the app has to start.
 */
export async function saveOutbox(db: GenericDb): Promise<SavedTable[]> {
    const saved: SavedTable[] = [];

    for (const table of OUTBOX_TABLES) {
        try {
            const columns = await columnsOf(db, table);
            if (columns.length == 0) {
                continue;
            }

            const select = `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}"`;
            const rows = (await db.all(sql.raw(select))) as unknown[];
            saved.push({ table, columns, rows: namedRows<Record<string, unknown>>(rows, columns) });
        } catch (e) {
            console.error(`Could not read ${table} before rebuilding the database; its rows are lost.`, e);
        }
    }

    return saved;
}

/** Writes saved outbox rows into a freshly migrated database. Never throws; anything it can't write is in `lost`. */
export async function restoreOutbox(db: GenericDb, saved: SavedTable[]): Promise<OutboxRestore> {
    const result: OutboxRestore = { restored: 0, lost: [] };

    for (const { table, columns, rows } of saved) {
        let shared: string[];
        try {
            const fresh = new Set(await columnsOf(db, table));
            shared = columns.filter((c) => fresh.has(c));
        } catch (e) {
            shared = [];
        }

        for (const row of rows) {
            try {
                if (shared.length == 0) {
                    throw new Error(`the rebuilt database has no ${table} table`);
                }

                await db.run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
                    shared.map((c) => sql.identifier(c)),
                    sql`, `,
                )}) VALUES (${sql.join(
                    shared.map((c) => sql`${row[c]}`),
                    sql`, `,
                )})`);
                result.restored++;
            } catch (e) {
                result.lost.push({ table, row, error: String((e as Error)?.message ?? e) });
            }
        }
    }

    for (const lost of result.lost) {
        console.error(`Outbox row lost in the database rebuild (${lost.table}): ${lost.error}`, JSON.stringify(lost.row));
    }

    return result;
}

/**
 * Save the outbox, rebuild, migrate, restore. `reset` deletes and reopens the database; `migrate` applies the
 * schema. If the rebuild itself fails, the saved rows are logged before the error propagates, since the file
 * they came from no longer exists.
 */
export async function rebuildKeepingOutbox(
    current: GenericDb,
    reset: () => GenericDb | Promise<GenericDb>,
    migrate: (db: GenericDb) => Promise<unknown>,
): Promise<{ db: GenericDb; outbox: OutboxRestore }> {
    const saved = await saveOutbox(current);

    let fresh: GenericDb;
    try {
        fresh = await reset();
        await migrate(fresh);
    } catch (e) {
        console.error("Database rebuild failed; the outbox rows it was carrying:", JSON.stringify(saved));
        throw e;
    }

    const outbox = await restoreOutbox(fresh, saved);
    console.warn(`Database rebuilt; kept ${outbox.restored} outbox row(s), lost ${outbox.lost.length}.`);
    return { db: fresh, outbox };
}
