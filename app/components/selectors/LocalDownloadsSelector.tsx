import React from "react";
import { Button, Image, ImageSourcePropType, Pressable, Text, StyleSheet } from "react-native";
import { useProgress } from "react-native-track-player";
import Slider from "@react-native-community/slider";
import { MediaManager, Navigator } from "../../tools";
import SongCollectionSelector from "./SongCollectionSelector";
import { SongFilters } from "@/app/types/SongFilters";
import { useNavigation } from "@react-navigation/native";

export default function LocalDownloadsSelector() {
    const navigation = useNavigation();
    const handleSelected = async () => {
        Navigator.toLocalDownloads(navigation);
    };

    return <SongCollectionSelector
        collectionName="Local Downloads"
        imageSource={require("@/assets/images/download.png")}
        onSelected={handleSelected}>
    </SongCollectionSelector>;
}
