import React, { useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useProgress } from "react-native-track-player";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Song } from "@/app/services/db/models";
import { MediaManager } from "@/app/services/media-manager";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { activeLineIndex, LrcLine, parseLrc } from "@/app/tools/lrc";

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
    const lines = useMemo(() => parseLrc(lrc), [lrc]);
    const { position } = useProgress(PROGRESS_INTERVAL_MS);
    const [manualOffsetMs, setManualOffsetMs] = useState(0);

    const scrollRef = useRef<ScrollView>(null);
    const lineLayouts = useRef<Record<number, { y: number; h: number }>>({});
    const containerHeight = useRef(0);

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
        return () => { cancelled = true; };
    }, [offsetKey]);

    // syncedLyrics is already trim-shifted by the producer (for YT-Music lyrics); the manual nudge is the
    // only adjustment applied here (positive = lyrics advance / appear earlier).
    const positionMs = position * 1000 + manualOffsetMs;
    const active = activeLineIndex(lines, positionMs);

    // Keep the active line centered.
    useEffect(() => {
        if (active < 0) {
            return;
        }
        const layout = lineLayouts.current[active];
        if (!layout || !containerHeight.current) {
            return;
        }
        const y = Math.max(0, layout.y - containerHeight.current / 2 + layout.h / 2);
        scrollRef.current?.scrollTo({ y, animated: true });
    }, [active]);

    const nudge = async (deltaMs: number) => {
        const next = manualOffsetMs + deltaMs;
        setManualOffsetMs(next);
        await AsyncStorage.setItem(offsetKey, String(next));
    };

    const onLineLayout = (i: number) => (e: LayoutChangeEvent) => {
        const { y, height } = e.nativeEvent.layout;
        lineLayouts.current[i] = { y, h: height };
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
                onLayout={(e) => { containerHeight.current = e.nativeEvent.layout.height; }}
                showsVerticalScrollIndicator={false}
            >
                {lines.map((line, i) => (
                    <Pressable key={i} onPress={() => seekToLine(line)} onLayout={onLineLayout(i)}>
                        <Text style={[styles.line, i === active && styles.activeLine]}>
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
    const label = offsetMs === 0 ? "In sync" : `${offsetMs > 0 ? "+" : "−"}${Math.abs(offsetMs / 1000).toFixed(2)}s`;
    return (
        <View style={styles.nudgeRow}>
            <Pressable style={styles.nudgeBtn} onPress={() => onNudge(-NUDGE_STEP_MS)} hitSlop={8}>
                <Text style={styles.nudgeBtnText}>{"−"}</Text>
            </Pressable>
            <Text style={styles.nudgeLabel}>{label}</Text>
            <Pressable style={styles.nudgeBtn} onPress={() => onNudge(NUDGE_STEP_MS)} hitSlop={8}>
                <Text style={styles.nudgeBtnText}>+</Text>
            </Pressable>
        </View>
    );
}

function PlainLyrics({ text }: { text: string }) {
    return (
        <ScrollView style={styles.fill} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.plain}>{text}</Text>
        </ScrollView>
    );
}

function Centered({ text }: { text: string }) {
    return (
        <View style={styles.centered}>
            <Text style={styles.muted}>{text}</Text>
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
        color: "#888",
        paddingVertical: 4,
        paddingHorizontal: 16,
    },
    activeLine: {
        color: "#111",
        fontWeight: "700",
        fontSize: 20,
    },
    plain: {
        fontSize: 16,
        lineHeight: 26,
        color: "#222",
        paddingHorizontal: 16,
    },
    centered: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    muted: {
        fontSize: 16,
        color: "#888",
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
        backgroundColor: "#eee",
        justifyContent: "center",
        alignItems: "center",
    },
    nudgeBtnText: {
        fontSize: 20,
        fontWeight: "600",
        color: "#333",
    },
    nudgeLabel: {
        fontSize: 13,
        color: "#666",
        minWidth: 64,
        textAlign: "center",
    },
});
