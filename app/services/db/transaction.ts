import { sql } from "drizzle-orm";
import { GenericDb } from "./GenericDb";

/**
 * Runs `work` inside one SQLite transaction and returns its result. Use this, not `db.transaction()`, for any
 * write that has to be all-or-nothing.
 *
 * `db.transaction()` is not one on the sync drivers (expo-sqlite on mobile, better-sqlite3 in the tests). Drizzle's
 * sync session runs `BEGIN`, calls the callback, and runs `COMMIT` as soon as the callback RETURNS, without
 * awaiting it. Every query function here is async, so the callback returns a promise at its first `await`: the
 * commit lands before any of its writes, each write then autocommits on its own, and a throw halfway rolls nothing
 * back. Only the async web driver (sqlite-proxy) awaits the callback.
 *
 * This issues the statements itself and awaits the work between them, which is correct on every driver. It runs on
 * the shared connection, not a second one: expo-sqlite's `withExclusiveTransactionAsync` would open another
 * connection, and every other write while it held the lock (a Keep being queued, the progress writer) would fail
 * with "database is locked".
 *
 * The cost of sharing the connection: a statement some other code issues while `work` is awaiting runs inside this
 * transaction, and is rolled back with it if `work` throws. So keep `work` short and free of network or file I/O.
 * Don't nest these, and don't call `db.transaction()` inside one; SQLite has no nested BEGIN.
 */
export async function withTransaction<T>(db: GenericDb, work: (db: GenericDb) => Promise<T>): Promise<T> {
    await db.run(sql`begin exclusive`);

    try {
        const result = await work(db);
        // Inside the try: a failed COMMIT leaves the transaction open, and the next BEGIN would then fail for good.
        await db.run(sql`commit`);
        return result;
    } catch (e) {
        try {
            await db.run(sql`rollback`);
        } catch {
            // SQLite rolls some failures back by itself (a full disk, for one), and then there is nothing left to
            // roll back. The original error is the one worth surfacing.
        }
        throw e;
    }
}
