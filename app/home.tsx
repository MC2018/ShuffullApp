import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { userTable } from "./services/db/schema";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./services/db/drizzle/migrations"
import { DbProvider, useDb } from "./services/db/dbProvider";
import UserCount from "./userCount";

export default function HomePage() {
    const db = useDb();

    if (db != null) {
        (async () => {
            await db.insert(userTable).values([{
                userId: Math.floor(Math.random() * 1000000),
                username: "oi",
                version: new Date()
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
