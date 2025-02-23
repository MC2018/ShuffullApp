import { Button, ScrollView, Text, View, StyleSheet } from "react-native";
import { Playlist } from "../services/db/models";
import React from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";

export default function PlaylistPage({ navigation, route }: any) {

    return (
        <>
        </>
    );
}

const styles = StyleSheet.create({
    parent: {

    },
    header: {
        fontSize: 20,
        fontWeight: "bold",
    }
});
