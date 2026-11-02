import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/app/services/api/ApiProvider";
import { SongRequest } from "@/app/services/api/models";
import { SongRequestsView } from "@/app/services/song-requests/useSongRequests";
import { cancelPlayNext, usePlayNext } from "@/app/services/song-requests/playNext";
import { describeRequestFailure, describeSongRequest, SongRequestTone, SongRequestView, toCreateSongRequest, visibleSongRequests } from "@/app/tools/songRequests";
import { AlbumArt, Button, Text } from "@/app/components/ui";
import { ColorToken, useTheme } from "@/app/theme";

const TONE_COLOR: Record<SongRequestTone, ColorToken> = {
    active: "accentTint",
    failed: "accent",
    done: "positive",
    muted: "textFaint",
};

interface Props {
    view: SongRequestsView;
    /** Show at most this many, newest first. */
    limit?: number;
    /** Said when there are no requests. Nothing is shown when it is left out. */
    emptyText?: string;
}

// The caller's song requests with their status (ShuffullApp#107): cancel while Pending, retry once Failed. Each is a
// direct call whose answer replaces the row, and a failure shows on the row, so the user can try again. A request the
// user asked to play next says so, and the user can take that back (ShuffullApp#108).
export default function SongRequestStatusList({ view, limit, emptyText }: Props) {
    const theme = useTheme();
    const { requests, loadError } = view;

    if (requests == null) {
        return loadError ? (
            <Text variant="caption" color="textFaint">
                {loadError}
            </Text>
        ) : (
            <ActivityIndicator color={theme.color.accent} style={{ alignSelf: "flex-start" }} />
        );
    }

    const shown = visibleSongRequests(requests).slice(0, limit);
    if (shown.length === 0) {
        return emptyText ? (
            <Text variant="body" color="textFaint">
                {emptyText}
            </Text>
        ) : null;
    }

    return (
        <View>
            {loadError ? (
                <Text variant="caption" color="textFaint" style={{ marginBottom: theme.space.xs }}>
                    {loadError}
                </Text>
            ) : null}
            {shown.map((request) => (
                <SongRequestRow key={request.songRequestId} request={request} onChanged={view.apply} onFailed={view.refresh} />
            ))}
        </View>
    );
}

interface RowProps {
    request: SongRequest;
    onChanged: (changed: SongRequest) => void;
    /** A refusal usually means the request moved on (a 409), so the list is re-read. */
    onFailed: () => void;
}

function SongRequestRow({ request, onChanged, onFailed }: RowProps) {
    const theme = useTheme();
    const api = useApi();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const status = describeSongRequest(request);
    const playsNext = usePlayNext((state) => state.intents.some((i) =>
        i.songRequestId === request.songRequestId || (i.songRequestId == null && i.externalSongId === request.externalSongId)));

    const act = async (call: () => Promise<SongRequest>, after?: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            onChanged(await call());
            await after?.();
        } catch (e) {
            setError(describeRequestFailure(e));
            onFailed();
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.sm }}>
            <AlbumArt source={request.thumbnailUrl ? { uri: request.thumbnailUrl } : undefined} size={44} radius={theme.radius.sm} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyStrong" numberOfLines={1}>
                    {request.title}
                </Text>
                {request.artists.length > 0 ? (
                    <Text variant="caption" color="textMuted" numberOfLines={1}>
                        {request.artists.join(", ")}
                    </Text>
                ) : null}
                <Text variant="caption" color={TONE_COLOR[status.tone]} numberOfLines={2} style={{ marginTop: 2 }}>
                    {status.label}
                </Text>
                {playsNext ? (
                    <Pressable
                        onPress={() => cancelPlayNext(request.externalSongId).catch((e) => setError(`Couldn't change that: ${String(e)}`))}
                        accessibilityRole="button"
                        accessibilityLabel={`${request.title} plays next. Don't play it next`}
                        hitSlop={8}
                        style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2, alignSelf: "flex-start" }}
                    >
                        <Text variant="caption" color="accentTint">
                            Plays next
                        </Text>
                        <Ionicons name="close" size={12} color={theme.color.textFaint} />
                    </Pressable>
                ) : null}
                {error ? (
                    <Text variant="caption" color="accent" numberOfLines={3} style={{ marginTop: 2 }}>
                        {error}
                    </Text>
                ) : null}
            </View>
            <RowAction
                busy={busy}
                status={status}
                onRetry={() => act(() => api.songRequestCreate(toCreateSongRequest(request)))}
                // The user cancelled it, so its play-next goes quietly rather than with a "was cancelled" message.
                onCancel={() => act(() => api.songRequestCancel(request.songRequestId), () => cancelPlayNext(request.externalSongId))}
            />
        </View>
    );
}

/** The right side of a row: a spinner while busy, Retry once Failed, Cancel while Pending, otherwise nothing. */
function RowAction({ busy, status, onRetry, onCancel }: { busy: boolean; status: SongRequestView; onRetry: () => void; onCancel: () => void }) {
    const theme = useTheme();
    if (busy) {
        return <ActivityIndicator color={theme.color.accent} />;
    }
    if (status.canRetry) {
        return <Button label="Retry" variant="ghost" onPress={onRetry} />;
    }
    if (status.canCancel) {
        return <Button label="Cancel" variant="danger" onPress={onCancel} />;
    }
    return null;
}
