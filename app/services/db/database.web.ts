import * as SQLite from "expo-sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { GenericDb } from "./GenericDb";

/**
 * Web/desktop database handle. Metro picks this over `database.ts` for the web platform.
 *
 * The native build calls `SQLite.openDatabaseSync` and wraps it with `drizzle-orm/expo-sqlite`, which is a
 * SYNCHRONOUS driver. That cannot work here: expo-sqlite's web backend runs sqlite-wasm in a worker over
 * OPFS, and driving it synchronously fails with "Sync operation timeout". So this build uses the ASYNC
 * expo-sqlite API and bridges it to `drizzle-orm/sqlite-proxy` — the driver-agnostic Drizzle adapter, whose
 * contract is exactly "hand me (sql, params, method), give me back rows".
 *
 * That pairing is why `GenericDb` was widened to accept async drivers: the schema, all 71 query functions,
 * the SyncManager and the outbox then run here byte-for-byte identical to native.
 *
 * Storage is OPFS, which requires a secure context and cross-origin isolation. The Electron shell supplies
 * both (custom `app://` scheme + COOP/COEP headers), so the browser-side caveats about those headers
 * blocking cross-origin media do not apply on desktop.
 */
const dbName = "shuffull-db";

let native: SQLite.SQLiteDatabase | null = null;
let db: GenericDb | null = null;

/**
 * Runs a query and returns rows as arrays of values IN COLUMN ORDER, which is what sqlite-proxy expects.
 *
 * `getAllAsync` cannot be used for this. It returns row OBJECTS keyed by column name, and a join whose sides
 * share a column name (`songs.name` and `artists.name`, say) collapses to a single key — so `Object.values()`
 * yields fewer values than the query has columns and every column after the collision shifts by one. The
 * visible symptom was song rows rendering the artist as the title with a blank artist beneath it.
 *
 * `executeForRawResultAsync` hands back the raw value array instead, so duplicate column names stay distinct.
 * It is marked "advanced use only" rather than private; the alternative is aliasing every column, which the
 * Drizzle-generated SQL does not do.
 */
async function queryRows(db: SQLite.SQLiteDatabase, source: string, params: any[]): Promise<any[][]> {
    const statement = await db.prepareAsync(source);
    try {
        const result = await statement.executeForRawResultAsync(params);
        return (await result.getAllAsync()) as any[][];
    } finally {
        await statement.finalizeAsync();
    }
}

async function openAsync(): Promise<GenericDb> {
    native = await SQLite.openDatabaseAsync(dbName);

    return drizzle(
        async (sql, params, method) => {
            if (!native) throw new Error("Database is not open.");

            try {
                if (method === "run") {
                    await native.runAsync(sql, params as any[]);
                    return { rows: [] };
                }

                const rows = await queryRows(native, sql, params as any[]);
                // "get" wants a single row, not a list of them.
                return { rows: method === "get" ? (rows[0] ?? []) : rows };
            } catch (e) {
                // Drizzle wraps driver failures in "Failed query: <the entire SQL>", which for a bulk insert is
                // thousands of placeholders and buries the actual SQLite message. Log the real one, plus the
                // parameter count, since exceeding the bind-variable limit is the failure this most often is.
                console.error(
                    `SQLite ${method} failed (${params?.length ?? 0} params): ${(e as Error)?.message ?? e}`,
                );
                throw e;
            }
        },
        async (queries) => {
            // Batch driver: sqlite-proxy issues these together; expo-sqlite has no batch API, so run in order.
            const results = [];
            for (const q of queries) {
                if (!native) throw new Error("Database is not open.");
                if (q.method === "run") {
                    await native.runAsync(q.sql, q.params as any[]);
                    results.push({ rows: [] });
                } else {
                    const rows = await queryRows(native, q.sql, q.params as any[]);
                    results.push({ rows: q.method === "get" ? (rows[0] ?? []) : rows });
                }
            }
            return results;
        },
    );
}

/**
 * Opening is async here (it is synchronous on native), so the handle is prepared once and awaited by the
 * provider before anything queries it.
 */
export async function initDbAsync(): Promise<GenericDb> {
    if (!db) db = await openAsync();
    return db;
}

export function getDb(): GenericDb {
    if (!db) {
        // Surfacing this loudly beats handing back a half-open handle and failing deep inside a query.
        throw new Error("Web database accessed before initDbAsync() completed.");
    }
    return db;
}

/** Drop and recreate — the web counterpart of the native reset, used when migrations cannot be applied. */
export async function resetDbAsync(): Promise<GenericDb> {
    try {
        await native?.closeAsync();
        await SQLite.deleteDatabaseAsync(dbName);
    } catch {
        // A missing or already-closed database is not worth failing the reset over.
    }
    db = null;
    native = null;
    return initDbAsync();
}
