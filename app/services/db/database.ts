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

// Tear the database down and recreate it from scratch. Used as a last resort when migrations fail to
// apply against a corrupt/stale on-device schema. Reassigns the module-level handle, so callers must
// read it via getDb() rather than capturing the reference.
export function resetDb(): ExpoSQLiteDatabase {
    MediaManager.clear();
    expoDb.closeSync();
    SQLite.deleteDatabaseSync(dbName);
    expoDb = SQLite.openDatabaseSync(dbName);
    db = drizzle(expoDb);
    MediaManager.setup(db);
    return db;
}
