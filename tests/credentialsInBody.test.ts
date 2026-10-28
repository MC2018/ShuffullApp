import axios, { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/app/services/api/ApiClient";

// Login and sign-up send the client's password hash, which is all it takes to log in. It belongs in the request
// body: anything in a URL ends up in proxy and access logs. Neither it nor the session token may reach a log.
describe("ApiClient: credentials stay out of URLs and logs", () => {
    const originalAdapter = axios.defaults.adapter;
    afterEach(() => {
        axios.defaults.adapter = originalAdapter;
        vi.restoreAllMocks();
    });

    const okSession = { user: { userId: "u1", username: "a", version: new Date().toISOString() }, token: "t", expiration: new Date().toISOString() };

    // Everything console.log was handed, serialised the way a log would render an object (AxiosError.toJSON
    // includes the request config).
    function captureLogs() {
        const logged: string[] = [];
        vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            logged.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg)).join(" "));
        });
        return logged;
    }

    function failWithoutAnswer() {
        axios.defaults.adapter = async (config) => {
            throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, { ...config, headers: new AxiosHeaders(config.headers) }, {});
        };
    }

    for (const [name, call, path] of [
        ["userAuthenticate", (api: ApiClient) => api.userAuthenticate("a&b +c#", "secret-hash"), "/api/v1/users/authenticate"],
        ["userCreate", (api: ApiClient) => api.userCreate("a&b +c#", "secret-hash"), "/api/v1/users"],
    ] as const) {
        it(`${name} sends the credentials in the JSON body, not the URL`, async () => {
            let sent: { url?: string, data?: unknown } = {};
            axios.defaults.adapter = async (config) => {
                sent = { url: config.url, data: config.data };
                return { data: okSession, status: 200, statusText: "OK", headers: {}, config };
            };

            const response = await call(new ApiClient("http://api", ""));

            expect(response.token).toBe("t");
            expect(sent.url).toBe(path);
            expect(JSON.parse(String(sent.data))).toEqual({ username: "a&b +c#", userHash: "secret-hash" });
        });

        it(`${name} never logs or rethrows the credential when the request fails`, async () => {
            const logged = captureLogs();
            failWithoutAnswer();

            const error = await call(new ApiClient("http://api", "")).catch(e => e);

            expect(error).toBeInstanceOf(AxiosError);
            expect(logged.some(line => line.includes("Network Error"))).toBe(true);
            expect(logged.join("\n")).not.toContain("secret-hash");
            expect(JSON.stringify(error)).not.toContain("secret-hash");
        });
    }

    it("a failed call never logs or rethrows the session token", async () => {
        const logged = captureLogs();
        failWithoutAnswer();

        const error = await new ApiClient("http://api", "session-token").tagGetAll().catch(e => e);

        // Still an AxiosError, so the outbox reads it as "no answer" and retries.
        expect(axios.isAxiosError(error)).toBe(true);
        expect(error.response).toBeUndefined();
        expect(logged.join("\n")).not.toContain("session-token");
        expect(JSON.stringify(error)).not.toContain("session-token");
    });
});
