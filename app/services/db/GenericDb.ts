import { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core";

/**
 * A SQLite database handle, independent of which driver opened it.
 *
 * Every query function takes one of these, so this single type is what decides whether the data layer is
 * portable. It used to name `ExpoSQLiteDatabase` specifically, which pinned all 71 query functions to the
 * native driver even though not one of them touches anything driver-specific. Widening it to Drizzle's
 * common ancestor lets the same schema, queries and migrations run wherever the app does:
 *
 *   mobile   drizzle-orm/expo-sqlite      (sync)
 *   desktop  drizzle-orm/better-sqlite3   (sync)   — Electron's main process has real native SQLite
 *   web      drizzle-orm/sqlite-proxy     (async)  — SQLocal over OPFS
 *
 * `"sync" | "async"` is the load-bearing part: the web driver can only ever be async (an OPFS worker cannot
 * be called synchronously), so a sync-only type would have excluded the browser outright. Every query here
 * already awaits its result, so admitting async costs nothing.
 *
 * The remaining type arguments are deliberately loose — pinning TRunResult or the schema would drag driver
 * specifics straight back in, and no query depends on either.
 */
export type GenericDb =
    | BaseSQLiteDatabase<"sync" | "async", any, any, any>
    // Transactions are handed to the same query functions, so they must satisfy the same type.
    | SQLiteTransaction<"sync" | "async", any, any, any>;
