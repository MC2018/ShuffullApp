export function toPlaylist(navigation: any, playlistId: number) {
    navigation.navigate("Playlist", { playlistId });
}

export function toLibrary(navigation: any, userId: number) {
    navigation.navigate("LibraryStack", { userId });
}

export function toLocalDownloads(navigation: any) {
    navigation.navigate("LocalDownloads", {});
}

export function toGenreJamEditor(navigation: any, userId: number) {
    navigation.navigate("GenreJamEditor", { userId });
}
