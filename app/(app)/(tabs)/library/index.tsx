import React, { useCallback } from "react";
import { Alert, ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { GenreJam, Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { jamSummary, launchJam } from "@/app/services/genre-jam";
import { AlbumArt, Divider, IconButton, ListRow, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { LikeStatus } from "@/app/enums";
import { auditionProgress, deriveAuditionRowState } from "@/app/tools/audition";
import { useDownloadStatusView } from "@/app/components/downloading/useDownloadStatusView";
import { describeDownloadsRow } from "@/app/tools/downloadStatus";

export default function LibraryScreen() {
    const [playlists, setPlaylists] = React.useState<Playlist[]>([]);
    const [jams, setJams] = React.useState<GenreJam[]>([]);
    const [isCurator, setIsCurator] = React.useState(false);
    const [cohortProgress, setCohortProgress] = React.useState<Record<string, { evaluated: number; total: number }>>({});
    const userId = useCurrentUser();
    const db = useDb();
    const theme = useTheme();
    // The Downloads row doubles as the ambient "is anything downloading?" indicator, so it tracks the
    // Downloader live instead of saying "Saved offline" forever.
    const { status: downloadStatus, currentName: downloadingName } = useDownloadStatusView();
    const [downloadedCount, setDownloadedCount] = React.useState(0);
    const loadDownloadedCount = useCallback(async () => {
        setDownloadedCount(await DbQueries.countDownloadedSongs(db));
    }, [db]);
    React.useEffect(() => {
        loadDownloadedCount();
    }, [loadDownloadedCount, downloadStatus.completedCount]);

    const loadPlaylists = useCallback(async () => {
        const loaded = await DbQueries.getPlaylists(db, userId);
        setPlaylists(loaded);

        // Progress bubbles for the audition cohorts, derived from synced data (lastPlayed / likeStatus /
        // exploratory) — "how many songs have had their chance?" A full bubble marks the cohort done and
        // safe to delete.
        const progress: Record<string, { evaluated: number; total: number }> = {};
        for (const playlist of loaded.filter(p => p.isExploratory)) {
            const rows = await DbQueries.getPlaylistSongStates(db, userId, playlist.playlistId);
            progress[playlist.playlistId] = auditionProgress(rows.map(r =>
                deriveAuditionRowState(r.exploratory, (r.likeStatus ?? LikeStatus.Neutral) as LikeStatus, r.lastPlayed)));
        }
        setCohortProgress(progress);
    }, [db, userId]);

    const loadJams = useCallback(async () => {
        setJams(await DbQueries.getGenreJams(db));
    }, [db]);

    const loadRole = useCallback(async () => {
        const user = await DbQueries.getUser(db, userId);
        setIsCurator(user?.isCurator ?? false);
    }, [db, userId]);

    // Reload playlists + jams on focus so a newly created/deleted one shows up immediately.
    useFocusEffect(
        useCallback(() => {
            loadPlaylists();
            loadJams();
            loadRole();
            loadDownloadedCount();
        }, [loadPlaylists, loadJams, loadRole, loadDownloadedCount]),
    );

    const confirmDelete = (jam: GenreJam) => {
        Alert.alert("Delete jam", `Delete "${jam.name}"?`, [
            { text: "Cancel", style: "cancel" },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    await DbQueries.deleteGenreJam(db, jam.genreJamId);
                    loadJams();
                },
            },
        ]);
    };

    const chevron = <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />;
    const jamSwatch = (
        <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.accentWash, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="play" size={20} color={theme.color.accent} />
        </View>
    );

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.sm }}>
                    Library
                </Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                    <ListRow
                        title="Downloads"
                        subtitle={describeDownloadsRow(downloadStatus, downloadedCount, downloadingName)}
                        onPress={() => router.push("/library/downloads")}
                        left={
                            <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: downloadStatus.phase === "downloading" ? theme.color.accentWash : theme.color.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                                <Ionicons
                                    name={downloadStatus.phase === "paused" ? "pause-circle-outline" : "download-outline"}
                                    size={22}
                                    color={downloadStatus.phase === "downloading" ? theme.color.accent : theme.color.textMuted}
                                />
                            </View>
                        }
                        right={chevron}
                    />
                    <ListRow
                        title="Artists"
                        subtitle="Browse by artist"
                        onPress={() => router.push("/library/artists")}
                        left={
                            <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                                <Ionicons name="people-outline" size={22} color={theme.color.textMuted} />
                            </View>
                        }
                        right={chevron}
                    />
                    {isCurator && (
                        <ListRow
                            title="Curator tools"
                            subtitle="Upgrade library tags"
                            onPress={() => router.push("/curator")}
                            left={
                                <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.accentWash, alignItems: "center", justifyContent: "center" }}>
                                    <Ionicons name="sparkles-outline" size={22} color={theme.color.accent} />
                                </View>
                            }
                            right={chevron}
                        />
                    )}

                    <Divider style={{ marginVertical: theme.space.sm }} />
                    <SectionHeader title="Jams" actionLabel="New" onAction={() => router.push("/genre-jam")} />
                    {jams.length === 0 ? (
                        <Text variant="body" color="textFaint">
                            No jams yet — tap New to make one.
                        </Text>
                    ) : (
                        jams.map((jam) => (
                            <ListRow
                                key={jam.genreJamId}
                                title={jam.name}
                                subtitle={jamSummary(jam)}
                                left={jamSwatch}
                                right={
                                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.xs }}>
                                        <IconButton
                                            name="create-outline"
                                            size={20}
                                            color={theme.color.textFaint}
                                            onPress={() => router.push({ pathname: "/genre-jam", params: { id: jam.genreJamId } })}
                                            accessibilityLabel="Edit jam"
                                        />
                                        <IconButton name="trash-outline" size={20} color={theme.color.textFaint} onPress={() => confirmDelete(jam)} accessibilityLabel="Delete jam" />
                                    </View>
                                }
                                onPress={() => launchJam(jam)}
                            />
                        ))
                    )}

                    {(() => {
                        // Audition cohorts get their own section, newest first — the weekly triage inbox —
                        // each with an evaluated/total bubble that fills when the cohort is done (and thus
                        // safe to delete). Everything else stays a plain playlist row.
                        const auditionPlaylists = playlists
                            .filter(p => p.isExploratory)
                            .sort((a, b) => b.version.getTime() - a.version.getTime());
                        const normalPlaylists = playlists.filter(p => !p.isExploratory);
                        return (
                            <>
                                {auditionPlaylists.length > 0 ? (
                                    <>
                                        <Divider style={{ marginVertical: theme.space.sm }} />
                                        <SectionHeader title="Audition" />
                                        {auditionPlaylists.map((p) => {
                                            const progress = cohortProgress[p.playlistId];
                                            const complete = progress != null && progress.total > 0 && progress.evaluated === progress.total;
                                            return (
                                                <ListRow
                                                    key={p.playlistId}
                                                    title={p.name}
                                                    subtitle={complete ? "Done — safe to delete" : "Audition playlist"}
                                                    left={<AlbumArt size={48} radius={theme.radius.md} />}
                                                    right={
                                                        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm }}>
                                                            {progress != null ? (
                                                                <View
                                                                    style={{
                                                                        paddingVertical: 2,
                                                                        paddingHorizontal: theme.space.sm,
                                                                        borderRadius: theme.radius.pill,
                                                                        backgroundColor: complete ? theme.color.accent : theme.color.neutralFill,
                                                                    }}
                                                                >
                                                                    <Text variant="caption" color={complete ? "onAccent" : "textMuted"}>
                                                                        {progress.evaluated}/{progress.total}
                                                                    </Text>
                                                                </View>
                                                            ) : null}
                                                            {chevron}
                                                        </View>
                                                    }
                                                    onPress={() => router.push({ pathname: "/library/playlist/[id]", params: { id: p.playlistId } })}
                                                />
                                            );
                                        })}
                                    </>
                                ) : null}
                                <Divider style={{ marginVertical: theme.space.sm }} />
                                <SectionHeader title="Playlists" />
                                {normalPlaylists.length === 0 ? (
                                    <Text variant="body" color="textFaint">
                                        No playlists yet.
                                    </Text>
                                ) : (
                                    normalPlaylists.map((p) => (
                                        <ListRow
                                            key={p.playlistId}
                                            title={p.name}
                                            subtitle="Playlist"
                                            left={<AlbumArt size={48} radius={theme.radius.md} />}
                                            right={chevron}
                                            onPress={() => router.push({ pathname: "/library/playlist/[id]", params: { id: p.playlistId } })}
                                        />
                                    ))
                                )}
                            </>
                        );
                    })()}
                </ScrollView>
            </View>
            <PlayerBar />
        </Screen>
    );
}
