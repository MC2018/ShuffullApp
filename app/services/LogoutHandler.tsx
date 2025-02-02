import React, { useEffect, useState } from "react";
import { ReactNode } from 'react';
import * as DbQueries from "../services/db/queries";
import { useDb } from "./db/DbProvider";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";

interface LogoutHandlerProps {
    children: ReactNode;
    onLogout: () => void;
};

let callOnLogout: () => void;

export const LogoutHandlerProvider = ({ children, onLogout }: LogoutHandlerProps) => {
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
            
            const localSessionData = await DbQueries.getLocalSessionData(db, parseInt(currentUserId));
                    
            if (!localSessionData || localSessionData.expiration < new Date(Date.now())) {
                await logout();
                return;
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [timerIncrement]);

    return <>{children}</>
};

export const logout = async () => {
    await callOnLogout();
}