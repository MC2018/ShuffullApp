import { View, Text, FlatList, TextInput } from "react-native";
import { useDb } from "../services/db/DbProvider";
import { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { MediaManager } from "../tools";
import React from "react";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";
import { useActiveSong } from "../tools/mediaManager";
import { Song, SongTag, Tag } from "../services/db/models";

export function SongTagList() {
    const db = useDb();
    const { songId } = useActiveSong();
    const [ songTags, setSongTags ] = useState<Tag[]>([]);

    useEffect(() => {
        (async () => {
            if (songId == undefined) {
                return;
            }

            const dbSongTags = await DbQueries.getTagsFromSong(db, songId);
            setSongTags(dbSongTags);
        })();
    }, [songId]);

    
    if (songId == undefined || !songTags.length) {
        return <></>;
    }

    return (<Text>{songTags.map(x => x.name).join(", ")}</Text>
    );
}
