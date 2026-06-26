import { Stack } from "expo-router";
import { color } from "@/app/theme";

export default function AuthLayout() {
    return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}
