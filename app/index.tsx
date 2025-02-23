import * as SQLite from "expo-sqlite/next";
import { Text, View } from "react-native";
import { drizzle } from "drizzle-orm/expo-sqlite"
import { migrate, useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./services/db/drizzle/migrations"
import { DbProvider } from "./services/db/DbProvider";
import LoginPage from "./pages/Login";
import { useEffect, useState } from "react";
import { ApiProvider } from "./services/api/apiProvider";
import { ApiClient } from "./services/api/apiClient";
import { localSessionDataTable } from "./services/db/schema";
import { LocalSessionData } from "./services/db/models";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "./constants/storageKeys";
import * as DbQueries from "./services/db/queries";
import { MediaManager } from "./tools";
import { Hasher } from "./tools";
import React from "react";
import NavigationTabs from "./pages/NavigationTabs";
import LogoutProvider from "./services/LogoutProvider";
import DownloaderProvider from "./services/DownloaderProvider";
import SyncManagerProvider from "./services/SyncManagerProvider";
import SongProgressSync from "./services/SongProgressSync";

const dbName = "shuffull-db";
let expoDb = SQLite.openDatabaseSync(dbName);
let db = drizzle(expoDb);

export default function Index() {
    const [ apiClient, setApiClient ] = useState<ApiClient | null>(null);
    const [ loggedIn, setLoggedIn ] = useState<boolean>(false);
    const [ sessionData, setSessionData ] = useState<LocalSessionData | null>(null);
    const [ loginRefreshes, setLoginRefreshes ] = useState<number>(0);
    const { success, error } = useMigrations(db, migrations);
    const [ autoLoginAttempted, setAutoLoginAttempted ] = useState<boolean>(false);
    const [ userId, setUserId ] = useState<number | null>(null);

    const resetDb = () => {
        MediaManager.clear();
        expoDb.closeSync();
        SQLite.deleteDatabaseSync(dbName);
        expoDb = SQLite.openDatabaseSync(dbName);
        db = drizzle(expoDb);
        MediaManager.setup(db);
    }

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
        if (success) {
            MediaManager.setup(db);
        }
    }, [success]);

    useEffect(() => {
        (async () => {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    
            if (!localSessionData || !hostAddress) {
                setAutoLoginAttempted(true);
                MediaManager.clear();
                return;
            }

            const client = new ApiClient(hostAddress, localSessionData.token);

            setApiClient(client);
            setSessionData(localSessionData);
            setLoggedIn(true);
            setAutoLoginAttempted(true);
            setUserId(localSessionData.userId);
        })();
    }, [loginRefreshes]);

    const handleLogin = async (username: string, password: string, hostAddress: string) => {
        const userHash = await Hasher.argon2Hash(`${username};${password}`);
        const api = new ApiClient(hostAddress, "");
        const authResponse = await api.userAuthenticate(username, userHash);

        await db.insert(localSessionDataTable).values([{
            userId: authResponse.user.userId,
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

        MediaManager.clear();

        await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_USER_ID);

        setApiClient(null);
        setSessionData(null);
        setLoggedIn(false);
        setUserId(null);
    };

    let result;

    if (!autoLoginAttempted) {
        result = <></>;
    } else if (loggedIn && apiClient && userId != null) {
        result =
            <DbProvider db={db}>
                <DownloaderProvider>
                    <LogoutProvider onLogout={handleLogout}>
                        <ApiProvider api={apiClient}>
                            {/* Background Services */}
                            <SyncManagerProvider userId={userId} />
                            <SongProgressSync />

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
