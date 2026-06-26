import { Stack } from "expo-router";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider as NavThemeProvider, DarkTheme, type Theme } from "@react-navigation/native";
import { DbProvider } from "./services/db/DbProvider";
import DownloaderProvider from "./services/downloader/DownloaderProvider";
import { SessionBootstrap } from "./services/auth/SessionBootstrap";
import { ThemeProvider, color } from "./theme";

// react-navigation's theme drives the scene/card backgrounds shown during transitions. Its default is light,
// so a nested transition (e.g. a push inside a tab) briefly reveals a white scene behind the sliding card,
// while a top-level push doesn't (the dark root view is behind it). Force a dark navigation theme
// (background + card = our bg) so every transition stays dark, app-wide.
const navTheme: Theme = {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: color.bg, card: color.bg },
};

// Root layout. Hosts the providers that are not tied to an authenticated session (theme +
// database + downloader), kicks off session restore, and declares the top-level navigator.
// Session-scoped providers (api, sync, current user) live under (app)/_layout so they only mount
// once logged in.
//
// SafeAreaProvider is required since Expo SDK 54 enables edge-to-edge by default (content draws behind the
// system bars): the bottom-tab navigator reads the inset from it to clear the nav bar, and non-tab screens
// (e.g. Now Playing) apply the inset themselves. paddingTop:30 keeps the previous manual status-bar offset.
export default function RootLayout() {
    return (
        <ThemeProvider>
            <DbProvider>
                <DownloaderProvider>
                    <SessionBootstrap />
                    <StatusBar style="light" />
                    <SafeAreaProvider>
                        <NavThemeProvider value={navTheme}>
                            <View style={{ flex: 1, paddingTop: 30, backgroundColor: color.bg }}>
                                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
                                    <Stack.Screen name="index" />
                                    <Stack.Screen name="(auth)" />
                                    <Stack.Screen name="(app)" />
                                    <Stack.Screen name="notification.click" />
                                </Stack>
                            </View>
                        </NavThemeProvider>
                    </SafeAreaProvider>
                </DownloaderProvider>
            </DbProvider>
        </ThemeProvider>
    );
}
