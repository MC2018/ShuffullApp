import { LikeStatus } from "@/app/enums";

// Audition mode (ShuffullApp#125): a flip-through deck over an audition mix's unheard songs. This module is the
// whole of its logic - the heard rule, the two laps, the verdicts and what moves the deck - with the player and
// the database behind a port, so it runs in a unit test. mediaManager supplies the real port.
//
// THE TRAP this is built around (hub CLAUDE.md, "The audition ladder"): the normal player stamps `lastPlayed` the
// moment a song STARTS, and deriveAuditionRowState reads any stamp as "heard". A heard, unkept song is purged with
// its mix. A deck you flick through in seconds would mark every song heard that way, so here nothing is stamped
// until the heard rule says so: `markHeard` is the only call that writes `lastPlayed`, and `load` writes nothing.

/** Seconds of actual playback, summed across visits, after which a song counts as heard. */
export const HEARD_SECONDS = 20;
/** Where lap 1 starts a song until the start point syncs (ShuffullApp#126). Lap 2 always starts at 0:00. */
export const DEFAULT_START_FRACTION = 0.35;
/** How many songs ahead of the current one are handed to the prefetcher. */
export const PREFETCH_AHEAD = 2;

/** 20 s, or half the song when it is shorter than 40 s. Unknown duration counts as a long song. */
export function heardThresholdSeconds(durationSeconds: number | undefined): number {
    return durationSeconds != undefined && durationSeconds > 0
        ? Math.min(HEARD_SECONDS, durationSeconds / 2)
        : HEARD_SECONDS;
}

export interface AuditionPort {
    /** Loads the song and starts it at `startFraction` of its length. Must NOT stamp it as played. */
    load(songId: string, startFraction: number): Promise<void>;
    resume(): Promise<void>;
    pause(): Promise<void>;
    seekTo(seconds: number): Promise<void>;
    /** Records a rating through the normal path (so a Like re-tags), WITHOUT moving the player on. */
    rate(songId: string, likeStatus: LikeStatus): Promise<void>;
    /** Records a Keep through the normal /songs/keep path. */
    keep(songId: string): Promise<void>;
    /** Stamps the song as played. The only write that makes a song "heard" by time. */
    markHeard(songId: string): Promise<void>;
    prefetch(songIds: string[]): void;
}

type Entry = { songId: string; lap: 1 | 2 };

type SongProgress = {
    secondsHeard: number;
    // Wall-clock ms when this song last went into the Playing state, while it is playing. Real time spent playing
    // is what counts: a pause adds nothing, and a seek forward adds nothing either.
    playingSince: number | undefined;
    durationSeconds: number | undefined;
    heard: boolean;
    // markHeard has been called (or is in flight). Separate from `heard` so a stamp is never written twice.
    stamped: boolean;
    quickSkippedInLap1: boolean;
    likeStatus: LikeStatus;
    kept: boolean;
};

export type AuditionSummary = {
    kept: number;
    liked: number;
    loved: number;
    disliked: number;
    passed: number;
    unheard: number;
};

export type AuditionNotice = { kind: "lap2"; count: number };

export interface AuditionSnapshot {
    songId: string | undefined;
    position: number; // 1-based, over both laps
    total: number;
    lap: 1 | 2;
    finished: boolean;
    notice: AuditionNotice | undefined;
    likeStatus: LikeStatus;
    kept: boolean;
    heard: boolean;
    summary: AuditionSummary;
}

export class AuditionSession {
    private readonly entries: Entry[];
    private readonly lap1Length: number;
    private readonly songs = new Map<string, SongProgress>();
    private index = 0;
    private lap2Built = false;
    private finished = false;
    private notice: AuditionNotice | undefined;
    private readonly listeners = new Set<() => void>();
    // One operation at a time: each reads the deck, awaits the player, then moves it. Two flicks in a row must
    // see each other's result, not both start from the same index.
    private chain: Promise<void> = Promise.resolve();
    // The database writes, in order. A stamp is not awaited by the deck, but it must land before the rating that
    // follows it: for a song with no UserSong row yet, both would otherwise try to create it.
    private writes: Promise<void> = Promise.resolve();

    /** `songIds` are the mix's unheard songs, so none of them has a rating or a Keep yet. */
    constructor(
        songIds: string[],
        private readonly port: AuditionPort,
        private readonly now: () => number = Date.now,
        private readonly startFraction: number = DEFAULT_START_FRACTION,
    ) {
        this.entries = songIds.map(songId => ({ songId, lap: 1 as const }));
        this.lap1Length = this.entries.length;
        for (const songId of songIds) {
            this.songs.set(songId, {
                secondsHeard: 0,
                playingSince: undefined,
                durationSeconds: undefined,
                heard: false,
                stamped: false,
                quickSkippedInLap1: false,
                likeStatus: LikeStatus.Neutral,
                kept: false,
            });
        }
        this.finished = this.entries.length === 0;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    snapshot(): AuditionSnapshot {
        const entry = this.current();
        const progress = entry ? this.songs.get(entry.songId) : undefined;
        return {
            songId: entry?.songId,
            position: Math.min(this.index + 1, this.entries.length),
            total: this.entries.length,
            lap: entry?.lap ?? (this.lap2Built && this.entries.length > this.lap1Length ? 2 : 1),
            finished: this.finished,
            notice: this.notice,
            likeStatus: progress?.likeStatus ?? LikeStatus.Neutral,
            kept: progress?.kept ?? false,
            heard: progress?.heard ?? false,
            summary: this.summary(),
        };
    }

    /** Seconds heard so far for `songId`, including the stretch playing right now. */
    secondsHeard(songId: string): number {
        const progress = this.songs.get(songId);
        if (progress == undefined) {
            return 0;
        }
        const running = progress.playingSince != undefined ? (this.now() - progress.playingSince) / 1000 : 0;
        return progress.secondsHeard + Math.max(0, running);
    }

    start(): Promise<void> {
        return this.run(async () => {
            if (!this.finished) {
                await this.loadCurrent();
            }
        });
    }

    /** The player went into or out of the Playing state. Only time spent Playing counts toward heard. */
    onPlaybackState(playing: boolean): void {
        const entry = this.current();
        if (entry == undefined || this.finished) {
            return;
        }
        const progress = this.songs.get(entry.songId)!;
        if (playing && progress.playingSince == undefined) {
            progress.playingSince = this.now();
        } else if (!playing) {
            this.stopClock(progress);
        }
    }

    /**
     * Called about once a second while the deck is open: stamps the current song the moment it crosses the bar.
     * `playing` re-syncs the clock with the player, for a track change that went from Playing to Playing without
     * a state event in between. `playerSongId` is the song the player has loaded; a tick for any other is ignored.
     */
    tick(durationSeconds?: number, playing?: boolean, playerSongId?: string): void {
        const entry = this.current();
        if (entry == undefined || this.finished) {
            return;
        }
        // Mid-change the player still reports the outgoing song, whose length is not this one's.
        if (playerSongId != undefined && playerSongId !== entry.songId) {
            return;
        }
        if (playing != undefined) {
            this.onPlaybackState(playing);
        }
        const progress = this.songs.get(entry.songId)!;
        if (durationSeconds != undefined && durationSeconds > 0) {
            progress.durationSeconds = durationSeconds;
        }
        if (!progress.heard && this.secondsHeard(entry.songId) >= heardThresholdSeconds(progress.durationSeconds)) {
            this.markHeard(entry.songId);
        }
    }

    /** A flick down the deck (or the lock screen's Next). Under the heard bar with no verdict, it's a quick skip. */
    next(): Promise<void> {
        return this.run(() => this.advance("skip"));
    }

    /** Back up the deck, to replay and re-rate the song before. On the first song, replays it. */
    previous(): Promise<void> {
        return this.run(async () => {
            if (this.finished) {
                return;
            }
            this.leaveCurrent();
            if (this.index > 0) {
                this.index--;
            }
            await this.loadCurrent();
        });
    }

    /** Swipe right. Counts as heard at once, and moves on. */
    like(): Promise<void> {
        return this.run(async () => {
            await this.rateCurrent(LikeStatus.Like);
            await this.advance("verdict");
        });
    }

    /** Swipe left. Counts as heard at once, and moves on - once: the player's own skip-on-dislike stays out of it. */
    dislike(): Promise<void> {
        return this.run(async () => {
            await this.rateCurrent(LikeStatus.Dislike);
            await this.advance("verdict");
        });
    }

    /** The heart button. Stays on the song. Pressing it on a loved song takes the love back off. */
    love(): Promise<void> {
        return this.run(async () => {
            const entry = this.current();
            if (entry == undefined || this.finished) {
                return;
            }
            const loved = this.songs.get(entry.songId)!.likeStatus === LikeStatus.Love;
            await this.rateCurrent(loved ? LikeStatus.Neutral : LikeStatus.Love);
        });
    }

    /** Any rating from outside the deck's own gestures (the notification's buttons). Moves on only as a swipe would. */
    rateFromRemote(likeStatus: LikeStatus): Promise<void> {
        if (likeStatus === LikeStatus.Like) {
            return this.like();
        }
        if (likeStatus === LikeStatus.Dislike) {
            return this.dislike();
        }
        return this.run(() => this.rateCurrent(likeStatus));
    }

    /** The bookmark button: Keep through the normal path. One-way, and it stays on the song. */
    keep(): Promise<void> {
        return this.run(async () => {
            const entry = this.current();
            if (entry == undefined || this.finished) {
                return;
            }
            const progress = this.songs.get(entry.songId)!;
            if (progress.kept) {
                return;
            }
            progress.kept = true;
            this.markHeard(entry.songId);
            this.emit();
            await this.write(() => this.port.keep(entry.songId));
        });
    }

    fromStart(): Promise<void> {
        return this.run(async () => {
            if (!this.finished) {
                await this.port.seekTo(0);
            }
        });
    }

    resume(): Promise<void> {
        return this.run(async () => {
            if (!this.finished) {
                await this.port.resume();
            }
        });
    }

    pause(): Promise<void> {
        return this.run(() => this.port.pause());
    }

    /** The song played to its end with no input: heard, and on to the next. Ignored if it is no longer current. */
    onEnded(songId: string | undefined): Promise<void> {
        return this.run(async () => {
            const entry = this.current();
            if (entry == undefined || this.finished || entry.songId !== songId) {
                return;
            }
            this.markHeard(entry.songId);
            await this.advance("ended");
        });
    }

    dismissNotice(): void {
        if (this.notice != undefined) {
            this.notice = undefined;
            this.emit();
        }
    }

    private run(task: () => Promise<void>): Promise<void> {
        const result = this.chain.then(task);
        this.chain = result.catch(() => undefined);
        return result;
    }

    /** Resolves once every step and write queued so far has finished, failed ones included. */
    async settled(): Promise<void> {
        await this.chain;
        await this.writes;
    }

    private write(task: () => Promise<void>): Promise<void> {
        const result = this.writes.then(task);
        this.writes = result.catch(() => undefined);
        return result;
    }

    private current(): Entry | undefined {
        return this.finished ? undefined : this.entries[this.index];
    }

    private async rateCurrent(likeStatus: LikeStatus) {
        const entry = this.current();
        if (entry == undefined) {
            return;
        }
        const progress = this.songs.get(entry.songId)!;
        // Any verdict counts as heard at once, whatever the time.
        this.markHeard(entry.songId);
        // Re-rating a song with the rating it already has writes nothing: a second Like would be a second outbox row.
        if (progress.likeStatus === likeStatus) {
            return;
        }
        progress.likeStatus = likeStatus;
        this.emit();
        await this.write(() => this.port.rate(entry.songId, likeStatus));
    }

    private markHeard(songId: string) {
        const progress = this.songs.get(songId);
        if (progress == undefined || progress.stamped) {
            return;
        }
        progress.heard = true;
        progress.stamped = true;
        this.emit();
        void this.write(() => this.port.markHeard(songId)).catch(error => {
            // Not heard after all, as far as the database knows: let a later tick or verdict try again. Failing
            // this way only ever leaves a song unheard, which replays it; it never makes one purgeable.
            progress.stamped = false;
            progress.heard = false;
            console.warn(`[audition] could not mark ${songId} heard:`, error);
        });
    }

    private stopClock(progress: SongProgress) {
        if (progress.playingSince != undefined) {
            progress.secondsHeard += Math.max(0, (this.now() - progress.playingSince) / 1000);
            progress.playingSince = undefined;
        }
    }

    /** Settles the current song's clock (and stamps it if that took it over the bar) before the deck moves. */
    private leaveCurrent() {
        const entry = this.current();
        if (entry == undefined) {
            return;
        }
        const progress = this.songs.get(entry.songId)!;
        this.stopClock(progress);
        if (!progress.heard && progress.secondsHeard >= heardThresholdSeconds(progress.durationSeconds)) {
            this.markHeard(entry.songId);
        }
    }

    private async advance(reason: "skip" | "verdict" | "ended") {
        const entry = this.current();
        if (entry == undefined) {
            return;
        }
        this.leaveCurrent();
        const progress = this.songs.get(entry.songId)!;

        if (reason === "skip" && !progress.heard) {
            if (entry.lap === 1) {
                // Quick skip on the first pass: not heard, it comes round again in lap 2.
                progress.quickSkippedInLap1 = true;
            } else {
                // A second quick skip is a verdict of its own: the song had its chance.
                this.markHeard(entry.songId);
            }
        }

        this.index++;
        if (this.index >= this.entries.length && !this.lap2Built) {
            this.lap2Built = true;
            const lap2 = this.entries
                .slice(0, this.lap1Length)
                .filter(e => {
                    const p = this.songs.get(e.songId)!;
                    return p.quickSkippedInLap1 && !p.heard;
                })
                .map(e => ({ songId: e.songId, lap: 2 as const }));
            if (lap2.length > 0) {
                this.entries.push(...lap2);
                this.notice = { kind: "lap2", count: lap2.length };
            }
        }

        if (this.index >= this.entries.length) {
            await this.finish();
            return;
        }

        await this.loadCurrent();
    }

    private async finish() {
        this.finished = true;
        this.index = this.entries.length;
        this.notice = undefined;
        this.port.prefetch([]);
        this.emit();
        await this.port.pause();
    }

    private async loadCurrent() {
        const entry = this.current();
        if (entry == undefined) {
            return;
        }
        this.emit();
        this.port.prefetch(this.entries.slice(this.index + 1, this.index + 1 + PREFETCH_AHEAD).map(e => e.songId));
        await this.port.load(entry.songId, entry.lap === 1 ? this.startFraction : 0);
    }

    private summary(): AuditionSummary {
        const summary: AuditionSummary = { kept: 0, liked: 0, loved: 0, disliked: 0, passed: 0, unheard: 0 };
        for (const progress of this.songs.values()) {
            if (progress.likeStatus === LikeStatus.Love) {
                summary.loved++;
            } else if (progress.likeStatus === LikeStatus.Like) {
                summary.liked++;
            } else if (progress.likeStatus === LikeStatus.Dislike) {
                summary.disliked++;
            } else if (progress.kept) {
                summary.kept++;
            } else if (progress.heard) {
                summary.passed++;
            } else {
                summary.unheard++;
            }
        }
        return summary;
    }

    private emit() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
