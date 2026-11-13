import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/app/services/api/ApiProvider";
import type { DeletedSong } from "@/app/services/api/models";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { Button, ListRow, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import {
    describeDeletedSong,
    describeDeletedSongsFailure,
    filterDeletedSongs,
    loadAllDeletedSongs,
    youtubeWatchUrl,
} from "@/app/tools/deletedSongs";
import { openExternalUrl } from "@/app/tools/externalLink";
import { log } from "@/app/tools/log";

type LoadState = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; songs: DeletedSong[] };

// Library › Deleted songs (ShuffullApp#59): what the server deleted for you, so a song you regret losing can be found
// again. Today that is the songs nobody kept when you deleted an audition mix. A list to look at: tapping a song opens
// its YouTube page, where you can find it and request it again. Read from the server on open, never stored on the
// device, so it needs a connection.
export default function DeletedSongsScreen() {
    const theme = useTheme();
    const api = useApi();
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const [text, setText] = useState("");
    // Only the newest load may set the list; one answering after the screen closed or after a retry is dropped.
    const loadSeq = useRef(0);

    const load = useCallback(async () => {
        const seq = ++loadSeq.current;
        setState({ status: "loading" });
        try {
            const songs = await loadAllDeletedSongs((before) => api.songGetDeleted(before));
            if (seq === loadSeq.current) {
                setState({ status: "loaded", songs });
            }
        } catch (error) {
            log.warn("library", "Loading deleted songs failed.", error);
            if (seq === loadSeq.current) {
                setState({ status: "failed", message: describeDeletedSongsFailure(error) });
            }
        }
    }, [api]);

    useEffect(() => {
        void load();
        // Leaving the screen retires the load in flight, so it can't set state after unmount.
        const seq = loadSeq;
        return () => {
            seq.current++;
        };
    }, [load]);

    const songs = useMemo(() => (state.status === "loaded" ? state.songs : []), [state]);
    const shown = useMemo(() => filterDeletedSongs(songs, text), [songs, text]);
    const now = new Date();
    const openIcon = <Ionicons name="open-outline" size={18} color={theme.color.textFaint} />;

    let body: ReactNode;
    if (state.status === "loading") {
        body = <ActivityIndicator color={theme.color.accent} style={{ marginTop: theme.space.lg }} />;
    } else if (state.status === "failed") {
        body = (
            <View style={{ gap: theme.space.md, alignItems: "flex-start" }}>
                <Text variant="body" color="textFaint">
                    {state.message}
                </Text>
                <Button label="Try again" variant="ghost" onPress={() => void load()} />
            </View>
        );
    } else {
        body = (
            <FlatList
                data={shown}
                keyExtractor={(item) => item.songId}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    <Text variant="body" color="textFaint">
                        {songs.length === 0 ? "Nothing deleted yet." : "No deleted song matches that."}
                    </Text>
                }
                renderItem={({ item }) => {
                    const url = youtubeWatchUrl(item.externalSongId);
                    return (
                        <ListRow
                            title={item.name}
                            subtitle={describeDeletedSong(item, now)}
                            right={url != null ? openIcon : undefined}
                            onPress={url != null ? () => void openExternalUrl(url) : undefined}
                        />
                    );
                }}
            />
        );
    }

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.xs }}>
                    Deleted songs
                </Text>
                <Text variant="caption" color="textMuted" style={{ marginBottom: theme.space.sm }}>
                    Songs removed when you deleted an audition mix without keeping them. Tap one to open it on YouTube.
                    {state.status === "loaded" && songs.length > 0 ? ` ${songs.length} in all.` : ""}
                </Text>
                {state.status === "loaded" && songs.length > 0 && (
                    <TextField
                        value={text}
                        onChangeText={setText}
                        placeholder="Song, artist or mix"
                        autoCorrect={false}
                        returnKeyType="search"
                        accessibilityLabel="Search deleted songs"
                        style={{ marginBottom: theme.space.sm }}
                    />
                )}
                {body}
            </View>
            <PlayerBar />
        </Screen>
    );
}
