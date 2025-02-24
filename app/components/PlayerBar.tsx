import { MediaManager } from "../tools";
import { Image, View, Text, Dimensions, StyleSheet, ImageSourcePropType, Pressable, ImageURISource } from "react-native";
import React, { useEffect, useState } from "react";
import { useActiveSong } from "../tools/mediaManager";
import { SongDetails } from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import * as DbQueries from "../services/db/queries";
import { State, usePlaybackState } from "react-native-track-player";
import { Song } from "../services/db/models";
import { Downloader } from "../tools/Downloader";

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");
const { width, height } = Dimensions.get("window");

function getPlayButtonImage(state: State | undefined): ImageURISource {
    switch (state) {
        case State.Paused:
        case State.Ready:
        case State.Buffering:
        case State.None:
            return require(`@/assets/images/play.png`);
        case State.Playing:
        default:
            return require(`@/assets/images/pause.png`);
    }
}

type GenericImageSource = ImageURISource | { uri: string };

async function getAlbumArtUri(song?: Song): Promise<GenericImageSource> {
    if (song == undefined) {
        return defaultArt;
    }

    const albumArtUri = Downloader.generateLocalAlbumArtUri(song)
    
    if (await Downloader.fileExists(albumArtUri)) {
        return { uri: albumArtUri };
    }

    return { uri: await Downloader.generateServerAlbumArtUrl(song) };
}

export default function PlayerBar() {
    const db = useDb();
    const playbackState = usePlaybackState();
    const { songId } = useActiveSong();
    const [ songInfo, setSongInfo ] = useState<SongDetails | null>(null);
    const [ albumArt, setAlbumArt ] = useState<GenericImageSource>(defaultArt);
    
    useEffect(() => {
        (async () => {
            if (songId == undefined) {
                setSongInfo(null);
                return;
            }
    
            try {
                const songInfo = await DbQueries.fetchSongDetails(db, songId);

                if (songId != songInfo.song.songId) {
                    setSongInfo(null);
                    return;
                }

                setSongInfo(songInfo);
                setAlbumArt(await getAlbumArtUri(songInfo.song));
            } catch {
                console.log("Error fetching song details");
            }
        })();
    }, [songId]);

    const controlMedia = async () => {
        if (playbackState.state == State.Playing) {
            await MediaManager.pause();
        } else {
            await MediaManager.play();
        }
    };

    if (songInfo == undefined) {
        return <></>;
    }

    return (
        <View style={styles.container}>
            <View style={styles.imageContainer}>
                <Image source={albumArt} style={styles.albumArtImage} defaultSource={defaultArt}></Image>
            </View>
            <View style={styles.textContainer}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.songName}>{songInfo?.song.name}</Text>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.artistName}>{songInfo?.artists.map(x => x.name).join(", ")}</Text>
            </View>
            <Pressable style={styles.imageContainer} onPress={() => controlMedia()}>
                <Image source={getPlayButtonImage(playbackState.state)} style={styles.playButtonImage}></Image>
            </Pressable>
        </View>
    );
}

const imageDimensions = {
    width: 40,
    height: 40
};
const playerBarHeight = 50;
const margin = 5;
export const totalPlayerBarHeight = playerBarHeight + margin * 2;

const styles = StyleSheet.create({
    container: {
        width: width - margin * 2,
        height: playerBarHeight,
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
        paddingHorizontal: 5,
    },
    songName: {
        fontSize: 16,
        fontWeight: "500"
    },
    artistName: {
        fontSize: 14,
        fontWeight: "300"
    },
    playButtonImage: {
        ...imageDimensions,
    },
    albumArtImage: {
        ...imageDimensions,
        borderRadius: 10
    },
    imageContainer: {
        justifyContent: "center",
        alignItems: "center",
        ...imageDimensions
    },
});