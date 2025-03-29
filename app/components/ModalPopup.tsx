import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal } from "react-native";
import { Playlist } from "../services/db/models";
import React, { ReactNode, useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import { MediaManager } from "../tools";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";
import { SongList } from "../components/SongList";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import SelectionPillGroup from "./selectors/FilterSelectionPillGroup";
import PillSelector from "./selectors/FilterPillSelector";

interface ModalPopup {
    visible: boolean;
    children: ReactNode;
    onRequestClose: () => void;
};

export default function ModalPopup({ visible, children, onRequestClose }: ModalPopup) {
    return (
        <Modal transparent visible={visible} onRequestClose={onRequestClose}>
            <View style={styles.modalGrayView}>
                <View style={styles.modalView}>
                    {children}
                </View>
            </View>
        </Modal>
    );
}


const styles = StyleSheet.create({
    modalGrayView: {
        backgroundColor: "#00000055",
        width: "100%",
        height: "100%"
    },
    modalView: {
        backgroundColor: "white",
        height: "85%",
        width: "80%",
        margin: "auto"
    },
});