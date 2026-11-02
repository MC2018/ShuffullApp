import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { Button, IconButton, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { useAuthStore } from "@/app/services/auth/authStore";
import { changePassword } from "@/app/services/auth/auth";
import { describePasswordChangeFailure, validatePasswordChange } from "@/app/services/auth/passwordChange";

// Change password (ShuffullApp#158), opened from Settings. On success this device stays signed in on the new session
// the server returns; every other device signs out on its next sync. A wrong current password just shows the
// server's message.
export default function ChangePasswordScreen() {
    const theme = useTheme();
    const hostAddress = useAuthStore((state) => state.hostAddress) ?? "";
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [changed, setChanged] = useState(false);

    const submit = async () => {
        const invalid = validatePasswordChange({ currentPassword, newPassword, confirmPassword });
        setError(invalid);
        if (invalid) {
            return;
        }

        setSaving(true);
        try {
            await changePassword(currentPassword, newPassword);
            setChanged(true);
        } catch (e) {
            setError(describePasswordChangeFailure(e, hostAddress));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.md }}>
                <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                <Text variant="screenTitle">Change password</Text>
            </View>

            {changed ? (
                <View style={{ gap: theme.space.md }}>
                    <Text variant="body">Your password is changed.</Text>
                    <Text variant="caption" color="textMuted">
                        {"You're still signed in here. Your other devices will sign out the next time they sync."}
                    </Text>
                    <Button label="Done" onPress={() => router.back()} full />
                </View>
            ) : (
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: theme.space.md }}>
                    <TextField value={currentPassword} onChangeText={setCurrentPassword} placeholder="Current password" secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="Current password" />
                    <TextField value={newPassword} onChangeText={setNewPassword} placeholder="New password" secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="New password" />
                    <TextField value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Confirm new password" secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="Confirm new password" />
                    <Text variant="caption" color="textFaint">
                        Your other devices will sign out and need the new password.
                    </Text>
                    <Button label={saving ? "Changing…" : "Change password"} onPress={submit} disabled={saving} full />
                    {error != null ? (
                        <Text variant="caption" style={{ color: theme.color.accent, textAlign: "center" }}>
                            {error}
                        </Text>
                    ) : null}
                </ScrollView>
            )}
        </Screen>
    );
}
