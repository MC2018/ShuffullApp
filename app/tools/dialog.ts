import { Alert, AlertButton } from "react-native";

/**
 * Shows an alert or confirm. Use this, never `Alert.alert` directly: react-native-web's `Alert` is an empty stub,
 * so on desktop a bare `Alert.alert` shows nothing and its buttons' callbacks never run. `dialog.web.ts` is the
 * desktop build of this module.
 */
export function showAlert(title: string, message?: string, buttons?: AlertButton[]): void {
    Alert.alert(title, message, buttons);
}
