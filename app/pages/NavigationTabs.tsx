import { View, Text } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Home from "./Home";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { useEffect, useState } from "react";
import Songs from "./Songs";
import { useDb } from "../services/db/DbProvider";
import { logout } from "../services/LogoutHandler";

const Tab = createBottomTabNavigator();

export default function NavigationTabs() {
    const [ userId, setUserId ] = useState<number | undefined>(undefined);
    const db = useDb();

    // Logout check
    useEffect(() => {
        (async () => {
            const currentUserId = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);

            if (currentUserId == null) {
                logout();
                return;
            }

            setUserId(parseInt(currentUserId));
        })();
    });

    if (userId == undefined) {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

    return (
        <Tab.Navigator screenOptions={{ headerShown: false }}>
            <Tab.Screen name="Songs" component={Songs} />
            <Tab.Screen name="Home" component={Home} initialParams={{ userId }} />
        </Tab.Navigator>
    );
}
