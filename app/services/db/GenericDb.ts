import { ExtractTablesWithRelations } from "drizzle-orm";
import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { SQLiteRunResult } from "expo-sqlite";

export type GenericDb = ExpoSQLiteDatabase | SQLiteTransaction<"sync", SQLiteRunResult, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;
