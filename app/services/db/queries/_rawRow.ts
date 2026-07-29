/**
 * Row-shape normaliser for RAW `sql` queries.
 *
 * Drizzle can field-map the results of its query BUILDER, but a hand-written `sql` template has no field
 * metadata, so `db.all()` returns whatever the driver produced — and the two drivers disagree:
 *
 *   expo-sqlite (mobile)   row OBJECTS keyed by the SELECT's column aliases
 *   sqlite-proxy (web)     positional ARRAYS of values
 *
 * Reading `row.songId` therefore works on mobile and silently yields `undefined` on web. Nothing throws; the
 * value just goes missing, which is how the desktop Play button ended up picking a song id of `undefined` out
 * of a perfectly good 237-row pool and doing nothing at all.
 *
 * Pass the column names in SELECT ORDER. Rows that are already objects are returned untouched, so the same
 * call is correct on both platforms.
 */
export function namedRows<T>(rows: readonly unknown[], columns: readonly (keyof T)[]): T[] {
    return rows.map((row) => {
        if (!Array.isArray(row)) {
            return row as T;
        }

        const named = {} as T;
        columns.forEach((column, index) => {
            named[column] = row[index];
        });
        return named;
    });
}
