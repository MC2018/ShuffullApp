import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { parsePrefetchSetting } from "../../tools/prefetchCache";

interface PrefetchSettingState {
    // Starts false and stays false until the stored value is read, so nothing is fetched on a setting the user
    // may have turned off.
    enabled: boolean;
    loaded: boolean;
    set: (enabled: boolean) => void;
}

/** "Load upcoming songs ahead" (ShuffullApp#124). A user decision, so it lives in storage and outlives the process. */
export const usePrefetchSetting = create<PrefetchSettingState>((set) => ({
    enabled: false,
    loaded: false,
    set: (enabled) => set({ enabled, loaded: true }),
}));

export async function loadPrefetchSetting(): Promise<boolean> {
    const enabled = parsePrefetchSetting(await AsyncStorage.getItem(STORAGE_KEYS.PREFETCH_UPCOMING));
    usePrefetchSetting.getState().set(enabled);
    return enabled;
}

export async function savePrefetchSetting(enabled: boolean): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEYS.PREFETCH_UPCOMING, enabled ? "1" : "0");
    usePrefetchSetting.getState().set(enabled);
}
