import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal } from "react-native";
import React from "react";
import FilterSelectionPill, { FilterPillInfo, WhitelistingStatus } from "../atoms/FilterSelectionPill";

interface FilterSelectionPillGroupProps<T> {
    pillsInfo: FilterPillInfo<T>[];
    onUpdateSelection: (pillInfo: FilterPillInfo<T>, newStatus: WhitelistingStatus) => void;
    displayOnly?: boolean;
};

export default function FilterSelectionPillGroup<T>({ pillsInfo, onUpdateSelection, displayOnly }: FilterSelectionPillGroupProps<T>) {
    return (
        <ScrollView>
            <View style={styles.pillGroup}>
                {pillsInfo.map(pillInfo => (
                    <FilterSelectionPill key={JSON.stringify(pillInfo.id)} pillInfo={pillInfo} displayOnly={displayOnly} onUpdateSelection={onUpdateSelection} />
                ))}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    pillGroup: {
        flexDirection: "row",
        flexWrap: "wrap"
    }
});
