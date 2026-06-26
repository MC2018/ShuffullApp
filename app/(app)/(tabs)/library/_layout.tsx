import { Stack } from "expo-router";
import { color } from "@/app/theme";

export default function LibraryLayout() {
    // contentStyle keeps the card dark during the push slide (otherwise a white strip flashes at the edge).
    return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}
