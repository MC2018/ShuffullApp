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
import { useSongRequestsCapability } from "@/app/services/song-requests/capability";
import { useSongRequests } from "@/app/services/song-requests/useSongRequests";
import { playWhenSynced } from "@/app/services/song-requests/playRequested";
import { SongRequestStatus } from "@/app/enums";
import {
    completedRequestFor,
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

const REQUESTED_NOTE = "Requested. Its status is below.";

// Find a song the library doesn't have and request it (ShuffullApp#107). Reached from Home and now-playing, only when
// the server offers song requests. Search waits for a pause in typing; each request is a direct call, so its outcome
// shows at once and a failure can be retried by hand. The user's requests and their status sit below the results.
export default function SongRequestsScreen() {
    const theme = useTheme();
    const api = useApi();
    const db = useDb();
    const { capability, asking, ask } = useSongRequestsCapability();
    const requests = useSongRequests();
    const [text, setText] = useState("");
    const [search, setSearch] = useState<SearchState>({ status: "idle" });
    const [rows, setRows] = useState<Record<string, RowState>>({});
    // Only the newest search may set the results: an older one answering late is dropped.
    const searchSeq = useRef(0);
    // The play-now still waiting for its song. Aborted by the next one and when the screen closes.
    const playing = useRef<AbortController | null>(null);
    useEffect(() => () => playing.current?.abort(), []);

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

    // Return searches at once, unless that exact search already ran and worked.
    const submitSearch = () => {
        if (query != null && (query !== lastQuery || search.status === "failed")) {
            void runSearch(query);
        }
    };

    const updateResult = (externalSongId: string, change: Partial<SongRequestSearchResult>) =>
        setSearch((s) => s.status === "done"
            ? { ...s, results: s.results.map((r) => (r.externalSongId === externalSongId ? { ...r, ...change } : r)) }
            : s);
    const setRow = (externalSongId: string, state: RowState) => setRows((all) => ({ ...all, [externalSongId]: state }));

    // Files the request and shows it in the list. A request that didn't complete at once leaves the result Requested.
    // On a failure the row says why, and the list is re-read, since a refusal usually means the request moved on.
    const fileRequest = async (result: SongRequestSearchResult) => {
        try {
            const created = await api.songRequestCreate(toCreateSongRequest(result));
            requests.apply(created);
            if (created.status !== SongRequestStatus.Completed) {
                updateResult(result.externalSongId, { inLibrary: false, alreadyRequested: true });
                setRow(result.externalSongId, { busy: false, note: REQUESTED_NOTE, isError: false });
            }
            return created;
        } catch (error) {
            setRow(result.externalSongId, { busy: false, note: describeRequestFailure(error), isError: true });
            void requests.refresh();
            return null;
        }
    };

    const request = async (result: SongRequestSearchResult) => {
        setRow(result.externalSongId, { busy: true });
        const created = await fileRequest(result);
        if (created?.status === SongRequestStatus.Completed) {
            updateResult(result.externalSongId, { inLibrary: true });
            setRow(result.externalSongId, { busy: false, note: `Added to ${created.targetPlaylistName}`, isError: false });
        }
    };

    // The server has the song. Requesting it completes at once and links it to the user, so it can play here. A song
    // this user already requested to completion plays without another request, so replaying it files nothing.
    const playNow = async (result: SongRequestSearchResult) => {
        playing.current?.abort();
        const controller = new AbortController();
        playing.current = controller;
        setRow(result.externalSongId, { busy: true });

        let songId = completedRequestFor(requests.requests, result.externalSongId)?.songId;
        if (songId == null) {
            const created = await fileRequest(result);
            if (created?.status !== SongRequestStatus.Completed) {
                return; // fileRequest has said why on the row
            }
            if (created.songId == null) {
                setRow(result.externalSongId, { busy: false, note: "In your library.", isError: false });
                return;
            }
            songId = created.songId;
        }
        const outcome = await playWhenSynced(db, songId, controller.signal);
        if (outcome === "cancelled") {
            // The user moved on. If the screen is still open, the row just stops waiting.
            setRow(result.externalSongId, { busy: false, note: "In your library.", isError: false });
            return;
        }
        setRow(result.externalSongId, {
            busy: false,
            note: outcome === "played" ? "Playing" : "In your library. It reaches this device with the next sync; tap play again then.",
            isError: false,
        });
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

            {capability !== "on" ? (
                <Unavailable capability={capability} asking={asking} onRetry={ask} />
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
                        onSubmitEditing={submitSearch}
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

/** Why the screen can't offer requests: the server said no, or it couldn't be asked. */
function Unavailable({ capability, asking, onRetry }: { capability: "off" | "unknown"; asking: boolean; onRetry: () => void }) {
    const theme = useTheme();
    if (asking) {
        return <ActivityIndicator color={theme.color.accent} style={{ marginTop: theme.space.lg }} />;
    }
    if (capability === "off") {
        return (
            <Card style={{ marginTop: theme.space.md }}>
                <Text variant="body" color="textMuted">
                    {"Song requests aren't available on this server."}
                </Text>
            </Card>
        );
    }
    return (
        <Card style={{ marginTop: theme.space.md, gap: theme.space.md }}>
            <Text variant="body" color="textMuted">
                {"Can't check whether this server takes song requests right now. Try again when you're online."}
            </Text>
            <Button label="Try again" variant="ghost" onPress={onRetry} />
        </Card>
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
            <ResultAction result={result} busy={busy} onRequest={onRequest} onPlay={onPlay} />
        </View>
    );
}

/** The right side of a result: a spinner while busy, play for a song the library has, Requested, or Request. */
function ResultAction({ result, busy, onRequest, onPlay }: { result: SongRequestSearchResult; busy: boolean; onRequest: () => void; onPlay: () => void }) {
    const theme = useTheme();
    if (busy) {
        return <ActivityIndicator color={theme.color.accent} />;
    }
    if (result.inLibrary) {
        return (
            <Pressable onPress={onPlay} accessibilityRole="button" accessibilityLabel={`In the library. Play ${result.title} now`} hitSlop={8}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Ionicons name="play" size={12} color={theme.color.positive} />
                    <Badge label="In library" tone="positive" />
                </View>
            </Pressable>
        );
    }
    if (result.alreadyRequested) {
        return <Badge label="Requested" />;
    }
    return <Button label="Request" onPress={onRequest} />;
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
