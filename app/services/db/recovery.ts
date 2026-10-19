import { sql } from "drizzle-orm";
import { GenericDb } from "./GenericDb";
import { namedRows } from "./queries/_rawRow";

/**
 * Last-resort recovery when the on-device schema cannot be migrated: rebuild the schema from scratch, but keep
 * the tables that hold data the server does not have.
 *
 * Most of the local database is a cache of the server, and a re-sync restores it. These tables are not:
 *   requests              the outbox. A queued Keep, Like or playlist delete exists nowhere else until it is sent.
 *   dead_letter_requests  the only record that queued work did not happen.
 *   genre_jam             user-made presets. Nothing syncs them.
 * Deleting the database file used to take all three with it (ShuffullApp#92).
 *
 * The rows never leave the file. In ONE transaction the preserved tables are renamed to `__rescued_<ts>__<table>`
 * and everything else is dropped; the empty file is then migrated, and `restoreRescuedTables` moves the rows into
 * the new tables. A crash at any point leaves them on disk: the rename either happened or didn't, and the restore
 * runs on every start, so it picks up where it stopped. A row the new schema cannot take stays in its rescue
 * table rather than being dropped.
 *
 * Rows copy RAW, column by column, rather than through the Drizzle schema, because the rescued table is on an
 * older schema than the code. Only columns both sides have are copied; a column the new table added takes its
 * default.
 */
const PRESERVED_TABLES = ["requests", "dead_letter_requests", "genre_jam"];
const RESCUE_PREFIX = "__rescued_";

export interface RescueRestore {
    restored: number;
    // Rescue tables still holding rows the new schema refused (or that could not be read). Retried on every start.
    leftInPlace: string[];
}

async function columnsOf(db: GenericDb, table: string): Promise<string[]> {
    // A missing table has no columns.
    const rows = (await db.all(sql`SELECT name FROM pragma_table_info(${table})`)) as unknown[];
    return namedRows<{ name: string }>(rows, ["name"]).map((x) => x.name);
}

async function schemaObjects(db: GenericDb): Promise<{ type: string; name: string }[]> {
    // Indexes go with their tables, and sqlite_* objects are SQLite's own.
    const rows = (await db.all(sql`SELECT type, name FROM sqlite_master
        WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)) as unknown[];
    return namedRows<{ type: string; name: string }>(rows, ["type", "name"]);
}

const isRescue = (name: string) => name.startsWith(RESCUE_PREFIX);

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
        const objects = (await schemaObjects(db)).filter((x) => !isRescue(x.name));

        // Views and triggers first, so nothing still refers to a table while it is renamed or dropped.
        for (const { type, name } of objects.filter((x) => x.type != "table")) {
            await db.run(sql.raw(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`));
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

/**
 * Moves rows out of any rescue tables into the live tables of the same name, deleting each rescued row in the
 * same transaction that writes it, and dropping a rescue table once it is empty. Runs on every start; with no
 * rescue tables it is one query. Never throws: a table it cannot restore stays as it is, and is logged.
 */
export async function restoreRescuedTables(db: GenericDb): Promise<RescueRestore> {
    const result: RescueRestore = { restored: 0, leftInPlace: [] };

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
        let refused = 0;
        let firstError: unknown;

        try {
            const live = new Set(await columnsOf(db, target));
            const shared = (await columnsOf(db, rescue)).filter((c) => live.has(c));
            if (shared.length == 0) {
                throw new Error(`there is no ${target} table to restore into`);
            }

            const select = sql`SELECT rowid, ${sql.join(shared.map((c) => sql.identifier(c)), sql`, `)} FROM ${sql.identifier(rescue)}`;
            const rows = namedRows<Record<string, unknown>>((await db.all(select)) as unknown[], ["rowid", ...shared]);

            await inTransaction(db, async () => {
                for (const row of rows) {
                    // A savepoint per row: one the new schema refuses is rolled back alone and stays rescued.
                    await db.run(sql`SAVEPOINT restore_row`);
                    try {
                        await db.run(sql`INSERT INTO ${sql.identifier(target)} (${sql.join(
                            shared.map((c) => sql.identifier(c)),
                            sql`, `,
                        )}) VALUES (${sql.join(
                            shared.map((c) => sql`${row[c]}`),
                            sql`, `,
                        )})`);
                        await db.run(sql`DELETE FROM ${sql.identifier(rescue)} WHERE rowid = ${row.rowid}`);
                        await db.run(sql`RELEASE restore_row`);
                        restored++;
                    } catch (e) {
                        await db.run(sql`ROLLBACK TO restore_row`);
                        await db.run(sql`RELEASE restore_row`);
                        firstError ??= e;
                        refused++;
                    }
                }

                if (refused == 0) {
                    await db.run(sql`DROP TABLE ${sql.identifier(rescue)}`);
                }
            });
        } catch (e) {
            // Nothing committed for this table; all of it is still rescued.
            firstError = e;
            restored = 0;
        }

        result.restored += restored;
        if (firstError !== undefined) {
            result.leftInPlace.push(rescue);
            const what = refused > 0 ? `${refused} row(s) could not be restored` : "could not be restored";
            console.error(`${rescue}: ${what}; kept in place and retried on every start.`, firstError);
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
