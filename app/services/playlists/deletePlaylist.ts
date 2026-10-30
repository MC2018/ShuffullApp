import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { Playlist } from "../db/models";
import { Downloader } from "../downloader/Downloader";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools";
import { showAlert } from "@/app/tools/dialog";

/**
 * The one way the app deletes a playlist: asks first, purges it locally the way the server will, and queues the
 * server delete through the outbox, where it waits on any Keep still queued (playlistDeleteHold). Shared by the
 * playlist screen and audition mode's summary, so the deck never grows a delete path of its own.
 * `onDeleted` runs only once the delete is done; Cancel does nothing.
 */
export function confirmDeletePlaylist(db: GenericDb, playlist: Playlist, onDeleted: () => void): void {
    const message = playlist.isExploratory
        ? "Delete this audition playlist? Songs you didn't keep will be removed from your library; kept (liked) songs stay."
        : "Delete this playlist? Its songs stay in your library.";
    showAlert("Delete playlist", message, [
        { text: "Cancel", style: "cancel" },
        {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
                await deletePlaylist(db, playlist);
                onDeleted();
            },
        },
    ]);
}

async function deletePlaylist(db: GenericDb, playlist: Playlist): Promise<void> {
    // Read before the purge removes them: the queued delete carries them so it waits only for Keeps
    // of songs in THIS playlist.
    const songIds = await DbQueries.getPlaylistSongIds(db, playlist.playlistId);
    // Purge locally (mirrors the server) and clean up any downloaded media for the removed songs.
    const purged = await DbQueries.deletePlaylistAndPurge(db, playlist.playlistId);
    // Media is stored by hash: leave a file another local song still plays.
    const filesInUse = await DbQueries.fileHashesInUse(db, purged.map(x => x.fileHash));
    for (const song of purged.filter(x => !filesInUse.has(x.fileHash))) {
        await Downloader.deleteLocalSongFiles(song);
    }
    // Tell the server (also performs the purge). Queued so a delete made offline still lands.
    await DbQueries.addRequests(db, [
        {
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.DeletePlaylist,
            userId: playlist.userId,
            playlistId: playlist.playlistId,
            payload: { songIds },
        },
    ]);
}
