import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { getRequests } from "@/app/services/db/queries/request";
import { deleteGenreJam, getGenreJam, getGenreJams, replaceGenreJams, saveGenreJam } from "@/app/services/db/queries/genreJam";
import { RequestType } from "@/app/enums";

/** ShuffullApp#214: a Genre Jam save or delete is the local row AND its outbox row, written together. */
const USER = "u1";

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

const filters = (genreIds: string[] = []) =>
    ({ artistIds: [], playlistIds: [], genreIds, timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] });
const jam = (genreJamId: string, name: string, userId = USER) =>
    ({ genreJamId, userId, name, whitelists: filters(["tag-rock"]), blacklists: filters(), heavinessMin: 4, heavinessMax: 6 });

describe("saving and deleting a Genre Jam queues it for the server", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("a save writes the jam and queues its payload; saving it again replaces the row and queues the new version", async () => {
        await saveGenreJam(db, jam("jam-1", "Loud"));
        await saveGenreJam(db, { ...jam("jam-1", "Louder"), heavinessMin: null, heavinessMax: null });

        expect(await getGenreJams(db, USER)).toEqual([{ ...jam("jam-1", "Louder"), heavinessMin: null, heavinessMax: null }]);
        expect((await getRequests(db, USER)).map(x => [x.requestType, x.payload])).toEqual([
            [RequestType.SaveGenreJam, { genreJamId: "jam-1", name: "Loud", whitelists: filters(["tag-rock"]), blacklists: filters(), heavinessMin: 4, heavinessMax: 6 }],
            [RequestType.SaveGenreJam, { genreJamId: "jam-1", name: "Louder", whitelists: filters(["tag-rock"]), blacklists: filters(), heavinessMin: null, heavinessMax: null }],
        ]);
    });

    it("a delete removes the jam and queues the delete", async () => {
        await saveGenreJam(db, jam("jam-1", "Loud"));
        await deleteGenreJam(db, USER, "jam-1");

        expect(await getGenreJams(db, USER)).toEqual([]);
        expect((await getRequests(db, USER)).map(x => [x.requestType, x.payload])).toEqual([
            [RequestType.SaveGenreJam, expect.objectContaining({ genreJamId: "jam-1" })],
            [RequestType.DeleteGenreJam, { genreJamId: "jam-1" }],
        ]);
    });

    it("a save whose outbox row can't be written leaves no jam behind", async () => {
        await db.run(sql`create trigger refuse_requests before insert on requests begin select raise(abort, 'outbox refused'); end`);

        await expect(saveGenreJam(db, jam("jam-1", "Loud"))).rejects.toThrow();

        expect(await getGenreJams(db, USER)).toEqual([]);
    });

    it("only the signed-in user's jams are listed or found", async () => {
        await saveGenreJam(db, jam("jam-1", "Mine"));
        await saveGenreJam(db, jam("jam-2", "Theirs", "u2"));

        expect((await getGenreJams(db, USER)).map(x => x.name)).toEqual(["Mine"]);
        expect(await getGenreJam(db, USER, "jam-2")).toBeUndefined();
    });
});

describe("replaceGenreJams: what a sync writes", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("the user's jams become exactly the list given, sorted by name, and nothing is queued", async () => {
        await saveGenreJam(db, jam("jam-old", "Old"));
        const queued = (await getRequests(db, USER)).length;

        await replaceGenreJams(db, USER, [jam("jam-b", "Beta"), jam("jam-a", "Alpha")]);

        expect((await getGenreJams(db, USER)).map(x => x.genreJamId)).toEqual(["jam-a", "jam-b"]);
        expect(await getRequests(db, USER)).toHaveLength(queued);
    });

    it("leaves other accounts' jams alone, unless one holds an id the server just gave this user", async () => {
        await saveGenreJam(db, jam("jam-x", "Theirs", "u2"));
        await saveGenreJam(db, jam("jam-shared", "Stale", "u2"));

        await replaceGenreJams(db, USER, [jam("jam-shared", "Mine")]);

        expect((await getGenreJams(db, USER)).map(x => x.name)).toEqual(["Mine"]);
        expect((await getGenreJams(db, "u2")).map(x => x.name)).toEqual(["Theirs"]);
    });
});
