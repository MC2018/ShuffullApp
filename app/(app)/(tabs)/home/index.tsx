import { useEffect, useState } from "react";
import { ImageURISource, Pressable, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { State, usePlaybackState } from "react-native-track-player";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { SongDetails } from "@/app/services/db/types";
import { Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { MediaManager } from "@/app/services/media-manager";
import { logout } from "@/app/services/auth/auth";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { AlbumArt, Card, IconButton, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");
type ArtSource = ImageURISource | { uri: string };

export default function HomeScreen() {
    const theme = useTheme();
    const db = useDb();
    const { songId } = useActiveSong();
    const playback = usePlaybackState();
    const isPlaying = playback.state === State.Playing;
    const [details, setDetails] = useState<SongDetails | null>(null);
    const [art, setArt] = useState<ArtSource>(defaultArt);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!songId) {
                setDetails(null);
                return;
            }
            try {
                const fetched = await DbQueries.fetchSongDetails(db, songId);
                if (cancelled || fetched.song.songId !== songId) {
                    return;
                }
                setDetails(fetched);
                setArt(await resolveArt(fetched.song));
            } catch {
                // ignore
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [songId]);

    const togglePlay = async () => {
        if (await MediaManager.isPlaying()) {
            await MediaManager.pause();
        } else {
            await MediaManager.play();
        }
    };

    const artistText = details && details.artists.length > 0 ? details.artists.map((a) => a.name).join(", ") : "Unknown Artist";

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.md, marginBottom: theme.space.sm }}>
                    <Text variant="screenTitle">Home</Text>
                    <IconButton name="log-out-outline" size={22} color={theme.color.textMuted} onPress={logout} accessibilityLabel="Log out" />
                </View>

                {details ? (
                    <Card style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md }}>
                        <Pressable style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md, flex: 1, minWidth: 0 }} onPress={() => router.push("/now-playing")}>
                            <AlbumArt source={art} size={56} radius={theme.radius.md} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text variant="micro" color="accentTint">
                                    Now playing
                                </Text>
                                <Text variant="bodyStrong" numberOfLines={1} style={{ marginTop: 2 }}>
                                    {details.song.name}
                                </Text>
                                <Text variant="caption" color="textMuted" numberOfLines={1}>
                                    {artistText}
                                </Text>
                            </View>
                        </Pressable>
                        <IconButton name={isPlaying ? "pause" : "play"} size={20} filled round={44} onPress={togglePlay} accessibilityLabel={isPlaying ? "Pause" : "Play"} />
                    </Card>
                ) : (
                    <Card>
                        <Text variant="body" color="textFaint">
                            Nothing playing yet — start a jam below.
                        </Text>
                    </Card>
                )}

                <SectionHeader title="Start something" />
                <Pressable onPress={() => router.push("/home/genre-jam")}>
                    <Card tint style={{ borderColor: theme.color.accentDeep }}>
                        <Text variant="micro" color="accentTint">
                            Genre Jam
                        </Text>
                        <Text variant="title" style={{ marginTop: theme.space.sm }}>
                            Start a Jam
                        </Text>
                        <Text variant="body" color="textMuted" style={{ marginTop: theme.space.xs }}>
                            Your whole library, minus dislikes, leaning into what you love. No playlist required.
                        </Text>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: theme.space.md }}>
                            <Ionicons name="play" size={14} color={theme.color.accent} />
                            <Text variant="label" color="accent">
                                Open the jam builder
                            </Text>
                        </View>
                    </Card>
                </Pressable>
            </View>
            <PlayerBar />
        </Screen>
    );
}

async function resolveArt(song: Song): Promise<ArtSource> {
    const localUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localUri)) {
        return { uri: localUri };
    }
    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}
