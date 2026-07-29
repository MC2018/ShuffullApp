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

/** Rows must be arrays of values, in column order — what sqlite-proxy expects. */
function toRows(records: any[]): any[][] {
    return records.map((r) => Object.values(r));
}

async function openAsync(): Promise<GenericDb> {
    native = await SQLite.openDatabaseAsync(dbName);

    return drizzle(
        async (sql, params, method) => {
            if (!native) throw new Error("Database is not open.");

            if (method === "run") {
                await native.runAsync(sql, params as any[]);
                return { rows: [] };
            }

            const records = await native.getAllAsync(sql, params as any[]);
            const rows = toRows(records);
            // "get" wants a single row, not a list of them.
            return { rows: method === "get" ? (rows[0] ?? []) : rows };
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
                    const rows = toRows(await native.getAllAsync(q.sql, q.params as any[]));
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
