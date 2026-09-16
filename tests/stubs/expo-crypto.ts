/**
 * Node stub for `expo-crypto`, aliased in by vitest.config.ts.
 *
 * `hasher.web.ts` imports expo-crypto for `shaHash`, and that import alone drags in React Native's
 * Flow-typed source, which vitest cannot parse — so the module could not be tested at all. Only
 * `argon2Hash` is under test (it is the login credential), and it never touches this, so the digest is
 * backed by Node's webcrypto rather than faked: if `shaHash` is ever tested, it gets a real SHA-256.
 */
import { webcrypto } from "node:crypto";

export enum CryptoDigestAlgorithm {
    SHA256 = "SHA-256",
}

export async function digest(algorithm: CryptoDigestAlgorithm, data: Uint8Array): Promise<ArrayBuffer> {
    return await webcrypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>);
}
