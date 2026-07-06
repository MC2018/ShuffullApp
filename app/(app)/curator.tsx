import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Button, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { useApi } from "@/app/services/api/ApiProvider";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";

// Server caps a single retag-stale request at 200 and each item is an AI call, so a small batch keeps each
// round quick and gives responsive progress. The screen loops rounds until nothing stale remains.
const BATCH_SIZE = 25;

/// <summary>
// Curator-only tools. Right now: "Upgrade library tags" — repeatedly re-tags songs whose metadata came from a
// weaker model than the current strong one, in bounded rounds, until none remain. Songs re-tagged this way get
// their Version bumped, so they refresh on the app's next background sync.
export default function CuratorScreen() {
    const theme = useTheme();
    const api = useApi();
    const db = useDb();
    const userId = useCurrentUser();

    const [isCurator, setIsCurator] = useState(false);
    const [checkedRole, setCheckedRole] = useState(false);

    const [running, setRunning] = useState(false);
    const [enriched, setEnriched] = useState(0);
    const [failed, setFailed] = useState(0);
    const [remaining, setRemaining] = useState<number | null>(null);
    const [strongModel, setStrongModel] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const stopRef = useRef(false);

    useEffect(() => {
        (async () => {
            const user = await DbQueries.getUser(db, userId);
            setIsCurator(user?.isCurator ?? false);
            setCheckedRole(true);
        })();
    }, [db, userId]);

    const runUpgrade = useCallback(async () => {
        stopRef.current = false;
        setRunning(true);
        setDone(false);
        setError(null);
        setEnriched(0);
        setFailed(0);
        setRemaining(null);

        let totalEnriched = 0;
        let totalFailed = 0;
        try {
            while (!stopRef.current) {
                const r = await api.songRetagStale(BATCH_SIZE);
                totalEnriched += r.enriched;
                totalFailed += r.failed;
                setEnriched(totalEnriched);
                setFailed(totalFailed);
                setRemaining(r.remaining);
                setStrongModel(r.strongModel);
                // Stop when nothing remains, or when a round made no progress (all remaining errored, or no
                // strong model is registered) — otherwise we'd loop forever.
                if (r.remaining <= 0 || r.enriched === 0) {
                    break;
                }
            }
            setDone(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setRunning(false);
        }
    }, [api]);

    const stop = useCallback(() => {
        stopRef.current = true;
    }, []);

    const gap = theme.space.md;

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.md }}>
                <Ionicons name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} />
                <Text variant="screenTitle">Curator tools</Text>
            </View>

            {checkedRole && !isCurator ? (
                <Text variant="body" color="textMuted">This area is for curators only.</Text>
            ) : (
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap }}>
                    <Text variant="title">Upgrade library tags</Text>
                    <Text variant="body" color="textMuted">
                        Re-tags songs whose genres/mood/era came from a weaker model than the current strong model,
                        reusing each song&apos;s stored audio analysis — no re-download. Runs in rounds of {BATCH_SIZE}.
                    </Text>

                    {running ? (
                        <Button label="Stop" variant="danger" icon="stop" onPress={stop} full />
                    ) : (
                        <Button label={done ? "Run again" : "Start upgrade"} variant="primary" icon="sparkles" onPress={runUpgrade} full />
                    )}

                    {(running || done || remaining !== null) && (
                        <View style={{ gap: theme.space.xs, backgroundColor: theme.color.surfaceAlt, borderRadius: theme.radius.md, padding: theme.space.md }}>
                            <Text variant="label" color="textMuted">
                                {running ? "Upgrading…" : done ? "Finished" : "Progress"}
                            </Text>
                            <Text variant="body">Re-tagged: {enriched}</Text>
                            {remaining !== null && <Text variant="body">Remaining: {remaining}</Text>}
                            {failed > 0 && <Text variant="body" color="textMuted">Failed: {failed}</Text>}
                            {strongModel && <Text variant="caption" color="textFaint">Target model: {strongModel}</Text>}
                        </View>
                    )}

                    {done && (
                        <Text variant="caption" color="textFaint">
                            Upgraded songs refresh on the next sync.
                        </Text>
                    )}
                    {error && (
                        <Text variant="body" color="accent">{error}</Text>
                    )}
                </ScrollView>
            )}
        </Screen>
    );
}
