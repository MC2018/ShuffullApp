import { Playlist } from "../services/db/models";

export function toPlaylist(navigation: any, playlistId: number) {
    navigation.navigate("Playlist", { playlistId });
}

export function toLibrary(navigation: any, userId: number) {
    navigation.navigate("LibraryStack", { userId });
}

export function toLocalDownloads(navigation: any) {
    navigation.navigate("LocalDownloads", {});
}
