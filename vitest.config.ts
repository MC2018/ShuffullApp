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
        },
    },
});
