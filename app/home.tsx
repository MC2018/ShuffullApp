import { Button, Text, View } from "react-native";
import { useDb } from "./services/db/dbProvider";
import UserCount from "./userCount";
import { useEffect, useState } from "react";
import { LocalSessionData } from "./services/db/models";
import { useApi } from "./services/api/apiProvider";
import * as DbExtensions from "./services/db/dbExtensions";
import PlayPauseButton from "./playPauseButton";

interface HomeProps {
    userId: number;
    onLogout: () => void;
}

export default function HomePage({ userId, onLogout }: HomeProps) {
    const [ session, setSession ] = useState<LocalSessionData | null>(null);
    const db = useDb();
    const api = useApi();

    // Logout check
    useEffect(() => {
        (async () => {
            const localSessionData = await DbExtensions.getLocalSessionData(db, userId);

            if (!localSessionData || localSessionData.expiration < new Date(Date.now())) {
                onLogout();
                return;
            }

            setSession(localSessionData);
        })();
    }, []); // TODO: have this run every X minutes to continuously validate expiration

    return (
        <>
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
            <PlayPauseButton />
        </View>
        </>
    );
}
