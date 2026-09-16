import React, { createContext, useContext } from "react";
import { theme as defaultTheme, Theme } from "./tokens";

// A single dark theme for now. The provider exists so components read tokens via a hook
// (decoupling them from the concrete object) and so a second theme could be slotted in later
// without touching call sites.
const ThemeContext = createContext<Theme>(defaultTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    return <ThemeContext.Provider value={defaultTheme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
    return useContext(ThemeContext);
}
