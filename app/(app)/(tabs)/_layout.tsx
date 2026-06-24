import { Tabs } from "expo-router";

// Open on the Home tab, matching the previous react-navigation initialRouteName.
export const unstable_settings = {
    initialRouteName: "home",
};

// Bottom tab bar: Songs | Home | Library (declared in that left-to-right order). Each tab that owns a
// nested flow (home, library) is a directory with its own Stack layout. The persistent PlayerBar is
// rendered inside each screen (above the tab bar), preserving the prior behaviour.
export default function TabsLayout() {
    return (
        <Tabs screenOptions={{ headerShown: false }}>
            <Tabs.Screen name="songs" options={{ title: "Songs" }} />
            <Tabs.Screen name="home" options={{ title: "Home" }} />
            <Tabs.Screen name="library" options={{ title: "Library" }} />
        </Tabs>
    );
}
