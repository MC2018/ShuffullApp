import { Text, View } from "react-native";
import { userTable } from "./services/db/schema";
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
