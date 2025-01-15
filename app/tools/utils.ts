import uuid from "react-native-uuid";

export function distinctBy<T, K>(array: T[], keySelector: (item: T) => K): T[] {
    const seen = new Set<K>();
    return array.filter(item => {
        const key = keySelector(item);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

export function generateGuid() {
    return uuid.v4();
}

export function generateRange(x: number): number[] {
    return Array.from({ length: x }, (_, i) => i);
}
