import { sql } from "drizzle-orm";
import { GenericDb } from "./GenericDb";

/**
 * Runs `work` inside one SQLite transaction and returns its result. Use this, not `db.transaction()`, for any
 * write that has to be all-or-nothing.
 *
 * `db.transaction()` is not one on the phone. Drizzle's expo-sqlite session runs `BEGIN`, calls the callback, and
 * runs `COMMIT` as soon as the callback RETURNS, without awaiting it. Every query function here is async, so the
 * callback returns a promise at its first `await`: the commit lands before any of its writes, each write then
 * autocommits on its own, and a throw halfway rolls nothing back (ShuffullApp#91). (better-sqlite3's driver refuses
 * an async callback outright; only the web driver, sqlite-proxy, awaits it.)
 *
 * This issues the statements itself and awaits the work between them, which is correct on every driver. It runs on
 * the shared connection, not a second one: expo-sqlite's `withExclusiveTransactionAsync` would open another
 * connection, and every other write while it held the lock would fail with "database is locked".
 *
 * Sharing the connection means anything written through the plain `db` while `work` is awaiting lands inside this
 * transaction, and is rolled back with it. Two rules keep that from costing a user decision:
 *
 * - Transactions run one at a time. A second one waits for the first to commit or roll back.
 * - `work` gets its own handle on the connection. Pass THAT to everything it calls: a `withTransaction` called with
 *   it joins this transaction instead of queueing behind it. One called with the plain `db` from inside `work` would
 *   wait for `work` to finish, and so never run.
 *
 * So the outbox writers (`addRequests`, `enqueueSongRetag`) each run in a transaction of their own. A Keep queued
 * while sync is writing waits for the sync to finish, and commits whether or not the sync did. Writes that don't go
 * through here (playback progress, download state) can still be caught in a sync's rollback; keep `work` short and
 * free of network and file I/O.
 */
export async function withTransaction<T>(db: GenericDb, work: (tx: GenericDb) => Promise<T>): Promise<T> {
    if (openTransactions.has(db)) {
        return work(db);
    }

    const run = queue.then(() => runTransaction(db, work));
    queue = run.catch(() => {});
    return run;
}

// Handles of the transactions currently open, so a nested call can tell it is already inside one.
const openTransactions = new WeakSet<object>();
// The tail of the line of transactions waiting to run. Never rejects, so one failure doesn't stop the next.
let queue: Promise<unknown> = Promise.resolve();

async function runTransaction<T>(db: GenericDb, work: (tx: GenericDb) => Promise<T>): Promise<T> {
    // Same connection, separate identity: it inherits every query method from `db`, and only it is marked open.
    const tx: GenericDb = Object.create(db);
    openTransactions.add(tx);

    try {
        await db.run(sql`begin exclusive`);
        try {
            const result = await work(tx);
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
    } finally {
        openTransactions.delete(tx);
    }
}
