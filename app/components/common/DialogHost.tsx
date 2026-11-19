import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "@/app/theme";
import { Button, Text } from "@/app/components/ui";
import { dismissDialog, pressDialogButton, useDialogQueue } from "@/app/tools/dialogQueue";

/**
 * Draws the web/desktop dialogs `showAlert` queues (see `dialogQueue.ts`), one at a time, oldest first. Mounted once
 * at the root. On native `showAlert` uses the system alert, so the queue stays empty and this draws nothing.
 *
 * Escape (react-native-web's Modal turns it into onRequestClose) and a click on the backdrop both dismiss: that runs
 * the cancel button, or the only button of a plain alert.
 */
export default function DialogHost() {
    const theme = useTheme();
    const dialog = useDialogQueue((s) => s.dialogs[0]);
    if (dialog == undefined) {
        return null;
    }

    return (
        <Modal transparent visible onRequestClose={() => dismissDialog(dialog.id)}>
            <View
                style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    padding: theme.space.xl,
                    backgroundColor: theme.color.scrim,
                }}
            >
                <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Dismiss" onPress={() => dismissDialog(dialog.id)} />
                <View
                    accessibilityRole="alert"
                    style={[
                        {
                            width: "100%",
                            maxWidth: 420,
                            gap: theme.space.md,
                            padding: theme.space.xl,
                            borderRadius: theme.radius.lg,
                            borderWidth: 1,
                            borderColor: theme.color.lineStrong,
                            backgroundColor: theme.color.bgDeep,
                        },
                        theme.shadow.modal,
                    ]}
                >
                    <Text variant="title">{dialog.title}</Text>
                    {dialog.message ? <Text color="textMuted">{dialog.message}</Text> : null}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.sm }}>
                        {dialog.buttons.map((button, index) => (
                            <Button
                                key={`${dialog.id}-${index}`}
                                label={button.text ?? "OK"}
                                variant={button.style === "cancel" ? "ghost" : "primary"}
                                onPress={() => pressDialogButton(dialog.id, index)}
                                style={{ flexGrow: 1, flexBasis: 120 }}
                            />
                        ))}
                    </View>
                </View>
            </View>
        </Modal>
    );
}
