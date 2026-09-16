import { useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import DbQueries from "../db/queries";
import { getDb } from "../db/database";
import { logout } from "./auth";

// Background poller (mounted inside the (app) guard) that logs the user out when their stored session
// expires or the cached user id disappears. Replaces the timer that used to live in LogoutProvider.
export function SessionExpiryWatcher() {
    useEffect(() => {
        const interval = setInterval(async () => {
            const currentUserId = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);

            if (currentUserId == null) {
                await logout();
                return;
            }

            const localSessionData = await DbQueries.getLocalSessionData(getDb(), currentUserId);

            if (!localSessionData || localSessionData.expiration < new Date(Date.now())) {
                await logout();
            }
        }, 5000);

        return () => clearInterval(interval);
    }, []);

    return null;
}
