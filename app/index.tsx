import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { usersTable } from "./db/schema";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./db/drizzle/migrations"
import { DBProvider } from "./db/db";
import UserCount from "./userCount";
import HomePage from "./home";
import LoginPage from "./login";
import { useState } from "react";

const expo = SQLite.openDatabaseSync("shuffull-db");
const db = drizzle(expo);

export default function Index() {
    const { success, error } = useMigrations(db, migrations);
    const loggedIn = false; // TODO: needs to be set via reading database
  
    (async () => {
        await db.insert(usersTable).values([{
            id: Math.floor(Math.random() * 1000000)
        }]);
    })();

    return (
        <DBProvider db={db}>
            {loggedIn ? (
                <HomePage />
            ) : (
                <LoginPage />
            )}
        </DBProvider>
    );
}
