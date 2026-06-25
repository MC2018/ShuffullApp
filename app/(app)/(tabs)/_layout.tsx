import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { color } from "@/app/theme";

// Open on the Home tab, matching the previous react-navigation initialRouteName.
export const unstable_settings = {
    initialRouteName: "home",
};

// Bottom tab bar: Songs | Home | Library (Home center). Themed to the Oxblood palette. The persistent
// PlayerBar is rendered inside each screen, above this bar.
export default function TabsLayout() {
    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: color.accent,
                tabBarInactiveTintColor: color.textFaint,
                tabBarStyle: { backgroundColor: color.bgDeep, borderTopColor: color.line, borderTopWidth: 1 },
                tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
            }}
        >
            <Tabs.Screen
                name="songs"
                options={{ title: "Songs", tabBarIcon: ({ color: c, size }) => <Ionicons name="musical-notes" size={size} color={c} /> }}
            />
            <Tabs.Screen
                name="home"
                options={{ title: "Home", tabBarIcon: ({ color: c, size }) => <Ionicons name="home" size={size} color={c} /> }}
            />
            <Tabs.Screen
                name="library"
                options={{ title: "Library", tabBarIcon: ({ color: c, size }) => <Ionicons name="library" size={size} color={c} /> }}
            />
        </Tabs>
    );
}
