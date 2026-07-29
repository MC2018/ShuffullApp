import { defineConfig } from "vitest/config";
import path from "path";

// Vitest harness for the app's PURE TypeScript logic only. Most modules pull in native code
// (expo-sqlite, react-native-track-player, expo-*, async-storage) that cannot run under Node, so the
// test suite deliberately imports only dependency-free helpers, Zod schemas, and the drizzle schema +
// query layer (exercised against an in-memory better-sqlite3 DB). React Native components are NOT rendered.
export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        globals: false,
    },
    resolve: {
        alias: {
            // Mirror the tsconfig "@/*" -> "./*" path mapping so test imports match app code.
            "@": path.resolve(__dirname, "."),
            // hasher.web.ts is genuinely worth testing (its output is the login credential), but importing it
            // pulls expo-crypto and therefore React Native's Flow source, which vitest can't parse. Stubbing
            // the leaf dependency lets the REAL module be tested instead of a copy of it drifting in a test.
            "expo-crypto": path.resolve(__dirname, "tests/stubs/expo-crypto.ts"),
        },
    },
});
