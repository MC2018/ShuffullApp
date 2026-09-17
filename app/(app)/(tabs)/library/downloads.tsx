import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import DownloadStatusCard from "@/app/components/downloading/molecules/DownloadStatusCard";
import { SongDetails } from "@/app/services/db/types";
import { SongFilters } from "@/app/types/SongFilters";
import { MediaManager } from "@/app/services/media-manager";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { useDownloadStatus } from "@/app/services/downloader/downloadStatus";
import { IconButton, ListRow, Screen, SectionHeader, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

// The queue can be an entire playlist; show its head and a "+N more" line rather than a second full list.
const QUEUE_PREVIEW_LIMIT = 8;

// Library › Downloads: the one place to see and manage background downloads. Top to bottom: status card
// (phase, current song, progress, pause/resume, Wi-Fi note), the head of the queue, then everything saved.
export default function LocalDownloadsScreen() {
    const theme = useTheme();
    const db = useDb();
    const downloader = useDownloader();
    const status = useDownloadStatus((s) => s.status);
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [queued, setQueued] = useState<SongDetails[]>([]);
    const [search, setSearch] = useState("");

    const loadDownloaded = useCallback(async () => {
        setSongs(await DbQueries.getDownloadedSongDetails(db));
    }, [db]);

    const loadQueue = useCallback(async () => {
        setQueued(await DbQueries.getDownloadQueueDetails(db, QUEUE_PREVIEW_LIMIT));
    }, [db]);

    // Both lists on focus (a download may have landed while we were elsewhere)...
    useFocusEffect(
        useCallback(() => {
            loadDownloaded();
            loadQueue();
        }, [loadDownloaded, loadQueue]),
    );
    // ...the saved list again whenever a song finishes, and the queue whenever its size or head changes.
    useEffect(() => {
        loadDownloaded();
    }, [status.completedCount, loadDownloaded]);
    useEffect(() => {
        loadQueue();
    }, [status.queuedCount, status.current?.songId, loadQueue]);

    const filteredSongs = useMemo(() => {
        if (search === "") {
            return songs;
        }
        const q = search.toLowerCase();
        return songs.filter(
            (x) => x.song.name.toLowerCase().includes(q) || x.artists.map((y) => y.name).join(", ").toLowerCase().includes(q),
        );
    }, [songs, search]);

    const handleSelectSong = async (songDetails: SongDetails) => {
        // Stay within the downloaded songs after the tapped one ends — the point of this screen is offline
        // listening, so wandering into songs that aren't on disk would defeat it.
        const scope = new SongFilters();
        scope.localOnly = true;
        await MediaManager.playSpecificSong(songDetails.song.songId, scope);
    };

    const confirmClearQueue = () => {
        Alert.alert("Clear queue", `Remove all ${status.queuedCount} queued songs? Nothing already saved is affected.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: () => downloader?.clearQueue() },
        ]);
    };

    const hiddenQueued = Math.max(0, status.queuedCount - queued.length);
    const inFlightId = status.phase === "downloading" ? status.current?.songId : undefined;

    const header = (
        <View>
            <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}>
                Downloads
            </Text>
            <DownloadStatusCard />

            {status.queuedCount > 0 ? (
                <>
                    <SectionHeader title={`Queued · ${status.queuedCount}`} actionLabel="Clear" onAction={confirmClearQueue} />
                    {queued.map((item) => {
                        const inFlight = item.song.songId === inFlightId;
                        return (
                            <ListRow
                                key={item.song.songId}
                                title={item.song.name}
                                subtitle={
                                    (inFlight ? "Downloading · " : "") +
                                    (item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist")
                                }
                                style={{ paddingVertical: theme.space.sm }}
                                left={
                                    <View style={{ width: 10, alignItems: "center" }}>
                                        {inFlight ? (
                                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent }} />
                                        ) : null}
                                    </View>
                                }
                                right={
                                    <IconButton
                                        name="close-outline"
                                        size={22}
                                        color={theme.color.textFaint}
                                        onPress={() => downloader?.removeFromQueue(item.song.songId)}
                                        accessibilityLabel="Remove from queue"
                                    />
                                }
                                onPress={() => router.push({ pathname: "/song/[id]", params: { id: item.song.songId } })}
                            />
                        );
                    })}
                    {hiddenQueued > 0 ? (
                        <Text variant="caption" color="textFaint" style={{ marginTop: theme.space.xs }}>
                            + {hiddenQueued} more
                        </Text>
                    ) : null}
                </>
            ) : null}

            <SectionHeader title={`Saved · ${songs.length}`} />
            <TextField
                placeholder="Search downloads"
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ marginBottom: theme.space.md }}
            />
        </View>
    );

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <SongList
                    songs={filteredSongs}
                    onSelectSong={handleSelectSong}
                    onShowInfo={(s) => router.push({ pathname: "/song/[id]", params: { id: s.song.songId } })}
                    ListHeaderComponent={header}
                    ListEmptyComponent={
                        <Text variant="body" color="textFaint">
                            {search !== "" ? "No saved songs match." : "Nothing saved offline yet — use the download button on a song or playlist."}
                        </Text>
                    }
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
