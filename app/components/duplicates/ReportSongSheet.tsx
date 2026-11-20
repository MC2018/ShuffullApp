import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { DUPLICATE_REPORT_MAX_NOTE_LENGTH } from "@/app/services/db/schema";
import { useActiveSong, useSongStateRevision } from "@/app/services/media-manager/mediaManager";
import { Button, ListRow, SectionHeader, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { showAlert } from "@/app/tools/dialog";
import {
    DuplicateCandidate,
    DuplicateSuggestion,
    DuplicateSuggestionReason,
    orderDuplicateCandidates,
} from "@/app/tools/duplicatePicker";

export interface ReportedSong {
    songId: string;
    name: string;
    artists: string[];
}

interface Props {
    song: ReportedSong;
    visible: boolean;
    onClose: () => void;
    // Whether a poor-quality flag is already queued, and how to queue one (the existing replacement flag).
    poorQualityFlagged: boolean;
    onFlagPoorQuality: () => void;
    // After a duplicate or different-version report is saved, with the song it hides.
    onReported: (hiddenSongId: string) => void;
}

type Step = "choose" | "pick" | "keep" | "differentVersion";

const SECTION_TITLES: Record<DuplicateSuggestionReason, string> = {
    nowPlaying: "Playing now",
    recent: "Recently played",
    similar: "Similar title or same artist",
    search: "Search",
};

// The flag button's sheet (ShuffullApp#219): poor quality (a replacement flag), "Duplicate of…", or "Different
// version, hide this one". A report hides one copy for this user only, at once and on this device, and the user can
// undo it from the song's screen or Settings → Hidden duplicates. It never touches the like status.
export default function ReportSongSheet({ song, visible, onClose, poorQualityFlagged, onFlagPoorQuality, onReported }: Props) {
    const theme = useTheme();
    const db = useDb();
    const userId = useCurrentUser();
    const nowPlayingId = useActiveSong((state) => state.songId);
    const [step, setStep] = useState<Step>("choose");
    const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
    const [query, setQuery] = useState("");
    const [other, setOther] = useState<DuplicateCandidate | null>(null);
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);

    // Start over each time the sheet opens.
    useEffect(() => {
        if (visible) {
            setStep("choose");
            setCandidates(null);
            setQuery("");
            setOther(null);
            setNote("");
        }
    }, [visible]);

    useEffect(() => {
        if (!visible || step !== "pick" || candidates != null) {
            return;
        }
        let cancelled = false;
        DbQueries.getDuplicateCandidates(db, userId).then((rows) => {
            if (!cancelled) {
                setCandidates(rows);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [visible, step, candidates, db, userId]);

    const suggestions = useMemo(
        () => (candidates ? orderDuplicateCandidates({ song, nowPlayingId, candidates, query }) : []),
        [candidates, song, nowPlayingId, query],
    );

    const searchResults = suggestions.filter((x) => x.reason === "search");
    const pick = (candidate: DuplicateCandidate) => {
        setOther(candidate);
        setStep("keep");
    };

    const submit = async (input: { otherSongId: string | null; preferredSongId: string | null }) => {
        if (saving) {
            return;
        }
        setSaving(true);
        try {
            const report = await DbQueries.reportDuplicate(db, {
                userId,
                songId: song.songId,
                otherSongId: input.otherSongId,
                kind: input.otherSongId ? "duplicate" : "differentVersion",
                preferredSongId: input.preferredSongId,
                note,
            });
            useSongStateRevision.getState().bump();
            onReported(report.hiddenSongId);
            onClose();
        } catch (e) {
            showAlert("Couldn't save the report", e instanceof Error ? e.message : "Please try again.");
        } finally {
            setSaving(false);
        }
    };

    const title =
        step === "choose" ? "What's wrong with this song?"
            : step === "pick" ? "Duplicate of…"
                : step === "keep" ? "Which copy do you keep?"
                    : "Different version";

    const noteField = (
        <>
            <SectionHeader title="Note (optional)" />
            <TextField
                placeholder="Anything the curator should know"
                value={note}
                onChangeText={setNote}
                maxLength={DUPLICATE_REPORT_MAX_NOTE_LENGTH}
                multiline
            />
        </>
    );

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={{ flex: 1, justifyContent: "flex-end" }}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
                <View
                    style={{
                        backgroundColor: theme.color.bg,
                        borderTopLeftRadius: theme.radius.lg,
                        borderTopRightRadius: theme.radius.lg,
                        borderWidth: 1,
                        borderColor: theme.color.line,
                        paddingHorizontal: theme.space.lg,
                        paddingTop: theme.space.md,
                        paddingBottom: theme.space.xl,
                        maxHeight: "85%",
                    }}
                >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.space.sm }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, flexShrink: 1 }}>
                            {step !== "choose" ? (
                                <Pressable
                                    onPress={() => setStep(step === "keep" ? "pick" : "choose")}
                                    hitSlop={8}
                                    accessibilityLabel="Back"
                                >
                                    <Ionicons name="chevron-back" size={20} color={theme.color.textPrimary} />
                                </Pressable>
                            ) : null}
                            <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</Text>
                        </View>
                        <Pressable onPress={onClose} hitSlop={8}>
                            <Text variant="label" color="accent">Cancel</Text>
                        </Pressable>
                    </View>

                    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                        {step === "choose" ? (
                            <>
                                <ListRow
                                    title="Poor quality"
                                    subtitle={poorQualityFlagged ? "Already flagged for a better copy" : "Ask for a better copy of this song"}
                                    left={<Ionicons name={poorQualityFlagged ? "flag" : "flag-outline"} size={22} color={theme.color.textMuted} />}
                                    onPress={() => {
                                        onClose();
                                        onFlagPoorQuality();
                                    }}
                                />
                                <ListRow
                                    title="Duplicate of…"
                                    subtitle="You already have this song. Hides one copy."
                                    left={<Ionicons name="copy-outline" size={22} color={theme.color.textMuted} />}
                                    onPress={() => setStep("pick")}
                                />
                                <ListRow
                                    title="Different version, hide this one"
                                    subtitle="A live, cover or remix you don't want. Hides this song."
                                    left={<Ionicons name="eye-off-outline" size={22} color={theme.color.textMuted} />}
                                    onPress={() => setStep("differentVersion")}
                                />
                            </>
                        ) : null}

                        {step === "pick" ? (
                            candidates == null ? (
                                <View style={{ paddingVertical: theme.space.xl, alignItems: "center" }}>
                                    <ActivityIndicator color={theme.color.accent} />
                                </View>
                            ) : (
                                <>
                                    <SuggestionList
                                        suggestions={suggestions.filter((x) => x.reason !== "search")}
                                        onPick={pick}
                                    />
                                    {/* The search box comes last; its matches show under it. */}
                                    <SectionHeader title="Search" />
                                    <TextField
                                        placeholder="Song or artist in your library"
                                        value={query}
                                        onChangeText={setQuery}
                                        autoCorrect={false}
                                    />
                                    {query.trim() ? (
                                        searchResults.length ? (
                                            searchResults.map((x) => (
                                                <ListRow
                                                    key={x.candidate.songId}
                                                    title={x.candidate.name}
                                                    subtitle={x.candidate.artists.join(", ") || "Unknown artist"}
                                                    onPress={() => pick(x.candidate)}
                                                />
                                            ))
                                        ) : (
                                            <Text variant="body" color="textFaint" style={{ paddingVertical: theme.space.md }}>
                                                No other matches in your library.
                                            </Text>
                                        )
                                    ) : null}
                                </>
                            )
                        ) : null}

                        {step === "keep" && other ? (
                            <>
                                <Text variant="body" color="textMuted" style={{ marginBottom: theme.space.sm }}>
                                    “{song.name}” and “{other.name}”. The other copy is hidden for you only, and you can undo it.
                                </Text>
                                <ListRow
                                    title="Keep this one"
                                    subtitle={`Hides “${other.name}”`}
                                    onPress={() => submit({ otherSongId: other.songId, preferredSongId: song.songId })}
                                />
                                <ListRow
                                    title="Keep the other"
                                    subtitle={`Hides “${song.name}”`}
                                    onPress={() => submit({ otherSongId: other.songId, preferredSongId: other.songId })}
                                />
                                <ListRow
                                    title="Let the curator decide"
                                    subtitle={`Hides “${song.name}” until then`}
                                    onPress={() => submit({ otherSongId: other.songId, preferredSongId: null })}
                                />
                                {noteField}
                            </>
                        ) : null}

                        {step === "differentVersion" ? (
                            <>
                                <Text variant="body" color="textMuted" style={{ marginBottom: theme.space.sm }}>
                                    “{song.name}” leaves shuffle, your library lists and mixes, for you only. It is not a
                                    dislike, and you can undo it.
                                </Text>
                                {noteField}
                                <View style={{ marginTop: theme.space.lg }}>
                                    <Button
                                        label="Hide this song"
                                        icon="eye-off-outline"
                                        full
                                        disabled={saving}
                                        onPress={() => submit({ otherSongId: null, preferredSongId: null })}
                                    />
                                </View>
                            </>
                        ) : null}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

// The suggested rows under a header for each section, in orderDuplicateCandidates' order.
function SuggestionList({ suggestions, onPick }: { suggestions: DuplicateSuggestion[]; onPick: (c: DuplicateCandidate) => void }) {
    const theme = useTheme();
    if (!suggestions.length) {
        return (
            <Text variant="body" color="textFaint" style={{ paddingVertical: theme.space.md }}>
                No suggestions. Search your library below.
            </Text>
        );
    }
    return (
        <>
            {suggestions.map((x, i) => (
                <View key={x.candidate.songId}>
                    {i === 0 || suggestions[i - 1].reason !== x.reason ? <SectionHeader title={SECTION_TITLES[x.reason]} /> : null}
                    <ListRow
                        title={x.candidate.name}
                        subtitle={x.candidate.artists.join(", ") || "Unknown artist"}
                        onPress={() => onPick(x.candidate)}
                    />
                </View>
            ))}
        </>
    );
}
