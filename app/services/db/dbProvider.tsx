import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { createContext, ReactNode, useContext } from 'react';

const DbContext = createContext<ExpoSQLiteDatabase | null>(null); // Replace 'null' with your DB type

interface DbProviderProps {
    children: ReactNode;
    db: ExpoSQLiteDatabase | null;
};

export const DbProvider = ({ children, db }: DbProviderProps) => (
    <DbContext.Provider value={db}>{children}</DbContext.Provider>
);

export const useDb = () => {
    const db = useContext(DbContext);

    if (db == null) {
        throw Error("Database is unexpectedly undefined.");
    }

    return db;
}
