import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { AntDesign } from "@expo/vector-icons";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { MediaManager } from "@/app/services/media-manager";
import { useLikeStatus } from "@/app/services/media-manager/mediaManager";
import { LikeStatus } from "@/app/enums";
import { useTheme } from "@/app/theme";
import HeartBurst from "./HeartBurst";

// Compact two-icon rating with tactile micro-animations. AntDesign glyphs (like/dislike/heart) are solid and
// minimal. The like button cycles Neutral → Like (👍, pop) → Love (♥, heartbeat + heart-burst) → Neutral; the
// dislike button toggles Dislike (a small wobble — acknowledged, not celebrated). Writes go through
// MediaManager.applyLikeStatus so the local DB, the sync push, and the notification rating stay in lockstep.
export default function RatingControl({ songId, gap, size = 24 }: { songId: string; gap?: number; size?: number }) {
    const db = useDb();
    const userId = useCurrentUser();
    const theme = useTheme();
    // Status is held in a shared store so changes from the notification's 👍/👎 buttons reflect here too.
    const status = useLikeStatus((s) => s.statuses[songId]) ?? LikeStatus.Neutral;
    const setLikeStatus = useLikeStatus((s) => s.setLikeStatus);
    const [burstKey, setBurstKey] = useState(0);

    const upScale = useRef(new Animated.Value(1)).current;
    const downRot = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const userSong = await DbQueries.getUserSong(db, userId, songId);
            if (!cancelled) {
                setLikeStatus(songId, (userSong?.likeStatus as LikeStatus) ?? LikeStatus.Neutral);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, userId, songId, setLikeStatus]);

    const apply = async (next: LikeStatus) => {
        setLikeStatus(songId, next); // optimistic
        await MediaManager.applyLikeStatus(songId, next);
    };

    const popUp = () =>
        Animated.sequence([
            Animated.spring(upScale, { toValue: 1.3, useNativeDriver: true, speed: 50, bounciness: 14 }),
            Animated.spring(upScale, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }),
        ]).start();

    const heartbeat = () =>
        Animated.sequence([
            Animated.timing(upScale, { toValue: 1.35, duration: 130, useNativeDriver: true }),
            Animated.timing(upScale, { toValue: 0.95, duration: 110, useNativeDriver: true }),
            Animated.timing(upScale, { toValue: 1.2, duration: 100, useNativeDriver: true }),
            Animated.spring(upScale, { toValue: 1, useNativeDriver: true, bounciness: 8 }),
        ]).start();

    const wobble = () =>
        Animated.sequence([
            Animated.timing(downRot, { toValue: -1, duration: 55, useNativeDriver: true }),
            Animated.timing(downRot, { toValue: 1, duration: 55, useNativeDriver: true }),
            Animated.timing(downRot, { toValue: -0.6, duration: 55, useNativeDriver: true }),
            Animated.timing(downRot, { toValue: 0, duration: 70, useNativeDriver: true }),
        ]).start();

    const cycleUp = () => {
        const next =
            status === LikeStatus.Like ? LikeStatus.Love : status === LikeStatus.Love ? LikeStatus.Neutral : LikeStatus.Like;
        if (next === LikeStatus.Like) {
            popUp();
        } else if (next === LikeStatus.Love) {
            heartbeat();
            setBurstKey((k) => k + 1);
        }
        apply(next);
    };

    const toggleDown = () => {
        const next = status === LikeStatus.Dislike ? LikeStatus.Neutral : LikeStatus.Dislike;
        if (next === LikeStatus.Dislike) {
            wobble();
        }
        apply(next);
    };

    const liked = status === LikeStatus.Like || status === LikeStatus.Love;
    const upName: keyof typeof AntDesign.glyphMap = status === LikeStatus.Love ? "heart" : "like";
    const upLabel = status === LikeStatus.Love ? "Loved" : status === LikeStatus.Like ? "Liked" : "Like";
    const disliked = status === LikeStatus.Dislike;
    const rotate = downRot.interpolate({ inputRange: [-1, 0, 1], outputRange: ["-12deg", "0deg", "12deg"] });

    return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: gap ?? theme.space.lg }}>
            <Pressable onPress={cycleUp} hitSlop={8} accessibilityRole="button" accessibilityLabel={upLabel}>
                <View>
                    <Animated.View style={{ transform: [{ scale: upScale }] }}>
                        <AntDesign name={upName} size={size} color={liked ? theme.color.accent : theme.color.textMuted} />
                    </Animated.View>
                    <HeartBurst playKey={burstKey} color={theme.color.accent} />
                </View>
            </Pressable>
            <Pressable onPress={toggleDown} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dislike">
                <Animated.View style={{ transform: [{ rotate }] }}>
                    <AntDesign name="dislike" size={size} color={disliked ? theme.color.textPrimary : theme.color.textMuted} />
                </Animated.View>
            </Pressable>
        </View>
    );
}
