import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { usersTable } from "./db/schema";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./db/drizzle/migrations"
import { DBProvider, useDB } from "./db/db";
import UserCount from "./userCount";

export default function HomePage() {
    const db = useDB();

    if (db != null) {
        (async () => {
            await db.insert(usersTable).values([{
                id: Math.floor(Math.random() * 1000000)
            }]);
        })();
    }

    return (
        <View
            style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
            }}
            >
            <Text>Edit app/index.tsx to edit this screen.</Text>
            <UserCount/>
        </View>
    );
}
