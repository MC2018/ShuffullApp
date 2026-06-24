import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { generateId } from "@/app/tools";
import { LikeStatus, RequestType } from "@/app/enums";

interface LikeControlProps {
    songId: string;
}

const OPTIONS: { status: LikeStatus; label: string }[] = [
    { status: LikeStatus.Like, label: "♥ Like" },
    { status: LikeStatus.Love, label: "♥♥ Love" },
    { status: LikeStatus.Dislike, label: "✕ Dislike" },
];

// Like / Love / Dislike for the current song. Optimistic: it updates the local UserSong immediately and
// queues a SetSongLikeStatus request for the sync loop to POST. Tapping the active choice clears it back to
// Neutral. Dislike = never play again (enforced in the shuffle query).
export default function LikeControl({ songId }: LikeControlProps) {
    const db = useDb();
    const userId = useCurrentUser();
    const [status, setStatus] = useState<LikeStatus>(LikeStatus.Neutral);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const userSong = await DbQueries.getUserSong(db, userId, songId);
            if (!cancelled) {
                setStatus((userSong?.likeStatus as LikeStatus) ?? LikeStatus.Neutral);
            }
        })();
        return () => { cancelled = true; };
    }, [db, userId, songId]);

    const choose = async (choice: LikeStatus) => {
        const next = status === choice ? LikeStatus.Neutral : choice;
        setStatus(next);
        // Optimistic local update, then queue the sync push (matching mediaManager's request pattern).
        await DbQueries.setUserSongLikeStatus(db, userId, songId, next);
        await DbQueries.addRequests(db, [{
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.SetSongLikeStatus,
            userId,
            songId,
            likeStatus: next,
        }]);
    };

    return (
        <View style={styles.row}>
            {OPTIONS.map(opt => {
                const active = status === opt.status;
                const activeStyle = opt.status === LikeStatus.Dislike ? styles.activeDislike : styles.active;
                return (
                    <Pressable
                        key={opt.status}
                        onPress={() => choose(opt.status)}
                        style={[styles.btn, active && activeStyle]}
                    >
                        <Text style={[styles.label, active && styles.activeLabel]}>{opt.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: "row",
        justifyContent: "center",
        gap: 8,
        marginTop: 8,
    },
    btn: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 16,
        backgroundColor: "#eee",
    },
    active: {
        backgroundColor: "#1d6ad1",
    },
    activeDislike: {
        backgroundColor: "#c0392b",
    },
    label: {
        fontSize: 13,
        color: "#444",
        fontWeight: "600",
    },
    activeLabel: {
        color: "#fff",
    },
});
