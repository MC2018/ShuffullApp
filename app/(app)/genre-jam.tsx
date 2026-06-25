import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { generateId } from "@/app/tools";
import { TagType } from "@/app/services/db/schema";
import { GenreJam } from "@/app/services/db/models";
import { WhitelistSetting } from "@/app/services/db/types";
import { launchJam } from "@/app/services/genre-jam";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { Button, Card, Chip, Divider, IconButton, Screen, SectionHeader, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

type FilterStatus = "none" | "include" | "exclude";
type Category = "genres" | "artists" | "timePeriods" | "languages" | "playlists";
interface FilterItem {
    id: string;
    name: string;
    status: FilterStatus;
}

const CATEGORIES: { key: Category; label: string; jamKey: keyof WhitelistSetting }[] = [
    { key: "genres", label: "Genres", jamKey: "genreIds" },
    { key: "artists", label: "Artists", jamKey: "artistIds" },
    { key: "timePeriods", label: "Decades", jamKey: "timePeriodIds" },
    { key: "languages", label: "Languages", jamKey: "languageIds" },
    { key: "playlists", label: "Playlists", jamKey: "playlistIds" },
];

function nextStatus(s: FilterStatus): FilterStatus {
    return s === "none" ? "include" : s === "include" ? "exclude" : "none";
}

function emptyWhitelist(): WhitelistSetting {
    return { artistIds: [], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] };
}

// The reworked Genre Jam builder/editor. An empty jam already means "whole library, minus dislikes, leaning to
// loved". Filters narrow it: Mood (chips), Energy (min, BPM-independent AI score), and per-category
// Include/Exclude. Jams are nameable + savable. Passing ?id loads an existing jam for editing instead.
export default function GenreJamEditor() {
    const theme = useTheme();
    const db = useDb();
    const userId = useCurrentUser();
    const params = useLocalSearchParams<{ id?: string }>();
    const editingId = typeof params.id === "string" && params.id.length > 0 ? params.id : null;

    const [items, setItems] = useState<Record<Category, FilterItem[]>>({
        genres: [],
        artists: [],
        timePeriods: [],
        languages: [],
        playlists: [],
    });
    const [moods, setMoods] = useState<FilterItem[]>([]);
    const [themes, setThemes] = useState<FilterItem[]>([]);
    const [expanded, setExpanded] = useState<Record<Category, boolean>>({
        genres: false,
        artists: false,
        timePeriods: false,
        languages: false,
        playlists: false,
    });
    const [energyEnabled, setEnergyEnabled] = useState(false);
    const [energyStart, setEnergyStart] = useState(4); // band start; band = [energyStart, energyStart + 2]
    const [jamName, setJamName] = useState("");
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        (async () => {
            const playlists = await DbQueries.getPlaylists(db, userId);
            const artists = await DbQueries.getArtists(db);
            const tags = await DbQueries.getTags(db);
            const tagItems = (type: TagType) =>
                tags.filter((t) => t.type === type).map((t) => ({ id: t.tagId, name: t.name }));

            // When editing, overlay the saved jam's include/exclude (and mood) selections onto the catalogs so
            // every chip reflects how the jam was last saved.
            const editing = editingId ? await DbQueries.getGenreJam(db, editingId) : undefined;
            const toItems = (arr: { id: string; name: string }[], jamKey: keyof WhitelistSetting): FilterItem[] => {
                const inc = new Set(editing?.whitelists?.[jamKey] ?? []);
                const exc = new Set(editing?.blacklists?.[jamKey] ?? []);
                return arr.map((x) => ({
                    id: x.id,
                    name: x.name,
                    status: inc.has(x.id) ? "include" : exc.has(x.id) ? "exclude" : "none",
                }));
            };

            setItems({
                genres: toItems(tagItems(TagType.Genre), "genreIds"),
                artists: toItems(artists.map((a) => ({ id: a.artistId, name: a.name })), "artistIds"),
                timePeriods: toItems(tagItems(TagType.TimePeriod), "timePeriodIds"),
                languages: toItems(tagItems(TagType.Language), "languageIds"),
                playlists: toItems(playlists.map((p) => ({ id: p.playlistId, name: p.name })), "playlistIds"),
            });

            const moodIncludes = new Set(editing?.whitelists?.moodIds ?? []);
            setMoods(
                tagItems(TagType.Mood).map((m) => ({
                    ...m,
                    status: moodIncludes.has(m.id) ? "include" : ("none" as FilterStatus),
                })),
            );

            const themeIncludes = new Set(editing?.whitelists?.themeIds ?? []);
            const themeExcludes = new Set(editing?.blacklists?.themeIds ?? []);
            setThemes(
                tagItems(TagType.Theme).map((t) => ({
                    ...t,
                    status: themeIncludes.has(t.id) ? "include" : themeExcludes.has(t.id) ? "exclude" : ("none" as FilterStatus),
                })),
            );

            if (editing) {
                setJamName(editing.name);
                if (editing.energyMin != null) {
                    setEnergyEnabled(true);
                    setEnergyStart(editing.energyMin);
                }
            }
        })();
    }, [userId, editingId]);

    const cycleItem = (cat: Category, id: string) => {
        setItems((prev) => ({
            ...prev,
            [cat]: prev[cat].map((it) => (it.id === id ? { ...it, status: nextStatus(it.status) } : it)),
        }));
    };
    const toggleMood = (id: string) => {
        setMoods((prev) => prev.map((m) => (m.id === id ? { ...m, status: m.status === "include" ? "none" : "include" } : m)));
    };
    // Themes cycle include -> exclude -> none so a theme can be required OR buried (e.g. exclude Christmas).
    const cycleTheme = (id: string) => {
        setThemes((prev) => prev.map((t) => (t.id === id ? { ...t, status: nextStatus(t.status) } : t)));
    };
    const toggleExpanded = (cat: Category) => setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));

    const buildJam = (name: string): GenreJam => {
        const whitelists = emptyWhitelist();
        const blacklists = emptyWhitelist();
        for (const cat of CATEGORIES) {
            for (const it of items[cat.key]) {
                if (it.status === "include") {
                    whitelists[cat.jamKey].push(it.id);
                } else if (it.status === "exclude") {
                    blacklists[cat.jamKey].push(it.id);
                }
            }
        }
        whitelists.moodIds = moods.filter((m) => m.status === "include").map((m) => m.id);
        whitelists.themeIds = themes.filter((t) => t.status === "include").map((t) => t.id);
        blacklists.themeIds = themes.filter((t) => t.status === "exclude").map((t) => t.id);
        return {
            genreJamId: editingId ?? generateId(),
            name,
            whitelists,
            blacklists,
            energyMin: energyEnabled ? energyStart : null,
            energyMax: energyEnabled ? energyStart + 2 : null,
        };
    };

    const handleStart = async () => {
        await launchJam(buildJam(jamName.trim() || "Quick Jam"));
    };

    const handleSave = async () => {
        const name = jamName.trim();
        if (!name) {
            return;
        }
        if (editingId) {
            await DbQueries.updateGenreJam(db, buildJam(name));
            router.back();
            return;
        }
        await DbQueries.addGenreJam(db, buildJam(name));
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
    };

    return (
        <Screen>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: totalPlayerBarHeight + theme.space.xl }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.md }}>
                    <IconButton name="chevron-back" size={24} color={theme.color.textMuted} onPress={() => router.back()} accessibilityLabel="Back" />
                    <Text variant="micro" color="textMuted">
                        Genre Jam
                    </Text>
                    <View style={{ width: 28 }} />
                </View>
                <Text variant="screenTitle" style={{ marginTop: theme.space.sm }}>
                    {editingId ? "Edit Jam" : "New Jam"}
                </Text>

                <Card tint style={{ borderColor: theme.color.accentDeep, marginTop: theme.space.md }}>
                    <Text variant="body" color="textMuted">
                        Plays your whole library — minus songs you've disliked, leaning toward what you love. Add filters below, or just start.
                    </Text>
                    <Button label="Start Jam" icon="play" full onPress={handleStart} style={{ marginTop: theme.space.md }} />
                </Card>

                <SectionHeader title="Mood" />
                {moods.length === 0 ? (
                    <Text variant="caption" color="textFaint">
                        No moods yet — they appear once songs are tagged.
                    </Text>
                ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm }}>
                        {moods.map((m) => (
                            <Chip key={m.id} label={m.name} state={m.status === "include" ? "selected" : "idle"} onPress={() => toggleMood(m.id)} />
                        ))}
                    </View>
                )}

                <SectionHeader title="Themes" />
                {themes.length === 0 ? (
                    <Text variant="caption" color="textFaint">
                        No themes yet — they appear once songs are tagged.
                    </Text>
                ) : (
                    <>
                        <Text variant="caption" color="textFaint" style={{ marginBottom: theme.space.sm }}>
                            Tap once to include, twice to exclude (e.g. bury Christmas).
                        </Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm }}>
                            {themes.map((t) => (
                                <Chip
                                    key={t.id}
                                    label={t.name}
                                    state={t.status === "include" ? "selected" : t.status === "exclude" ? "excluded" : "idle"}
                                    onPress={() => cycleTheme(t.id)}
                                />
                            ))}
                        </View>
                    </>
                )}

                <SectionHeader title="Energy" actionLabel={energyEnabled ? "On" : "Off"} onAction={() => setEnergyEnabled((v) => !v)} />
                {energyEnabled ? (
                    <>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: theme.space.xs }}>
                            <Text variant="caption" color="textFaint">
                                Mellow
                            </Text>
                            <Text variant="caption" color="accent">
                                Energy {energyStart}–{energyStart + 2}
                            </Text>
                            <Text variant="caption" color="textFaint">
                                Driving
                            </Text>
                        </View>
                        <Slider
                            minimumValue={1}
                            maximumValue={8}
                            step={1}
                            value={energyStart}
                            onValueChange={setEnergyStart}
                            minimumTrackTintColor={theme.color.accent}
                            maximumTrackTintColor={theme.color.line}
                            thumbTintColor={theme.color.accent}
                        />
                    </>
                ) : (
                    <Text variant="caption" color="textFaint">
                        Any energy.
                    </Text>
                )}

                <SectionHeader title="Include &amp; exclude" />
                <Text variant="caption" color="textFaint" style={{ marginBottom: theme.space.sm }}>
                    Tap once to include, twice to exclude.
                </Text>
                {CATEGORIES.map((cat) => {
                    const list = items[cat.key];
                    const inc = list.filter((i) => i.status === "include").length;
                    const exc = list.filter((i) => i.status === "exclude").length;
                    const summary = inc || exc ? `${inc} in${exc ? ` · ${exc} out` : ""}` : "Any";
                    return (
                        <View key={cat.key}>
                            <Pressable
                                onPress={() => toggleExpanded(cat.key)}
                                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.space.md }}
                            >
                                <View>
                                    <Text variant="bodyStrong">{cat.label}</Text>
                                    <Text variant="caption" color="textFaint" style={{ marginTop: 2 }}>
                                        {summary}
                                    </Text>
                                </View>
                                <Ionicons name={expanded[cat.key] ? "chevron-up" : "chevron-down"} size={18} color={theme.color.textFaint} />
                            </Pressable>
                            {expanded[cat.key] ? (
                                list.length === 0 ? (
                                    <Text variant="caption" color="textFaint" style={{ paddingBottom: theme.space.sm }}>
                                        None available.
                                    </Text>
                                ) : (
                                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, paddingBottom: theme.space.md }}>
                                        {list.map((it) => (
                                            <Chip
                                                key={it.id}
                                                label={it.name}
                                                state={it.status === "include" ? "selected" : it.status === "exclude" ? "excluded" : "idle"}
                                                onPress={() => cycleItem(cat.key, it.id)}
                                            />
                                        ))}
                                    </View>
                                )
                            ) : null}
                            <Divider />
                        </View>
                    );
                })}

                <SectionHeader title={editingId ? "Update this jam" : "Save this jam"} />
                <TextField placeholder="Jam name (e.g. Late Night)" value={jamName} onChangeText={setJamName} autoCapitalize="words" />
                <Button
                    label={saved ? "Saved ✓" : editingId ? "Save changes" : "Save jam"}
                    variant="ghost"
                    full
                    onPress={handleSave}
                    disabled={!jamName.trim()}
                    style={{ marginTop: theme.space.sm }}
                />
            </ScrollView>
            <PlayerBar />
        </Screen>
    );
}
