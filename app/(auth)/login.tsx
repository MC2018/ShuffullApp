import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { useAuthStore } from "@/app/services/auth/authStore";
import { login, register } from "@/app/services/auth/auth";
import { describeAuthFailure } from "@/app/services/api/errors";
import { Button, Screen, Text, TextField } from "@/app/components/ui";
import AppVersion from "@/app/components/common/AppVersion";
import { useTheme } from "@/app/theme";
import { log } from "@/app/tools/log";

// Canonical Shuffull server; pre-filled on a fresh install so most users never touch the host field.
// Still editable (self-hosters / local dev can point elsewhere); a saved value always wins.
const DEFAULT_HOST_ADDRESS = "https://shuffull-api.clausius.app";

// Login / registration screen. Talks to the auth service directly; on success the service flips the
// auth store to "authenticated" and this screen redirects into the app. The (app) guard and index
// redirect cover the inverse direction, so there is no manual navigation here.
export default function LoginScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const status = useAuthStore((state) => state.status);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [hostAddress, setHostAddress] = useState("");
    const [error, setError] = useState<string | null>(null);
    // Which button is running. A login can take a while: it may clear the last account's songs first
    // (services/auth/accountSwitch), and a second tap must not start a second login and a second clear.
    const [busy, setBusy] = useState<"login" | "register" | null>(null);
    // The same, read synchronously: two taps can both land before the re-render that disables the buttons.
    const submitting = useRef(false);

    useEffect(() => {
        (async () => {
            const savedHostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            setHostAddress(savedHostAddress ?? DEFAULT_HOST_ADDRESS);
        })().catch((e) => log.warn("auth", "Reading the saved host address failed.", e));
    }, []);

    if (status === "authenticated") {
        return <Redirect href="/home" />;
    }

    const submit = async (kind: "login" | "register", run: typeof login, failure: string) => {
        if (submitting.current) {
            return;
        }
        submitting.current = true;
        setBusy(kind);
        try {
            setError(null);
            await AsyncStorage.setItem(STORAGE_KEYS.HOST_ADDRESS, hostAddress);
            await run(username, password, hostAddress);
        } catch (e) {
            setError(`${failure} ${describeAuthFailure(e, hostAddress)}`);
        } finally {
            submitting.current = false;
            setBusy(null);
        }
    };

    const attemptLogin = () => submit("login", login, "Login failed.");
    const attemptRegister = () => submit("register", register, "Registration failed.");

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
                <Button label={busy === "login" ? "Logging in..." : "Login"} onPress={attemptLogin} disabled={busy != null} full />
                <Button
                    label={busy === "register" ? "Creating account..." : "Create account"}
                    variant="ghost"
                    onPress={attemptRegister}
                    disabled={busy != null}
                    full
                />
                {error != null ? (
                    <Text variant="caption" style={{ color: theme.color.accent, textAlign: "center" }}>
                        {error}
                    </Text>
                ) : null}
            </View>
            <View style={{ paddingBottom: insets.bottom + theme.space.md }}>
                <AppVersion />
            </View>
        </Screen>
    );
}
