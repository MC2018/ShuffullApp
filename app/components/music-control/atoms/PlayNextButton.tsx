import { useState } from "react";
import { cancelPlayNextForSong, playLibrarySongNext, usePlayNext } from "@/app/services/song-requests/playNext";
import IconButton from "@/app/components/ui/IconButton";
import { useTheme } from "@/app/theme";
import { showAlert } from "@/app/tools/dialog";
import { log } from "@/app/tools/log";

// "Play next" for a song in the library (ShuffullApp#25). A toggle: lit while the song is waiting to play next (asked
// for here or from the request search), and a second tap takes it back off.
export default function PlayNextButton({ songId, name, size = 24 }: { songId: string; name: string; size?: number }) {
    const theme = useTheme();
    const playsNext = usePlayNext((state) => state.intents.some((intent) => intent.songId === songId));
    const [busy, setBusy] = useState(false);

    const toggle = async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            if (playsNext) {
                await cancelPlayNextForSong(songId);
                return;
            }
            const error = await playLibrarySongNext({ songId, name });
            if (error != null) {
                showAlert("Not playing next", error);
            }
        } catch (e) {
            log.warn("play-next", "changing play next from the song page failed", e);
            showAlert("Not playing next", `Couldn't change that: ${String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <IconButton
            name={playsNext ? "play-forward" : "play-forward-outline"}
            size={size}
            color={playsNext ? theme.color.accentTint : theme.color.textMuted}
            onPress={() => void toggle()}
            accessibilityLabel={playsNext ? `${name} plays next. Don't play it next` : "Play next"}
        />
    );
}
