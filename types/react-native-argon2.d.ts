// The package ships only index.js, which re-exports the native RNArgon2.argon2. Shapes from its README.
declare module "@sphereon/react-native-argon2" {
    export interface Argon2Config {
        iterations?: number;
        memory?: number;
        parallelism?: number;
        hashLength?: number;
        mode?: "argon2i" | "argon2d" | "argon2id";
    }

    export interface Argon2Result {
        /** Hex. */
        rawHash: string;
        /** The `$argon2id$v=19$...` string form. */
        encodedHash: string;
    }

    export default function argon2(password: string, salt: string, config: Argon2Config): Promise<Argon2Result>;
}
