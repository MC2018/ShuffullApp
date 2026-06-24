import { Redirect, Stack } from "expo-router";
import { useAuthStore } from "@/app/services/auth/authStore";
import { ApiProvider } from "@/app/services/api/ApiProvider";
import { CurrentUserProvider } from "@/app/services/auth/CurrentUserProvider";
import { SessionExpiryWatcher } from "@/app/services/auth/SessionExpiryWatcher";
import SyncManagerProvider from "@/app/services/sync-manager/SyncManagerProvider";
import SongProgressSync from "@/app/services/SongProgressSync";

// Auth guard for everything under (app). If there is no live session it redirects to login; otherwise
// it provides the session-scoped context (authenticated api client, current user) and starts the
// background services (sync, playback progress, expiry watcher). Because this gate runs before any
// child screen renders, screens can rely on useCurrentUser() returning a non-null id.
export default function AppLayout() {
    const status = useAuthStore((state) => state.status);
    const userId = useAuthStore((state) => state.userId);
    const apiClient = useAuthStore((state) => state.apiClient);

    if (status === "loading") {
        return null;
    }

    if (status === "unauthenticated" || userId == null || apiClient == null) {
        return <Redirect href="/login" />;
    }

    return (
        <ApiProvider api={apiClient}>
            <CurrentUserProvider userId={userId}>
                {/* Background services (render nothing) */}
                <SyncManagerProvider userId={userId} />
                <SongProgressSync />
                <SessionExpiryWatcher />

                <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="now-playing" options={{ presentation: "modal" }} />
                </Stack>
            </CurrentUserProvider>
        </ApiProvider>
    );
}
