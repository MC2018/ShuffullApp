export function toPlaylist(navigation: any, playlistId: string) {
    navigation.navigate("Playlist", { playlistId });
}

export function toLibrary(navigation: any, userId: string) {
    navigation.navigate("LibraryStack", { userId });
}

export function toLocalDownloads(navigation: any) {
    navigation.navigate("LocalDownloads", {});
}

export function toGenreJamEditor(navigation: any, userId: string) {
    navigation.navigate("GenreJamEditor", { userId });
}
