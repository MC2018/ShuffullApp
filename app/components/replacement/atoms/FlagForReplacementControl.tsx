import { useEffect, useState } from "react";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools/utils";
import IconButton from "@/app/components/ui/IconButton";
import { useTheme } from "@/app/theme";
import { showAlert } from "@/app/tools/dialog";
import ReportSongSheet, { ReportedSong } from "@/app/components/duplicates/ReportSongSheet";

// The song screen's flag button. It opens a sheet with three reports (ShuffullApp#219):
// - Poor quality: queues a global per-song replacement request through the sync pipeline
//   (→ POST /api/v1/replacements) so a better copy can be sourced. One-way from the app's side: once queued the icon
//   stays filled, and re-detects a still-pending request on remount so it survives navigating away before the next
//   sync flushes it. Resolution happens server/funnel-side.
// - Duplicate of… / Different version: a duplicate report that hides one copy for this user (ReportSongSheet).
export default function FlagForReplacementControl({
    song,
    size = 24,
    onReported,
}: {
    song: ReportedSong;
    size?: number;
    onReported: (hiddenSongId: string) => void;
}) {
    const songId = song.songId;
    const db = useDb();
    const userId = useCurrentUser();
    const theme = useTheme();
    const [flagged, setFlagged] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const requests = await DbQueries.getRequests(db, userId);
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
    }, [db, songId, userId]);

    const flagForReplacement = () => {
        if (flagged) {
            return;
        }
        showAlert(
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
        <>
            <IconButton
                name={flagged ? "flag" : "flag-outline"}
                size={size}
                color={flagged ? theme.color.accent : theme.color.textMuted}
                onPress={() => setSheetOpen(true)}
                accessibilityLabel="Report a problem with this song"
            />
            <ReportSongSheet
                song={song}
                visible={sheetOpen}
                onClose={() => setSheetOpen(false)}
                poorQualityFlagged={flagged}
                onFlagPoorQuality={flagForReplacement}
                onReported={onReported}
            />
        </>
    );
}
