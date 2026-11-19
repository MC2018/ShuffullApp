import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { PlayHistoryItem } from "@/app/services/db/queries/playHistory";
import { AlbumArt, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { usePlayHistory, useSongArt } from "./usePlayHistory";

const CARD = 112;
/** Songs on the strip. The full list is one tap away, so this only has to answer "what was that song just now?". */
const STRIP_SONGS = 12;
/** Plays read to fill the strip: a song played twice in a row takes one card, so read a few more than it shows. */
const STRIP_READ = 40;

function StripCard({ item }: { item: PlayHistoryItem }) {
    const theme = useTheme();
    const art = useSongArt(item.song);
    const artists = item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist";
    return (
        <Pressable
            onPress={() => router.push({ pathname: "/song/[id]", params: { id: item.song.songId } })}
            style={({ pressed }) => ({ width: CARD, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={`${item.song.name} by ${artists}`}
        >
            <AlbumArt source={art} size={CARD} radius={theme.radius.md} />
            <Text variant="label" numberOfLines={1} style={{ marginTop: theme.space.sm }}>
                {item.song.name}
            </Text>
            <Text variant="caption" color="textFaint" numberOfLines={1}>
                {artists}
            </Text>
        </Pressable>
    );
}

/** Home's "Recently played": the latest songs as art cards, each once, newest first, with "See all" for the full list. */
export default function RecentlyPlayedStrip() {
    const theme = useTheme();
    const { plays } = usePlayHistory(STRIP_READ);

    const seen = new Set<string>();
    const latest = plays.filter((x) => !seen.has(x.song.songId) && seen.add(x.song.songId)).slice(0, STRIP_SONGS);
    if (latest.length === 0) {
        return null;
    }

    return (
        <View>
            <SectionHeader title="Recently played" actionLabel="See all" onAction={() => router.push("/history")} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.md, paddingRight: theme.space.md }}>
                {latest.map((item) => (
                    <StripCard key={item.play.listenId} item={item} />
                ))}
            </ScrollView>
        </View>
    );
}
