import { afterEach, describe, expect, it } from "vitest";
import axios, { AxiosHeaders, InternalAxiosRequestConfig } from "axios";
import { AI_TIMEOUT_MS, ApiClient, BULK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from "@/app/services/api/ApiClient";
import { ApiStatusFailureError } from "@/app/services/api/errors";

// Every ApiClient call goes through one request helper (ShuffullApp#94). These pin what each call used to spell out
// for itself: its timeout class, its query string, a JSON body, the status check, and parsing instead of casting.
describe("ApiClient.request", () => {
    const originalAdapter = axios.defaults.adapter;
    afterEach(() => { axios.defaults.adapter = originalAdapter; });

    /** A client whose every call answers `status` with `data`, and the requests it sent. Set before the client is made. */
    function stubbed(status: number, data: unknown) {
        const sent: InternalAxiosRequestConfig[] = [];
        axios.defaults.adapter = async (config) => {
            sent.push(config);
            return { data, status, statusText: "", headers: {}, config };
        };
        return { api: new ApiClient("http://api", "t"), sent };
    }

    it.each([
        ["userGet (single item)", DEFAULT_TIMEOUT_MS, (api: ApiClient) => api.userGet()],
        ["playlistDelete (single item)", DEFAULT_TIMEOUT_MS, (api: ApiClient) => api.playlistDelete("p1")],
        ["songKeep (a batch)", BULK_TIMEOUT_MS, (api: ApiClient) => api.songKeep(["s1"])],
        ["songGetChanged (a page)", BULK_TIMEOUT_MS, (api: ApiClient) => api.songGetChanged({ afterDate: "2026-01-01T00:00:00.000Z" })],
        ["songRetag (runs the AI)", AI_TIMEOUT_MS, (api: ApiClient) => api.songRetag([{ songId: "s1", model: "weak" }])],
        ["songRetagStale (runs the AI)", AI_TIMEOUT_MS, (api: ApiClient) => api.songRetagStale(5)],
    ] as const)("%s gets its timeout", async (_name, timeout, call) => {
        const { api, sent } = stubbed(200, {});

        await call(api).catch(() => undefined); // the empty body may not parse; only the request matters here

        expect(sent[0].timeout).toBe(timeout);
    });

    it("sends params in the query string and no body when there is none", async () => {
        const { api, sent } = stubbed(200, { enriched: 0, failed: 0, remaining: 0, strongModel: null });

        await api.songRetagStale(25);

        expect([sent[0].method, sent[0].url, sent[0].params, sent[0].data]).toEqual(["post", "/api/v1/songs/retag-stale", { limit: 25 }, undefined]);
    });

    it("sends a bare value as a JSON body", async () => {
        const { api, sent } = stubbed(200, null);

        await api.userSongSetLikeStatus("s1", 2);

        expect(sent[0].data).toBe("2");
        expect(AxiosHeaders.from(sent[0].headers).getContentType()).toMatch(/^application\/json/);
    });

    it("throws ApiStatusFailureError with the status and body for anything outside 2xx", async () => {
        const { api } = stubbed(404, { error: "No such playlist." });

        const error = await api.playlistDelete("p1").catch(e => e);

        expect(error).toBeInstanceOf(ApiStatusFailureError);
        expect(error.status).toBe(404);
        expect(error.data).toEqual({ error: "No such playlist." });
    });

    it.each([
        ["songRetag", (api: ApiClient) => api.songRetag([{ songId: "s1", model: "weak" }])],
        ["songRetagStale", (api: ApiClient) => api.songRetagStale(5)],
    ] as const)("%s rejects a 200 that isn't its response (a proxy page) instead of casting it", async (_name, call) => {
        const { api } = stubbed(200, "<html>Bad gateway</html>");

        await expect(call(api)).rejects.toThrow();
    });
});
