import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Card, IconButton, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { useApi } from "@/app/services/api/ApiProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { loadRecap, RecapLoad } from "@/app/services/recap/recapLoader";
import { sampleRecap } from "@/app/services/recap/sampleRecap";
import { RECAP_SECTIONS } from "@/app/components/recap/sections";
import { Recap } from "@/app/services/api/models";
import { deviceTimeZone, formatDay, recapYear } from "@/app/tools/recap";

// The December recap (ShuffullApp#116), as one scrolling page of cards like Home and Settings. The sections don't know
// they're on a page: each is a component in RECAP_SECTIONS, so a story-style container could replace this one alone.
//
// Reached from Home's December button. Development builds also open it from Settings, with `?sample=1` for made-up
// data, since the button hides outside December.
export default function RecapScreen() {
    const theme = useTheme();
    const api = useApi();
    const userId = useCurrentUser();
    const params = useLocalSearchParams<{ year?: string; sample?: string }>();
    const year = Number(params.year) || recapYear();
    const sample = __DEV__ && params.sample === "1";
    const [load, setLoad] = useState<RecapLoad | null>(null);

    const fetchRecap = useCallback(async () => {
        setLoad(null);
        setLoad(sample
            ? { status: "ready", recap: sampleRecap(), fetchedAt: Date.now(), saved: false }
            : await loadRecap(api, userId, year, deviceTimeZone()));
    }, [api, userId, year, sample]);

    useEffect(() => {
        fetchRecap();
    }, [fetchRecap]);

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.sm }}>
                <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="micro" color="accentTint">
                        {sample ? "Sample data" : "Recap"}
                    </Text>
                    <Text variant="screenTitle">Your {year}</Text>
                </View>
            </View>

            {load == null ? (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                    <ActivityIndicator color={theme.color.accent} />
                </View>
            ) : load.status === "ready" ? (
                <RecapPage recap={load.recap} savedAt={load.saved ? load.fetchedAt : null} />
            ) : (
                <RecapUnavailable load={load} onRetry={fetchRecap} />
            )}
        </Screen>
    );
}

function RecapPage({ recap, savedAt }: { recap: Recap; savedAt: number | null }) {
    const theme = useTheme();
    return (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: theme.space.xxxl }}>
            {savedAt != null ? (
                <Text variant="caption" color="textFaint" style={{ marginBottom: theme.space.sm }}>
                    Offline: showing the copy saved on {formatDay(new Date(savedAt))}.
                </Text>
            ) : null}
            {RECAP_SECTIONS.map(({ key, title, Component }) => (
                <View key={key}>
                    <SectionHeader title={title} style={key === RECAP_SECTIONS[0].key ? { marginTop: theme.space.sm } : undefined} />
                    <Card>
                        <Component recap={recap} />
                    </Card>
                </View>
            ))}
        </ScrollView>
    );
}

function RecapUnavailable({ load, onRetry }: { load: Exclude<RecapLoad, { status: "ready" }>; onRetry: () => void }) {
    const theme = useTheme();
    const message =
        load.status === "unavailable"
            ? "Your recap isn't ready on the server yet. Check back later."
            : load.status === "offline"
                ? "Your recap needs a connection the first time. Connect and try again."
                : `Couldn't load your recap (error ${load.httpStatus}). Try again in a bit.`;
    return (
        <Card style={{ marginTop: theme.space.md, gap: theme.space.md }}>
            <Text variant="body" color="textMuted">
                {message}
            </Text>
            {load.status === "unavailable" ? null : <Button label="Try again" onPress={onRetry} />}
        </Card>
    );
}
