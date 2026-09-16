import { argon2id } from "hash-wasm";
import * as Crypto from "expo-crypto";

/**
 * Web/desktop build of the hasher. Metro picks this over `hasher.ts` for the web platform.
 *
 * `@sphereon/react-native-argon2` is a native module with no web implementation, and because it is imported
 * at module scope it throws while the bundle is evaluating — which took down the entire app before React
 * could mount (and equally killed `expo export`'s static prerender). This replaces it with a WASM argon2.
 *
 * HASH PARITY IS LOAD-BEARING: `argon2Hash` output IS the credential sent to the server, so a web hash that
 * differs from the native one by a single byte means accounts silently fail to log in on this platform.
 * The cost parameters below mirror `hasher.ts` exactly.
 *
 * The salt needed care. `hasher.ts` hex-ENCODES the constant before handing it over, and the native module
 * hex-DECODES it again (RNArgon2Module.java):
 *
 *     final byte[] saltInputBytes = new BigInteger(salt, 16).toByteArray();
 *     byte[] saltBytes = new byte[32];
 *     System.arraycopy(saltInputBytes, saltInputBytes.length - 32, saltBytes, 0, 32);
 *
 * so the bytes argon2 actually sees are the RAW UTF-8 bytes of the constant — the encode/decode round-trips.
 * Passing the hex string's own ASCII bytes (the obvious reading, and what this file did first) produced a
 * completely different hash and a 400 from /users/authenticate. Verified against hash-wasm at these exact
 * parameters; do not "simplify" the derivation below without re-checking a real login.
 */

// Same constant as hasher.ts. Exactly 32 bytes, which is what makes the native path below well-defined.
const SALT_SOURCE = "ShuffullSaltingSixteenBytesLong!";

/** The hex string `hasher.ts` builds and passes to the native module. */
function saltHex(): string {
    const bytes = new TextEncoder().encode(SALT_SOURCE);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reproduces the native module's salt derivation: hex-decode, then right-align the last 32 bytes into a
 * 32-byte buffer. Anything shorter than 32 bytes makes the native side throw (its arraycopy offset goes
 * negative), so a short salt is a bug on BOTH platforms — fail here rather than diverge silently.
 */
function saltBytes(): Uint8Array {
    const hex = saltHex();
    const decoded = new Uint8Array(hex.length / 2);
    for (let i = 0; i < decoded.length; i++) {
        decoded[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }

    if (decoded.length < 32) {
        throw new Error(`Salt must be at least 32 bytes; got ${decoded.length}.`);
    }

    return decoded.slice(decoded.length - 32);
}

export async function argon2Hash(input: string) {
    return await argon2id({
        password: input,
        salt: saltBytes(),
        // Mirrors hasher.ts exactly — any drift here changes the hash.
        memorySize: Math.pow(2, 14),
        parallelism: 4,
        iterations: 5,
        hashLength: 16,
        outputType: "hex",
    });
}

/**
 * Unchanged from the native build: expo-crypto's digest works on web, so this needs no special handling and
 * is duplicated only because the module as a whole had to be overridden.
 */
export async function shaHash(bytes: Uint8Array) {
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>);
    const rawHash = new Uint8Array(digest);
    return Array.from(rawHash).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
