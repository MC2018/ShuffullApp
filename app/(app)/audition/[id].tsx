import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Animated, AppState, ImageURISource, LayoutChangeEvent, PanResponder, Pressable, Vibration, View,
} from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { Playlist, Song } from "@/app/services/db/models";
import { SongDetails } from "@/app/services/db/types";
import { Downloader } from "@/app/services/downloader/Downloader";
import { useIsPlaybackActive, useSongStateRevision } from "@/app/services/media-manager/mediaManager";
import { startAuditionMode, stopAuditionMode, useAuditionMode } from "@/app/services/audition/auditionMode";
import { confirmDeletePlaylist } from "@/app/services/playlists/deletePlaylist";
import Skimmer from "@/app/components/music-control/atoms/Skimmer";
import { AlbumArt, Button, Card, IconButton, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { LikeStatus } from "@/app/enums";
import { AuditionProgress, isAuditionComplete } from "@/app/tools/audition";
import { AuditionSession, AuditionSummary } from "@/app/tools/auditionSession";

// Audition mode (ShuffullApp#125): flip through a mix's unheard songs. Flick up for the next song, down for the one
// before; in the middle band, swipe right to Like or left to Dislike, and either moves on. A tap plays or pauses.
// The deck's rules (heard after 20 s, laps, what counts as a verdict) are in tools/auditionSession.

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");

// Movement before a drag picks its axis. After that it stays on that axis until the finger lifts.
const AXIS_LOCK_PX = 10;
// How far a sideways drag has to go to count as a verdict, and an up/down drag to change song.
const VERDICT_PX = 110;
const FLIP_PX = 80;
// A fast flick changes song even when it is short.
const FLIP_VELOCITY = 0.6;
const LAP2_NOTICE_MS = 6_000;

type Axis = "none" | "horizontal" | "vertical" | "blocked";

export default function AuditionScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const db = useDb();
    const { id: playlistId } = useLocalSearchParams<{ id: string }>();
    const snapshot = useAuditionMode((s) => s.snapshot);
    const [playlist, setPlaylist] = useState<Playlist | undefined>(undefined);
    const sessionRef = useRef<AuditionSession | undefined>(undefined);

    // The deck lives exactly as long as this screen.
    useEffect(() => {
        if (playlistId == undefined) {
            return;
        }
        let closed = false;
        (async () => {
            setPlaylist(await DbQueries.getPlaylist(db, playlistId));
            const session = await startAuditionMode(db, playlistId);
            if (!closed) {
                sessionRef.current = session;
            }
        })().catch((e) => console.warn("[audition] could not start", e));
        return () => {
            closed = true;
            sessionRef.current = undefined;
            void stopAuditionMode();
        };
    }, [db, playlistId]);

    // Leaving the screen for another (song info) or the app (home, lock) pauses. Nothing advances on its own while
    // nobody is listening.
    useFocusEffect(
        useCallback(() => () => void sessionRef.current?.pause(), []),
    );
    useEffect(() => {
        const sub = AppState.addEventListener("change", (state) => {
            if (state !== "active") {
                void sessionRef.current?.pause();
            }
        });
        return () => sub.remove();
    }, []);

    // The lap-2 pop-up dismisses itself; the deck carries on playing underneath it.
    useEffect(() => {
        if (snapshot?.notice == undefined) {
            return;
        }
        const timer = setTimeout(() => sessionRef.current?.dismissNotice(), LAP2_NOTICE_MS);
        return () => clearTimeout(timer);
    }, [snapshot?.notice]);

    const header = (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, paddingVertical: theme.space.sm }}>
            <IconButton name="chevron-down" accessibilityLabel="Leave audition mode" onPress={() => router.back()} />
            <View style={{ flex: 1 }}>
                <Text variant="section" numberOfLines={1}>{playlist?.name ?? "Audition"}</Text>
                {snapshot && !snapshot.finished && snapshot.total > 0 ? (
                    <Text variant="caption" color="textFaint">
                        {`Song ${snapshot.position} of ${snapshot.total}${snapshot.lap === 2 ? " · Second pass" : ""}`}
                    </Text>
                ) : null}
            </View>
        </View>
    );

    if (snapshot == undefined) {
        return <Screen>{header}</Screen>;
    }

    if (snapshot.finished) {
        return (
            <Screen style={{ paddingBottom: insets.bottom + theme.space.lg }}>
                {header}
                <AuditionSummaryView db={db} playlist={playlist} summary={snapshot.summary} empty={snapshot.total === 0} />
            </Screen>
        );
    }

    return (
        <Screen style={{ paddingBottom: insets.bottom + theme.space.md }}>
            {header}
            {snapshot.songId != undefined ? (
                <Deck
                    key={`${snapshot.songId}:${snapshot.position}`}
                    songId={snapshot.songId}
                    session={sessionRef}
                />
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: theme.space.md }}>
                <DeckButton
                    icon={snapshot.kept ? "bookmark" : "bookmark-outline"}
                    label={snapshot.kept ? "Kept" : "Keep"}
                    active={snapshot.kept}
                    onPress={() => void sessionRef.current?.keep()}
                />
                <DeckButton
                    icon={snapshot.likeStatus === LikeStatus.Love ? "heart" : "heart-outline"}
                    label="Love"
                    active={snapshot.likeStatus === LikeStatus.Love}
                    onPress={() => void sessionRef.current?.love()}
                />
                <DeckButton icon="play-back-outline" label="From the start" onPress={() => void sessionRef.current?.fromStart()} />
            </View>
            <View style={{ marginTop: theme.space.sm }}>
                <Skimmer showTimes />
            </View>
            {snapshot.notice != undefined ? (
                <Pressable
                    onPress={() => sessionRef.current?.dismissNotice()}
                    style={{ position: "absolute", left: theme.space.lg, right: theme.space.lg, top: 72 }}
                >
                    <Card>
                        <Text variant="bodyStrong">First pass done.</Text>
                        <Text variant="body" color="textMuted" style={{ marginTop: 2 }}>
                            {`${snapshot.notice.count} ${snapshot.notice.count === 1 ? "song" : "songs"} you skipped quickly. Replaying ${snapshot.notice.count === 1 ? "it" : "them"} from the start.`}
                        </Text>
                    </Card>
                </Pressable>
            ) : null}
        </Screen>
    );
}

/** The current song's card: art, title, and every gesture. Re-mounted per song, so a drag never carries over. */
function Deck({ songId, session }: { songId: string; session: React.RefObject<AuditionSession | undefined> }) {
    const theme = useTheme();
    const db = useDb();
    const playing = useIsPlaybackActive();
    const [details, setDetails] = useState<SongDetails | undefined>(undefined);
    const [art, setArt] = useState<ImageURISource>(defaultArt);
    const [height, setHeight] = useState(0);
    const [artSize, setArtSize] = useState(240);
    const offset = useRef(new Animated.ValueXY()).current;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const fetched = await DbQueries.fetchSongDetails(db, songId);
            if (cancelled) {
                return;
            }
            setDetails(fetched);
            const resolved = await resolveArt(fetched.song);
            if (!cancelled) {
                setArt(resolved);
            }
        })().catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [db, songId]);

    const container = useRef<View>(null);
    const top = useRef(0);
    const onLayout = (e: LayoutChangeEvent) => {
        const { width, height: h } = e.nativeEvent.layout;
        setHeight(h);
        setArtSize(Math.max(120, Math.min(width - 48, h - 120, 320)));
        // In window coordinates, like a drag's start point.
        container.current?.measureInWindow((_x, y) => {
            top.current = y;
        });
    };

    // Per drag: the axis it locked to, and whether it has already buzzed for crossing the verdict line.
    const drag = useRef({ axis: "none" as Axis, buzzed: false });
    const heightRef = useRef(0);
    heightRef.current = height;

    const responder = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
            drag.current = { axis: "none", buzzed: false };
        },
        onPanResponderMove: (_, g) => {
            const state = drag.current;
            if (state.axis === "none" && Math.max(Math.abs(g.dx), Math.abs(g.dy)) >= AXIS_LOCK_PX) {
                if (Math.abs(g.dx) > Math.abs(g.dy)) {
                    // Verdicts only from the middle half: the edges are where thumbs rest while scrolling.
                    const startY = g.y0 - top.current;
                    const h = heightRef.current;
                    state.axis = h > 0 && startY >= h * 0.25 && startY <= h * 0.75 ? "horizontal" : "blocked";
                } else {
                    state.axis = "vertical";
                }
            }
            if (state.axis === "horizontal") {
                offset.setValue({ x: g.dx, y: 0 });
                const past = Math.abs(g.dx) >= VERDICT_PX;
                if (past && !state.buzzed) {
                    // Once, as the drag crosses the line where letting go commits.
                    Vibration.vibrate(15);
                }
                state.buzzed = past;
            } else if (state.axis === "vertical") {
                offset.setValue({ x: 0, y: g.dy });
            }
        },
        onPanResponderRelease: (_, g) => {
            const { axis } = drag.current;
            const springBack = () => Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
            if (axis === "none") {
                // A tap: play or pause. No double tap, so a tap never waits to find out if another follows.
                springBack();
                void (playing ? session.current?.pause() : session.current?.resume());
                return;
            }
            // The card goes back either way: the next song's card replaces it, and on the first song "previous"
            // replays the same one.
            springBack();
            if (axis === "horizontal" && Math.abs(g.dx) >= VERDICT_PX) {
                void (g.dx > 0 ? session.current?.like() : session.current?.dislike());
            } else if (axis === "vertical") {
                // Like a short-video feed: push the card up for the next song, pull it down for the one before.
                if (g.dy <= -FLIP_PX || g.vy <= -FLIP_VELOCITY) {
                    void session.current?.next();
                } else if (g.dy >= FLIP_PX || g.vy >= FLIP_VELOCITY) {
                    void session.current?.previous();
                }
            }
        },
        onPanResponderTerminate: () => {
            Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
        },
    }), [offset, playing, session]);

    const likeTint = offset.x.interpolate({ inputRange: [0, VERDICT_PX], outputRange: [0, 0.45], extrapolate: "clamp" });
    const dislikeTint = offset.x.interpolate({ inputRange: [-VERDICT_PX, 0], outputRange: [0.45, 0], extrapolate: "clamp" });
    const artists = details && details.artists.length > 0 ? details.artists.map((a) => a.name).join(", ") : "";

    return (
        <View ref={container} style={{ flex: 1 }} onLayout={onLayout} {...responder.panHandlers}>
            <Animated.View
                style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    transform: [{ translateX: offset.x }, { translateY: offset.y }],
                }}
            >
                <View>
                    <AlbumArt source={art} size={artSize} elevated />
                    <Animated.View
                        pointerEvents="none"
                        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: theme.radius.lg, backgroundColor: theme.color.positive, opacity: likeTint }}
                    />
                    <Animated.View
                        pointerEvents="none"
                        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: theme.radius.lg, backgroundColor: theme.color.accentDeep, opacity: dislikeTint }}
                    />
                    {!playing ? (
                        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                            <Ionicons name="play" size={56} color={theme.color.textPrimary} />
                        </View>
                    ) : null}
                </View>
                <Text variant="title" numberOfLines={2} style={{ marginTop: theme.space.lg, textAlign: "center" }}>
                    {details?.song.name ?? ""}
                </Text>
                <Text variant="body" color="textMuted" numberOfLines={1} style={{ marginTop: 2, textAlign: "center" }}>
                    {artists}
                </Text>
            </Animated.View>
        </View>
    );
}

function DeckButton({ icon, label, active, onPress }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    active?: boolean;
    onPress: () => void;
}) {
    const theme = useTheme();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={{ alignItems: "center", minWidth: 80 }}>
            <Ionicons name={icon} size={26} color={active ? theme.color.accent : theme.color.textPrimary} />
            <Text variant="caption" color="textMuted" style={{ marginTop: 4 }}>{label}</Text>
        </Pressable>
    );
}

/**
 * The end of the deck: what happened to each song, then the choice to keep the mix or delete it. Delete goes through
 * the same flow as the playlist screen's, holds included, and is offered only once the mix has nothing unheard left.
 */
function AuditionSummaryView({ db, playlist, summary, empty }: {
    db: ReturnType<typeof useDb>;
    playlist: Playlist | undefined;
    summary: AuditionSummary;
    empty: boolean;
}) {
    const theme = useTheme();
    const revision = useSongStateRevision((s) => s.revision);
    const [progress, setProgress] = useState<AuditionProgress | undefined>(undefined);

    // From the database, not the deck: the delete is safe only if the playlist screen would call the mix done too.
    useEffect(() => {
        if (playlist == undefined) {
            return;
        }
        let cancelled = false;
        (async () => {
            const sessionData = await DbQueries.getActiveLocalSessionData(db);
            if (!sessionData) {
                return;
            }
            const result = await DbQueries.getAuditionProgress(db, sessionData.userId, playlist.playlistId);
            if (!cancelled) {
                setProgress(result);
            }
        })().catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [db, playlist, revision]);

    const rows: [string, number][] = [
        ["Kept", summary.kept],
        ["Liked", summary.liked],
        ["Loved", summary.loved],
        ["Disliked", summary.disliked],
        ["Passed", summary.passed],
    ];
    if (summary.unheard > 0) {
        rows.push(["Not heard yet", summary.unheard]);
    }
    const complete = progress != undefined && isAuditionComplete(progress);

    return (
        <View style={{ flex: 1, justifyContent: "center", gap: theme.space.lg }}>
            <Text variant="screenTitle" style={{ textAlign: "center" }}>
                {empty ? "Nothing left to audition" : "Audition done"}
            </Text>
            {!empty ? (
                <Card>
                    {rows.map(([label, count]) => (
                        <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
                            <Text variant="body">{label}</Text>
                            <Text variant="bodyStrong">{count}</Text>
                        </View>
                    ))}
                </Card>
            ) : null}
            {progress != undefined && !complete ? (
                <Text variant="caption" color="textFaint" style={{ textAlign: "center" }}>
                    {`${progress.total - progress.evaluated} of this mix's songs are still unheard.`}
                </Text>
            ) : null}
            <Button label="Keep the mix" icon="checkmark" onPress={() => router.back()} full />
            {playlist != undefined && complete ? (
                <Button
                    label="Delete the mix"
                    icon="trash-outline"
                    variant="ghost"
                    onPress={() => confirmDeletePlaylist(db, playlist, () => router.back())}
                    full
                />
            ) : null}
        </View>
    );
}

async function resolveArt(song: Song): Promise<ImageURISource> {
    const localUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localUri)) {
        return { uri: localUri };
    }
    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}
