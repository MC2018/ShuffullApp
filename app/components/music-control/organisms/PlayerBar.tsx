import { ImageURISource, Pressable, View } from "react-native";
import React, { useEffect, useState } from "react";
import { router } from "expo-router";
import { State, usePlaybackState } from "react-native-track-player";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";
import { SongDetails } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";
import { AlbumArt, IconButton, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");

type ArtSource = ImageURISource | { uri: string };

async function getAlbumArtUri(song?: Song): Promise<ArtSource> {
    if (song == undefined) {
        return defaultArt;
    }
    const albumArtUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(albumArtUri)) {
        return { uri: albumArtUri };
    }
    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}

const playerBarHeight = 56;
const margin = 8;
export const totalPlayerBarHeight = playerBarHeight + margin * 2;

// Persistent mini-player pinned above the tab bar. Tapping the song opens the full Now Playing screen.
export default function PlayerBar() {
    const theme = useTheme();
    const db = useDb();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const { songId } = useActiveSong();
    const [songInfo, setSongInfo] = useState<SongDetails | null>(null);
    const [albumArt, setAlbumArt] = useState<ArtSource>(defaultArt);

    useEffect(() => {
        (async () => {
            if (songId == undefined) {
                setSongInfo(null);
                return;
            }
            try {
                const fetched = await DbQueries.fetchSongDetails(db, songId);
                if (songId != fetched.song.songId) {
                    setSongInfo(null);
                    return;
                }
                setSongInfo(fetched);
                setAlbumArt(await getAlbumArtUri(fetched.song));
            } catch {
                // Song may have changed out from under us; ignore.
            }
        })();
    }, [songId]);

    const controlMedia = async () => {
        if (playbackState.state === State.Playing) {
            await MediaManager.pause();
        } else {
            await MediaManager.play();
        }
    };

    if (songInfo == null) {
        return null;
    }

    return (
        <View
            style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: margin,
                height: playerBarHeight,
                borderRadius: theme.radius.lg,
                backgroundColor: theme.color.surfaceAlt,
                borderWidth: 1,
                borderColor: theme.color.line,
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: theme.space.sm,
                gap: theme.space.sm,
            }}
        >
            <Pressable style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, flex: 1, minWidth: 0 }} onPress={() => router.push("/now-playing")}>
                <AlbumArt source={albumArt} size={40} radius={theme.radius.sm} />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="label" numberOfLines={1}>
                        {songInfo.song.name}
                    </Text>
                    <Text variant="caption" color="textMuted" numberOfLines={1}>
                        {songInfo.artists.map((x) => x.name).join(", ")}
                    </Text>
                </View>
            </Pressable>
            <IconButton name={isPlaying ? "pause" : "play"} size={22} color={theme.color.textPrimary} onPress={controlMedia} accessibilityLabel={isPlaying ? "Pause" : "Play"} />
        </View>
    );
}
