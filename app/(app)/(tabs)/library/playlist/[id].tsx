import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";
import { DownloadPriority, SongDetails } from "@/app/services/db/types";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { MediaManager } from "@/app/services/media-manager";
import { useSongStateRevision } from "@/app/services/media-manager/mediaManager";
import { Button, Chip, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { LikeStatus } from "@/app/enums";
import { AuditionRowState, auditionProgress, deriveAuditionRowState } from "@/app/tools/audition";
import { confirmDeletePlaylist } from "@/app/services/playlists/deletePlaylist";

export default function PlaylistScreen() {
    const theme = useTheme();
    const { id: playlistId } = useLocalSearchParams<{ id: string }>();
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [playlist, setPlaylist] = useState<Playlist | null>(null);
    const [songStates, setSongStates] = useState<Record<string, AuditionRowState>>({});
    const [search, setSearch] = useState("");
    const [unheardOnly, setUnheardOnly] = useState(false);
    // Feedback for the Download button, which used to be fire-and-forget. Reset when the playlist changes.
    const [downloadLabel, setDownloadLabel] = useState<string | null>(null);
    const db = useDb();
    const downloader = useDownloader();
    // Moves whenever a song starts, is rated or is kept, wherever that happened (this list, Now Playing, the
    // notification, a song ending on its own).
    const songStateRevision = useSongStateRevision((s) => s.revision);

    // Per-row audition/heard states, derived entirely from synced data (identical across devices). Computed for
    // every playlist: audition views render the full three-state treatment, and the "unheard only" chip works
    // everywhere.
    const loadSongStates = useCallback(async (dbPlaylist: Playlist) => {
        const sessionData = await DbQueries.getActiveLocalSessionData(db);
        if (!sessionData) {
            return;
        }
        const rows = await DbQueries.getPlaylistSongStates(db, sessionData.userId, dbPlaylist.playlistId);
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
    }, [db]);

    useEffect(() => {
        if (playlistId == undefined) {
            return;
        }
        setDownloadLabel(null);
        (async () => {
            const dbPlaylist = await DbQueries.getPlaylist(db, playlistId);
            if (dbPlaylist == undefined) {
                // TODO: fetch playlist info from server
                throw new Error("Playlist not in DB");
            }
            setPlaylist(dbPlaylist);
            const dbSongs = await DbQueries.getSongDetailsByPlaylist(db, playlistId);
            setSongs(dbSongs);
        })();
    }, [playlistId]);

    // Runs once the playlist loads and again on every revision, so "N/M evaluated" moves as songs play instead
    // of only when the screen is re-opened.
    useEffect(() => {
        if (playlist != undefined) {
            loadSongStates(playlist);
        }
    }, [playlist, songStateRevision, loadSongStates]);

    // Audition mode's summary can delete this playlist from a screen on top of this one. Coming back to a playlist
    // that no longer exists goes back to the list instead of showing it.
    const loaded = playlist != undefined;
    useFocusEffect(
        useCallback(() => {
            if (!loaded || playlistId == undefined) {
                return;
            }
            let cancelled = false;
            (async () => {
                if ((await DbQueries.getPlaylist(db, playlistId)) == undefined && !cancelled) {
                    router.back();
                }
            })();
            return () => {
                cancelled = true;
            };
        }, [db, playlistId, loaded]),
    );

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
    // Not before the states load: an empty count would read as "all heard" for a moment on every open.
    const allHeard = progress.total > 0 && progress.evaluated >= progress.total;

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
        if (!downloader) {
            return;
        }
        const result = await downloader.addPlaylistToDownloadQueue(playlist.playlistId, DownloadPriority.Medium);
        // Say what happened on the button itself: it's the thing that was just tapped, and the Downloads
        // screen (Library › Downloads) is where progress lives.
        setDownloadLabel(result.queued > 0 ? `Queued ${result.queued}` : "All saved");
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

    const confirmDelete = () => confirmDeletePlaylist(db, playlist, () => router.back());

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
                    <Button
                        label={downloadLabel ?? "Download"}
                        icon={downloadLabel ? "checkmark" : "download-outline"}
                        variant="ghost"
                        onPress={downloadPlaylist}
                        style={{ flex: 1 }}
                    />
                    <Button label="Delete" icon="trash-outline" variant="ghost" onPress={confirmDelete} />
                </View>
                {playlist.isExploratory ? (
                    <Button
                        label={allHeard ? "Audition mode · all heard" : "Audition mode"}
                        icon="albums-outline"
                        variant="ghost"
                        disabled={allHeard}
                        onPress={() => router.push({ pathname: "/audition/[id]", params: { id: playlist.playlistId } })}
                        style={{ marginBottom: theme.space.md }}
                    />
                ) : null}
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
