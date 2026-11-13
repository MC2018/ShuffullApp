import { useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, LayoutChangeEvent, StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { NavigationContext } from "@react-navigation/native";
import { ColorToken, TypographyVariant } from "@/app/theme";
import Text from "./Text";
import { MARQUEE_GAP_PX, planMarquee } from "./marqueePlan";

interface Props {
    children: string;
    variant?: TypographyVariant;
    color?: ColorToken;
    /** Center the text when it fits. A title that scrolls always starts at the left edge. */
    center?: boolean;
    /** False holds the text still at its start, e.g. while it is faded out. */
    active?: boolean;
    /** Lines to wrap to when it can't scroll (reduce motion is on). Ends in an ellipsis past that. */
    staticLines?: number;
    style?: StyleProp<ViewStyle>;
}

// A single line of text that slowly scrolls when it is too long to fit, so a long song title can be read
// in full. Text that fits renders exactly like a plain one-line <Text>. With the OS "reduce motion" setting
// on, it stays still and truncates with an ellipsis instead. It also holds still while its screen is not
// the focused one, so the player bars of screens further down the stack don't keep animating.
// Legacy Animated on the native driver, like the rest of the app (no reanimated babel setup needed).
export default function MarqueeText({ children, variant, color, center = false, active = true, staticLines = 1, style }: Props) {
    const [containerWidth, setContainerWidth] = useState(0);
    const [textWidth, setTextWidth] = useState(0);
    const reduceMotion = useReduceMotion();
    const screenFocused = useScreenFocused();
    const translateX = useRef(new Animated.Value(0)).current;

    const plan = planMarquee(textWidth, containerWidth);
    const scrolling = plan.scroll && !reduceMotion;
    const moving = scrolling && active && screenFocused;
    const distance = plan.scroll ? plan.distance : 0;
    const durationMs = plan.scroll ? plan.durationMs : 0;
    const pauseMs = plan.scroll ? plan.pauseMs : 0;

    useEffect(() => {
        translateX.setValue(0);
        if (!moving) {
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
    }, [moving, distance, durationMs, pauseMs, children, translateX]);

    const onContainerLayout = (e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width);
    // Rounded up so the last glyph never clips.
    const onMeasureLayout = (e: LayoutChangeEvent) => setTextWidth(Math.ceil(e.nativeEvent.layout.width));

    return (
        // Not `accessible`: the visible text is the one a screen reader reads, so a parent button (the player
        // bar) still groups it with its other labels. The measuring copy and the trailing copy are hidden.
        <View style={[styles.container, style]} onLayout={onContainerLayout}>
            {/* Invisible copy inside a very wide row, so it lays out at its natural width instead of the container's. */}
            <View style={styles.measure} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text variant={variant} color={color} numberOfLines={1} onLayout={onMeasureLayout}>
                    {children}
                </Text>
            </View>

            {scrolling ? (
                // Explicit widths: without them the row is capped at the container's width and the copies shrink.
                <Animated.View style={[styles.track, { width: textWidth * 2 + MARQUEE_GAP_PX, transform: [{ translateX }] }]}>
                    <Text variant={variant} color={color} style={{ width: textWidth }} numberOfLines={1}>
                        {children}
                    </Text>
                    <View style={{ width: MARQUEE_GAP_PX }} />
                    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                        <Text variant={variant} color={color} style={{ width: textWidth }} numberOfLines={1}>
                            {children}
                        </Text>
                    </View>
                </Animated.View>
            ) : (
                <Text variant={variant} color={color} numberOfLines={reduceMotion ? staticLines : 1} style={center ? styles.centered : null}>
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

// Whether the enclosing screen is the focused one. Outside any navigator it counts as focused, so the
// component also works where useIsFocused would throw.
function useScreenFocused(): boolean {
    const navigation = useContext(NavigationContext);
    const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
    useEffect(() => {
        if (!navigation) {
            return;
        }
        setFocused(navigation.isFocused());
        const offFocus = navigation.addListener("focus", () => setFocused(true));
        const offBlur = navigation.addListener("blur", () => setFocused(false));
        return () => {
            offFocus();
            offBlur();
        };
    }, [navigation]);
    return focused;
}

const styles = StyleSheet.create({
    container: { alignSelf: "stretch", overflow: "hidden" },
    measure: { position: "absolute", top: 0, left: 0, width: 10000, flexDirection: "row", opacity: 0 },
    track: { flexDirection: "row", alignSelf: "flex-start" },
    centered: { textAlign: "center" },
});
