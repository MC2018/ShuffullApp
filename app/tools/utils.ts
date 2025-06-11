import * as FileSystem from "expo-file-system";
import { shaHash } from "./hasher";
import { monotonicFactory } from "ulid";

export function distinctBy<T, K>(array: T[], keySelector: (item: T) => K): T[] {
    const seen = new Set<K>();
    return array.filter(item => {
        const key = keySelector(item);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

// TODO: Math.random() is not cryptographically secure
export function generateId(): string {
    const ulid = monotonicFactory(() => Math.random());
    return ulid();
}

export function generateRange(x: number): number[] {
    return Array.from({ length: x }, (_, i) => i);
}

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

export function isAnyNullish(...args: any[]): boolean {
    return args.some(arg => arg == null || arg == undefined);
}