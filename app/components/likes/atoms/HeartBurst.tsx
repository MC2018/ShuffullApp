import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { AntDesign } from "@expo/vector-icons";

const COUNT = 8;
const RADIUS = 26;

// A one-shot radial burst of little hearts, re-fired whenever `playKey` changes (0 = idle, never plays).
// Pure legacy Animated on the native driver — matches the rest of the app and needs no reanimated babel setup.
export default function HeartBurst({ playKey, color, size = 9 }: { playKey: number; color: string; size?: number }) {
    const progress = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (playKey === 0) {
            return;
        }
        progress.setValue(0);
        Animated.timing(progress, { toValue: 1, duration: 620, useNativeDriver: true }).start();
    }, [playKey]);

    return (
        <View pointerEvents="none" style={styles.container}>
            {Array.from({ length: COUNT }).map((_, i) => {
                const angle = (i / COUNT) * Math.PI * 2;
                const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * RADIUS] });
                const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * RADIUS] });
                const opacity = progress.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] });
                const scale = progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.4, 1, 0.3] });
                return (
                    <Animated.View key={i} style={[styles.particle, { opacity, transform: [{ translateX }, { translateY }, { scale }] }]}>
                        <AntDesign name="heart" size={size} color={color} />
                    </Animated.View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
    particle: { position: "absolute" },
});
