import React from "react";
import { Button, Image, ImageSourcePropType, Pressable, Text, StyleSheet } from "react-native";

export interface SongCollectionSelectorProps {
    collectionName: string;
    imageSource: ImageSourcePropType | string;
    onSelected: () => void;
}

export default function SongCollectionSelector({ collectionName, imageSource, onSelected }: SongCollectionSelectorProps) {
    return <Pressable onPress={onSelected} style={styles.parent}>
        {(typeof imageSource === "string") ?
            <Image source={{ uri: imageSource }} style={styles.image} />
            :
            <Image source={imageSource} style={styles.image} />
        }
        <Text numberOfLines={2} ellipsizeMode="tail" style={styles.text}>{collectionName}</Text>
    </Pressable>;
}

const imageDimensions = 100;

const styles = StyleSheet.create({
    parent: {
        padding: 0,
        margin: 5,
        backgroundColor: "#f0f0f0",
        borderRadius: 10,
        alignItems: "center",
    },
    image: {
        width: imageDimensions,
        height: imageDimensions,
    },
    text: {
        marginTop: 5,
        width: imageDimensions,
        textAlign: "left",
        fontSize: 13,
    }
});
