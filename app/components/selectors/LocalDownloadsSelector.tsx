import React from "react";
import { Button, Image, ImageSourcePropType, Pressable, Text, StyleSheet } from "react-native";
import { useProgress } from "react-native-track-player";
import Slider from "@react-native-community/slider";
import { MediaManager } from "../../tools";
import SongCollectionSelector from "./SongCollectionSelector";
import { SongFilters } from "@/app/types/SongFilters";

export default function LocalDownloadsSelector() {
    const handleSelected = async () => {
        const songFilters = new SongFilters();
        songFilters.localOnly = true;

        await MediaManager.setSongFilters(songFilters, true);
    };

    return <SongCollectionSelector
        collectionName="Local Downloads"
        imageSource={require("@/assets/images/download.png")}
        onSelected={handleSelected}>
    </SongCollectionSelector>;
}
