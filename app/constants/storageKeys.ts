export const STORAGE_KEYS = {
    HOST_ADDRESS: "HOST_ADDRESS",
    CURRENT_USER_ID: "CURRENT_USER_ID",
    CURRENT_SONG_FILTERS: "CURRENT_SONG_FILTERS",
    // Per-song manual lyrics offset nudge (ms), keyed by `${LYRICS_OFFSET_PREFIX}${songId}`. Applied on
    // top of the producer's already-baked trim shift to correct residual drift.
    LYRICS_OFFSET_PREFIX: "LYRICS_OFFSET:",
    // ISO timestamp cursor for incremental refresh of already-synced songs (GET /api/v1/songs/changed).
    // Seeded at the first sync so we never re-page the whole library; advanced to the newest Version seen, kept as
    // the exact string the server sent (older builds read it as a Date, which still parses).
    SONG_SYNC_CURSOR: "SONG_SYNC_CURSOR",
    // JSON FeedKey { version, songId } of the row SONG_SYNC_CURSOR came from, so the next sync can send `afterId`.
    // Used only while its version equals SONG_SYNC_CURSOR (see songFeedStart).
    SONG_SYNC_KEY: "SONG_SYNC_KEY",
    // "1" while the user has paused background downloads. A user decision, so it outlives the process.
    DOWNLOADS_PAUSED: "DOWNLOADS_PAUSED",
    // The audition playlist that still had unheard songs when the current song started. Kept across restarts so
    // that resuming the mix's last song after the app was killed still stops when it ends.
    AUDITION_IN_PROGRESS: "AUDITION_IN_PROGRESS",
    // Epoch ms of the last check that every local song still exists on the server (SyncManager.reconcileSongs).
    SONG_RECONCILE_AT: "SONG_RECONCILE_AT",
    // JSON SongReconcileState: the song ids that check missed, purged only if the next check misses them too.
    SONG_RECONCILE_STATE: "SONG_RECONCILE_STATE",
}