import type { PlayerOptions } from "react-native-track-player";

/**
 * What the player is set up with, once per process (mediaManager's initTrackPlayer).
 *
 * `autoHandleInterruptions` is the whole of ShuffullApp#23. Called with no options, the vendored RNTP fork reads
 * the flag with Android's `Bundle.getBoolean`, which answers `false` for a missing key, so the `?: true` fallback
 * beside it never applies. That turns ExoPlayer's audio-focus handling off. Another app could then start playing
 * and Shuffull would keep going over it, and a phone call wouldn't pause it.
 *
 * Listening for `Event.RemoteDuck` instead is not an option on Android: the fork never emits it there (its focus
 * listener is an empty TODO and nothing calls `updateOnAudioFocusChanged`). With the flag on, ExoPlayer owns focus:
 * it pauses when another app takes the audio for good, pauses and resumes around a call or a navigation prompt,
 * and ducks for a notification sound. On iOS the system pauses on an interruption either way; the flag makes the
 * player resume when the interruption ends and the system says it may.
 */
export const PLAYER_SETUP_OPTIONS: PlayerOptions = {
    autoHandleInterruptions: true,
};
