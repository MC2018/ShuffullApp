import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal } from "react-native";
import React, { useEffect, useState } from "react";
import FilterSelectionPill, { FilterPillInfo, WhitelistingMode, WhitelistingStatus } from "../atoms/FilterSelectionPill";
import FilterSelectionPillGroup from "./FilterSelectionPillGroup";

interface FilterPillSelectorProps<T> {
    pillsInfo: FilterPillInfo<T>[];
    onUpdateSelection: (pillInfo: FilterPillInfo<T>, newStatus: WhitelistingStatus) => void;
};

export default function FilterPillSelector<T>({ pillsInfo, onUpdateSelection }: FilterPillSelectorProps<T>) {
    const selectedComparison = (pillInfo: FilterPillInfo<T>) => {
        return pillInfo.whitelistingStatus != WhitelistingStatus.None;
    }
    const selectedPills = pillsInfo.filter(selectedComparison);
    const unselectedPills = pillsInfo.filter(x => !selectedComparison(x));

    return (
        <>
            <Text>Selected</Text>
            <FilterSelectionPillGroup pillsInfo={selectedPills} onUpdateSelection={onUpdateSelection}></FilterSelectionPillGroup>
            <Text>Unselected</Text>
            <FilterSelectionPillGroup pillsInfo={unselectedPills} onUpdateSelection={onUpdateSelection}></FilterSelectionPillGroup>
        </>
    );
}
