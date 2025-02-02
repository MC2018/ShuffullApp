import * as SQLite from "expo-sqlite/next";
import { Text, View } from "react-native";
import { drizzle } from "drizzle-orm/expo-sqlite"
import { migrate, useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./services/db/drizzle/migrations"
import { DbProvider } from "./services/db/DbProvider";
import HomePage from "./pages/Home";
import LoginPage from "./pages/Login";
import { useEffect, useState } from "react";
import { ApiProvider } from "./services/api/apiProvider";
import { ApiClient } from "./services/api/apiClient";
import { localSessionDataTable } from "./services/db/schema";
import { LocalSessionData } from "./services/db/models";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "./constants/storageKeys";
import SyncManager from "./tools/SyncManager";
import * as DbQueries from "./services/db/queries";
import * as MediaManager from "./tools/MediaManager";
import { argon2Hash } from "./tools/hasher";
import React from "react";
import NavigationTabs from "./pages/NavigationTabs";
import LogoutProvider from "./services/LogoutProvider";
import DownloaderProvider from "./services/DownloaderProvider";

const dbName = "shuffull-db";
let expoDb = SQLite.openDatabaseSync(dbName);
let db = drizzle(expoDb);
let syncManager: SyncManager | null;
MediaManager.setup(db);

function resetDb() {
    MediaManager.reset();
    expoDb.closeSync();
    SQLite.deleteDatabaseSync(dbName);
    expoDb = SQLite.openDatabaseSync(dbName);
    db = drizzle(expoDb);
    MediaManager.setup(db);
}

export default function Index() {
    const [ apiClient, setApiClient ] = useState<ApiClient | null>(null);
    const [ loggedIn, setLoggedIn ] = useState<boolean>(false);
    const [ sessionData, setSessionData ] = useState<LocalSessionData | null>(null);
    const [ loginRefreshes, setLoginRefreshes ] = useState<number>(0);
    const { success, error } = useMigrations(db, migrations);
    const [ autoLoginAttempted, setAutoLoginAttempted ] = useState<boolean>(false);

    if (error) {
        try {
            console.log("Problem with migration");
            console.log(error.message);
            resetDb();
            migrate(db, migrations);
            console.log("Migrated successfully");
        } catch (e) {
            console.error("Serious error with migrations: " + e);
        }
    }

    useEffect(() => {
        (async () => {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    
            if (!localSessionData || !hostAddress) {
                setAutoLoginAttempted(true);
                MediaManager.reset();
                return;
            }

            if (syncManager) {
                syncManager.dispose();
            }

            const client = new ApiClient(hostAddress, localSessionData.token);
            syncManager = new SyncManager(db, client, localSessionData.userId);

            setApiClient(client);
            setSessionData(localSessionData);
            setLoggedIn(true);
            setAutoLoginAttempted(true);
        })();
    }, [loginRefreshes]);

    const handleLogin = async (username: string, password: string, hostAddress: string) => {
        const userHash = await argon2Hash(`${username};${password}`);
        const api = new ApiClient(hostAddress, "");
        const authResponse = await api.userAuthenticate(username, userHash);

        await db.insert(localSessionDataTable).values([{
            userId: authResponse.user.userId,
            currentPlaylistId: -1,
            activelyDownload: false,
            token: authResponse.token,
            expiration: new Date(authResponse.expiration)
        }]).onConflictDoUpdate({
            target: localSessionDataTable.userId,
            set: {
                token: authResponse.token,
                expiration: new Date(authResponse.expiration)
            }
        });
        const localSessionData = await DbQueries.getLocalSessionData(db, authResponse.user.userId);
        
        if (!localSessionData) {
            throw Error("Critical error: Local session data cannot find data after upserting.");
        }

        await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, localSessionData.userId.toString());
        setLoginRefreshes(loginRefreshes + 1);
    };

    const handleLogout = async () => {
        await db.update(localSessionDataTable).set({
            expiration: new Date(Date.now())
        });

        if (syncManager) {
            syncManager.dispose();
            syncManager = null;
        }

        MediaManager.reset();

        await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_USER_ID);

        setApiClient(null);
        setSessionData(null);
        setLoggedIn(false);
    };

    useEffect(() => {
        const interval = setInterval(() => {
            if (loggedIn && syncManager?.loggingOut) {
                handleLogout();
            }
        }, 5000);

        return () => clearInterval(interval);
    }, []);

    let result;

    if (!autoLoginAttempted) {
        result = <></>;
    } else if (loggedIn && apiClient) {
        result =
            <DbProvider db={db}>
                <DownloaderProvider>
                    <LogoutProvider onLogout={handleLogout}>
                        <ApiProvider api={apiClient}>
                            <NavigationTabs />
                        </ApiProvider>
                    </LogoutProvider>
                </DownloaderProvider>
            </DbProvider>;
    } else {
        result = <LoginPage onLogin={handleLogin} />;
    }

    result =
        <View style={{width: "100%", height: "100%", paddingTop: 30}}>
            {result}
        </View>;

    return result;
}
