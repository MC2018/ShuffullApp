import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as DbQueries from "../services/db/queries";
import * as FileSystem from "expo-file-system";
import { verifyFileIntegrity } from "./utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { getNetworkStateAsync, NetworkStateType } from "expo-network";
import { GenericDb } from "../services/db/GenericDb";
import path from "path-browserify";
import { Song } from "../services/db/models";

if (FileSystem.documentDirectory == null) {
    throw new Error("documentDirectory is null");
}

const tempFolder = path.join(FileSystem.documentDirectory, "temp");
const musicFolder = path.join(FileSystem.documentDirectory, "music");
const albumArtFolder = path.join(FileSystem.documentDirectory, "albumart");

export class Downloader {
    downloading = false;
    paused = true;
    db: ExpoSQLiteDatabase;
    timerId: NodeJS.Timeout;

    constructor(db: GenericDb) {
        this.db = db;

        // TODO: make it so downloadNext is called less often, and continues downloading next on its own
        this.timerId = setInterval(async () => {
            if (!this.downloading && !this.paused) {
                await this.downloadNext();
            }
        }, 2000);
        this.paused = false;
    
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
    }

    public async addSongToDownloadQueue(songId: number, priority: DownloadPriority) {
        await DbQueries.addToDownloadQueue(this.db, [songId], priority);
    }

    // TODO: this could be optimized to prevent spam-presses
    async addPlaylistToDownloadQueue(playlistId: number, priority: DownloadPriority) {
        let songs = await DbQueries.getSongsByPlaylist(this.db, playlistId);
        const existingSongs: number[] = [];

        for (let i = 0; i < songs.length; i++) {
            const localSongUri = Downloader.generateLocalSongUri(songs[i]);

            if (await Downloader.fileExists(localSongUri)) {
                existingSongs.push(songs[i].songId);
            }
        }
    
        songs = songs.filter(x => !existingSongs.includes(x.songId));
        await DbQueries.addToDownloadQueue(this.db, songs.map(x => x.songId), priority);
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
    
            const networkState = await getNetworkStateAsync();
    
            if (!networkState.isInternetReachable || networkState.type == NetworkStateType.CELLULAR) {
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
            const songFileName = Downloader.generateSongFileName(song);
            const songDownloadedPath = path.join(tempFolder, songFileName);
            const songDownloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "music", songFileName),
                songDownloadedPath);
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
        } catch (e) {
            console.error(e);
        } finally {
            this.downloading = false;
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

export enum DownloadPriority {
    Low = 1,
    Medium = 2,
    High = 3
}
