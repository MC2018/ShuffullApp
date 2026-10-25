import type { AlertButton } from "react-native";

/** The two browser dialogs this needs; a parameter so tests can supply their own. */
export interface BrowserDialogs {
    alert(message: string): void;
    confirm(message: string): boolean;
}

/**
 * Web/desktop build of `dialog.ts`. Metro picks this over `dialog.ts` for the web platform.
 *
 * react-native-web's `Alert.alert` does nothing at all, which made every confirm in the app (playlist Delete,
 * Delete jam, Clear queue, Flag for replacement) a dead button on desktop. The browser only has OK and OK/Cancel,
 * so the buttons map onto those:
 * - zero or one button: `window.alert`, then that button's `onPress`, if any.
 * - two or more: `window.confirm`. OK runs the last non-cancel button, Cancel runs the cancel button, if any.
 * The browser can't show two action buttons. Nothing in the app passes that; if something does, the last one wins.
 */
export function showAlert(title: string, message?: string, buttons?: AlertButton[], dialogs: BrowserDialogs = window): void {
    const text = message ? `${title}\n\n${message}` : title;
    if (!buttons || buttons.length <= 1) {
        dialogs.alert(text);
        buttons?.[0]?.onPress?.();
        return;
    }
    const cancel = buttons.find(b => b.style === "cancel");
    const actions = buttons.filter(b => b.style !== "cancel");
    if (dialogs.confirm(text)) {
        actions[actions.length - 1]?.onPress?.();
    } else {
        cancel?.onPress?.();
    }
}
