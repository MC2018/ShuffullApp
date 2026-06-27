import React, { useEffect, useState } from "react";
import { ImageURISource, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artist, Song, Tag } from "@/app/services/db/models";
import { SongDetails } from "@/app/services/db/types";
import { TagType } from "@/app/services/db/schema";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import { Downloader } from "@/app/services/downloader/Downloader";
import { MediaManager } from "@/app/services/media-manager";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import RatingControl from "@/app/components/likes/atoms/RatingControl";
import SongDownloadControl from "@/app/components/downloading/atoms/SongDownloadControl";
import FlagForReplacementControl from "@/app/components/replacement/atoms/FlagForReplacementControl";
import AddToPlaylistSheet from "@/app/components/playlists/AddToPlaylistSheet";
import { AlbumArt, Chip, IconButton, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");
type ArtSource = ImageURISource | { uri: string };

export default function SongScreen() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const { id: songId } = useLocalSearchParams<{ id: string }>();
    const db = useDb();
    const [details, setDetails] = useState<SongDetails | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [art, setArt] = useState<ArtSource>(defaultArt);
    const [showPlaylistSheet, setShowPlaylistSheet] = useState(false);

    useEffect(() => {
        if (songId == undefined) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const fetched = await DbQueries.fetchSongDetails(db, songId);
                const songTags = await DbQueries.getTagsFromSong(db, songId);
                if (cancelled) {
                    return;
                }
                setDetails(fetched);
                setTags(songTags);
                setArt(await resolveArt(fetched.song));
            } catch {
                // Song not found locally — leave the empty state.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [songId]);

    const tagNames = (type: TagType) => tags.filter((t) => t.type === type).map((t) => t.name);
    const genres = tagNames(TagType.Genre);
    const moods = tagNames(TagType.Mood);
    const themes = tagNames(TagType.Theme);
    const eras = tagNames(TagType.TimePeriod);
    const languages = tagNames(TagType.Language);

    const goToArtist = (artist: Artist) =>
        router.push({ pathname: "/artist/[id]", params: { id: artist.artistId } });

    const header = (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.md }}>
            <IconButton name="chevron-down" size={26} color={theme.color.textMuted} onPress={() => router.back()} accessibilityLabel="Close" />
            <Text variant="micro" color="textMuted">
                Song info
            </Text>
            <View style={{ width: 40 }} />
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
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: theme.space.xl }}>
                    <View style={{ alignItems: "center", marginTop: theme.space.md }}>
                        <AlbumArt source={art} size={artSize} radius={theme.radius.lg} elevated />
                    </View>

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
                </ScrollView>
            </View>
            <PlayerBar floating />
            <AddToPlaylistSheet songId={details.song.songId} visible={showPlaylistSheet} onClose={() => setShowPlaylistSheet(false)} />
        </Screen>
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
