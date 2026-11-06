import { File } from "expo-file-system";
import { shaHash } from "./hasher";

// Dependency-free helpers live in ./pure so they can be unit-tested without this file's native imports.
// Re-exported here so every existing `./utils` / `@/app/tools` import keeps resolving unchanged.
export { chunk, distinctBy, distinctByLast, deterministicId, generateRange, isAnyNullish, generateId } from "./pure";

function getFileNameFromUri(uri: string): string | null {
    if (!uri) {
        return null;
    }

    const segments = uri.replace("\\", "/").split("/");
    return segments[segments.length - 1] || null;
}

/**
 * SHA-256 of a local file, read straight into bytes for the native digest. It used to read the file as base64, decode
 * it with atob and copy it into an array one character at a time: millions of JS calls per song, all blocking the JS
 * thread (ShuffullApp#181).
 */
async function hashFile(uri: string) {
    const file = new File(uri);

    if (!file.exists) {
        return undefined;
    }

    return await shaHash(await file.bytes());
}

export async function verifyFileIntegrity(uri: string) {
    const originalHash = getFileNameFromUri(uri)?.split(".")[0] ?? "";
    const newHash = await hashFile(uri);
    return newHash != undefined && newHash.startsWith(originalHash);
}

