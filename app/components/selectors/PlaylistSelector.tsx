import React from "react";
import { Button, Image, ImageSourcePropType, Pressable, Text, StyleSheet } from "react-native";
import { MediaManager } from "../../tools";
import SongCollectionSelector from "./SongCollectionSelector";
import { Playlist } from "@/app/services/db/models";
import { SongFilterType } from "@/app/types/SongFilters";

export interface PlaylistSelectorProps {
    playlist: Playlist;
    imageSource: ImageSourcePropType | string;
    onSelected: () => void;
}

export default function PlaylistSelector({ playlist, imageSource, onSelected }: PlaylistSelectorProps) {
    const handleSelected = async () => {
        const songFilters = await MediaManager.getSongFilters();
        const newPlaylistIds = [playlist.playlistId];

        if (newPlaylistIds == songFilters.playlistIds) {
            return;
        }

        songFilters.setPrimaryFilter(SongFilterType.Playlist, newPlaylistIds);
        await MediaManager.setSongFilters(songFilters, true);
        await MediaManager.skip();
    };

    return <SongCollectionSelector
        collectionName={playlist.name}
        imageSource={require("@/assets/images/default-album-art.jpg")}
        onSelected={handleSelected}>
    </SongCollectionSelector>;
}
