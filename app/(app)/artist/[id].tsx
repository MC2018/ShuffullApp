import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";
import { SongDetails } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";
import { Button, IconButton, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function ArtistScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { id: artistId } = useLocalSearchParams<{ id: string }>();
    const [artist, setArtist] = useState<Artist | null>(null);
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [query, setQuery] = useState("");
    const db = useDb();

    useEffect(() => {
        if (artistId == undefined) {
            return;
        }
        (async () => {
            setArtist((await DbQueries.getArtist(db, artistId)) ?? null);
            setSongs(await DbQueries.getSongDetailsByArtist(db, artistId));
        })();
    }, [artistId]);

    const q = query.trim().toLowerCase();
    const filteredSongs = q === "" ? songs : songs.filter((x) => x.song.name.toLowerCase().includes(q));

    const handleSelectSong = async (songDetails: SongDetails) => {
        // Keep playing within this artist once the tapped song ends.
        const scope = new SongFilters();
        if (artistId != undefined) {
            scope.setSoleFilter(SongFilterType.Artist, [artistId]);
        }
        await MediaManager.playSpecificSong(songDetails.song.songId, scope);
    };

    const playArtist = async () => {
        if (artistId == undefined) {
            return;
        }
        const songFilters = await MediaManager.getSongFilters();
        songFilters.setSoleFilter(SongFilterType.Artist, [artistId]);
        await MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight + insets.bottom }}>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: theme.space.md }}>
                    <IconButton name="chevron-back" size={24} color={theme.color.textMuted} onPress={() => router.back()} accessibilityLabel="Back" />
                </View>
                <Text variant="screenTitle" numberOfLines={1} style={{ marginTop: theme.space.xs }}>
                    {artist?.name ?? "Artist"}
                </Text>
                <Text variant="caption" color="textFaint" style={{ marginTop: 2, marginBottom: theme.space.md }}>
                    {songs.length} song{songs.length === 1 ? "" : "s"}
                </Text>
                <Button label="Play" icon="play" onPress={playArtist} style={{ marginBottom: theme.space.md }} />
                <TextField
                    placeholder="Search in artist"
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ marginBottom: theme.space.md }}
                />
                <SongList
                    songs={filteredSongs}
                    onSelectSong={handleSelectSong}
                    onShowInfo={(s) => router.push({ pathname: "/song/[id]", params: { id: s.song.songId } })}
                />
            </View>
            <PlayerBar floating />
        </Screen>
    );
}
