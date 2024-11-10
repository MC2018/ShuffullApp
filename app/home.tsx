import { Button, Text, View } from "react-native";
import { localSessionDataTable, userTable } from "./services/db/schema";
import { DbProvider, useDb } from "./services/db/dbProvider";
import UserCount from "./userCount";
import { useEffect, useState } from "react";
import { eq } from "drizzle-orm";
import { LocalSessionData } from "./services/db/models";

interface HomeProps {
    userId: number;
    onLogout: () => void;
}

export default function HomePage({ userId, onLogout }: HomeProps) {
    const [ session, setSession ] = useState<LocalSessionData | null>(null);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const localSessionDataList = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, userId)).limit(1);

            if (!localSessionDataList.length) {
                onLogout();
                return;
            }

            const localSessionData = localSessionDataList[0];

            if (!localSessionData.expiration || localSessionData.expiration < new Date(Date.now())) {
                localSessionData.expiration = null;
            }

            if (localSessionData.expiration == null) {
                onLogout();
                return;
            }

            setSession(localSessionData);
        })();
    }, []); // TODO: have this run every X minutes to continuously validate expiration

    return (
        <View
            style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
            }}
            >
            <Text>Edit app/index.tsx to edit this screen.</Text>
            <UserCount />
            <Button onPress={onLogout} title="Logout" />
        </View>
    );
}
