import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { userTable } from "./db/schema";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./db/drizzle/migrations"
import { DbProvider } from "./db/dbProvider";
import UserCount from "./userCount";
import HomePage from "./home";
import LoginPage from "./login";
import { useState } from "react";
import { ApiProvider } from "./services/apiProvider";
import { ApiClient } from "./services/apiClient";

const expo = SQLite.openDatabaseSync("shuffull-db");
const db = drizzle(expo);

export default function Index() {
    const [apiClient, setApiClient] = useState<ApiClient | null>(null);
    const { success, error } = useMigrations(db, migrations);
    let loggedIn = apiClient != null; // TODO: needs to be updated via reading database
  
    if (error) {
        console.log("Problem with migration");
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
