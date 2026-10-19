import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { Text, View } from "react-native";
import migrations from "./drizzle/migrations";
import { getDb, resetDb } from "./database";
import { rebuildKeepingLocalData, restoreRescuedTables } from "./recovery";
import { MediaManager } from "../media-manager";

const DbContext = createContext<ExpoSQLiteDatabase | null>(null);

interface DbProviderProps {
    children: ReactNode;
}

// Owns the database lifecycle for the whole app: runs Drizzle migrations, recovers from a bad schema,
// initialises the MediaManager, and only exposes the handle (and renders children) once the schema is
// ready. Previously this logic was tangled into the god-component in index.tsx.
//
// Migrations run once, in an effect, and are awaited. They used to run through `useMigrations` with the
// recovery in the render body: it repeated on every re-render while the error stood, its un-awaited
// `migrate()` could fail without the catch seeing it, and the children rendered against the broken schema
// regardless (ShuffullApp#92).
export const DbProvider = ({ children }: DbProviderProps) => {
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                try {
                    await migrate(getDb(), migrations);
                    // Finishes a rebuild a crash interrupted; with nothing rescued it is one query.
                    await restoreRescuedTables(getDb());
                } catch (e) {
                    // Last resort: rebuild the schema from scratch. The outbox, dead letters and genre jams are
                    // carried across inside the file (recovery.ts); the rest is a cache of the server and comes
                    // back on the next sync.
                    console.warn("Migrations failed; rebuilding the database.", e);
                    await rebuildKeepingLocalData(getDb(), (db) => migrate(db, migrations), resetDb);
                }
            } catch (fatal) {
                console.error("Database unavailable.", fatal);
                if (!cancelled) {
                    setFailure(String(fatal));
                }
                return;
            }

            if (!cancelled) {
                setReady(true);
            }
            MediaManager.setup(getDb()).catch((e) => console.error("MediaManager setup failed.", e));
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    if (failure) {
        return (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
                <Text>Database unavailable: {failure}</Text>
            </View>
        );
    }

    // Hold the tree until the schema is ready, so no screen queries a not-yet-migrated database.
    if (!ready) {
        return (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Text>Loading...</Text>
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
