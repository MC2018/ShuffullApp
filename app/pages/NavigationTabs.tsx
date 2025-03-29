import { View, Text } from "react-native";
import { NavigationContainer, TypedNavigator } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createStackNavigator } from "@react-navigation/stack";
import Home from "./Home";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { useEffect, useState } from "react";
import SongsStackScreen from "./Songs";
import { useDb } from "../services/db/DbProvider";
import { logout } from "../services/LogoutProvider";
import LibraryStackScreen from "./Library";
import Playlist from "./Playlist";
import HomeStackScreen from "./Home";

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

function Tabs({ navigation, route }: any) {
    return (
        <Tab.Navigator initialRouteName="HomeStack" screenOptions={{ headerShown: false }}>
            <Tab.Screen name="SongsStack" options={{ title: "Songs" }} component={SongsStackScreen} initialParams={route.params} />
            <Tab.Screen name="HomeStack" options={{ title: "Home" }} component={HomeStackScreen} initialParams={route.params} />
            <Tab.Screen name="LibraryStack" options={{ title: "Library" }} component={LibraryStackScreen} initialParams={route.params} />
        </Tab.Navigator>
    );
}

export default function NavigationTabs() {
    const [ userId, setUserId ] = useState<number | undefined>(undefined);

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
    }, []);

    if (userId == undefined) {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

    return (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
            {/* Main tabs */}
            <Stack.Screen name="MainTabs" component={Tabs} initialParams={{ userId }} />
        </Stack.Navigator>
    );
}






// import { View, Text } from "react-native";
// import { NavigationContainer } from "@react-navigation/native";
// import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
// import { createStackNavigator } from "@react-navigation/stack";
// import Home from "./Home";
// import AsyncStorage from "@react-native-async-storage/async-storage";
// import { STORAGE_KEYS } from "../constants/storageKeys";
// import { useEffect, useState } from "react";
// import Songs from "./Songs";
// import { useDb } from "../services/db/DbProvider";
// import { logout } from "../services/LogoutProvider";
// import Library from "./Library";
// import Playlist from "./Playlist";

// const Tab = createBottomTabNavigator();
// const Stack = createStackNavigator();

// function Tabs({ navigation, route }: any) {
//     const { userId } = route.params;

//     return (
//         <Tab.Navigator screenOptions={{ headerShown: false }}>
//             <Tab.Screen name="Songs" component={Songs} />
//             <Tab.Screen name="Home" component={Home} />
//             <Tab.Screen name="Library" component={Library} initialParams={{ userId }} />
//             <Tab.Screen 
//                 name="Playlist" 
//                 component={Playlist} 
//                 options={{ tabBarButton: () => null }} 
//             />
//         </Tab.Navigator>
//     );
// }

// export default function NavigationTabs() {
//     const [ userId, setUserId ] = useState<number | undefined>(undefined);

//     // Logout check
//     useEffect(() => {
//         (async () => {
//             const currentUserId = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);

//             if (currentUserId == null) {
//                 logout();
//                 return;
//             }

//             setUserId(parseInt(currentUserId));
//         })();
//     });

//     if (userId == undefined) {
//         return (
//             <View>
//                 <Text>Loading...</Text>
//             </View>
//         );
//     }

//     return (
//         <Stack.Navigator screenOptions={{ headerShown: false }}>
//             {/* Main tabs */}
//             <Stack.Screen name="MainTabs" component={Tabs} initialParams={{ userId }} />
                
//             {/* Hidden screen (not in bottom tab) */}
//             <Stack.Screen name="Playlist" component={Playlist} />
//         </Stack.Navigator>
//     );
// }
