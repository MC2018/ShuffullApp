import React, { useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useProgress } from "react-native-track-player";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Song } from "@/app/services/db/models";
import { MediaManager } from "@/app/services/media-manager";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { activeLineIndex, LrcLine, parseLrc } from "@/app/tools/lrc";
import { useTheme } from "@/app/theme";

const NUDGE_STEP_MS = 250;
// Poll playback often enough that line changes feel tight without thrashing render.
const PROGRESS_INTERVAL_MS = 250;

interface LyricsViewProps {
    song: Song;
}

// Picks the right presentation for a song's lyrics. Order: explicit instrumental flag, then synced
// (LRC, highlighted + auto-scrolled), then plain text, then nothing. No hooks here so the branch can
// vary per song; each leaf component owns its own hooks.
export default function LyricsView({ song }: LyricsViewProps) {
    if (song.lyricsInstrumental) {
        return <Centered text="♪ Instrumental ♪" />;
    }
    if (song.syncedLyrics) {
        return <SyncedLyrics song={song} lrc={song.syncedLyrics} />;
    }
    if (song.plainLyrics) {
        return <PlainLyrics text={song.plainLyrics} />;
    }
    return <Centered text="No lyrics available" />;
}

function SyncedLyrics({ song, lrc }: { song: Song; lrc: string }) {
    const theme = useTheme();
    const lines = useMemo(() => parseLrc(lrc), [lrc]);
    const { position } = useProgress(PROGRESS_INTERVAL_MS);
    const [manualOffsetMs, setManualOffsetMs] = useState(0);

    const scrollRef = useRef<ScrollView>(null);
    const lineLayouts = useRef<Record<number, { y: number; h: number }>>({});
    const containerHeight = useRef(0);
    // The first positioning (opening the lyrics, or a new song) snaps instantly to the current line;
    // only later line changes animate. Without this, opening mid-song scrolls quickly from the top.
    const didInitialJump = useRef(false);

    const offsetKey = STORAGE_KEYS.LYRICS_OFFSET_PREFIX + song.songId;

    // Load the per-song manual nudge whenever the song changes.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const stored = await AsyncStorage.getItem(offsetKey);
            if (!cancelled) {
                setManualOffsetMs(stored ? parseInt(stored, 10) || 0 : 0);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [offsetKey]);

    // New song -> snap to position again rather than animating from wherever the last song ended.
    useEffect(() => {
        didInitialJump.current = false;
    }, [lrc]);

    // syncedLyrics is already trim-shifted by the producer (for YT-Music lyrics); the manual nudge is the
    // only adjustment applied here (positive = lyrics advance / appear earlier).
    const positionMs = position * 1000 + manualOffsetMs;
    const active = activeLineIndex(lines, positionMs);

    const scrollToActive = (animated: boolean) => {
        if (active < 0) {
            return;
        }
        const layout = lineLayouts.current[active];
        if (!layout || !containerHeight.current) {
            return;
        }
        const y = Math.max(0, layout.y - containerHeight.current / 2 + layout.h / 2);
        scrollRef.current?.scrollTo({ y, animated });
    };

    // Keep the active line centered. Instant on the first successful scroll, animated afterwards.
    useEffect(() => {
        scrollToActive(didInitialJump.current);
        if (!didInitialJump.current && lineLayouts.current[active] && containerHeight.current) {
            didInitialJump.current = true;
        }
    }, [active]);

    const nudge = async (deltaMs: number) => {
        const next = manualOffsetMs + deltaMs;
        setManualOffsetMs(next);
        await AsyncStorage.setItem(offsetKey, String(next));
    };

    const onLineLayout = (i: number) => (e: LayoutChangeEvent) => {
        const { y, height } = e.nativeEvent.layout;
        lineLayouts.current[i] = { y, h: height };
        // If layouts settle after the active line is already known, do the initial jump here.
        if (!didInitialJump.current && i === active && containerHeight.current) {
            scrollToActive(false);
            didInitialJump.current = true;
        }
    };

    // Tapping a line seeks playback to where that line becomes active (undoing the manual nudge).
    const seekToLine = async (line: LrcLine) => {
        await MediaManager.seekTo(Math.max(0, line.timeMs - manualOffsetMs) / 1000);
    };

    if (lines.length === 0) {
        return <Centered text="No lyrics available" />;
    }

    return (
        <View style={styles.fill}>
            <ScrollView
                ref={scrollRef}
                style={styles.fill}
                contentContainerStyle={styles.scrollContent}
                onLayout={(e) => {
                    containerHeight.current = e.nativeEvent.layout.height;
                    if (!didInitialJump.current) {
                        scrollToActive(false);
                        if (lineLayouts.current[active] && containerHeight.current) {
                            didInitialJump.current = true;
                        }
                    }
                }}
                showsVerticalScrollIndicator={false}
            >
                {lines.map((line, i) => (
                    <Pressable key={i} onPress={() => seekToLine(line)} onLayout={onLineLayout(i)}>
                        <Text
                            style={[
                                styles.line,
                                { color: theme.color.textFaint },
                                i === active && { color: theme.color.accent, fontWeight: "800", fontSize: 20 },
                            ]}
                        >
                            {line.text || "♪"}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
            <OffsetNudge offsetMs={manualOffsetMs} onNudge={nudge} />
        </View>
    );
}

function OffsetNudge({ offsetMs, onNudge }: { offsetMs: number; onNudge: (deltaMs: number) => void }) {
    const theme = useTheme();
    const label = offsetMs === 0 ? "In sync" : `${offsetMs > 0 ? "+" : "−"}${Math.abs(offsetMs / 1000).toFixed(2)}s`;
    return (
        <View style={styles.nudgeRow}>
            <Pressable style={[styles.nudgeBtn, { backgroundColor: theme.color.surface }]} onPress={() => onNudge(-NUDGE_STEP_MS)} hitSlop={8}>
                <Text style={[styles.nudgeBtnText, { color: theme.color.textMuted }]}>{"−"}</Text>
            </Pressable>
            <Text style={[styles.nudgeLabel, { color: theme.color.textFaint }]}>{label}</Text>
            <Pressable style={[styles.nudgeBtn, { backgroundColor: theme.color.surface }]} onPress={() => onNudge(NUDGE_STEP_MS)} hitSlop={8}>
                <Text style={[styles.nudgeBtnText, { color: theme.color.textMuted }]}>+</Text>
            </Pressable>
        </View>
    );
}

function PlainLyrics({ text }: { text: string }) {
    const theme = useTheme();
    return (
        <ScrollView style={styles.fill} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Text style={[styles.plain, { color: theme.color.textMuted }]}>{text}</Text>
        </ScrollView>
    );
}

function Centered({ text }: { text: string }) {
    const theme = useTheme();
    return (
        <View style={styles.centered}>
            <Text style={[styles.muted, { color: theme.color.textFaint }]}>{text}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    fill: {
        flex: 1,
    },
    scrollContent: {
        paddingVertical: 24,
    },
    line: {
        fontSize: 18,
        lineHeight: 30,
        textAlign: "center",
        paddingVertical: 4,
        paddingHorizontal: 16,
    },
    plain: {
        fontSize: 16,
        lineHeight: 26,
        paddingHorizontal: 16,
    },
    centered: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    muted: {
        fontSize: 16,
    },
    nudgeRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 8,
        gap: 16,
    },
    nudgeBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        justifyContent: "center",
        alignItems: "center",
    },
    nudgeBtnText: {
        fontSize: 20,
        fontWeight: "600",
    },
    nudgeLabel: {
        fontSize: 13,
        minWidth: 64,
        textAlign: "center",
    },
});
