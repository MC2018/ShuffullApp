import { getTableColumns, sql } from "drizzle-orm";
import { GenericDb } from "./GenericDb";
import { Request } from "./models";
import { namedRows } from "./queries/_rawRow";
import { deadLetterRequests } from "./queries/request";
import { requestTable } from "./schema";

/**
 * Opening the database, and the last-resort recovery when the on-device schema cannot be migrated: rebuild the
 * schema from scratch, but keep the tables that hold data the server does not have.
 *
 * Most of the local database is a cache of the server, and a re-sync restores it. These tables are not:
 *   requests              the outbox. A queued Keep, Like or playlist delete exists nowhere else until it is sent.
 *   dead_letter_requests  the only record that queued work did not happen.
 *   genre_jam             user-made presets. Nothing syncs them.
 * Deleting the database file used to take all three with it (ShuffullApp#92).
 *
 * The rows never leave the file. In ONE transaction the preserved tables are renamed to `__rescued_<ts>__<table>`
 * and everything else is dropped; the emptied file is then migrated, and `restoreRescuedTables` moves the rows into
 * the new tables. A crash at any point leaves them on disk: the rename either happened or didn't, and the restore
 * runs on every start, so it picks up where it stopped. An outbox row the new schema refuses is dead-lettered with
 * the reason, like any other request that can't be sent; anything else it refuses stays in its rescue table.
 *
 * Rows copy RAW, column by column, rather than through the Drizzle schema, because the rescued table is on an
 * older schema than the code. Only columns both sides have are copied; a column the new table added takes its
 * default.
 */
const PRESERVED_TABLES = ["requests", "dead_letter_requests", "genre_jam"];
const RESCUE_PREFIX = "__rescued_";

export interface RescueRestore {
    restored: number;
    // Outbox rows the new schema refused, now in dead_letter_requests with the reason.
    deadLettered: number;
    // Rescue tables still holding rows (refused, or unreadable). Retried on every start.
    leftInPlace: string[];
}

async function columnsOf(db: GenericDb, table: string): Promise<string[]> {
    // A missing table has no columns.
    const rows = (await db.all(sql`SELECT name FROM pragma_table_info(${table})`)) as unknown[];
    return namedRows<{ name: string }>(rows, ["name"]).map((x) => x.name);
}

async function schemaObjects(db: GenericDb): Promise<{ type: string; name: string; tableName: string }[]> {
    // sqlite_* objects (including the automatic indexes behind PRIMARY KEY and UNIQUE) are SQLite's own.
    const rows = (await db.all(sql`SELECT type, name, tbl_name FROM sqlite_master
        WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)) as unknown[];
    return namedRows<{ type: string; name: string; tbl_name: string }>(rows, ["type", "name", "tbl_name"])
        .map((x) => ({ type: x.type, name: x.name, tableName: x.tbl_name }));
}

const isRescue = (name: string) => name.startsWith(RESCUE_PREFIX);

// Drizzle wraps driver errors as "Failed query: <sql>"; the SQLite message is on `cause`.
function reasonOf(e: unknown): string {
    const error = e as { message?: string; cause?: { message?: string } } | undefined;
    return error?.cause?.message ?? error?.message ?? String(e);
}

// Raw BEGIN/COMMIT rather than `db.transaction()`: the native driver's transaction callback is synchronous, and
// this has to run the same way on the async web driver.
async function inTransaction(db: GenericDb, work: () => Promise<void>): Promise<void> {
    await db.run(sql`BEGIN`);
    try {
        await work();
        await db.run(sql`COMMIT`);
    } catch (e) {
        await db.run(sql`ROLLBACK`);
        throw e;
    }
}

/** Renames the preserved tables out of the way and drops everything else, atomically. */
async function setAside(db: GenericDb): Promise<void> {
    const stamp = Date.now();

    await inTransaction(db, async () => {
        const objects = (await schemaObjects(db)).filter((x) => !isRescue(x.tableName));

        // Triggers, views and indexes first. Index names are global in SQLite and an index follows its table
        // through a rename, so one left on a rescued table would collide with the index the migrations recreate.
        for (const type of ["trigger", "view", "index"]) {
            for (const { name } of objects.filter((x) => x.type == type)) {
                await db.run(sql`DROP ${sql.raw(type.toUpperCase())} IF EXISTS ${sql.identifier(name)}`);
            }
        }
        for (const { name } of objects.filter((x) => x.type == "table")) {
            if (PRESERVED_TABLES.includes(name)) {
                await db.run(sql`ALTER TABLE ${sql.identifier(name)} RENAME TO ${sql.identifier(`${RESCUE_PREFIX}${stamp}__${name}`)}`);
            } else {
                await db.run(sql`DROP TABLE IF EXISTS ${sql.identifier(name)}`);
            }
        }
    });
}

// A rescued outbox row (raw column values) back in the shape the request queries take.
function toRequest(row: Record<string, unknown>): Request {
    const request: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(getTableColumns(requestTable))) {
        const raw = row[column.name];
        request[key] = raw == null ? null : column.mapFromDriverValue(raw);
    }
    return request as unknown as Request;
}

/**
 * Moves rows out of any rescue tables into the live tables of the same name, deleting each rescued row in the
 * same transaction that writes it, and dropping a rescue table once it is empty. Runs on every start; with no
 * rescue tables it is one query. Never throws: what it cannot restore stays where it is, and is logged.
 */
export async function restoreRescuedTables(db: GenericDb): Promise<RescueRestore> {
    const result: RescueRestore = { restored: 0, deadLettered: 0, leftInPlace: [] };

    let rescues: string[];
    try {
        rescues = (await schemaObjects(db)).filter((x) => x.type == "table" && isRescue(x.name)).map((x) => x.name).sort();
    } catch (e) {
        console.error("Could not look for rescued tables.", e);
        return result;
    }

    for (const rescue of rescues) {
        const target = rescue.slice(rescue.lastIndexOf("__") + 2);
        let restored = 0;
        let deadLettered = 0;
        let refused = 0;
        let failure: unknown;

        try {
            // Every column, so a dead-lettered request keeps the ones the new table no longer has.
            const columns = await columnsOf(db, rescue);
            const live = new Set(await columnsOf(db, target));
            const shared = columns.filter((c) => live.has(c));
            if (shared.length == 0) {
                throw new Error(`there is no ${target} table to restore into`);
            }

            const select = sql`SELECT rowid, ${sql.join(columns.map((c) => sql.identifier(c)), sql`, `)} FROM ${sql.identifier(rescue)}`;
            const rows = namedRows<Record<string, unknown>>((await db.all(select)) as unknown[], ["rowid", ...columns]);
            const deleteRescued = (row: Record<string, unknown>) =>
                db.run(sql`DELETE FROM ${sql.identifier(rescue)} WHERE rowid = ${row.rowid}`);

            await inTransaction(db, async () => {
                for (const row of rows) {
                    // A savepoint per row: one the new schema refuses is rolled back alone.
                    await db.run(sql`SAVEPOINT restore_row`);
                    try {
                        await db.run(sql`INSERT INTO ${sql.identifier(target)} (${sql.join(
                            shared.map((c) => sql.identifier(c)),
                            sql`, `,
                        )}) VALUES (${sql.join(
                            shared.map((c) => sql`${row[c]}`),
                            sql`, `,
                        )})`);
                        await deleteRescued(row);
                        await db.run(sql`RELEASE restore_row`);
                        restored++;
                        continue;
                    } catch (e) {
                        await db.run(sql`ROLLBACK TO restore_row`);
                        failure ??= e;
                    }

                    // An outbox row that can't go back into the outbox is a request that can't be sent: dead-letter
                    // it with the reason, where the playlist-delete hold and anyone reading the device can see it.
                    if (target == "requests") {
                        try {
                            const reason = `Could not be restored after a database rebuild: ${reasonOf(failure)}`;
                            await deadLetterRequests(db, [{ request: toRequest(row), reason }]);
                            await deleteRescued(row);
                            await db.run(sql`RELEASE restore_row`);
                            deadLettered++;
                            continue;
                        } catch {
                            await db.run(sql`ROLLBACK TO restore_row`);
                        }
                    }

                    await db.run(sql`RELEASE restore_row`);
                    refused++;
                }

                if (refused == 0) {
                    await db.run(sql`DROP TABLE ${sql.identifier(rescue)}`);
                }
            });
        } catch (e) {
            // Rolled back: nothing committed for this table, and all of it is still rescued.
            result.leftInPlace.push(rescue);
            console.error(`${rescue} could not be restored; kept in place and retried on every start.`, e);
            continue;
        }

        result.restored += restored;
        result.deadLettered += deadLettered;
        if (deadLettered > 0) {
            console.error(`${rescue}: ${deadLettered} request(s) the rebuilt schema refused were dead-lettered.`, failure);
        }
        if (refused > 0) {
            result.leftInPlace.push(rescue);
            console.error(`${rescue}: ${refused} row(s) could not be restored; kept in place and retried on every start.`, failure);
        }
    }

    if (result.restored > 0) {
        console.warn(`Restored ${result.restored} preserved row(s) into the rebuilt database.`);
    }
    return result;
}

/**
 * Rebuilds a database whose migration failed, keeping the preserved tables (see the top of this file).
 *
 * `deleteFile` is the fallback for a file too damaged to rename tables in: it deletes and reopens the database, and
 * what was in the preserved tables is then lost. That is the only path that loses them, and it says so in the log.
 */
export async function rebuildKeepingLocalData<T extends GenericDb>(
    current: T,
    migrate: (db: T) => Promise<unknown>,
    deleteFile: () => T | Promise<T>,
): Promise<T> {
    let db = current;
    try {
        await setAside(db);
    } catch (e) {
        console.error("Could not set the outbox aside in the damaged database; deleting it. Its outbox, dead letters and genre jams are lost.", e);
        db = await deleteFile();
    }

    await migrate(db);
    await restoreRescuedTables(db);
    return db;
}

/**
 * What both DbProviders do on start: migrate, finish any rebuild a crash interrupted, and fall back to the rebuild
 * when migrating fails. Returns the handle to use, which is a new one only if the file had to be deleted. Throws
 * only if the rebuilt database cannot be migrated either.
 */
export async function prepareDatabase<T extends GenericDb>(
    db: T,
    migrate: (db: T) => Promise<unknown>,
    deleteFile: () => T | Promise<T>,
): Promise<T> {
    try {
        await migrate(db);
    } catch (e) {
        console.warn("Migrations failed; rebuilding the database.", e);
        return rebuildKeepingLocalData(db, migrate, deleteFile);
    }

    // With nothing rescued this is one query.
    await restoreRescuedTables(db);
    return db;
}
