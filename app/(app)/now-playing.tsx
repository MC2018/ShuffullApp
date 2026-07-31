import { useEffect, useRef, useState } from "react";
import { Animated, Easing, ImageURISource, LayoutChangeEvent, Pressable, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { SongDetails } from "@/app/services/db/types";
import { Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";
import Skimmer from "@/app/components/music-control/atoms/Skimmer";
import Transport from "@/app/components/music-control/molecules/Transport";
import LyricsView from "@/app/components/lyrics/organisms/LyricsView";
import { hasDisplayableLyrics } from "@/app/tools/lrc";
import RatingControl from "@/app/components/likes/atoms/RatingControl";
import { MediaManager } from "@/app/services/media-manager";
import SongDownloadControl from "@/app/components/downloading/atoms/SongDownloadControl";
import { AlbumArt, IconButton, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");

type ArtSource = ImageURISource | { uri: string };

const COMPACT_ART = 56; // thumbnail size when lyrics are open
const OPEN_MS = 250;
const CLOSE_MS = 190;
// Snappy decelerate on open (fast out, soft settle); quick accelerate on close.
const OPEN_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const CLOSE_EASING = Easing.bezier(0.4, 0, 1, 1);

// Full-screen "now playing". Lyrics are hidden by default (YT-Music style): the art sits large and the
// transport/likes are below. Tapping "Lyrics" animates the art shrinking into the top-left, the title
// sliding up beside it, and the lyrics fading in — the bottom controls stay pinned. The toggle persists
// across songs.
export default function NowPlayingScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const db = useDb();
    const { width } = useWindowDimensions();
    const artSize = Math.min(width - 96, 300);
    const { songId } = useActiveSong();
    const [details, setDetails] = useState<SongDetails | null>(null);
    const [art, setArt] = useState<ArtSource>(defaultArt);

    const [showLyrics, setShowLyrics] = useState(false);
    const [lyricsMounted, setLyricsMounted] = useState(false);
    const [box, setBox] = useState({ w: 0, h: 0 });
    const progress = useRef(new Animated.Value(0)).current;

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
        return () => {
            cancelled = true;
        };
    }, [songId]);

    const toggleLyrics = () => {
        if (!showLyrics) {
            setShowLyrics(true);
            setLyricsMounted(true);
            Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: OPEN_EASING, useNativeDriver: true }).start();
        } else {
            setShowLyrics(false);
            Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: CLOSE_EASING, useNativeDriver: true }).start(({ finished }) => {
                if (finished) {
                    setLyricsMounted(false);
                }
            });
        }
    };

    const onUpperLayout = (e: LayoutChangeEvent) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };

    const song = details?.song;
    const artistText = details && details.artists.length > 0 ? details.artists.map((a) => a.name).join(", ") : "Unknown Artist";
    const hasLyrics = hasDisplayableLyrics(song);
    const showToggle = hasLyrics || showLyrics;

    // Geometry: art animates from big+centered (progress 0) to COMPACT_ART top-left (progress 1).
    const tx0 = (box.w - artSize) / 2;
    const ty0 = Math.max(8, (box.h - artSize) / 2 - 24);
    const s1 = COMPACT_ART / (artSize || 1);
    const tx1 = (COMPACT_ART - artSize) / 2;
    const ty1 = 8 + (COMPACT_ART - artSize) / 2;
    const bigMetaTop = ty0 + artSize + theme.space.lg;

    const artTransform = {
        transform: [
            { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [tx0, tx1] }) },
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [ty0, ty1] }) },
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, s1] }) },
        ],
    };
    // Crisp sequencing: big title clears early, then the compact title and lyrics arrive as the art settles.
    const bigMetaOpacity = progress.interpolate({ inputRange: [0, 0.25], outputRange: [1, 0], extrapolate: "clamp" });
    const compactMetaOpacity = progress.interpolate({ inputRange: [0.45, 0.8], outputRange: [0, 1], extrapolate: "clamp" });
    // Lyrics get a visible fade-in window plus a small upward drift so they ease in rather than blink on.
    const lyricsOpacity = progress.interpolate({ inputRange: [0.45, 0.92], outputRange: [0, 1], extrapolate: "clamp" });
    const lyricsTranslateY = progress.interpolate({ inputRange: [0.45, 1], outputRange: [14, 0], extrapolate: "clamp" });

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.space.sm }}>
                <IconButton name="chevron-down" size={26} color={theme.color.textMuted} onPress={() => router.back()} accessibilityLabel="Close" />
                <Text variant="micro" color="textMuted">
                    Now Playing
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm }}>
                    {details ? <SongDownloadControl song={details.song} /> : null}
                    <IconButton
                        name="information-circle-outline"
                        size={22}
                        color={theme.color.textMuted}
                        onPress={() => details && router.push({ pathname: "/song/[id]", params: { id: details.song.songId } })}
                        accessibilityLabel="Song info"
                    />
                </View>
            </View>

            {details == null ? (
                <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                    <Text variant="body" color="textFaint">
                        Nothing playing
                    </Text>
                </View>
            ) : (
                <>
                    {/* Upper area: animated art + meta + lyrics, all absolutely positioned so the art can morph. */}
                    <View style={{ flex: 1, marginTop: theme.space.sm }} onLayout={onUpperLayout}>
                        {box.w > 0 && box.h > 0 ? (
                            <>
                                {lyricsMounted ? (
                                    <Animated.View
                                        pointerEvents={showLyrics ? "auto" : "none"}
                                        style={{
                                            position: "absolute",
                                            left: 0,
                                            right: 0,
                                            top: COMPACT_ART + 24,
                                            bottom: 0,
                                            opacity: lyricsOpacity,
                                            transform: [{ translateY: lyricsTranslateY }],
                                        }}
                                    >
                                        <LyricsView song={details.song} />
                                    </Animated.View>
                                ) : null}

                                <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: bigMetaTop, alignItems: "center", opacity: bigMetaOpacity }}>
                                    <Text variant="title" numberOfLines={1} style={{ textAlign: "center" }}>
                                        {details.song.name}
                                    </Text>
                                    <Text variant="body" color="textMuted" numberOfLines={1} style={{ textAlign: "center", marginTop: theme.space.xs }}>
                                        {artistText}
                                    </Text>
                                </Animated.View>

                                <Animated.View
                                    pointerEvents="none"
                                    style={{ position: "absolute", left: COMPACT_ART + theme.space.md, right: 0, top: 8, height: COMPACT_ART, justifyContent: "center", opacity: compactMetaOpacity }}
                                >
                                    <Text variant="bodyStrong" numberOfLines={1}>
                                        {details.song.name}
                                    </Text>
                                    <Text variant="caption" color="textMuted" numberOfLines={1}>
                                        {artistText}
                                    </Text>
                                </Animated.View>

                                <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, width: artSize, height: artSize }, artTransform]}>
                                    <AlbumArt source={art} size={artSize} elevated />
                                </Animated.View>
                            </>
                        ) : (
                            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                                <AlbumArt source={art} size={artSize} elevated />
                            </View>
                        )}
                    </View>

                    {/* Bottom controls: always pinned. paddingBottom clears the nav bar (edge-to-edge, SDK 54). */}
                    <View style={{ marginTop: theme.space.md, paddingBottom: insets.bottom }}>
                        <Skimmer showTimes />
                        <View style={{ marginTop: theme.space.md }}>
                            <Transport />
                        </View>
                        {/* Keep sits beside the rating control, and ONLY for audition songs (it is a no-op for
                            anything else). Until now it existed solely as a bookmark glyph on audition
                            playlist ROWS, which is unreachable while a song is playing full-screen - the exact
                            moment you decide whether to keep it, and the only view you get on a phone. */}
                        <View style={{ marginTop: theme.space.lg, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
                            <RatingControl songId={details.song.songId} gap={theme.space.xl} />
                            {details.song.exploratory ? (
                                <IconButton
                                    name="bookmark-outline"
                                    size={26}
                                    color={theme.color.textMuted}
                                    onPress={() => MediaManager.keepSong(details.song.songId)}
                                    accessibilityLabel="Keep song"
                                    style={{ marginLeft: theme.space.xl }}
                                />
                            ) : null}
                        </View>
                        {/* The lyrics pill ALWAYS occupies its slot, and is merely made invisible when a song
                            has none. Unmounting it shortens this pinned stack, which grows the flex:1 area
                            above — and because the art is centred off that area's measured height, the
                            artwork and title visibly jump every time playback moves between a song with
                            lyrics and one without. Reserving the space keeps the whole screen still. */}
                        <View
                            style={{ alignItems: "center", marginTop: theme.space.lg, marginBottom: theme.space.sm }}
                            pointerEvents={showToggle ? "auto" : "none"}
                            // Keep the hidden placeholder out of the accessibility tree — it is layout, not a control.
                            accessibilityElementsHidden={!showToggle}
                            importantForAccessibility={showToggle ? "auto" : "no-hide-descendants"}
                        >
                            <Pressable
                                onPress={toggleLyrics}
                                disabled={!showToggle}
                                accessibilityRole="button"
                                accessibilityLabel={showLyrics ? "Hide lyrics" : "Show lyrics"}
                                style={({ pressed }) => ({
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: 6,
                                    paddingVertical: theme.space.sm,
                                    paddingHorizontal: theme.space.lg,
                                    borderRadius: theme.radius.pill,
                                    backgroundColor: theme.color.surface,
                                    borderWidth: 1,
                                    borderColor: theme.color.line,
                                    opacity: !showToggle ? 0 : pressed ? 0.8 : 1,
                                })}
                            >
                                <Ionicons name={showLyrics ? "chevron-down" : "chevron-up"} size={14} color={theme.color.textMuted} />
                                <Text variant="label" color="textMuted">
                                    {showLyrics ? "Hide lyrics" : "Lyrics"}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                </>
            )}
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
