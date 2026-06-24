import { Button, Text, TextInput } from "react-native";
import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { useAuthStore } from "@/app/services/auth/authStore";
import { login, register } from "@/app/services/auth/auth";

// Login / registration screen. Talks to the auth service directly; on success the service flips the
// auth store to "authenticated" and this screen redirects into the app. The (app) guard and index
// redirect cover the inverse direction, so there is no manual navigation here.
export default function LoginScreen() {
    const status = useAuthStore((state) => state.status);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [hostAddress, setHostAddress] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            const savedHostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            setHostAddress(savedHostAddress ?? "");
        })();
    }, []);

    if (status === "authenticated") {
        return <Redirect href="/home" />;
    }

    const attemptLogin = async () => {
        try {
            setError(null);
            await AsyncStorage.setItem(STORAGE_KEYS.HOST_ADDRESS, hostAddress);
            await login(username, password, hostAddress);
        } catch (e) {
            setError(`Login failed: ${e}`);
        }
    };

    const attemptRegister = async () => {
        try {
            setError(null);
            await AsyncStorage.setItem(STORAGE_KEYS.HOST_ADDRESS, hostAddress);
            await register(username, password, hostAddress);
        } catch (e) {
            setError(`Registration failed: ${e}`);
        }
    };

    return (
        <>
            <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
            <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" />
            <Button title="Login" onPress={attemptLogin}></Button>
            <Button title="Create account" onPress={attemptRegister}></Button>
            {error != null && <Text style={{ color: "red" }}>{error}</Text>}
        </>
    );
}
