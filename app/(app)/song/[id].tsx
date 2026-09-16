import React, { useEffect, useState } from "react";
import { Alert, ImageURISource, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artist, Song, Tag, UpdateSongMetadataPayload } from "@/app/services/db/models";
import { SongDetails } from "@/app/services/db/types";
import { TagType } from "@/app/services/db/schema";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools";
import { computeTapBpm, nextTaps } from "@/app/tools/tapTempo";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { Downloader } from "@/app/services/downloader/Downloader";
import { MediaManager } from "@/app/services/media-manager";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import RatingControl from "@/app/components/likes/atoms/RatingControl";
import SongDownloadControl from "@/app/components/downloading/atoms/SongDownloadControl";
import FlagForReplacementControl from "@/app/components/replacement/atoms/FlagForReplacementControl";
import AddToPlaylistSheet from "@/app/components/playlists/AddToPlaylistSheet";
import { AlbumArt, Button, Chip, IconButton, Screen, SectionHeader, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");
type ArtSource = ImageURISource | { uri: string };

// The tag groups a curator can edit, in display order. (Genre/Mood/Theme/TimePeriod/Language.)
const EDITABLE_TAG_SECTIONS: { type: TagType; title: string }[] = [
    { type: TagType.Genre, title: "Genres" },
    { type: TagType.Mood, title: "Mood" },
    { type: TagType.Theme, title: "Themes" },
    { type: TagType.TimePeriod, title: "Released" },
    { type: TagType.Language, title: "Language" },
];

export default function SongScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const { id: songId } = useLocalSearchParams<{ id: string }>();
    const db = useDb();
    const userId = useCurrentUser();
    const [details, setDetails] = useState<SongDetails | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [art, setArt] = useState<ArtSource>(defaultArt);
    const [showPlaylistSheet, setShowPlaylistSheet] = useState(false);
    const [isCurator, setIsCurator] = useState(false);

    // Edit mode (curator-only). Drafts are seeded from the loaded song when editing starts.
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editName, setEditName] = useState("");
    const [editBpm, setEditBpm] = useState("");
    const [editEnergy, setEditEnergy] = useState("");
    const [editArtists, setEditArtists] = useState<string[]>([]);
    const [editTags, setEditTags] = useState<{ name: string; type: TagType }[]>([]);
    const [tagDrafts, setTagDrafts] = useState<Record<number, string>>({});
    const [bpmTaps, setBpmTaps] = useState<number[]>([]);

    async function refresh() {
        if (songId == undefined) {
            return;
        }
        const fetched = await DbQueries.fetchSongDetails(db, songId);
        const songTags = await DbQueries.getTagsFromSong(db, songId);
        setDetails(fetched);
        setTags(songTags);
        setArt(await resolveArt(fetched.song));
    }

    useEffect(() => {
        if (songId == undefined) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const fetched = await DbQueries.fetchSongDetails(db, songId);
                const songTags = await DbQueries.getTagsFromSong(db, songId);
                const user = await DbQueries.getUser(db, userId);
                if (cancelled) {
                    return;
                }
                setDetails(fetched);
                setTags(songTags);
                setIsCurator(user?.isCurator ?? false);
                setArt(await resolveArt(fetched.song));
            } catch {
                // Song not found locally — leave the empty state.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [songId, userId]);

    const tagNames = (type: TagType) => tags.filter((t) => t.type === type).map((t) => t.name);
    const genres = tagNames(TagType.Genre);
    const moods = tagNames(TagType.Mood);
    const themes = tagNames(TagType.Theme);
    const eras = tagNames(TagType.TimePeriod);
    const languages = tagNames(TagType.Language);

    const goToArtist = (artist: Artist) =>
        router.push({ pathname: "/artist/[id]", params: { id: artist.artistId } });

    function startEditing() {
        if (details == null) {
            return;
        }
        setEditName(details.song.name);
        setEditBpm(details.song.bpm != null ? String(details.song.bpm) : "");
        setEditEnergy(details.song.energy != null ? String(details.song.energy) : "");
        setEditArtists(details.artists.map((a) => a.name));
        setEditTags(tags.map((t) => ({ name: t.name, type: t.type })));
        setTagDrafts({});
        setBpmTaps([]);
        setEditing(true);
    }

    // Tap-tempo: each tap recomputes the BPM from the recent taps and fills the field. A pause restarts it.
    function handleBpmTap() {
        setBpmTaps((prev) => {
            const taps = nextTaps(prev, Date.now());
            const bpm = computeTapBpm(taps);
            if (bpm != null) {
                setEditBpm(String(bpm));
            }
            return taps;
        });
    }

    function cancelEditing() {
        setEditing(false);
    }

    async function saveEditing() {
        if (songId == undefined) {
            return;
        }

        const name = editName.trim();
        if (name.length === 0) {
            Alert.alert("Name required", "The song must have a name.");
            return;
        }

        let bpm: number | null = null;
        if (editBpm.trim().length > 0) {
            const parsed = Number(editBpm);
            if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
                Alert.alert("Invalid BPM", "BPM must be a whole number between 1 and 1000.");
                return;
            }
            bpm = parsed;
        }

        let energy: number | null = null;
        if (editEnergy.trim().length > 0) {
            const parsed = Number(editEnergy);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
                Alert.alert("Invalid energy", "Energy must be a whole number between 1 and 10.");
                return;
            }
            energy = parsed;
        }

        const artists = editArtists.map((a) => a.trim()).filter((a) => a.length > 0);
        const cleanedTags = editTags
            .map((t) => ({ name: t.name.trim(), type: t.type }))
            .filter((t) => t.name.length > 0);

        const payload: UpdateSongMetadataPayload = { name, bpm, energy, artists, tags: cleanedTags };

        setSaving(true);
        try {
            // 1) Apply locally so the screen reflects the edit immediately.
            await DbQueries.applySongMetadataEdit(db, songId, payload);
            // 2) Queue the edit for the server (offline-tolerant outbox; SyncManager pushes it, latest wins).
            await DbQueries.addRequests(db, [{
                requestId: generateId(),
                timeRequested: new Date(Date.now()),
                requestType: RequestType.UpdateSongMetadata,
                userId,
                songId,
                payload,
            }]);
            await refresh();
            setEditing(false);
        } catch (e) {
            console.log(e);
            Alert.alert("Couldn't save", "Something went wrong applying the edit.");
        } finally {
            setSaving(false);
        }
    }

    const addArtist = () => setEditArtists((prev) => [...prev, ""]);
    const setArtistAt = (index: number, value: string) =>
        setEditArtists((prev) => prev.map((a, i) => (i === index ? value : a)));
    const removeArtistAt = (index: number) =>
        setEditArtists((prev) => prev.filter((_, i) => i !== index));

    const removeTag = (name: string, type: TagType) =>
        setEditTags((prev) => prev.filter((t) => !(t.name === name && t.type === type)));
    const addTag = (type: TagType) => {
        const draft = (tagDrafts[type] ?? "").trim();
        if (draft.length === 0) {
            return;
        }
        setEditTags((prev) =>
            prev.some((t) => t.name === draft && t.type === type) ? prev : [...prev, { name: draft, type }]);
        setTagDrafts((prev) => ({ ...prev, [type]: "" }));
    };

    const header = (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.md }}>
            <IconButton name="chevron-down" size={26} color={theme.color.textMuted} onPress={() => router.back()} accessibilityLabel="Close" />
            <Text variant="micro" color="textMuted">
                {editing ? "Edit song" : "Song info"}
            </Text>
            {/* Curator pencil toggles edit mode; otherwise keep the header balanced with a spacer. */}
            {isCurator && !editing ? (
                <IconButton name="pencil" size={20} color={theme.color.textMuted} onPress={startEditing} accessibilityLabel="Edit song" />
            ) : (
                <View style={{ width: 40 }} />
            )}
        </View>
    );

    if (details == null) {
        return (
            <Screen>
                {header}
                <View style={{ flex: 1 }} />
            </Screen>
        );
    }

    const artSize = Math.min(width * 0.78, 320);

    const facts: { label: string; value: string }[] = [
        { label: "Released", value: eras.join(", ") || "—" },
        { label: "Language", value: languages.join(", ") || "—" },
        { label: "BPM", value: details.song.bpm != null ? String(details.song.bpm) : "—" },
        { label: "Energy", value: details.song.energy != null ? `${details.song.energy}/10` : "—" },
        { label: "Lyrics", value: details.song.syncedLyrics ? "Synced" : details.song.plainLyrics ? "Plain" : "None" },
    ];

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight + insets.bottom }}>
                {header}
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: theme.space.xl }}>
                    <View style={{ alignItems: "center", marginTop: theme.space.md }}>
                        <AlbumArt source={art} size={artSize} radius={theme.radius.lg} elevated />
                    </View>

                    {editing ? (
                        <EditForm
                            name={editName}
                            onName={setEditName}
                            bpm={editBpm}
                            onBpm={setEditBpm}
                            onBpmTap={handleBpmTap}
                            tapCount={bpmTaps.length}
                            energy={editEnergy}
                            onEnergy={setEditEnergy}
                            artists={editArtists}
                            onAddArtist={addArtist}
                            onArtistAt={setArtistAt}
                            onRemoveArtistAt={removeArtistAt}
                            tags={editTags}
                            tagDrafts={tagDrafts}
                            onTagDraft={(type, value) => setTagDrafts((prev) => ({ ...prev, [type]: value }))}
                            onAddTag={addTag}
                            onRemoveTag={removeTag}
                            saving={saving}
                            onSave={saveEditing}
                            onCancel={cancelEditing}
                        />
                    ) : (
                        <>
                            {/* Title + inline, tappable artists (Spotify-style — no "Artists" label). */}
                            <Text variant="title" numberOfLines={2} style={{ marginTop: theme.space.lg }}>
                                {details.song.name}
                            </Text>
                            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: theme.space.xs }}>
                                {details.artists.length > 0 ? (
                                    details.artists.map((a, i) => (
                                        <React.Fragment key={a.artistId}>
                                            {i > 0 ? (
                                                <Text variant="body" color="textFaint">
                                                    {"  •  "}
                                                </Text>
                                            ) : null}
                                            <Pressable onPress={() => goToArtist(a)}>
                                                <Text variant="body" color="textMuted">
                                                    {a.name}
                                                </Text>
                                            </Pressable>
                                        </React.Fragment>
                                    ))
                                ) : (
                                    <Text variant="body" color="textFaint">
                                        Unknown artist
                                    </Text>
                                )}
                            </View>

                            {/* Action bar: like · dislike · download on the left, prominent Play on the right. */}
                            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.lg }}>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.lg }}>
                                    <RatingControl songId={details.song.songId} />
                                    <SongDownloadControl song={details.song} />
                                    <IconButton
                                        name="add-circle-outline"
                                        size={24}
                                        color={theme.color.textMuted}
                                        onPress={() => setShowPlaylistSheet(true)}
                                        accessibilityLabel="Add to playlist"
                                    />
                                    {details.song.exploratory ? (
                                        // Keep = retain this audition song with cheap (weak-model) tags,
                                        // without the like signal. Disappears once kept/promoted.
                                        <IconButton
                                            name="bookmark-outline"
                                            size={24}
                                            color={theme.color.textMuted}
                                            onPress={async () => {
                                                await MediaManager.keepSong(details.song.songId);
                                                setDetails(prev => prev
                                                    ? { ...prev, song: { ...prev.song, exploratory: false, tagsStale: true } }
                                                    : prev);
                                            }}
                                            accessibilityLabel="Keep song"
                                        />
                                    ) : null}
                                    <FlagForReplacementControl songId={details.song.songId} />
                                </View>
                                <IconButton
                                    name="play"
                                    size={26}
                                    filled
                                    round={58}
                                    onPress={() => MediaManager.playSpecificSong(details.song.songId)}
                                    accessibilityLabel="Play"
                                />
                            </View>

                            {genres.length > 0 ? (
                                <>
                                    <SectionHeader title="Genres" />
                                    <ChipRow items={genres} />
                                </>
                            ) : null}

                            {moods.length > 0 ? (
                                <>
                                    <SectionHeader title="Mood" />
                                    <ChipRow items={moods} />
                                </>
                            ) : null}

                            {themes.length > 0 ? (
                                <>
                                    <SectionHeader title="Themes" />
                                    <ChipRow items={themes} />
                                </>
                            ) : null}

                            <SectionHeader title="Details" />
                            <View>
                                {facts.map((f) => (
                                    <View key={f.label} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: theme.space.xs }}>
                                        <Text variant="body" color="textMuted">
                                            {f.label}
                                        </Text>
                                        <Text variant="body" numberOfLines={1} style={{ flexShrink: 1, textAlign: "right", marginLeft: theme.space.md }}>
                                            {f.value}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        </>
                    )}
                </ScrollView>
            </View>
            {/* Kept visible in edit mode too, so a curator can play the track and tap the tempo along to it. */}
            <PlayerBar floating />
            <AddToPlaylistSheet songId={details.song.songId} visible={showPlaylistSheet} onClose={() => setShowPlaylistSheet(false)} />
        </Screen>
    );
}

interface EditFormProps {
    name: string;
    onName: (v: string) => void;
    bpm: string;
    onBpm: (v: string) => void;
    onBpmTap: () => void;
    tapCount: number;
    energy: string;
    onEnergy: (v: string) => void;
    artists: string[];
    onAddArtist: () => void;
    onArtistAt: (index: number, value: string) => void;
    onRemoveArtistAt: (index: number) => void;
    tags: { name: string; type: TagType }[];
    tagDrafts: Record<number, string>;
    onTagDraft: (type: TagType, value: string) => void;
    onAddTag: (type: TagType) => void;
    onRemoveTag: (name: string, type: TagType) => void;
    saving: boolean;
    onSave: () => void;
    onCancel: () => void;
}

function EditForm(props: EditFormProps) {
    const theme = useTheme();

    return (
        <View style={{ marginTop: theme.space.lg, gap: theme.space.md }}>
            <Field label="Name">
                <TextField value={props.name} onChangeText={props.onName} placeholder="Song name" />
            </Field>

            <View style={{ flexDirection: "row", gap: theme.space.md }}>
                <View style={{ flex: 1 }}>
                    <Field label="BPM">
                        <TextField value={props.bpm} onChangeText={props.onBpm} placeholder="—" keyboardType="number-pad" />
                        <Pressable
                            onPress={props.onBpmTap}
                            accessibilityLabel="Tap tempo"
                            style={{
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: theme.space.xs,
                                marginTop: theme.space.xs,
                                paddingVertical: theme.space.sm,
                                borderRadius: theme.radius.md,
                                borderWidth: 1,
                                borderColor: theme.color.line,
                                backgroundColor: theme.color.surface,
                            }}
                        >
                            <Ionicons name="hand-left-outline" size={16} color={theme.color.textMuted} />
                            <Text variant="label" color="textMuted">
                                {props.tapCount > 0 ? `Tap to the beat (${props.tapCount})` : "Tap to the beat"}
                            </Text>
                        </Pressable>
                    </Field>
                </View>
                <View style={{ flex: 1 }}>
                    <Field label="Energy (1-10)">
                        <TextField value={props.energy} onChangeText={props.onEnergy} placeholder="—" keyboardType="number-pad" />
                    </Field>
                </View>
            </View>

            <Field label="Artists">
                <View style={{ gap: theme.space.sm }}>
                    {props.artists.map((artist, i) => (
                        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm }}>
                            <View style={{ flex: 1 }}>
                                <TextField value={artist} onChangeText={(v) => props.onArtistAt(i, v)} placeholder="Artist name" />
                            </View>
                            <IconButton name="close" size={20} color={theme.color.textMuted} onPress={() => props.onRemoveArtistAt(i)} accessibilityLabel="Remove artist" />
                        </View>
                    ))}
                    <Button label="Add artist" variant="ghost" icon="add" onPress={props.onAddArtist} />
                </View>
            </Field>

            {EDITABLE_TAG_SECTIONS.map((section) => {
                const sectionTags = props.tags.filter((t) => t.type === section.type);
                return (
                    <Field key={section.type} label={section.title}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm }}>
                            {sectionTags.map((t) => (
                                <Pressable
                                    key={t.name}
                                    onPress={() => props.onRemoveTag(t.name, t.type)}
                                    style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: 4,
                                        backgroundColor: theme.color.surface,
                                        borderWidth: 1,
                                        borderColor: theme.color.line,
                                        borderRadius: theme.radius.md,
                                        paddingVertical: 4,
                                        paddingHorizontal: theme.space.sm,
                                    }}
                                >
                                    <Text variant="label" color="textMuted">{t.name}</Text>
                                    <Ionicons name="close" size={14} color={theme.color.textFaint} />
                                </Pressable>
                            ))}
                        </View>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.sm }}>
                            <View style={{ flex: 1 }}>
                                <TextField
                                    value={props.tagDrafts[section.type] ?? ""}
                                    onChangeText={(v) => props.onTagDraft(section.type, v)}
                                    placeholder={`Add ${section.title.toLowerCase()}`}
                                    onSubmitEditing={() => props.onAddTag(section.type)}
                                />
                            </View>
                            <IconButton name="add" size={22} color={theme.color.textMuted} onPress={() => props.onAddTag(section.type)} accessibilityLabel={`Add ${section.title}`} />
                        </View>
                    </Field>
                );
            })}

            <View style={{ flexDirection: "row", gap: theme.space.md, marginTop: theme.space.md }}>
                <View style={{ flex: 1 }}>
                    <Button label="Cancel" variant="ghost" onPress={props.onCancel} disabled={props.saving} full />
                </View>
                <View style={{ flex: 1 }}>
                    <Button label={props.saving ? "Saving…" : "Save"} onPress={props.onSave} disabled={props.saving} full />
                </View>
            </View>
        </View>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    const theme = useTheme();
    return (
        <View style={{ gap: theme.space.xs }}>
            <Text variant="micro" color="textMuted">
                {label}
            </Text>
            {children}
        </View>
    );
}

function ChipRow({ items }: { items: string[] }) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm }}>
            {items.map((label) => (
                <Chip key={label} label={label} />
            ))}
        </View>
    );
}

async function resolveArt(song: Song): Promise<ArtSource> {
    const localUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localUri)) {
        return { uri: localUri };
    }
    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}
