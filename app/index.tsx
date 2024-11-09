import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle } from "drizzle-orm/expo-sqlite"
import { migrate, useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./services/db/drizzle/migrations"
import { DbProvider } from "./services/db/dbProvider";
import HomePage from "./home";
import LoginPage from "./login";
import { useState } from "react";
import { ApiProvider } from "./services/api/apiProvider";
import { ApiClient } from "./services/api/apiClient";

const dbName = "shuffull-db";
let expoDb = SQLite.openDatabaseSync(dbName);
let db = drizzle(expoDb);

async function resetDb() {
    expoDb.closeSync();
    SQLite.deleteDatabaseSync(dbName);
    expoDb = SQLite.openDatabaseSync(dbName);
    db = drizzle(expoDb);
}

export default function Index() {
    const [apiClient, setApiClient] = useState<ApiClient | null>(null);
    const { success, error } = useMigrations(db, migrations);
    let loggedIn = apiClient != null; // TODO: needs to be updated via reading database
  
    if (error) {
        try {
            console.log("Problem with migration");
            console.log(error.message);
            resetDb();
            migrate(db, migrations);
            loggedIn = false;
        } catch (e) {
            console.error("Serious error with migrations: " + e);
        }
    }

    /*(async () => {
        await db.insert(usersTable).values([{
            id: Math.floor(Math.random() * 1000000)
        }]);
    })();*/

    const handleLogin = (newApiClient: ApiClient) => {
        setApiClient(newApiClient);
        loggedIn = true;
    }

    return (
        <DbProvider db={db}>
        <ApiProvider api={apiClient}>
            {loggedIn ? (
                <HomePage />
            ) : (
                <LoginPage onLogin={handleLogin} />
            )}
        </ApiProvider>
        </DbProvider>
    );
}
