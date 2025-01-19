import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { createContext, ReactNode, useContext } from 'react';

const DbContext = createContext<ExpoSQLiteDatabase | null>(null);

interface DbProviderProps {
    children: ReactNode;
    db: ExpoSQLiteDatabase;
};

export const DbProvider = ({ children, db }: DbProviderProps) => (
    <DbContext.Provider value={db}>{children}</DbContext.Provider>
);

export const useDb = () => {
    const context = useContext(DbContext);

    if (!context) {
        throw Error("DB Context null.");
    }

    return context;
}