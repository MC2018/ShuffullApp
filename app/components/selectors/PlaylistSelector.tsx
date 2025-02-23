import React from "react";
import { Button, Image, ImageSourcePropType, Pressable, Text, StyleSheet } from "react-native";
import { MediaManager } from "../../tools";
import SongCollectionSelector from "./SongCollectionSelector";
import { Playlist } from "@/app/services/db/models";
import { SongFilterType } from "@/app/types/SongFilters";

export interface PlaylistSelectorProps {
    playlist: Playlist;
    imageSource: ImageSourcePropType | string;
    onSelectPlaylist: (playlist: Playlist) => void;
}

export default function PlaylistSelector({ playlist, imageSource, onSelectPlaylist }: PlaylistSelectorProps) {
    return <SongCollectionSelector
        collectionName={playlist.name}
        imageSource={require("@/assets/images/default-album-art.jpg")}
        onSelected={() => onSelectPlaylist(playlist)}>
    </SongCollectionSelector>;
}
