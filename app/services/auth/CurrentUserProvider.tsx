import { createContext, ReactNode, useContext } from "react";

// Provides the authenticated user id below the (app) auth guard. Because the guard only renders its
// children once a session exists, `useCurrentUser()` can return a plain non-null string — screens no
// longer need to read CURRENT_USER_ID from AsyncStorage, parse it, or guard against null/undefined.
const CurrentUserContext = createContext<string | null>(null);

interface CurrentUserProviderProps {
    userId: string;
    children: ReactNode;
}

export function CurrentUserProvider({ userId, children }: CurrentUserProviderProps) {
    return <CurrentUserContext.Provider value={userId}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): string {
    const userId = useContext(CurrentUserContext);

    if (userId == null) {
        throw Error("useCurrentUser must be used within the (app) auth guard.");
    }

    return userId;
}
