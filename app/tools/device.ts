// The pure parts of device identity (ShuffullApp#58): this install's id, its name, and the check-in that tells the
// server both. services/device.ts wires them to AsyncStorage, the platform and the API. Nothing here imports React
// Native, so the tests run it as is.

import type { DeviceCheckInBody } from "../services/api/models";

/** The API's limits (Shuffull's UserDevice): longer, or holding a control character, is a 400. */
export const DEVICE_ID_MAX_LENGTH = 64;
export const DEVICE_NAME_MAX_LENGTH = 64;

/**
 * A check-in on coming to the foreground or getting the network back is skipped if one succeeded this recently. Other
 * triggers always send.
 */
export const FOREGROUND_CHECK_IN_INTERVAL_MS = 5 * 60_000;

/** The facts a default name is made from. */
export interface DeviceEnvironment {
    /** `Platform.OS`. */
    os: string;
    /** The Electron app, which runs the web build (`desktopShell()` present). */
    desktop: boolean;
    /** Android's `Platform.constants.Model`, e.g. "Pixel 8". */
    model?: string | null;
    /** iOS's `Platform.isPad`. */
    isPad?: boolean;
    /** The browser's `navigator.userAgent`, on web. */
    userAgent?: string | null;
}

const hasControlCharacter = (value: string) => /\p{Cc}/u.test(value);

/** The browser a user agent names, or undefined when it isn't one of the few worth telling apart. Order matters: Edge
 * and Opera also say "Chrome", and Chrome also says "Safari". */
export function browserName(userAgent: string | null | undefined): string | undefined {
    if (!userAgent) {
        return undefined;
    }
    if (/\bEdg(e|A|iOS)?\//.test(userAgent)) {
        return "Edge";
    }
    if (/\b(OPR|Opera)\//.test(userAgent)) {
        return "Opera";
    }
    if (/\b(Firefox|FxiOS)\//.test(userAgent)) {
        return "Firefox";
    }
    if (/\b(Chrome|Chromium|CriOS)\//.test(userAgent)) {
        return "Chrome";
    }
    if (/\bSafari\//.test(userAgent)) {
        return "Safari";
    }
    return undefined;
}

/**
 * A name as the API will take it: control characters dropped, trimmed, cut to the length limit. Undefined when
 * nothing is left, which means "no name": the default is used instead.
 */
export function cleanDeviceName(name: string | null | undefined): string | undefined {
    // The cut counts UTF-16 units, like the API's limit, so an emoji across it would leave half a pair: drop that half.
    const cleaned = (name ?? "").replace(/\p{Cc}/gu, "").trim().slice(0, DEVICE_NAME_MAX_LENGTH)
        .replace(/[\uD800-\uDBFF]$/, "").trim();
    return cleaned.length > 0 ? cleaned : undefined;
}

/** What a device is called until the user names it. */
export function defaultDeviceName(env: DeviceEnvironment): string {
    if (env.desktop) {
        return "Desktop";
    }
    switch (env.os) {
        case "android":
            return cleanDeviceName(env.model) ?? "Android device";
        case "ios":
            return env.isPad ? "iPad" : "iPhone";
        case "web": {
            const browser = browserName(env.userAgent);
            return browser ? `Web (${browser})` : "Web browser";
        }
        default:
            return cleanDeviceName(env.os) ?? "Unknown device";
    }
}

/** Whether a stored id is one the API accepts. Anything else (a hand-edited or truncated value) is replaced. */
export function isValidDeviceId(id: string | null | undefined): id is string {
    return id != null && id.trim().length > 0 && id.length <= DEVICE_ID_MAX_LENGTH && !hasControlCharacter(id);
}

/** The slice of AsyncStorage this needs (localStorage on web and Electron). */
export interface KeyValueStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface DeviceIdentityDeps {
    storage: KeyValueStore;
    /** A fresh random id (a UUID). */
    makeId: () => string;
    environment: () => DeviceEnvironment;
    idKey: string;
    nameKey: string;
}

/**
 * This install's id and name: the one place to read them (ShuffullApp#194 uses it too, and never makes its own).
 *
 * The id is made on first use and stored, so every later read, in this run or the next, gets the same one. Logging
 * out keeps it. Clearing app data or site data, or reinstalling, loses it, and the next id is a new device.
 */
export class DeviceIdentity {
    private idRead: Promise<string> | undefined;

    constructor(private readonly deps: DeviceIdentityDeps) {}

    /**
     * The install id. Concurrent first calls share one read, so they can't each make and store a different id. If
     * the new id can't be stored, this run still uses it throughout, and the next run makes another.
     */
    id(): Promise<string> {
        this.idRead ??= this.readOrMakeId().catch(e => {
            this.idRead = undefined;
            throw e;
        });
        return this.idRead;
    }

    /** The name the user chose, if any. */
    async customName(): Promise<string | undefined> {
        return cleanDeviceName(await this.deps.storage.getItem(this.deps.nameKey));
    }

    defaultName(): string {
        return defaultDeviceName(this.deps.environment());
    }

    /** The name sent to the server: the user's, else the default. */
    async name(): Promise<string> {
        return (await this.customName()) ?? this.defaultName();
    }

    /** Stores the user's name for this device. An empty one goes back to the default. Returns the name now in use. */
    async rename(name: string): Promise<string> {
        const cleaned = cleanDeviceName(name);
        if (cleaned == undefined) {
            await this.deps.storage.removeItem(this.deps.nameKey);
            return this.defaultName();
        }
        await this.deps.storage.setItem(this.deps.nameKey, cleaned);
        return cleaned;
    }

    private async readOrMakeId(): Promise<string> {
        const stored = await this.deps.storage.getItem(this.deps.idKey);
        if (isValidDeviceId(stored)) {
            return stored;
        }

        const id = this.deps.makeId();
        try {
            await this.deps.storage.setItem(this.deps.idKey, id);
        } catch {
            // Kept for this run: a listen and the check-in must agree on the id even if storage is broken.
        }
        return id;
    }
}

/**
 * The Settings device-name field's save rules, kept out of the screen so they can be tested. The screen saves on
 * blur and again when it closes (Back with the keyboard up doesn't blur first), and Done blurs too, so `take` must
 * hand out each edit once, and only an edit that changes the cleaned name.
 */
export class DeviceNameDraft {
    private typedText: string | undefined;
    private savedName = "";

    /** The stored name has been read. Returns the text to show, or undefined when the user has already typed. */
    loaded(name: string | undefined): string | undefined {
        this.savedName = name ?? "";
        return this.typedText == undefined ? this.savedName : undefined;
    }

    typed(text: string): void {
        this.typedText = text;
    }

    /** The text to save now, or undefined when there is nothing new. An empty result means "use the default". */
    take(): string | undefined {
        const text = this.typedText;
        if (text == undefined) {
            return undefined;
        }
        const cleaned = cleanDeviceName(text) ?? "";
        if (cleaned === this.savedName) {
            return undefined;
        }
        this.savedName = cleaned;
        this.typedText = undefined;
        return text;
    }
}

/**
 * Why a check-in is sent. A new session covers both the app starting signed in and a fresh login. A reconnect retries
 * one that failed offline: on web and desktop the app may never leave the foreground again.
 */
export type CheckInTrigger = "session" | "foreground" | "reconnect" | "rename";

const THROTTLED: ReadonlySet<CheckInTrigger> = new Set(["foreground", "reconnect"]);

export interface DeviceCheckInDeps {
    identity: Pick<DeviceIdentity, "id" | "name">;
    /** The same value listens carry (listenPlatform). */
    platform: string;
    send: (deviceId: string, body: DeviceCheckInBody) => Promise<unknown>;
    /** Called with the error when a check-in fails. The next trigger tries again. */
    onError?: (trigger: CheckInTrigger, error: unknown) => void;
    now?: () => number;
}

/**
 * Tells the server this install is open, with its current name (Shuffull#132). Best effort: a failure is reported
 * to `onError` and left for the next trigger. It goes through no outbox, because a missed check-in loses nothing; the
 * next one carries the same facts.
 *
 * A foreground or reconnect check-in is skipped within FOREGROUND_CHECK_IN_INTERVAL_MS of the last one that succeeded, or while
 * one is already on its way. A session or rename check-in always sends, after any one still on its way, so the name
 * it reads is the newest.
 */
export class DeviceCheckIn {
    private lastSucceededAt: number | undefined;
    private inFlight: Promise<boolean> | undefined;
    private readonly now: () => number;

    constructor(private readonly deps: DeviceCheckInDeps) {
        this.now = deps.now ?? Date.now;
    }

    /** Sends a check-in unless the throttle skips it. Resolves whether one was sent and succeeded; never rejects. */
    checkIn(trigger: CheckInTrigger): Promise<boolean> {
        if (THROTTLED.has(trigger)) {
            if (this.inFlight != undefined) {
                return this.inFlight;
            }
            if (this.lastSucceededAt != undefined && this.now() - this.lastSucceededAt < FOREGROUND_CHECK_IN_INTERVAL_MS) {
                return Promise.resolve(false);
            }
        }

        const previous = this.inFlight ?? Promise.resolve(true);
        const attempt = previous.then(() => this.send(trigger));
        this.inFlight = attempt;
        void attempt.finally(() => {
            if (this.inFlight === attempt) {
                this.inFlight = undefined;
            }
        });
        return attempt;
    }

    private async send(trigger: CheckInTrigger): Promise<boolean> {
        try {
            const [deviceId, name] = await Promise.all([this.deps.identity.id(), this.deps.identity.name()]);
            await this.deps.send(deviceId, { name, platform: this.deps.platform });
            this.lastSucceededAt = this.now();
            return true;
        } catch (e) {
            this.deps.onError?.(trigger, e);
            return false;
        }
    }
}
