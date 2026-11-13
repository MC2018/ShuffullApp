import { describe, expect, it, vi } from "vitest";
import {
    browserName,
    cleanDeviceName,
    defaultDeviceName,
    DeviceCheckIn,
    DeviceEnvironment,
    DeviceIdentity,
    DeviceNameDraft,
    FOREGROUND_CHECK_IN_INTERVAL_MS,
    isValidDeviceId,
    KeyValueStore,
} from "@/app/tools/device";
import type { DeviceCheckInBody } from "@/app/services/api/models";

// Device identity and check-in (ShuffullApp#58).

class MemoryStore implements KeyValueStore {
    readonly values = new Map<string, string>();
    failWrites = false;
    failReads = false;

    async getItem(key: string) {
        if (this.failReads) {
            throw new Error("read failed");
        }
        return this.values.get(key) ?? null;
    }

    async setItem(key: string, value: string) {
        if (this.failWrites) {
            throw new Error("write failed");
        }
        this.values.set(key, value);
    }

    async removeItem(key: string) {
        this.values.delete(key);
    }
}

const ANDROID: DeviceEnvironment = { os: "android", desktop: false, model: "Pixel 8" };

function identity(storage = new MemoryStore(), environment: DeviceEnvironment = ANDROID) {
    let n = 0;
    const makeId = vi.fn(() => `id-${++n}`);
    return {
        storage,
        makeId,
        identity: new DeviceIdentity({ storage, makeId, environment: () => environment, idKey: "ID", nameKey: "NAME" }),
    };
}

const UA = {
    chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
    firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
};

describe("device id", () => {
    it("is made once, stored, and the same for every later instance", async () => {
        const { storage, identity: first, makeId } = identity();

        const id = await first.id();
        expect(await first.id()).toBe(id);
        expect(storage.values.get("ID")).toBe(id);
        expect(await identity(storage).identity.id()).toBe(id);
        expect(makeId).toHaveBeenCalledTimes(1);
    });

    it("concurrent first calls share one id", async () => {
        const { identity: device, makeId } = identity();

        const ids = await Promise.all([device.id(), device.id(), device.id()]);

        expect(new Set(ids).size).toBe(1);
        expect(makeId).toHaveBeenCalledTimes(1);
    });

    it.each([["empty", ""], ["blank", "   "], ["too long", "x".repeat(65)], ["a control character", "a\tb"]])(
        "a stored id that is %s is replaced", async (_, stored) => {
            const storage = new MemoryStore();
            storage.values.set("ID", stored);

            const id = await identity(storage).identity.id();

            expect(id).toBe("id-1");
            expect(storage.values.get("ID")).toBe("id-1");
        });

    it("an id that can't be stored is still used for the whole run", async () => {
        const storage = new MemoryStore();
        storage.failWrites = true;
        const { identity: device } = identity(storage);

        expect(await device.id()).toBe("id-1");
        expect(await device.id()).toBe("id-1");
    });

    it("a failed read is retried on the next call rather than remembered", async () => {
        const storage = new MemoryStore();
        storage.values.set("ID", "stored-id");
        storage.failReads = true;
        const { identity: device } = identity(storage);

        await expect(device.id()).rejects.toThrow("read failed");
        storage.failReads = false;
        expect(await device.id()).toBe("stored-id");
    });

    it("validates ids the way the API does", () => {
        expect(isValidDeviceId("3f2b9c1e-0000-4000-8000-000000000000")).toBe(true);
        expect(isValidDeviceId("x".repeat(64))).toBe(true);
        expect(isValidDeviceId(null)).toBe(false);
        expect(isValidDeviceId("x".repeat(65))).toBe(false);
    });
});

describe("device name", () => {
    it.each<[string, DeviceEnvironment, string]>([
        ["Android, with its model", { os: "android", desktop: false, model: "Pixel 8" }, "Pixel 8"],
        ["Android, without a model", { os: "android", desktop: false, model: "  " }, "Android device"],
        ["iPhone", { os: "ios", desktop: false, isPad: false }, "iPhone"],
        ["iPad", { os: "ios", desktop: false, isPad: true }, "iPad"],
        ["the Electron app", { os: "web", desktop: true, userAgent: UA.chrome }, "Desktop"],
        ["Chrome", { os: "web", desktop: false, userAgent: UA.chrome }, "Web (Chrome)"],
        ["an unknown browser", { os: "web", desktop: false, userAgent: "curl/8.0" }, "Web browser"],
        ["web without a user agent", { os: "web", desktop: false }, "Web browser"],
        ["another OS", { os: "windows", desktop: false }, "windows"],
        ["no OS at all", { os: "", desktop: false }, "Unknown device"],
    ])("defaults on %s", (_, env, expected) => {
        expect(defaultDeviceName(env)).toBe(expected);
    });

    it.each([
        [UA.chrome, "Chrome"], [UA.edge, "Edge"], [UA.opera, "Opera"], [UA.firefox, "Firefox"], [UA.safari, "Safari"],
        [UA.chromeIos, "Chrome"],
    ])("tells browsers apart: %s", (ua, expected) => {
        expect(browserName(ua)).toBe(expected);
    });

    it("cleans a name the way the API will take it", () => {
        expect(cleanDeviceName("  Kitchen\tTablet\n ")).toBe("KitchenTablet");
        expect(cleanDeviceName("x".repeat(80))).toBe("x".repeat(64));
        expect(cleanDeviceName(" \n ")).toBeUndefined();
        expect(cleanDeviceName(null)).toBeUndefined();
        // An emoji across the 64-unit cut would leave half a surrogate pair, which the API can't read.
        const atTheCut = "x".repeat(63) + "\u{1F3B5}";
        expect(cleanDeviceName(atTheCut)).toBe("x".repeat(63));
        expect(cleanDeviceName("x".repeat(62) + "\u{1F3B5}")).toBe("x".repeat(62) + "\u{1F3B5}");
    });

    it("is the default until renamed, the new name after, and the default again once cleared", async () => {
        const { storage, identity: device } = identity();

        expect(await device.name()).toBe("Pixel 8");
        expect(await device.rename("  Kitchen tablet ")).toBe("Kitchen tablet");
        expect(storage.values.get("NAME")).toBe("Kitchen tablet");
        expect(await device.name()).toBe("Kitchen tablet");
        expect(await device.customName()).toBe("Kitchen tablet");

        expect(await device.rename("   ")).toBe("Pixel 8");
        expect(storage.values.has("NAME")).toBe(false);
        expect(await device.customName()).toBeUndefined();
        expect(await device.name()).toBe("Pixel 8");
    });
});

describe("device check-in", () => {
    function checkIn(options: { fail?: () => boolean } = {}) {
        let clock = 1_000_000;
        const { identity: device } = identity();
        const sent: { deviceId: string; body: DeviceCheckInBody }[] = [];
        const errors: string[] = [];
        const send = vi.fn(async (deviceId: string, body: DeviceCheckInBody) => {
            sent.push({ deviceId, body });
            if (options.fail?.()) {
                throw new Error("offline");
            }
        });
        const subject = new DeviceCheckIn({
            identity: device, platform: "android", send, now: () => clock, onError: (trigger) => errors.push(trigger),
        });
        return { subject, device, sent, errors, advance: (ms: number) => { clock += ms; } };
    }

    it("sends the install id, its name and the platform", async () => {
        const { subject, sent } = checkIn();

        expect(await subject.checkIn("session")).toBe(true);

        expect(sent).toEqual([{ deviceId: "id-1", body: { name: "Pixel 8", platform: "android" } }]);
    });

    it("skips a foreground check-in within the interval of the last success, and sends one after", async () => {
        const { subject, sent, advance } = checkIn();

        await subject.checkIn("session");
        advance(FOREGROUND_CHECK_IN_INTERVAL_MS - 1);
        expect(await subject.checkIn("foreground")).toBe(false);
        expect(sent).toHaveLength(1);

        advance(1);
        expect(await subject.checkIn("foreground")).toBe(true);
        expect(sent).toHaveLength(2);
    });

    it("two quick foregrounds send one check-in", async () => {
        const { subject, sent } = checkIn();

        await Promise.all([subject.checkIn("foreground"), subject.checkIn("foreground")]);
        await subject.checkIn("foreground");

        expect(sent).toHaveLength(1);
    });

    it("a failure is reported, never thrown, and the next foreground tries again", async () => {
        let failing = true;
        const { subject, sent, errors } = checkIn({ fail: () => failing });

        expect(await subject.checkIn("session")).toBe(false);
        expect(errors).toEqual(["session"]);

        failing = false;
        expect(await subject.checkIn("foreground")).toBe(true);
        expect(sent).toHaveLength(2);
    });

    it("a reconnect retries a check-in that failed offline, and is throttled like a foreground after a success", async () => {
        let failing = true;
        const { subject, sent, advance } = checkIn({ fail: () => failing });

        expect(await subject.checkIn("session")).toBe(false);
        failing = false;
        expect(await subject.checkIn("reconnect")).toBe(true);
        expect(await subject.checkIn("reconnect")).toBe(false);
        expect(await subject.checkIn("foreground")).toBe(false);

        advance(FOREGROUND_CHECK_IN_INTERVAL_MS);
        expect(await subject.checkIn("reconnect")).toBe(true);
        expect(sent).toHaveLength(3);
    });

    it("a reconnect while a check-in is on its way sends nothing more", async () => {
        const { subject, sent } = checkIn();

        await Promise.all([subject.checkIn("session"), subject.checkIn("reconnect")]);

        expect(sent).toHaveLength(1);
    });

    it("session and rename check-ins are never throttled", async () => {
        const { subject, sent } = checkIn();

        await subject.checkIn("session");
        await subject.checkIn("session");
        await subject.checkIn("rename");

        expect(sent).toHaveLength(3);
    });

    it("a rename check-in waits for one on its way, so the server ends on the new name", async () => {
        const { identity: device } = identity();
        const sent: string[] = [];
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const send = vi.fn(async (_deviceId: string, body: DeviceCheckInBody) => {
            sent.push(body.name);
            if (sent.length === 1) {
                await held;
            }
        });
        const subject = new DeviceCheckIn({ identity: device, platform: "android", send });

        const first = subject.checkIn("session");
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        await device.rename("Living room");
        const second = subject.checkIn("rename");
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(send).toHaveBeenCalledTimes(1);
        release();
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(sent).toEqual(["Pixel 8", "Living room"]);
    });
});

describe("DeviceNameDraft (the Settings field)", () => {
    it("shows the stored name, and saves an edit once even when Done and the blur both save", () => {
        const draft = new DeviceNameDraft();

        expect(draft.loaded("Pixel 8")).toBe("Pixel 8");
        draft.typed("Kitchen tablet");

        expect(draft.take()).toBe("Kitchen tablet");
        expect(draft.take()).toBeUndefined();
    });

    it("saves nothing when nothing was typed, or the edit cleans to the saved name", () => {
        const draft = new DeviceNameDraft();
        draft.loaded("Kitchen tablet");

        expect(draft.take()).toBeUndefined();
        draft.typed("  Kitchen tablet ");
        expect(draft.take()).toBeUndefined();
    });

    it("saves a cleared field, which means the default, and then nothing more", () => {
        const draft = new DeviceNameDraft();
        draft.loaded("Kitchen tablet");

        draft.typed("   ");
        expect(draft.take()).toBe("   ");
        draft.typed("");
        expect(draft.take()).toBeUndefined();
    });

    it("a load that arrives after typing doesn't replace the text, but still counts as saved", () => {
        const draft = new DeviceNameDraft();

        draft.typed("Living room");
        expect(draft.loaded("Living room")).toBeUndefined();
        expect(draft.take()).toBeUndefined();
        draft.typed("Den");
        expect(draft.take()).toBe("Den");
    });

    it("with no stored name, the field starts empty and an empty edit saves nothing", () => {
        const draft = new DeviceNameDraft();

        expect(draft.loaded(undefined)).toBe("");
        draft.typed("");
        expect(draft.take()).toBeUndefined();
    });
});
