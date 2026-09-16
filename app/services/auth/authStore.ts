import { create } from "zustand";
import { ApiClient } from "../api/ApiClient";

// Single source of truth for the authenticated session. Route guards (app/index.tsx,
// (app)/_layout.tsx, (auth)/login.tsx) subscribe to `status` to decide what to render, and screens
// read `userId` (guaranteed non-null inside (app) via useCurrentUser). Living in a store rather than
// React state lets non-React code (the auth service) flip auth state from imperative handlers.
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface Session {
    userId: string;
    apiClient: ApiClient;
    hostAddress: string;
}

interface AuthState {
    status: AuthStatus;
    userId: string | null;
    apiClient: ApiClient | null;
    hostAddress: string | null;
    setSession: (session: Session) => void;
    clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
    status: "loading",
    userId: null,
    apiClient: null,
    hostAddress: null,
    setSession: ({ userId, apiClient, hostAddress }) =>
        set({ status: "authenticated", userId, apiClient, hostAddress }),
    clearSession: () =>
        set({ status: "unauthenticated", userId: null, apiClient: null, hostAddress: null }),
}));
