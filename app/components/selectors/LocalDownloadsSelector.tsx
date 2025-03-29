import React from "react";
import { MediaManager, Navigator } from "../../tools";
import SongCollectionSelector from "./SongCollectionSelector";
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
