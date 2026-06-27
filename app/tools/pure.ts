// Dependency-free helpers extracted from ./utils so they can be unit-tested under Node without pulling
// in the native-only imports (expo-file-system, expo-crypto, argon2) that live in ./utils. Behaviour is
// unchanged: ./utils re-exports each of these, so every existing import path still resolves identically.

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

export function isAnyNullish(...args: any[]): boolean {
    return args.some(arg => arg == null || arg == undefined);
}
