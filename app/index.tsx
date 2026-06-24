import { Redirect } from "expo-router";
import { Text, View } from "react-native";
import { useAuthStore } from "./services/auth/authStore";

// Entry route. Pure redirector: it waits for session restore (kicked off by SessionBootstrap) to
// resolve `status`, then sends the user into the authenticated tabs or the login screen. The (app)
// and (auth) layouts re-check auth themselves, so this stays a thin gate.
export default function Index() {
    const status = useAuthStore((state) => state.status);

    if (status === "loading") {
        return (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Text>Loading...</Text>
            </View>
        );
    }

    if (status === "authenticated") {
        return <Redirect href="/home" />;
    }

    return <Redirect href="/login" />;
}
