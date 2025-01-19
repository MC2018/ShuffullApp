// @ts-ignore
import argon2 from "@sphereon/react-native-argon2";
import * as Crypto from "expo-crypto";

export async function argon2Hash(input: string) {
    const encoder = new TextEncoder();
    const byteArray = encoder.encode("ShuffullSaltingSixteenBytesLong!");
    const salt = Array.from(byteArray).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const result = await argon2(input, salt, {
        memory: Math.pow(2, 14),
        parallelism: 4,
        iterations: 5,
        mode: "argon2id",
        hashLength: 16
    });
    return result.rawHash;
}

export async function shaHash(bytes: Uint8Array) {
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    const rawHash = new Uint8Array(digest);
    return Array.from(rawHash).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
