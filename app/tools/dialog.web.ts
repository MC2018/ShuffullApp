import type { AlertButton } from "react-native";
import { enqueueDialog } from "./dialogQueue";

/**
 * Web/desktop build of `dialog.ts`. Metro picks this over `dialog.ts` for the web platform.
 *
 * react-native-web's `Alert.alert` does nothing at all, which made every confirm in the app (playlist Delete,
 * Delete jam, Clear queue, Flag for replacement) a dead button on desktop. The browser's own `alert`/`confirm`
 * fixed that but froze the whole app while open (ShuffullApp#209), so the dialog is drawn in the app instead:
 * queued here, shown by `DialogHost`. Like native `Alert.alert`, this returns at once; buttons run when pressed.
 */
export function showAlert(title: string, message?: string, buttons?: AlertButton[]): void {
    enqueueDialog(title, message, buttons);
}
