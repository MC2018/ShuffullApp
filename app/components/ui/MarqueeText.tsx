import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, LayoutChangeEvent, StyleProp, StyleSheet, TextStyle, View, ViewStyle } from "react-native";
import { ColorToken, TypographyVariant } from "@/app/theme";
import Text from "./Text";
import { MARQUEE_GAP_PX, planMarquee } from "./marqueePlan";

interface Props {
    children: string;
    variant?: TypographyVariant;
    color?: ColorToken;
    /** Center the text when it fits. A title that scrolls always starts at the left edge. */
    center?: boolean;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}

// A single line of text that slowly scrolls when it is too long to fit, so a long song title can be read
// in full. Text that fits renders exactly like a plain one-line <Text>. With the OS "reduce motion" setting
// on, it stays still and truncates with an ellipsis instead.
// Legacy Animated on the native driver, like the rest of the app (no reanimated babel setup needed).
export default function MarqueeText({ children, variant, color, center = false, style, textStyle }: Props) {
    const [containerWidth, setContainerWidth] = useState(0);
    const [textWidth, setTextWidth] = useState(0);
    const reduceMotion = useReduceMotion();
    const translateX = useRef(new Animated.Value(0)).current;

    const plan = planMarquee(textWidth, containerWidth);
    const scrolling = plan.scroll && !reduceMotion;
    const distance = plan.scroll ? plan.distance : 0;
    const durationMs = plan.scroll ? plan.durationMs : 0;
    const pauseMs = plan.scroll ? plan.pauseMs : 0;

    useEffect(() => {
        translateX.setValue(0);
        if (!scrolling) {
            return;
        }
        const loop = Animated.loop(
            Animated.sequence([
                Animated.delay(pauseMs),
                Animated.timing(translateX, { toValue: -distance, duration: durationMs, easing: Easing.linear, useNativeDriver: true }),
                // The trailing copy now sits where the original started, so snapping back is seamless.
                Animated.timing(translateX, { toValue: 0, duration: 0, useNativeDriver: true }),
            ]),
        );
        loop.start();
        return () => loop.stop();
        // `children` restarts the pass from the beginning when the song changes. `translateX` is a stable ref.
    }, [scrolling, distance, durationMs, pauseMs, children, translateX]);

    const onContainerLayout = (e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width);
    const onMeasureLayout = (e: LayoutChangeEvent) => setTextWidth(Math.ceil(e.nativeEvent.layout.width));

    return (
        <View style={[styles.container, style]} onLayout={onContainerLayout} accessible accessibilityRole="text" accessibilityLabel={children}>
            {/* Invisible copy inside a very wide row, so it lays out at its natural width instead of the container's. */}
            <View style={styles.measure} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text variant={variant} color={color} style={textStyle} numberOfLines={1} onLayout={onMeasureLayout}>
                    {children}
                </Text>
            </View>

            {scrolling ? (
                // Explicit widths: without them the row is capped at the container's width and the copies shrink.
                <Animated.View style={[styles.track, { width: textWidth * 2 + MARQUEE_GAP_PX, transform: [{ translateX }] }]}>
                    <Text variant={variant} color={color} style={[textStyle, { width: textWidth }]} numberOfLines={1}>
                        {children}
                    </Text>
                    <View style={{ width: MARQUEE_GAP_PX }} />
                    <Text variant={variant} color={color} style={[textStyle, { width: textWidth }]} numberOfLines={1}>
                        {children}
                    </Text>
                </Animated.View>
            ) : (
                <Text variant={variant} color={color} numberOfLines={1} style={[center ? styles.centered : null, textStyle]}>
                    {children}
                </Text>
            )}
        </View>
    );
}

function useReduceMotion(): boolean {
    const [reduce, setReduce] = useState(false);
    useEffect(() => {
        let active = true;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((value) => active && setReduce(value))
            .catch(() => {});
        const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
        return () => {
            active = false;
            sub?.remove();
        };
    }, []);
    return reduce;
}

const styles = StyleSheet.create({
    container: { alignSelf: "stretch", overflow: "hidden" },
    measure: { position: "absolute", top: 0, left: 0, width: 10000, flexDirection: "row", opacity: 0 },
    track: { flexDirection: "row", alignSelf: "flex-start" },
    centered: { textAlign: "center" },
});
