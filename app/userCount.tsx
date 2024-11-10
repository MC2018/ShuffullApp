import { Text, View } from "react-native";
import { useDb } from "./services/db/dbProvider";
import { userTable } from "./services/db/schema";
import { useState } from "react";

const UserCount = () => {
    const [userCount, setUserCount] = useState(0);
    const db = useDb();

    (async () => {
        if (db != null) {
            const users = await db.select().from(userTable);
            setUserCount(users.length);
        }
    })();

    return (
        <Text>
            {userCount}
        </Text>
    );
}

export default UserCount;