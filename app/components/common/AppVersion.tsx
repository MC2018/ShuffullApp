import * as Application from "expo-application";
import { Text } from "@/app/components/ui";
import { formatInstalledBuild } from "@/app/tools/appVersion";
import { useTheme } from "@/app/theme";

const label = formatInstalledBuild({
    appName: Application.applicationName,
    version: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
});

// Which app and which commit this install is. Renders nothing on web/desktop, which have no native version.
export default function AppVersion() {
    const theme = useTheme();
    if (!label) {
        return null;
    }
    return (
        <Text variant="caption" color="textFaint" selectable style={{ textAlign: "center", marginTop: theme.space.xl }}>
            {label}
        </Text>
    );
}
