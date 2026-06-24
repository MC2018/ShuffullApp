import { Stack } from "expo-router";
import { View } from "react-native";
import { DbProvider } from "./services/db/DbProvider";
import DownloaderProvider from "./services/downloader/DownloaderProvider";
import { SessionBootstrap } from "./services/auth/SessionBootstrap";

// Root layout. Hosts the providers that are not tied to an authenticated session (database +
// downloader), kicks off session restore, and declares the top-level navigator. Session-scoped
// providers (api, sync, current user) live under (app)/_layout so they only mount once logged in.
export default function RootLayout() {
    return (
        <DbProvider>
            <DownloaderProvider>
                <SessionBootstrap />
                <View style={{ flex: 1, paddingTop: 30 }}>
                    <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="index" />
                        <Stack.Screen name="(auth)" />
                        <Stack.Screen name="(app)" />
                        <Stack.Screen name="notification.click" />
                    </Stack>
                </View>
            </DownloaderProvider>
        </DbProvider>
    );
}
