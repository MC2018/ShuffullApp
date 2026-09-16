import React from "react";
import { router } from "expo-router";
import SongCollectionSelector from "./SongCollectionSelector";

export default function LocalDownloadsSelector() {
    const handleSelected = async () => {
        router.push("/library/downloads");
    };

    return <SongCollectionSelector
        collectionName="Local Downloads"
        imageSource={require("@/assets/images/download.png")}
        onSelected={handleSelected}>
    </SongCollectionSelector>;
}
