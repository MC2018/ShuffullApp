import type { PlayerOptions } from "react-native-track-player";

/**
 * What the player is set up with, once per process (mediaManager's initTrackPlayer passes `Platform.OS`).
 *
 * `autoHandleInterruptions` on Android is the whole of ShuffullApp#23. Called with no options, the vendored RNTP
 * fork reads the flag with Android's `Bundle.getBoolean`, which answers `false` for a missing key, so the `?: true`
 * fallback beside it never applies. That turns ExoPlayer's audio-focus handling off. Another app could then start
 * playing and Shuffull would keep going over it, and a phone call wouldn't pause it.
 *
 * Listening for `Event.RemoteDuck` instead is not an option on Android: the fork never emits it there (its focus
 * listener is an empty TODO and nothing calls `updateOnAudioFocusChanged`). With the flag on, ExoPlayer owns focus:
 * it pauses when another app takes the audio for good, pauses and resumes around a call, and lowers the volume for
 * a short sound such as a notification or a navigation prompt.
 *
 * iOS keeps it off. The system already pauses playback on an interruption there, and all the flag adds is a native
 * `player.play()` when the interruption ends - which doesn't know the user had paused before the call, so it would
 * start a song they had stopped.
 */
export function playerSetupOptions(os: string): PlayerOptions {
    return {
        autoHandleInterruptions: os === "android",
    };
}
