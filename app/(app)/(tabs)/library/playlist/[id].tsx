import React, { useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";
import { DownloadPriority, SongDetails } from "@/app/services/db/types";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { Downloader } from "@/app/services/downloader/Downloader";
import { MediaManager } from "@/app/services/media-manager";
import { Button, Chip, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { LikeStatus, RequestType } from "@/app/enums";
import { generateId } from "@/app/tools";
import { AuditionRowState, auditionProgress, deriveAuditionRowState } from "@/app/tools/audition";

export default function PlaylistScreen() {
    const theme = useTheme();
    const { id: playlistId } = useLocalSearchParams<{ id: string }>();
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [playlist, setPlaylist] = useState<Playlist | null>(null);
    const [songStates, setSongStates] = useState<Record<string, AuditionRowState>>({});
    const [search, setSearch] = useState("");
    const [unheardOnly, setUnheardOnly] = useState(false);
    const db = useDb();
    const downloader = useDownloader();

    useEffect(() => {
        if (playlistId == undefined) {
            return;
        }
        (async () => {
            const dbPlaylist = await DbQueries.getPlaylist(db, playlistId);
            if (dbPlaylist == undefined) {
                // TODO: fetch playlist info from server
                throw new Error("Playlist not in DB");
            }
            setPlaylist(dbPlaylist);
            const dbSongs = await DbQueries.getSongDetailsByPlaylist(db, playlistId);
            setSongs(dbSongs);

            // Per-row audition/heard states, derived entirely from synced data (identical across devices).
            // Computed for every playlist — audition views render the full three-state treatment, and the
            // "unheard only" chip works everywhere.
            const sessionData = await DbQueries.getActiveLocalSessionData(db);
            if (sessionData) {
                const rows = await DbQueries.getPlaylistSongStates(db, sessionData.userId, playlistId);
                const states: Record<string, AuditionRowState> = {};
                for (const row of rows) {
                    // Pass whether this IS an audition playlist: outside one, "not exploratory" cannot mean
                    // "kept via the Keep button" (nothing here was ever exploratory), and assuming it did made
                    // every row read as evaluated - which is why "Unheard only" filtered to nothing on ordinary
                    // playlists.
                    states[row.songId] = deriveAuditionRowState(
                        row.exploratory, (row.likeStatus ?? LikeStatus.Neutral) as LikeStatus, row.lastPlayed,
                        dbPlaylist.isExploratory);
                }
                setSongStates(states);
            }
        })();
    }, [playlistId]);

    // Search + the unheard-only chip compose over the loaded list; both derive, never mutate.
    const visibleSongs = useMemo(() => {
        let result = songs;
        if (search !== "") {
            const q = search.toLowerCase();
            result = result.filter(
                (x) => x.song.name.toLowerCase().includes(q) || x.artists.map((y) => y.name).join(", ").toLowerCase().includes(q),
            );
        }
        if (unheardOnly) {
            result = result.filter((x) => songStates[x.song.songId] === "unheard");
        }
        return result;
    }, [songs, search, unheardOnly, songStates]);

    const progress = useMemo(() => auditionProgress(Object.values(songStates)), [songStates]);

    const handleSelectSong = async (songDetails: SongDetails) => {
        // Scope shuffle to this playlist, so when the tapped song ends the next one comes from the same
        // playlist instead of playback simply stopping.
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Playlist, [playlistId]);
        // In an audition cohort the follow-on songs should be ones never heard before — picking a track by
        // hand shouldn't drop you back into repeats once it ends.
        scope.unheardOnly = playlist?.isExploratory ?? false;
        await MediaManager.playSpecificSong(songDetails.song.songId, scope);
    };

    // Keep = retain with cheap tags (weak model), without liking. Optimistically reflect the state change
    // in this list so the row flips to its kept treatment immediately.
    const handleKeepSong = async (songDetails: SongDetails) => {
        await MediaManager.keepSong(songDetails.song.songId);
        setSongs(prev => prev.map(s =>
            s.song.songId === songDetails.song.songId
                ? { ...s, song: { ...s.song, exploratory: false, tagsStale: true } }
                : s));
        setSongStates(prev => ({ ...prev, [songDetails.song.songId]: "kept" }));
    };

    if (playlist == undefined) {
        return <Screen><View style={{ flex: 1 }} /></Screen>;
    }

    const downloadPlaylist = async () => {
        await downloader?.addPlaylistToDownloadQueue(playlist.playlistId, DownloadPriority.Medium);
    };

    const playPlaylist = async () => {
        const songFilters = await MediaManager.getSongFilters();
        // TODO: check if filters and list are same: if they are, return early
        songFilters.setSoleFilter(SongFilterType.Playlist, [playlist.playlistId]);
        // Audition playlists exist to give every track one first listen, so they play unheard songs only —
        // ordinary playlists keep the normal least-recently-played shuffle.
        songFilters.unheardOnly = playlist.isExploratory;
        await MediaManager.setSongFilters(songFilters, true);
    };

    const confirmDelete = () => {
        const message = playlist.isExploratory
            ? "Delete this audition playlist? Songs you didn't keep will be removed from your library; kept (liked) songs stay."
            : "Delete this playlist? Its songs stay in your library.";
        Alert.alert("Delete playlist", message, [
            { text: "Cancel", style: "cancel" },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    // Purge locally (mirrors the server) and clean up any downloaded media for the removed songs.
                    const purged = await DbQueries.deletePlaylistAndPurge(db, playlist.playlistId);
                    for (const song of purged) {
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
                        },
                    ]);
                    router.back();
                },
            },
        ]);
    };

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" numberOfLines={1} style={{ marginTop: theme.space.md }}>
                    {playlist.name}
                </Text>
                <Text variant="caption" color="textFaint" style={{ marginTop: 2, marginBottom: theme.space.md }}>
                    {songs.length} songs
                    {playlist.isExploratory ? ` · Audition · ${progress.evaluated}/${progress.total} evaluated` : ""}
                </Text>
                <View style={{ flexDirection: "row", gap: theme.space.sm, marginBottom: theme.space.md }}>
                    <Button label="Play" icon="play" onPress={playPlaylist} style={{ flex: 1 }} />
                    <Button label="Download" icon="download-outline" variant="ghost" onPress={downloadPlaylist} style={{ flex: 1 }} />
                    <Button label="Delete" icon="trash-outline" variant="ghost" onPress={confirmDelete} />
                </View>
                <View style={{ flexDirection: "row", gap: theme.space.sm, alignItems: "center", marginBottom: theme.space.md }}>
                    <TextField
                        placeholder="Search in playlist"
                        onChangeText={setSearch}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={{ flex: 1 }}
                    />
                    <Chip
                        label="Unheard only"
                        state={unheardOnly ? "selected" : "idle"}
                        onPress={() => setUnheardOnly(v => !v)}
                    />
                </View>
                <SongList
                    songs={visibleSongs}
                    onSelectSong={handleSelectSong}
                    onShowInfo={(s) => router.push({ pathname: "/song/[id]", params: { id: s.song.songId } })}
                    onKeepSong={handleKeepSong}
                    auditionStates={playlist.isExploratory ? songStates : undefined}
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
