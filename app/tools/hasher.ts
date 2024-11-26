// @ts-ignore
import argon2 from "@sphereon/react-native-argon2";

export default async function hash(input: string) {
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
