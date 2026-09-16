import { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { useAuthStore } from "@/app/services/auth/authStore";
import { login, register } from "@/app/services/auth/auth";
import { Button, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

// Canonical Shuffull server; pre-filled on a fresh install so most users never touch the host field.
// Still editable (self-hosters / local dev can point elsewhere); a saved value always wins.
const DEFAULT_HOST_ADDRESS = "https://shuffull-api.clausius.app";

// Login / registration screen. Talks to the auth service directly; on success the service flips the
// auth store to "authenticated" and this screen redirects into the app. The (app) guard and index
// redirect cover the inverse direction, so there is no manual navigation here.
export default function LoginScreen() {
    const theme = useTheme();
    const status = useAuthStore((state) => state.status);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [hostAddress, setHostAddress] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            const savedHostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            setHostAddress(savedHostAddress ?? DEFAULT_HOST_ADDRESS);
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
        <Screen>
            <View style={{ flex: 1, justifyContent: "center", gap: theme.space.md }}>
                <Text variant="screenTitle" style={{ marginBottom: theme.space.sm }}>
                    Welcome back
                </Text>
                <TextField value={username} onChangeText={setUsername} placeholder="Username" autoCapitalize="none" autoCorrect={false} />
                <TextField value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
                <TextField value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" autoCapitalize="none" autoCorrect={false} />
                <View style={{ height: theme.space.sm }} />
                <Button label="Login" onPress={attemptLogin} full />
                <Button label="Create account" variant="ghost" onPress={attemptRegister} full />
                {error != null ? (
                    <Text variant="caption" style={{ color: theme.color.accent, textAlign: "center" }}>
                        {error}
                    </Text>
                ) : null}
            </View>
        </Screen>
    );
}
