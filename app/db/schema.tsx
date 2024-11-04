import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// integer("id", { mode: "boolean" })
// integer("id", { mode: "timestamp" })
// integer("id", { mode: "timestamp_ms" })

export const usersTable = sqliteTable("users", {
    id: integer("id").primaryKey()
});