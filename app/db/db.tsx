import * as SQLite from "expo-sqlite";

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
    const db = await SQLite.openDatabaseAsync("shuffull-db");

    // TODO: If Drizzle isn't used, create a hash of all table creates and save that hash in the DB; if they don't match on startup, reset the db
    // One may be separately made for login (cache) info so it isn't always cleared
    await db.withTransactionAsync(async () => {
        db.runAsync(`create table if not exists items (id integer primary key not null, value text);`)
        db.runAsync(`INSERT INTO items (value) VALUES ('yo');`)
        const count: any = await db.getFirstAsync(`SELECT COUNT(*) FROM items;`)
        // console.log("Count: " + count["COUNT(*)"])
    });

    return db
}
