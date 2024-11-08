import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
    id: integer("id").primaryKey()
});

export const localSessionDataTable = sqliteTable("localSessionData", {
    userId: integer("userId").primaryKey(),
    currentPlaylistId: integer("currentPlaylistId").notNull(),
    activelyDownload: integer("activelyDownload", { mode: "boolean" }).notNull(),
    token: text("token").notNull(),
    expiration: integer("expiration", { mode: "timestamp_ms" }),
    hostAddress: text("hostAddress").notNull()
});