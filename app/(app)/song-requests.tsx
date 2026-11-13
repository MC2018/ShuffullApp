import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useShallow } from "zustand/react/shallow";
import { AlbumArt, Button, Card, IconButton, Screen, SectionHeader, Text, TextField } from "@/app/components/ui";
import SongRequestStatusList, { PlayNextWithoutRequestList } from "@/app/components/song-requests/SongRequestStatusList";
import { useTheme } from "@/app/theme";
import { useApi } from "@/app/services/api/ApiProvider";
import { useDb } from "@/app/services/db/DbProvider";
import { SongRequest, SongRequestSearchResult } from "@/app/services/api/models";
import { useSongRequestsCapability } from "@/app/services/song-requests/capability";
import { useSongRequests } from "@/app/services/song-requests/useSongRequests";
import {
    attachPlayNextRequest,
    cancelPlayNext,
    playNowOrNext,
    recordPlayNext,
    savePlayNext,
    usePlayNext,
} from "@/app/services/song-requests/playNext";
import { SongRequestStatus } from "@/app/enums";
import {
    openRequestFor,
    ownedSongIdFor,
    describeRequestFailure,
    describeSearchFailure,
    formatSongDuration,
    resultWithRequests,
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

/**
 * What a result row is doing right now, or what its last action came to. `whileRequested` notes go once it isn't, and
 * `whilePlaysNext` notes once its play-next intent is gone.
 */
type RowState = { busy: true } | { busy: false; note: string; isError: boolean; whileRequested?: boolean; whilePlaysNext?: boolean };

const REQUESTED_NOTE = "Requested. Its status is below.";
const PLAY_NEXT_NOTE = "Plays next once it arrives.";

// Find a song the library doesn't have and request it (ShuffullApp#107). Reached from Home and now-playing, only when
// the server offers song requests. Search waits for a pause in typing; each request is a direct call, so its outcome
// shows at once and a failure can be retried by hand. The user's requests and their status sit below the results, after
// any play-next with no request row to show it (ShuffullApp#175).
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

    const setRow = (externalSongId: string, state: RowState) => setRows((all) => ({ ...all, [externalSongId]: state }));

    // Files the request and shows it in the list, which the result's badge follows from then on. On a failure the row
    // says why, and the list is re-read, since a refusal usually means the request moved on.
    const fileRequest = async (result: SongRequestSearchResult) => {
        try {
            const created = await api.songRequestCreate(toCreateSongRequest(result));
            requests.apply(created);
            if (created.status !== SongRequestStatus.Completed) {
                setRow(result.externalSongId, { busy: false, note: REQUESTED_NOTE, isError: false, whileRequested: true });
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
            setRow(result.externalSongId, { busy: false, note: `Added to ${created.targetPlaylistName}`, isError: false });
        }
    };

    // The server has the song. One the user already has plays with no request (Shuffull#117): requesting it would add it
    // to this week's requests playlist and their auditions again. One they don't have is requested, which completes at
    // once and links it to them. A song not on this device yet gets a play-next intent before the wait, so the ask
    // outlives the wait, the screen and the app: it plays when it arrives if nothing else started meanwhile, and right
    // after the current song otherwise.
    const playNow = async (result: SongRequestSearchResult) => {
        playing.current?.abort();
        const controller = new AbortController();
        playing.current = controller;
        setRow(result.externalSongId, { busy: true });

        let songId = ownedSongIdFor(result);
        let songRequestId: string | null = null;
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
            songRequestId = created.songRequestId;
        }
        const { outcome, queued } = await playNowOrNext(db, result, { songId, songRequestId }, controller.signal);
        if (outcome === "played") {
            setRow(result.externalSongId, { busy: false, note: "Playing", isError: false });
        } else if (queued) {
            setRow(result.externalSongId, { busy: false, note: PLAY_NEXT_NOTE, isError: false, whilePlaysNext: true });
        } else {
            // The user moved on, or the intent couldn't be saved. If the screen is still open, the row stops waiting.
            setRow(result.externalSongId, {
                busy: false,
                note: outcome === "cancelled" ? "In your library." : "In your library. It reaches this device with the next sync; tap play again then.",
                isError: false,
            });
        }
    };

    // Plays the song right after the current one, once it is on this device (ShuffullApp#108). A song the user has needs
    // no request (Shuffull#117). Otherwise the intent is saved before the request is filed, so a restart, or the app
    // dying mid-call, keeps it, and a request already open for the song is reused rather than filed again.
    const playNext = async (result: SongRequestSearchResult) => {
        setRow(result.externalSongId, { busy: true });
        const owned = ownedSongIdFor(result);
        if (owned != null) {
            const error = await savePlayNext(result, { songId: owned, songRequestId: null });
            setRow(result.externalSongId, error == null
                ? { busy: false, note: PLAY_NEXT_NOTE, isError: false, whilePlaysNext: true }
                : { busy: false, note: `Couldn't save that: ${error}`, isError: true });
            return;
        }
        try {
            await recordPlayNext(result);
        } catch (error) {
            setRow(result.externalSongId, { busy: false, note: `Couldn't save that: ${String(error)}`, isError: true });
            return;
        }
        const request = openRequestFor(requests.requests, result.externalSongId) ?? await fileRequest(result);
        if (request == null) {
            await cancelPlayNext(result.externalSongId); // fileRequest has said why on the row
            return;
        }
        await attachPlayNextRequest(request);
        setRow(result.externalSongId, { busy: false, note: PLAY_NEXT_NOTE, isError: false, whilePlaysNext: true });
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
                    <SearchResults search={search} rows={rows} requests={requests.requests} onRetry={runSearch} onRequest={request} onPlay={playNow} onPlayNext={playNext} />

                    <PlayNextWithoutRequestList view={requests} title="Playing next" />
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
    requests: SongRequest[] | null;
    onRetry: (query: string) => void;
    onRequest: (result: SongRequestSearchResult) => void;
    onPlay: (result: SongRequestSearchResult) => void;
    onPlayNext: (result: SongRequestSearchResult) => void;
}

function SearchResults({ search, rows, requests, onRetry, onRequest, onPlay, onPlayNext }: ResultsProps) {
    const theme = useTheme();
    // A song asked for from its library page is keyed by its song id (libraryPlayNextKey), not its source id, so match both.
    const playNextIdList = usePlayNext(useShallow((state) => state.intents.flatMap((i) => i.songId == null ? [i.externalSongId] : [i.externalSongId, i.songId])));
    const playNextIds = useMemo(() => new Set(playNextIdList), [playNextIdList]);
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
                    {search.results.map((found) => resultWithRequests(found, requests)).map((result) => (
                        <SearchResultRow
                            key={result.externalSongId}
                            result={result}
                            row={rows[result.externalSongId]}
                            onRequest={() => onRequest(result)}
                            onPlay={() => onPlay(result)}
                            playsNext={[result.externalSongId, ownedSongIdFor(result)].some((id) => id != null && playNextIds.has(id))}
                            onPlayNext={() => onPlayNext(result)}
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
    /** A play-next intent is waiting on this song. */
    playsNext: boolean;
    onPlayNext: () => void;
}

function SearchResultRow({ result, row, onRequest, onPlay, playsNext, onPlayNext }: ResultRowProps) {
    const theme = useTheme();
    const duration = formatSongDuration(result.durationSeconds);
    const byline = [result.artists.join(", "), duration].filter(Boolean).join(" · ");
    const busy = row?.busy === true;
    const note = row && !row.busy && (!row.whileRequested || result.alreadyRequested) && (!row.whilePlaysNext || playsNext) ? row : null;

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
                {busy ? null : <PlayNextControl result={result} playsNext={playsNext} noted={note?.whilePlaysNext === true} onPlayNext={onPlayNext} />}
            </View>
            <ResultAction result={result} busy={busy} onRequest={onRequest} onPlay={onPlay} />
        </View>
    );
}

/** Under a result: "Plays next" once asked (unless the row's note already says so), otherwise the action to ask. */
function PlayNextControl({ result, playsNext, noted, onPlayNext }: { result: SongRequestSearchResult; playsNext: boolean; noted: boolean; onPlayNext: () => void }) {
    const theme = useTheme();
    if (playsNext) {
        return noted ? null : (
            <Text variant="caption" color="accentTint" style={{ marginTop: 2 }}>
                Plays next
            </Text>
        );
    }
    const requested = result.inLibrary || result.alreadyRequested;
    return (
        <Pressable
            onPress={onPlayNext}
            accessibilityRole="button"
            accessibilityLabel={`${requested ? "Play" : "Request and play"} ${result.title} next`}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4, alignSelf: "flex-start" }}
        >
            <Ionicons name="play-skip-forward" size={12} color={theme.color.accentTint} />
            <Text variant="caption" color="accentTint">
                {requested ? "Play next" : "Request & play next"}
            </Text>
        </Pressable>
    );
}

/** The right side of a result: a spinner while busy, play for a song the library has (or the user), Requested, or Request. */
function ResultAction({ result, busy, onRequest, onPlay }: { result: SongRequestSearchResult; busy: boolean; onRequest: () => void; onPlay: () => void }) {
    const theme = useTheme();
    if (busy) {
        return <ActivityIndicator color={theme.color.accent} />;
    }
    if (result.inLibrary) {
        const yours = ownedSongIdFor(result) != null;
        return (
            <Pressable onPress={onPlay} accessibilityRole="button" accessibilityLabel={`In ${yours ? "your" : "the"} library. Play ${result.title} now`} hitSlop={8}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Ionicons name="play" size={12} color={theme.color.positive} />
                    <Badge label={yours ? "In your library" : "In library"} tone="positive" />
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
