/**
 * Splitting helpers for statements whose size is driven by how much data the sync happens to pull.
 *
 * A single SQLite statement is bounded in ways this app can hit with an ordinary library. A multi-row
 * `INSERT ... VALUES (...),(...),...` is compiled as a compound SELECT (SQLITE_MAX_COMPOUND_SELECT, commonly
 * 500 terms) and every placeholder counts against the bind-variable cap (SQLITE_MAX_VARIABLE_NUMBER, 999 in
 * older builds). Those limits are BUILD-SPECIFIC, and the web/wasm build is tighter than native's: a sync
 * that inserted 1357 user_songs in one statement (6785 parameters) failed on desktop with a bare
 * "Error finalizing statement" while working fine on Android.
 *
 * So the row count is capped rather than trusted. The caps are deliberately below the smallest documented
 * limits — the cost is a few extra local statements, and the benefit is that the write path no longer has a
 * silent ceiling that a growing library eventually crosses on EVERY platform, native included.
 */

/** Comfortably under the classic 999 bind-variable limit. */
const MAX_BIND_PARAMS = 900;

/** Comfortably under the classic 500-term compound-SELECT limit. */
const MAX_ROWS_PER_STATEMENT = 250;

function split<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/**
 * Splits rows for a multi-row insert, sized so neither the row-count nor the parameter-count limit is hit.
 * The column count is derived from the rows themselves (Drizzle emits one placeholder per column per row),
 * using the widest row so a partially-populated first row can't under-count.
 */
export function chunkRows<T extends object>(rows: T[]): T[][] {
    if (!rows.length) {
        return [];
    }

    const columns = Math.max(1, ...rows.map((row) => Object.keys(row).length));
    const size = Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_BIND_PARAMS / columns)));
    return split(rows, size);
}

/**
 * Splits an id list for `inArray(...)`, which binds one parameter per id. Not a compound select, so only the
 * parameter cap applies.
 */
export function chunkIds<T>(ids: T[]): T[][] {
    if (!ids.length) {
        return [];
    }
    return split(ids, MAX_BIND_PARAMS);
}
