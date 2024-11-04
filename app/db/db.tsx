import * as SQLite from "expo-sqlite/next";
import { drizzle, ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { createContext, ReactNode, useContext } from 'react';

const DBContext = createContext<ExpoSQLiteDatabase | null>(null); // Replace 'null' with your DB type

interface DBProviderProps {
    children: ReactNode;
    db: ExpoSQLiteDatabase | null;
};

export const DBProvider = ({ children, db }: DBProviderProps) => (
    <DBContext.Provider value={db}>{children}</DBContext.Provider>
);

export const useDB = () => useContext(DBContext);
