import { Stack } from "expo-router";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { DbProvider } from "./services/db/DbProvider";
import DownloaderProvider from "./services/downloader/DownloaderProvider";
import { SessionBootstrap } from "./services/auth/SessionBootstrap";
import { ThemeProvider, color } from "./theme";

// Root layout. Hosts the providers that are not tied to an authenticated session (theme +
// database + downloader), kicks off session restore, and declares the top-level navigator.
// Session-scoped providers (api, sync, current user) live under (app)/_layout so they only mount
// once logged in.
//
// The paddingTop:30 below is the previous manual status-bar offset; it stays until screens adopt
// the Screen primitive's safe-area handling (Phase 2), so unmigrated screens keep their spacing.
export default function RootLayout() {
    return (
        <ThemeProvider>
            <DbProvider>
                <DownloaderProvider>
                    <SessionBootstrap />
                    <StatusBar style="light" />
                    <View style={{ flex: 1, paddingTop: 30, backgroundColor: color.bg }}>
                        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
                            <Stack.Screen name="index" />
                            <Stack.Screen name="(auth)" />
                            <Stack.Screen name="(app)" />
                            <Stack.Screen name="notification.click" />
                        </Stack>
                    </View>
                </DownloaderProvider>
            </DbProvider>
        </ThemeProvider>
    );
}
