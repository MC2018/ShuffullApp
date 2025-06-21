import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal } from "react-native";
import React, { useEffect, useState } from "react";


export enum WhitelistingStatus {
    None,
    Whitelisted,
    Blacklisted
};

export enum WhitelistingMode {
    Whitelisting,
    Blacklisting
}

export namespace WhitelistingStatus {
    export function fromWhitelistingMode(whitelistingMode: WhitelistingMode) {
        switch (whitelistingMode) {
            case WhitelistingMode.Blacklisting:
                return WhitelistingStatus.Blacklisted;
            case WhitelistingMode.Whitelisting:
                return WhitelistingStatus.Whitelisted;
            default:
                throw new Error("Matching WhitelistingStatus not found.");
        }
    }
}

export type FilterPillInfo<T> = {
    id: T;
    displayName: string;
    whitelistingStatus: WhitelistingStatus;
};

interface FilterSelectionPillProps<T> {
    pillInfo: FilterPillInfo<T>;
    onUpdateSelection: (pillInfo: FilterPillInfo<T>, newStatus: WhitelistingStatus) => void;
    displayOnly?: boolean
};

export default function SelectionPill<T>({ pillInfo, onUpdateSelection, displayOnly = false }: FilterSelectionPillProps<T>) {
    const displayText = pillInfo.whitelistingStatus == WhitelistingStatus.None ? "+" : "x";
    const truncateText = (text: string, maxLength: number) => {
        return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
    };
    const getBackgroundColor = () => {
        switch (pillInfo.whitelistingStatus) {
            case WhitelistingStatus.Blacklisted:
                return "#333";
            case WhitelistingStatus.Whitelisted:
                return "#fff";
            case WhitelistingStatus.None:
                return "#ddd";
            default:
                throw new Error(`Unexpected whitelisting status: ${pillInfo.whitelistingStatus}`);
        }
    }
    const getTextColor = () => {
        switch (pillInfo.whitelistingStatus) {
            case WhitelistingStatus.Blacklisted:
                return "#fff";
            case WhitelistingStatus.Whitelisted:
                return "#000";
            case WhitelistingStatus.None:
                return "#000";
            default:
                throw new Error(`Unexpected whitelisting status: ${pillInfo.whitelistingStatus}`);
        }
    }

    const handlePress = (long: boolean, overrideToNone: boolean = false) => {
        let newStatus: WhitelistingStatus = pillInfo.whitelistingStatus;

        switch (pillInfo.whitelistingStatus) {
            case WhitelistingStatus.None:
                newStatus = long ? WhitelistingStatus.Blacklisted : WhitelistingStatus.Whitelisted;
                break;
            case WhitelistingStatus.Blacklisted:
                if (long) {
                    newStatus = WhitelistingStatus.Whitelisted;
                }
                break;
            case WhitelistingStatus.Whitelisted:
                if (long) {
                    newStatus = WhitelistingStatus.Blacklisted;
                }
                break;
        }

        if (overrideToNone) {
            newStatus = WhitelistingStatus.None;
        }

        onUpdateSelection(pillInfo, newStatus);
    };

    return (
        <TouchableOpacity disabled={displayOnly} onPress={() => handlePress(false)} onLongPress={() => handlePress(true)}>
            <View style={[styles.selectedPill, { backgroundColor: getBackgroundColor() }, pillInfo.whitelistingStatus == WhitelistingStatus.Whitelisted ? { borderColor: "#000", borderWidth: 1 } : {}]}>
                <Text style={[styles.pillText, { color: getTextColor() }]}>{truncateText(pillInfo.displayName, 20)}</Text>
                {pillInfo.whitelistingStatus == WhitelistingStatus.None ?
                    <></> : 
                    displayOnly ?
                    <></> :  
                    <TouchableOpacity onPress={() => handlePress(false, true)}>
                        <Text style={[styles.pillX, { color: getTextColor() }]} numberOfLines={1} ellipsizeMode="tail">x</Text>
                    </TouchableOpacity>
                }
            </View>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    selectedPill: {
        flexDirection: "row",
        height: 22,
        fontSize: 14,
        backgroundColor: "#ddd",
        borderRadius: 10,
        margin: 5
    },
    pillText: {
        marginHorizontal: 5
    },
    pillX: {
        marginHorizontal: 5,
        paddingBottom: 5,
    }
});