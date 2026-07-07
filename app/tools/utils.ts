import * as FileSystem from "expo-file-system/legacy";
import { shaHash } from "./hasher";

// Dependency-free helpers live in ./pure so they can be unit-tested without this file's native imports.
// Re-exported here so every existing `./utils` / `@/app/tools` import keeps resolving unchanged.
export { distinctBy, deterministicId, generateRange, isAnyNullish, generateId } from "./pure";

function getFileNameFromUri(uri: string): string | null {
    if (!uri) {
        return null;
    }

    const segments = uri.replace("\\", "/").split("/");
    return segments[segments.length - 1] || null;
}

async function hashFile(uri: string) {
    const fileData = await FileSystem.getInfoAsync(uri);

    if (!fileData.exists) {
        return undefined;
    }

    const base64Data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const binaryString = atob(base64Data);
    const bytes = Uint8Array.from(binaryString, char => char.charCodeAt(0));
    return await shaHash(bytes);
}

export async function verifyFileIntegrity(uri: string) {
    const originalHash = getFileNameFromUri(uri)?.split(".")[0] ?? "";
    const newHash = await hashFile(uri);
    return newHash != undefined && newHash.startsWith(originalHash);
}

export const sleep = (time: number) => new Promise((resolve) => setTimeout(() => resolve(null), time));
