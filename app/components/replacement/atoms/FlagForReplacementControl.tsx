import React, { useEffect, useState } from "react";
import { Alert } from "react-native";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools/utils";
import IconButton from "@/app/components/ui/IconButton";
import { useTheme } from "@/app/theme";

// Per-song "flag for replacement" toggle. Queues a global per-song replacement request through the sync
// pipeline (→ POST /api/v1/replacements) so a poor-quality song can be re-sourced. The flag is one-way from
// the app's side: once queued it stays filled, and re-detects a still-pending request on remount so it
// survives navigating away before the next sync flushes it. Resolution happens server/funnel-side.
export default function FlagForReplacementControl({ songId, size = 24 }: { songId: string; size?: number }) {
    const db = useDb();
    const userId = useCurrentUser();
    const theme = useTheme();
    const [flagged, setFlagged] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const requests = await DbQueries.getRequests(db);
            const pending = requests.some(
                (r) => r.requestType === RequestType.FlagSongForReplacement && r.songId === songId,
            );
            if (!cancelled && pending) {
                setFlagged(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, songId]);

    const flagForReplacement = () => {
        if (flagged) {
            return;
        }
        Alert.alert(
            "Flag for replacement",
            "Mark this song as poor quality so a better version can be sourced?",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Flag",
                    style: "destructive",
                    onPress: async () => {
                        setFlagged(true); // optimistic
                        await DbQueries.addRequests(db, [
                            {
                                requestId: generateId(),
                                timeRequested: new Date(),
                                requestType: RequestType.FlagSongForReplacement,
                                userId,
                                songId,
                            },
                        ]);
                    },
                },
            ],
        );
    };

    return (
        <IconButton
            name={flagged ? "flag" : "flag-outline"}
            size={size}
            color={flagged ? theme.color.accent : theme.color.textMuted}
            onPress={flagForReplacement}
            accessibilityLabel={flagged ? "Flagged for replacement" : "Flag for replacement"}
        />
    );
}
