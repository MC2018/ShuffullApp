import { MediaManager, DownloadPriority } from "../tools";
import { Button, Image, View, Text, Dimensions, StyleSheet, ImageSourcePropType, Pressable } from "react-native";
import React, { useEffect, useState } from "react";
import { useDownloader } from "../services/DownloaderProvider";
import { play, useActiveSong } from "../tools/mediaManager";
import { SongWithArtists } from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import * as DbQueries from "../services/db/queries";
import { State, usePlaybackState } from "react-native-track-player";

const { width, height } = Dimensions.get("window");
const margin = 5;

function getIconResource(state: State | undefined): ImageSourcePropType {
    switch (state) {
        case State.Paused:
        case State.Ready:
        case State.Buffering:
            return require(`../../assets/images/play.png`);
        case State.Playing:
        default:
            return require(`../../assets/images/pause.png`);
    }
}

export default function PlayerBar() {
    const db = useDb();
    const { songId } = useActiveSong();
    const [ songInfo, setSongInfo ] = useState<SongWithArtists | null>(null);
    const playbackState = usePlaybackState();
    
    useEffect(() => {
        if (songId == -1) {
            setSongInfo(null);
            return;
        }

        try {
            DbQueries.fetchSongDetails(db, songId).then((songInfo) => {
                if (songId != songInfo.song.songId) {
                    setSongInfo(null);
                    return;
                }

                setSongInfo(songInfo);
            });
        } catch {
            console.log("Error fetching song details");
        }
    }, [songId]);

    const controlMedia = async () => {
        if (playbackState.state == State.Playing) {
            await MediaManager.pause();
        } else {
            await MediaManager.play();
        }
    };

    if (songInfo == null || songId == -1) {
        return <></>;
    }

    return (
        <View style={styles.container}>
            <View style={styles.textContainer}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.songName}>{songInfo?.song.name}</Text>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.artistName}>{songInfo?.artists.map(x => x.name).join(", ")}</Text>
            </View>
            <Pressable style={styles.playPressable} onPress={() => controlMedia()}>
                <Image source={getIconResource(playbackState.state)} style={styles.playImage}></Image>
            </Pressable>
        </View>
    );
}

const playImageDimensions = {
    width: 40,
    height: 40
};

const styles = StyleSheet.create({
    container: {
        width: width - margin * 2,
        height: 50,
        backgroundColor: "#ccc",
        position: "absolute",
        bottom: 0,
        borderRadius: 10,
        margin: margin,
        paddingHorizontal: 5,
        paddingVertical: 2,
        flexDirection: "row",
        alignItems: "center",
    },
    textContainer: {
        flexDirection: "column",
        justifyContent: "center",
        flex: 1,
        paddingRight: 5,
    },
    songName: {
        fontSize: 16,
        fontWeight: "500"
    },
    artistName: {
        fontSize: 14,
        fontWeight: "300"
    },
    playImage: {
        ...playImageDimensions
    },
    playPressable: {
        justifyContent: "center",
        alignItems: "center",
        ...playImageDimensions
    },
});