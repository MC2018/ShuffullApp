import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal, DimensionValue } from "react-native";
import React, { ReactNode, useEffect, useState } from "react";

interface ModalPopupTemplateProps {
    visible: boolean;
    children: ReactNode;
    onRequestClose: () => void;
};

export default function ModalPopupTemplate({ visible, children, onRequestClose }: ModalPopupTemplateProps) {
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