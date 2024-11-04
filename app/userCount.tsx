import { Text, View } from "react-native";
import { useDB } from "./db/db";
import { usersTable } from "./db/schema";
import { useState } from "react";

const UserCount = () => {
    const [userCount, setUserCount] = useState(0)
    const db = useDB();

    (async () => {
        if (db != null) {
            const users = await db.select().from(usersTable);
        
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