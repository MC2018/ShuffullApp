import * as SQLite from "expo-sqlite";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { MediaManager } from "../media-manager";

// The local SQLite database is a process-wide singleton: it is opened once on module load and shared
// through DbProvider. Keeping it here (rather than inside a component) means the handle survives
// navigation/auth changes and is reachable from non-React code (auth service, expiry watcher).
const dbName = "shuffull-db";
let expoDb = SQLite.openDatabaseSync(dbName);
let db: ExpoSQLiteDatabase = drizzle(expoDb);

export function getDb(): ExpoSQLiteDatabase {
    return db;
}

// Delete the database file and open a new, empty one. Only for a file too damaged for recovery.ts to
// rebuild in place, so whatever it held, outbox included, is lost. Reassigns the module-level handle, so
// callers must read it via getDb() rather than capturing the reference. The caller migrates the new
// database, then sets up the MediaManager.
export function resetDb(): ExpoSQLiteDatabase {
    MediaManager.clear();
    expoDb.closeSync();
    SQLite.deleteDatabaseSync(dbName);
    expoDb = SQLite.openDatabaseSync(dbName);
    db = drizzle(expoDb);
    return db;
}
