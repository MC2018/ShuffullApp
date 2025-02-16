import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as DbQueries from "../services/db/queries";
import * as FileSystem from "expo-file-system";
import { verifyFileIntegrity } from "./utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { getNetworkStateAsync, NetworkStateType } from "expo-network";
import { GenericDb } from "../services/db/GenericDb";
import path from "path-browserify";

if (FileSystem.documentDirectory == null) {
    throw new Error("documentDirectory is null");
}

const tempFolder = path.join(FileSystem.documentDirectory, "temp");
const destFolder = path.join(FileSystem.documentDirectory, "music");
const albumArtFolder = path.join(FileSystem.documentDirectory, "album_art");

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
            await FileSystem.makeDirectoryAsync(destFolder, { intermediates: true });
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
            const songFileName = Downloader.generateSongFileName(songs[i]);

            if (await Downloader.songFileExists(songFileName)) {
                existingSongs.push(songs[i].songId);
            }
        }
    
        songs = songs.filter(x => !existingSongs.includes(x.songId));
        await DbQueries.addToDownloadQueue(this.db, songs.map(x => x.songId), priority);
    }

    static async songFileExists(fileName: string) {
        const fileInfo = await FileSystem.getInfoAsync(Downloader.generateLocalSongUri(fileName));
        return fileInfo.exists;
    }
    
    static generateLocalSongUri(fileName: string) {
        return `${destFolder}${fileName}`;
    }

    async downloadNext() {
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
    
        if (this.downloading || this.paused) {
            return;
        }
    
        try {
            this.downloading = true;
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
    
            if (hostAddress == null) {
                return;
            }
    
            const songFileName = Downloader.generateSongFileName(song);
            const songDownloadedPath = path.join(tempFolder, songFileName);
            const downloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "music", songFileName),
                songDownloadedPath);
    
            if (await Downloader.songFileExists(songFileName)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return;
            }
    
            const downloadedFile = await downloadResumable.downloadAsync();
    
            if (downloadedFile == undefined || !(await Downloader.songFileExists(songFileName))) {
                return;
            }
    
            const verified = await verifyFileIntegrity(downloadedFile.uri)
    
            if (!verified) {
                return;
            }

            await FileSystem.moveAsync({
                from: downloadedFile.uri,
                to: path.join(destFolder, songFileName)
            });
            await DbQueries.removeFromDownloadQueue(this.db, song.songId);
        } catch (e) {
            console.error(e);
        } finally {
            this.downloading = false;
        }
    }

    static generateSongFileName(song: { fileHash: string, fileExtension: string }) {
        return `${song.fileHash}${song.fileExtension}`;
    } 
}

export enum DownloadPriority {
    Low = 1,
    Medium = 2,
    High = 3
}
