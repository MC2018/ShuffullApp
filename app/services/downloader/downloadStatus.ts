import { create } from "zustand";
import { DownloadStatus } from "@/app/tools/downloadStatus";

// Reactive mirror of what the Downloader is doing, following the mediaManager pattern (useActiveSong /
// usePlaybackIssue): the service is the only writer, screens subscribe. Lives in its own module because
// Downloader.ts throws at module scope on web (no documentDirectory), and this must be importable everywhere.
interface DownloadStatusState {
    status: DownloadStatus;
    setStatus: (patch: Partial<DownloadStatus>) => void;
}

export const useDownloadStatus = create<DownloadStatusState>((set) => ({
    status: { phase: "idle", queuedCount: 0, completedCount: 0 },
    setStatus: (patch) => set((state) => ({ status: { ...state.status, ...patch } })),
}));
