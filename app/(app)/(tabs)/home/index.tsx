import { useCallback, useEffect, useState } from "react";
import { ImageURISource, Pressable, ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { State, usePlaybackState } from "react-native-track-player";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { SongDetails } from "@/app/services/db/types";
import { GenreJam, Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { MediaManager } from "@/app/services/media-manager";
import { logout } from "@/app/services/auth/auth";
import { jamSummary, launchJam } from "@/app/services/genre-jam";
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
    const [jams, setJams] = useState<GenreJam[]>([]);

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

    // Reload saved jams whenever Home regains focus (e.g. after saving one in the builder).
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            (async () => {
                const all = await DbQueries.getGenreJams(db);
                if (!cancelled) {
                    setJams(all);
                }
            })();
            return () => {
                cancelled = true;
            };
        }, [db]),
    );

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
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: totalPlayerBarHeight + theme.space.xl }}>
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
                <Pressable onPress={() => router.push("/genre-jam")}>
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

                {jams.length > 0 ? (
                    <>
                        <SectionHeader title="Your Jams" />
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.md, paddingRight: theme.space.md }}>
                            {jams.map((jam) => (
                                <Pressable key={jam.genreJamId} onPress={() => launchJam(jam)}>
                                    <Card style={{ width: 150 }}>
                                        <View style={{ height: 54, borderRadius: theme.radius.md, backgroundColor: theme.color.accentWash, alignItems: "center", justifyContent: "center", marginBottom: theme.space.sm }}>
                                            <Ionicons name="play" size={20} color={theme.color.accent} />
                                        </View>
                                        <Text variant="bodyStrong" numberOfLines={1}>
                                            {jam.name}
                                        </Text>
                                        <Text variant="caption" color="textFaint" numberOfLines={1}>
                                            {jamSummary(jam)}
                                        </Text>
                                    </Card>
                                </Pressable>
                            ))}
                        </ScrollView>
                    </>
                ) : null}
            </ScrollView>
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
