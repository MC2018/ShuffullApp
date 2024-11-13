import { Text, View } from "react-native";
import * as SQLite from "expo-sqlite/next";
import { drizzle } from "drizzle-orm/expo-sqlite"
import { migrate, useMigrations } from "drizzle-orm/expo-sqlite/migrator"
import migrations from "./services/db/drizzle/migrations"
import { DbProvider } from "./services/db/dbProvider";
import HomePage from "./home";
import LoginPage, { LoginProps } from "./login";
import { useEffect, useState } from "react";
import { ApiProvider } from "./services/api/apiProvider";
import { ApiClient } from "./services/api/apiClient";
import { localSessionDataTable } from "./services/db/schema";
import { isNotNull, eq } from "drizzle-orm";
import { LocalSessionData } from "./services/db/models";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "./constants/storageKeys";

const dbName = "shuffull-db";
let expoDb = SQLite.openDatabaseSync(dbName);
let db = drizzle(expoDb);

function resetDb() {
    expoDb.closeSync();
    SQLite.deleteDatabaseSync(dbName);
    expoDb = SQLite.openDatabaseSync(dbName);
    db = drizzle(expoDb);
}

export default function Index() {
    const [ apiClient, setApiClient ] = useState<ApiClient | null>(null);
    const [ loggedIn, setLoggedIn ] = useState<boolean>(false);
    const [ sessionData, setSessionData ] = useState<LocalSessionData | null>(null);
    const { success, error } = useMigrations(db, migrations);

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
            const localSessionData = await db.select().from(localSessionDataTable).where(isNotNull(localSessionDataTable.expiration)).limit(1);
    
            if (!localSessionData.length || !hostAddress) {
                return;
            }

            setApiClient(new ApiClient(hostAddress, localSessionData[0].token));
            setSessionData(localSessionData[0]);
            setLoggedIn(true);
        })();
    }, []);

    const handleLogin = async (username: string, password: string, hostAddress: string) => {
        const userHash = "638a95e77ba6ec76c4179ff3fd98e682"; // TODO: THIS ONLY WORKS WITH USER MC PASS password, ARGON2 HAS TO BE IMPLEMENTED
        let api = new ApiClient(hostAddress, "");
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
        const localSessionData = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, authResponse.user.userId)).limit(1);
        
        if (!localSessionData.length) {
            throw Error("Critical error: Local session data cannot find data after upserting.");
        }

        api.updateAuthHeader(localSessionData[0].token);

        setApiClient(api);
        setSessionData(localSessionData[0]);
        setLoggedIn(true);
    };

    const handleLogout = async () => {
        await db.update(localSessionDataTable).set({
            expiration: null
        });
        setApiClient(null);
        setSessionData(null);
        setLoggedIn(false);
    };

    return (
        <DbProvider db={db}>
            {loggedIn ? (
                <ApiProvider api={apiClient}>
                    <HomePage userId={sessionData?.userId ?? -1} onLogout={handleLogout}/>
                </ApiProvider>
            ) : (
                <LoginPage onLogin={handleLogin} />
            )}
        </DbProvider>
    );
}
