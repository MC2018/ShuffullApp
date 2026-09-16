export const STORAGE_KEYS = {
    HOST_ADDRESS: "HOST_ADDRESS",
    CURRENT_USER_ID: "CURRENT_USER_ID",
    FOREGROUND_TIMER_ID: "FOREGROUND_TIMER_ID",
    CURRENT_SONG_FILTERS: "CURRENT_SONG_FILTERS",
    // Per-song manual lyrics offset nudge (ms), keyed by `${LYRICS_OFFSET_PREFIX}${songId}`. Applied on
    // top of the producer's already-baked trim shift to correct residual drift.
    LYRICS_OFFSET_PREFIX: "LYRICS_OFFSET:",
    // ISO timestamp cursor for incremental refresh of already-synced songs (GET /api/v1/songs/changed).
    // Seeded at the first sync so we never re-page the whole library; advanced to the newest Version seen.
    SONG_SYNC_CURSOR: "SONG_SYNC_CURSOR",
}