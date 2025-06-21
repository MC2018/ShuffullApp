import { createContext, ReactNode, useContext } from 'react';
import { ApiClient } from './ApiClient';

const ApiContext = createContext<ApiClient | null>(null);

interface ApiProviderProps {
    children: ReactNode;
    api: ApiClient;
};

export const ApiProvider = ({ children, api }: ApiProviderProps) => (
    <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useApi = () => {
    const context = useContext(ApiContext);

    if (!context) {
        throw Error("API Context null.");
    }

    return context;
}