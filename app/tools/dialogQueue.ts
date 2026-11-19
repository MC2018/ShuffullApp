import { create } from "zustand";
import type { AlertButton } from "react-native";

/**
 * The web/desktop dialogs, as state. `dialog.web.ts` queues them and `DialogHost` draws the first one in the app.
 *
 * This replaced `window.alert` / `window.confirm`, which are MODAL TO THE WHOLE PAGE: until the user clicks, no
 * JavaScript runs at all. The sync loop stops, listens stop checkpointing, and when the song ends the next one
 * never starts. A failed song-edit save on desktop froze playback that way (ShuffullApp#209). A dialog drawn by the
 * app leaves everything else running.
 *
 * It also lifts the browser's limits: every button shows with its own label, not just OK / Cancel.
 */

export interface PendingDialog {
    id: number;
    title: string;
    message?: string;
    /** Never empty: an alert with no buttons gets a lone OK, as on native. */
    buttons: AlertButton[];
}

interface DialogQueueState {
    dialogs: PendingDialog[];
}

export const useDialogQueue = create<DialogQueueState>(() => ({ dialogs: [] }));

let nextId = 1;

export function enqueueDialog(title: string, message?: string, buttons?: AlertButton[]): void {
    const dialog: PendingDialog = {
        id: nextId++,
        title,
        message,
        buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
    };
    useDialogQueue.setState((s) => ({ dialogs: [...s.dialogs, dialog] }));
}

/**
 * Closes the dialog, then runs the button's `onPress`. In that order, so a button that opens another dialog queues
 * it behind nothing. Does nothing if the dialog is already closed, so a double click runs the action once.
 */
export function pressDialogButton(id: number, index: number): void {
    const dialog = useDialogQueue.getState().dialogs.find((d) => d.id === id);
    if (dialog == undefined) {
        return;
    }
    useDialogQueue.setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
    const result = dialog.buttons[index]?.onPress?.() as unknown;
    if (result instanceof Promise) {
        // A rejected async handler would otherwise surface as an unhandled rejection with no context.
        result.catch((e) => console.warn(`[dialog] "${dialog.title}" button failed:`, e));
    }
}

/**
 * Escape or a click outside. Runs the cancel button if there is one, or the only button of a plain alert (that
 * button just acknowledges it, and the browser alert always ran it on close). A choice with no cancel button stays
 * open: dismissing it must not pick an action.
 */
export function dismissDialog(id: number): void {
    const dialog = useDialogQueue.getState().dialogs.find((d) => d.id === id);
    if (dialog == undefined) {
        return;
    }
    const cancelIndex = dialog.buttons.findIndex((b) => b.style === "cancel");
    if (cancelIndex >= 0) {
        pressDialogButton(id, cancelIndex);
    } else if (dialog.buttons.length === 1) {
        pressDialogButton(id, 0);
    }
}
