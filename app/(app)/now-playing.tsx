import { useEffect, useState } from "react";
import { Image, ImageURISource, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { SongDetails } from "@/app/services/db/types";
import { Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";
import PlayPauseButton from "@/app/components/music-control/atoms/PlayPauseButton";
import Skimmer from "@/app/components/music-control/atoms/Skimmer";
import LyricsView from "@/app/components/lyrics/organisms/LyricsView";
import LikeControl from "@/app/components/likes/atoms/LikeControl";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");

type ArtSource = ImageURISource | { uri: string };

// Full-screen "now playing": album art + transport on top, lyrics filling the rest. Reached by tapping
// the PlayerBar. Tracks the active song so it follows skips/auto-advance.
export default function NowPlayingScreen() {
    const db = useDb();
    const { songId } = useActiveSong();
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
                // Song may have just changed out from under us; ignore.
            }
        })();
        return () => { cancelled = true; };
    }, [songId]);

    return (
        <View style={styles.container}>
            <Pressable style={styles.closeBtn} onPress={() => router.back()} hitSlop={10}>
                <Text style={styles.closeText}>✕</Text>
            </Pressable>

            {details == null ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>Nothing playing</Text>
                </View>
            ) : (
                <>
                    <Image source={art} defaultSource={defaultArt} style={styles.art} />
                    <Text numberOfLines={1} style={styles.title}>{details.song.name}</Text>
                    <Text numberOfLines={1} style={styles.artist}>
                        {details.artists.length > 0 ? details.artists.map(a => a.name).join(", ") : "Unknown Artist"}
                    </Text>
                    <Skimmer />
                    <View style={styles.controls}>
                        <PlayPauseButton />
                    </View>
                    <LikeControl songId={details.song.songId} />
                    <View style={styles.lyrics}>
                        <LyricsView song={details.song} />
                    </View>
                </>
            )}
        </View>
    );
}

async function resolveArt(song: Song): Promise<ArtSource> {
    const localUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localUri)) {
        return { uri: localUri };
    }
    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#fff",
        paddingHorizontal: 16,
    },
    closeBtn: {
        alignSelf: "flex-end",
        padding: 8,
    },
    closeText: {
        fontSize: 20,
        color: "#444",
    },
    empty: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    emptyText: {
        fontSize: 16,
        color: "#888",
    },
    art: {
        alignSelf: "center",
        width: 200,
        height: 200,
        borderRadius: 12,
        backgroundColor: "#eee",
        marginTop: 4,
    },
    title: {
        fontSize: 20,
        fontWeight: "700",
        textAlign: "center",
        marginTop: 16,
    },
    artist: {
        fontSize: 15,
        color: "#666",
        textAlign: "center",
        marginTop: 4,
    },
    controls: {
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "center",
    },
    lyrics: {
        flex: 1,
        marginTop: 8,
    },
});
