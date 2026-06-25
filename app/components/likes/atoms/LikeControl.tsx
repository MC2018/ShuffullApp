import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { generateId } from "@/app/tools";
import { LikeStatus, RequestType } from "@/app/enums";
import { useTheme } from "@/app/theme";
import Text from "@/app/components/ui/Text";

interface LikeControlProps {
    songId: string;
}

const OPTIONS: { status: LikeStatus; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { status: LikeStatus.Like, label: "Like", icon: "heart-outline" },
    { status: LikeStatus.Love, label: "Love", icon: "heart" },
    { status: LikeStatus.Dislike, label: "Not for me", icon: "close" },
];

// Like / Love / Dislike for the current song. Optimistic: it updates the local UserSong immediately and
// queues a SetSongLikeStatus request for the sync loop to POST. Tapping the active choice clears it back to
// Neutral. Dislike = never play again (enforced in the shuffle query); shown as a neutral fill rather than
// red, since the accent itself reads as "liked".
export default function LikeControl({ songId }: LikeControlProps) {
    const db = useDb();
    const userId = useCurrentUser();
    const theme = useTheme();
    const [status, setStatus] = useState<LikeStatus>(LikeStatus.Neutral);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const userSong = await DbQueries.getUserSong(db, userId, songId);
            if (!cancelled) {
                setStatus((userSong?.likeStatus as LikeStatus) ?? LikeStatus.Neutral);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, userId, songId]);

    const choose = async (choice: LikeStatus) => {
        const next = status === choice ? LikeStatus.Neutral : choice;
        setStatus(next);
        // Optimistic local update, then queue the sync push (matching mediaManager's request pattern).
        await DbQueries.setUserSongLikeStatus(db, userId, songId, next);
        await DbQueries.addRequests(db, [
            {
                requestId: generateId(),
                timeRequested: new Date(),
                requestType: RequestType.SetSongLikeStatus,
                userId,
                songId,
                likeStatus: next,
            },
        ]);
    };

    return (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: theme.space.sm }}>
            {OPTIONS.map((opt) => {
                const active = status === opt.status;
                const isDislike = opt.status === LikeStatus.Dislike;
                const bg = active ? (isDislike ? theme.color.neutralFill : theme.color.accent) : theme.color.surface;
                const fg = active ? (isDislike ? theme.color.textFaint : theme.color.onAccent) : theme.color.textMuted;
                return (
                    <Pressable
                        key={opt.status}
                        onPress={() => choose(opt.status)}
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                            paddingVertical: theme.space.sm,
                            paddingHorizontal: theme.space.md,
                            borderRadius: theme.radius.pill,
                            backgroundColor: bg,
                            borderWidth: 1,
                            borderColor: active ? "transparent" : theme.color.line,
                        }}
                    >
                        <Ionicons name={opt.icon} size={14} color={fg} />
                        <Text variant="label" style={{ color: fg }}>
                            {opt.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
