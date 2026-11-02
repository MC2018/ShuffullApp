// Mirrors the SITE's Shuffull.Core.Models.Enums.SongRequestStatus, sent as its int. 1 to 4 are the producer's progress
// reports; the rest are the API's own. Failed is still open: requesting the song again puts it back to Pending.
export enum SongRequestStatus {
    Pending = 0,
    Accepted = 1,
    Downloading = 2,
    Retrying = 3,
    Failed = 4,
    Completed = 5,
    Cancelled = 6,
}
