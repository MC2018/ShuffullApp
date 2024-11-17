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