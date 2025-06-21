import { View, Text, FlatList, TextInput } from "react-native";
import React from "react";
import { Song, SongTag, Tag } from "@/app/services/db/models";

export interface TagListProps {
    tags: Tag[];
}

export function TagList({ tags }: TagListProps) {

    return (<Text>{tags.map(x => x.name).join(", ")}</Text>);
}
