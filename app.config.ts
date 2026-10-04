import { ExpoConfig } from "expo/config";
import { version } from "./package.json";

// Two Android apps install side by side: the daily driver ("Shuffull", the real app ID, JS bundled in) and
// the Expo dev client ("Shuffull Dev", ".dev" suffix, needs Metro). android/ is committed and is what the
// build actually uses: android/app/build.gradle sets the IDs, names and schemes per build type. This file
// mirrors it so that `expo prebuild` and the JS-visible config (Constants.expoConfig) agree with the native
// side. Select with APP_VARIANT=development|production; unset means production.
//
// The slug stays "shuffull-app": the EAS project and the dev client's exp+shuffull-app:// scheme hang off it.
const variant = process.env.APP_VARIANT === "development" ? "development" : "production";
const isDev = variant === "development";
const appId = isDev ? "com.mc2018.shuffullapp.dev" : "com.mc2018.shuffullapp";

const config: ExpoConfig = {
    name: isDev ? "Shuffull Dev" : "Shuffull",
    slug: "shuffull-app",
    version,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: isDev ? "shuffull-dev" : "shuffull",
    userInterfaceStyle: "automatic",
    splash: {
        image: "./assets/images/splash.png",
        resizeMode: "contain",
        backgroundColor: "#ffffff",
    },
    ios: {
        supportsTablet: true,
        bundleIdentifier: appId,
    },
    android: {
        adaptiveIcon: {
            foregroundImage: "./assets/images/adaptive-icon.png",
            backgroundColor: isDev ? "#E8590C" : "#ffffff",
        },
        package: appId,
        permissions: ["android.permission.POST_NOTIFICATIONS"],
    },
    web: {
        bundler: "metro",
        output: "single",
        favicon: "./assets/images/favicon.png",
    },
    plugins: ["expo-router", "expo-font", "expo-asset", "./plugins/withNotificationActionIcons"],
    experiments: {
        typedRoutes: true,
    },
    extra: {
        appVariant: variant,
        router: {
            origin: false,
        },
        eas: {
            projectId: "f9b05c26-f57b-4c72-b26a-3eb269e45123",
        },
    },
    owner: "mc_2018",
};

export default config;
