import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { migrate, useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import { createContext, ReactNode, useContext, useEffect } from "react";
import { Text, View } from "react-native";
import migrations from "./drizzle/migrations";
import { getDb, resetDb } from "./database";
import { MediaManager } from "../media-manager";

const DbContext = createContext<ExpoSQLiteDatabase | null>(null);

interface DbProviderProps {
    children: ReactNode;
}

// Owns the database lifecycle for the whole app: runs Drizzle migrations, recovers from a bad schema,
// initialises the MediaManager, and only exposes the handle (and renders children) once the schema is
// ready. Previously this logic was tangled into the god-component in index.tsx.
export const DbProvider = ({ children }: DbProviderProps) => {
    const { success, error } = useMigrations(getDb(), migrations);

    if (error) {
        try {
            console.log("Problem with migration");
            console.log(error.message);
            resetDb();
            migrate(getDb(), migrations);
            console.log("Migrated successfully");
        } catch (e) {
            console.error("Serious error with migrations: " + e);
        }
    }

    useEffect(() => {
        if (success) {
            MediaManager.setup(getDb());
        }
    }, [success]);

    // Hold the tree until migrations resolve one way or another, to avoid screens querying a
    // not-yet-migrated schema.
    if (!success && !error) {
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
