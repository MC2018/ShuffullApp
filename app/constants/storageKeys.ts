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
    // The SONG_FIELDS_REVISION a full songs check has filled in on every local song (SyncManager.reconcileSongs).
    SONG_FIELDS_REVISION: "SONG_FIELDS_REVISION",
    // "1" while the user has paused background downloads. A user decision, so it outlives the process.
    DOWNLOADS_PAUSED: "DOWNLOADS_PAUSED",
    // The audition playlist that still had unheard songs when the current song started. Kept across restarts so
    // that resuming the mix's last song after the app was killed still stops when it ends.
    AUDITION_IN_PROGRESS: "AUDITION_IN_PROGRESS",
    // Epoch ms of the last check that every local song still exists on the server (SyncManager.reconcileSongs).
    SONG_RECONCILE_AT: "SONG_RECONCILE_AT",
    // JSON SongReconcileState: the song ids that check missed, purged only if the next check misses them too.
    SONG_RECONCILE_STATE: "SONG_RECONCILE_STATE",
    // The account the shared song cache (songs, artists, tags, downloads) was last synced for, and its host (for the log
    // only). A different account logging in clears the cache first (services/auth/accountSwitch, ShuffullApp#193).
    SONG_CACHE_USER_ID: "SONG_CACHE_USER_ID",
    SONG_CACHE_HOST: "SONG_CACHE_HOST",
    // "0" once the user has turned off "Load upcoming songs ahead". Anything else, unset included, means on.
    PREFETCH_UPCOMING: "PREFETCH_UPCOMING",
    // JSON SavedRecap { recap, fetchedAt }: the last fetched December recap, keyed by `${RECAP_PREFIX}${userId}:${year}`
    // (recapCacheKey), so the recap screen can still show it offline.
    RECAP_PREFIX: "RECAP:",
    // JSON string[]: an audition mix's songs quick-skipped on the deck's first pass and not yet heard, keyed by
    // `${AUDITION_QUICK_SKIPS_PREFIX}${userId}:${playlistId}` (services/audition/quickSkipStore). Removed once the
    // list is empty or the mix is deleted on this device. Never synced: a quick skip must not look like a listen.
    AUDITION_QUICK_SKIPS_PREFIX: "AUDITION_QUICK_SKIPS:",
    // This install's id, a UUID made on first launch (services/device, ShuffullApp#58). Never removed: logging out
    // keeps it, so the same install stays the same device across accounts and sessions.
    DEVICE_ID: "DEVICE_ID",
    // The name the user gave this device in Settings. Unset means the default (tools/device defaultDeviceName). Logging
    // out or switching accounts keeps it, on purpose: it names the device, not the account. Only clearing it in
    // Settings removes it.
    DEVICE_NAME: "DEVICE_NAME",
};
