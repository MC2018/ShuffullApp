import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal, Image } from "react-native";
import React, { useEffect, useState } from "react";
import FilterSelectionPill, { FilterPillInfo, WhitelistingMode, WhitelistingStatus } from "./FilterSelectionPill";
import FilterSelectionPillGroup from "./FilterSelectionPillGroup";

interface FilterSelectionTypeProps<T> {
    title: string,
    pillsInfo: FilterPillInfo<T>[];
    onEditRequest: () => void;
};

export default function FilterSelectionType<T>({ title, pillsInfo, onEditRequest }: FilterSelectionTypeProps<T>) {
    const selectedPills = pillsInfo.filter(x => x.whitelistingStatus != WhitelistingStatus.None);

    return (
        <View>
            <View style={styles.flexContainer}>
                <Text style={styles.title}>{title}</Text>
                <TouchableOpacity onPress={onEditRequest}>
                    <Image source={require("@/assets/images/edit.png")} style={styles.image}></Image>
                </TouchableOpacity>
            </View>
            <FilterSelectionPillGroup pillsInfo={selectedPills} displayOnly={true} onUpdateSelection={() => {}}></FilterSelectionPillGroup>
        </View>

    );
}

const imageDimensions = 18;

const styles = StyleSheet.create({
    flexContainer: {
        flexDirection: "row",
        alignItems: "center"
    },
    title: {
        fontSize: 18,
        marginRight: 10
    },
    image: {
        width: imageDimensions,
        height: imageDimensions,
    },
});
