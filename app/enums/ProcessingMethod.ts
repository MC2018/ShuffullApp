import { RequestType } from "./RequestType";

export enum ProcessingMethod {
    None = 0,
    OnlyOnce = 1,
    Individual = 2,
    Batch = 3
};

export function getProcessingMethod(requestType: RequestType): ProcessingMethod {
    switch (requestType) {
        case RequestType.Authenticate:
            return ProcessingMethod.OnlyOnce;
        case RequestType.CreateUserSong:
            return ProcessingMethod.Batch;
        case RequestType.OverallSync:
            return ProcessingMethod.None; // because it is always run
        case RequestType.UpdateSongLastPlayed:
            return ProcessingMethod.Batch;
        case RequestType.SetSongLikeStatus:
            // One POST per song (the endpoint is per-song); the latest queued value wins server-side.
            return ProcessingMethod.Individual;
        case RequestType.FlagSongForReplacement:
            // Idempotent per-song flag (server skips if one is already open); batch the posts together.
            return ProcessingMethod.Batch;
        case RequestType.UpdateSongMetadata:
            // One PUT per song (the endpoint is per-song); the latest queued edit wins server-side.
            return ProcessingMethod.Individual;
        case RequestType.SongRetag:
            // The endpoint takes a list of ids, so coalesce many queued promotions into one POST.
            return ProcessingMethod.Batch;
        case RequestType.DeletePlaylist:
            // One DELETE per playlist (the endpoint is per-playlist).
            return ProcessingMethod.Individual;
    }
}
