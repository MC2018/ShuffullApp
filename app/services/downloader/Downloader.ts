import DbQueries from "../db/queries";
import * as FileSystem from "expo-file-system/legacy";
import { verifyFileIntegrity } from "../../tools/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { addNetworkStateListener, getNetworkStateAsync, NetworkState } from "expo-network";
import { GenericDb } from "../db/GenericDb";
import path from "path-browserify";
import { Song } from "../db/models";
import { DownloadPriority } from "../db/types";
import { useDownloadStatus } from "./downloadStatus";
import { derivePhase, isDownloadNetwork } from "../../tools/downloadStatus";

if (FileSystem.documentDirectory == null) {
    throw new Error("documentDirectory is null");
}

const tempFolder = path.join(FileSystem.documentDirectory, "temp");
const musicFolder = path.join(FileSystem.documentDirectory, "music");
const albumArtFolder = path.join(FileSystem.documentDirectory, "albumart");

export class Downloader {
    downloading = false;
    // Starts true so the timer cannot fire before the persisted value is read; the constructor flips it.
    paused = true;
    // Matches the constructor, which was already driver-agnostic — the field just hadn't kept up.
    db: GenericDb;
    timerId: ReturnType<typeof setInterval>;
    // Last network state seen, from the listener (instant) or the polled read (each attempt). Only used
    // to publish the phase - the download itself always re-reads before starting.
    private network: NetworkState | undefined;
    private networkSubscription: { remove: () => void } | undefined;
    private songInFlight: string | undefined;

    constructor(db: GenericDb) {
        this.db = db;

        // TODO: make it so downloadNext is called less often, and continues downloading next on its own
        this.timerId = setInterval(async () => {
            if (!this.downloading && !this.paused) {
                await this.downloadNext();
            }
            // Even when nothing runs, keep the published phase honest (queue count, network).
            await this.publishStatus();
        }, 2000);

        // Pause is a user decision, so it survives restarts (see CLAUDE.md "durability before enrichment"
        // - same principle at a smaller scale: the choice lives in storage, not in whatever the loop last did).
        (async () => {
            this.paused = (await AsyncStorage.getItem(STORAGE_KEYS.DOWNLOADS_PAUSED)) === "1";
            await this.publishStatus();
        })();

        // Surface "waiting for Wi-Fi" the moment the network changes rather than on the next tick.
        this.networkSubscription = addNetworkStateListener((state) => {
            this.network = state;
            void this.publishStatus();
        });

        // Ensure directories exist
        (async () => {
            await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(musicFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(albumArtFolder, { intermediates: true });
        })();
    }

    // TODO: improve
    public dispose() {
        this.paused = true;
        clearInterval(this.timerId);
        this.networkSubscription?.remove();
    }

    /** Stops starting NEW downloads. A song already in flight is allowed to finish (they are single files). */
    public async pause() {
        this.paused = true;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "1");
        await this.publishStatus();
    }

    public async resume() {
        this.paused = false;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "0");
        await this.publishStatus();
        // Don't make the user wait out the timer to see it start.
        void this.downloadNext();
    }

    public async removeFromQueue(songId: string) {
        await DbQueries.removeFromDownloadQueue(this.db, songId);
        await this.publishStatus();
    }

    public async clearQueue() {
        await DbQueries.removeAllFromDownloadQueue(this.db);
        await this.publishStatus();
    }

    /**
     * Recomputes the observable status from the queue, the loop's own flags and the last network state.
     * Cheap (one COUNT), and the only writer of the store apart from the in-flight progress callback.
     */
    private async publishStatus() {
        try {
            const queuedCount = await DbQueries.countDownloadQueue(this.db);
            if (this.network == undefined) {
                this.network = await getNetworkStateAsync();
            }
            const phase = derivePhase({
                paused: this.paused,
                downloading: this.downloading,
                queuedCount,
                network: { isInternetReachable: this.network.isInternetReachable === true, type: this.network.type },
            });
            const current = useDownloadStatus.getState().status.current;
            useDownloadStatus.getState().setStatus({
                phase,
                queuedCount,
                // Keep the progress the callback wrote; only clear it once nothing is in flight.
                current: this.songInFlight ? (current?.songId === this.songInFlight ? current : { songId: this.songInFlight, progress: 0 }) : undefined,
            });
        } catch (e) {
            console.warn("[downloader] failed to publish status", e);
        }
    }

    private publishProgress(songId: string, progress: number) {
        const current = useDownloadStatus.getState().status.current;
        // Throttle to whole-percent changes so a large file doesn't re-render the screen hundreds of times.
        if (current?.songId === songId && Math.round(current.progress * 100) === Math.round(progress * 100)) {
            return;
        }
        useDownloadStatus.getState().setStatus({ current: { songId, progress } });
    }

    public async addSongToDownloadQueue(songId: string, priority: DownloadPriority) {
        await DbQueries.addToDownloadQueue(this.db, [songId], priority);
        await this.publishStatus();
    }

    // TODO: this could be optimized to prevent spam-presses
    /** Returns what happened so the button can say so: how many were queued vs. already on disk. */
    async addPlaylistToDownloadQueue(playlistId: string, priority: DownloadPriority): Promise<{ queued: number; alreadyDownloaded: number }> {
        let songs = await DbQueries.getSongsByPlaylist(this.db, playlistId);
        const existingSongs: string[] = [];

        for (let i = 0; i < songs.length; i++) {
            const localSongUri = Downloader.generateLocalSongUri(songs[i]);

            if (await Downloader.fileExists(localSongUri)) {
                existingSongs.push(songs[i].songId);
            }
        }
    
        songs = songs.filter(x => !existingSongs.includes(x.songId));
        await DbQueries.addToDownloadQueue(this.db, songs.map(x => x.songId), priority);
        await this.publishStatus();
        return { queued: songs.length, alreadyDownloaded: existingSongs.length };
    }

    public static async fileExists(uri: string) {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        return fileInfo.exists;
    }

    async downloadNext() {
        if (this.downloading || this.paused) {
            return;
        }

        try {
            this.downloading = true;
            const nextDownload = await DbQueries.getFromDownloadQueue(this.db);
    
            if (!nextDownload) {
                return;
            }

            const song = await DbQueries.getSong(this.db, nextDownload.songId);
    
            if (!song) {
                await DbQueries.removeFromDownloadQueue(this.db, nextDownload.songId);
                return;
            }
    
            // Re-read rather than trust the listener: this is the gate that spends the user's data.
            // Allowlist (Wi-Fi / Ethernet), not "anything but cellular" - see tools/downloadStatus.ts.
            const networkState = await getNetworkStateAsync();
            this.network = networkState;

            if (!networkState.isInternetReachable || !isDownloadNetwork(networkState.type)) {
                return;
            }

            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
    
            if (hostAddress == null) {
                return;
            }
    
            // Make sure song isn't already downloaded
            const localSongUri = Downloader.generateLocalSongUri(song);

            if (await Downloader.fileExists(localSongUri)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return;
            }

            // Download song
            this.songInFlight = song.songId;
            this.publishProgress(song.songId, 0);
            await this.publishStatus();
            const songFileName = Downloader.generateSongFileName(song);
            const songDownloadedPath = path.join(tempFolder, songFileName);
            const songDownloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "music", songFileName),
                songDownloadedPath,
                {},
                ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                    if (totalBytesExpectedToWrite > 0) {
                        this.publishProgress(song.songId, totalBytesWritten / totalBytesExpectedToWrite);
                    }
                },
            );
            const downloadedSongFile = await songDownloadResumable.downloadAsync();
    
            if (downloadedSongFile == undefined) {
                return;
            }
    
            const verifiedSong = await verifyFileIntegrity(downloadedSongFile.uri)
    
            if (!verifiedSong) {
                return;
            }

            // Download album art
            const albumArtFileName = `${song.fileHash}.jpg`;
            const albumArtDownloadedPath = path.join(tempFolder, albumArtFileName);
            const albumArtDownloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "albumart", albumArtFileName),
                albumArtDownloadedPath);
    
            if (await Downloader.fileExists(localSongUri)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return;
            }

            const downloadedAlbumArtFile = await albumArtDownloadResumable.downloadAsync();
    
            if (downloadedAlbumArtFile == undefined) {
                return;
            }

            // Move song and art to respective folder
            await FileSystem.moveAsync({
                from: downloadedSongFile.uri,
                to: path.join(musicFolder, songFileName)
            });
            await FileSystem.moveAsync({
                from: downloadedAlbumArtFile.uri,
                to: path.join(albumArtFolder, albumArtFileName)
            });
            await DbQueries.addDownloadedSong(this.db, song.songId);
            await DbQueries.removeFromDownloadQueue(this.db, song.songId);
            useDownloadStatus.getState().setStatus({ completedCount: useDownloadStatus.getState().status.completedCount + 1 });
        } catch (e) {
            console.error(e);
        } finally {
            this.downloading = false;
            this.songInFlight = undefined;
            await this.publishStatus();
        }
    }

    public static generateSongFileName(song: { fileHash: string, fileExtension: string }) {
        return `${song.fileHash}${song.fileExtension}`;
    }

    public static generateAlbumArtFileName(song: Song) {
        return `${song.fileHash}.jpg`;
    }
    
    public static generateLocalSongUri(song: Song) {
        return path.join(musicFolder, Downloader.generateSongFileName(song));
    }

    // Removes a song's local audio + album-art files (keyed by fileHash). Best-effort and idempotent — pass the
    // OLD song record after its server fileHash changed so the now-orphaned files are cleaned up; missing files
    // are a no-op. Does not touch the DB (the caller clears the downloaded flag).
    public static async deleteLocalSongFiles(song: Song) {
        try {
            await FileSystem.deleteAsync(Downloader.generateLocalSongUri(song), { idempotent: true });
            await FileSystem.deleteAsync(Downloader.generateLocalAlbumArtUri(song), { idempotent: true });
        } catch (e) {
            console.warn(`Failed to delete local files for replaced song ${song.songId}:`, e);
        }
    }

    public static generateLocalAlbumArtUri(song: Song) {
        return path.join(albumArtFolder, Downloader.generateAlbumArtFileName(song));
    }

    public static async generateServerAlbumArtUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

        if (hostAddress == null) {
            throw new Error("Host address is null");
        }

        return path.join(hostAddress, "albumart", `${song.fileHash}.jpg`);
    }
}
