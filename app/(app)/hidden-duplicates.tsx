import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { HiddenDuplicate } from "@/app/services/db/queries/duplicateReport";
import { useSongStateRevision } from "@/app/services/media-manager/mediaManager";
import { IconButton, ListRow, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

// Settings → Hidden duplicates (ShuffullApp#219): every song the user's duplicate reports hide from them, with an
// Undo that withdraws the report and brings the song back. A hide is per user and never a dislike.
export default function HiddenDuplicatesScreen() {
    const theme = useTheme();
    const db = useDb();
    const userId = useCurrentUser();
    const revision = useSongStateRevision((state) => state.revision);
    const [rows, setRows] = useState<HiddenDuplicate[] | null>(null);

    const load = useCallback(async () => {
        setRows(await DbQueries.getHiddenDuplicates(db, userId));
    }, [db, userId]);

    useEffect(() => {
        load();
    }, [load, revision]);

    const undo = async (hiddenSongId: string) => {
        await DbQueries.withdrawDuplicateReports(db, userId, hiddenSongId);
        useSongStateRevision.getState().bump();
        await load();
    };

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.md }}>
                <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                <Text variant="screenTitle">Hidden duplicates</Text>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.sm }}>
                {rows != null && rows.length === 0 ? (
                    <Text variant="body" color="textMuted">
                        Nothing hidden. Songs you report as a duplicate or a version you don&apos;t want show here.
                    </Text>
                ) : null}
                {(rows ?? []).map((row) => (
                    <ListRow
                        key={row.hiddenSongId}
                        title={row.song?.name ?? "A song no longer on this device"}
                        subtitle={describeHide(row)}
                        onPress={row.song ? () => router.push(`/song/${row.hiddenSongId}`) : undefined}
                        right={
                            <Pressable
                                onPress={() => undo(row.hiddenSongId)}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={`Undo hiding ${row.song?.name ?? "this song"}`}
                            >
                                <Text variant="label" color="accent">
                                    Undo
                                </Text>
                            </Pressable>
                        }
                    />
                ))}
            </ScrollView>
        </Screen>
    );
}

function describeHide(row: HiddenDuplicate): string {
    if (row.report.kind === "differentVersion") {
        return "Different version";
    }
    const status = row.report.status === "pending" ? "Waiting for a curator" : "Kept hidden by a curator";
    return row.otherSong ? `Duplicate of “${row.otherSong.name}” · ${status}` : `Duplicate · ${status}`;
}
