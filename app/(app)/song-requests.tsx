import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AlbumArt, Button, Card, IconButton, Screen, SectionHeader, Text, TextField } from "@/app/components/ui";
import SongRequestStatusList from "@/app/components/song-requests/SongRequestStatusList";
import { useTheme } from "@/app/theme";
import { useApi } from "@/app/services/api/ApiProvider";
import { useDb } from "@/app/services/db/DbProvider";
import { SongRequestSearchResult } from "@/app/services/api/models";
import { useSongRequestsEnabled } from "@/app/services/song-requests/capability";
import { useSongRequests } from "@/app/services/song-requests/useSongRequests";
import { playWhenSynced } from "@/app/services/song-requests/playRequested";
import { SongRequestStatus } from "@/app/enums";
import {
    describeRequestFailure,
    describeSearchFailure,
    formatSongDuration,
    SEARCH_DEBOUNCE_MS,
    SEARCH_LIMIT,
    SEARCH_MAX_LENGTH,
    searchQuery,
    toCreateSongRequest,
} from "@/app/tools/songRequests";

type SearchState =
    | { status: "idle" }
    | { status: "searching"; query: string }
    | { status: "done"; query: string; results: SongRequestSearchResult[] }
    | { status: "failed"; query: string; message: string };

/** What a result row is doing right now, or what its last action came to. */
type RowState = { busy: true } | { busy: false; note: string; isError: boolean };

// Find a song the library doesn't have and request it (ShuffullApp#107). Reached from Home and now-playing, only when
// the server offers song requests. Search waits for a pause in typing; each request is a direct call, so its outcome
// shows at once and a failure can be retried by hand. The user's requests and their status sit below the results.
export default function SongRequestsScreen() {
    const theme = useTheme();
    const api = useApi();
    const db = useDb();
    const enabled = useSongRequestsEnabled();
    const requests = useSongRequests();
    const [text, setText] = useState("");
    const [search, setSearch] = useState<SearchState>({ status: "idle" });
    const [rows, setRows] = useState<Record<string, RowState>>({});
    // Only the newest search may set the results: an older one answering late is dropped.
    const searchSeq = useRef(0);

    const runSearch = useCallback(async (query: string) => {
        const seq = ++searchSeq.current;
        setSearch({ status: "searching", query });
        try {
            const results = await api.songRequestSearch(query, SEARCH_LIMIT);
            if (seq === searchSeq.current) {
                setSearch({ status: "done", query, results });
                setRows({});
            }
        } catch (error) {
            if (seq === searchSeq.current) {
                setSearch({ status: "failed", query, message: describeSearchFailure(error) });
            }
        }
    }, [api]);

    const query = searchQuery(text);
    const lastQuery = search.status === "idle" ? null : search.query;
    useEffect(() => {
        if (query == null) {
            searchSeq.current++;
            setSearch({ status: "idle" });
            return;
        }
        if (query === lastQuery) {
            return;
        }
        const timer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, lastQuery, runSearch]);

    const updateResult = (externalSongId: string, change: Partial<SongRequestSearchResult>) =>
        setSearch((s) => s.status === "done"
            ? { ...s, results: s.results.map((r) => (r.externalSongId === externalSongId ? { ...r, ...change } : r)) }
            : s);
    const setRow = (externalSongId: string, state: RowState) => setRows((all) => ({ ...all, [externalSongId]: state }));

    const request = async (result: SongRequestSearchResult) => {
        setRow(result.externalSongId, { busy: true });
        try {
            const created = await api.songRequestCreate(toCreateSongRequest(result));
            requests.apply(created);
            const completed = created.status === SongRequestStatus.Completed;
            updateResult(result.externalSongId, completed ? { inLibrary: true } : { alreadyRequested: true });
            setRow(result.externalSongId, {
                busy: false,
                note: completed ? `Added to ${created.targetPlaylistName}` : "Requested. Its status is below.",
                isError: false,
            });
        } catch (error) {
            setRow(result.externalSongId, { busy: false, note: describeRequestFailure(error), isError: true });
            void requests.refresh();
        }
    };

    // The server has the song: requesting it completes at once and links it to the user, so it can play here.
    const playNow = async (result: SongRequestSearchResult) => {
        setRow(result.externalSongId, { busy: true });
        try {
            const created = await api.songRequestCreate(toCreateSongRequest(result));
            requests.apply(created);
            if (created.status !== SongRequestStatus.Completed || created.songId == null) {
                updateResult(result.externalSongId, { inLibrary: false, alreadyRequested: true });
                setRow(result.externalSongId, { busy: false, note: "Requested. Its status is below.", isError: false });
                return;
            }
            const played = await playWhenSynced(db, created.songId);
            setRow(result.externalSongId, {
                busy: false,
                note: played ? "Playing" : "In your library. It plays here once the next sync brings it in.",
                isError: false,
            });
        } catch (error) {
            setRow(result.externalSongId, { busy: false, note: describeRequestFailure(error), isError: true });
        }
    };

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.sm }}>
                <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="micro" color="accentTint">
                        Song requests
                    </Text>
                    <Text variant="screenTitle">Find a song</Text>
                </View>
            </View>

            {!enabled ? (
                <Card style={{ marginTop: theme.space.md }}>
                    <Text variant="body" color="textMuted">
                        {"Song requests aren't available on this server."}
                    </Text>
                </Card>
            ) : (
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: theme.space.xxxl }}>
                    <TextField
                        value={text}
                        onChangeText={setText}
                        placeholder="Song or artist"
                        autoFocus
                        autoCorrect={false}
                        returnKeyType="search"
                        maxLength={SEARCH_MAX_LENGTH}
                        onSubmitEditing={() => query != null && void runSearch(query)}
                        accessibilityLabel="Search for a song to request"
                        style={{ marginTop: theme.space.sm }}
                    />
                    <SearchResults search={search} rows={rows} onRetry={runSearch} onRequest={request} onPlay={playNow} />

                    <SectionHeader title="Your requests" />
                    <SongRequestStatusList view={requests} emptyText="Nothing requested yet. Search above to find a song." />
                </ScrollView>
            )}
        </Screen>
    );
}

interface ResultsProps {
    search: SearchState;
    rows: Record<string, RowState>;
    onRetry: (query: string) => void;
    onRequest: (result: SongRequestSearchResult) => void;
    onPlay: (result: SongRequestSearchResult) => void;
}

function SearchResults({ search, rows, onRetry, onRequest, onPlay }: ResultsProps) {
    const theme = useTheme();
    switch (search.status) {
        case "idle":
            return (
                <Text variant="caption" color="textFaint" style={{ marginTop: theme.space.md }}>
                    {"Search for a song that isn't in your library, then request it. Requested songs land in this week's requests playlist."}
                </Text>
            );
        case "searching":
            return <ActivityIndicator color={theme.color.accent} style={{ marginTop: theme.space.lg }} />;
        case "failed":
            return (
                <Card style={{ marginTop: theme.space.md, gap: theme.space.md }}>
                    <Text variant="body" color="textMuted">
                        {search.message}
                    </Text>
                    <Button label="Try again" variant="ghost" onPress={() => onRetry(search.query)} />
                </Card>
            );
        case "done":
            return search.results.length === 0 ? (
                <Text variant="body" color="textFaint" style={{ marginTop: theme.space.md }}>
                    {`No songs found for "${search.query}".`}
                </Text>
            ) : (
                <View style={{ marginTop: theme.space.sm }}>
                    {search.results.map((result) => (
                        <SearchResultRow
                            key={result.externalSongId}
                            result={result}
                            row={rows[result.externalSongId]}
                            onRequest={() => onRequest(result)}
                            onPlay={() => onPlay(result)}
                        />
                    ))}
                </View>
            );
    }
}

interface ResultRowProps {
    result: SongRequestSearchResult;
    row: RowState | undefined;
    onRequest: () => void;
    onPlay: () => void;
}

function SearchResultRow({ result, row, onRequest, onPlay }: ResultRowProps) {
    const theme = useTheme();
    const duration = formatSongDuration(result.durationSeconds);
    const byline = [result.artists.join(", "), duration].filter(Boolean).join(" · ");
    const busy = row?.busy === true;
    const note = row && !row.busy ? row : null;

    return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.sm }}>
            <AlbumArt source={result.thumbnailUrl ? { uri: result.thumbnailUrl } : undefined} size={52} radius={theme.radius.sm} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.xs }}>
                    <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {result.title}
                    </Text>
                    {result.isExplicit ? <Badge label="E" /> : null}
                </View>
                {byline ? (
                    <Text variant="caption" color="textMuted" numberOfLines={1}>
                        {byline}
                    </Text>
                ) : null}
                {note ? (
                    <Text variant="caption" color={note.isError ? "accent" : "textFaint"} numberOfLines={3} style={{ marginTop: 2 }}>
                        {note.note}
                    </Text>
                ) : null}
            </View>
            {busy ? (
                <ActivityIndicator color={theme.color.accent} />
            ) : result.inLibrary ? (
                <Pressable onPress={onPlay} accessibilityRole="button" accessibilityLabel={`In library. Play ${result.title} now`} hitSlop={8}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Ionicons name="play" size={12} color={theme.color.positive} />
                        <Badge label="In library" tone="positive" />
                    </View>
                </Pressable>
            ) : result.alreadyRequested ? (
                <Badge label="Requested" />
            ) : (
                <Button label="Request" onPress={onRequest} />
            )}
        </View>
    );
}

function Badge({ label, tone }: { label: string; tone?: "positive" }) {
    const theme = useTheme();
    return (
        <View
            style={{
                paddingVertical: 2,
                paddingHorizontal: theme.space.sm,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.color.neutralFill,
            }}
        >
            <Text variant="caption" color={tone === "positive" ? "positive" : "textMuted"}>
                {label}
            </Text>
        </View>
    );
}
