import { createContext, ReactNode, useContext } from 'react';
import { ApiClient } from "./apiClient";

const ApiContext = createContext<ApiClient | null>(null);

interface ApiProviderProps {
    children: ReactNode;
    api: ApiClient | null;
};

export const ApiProvider = ({ children, api }: ApiProviderProps) => (
    <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useApi = () => useContext(ApiContext);
