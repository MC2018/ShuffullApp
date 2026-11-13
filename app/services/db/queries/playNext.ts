import { and, asc, eq } from "drizzle-orm";
import { GenericDb } from "../GenericDb";
import { PlayNextIntent } from "../models";
import { playNextIntentTable } from "../schema";

// Play-next intents (ShuffullApp#108): see playNextIntentTable.

/**
 * Records the tap. A second tap on the same song starts it over: a new request, a fresh wait. (recordPlayNext also
 * refreshes the wait when a song already has a row under the other screen's key, rather than adding a second row.)
 */
export async function savePlayNextIntent(db: GenericDb, intent: PlayNextIntent): Promise<void> {
    await db.insert(playNextIntentTable).values(intent).onConflictDoUpdate({
        target: [playNextIntentTable.userId, playNextIntentTable.externalSongId],
        set: { songRequestId: intent.songRequestId, title: intent.title, songId: intent.songId, createdAt: intent.createdAt },
    });
}

/** Oldest first, which is the order they were asked for. */
export async function getPlayNextIntents(db: GenericDb, userId: string): Promise<PlayNextIntent[]> {
    return await db.select().from(playNextIntentTable)
        .where(eq(playNextIntentTable.userId, userId))
        .orderBy(asc(playNextIntentTable.createdAt));
}

// Both match the tap by its time as well, so a reconcile that read an intent can't touch the one a second tap on the
// same song has since put in its place.
type IntentKey = Pick<PlayNextIntent, "userId" | "externalSongId" | "createdAt">;

const matches = (intent: IntentKey) => and(
    eq(playNextIntentTable.userId, intent.userId),
    eq(playNextIntentTable.externalSongId, intent.externalSongId),
    eq(playNextIntentTable.createdAt, intent.createdAt));

/** Fills in what was learned about an intent: its request id once filed, its song once Completed. */
export async function updatePlayNextIntent(db: GenericDb, intent: IntentKey,
    change: Partial<Pick<PlayNextIntent, "songRequestId" | "songId">>): Promise<void> {
    await db.update(playNextIntentTable).set(change).where(matches(intent));
}

export async function deletePlayNextIntent(db: GenericDb, intent: IntentKey): Promise<void> {
    await db.delete(playNextIntentTable).where(matches(intent));
}
