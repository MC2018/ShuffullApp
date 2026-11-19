import React from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { PlayHistoryItem } from "@/app/services/db/queries/playHistory";
import { AlbumArt, ListRow, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { describePlayRow, formatPlayTime } from "@/app/tools/playHistory";
import { useSongArt } from "./usePlayHistory";

/**
 * One play on the Recently played screen: art, title, "artists · how it ended · where from", and the time it started.
 * A song that wasn't played out is dimmed a little, so the songs actually heard stand out. Tapping opens the song.
 */
function PlayHistoryRow({ item }: { item: PlayHistoryItem }) {
    const theme = useTheme();
    const art = useSongArt(item.song);
    const { play } = item;
    const heardOut = play.endReason === "finished";

    return (
        <ListRow
            title={item.song.name}
            subtitle={describePlayRow(item.artists.map((x) => x.name), play.endReason, play.secondsListened, play.context, item.playlistName)}
            left={<AlbumArt source={art} size={48} radius={theme.radius.md} />}
            right={
                <View style={{ alignItems: "flex-end" }}>
                    <Text variant="caption" color="textFaint">
                        {formatPlayTime(play.startedAt)}
                    </Text>
                </View>
            }
            style={heardOut ? undefined : { opacity: 0.6 }}
            onPress={() => router.push({ pathname: "/song/[id]", params: { id: item.song.songId } })}
        />
    );
}

export default React.memo(PlayHistoryRow);
