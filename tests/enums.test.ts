import { describe, it, expect } from "vitest";
import { getProcessingMethod, ProcessingMethod, RequestType } from "@/app/enums";

describe("getProcessingMethod", () => {
    it("maps each request type to its declared processing method", () => {
        expect(getProcessingMethod(RequestType.Authenticate)).toBe(ProcessingMethod.OnlyOnce);
        expect(getProcessingMethod(RequestType.CreateUserSong)).toBe(ProcessingMethod.Batch);
        expect(getProcessingMethod(RequestType.OverallSync)).toBe(ProcessingMethod.None);
        expect(getProcessingMethod(RequestType.UpdateSongLastPlayed)).toBe(ProcessingMethod.Batch);
        expect(getProcessingMethod(RequestType.SetSongLikeStatus)).toBe(ProcessingMethod.Individual);
        expect(getProcessingMethod(RequestType.FlagSongForReplacement)).toBe(ProcessingMethod.Batch);
    });

    it("covers every RequestType value", () => {
        const numericValues = Object.values(RequestType).filter(v => typeof v === "number") as RequestType[];
        for (const value of numericValues) {
            // Each known type returns a defined ProcessingMethod (no undefined fall-through).
            expect(getProcessingMethod(value)).toBeTypeOf("number");
        }
    });
});
