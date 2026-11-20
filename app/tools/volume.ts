// Pure helpers for the desktop volume slider (ShuffullApp#217). No React Native imports, so they are unit-tested.

/** A whole percent between 0 and 100. Anything that isn't a number reads as 0. */
export function clampVolume(level: number): number {
    if (!Number.isFinite(level)) {return 0;}
    return Math.round(Math.max(0, Math.min(100, level)));
}

export type VolumeGlyph = "volume-mute" | "volume-low" | "volume-medium" | "volume-high";

/** The speaker glyph: crossed out when muted or at 0, then one, two or three waves as it gets louder. */
export function volumeGlyph(volume: number, muted: boolean): VolumeGlyph {
    if (muted || volume <= 0) {return "volume-mute";}
    if (volume < 34) {return "volume-low";}
    if (volume < 67) {return "volume-medium";}
    return "volume-high";
}

/** What a key does to the level on a focused slider, or null when the key isn't ours. */
export function volumeAfterKey(volume: number, key: string): number | null {
    switch (key) {
        case "ArrowUp":
        case "ArrowRight":
            return clampVolume(volume + 5);
        case "ArrowDown":
        case "ArrowLeft":
            return clampVolume(volume - 5);
        case "PageUp":
            return clampVolume(volume + 10);
        case "PageDown":
            return clampVolume(volume - 10);
        case "Home":
            return 0;
        case "End":
            return 100;
        default:
            return null;
    }
}

/** One scroll-wheel notch: 2% up when scrolling up, 2% down otherwise. */
export function volumeAfterWheel(volume: number, deltaY: number): number {
    if (deltaY === 0) {return volume;}
    return clampVolume(volume + (deltaY < 0 ? 2 : -2));
}
