import { Button, Text, TextInput, View } from "react-native";
import { useDb } from "./services/db/dbProvider";
import { localSessionDataTable } from "./services/db/schema";
import { useEffect, useState } from "react";
import { ApiClient } from "./services/api/apiClient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "./constants/storageKeys";

interface LoginProps {
    onLogin: (newApiClient: ApiClient) => void;
}

const LoginPage = ({ onLogin }: LoginProps) => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [hostAddress, setHostAddress] = useState("");
    const db = useDb();

    useEffect(() => {
        (async () => {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            setHostAddress(hostAddress ?? "");
        })();
    }, []);

    async function attemptLogin() {
        const userHash = "638a95e77ba6ec76c4179ff3fd98e682"; // TODO: THIS ONLY WORKS WITH USER MC PASS password, ARGON2 HAS TO BE IMPLEMENTED
        const api = new ApiClient(hostAddress);
        const authResult = await api?.authenticate(username, userHash);
        await AsyncStorage.setItem(STORAGE_KEYS.HOST_ADDRESS, hostAddress);

        await db?.insert(localSessionDataTable).values([{
            userId: authResult.user.userId,
            currentPlaylistId: -1,
            activelyDownload: false,
            token: authResult.token,
            expiration: new Date(authResult.expiration)
        }]).onConflictDoUpdate({
            target: localSessionDataTable.userId,
            set: {
                token: authResult.token,
                expiration: new Date(authResult.expiration)
            }
        });

        onLogin(api);
    }

    return (
        <>
            <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
            <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" />
            <Button title="Login" onPress={attemptLogin}></Button>
        </>
    );
}

export default LoginPage;