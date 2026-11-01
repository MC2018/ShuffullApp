import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useServerReachability } from "@/app/services/connectivity/serverReachability";
import { Button, Card, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

// Says why only downloaded songs play while the server can't be reached (ShuffullApp#24), and offers a sync now
// rather than leave the user waiting out the sync's backoff, which grows to 5 minutes.
export default function OfflineBanner() {
    const theme = useTheme();
    const { reachability, checkNow } = useServerReachability();

    if (reachability !== "unreachable") {
        return null;
    }

    return (
        <Card style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md, marginBottom: theme.space.md }}>
            <Ionicons name="cloud-offline-outline" size={22} color={theme.color.accent} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyStrong">{"Can't reach the server"}</Text>
                <Text variant="caption" color="textMuted">
                    {"Playing downloaded songs. Likes and Keeps are saved and sent once it's back."}
                </Text>
            </View>
            {checkNow ? <Button label="Try again" variant="ghost" onPress={checkNow} /> : null}
        </Card>
    );
}
