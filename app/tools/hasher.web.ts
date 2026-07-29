import { argon2id } from "hash-wasm";
import * as Crypto from "expo-crypto";

/**
 * Web/desktop build of the hasher. Metro picks this over `hasher.ts` for the web platform.
 *
 * `@sphereon/react-native-argon2` is a native module with no web implementation, and because it is imported
 * at module scope it throws while the bundle is evaluating — which took down the entire app before React
 * could mount (and equally killed `expo export`'s static prerender). This replaces it with a WASM argon2.
 *
 * ⚠ HASH PARITY IS LOAD-BEARING AND UNVERIFIED.
 * `argon2Hash` output is the credential sent to the server, so a web hash that differs from the native one
 * by a single byte means accounts silently fail to log in on this platform. The parameters below mirror
 * `hasher.ts` exactly, and the salt is treated the way the native module appears to treat it — as the UTF-8
 * bytes of the hex STRING that hasher.ts builds, not as the 16 bytes that string encodes. That reading has
 * not been checked against the native library. Before trusting desktop/web login, hash a known input on a
 * device and here, and compare. If they differ, this is where to fix it.
 */

// Same constant as hasher.ts, hex-encoded the same way, so both platforms feed argon2 identical salt bytes.
const SALT_SOURCE = "ShuffullSaltingSixteenBytesLong!";

function saltHex(): string {
    const bytes = new TextEncoder().encode(SALT_SOURCE);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function argon2Hash(input: string) {
    return await argon2id({
        password: input,
        // See the parity note above: the native side passes this hex string straight through as the salt.
        salt: new TextEncoder().encode(saltHex()),
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
