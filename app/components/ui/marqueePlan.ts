// Pure timing for MarqueeText, kept free of React Native so it can be unit-tested.

/** Scroll speed. Slow enough to read a title while it moves. */
export const MARQUEE_SPEED_PX_PER_S = 30;
/** Hold still this long before each pass, so the start of the title can be read first. */
export const MARQUEE_PAUSE_MS = 2500;
/** Blank space between the end of the title and the copy that follows it in. */
export const MARQUEE_GAP_PX = 48;
/** Overflow smaller than this (sub-pixel rounding, a stray glyph edge) doesn't count as "too long". */
const OVERFLOW_TOLERANCE_PX = 1;

export type MarqueePlan = { scroll: false } | { scroll: true; distance: number; durationMs: number; pauseMs: number };

/**
 * Decide whether a title of `textWidth` needs to scroll inside `containerWidth`, and how.
 * One pass moves the text left by its own width plus the gap, which puts the trailing copy exactly where
 * the original started, so jumping back to 0 afterwards is invisible.
 */
export function planMarquee(textWidth: number, containerWidth: number): MarqueePlan {
    if (!(textWidth > 0) || !(containerWidth > 0) || textWidth <= containerWidth + OVERFLOW_TOLERANCE_PX) {
        return { scroll: false };
    }
    const distance = Math.ceil(textWidth + MARQUEE_GAP_PX);
    return {
        scroll: true,
        distance,
        durationMs: Math.round((distance / MARQUEE_SPEED_PX_PER_S) * 1000),
        pauseMs: MARQUEE_PAUSE_MS,
    };
}
