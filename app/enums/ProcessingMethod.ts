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
    }
}
