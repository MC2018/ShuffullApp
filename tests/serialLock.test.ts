import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSerialLock } from "@/app/tools/serialLock";

// ShuffullApp#22: the media manager's play/pause/skip/previous each read the current song, await the database and
// the player several times, then write. Started together they interleave at every await.

/** The shape of a skip: read what is current, do slow work, then write based on what was read. */
function makePlayer() {
    let current = 0;
    const started: number[] = [];

    async function skip() {
        const from = current;
        await new Promise((resolve) => setTimeout(resolve, 10));
        started.push(from + 1);
        current = from + 1;
    }

    return { skip, started, get current() { return current; } };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("createSerialLock", () => {
    it("without it, two fast skips both start from the same song", async () => {
        // The race this module exists for, shown on the model above so the next test's assertion means something.
        const player = makePlayer();

        const both = Promise.all([player.skip(), player.skip()]);
        await vi.runAllTimersAsync();
        await both;

        expect(player.started).toEqual([1, 1]);
        expect(player.current).toBe(1);
    });

    it("runs each skip from the state the previous one left", async () => {
        const player = makePlayer();
        const lock = createSerialLock();

        const both = Promise.all([lock.run(player.skip), lock.run(player.skip), lock.run(player.skip)]);
        await vi.runAllTimersAsync();
        await both;

        expect(player.started).toEqual([1, 2, 3]);
        expect(player.current).toBe(3);
    });

    it("runs tasks in the order they were requested", async () => {
        const lock = createSerialLock();
        const order: string[] = [];
        const step = (name: string, ms: number) => () =>
            new Promise<void>((resolve) => setTimeout(() => { order.push(name); resolve(); }, ms));

        // Durations deliberately reversed: without the lock "pause" would finish first.
        const all = Promise.all([lock.run(step("skip", 30)), lock.run(step("play", 20)), lock.run(step("pause", 10))]);
        await vi.runAllTimersAsync();
        await all;

        expect(order).toEqual(["skip", "play", "pause"]);
    });

    it("hands each caller its own task's result", async () => {
        const lock = createSerialLock();

        await expect(Promise.all([lock.run(async () => "a"), lock.run(async () => 2)])).resolves.toEqual(["a", 2]);
    });

    it("rejects only the caller whose task failed, and keeps going", async () => {
        const lock = createSerialLock();
        const ran: string[] = [];

        const failing = lock.run(async () => { throw new Error("player unavailable"); });
        const next = lock.run(async () => { ran.push("next"); });

        await expect(failing).rejects.toThrow("player unavailable");
        await next;
        expect(ran).toEqual(["next"]);
    });

    it("lets the next task run once a holder has been stuck past the limit", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const lock = createSerialLock({ maxHoldMs: 1_000 });
        const ran: string[] = [];

        void lock.run(() => new Promise<void>(() => undefined)); // a native call that never settles
        const next = lock.run(async () => { ran.push("next"); });

        await vi.advanceTimersByTimeAsync(999);
        expect(ran).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await next;
        expect(ran).toEqual(["next"]);
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("times how long a task holds the lock, not how long it queued", async () => {
        const lock = createSerialLock({ maxHoldMs: 1_000 });
        const order: string[] = [];
        const slow = (name: string) => () =>
            new Promise<void>((resolve) => setTimeout(() => { order.push(name); resolve(); }, 800));

        // b queues behind a for 800ms, then holds for 800ms. Had its clock started when it queued, c would be let
        // in at 1000ms while b was still running.
        void lock.run(slow("a"));
        void lock.run(slow("b"));
        const c = lock.run(async () => { order.push("c"); });

        await vi.advanceTimersByTimeAsync(1_200);
        expect(order).toEqual(["a"]);

        await vi.advanceTimersByTimeAsync(400);
        await c;
        expect(order).toEqual(["a", "b", "c"]);
    });
});
