export interface VolumeControlProps {
    /** Width of the slider track. */
    width?: number;
    /** Show the level as a percentage after the slider. */
    showPercent?: boolean;
}

/**
 * The speaker volume slider exists only in the desktop app, which runs the web build: see VolumeControl.web.tsx
 * (ShuffullApp#217). On a phone the hardware buttons own the volume, so this renders nothing.
 */
export default function VolumeControl(_props: VolumeControlProps) {
    return null;
}
