// Dependency-free helpers extracted from ./utils so they can be unit-tested under Node without pulling
// in the native-only imports (expo-file-system, expo-crypto, argon2) that live in ./utils. Behaviour is
// unchanged: ./utils re-exports each of these, so every existing import path still resolves identically.

import { monotonicFactory } from "ulid";

// TODO: Math.random() is not cryptographically secure
export function generateId(): string {
    const ulid = monotonicFactory(() => Math.random());
    return ulid();
}

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

/**
 * distinctBy, but the LAST occurrence of each key wins (order of first appearance is preserved).
 *
 * Meant for cursor-paginated feeds, where the same row can legitimately arrive on two consecutive pages and
 * the later copy is the more recent one. Concatenating those pages yields duplicate primary keys, and a
 * multi-row INSERT containing them fails as a whole — so the caller must collapse them before writing.
 */
export function distinctByLast<T, K>(array: T[], keySelector: (item: T) => K): T[] {
    const byKey = new Map<K, T>();
    for (const item of array) {
        // Map.set keeps the key's ORIGINAL insertion position while replacing the value, so this is
        // "last value wins, first position kept".
        byKey.set(keySelector(item), item);
    }
    return [...byKey.values()];
}

// Stable, content-derived ID for rows the API no longer supplies an ID for: synthesized artists
// and the song/playlist join rows (the API now returns artist/tag names and a flat songIds list
// with no IDs). Deterministic so re-syncing the same logical row yields the same primary key,
// keeping the `onConflictDoNothing` inserts idempotent. FNV-1a, 64-bit, base-36 encoded. Parts are
// joined with a separator; every caller leads with a unique kind tag and the only free-form part
// (an artist name) always comes last, so distinct inputs never collide.
export function deterministicId(...parts: string[]): string {
    const input = parts.join(" ");
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;

    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & mask;
    }

    return hash.toString(36);
}

export function generateRange(x: number): number[] {
    return Array.from({ length: x }, (_, i) => i);
}

// `== null` is already true for undefined, so the second half of the old condition never fired.
export function isAnyNullish(...args: any[]): boolean {
    return args.some(arg => arg == null);
}

/**
 * Split an array into fixed-size chunks, the last of which may be short.
 *
 * SQLite caps a statement at 999 bound parameters, so multi-row INSERTs of a synced page have to go
 * out in batches rather than as one statement.
 */
export function chunk<T>(array: T[], size: number): T[][] {
    if (size < 1) {
        throw new Error(`chunk size must be at least 1, got ${size}`);
    }

    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
