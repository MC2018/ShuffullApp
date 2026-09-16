import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { sql } from "drizzle-orm";
import migrations from "./drizzle/migrations";
import { getDb, initDbAsync, resetDbAsync } from "./database.web";
import { GenericDb } from "./GenericDb";
import { MediaManager } from "../media-manager";

const DbContext = createContext<GenericDb | null>(null);

interface DbProviderProps {
    children: ReactNode;
}

/**
 * Web/desktop database provider. Metro picks this over `DbProvider.tsx` for the web platform.
 *
 * Two things differ from native. Opening is asynchronous (OPFS), so the tree is held until the handle
 * exists rather than assuming it. And migrations are applied by hand: `useMigrations` comes from
 * `drizzle-orm/expo-sqlite/migrator`, which drives the SYNCHRONOUS driver this build deliberately does not
 * use. The migration data itself is the same `drizzle/migrations` bundle native runs, so both platforms
 * apply an identical schema history — only the runner differs.
 *
 * It DOES initialise the MediaManager, exactly as the native provider does. That was deferred while the web
 * target was being brought up, on the assumption react-native-track-player would drag in native-only setup —
 * but Metro aliases it to an HTMLAudioElement shim here, so there is nothing native left to avoid, and
 * skipping it left mediaManager without a database handle.
 */
async function runMigrations(db: GenericDb) {
    // Bookkeeping table so an already-applied migration is never re-run on this origin. INTEGER PRIMARY KEY
    // (not SERIAL — that is Postgres) is what SQLite wants for an autoincrementing id.
    await db.run(sql`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
    )`);

    const appliedRows = (await db.all(sql`SELECT hash FROM __drizzle_migrations`)) as any[];
    // sqlite-proxy hands rows back as arrays of values, so the hash is column 0.
    const done = new Set(appliedRows.map((r) => (Array.isArray(r) ? r[0] : r.hash)));

    // The bundle Drizzle generates is `{ journal, migrations: { m0000: "...sql", m0001: ... } }` — the SQL
    // is an object keyed by index, and the journal's entries carry the ORDER and the identity (`tag`).
    // Iterating the object directly is what failed: it isn't iterable, and its key order is not the schema's
    // history.
    const bundle = migrations as any;
    const entries: { idx: number; tag: string }[] = bundle.journal?.entries ?? [];

    for (const entry of [...entries].sort((a, b) => a.idx - b.idx)) {
        if (done.has(entry.tag)) {
            continue;
        }

        const key = `m${String(entry.idx).padStart(4, "0")}`;
        const migrationSql: string | undefined = bundle.migrations?.[key];
        if (!migrationSql) {
            continue;
        }

        // Drizzle separates statements with this marker; SQLite executes one at a time.
        for (const statement of migrationSql.split("--> statement-breakpoint")) {
            const text = statement.trim();
            if (text) {
                await db.run(sql.raw(text));
            }
        }

        await db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${entry.tag}, ${Date.now()})`);
    }
}

export const DbProvider = ({ children }: DbProviderProps) => {
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const db = await initDbAsync();
                await runMigrations(db);
                // Same handoff the native provider does. mediaManager keeps the handle in a module-level
                // variable, so without this every playback path dereferenced an undefined db and threw
                // "Cannot read properties of undefined (reading 'select')" — tapping a song did nothing.
                await MediaManager.setup(db);
                if (!cancelled) setReady(true);
            } catch (e) {
                // Same last resort as native: a schema we cannot migrate is rebuilt from scratch. The local
                // database is a cache of the server, so losing it costs a re-sync, not data.
                console.warn("Web migrations failed; rebuilding the database.", e);
                try {
                    const fresh = await resetDbAsync();
                    await runMigrations(fresh);
                    if (!cancelled) setReady(true);
                } catch (fatal) {
                    if (!cancelled) setFailure(String(fatal));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    if (failure) {
        return (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
                <Text style={{ color: "#fff" }}>Database unavailable: {failure}</Text>
            </View>
        );
    }

    // Hold the tree until the schema is ready, so no screen queries a half-built database.
    if (!ready) {
        return (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Text style={{ color: "#fff" }}>Loading...</Text>
            </View>
        );
    }

    return <DbContext.Provider value={getDb()}>{children}</DbContext.Provider>;
};

export const useDb = () => {
    const context = useContext(DbContext);

    if (!context) {
        throw Error("DB Context null.");
    }

    return context;
};
