import React, { useEffect, useState } from "react";
import { ReactNode } from 'react';
import * as DbQueries from "./db/queries";
import { useDb } from "./db/DbProvider";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";

interface LogoutProviderProps {
    children: ReactNode;
    onLogout: () => Promise<void>;
};
let callOnLogout: () => Promise<void>;

export default function LogoutProvider({ children, onLogout }: LogoutProviderProps) {
    const [ timerIncrement, setTimerIncrement ] = useState(0);

    const db = useDb();
    callOnLogout = onLogout;

    useEffect(() => {
        const timer = setTimeout(async () => {
            setTimerIncrement((prev) => prev + 1);

            const currentUserId = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);

            if (currentUserId == null) {
                await logout();
                return;
            }
            
            const localSessionData = await DbQueries.getLocalSessionData(db, currentUserId);
                    
            if (!localSessionData || localSessionData.expiration < new Date(Date.now())) {
                await logout();
                return;
            }
        }, 5000);

        return () => clearTimeout(timer);
    }, [timerIncrement]);

    return <>{children}</>
};

export const logout = async () => {
    await callOnLogout();
}