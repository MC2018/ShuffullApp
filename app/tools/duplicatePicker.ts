// The "Duplicate of…" picker's suggestions (ShuffullApp#219). Pure, so the order is testable without React Native.

/** A song the user could name as the copy they already have. */
export interface DuplicateCandidate {
    songId: string;
    name: string;
    artists: string[];
    // Null or before the epoch when never played (the server seeds UserSongs with DateTime.MinValue).
    lastPlayed: Date | null;
}

/** Why a song is suggested; the picker shows it as the row's section. */
export type DuplicateSuggestionReason = "nowPlaying" | "recent" | "similar" | "search";

export interface DuplicateSuggestion {
    candidate: DuplicateCandidate;
    reason: DuplicateSuggestionReason;
}

export const DUPLICATE_PICKER_RECENT_LIMIT = 10;
export const DUPLICATE_PICKER_SIMILAR_LIMIT = 20;
export const DUPLICATE_PICKER_SEARCH_LIMIT = 50;

export interface DuplicatePickerInput {
    // The song being reported.
    song: { songId: string; name: string; artists: string[] };
    // What is playing now, if anything.
    nowPlayingId: string | undefined;
    // Every song the user may name: the songs in their library, minus the ones they've hidden. The server refuses a
    // report naming a song outside the library, so nothing else is offered.
    candidates: DuplicateCandidate[];
    // The search box's text. Empty shows no search results.
    query: string;
}

/**
 * The picker's rows, in the order the ticket asks for: the song playing now (when it isn't this one), then recent
 * plays, then songs with a similar title or the same artist, then what the search box matches. A song shows once, in
 * the first section it qualifies for, and the reported song itself never shows.
 */
export function orderDuplicateCandidates(input: DuplicatePickerInput): DuplicateSuggestion[] {
    const { song, nowPlayingId, candidates, query } = input;
    const result: DuplicateSuggestion[] = [];
    const shown = new Set<string>([song.songId]);
    const add = (candidate: DuplicateCandidate, reason: DuplicateSuggestionReason) => {
        if (!shown.has(candidate.songId)) {
            shown.add(candidate.songId);
            result.push({ candidate, reason });
        }
    };

    const nowPlaying = nowPlayingId == undefined ? undefined : candidates.find(x => x.songId === nowPlayingId);
    if (nowPlaying) {
        add(nowPlaying, "nowPlaying");
    }

    candidates
        .filter(x => x.lastPlayed != null && x.lastPlayed.getTime() > 0 && !shown.has(x.songId))
        .sort((a, b) => b.lastPlayed!.getTime() - a.lastPlayed!.getTime())
        .slice(0, DUPLICATE_PICKER_RECENT_LIMIT)
        .forEach(x => add(x, "recent"));

    const title = normalizeSongTitle(song.name);
    const artists = new Set(song.artists.map(normalizeArtist).filter(Boolean));
    candidates
        .map(x => ({ candidate: x, score: similarity(title, artists, x) }))
        .filter(x => x.score > 0 && !shown.has(x.candidate.songId))
        // Stable: equal scores keep the caller's order.
        .sort((a, b) => b.score - a.score)
        .slice(0, DUPLICATE_PICKER_SIMILAR_LIMIT)
        .forEach(x => add(x.candidate, "similar"));

    const q = query.trim().toLowerCase();
    if (q) {
        candidates
            .filter(x => !shown.has(x.songId)
                && (x.name.toLowerCase().includes(q) || x.artists.some(a => a.toLowerCase().includes(q))))
            .slice(0, DUPLICATE_PICKER_SEARCH_LIMIT)
            .forEach(x => add(x, "search"));
    }

    return result;
}

// 3: the same normalised title. 2: one title contains the other ("song" and "song remix"). 1: a shared artist. Title and artist together add up, so a same-title same-artist copy comes first.
function similarity(title: string, artists: Set<string>, candidate: DuplicateCandidate): number {
    const other = normalizeSongTitle(candidate.name);
    let score = 0;
    if (title && other) {
        if (title === other) {
            score += 3;
        } else if (Math.min(title.length, other.length) >= 4 && (title.includes(other) || other.includes(title))) {
            score += 2;
        }
    }
    if (candidate.artists.some(a => artists.has(normalizeArtist(a)))) {
        score += 1;
    }
    return score;
}

/**
 * A title reduced to what two uploads of one recording share: lower case, accents dropped, anything in brackets
 * ("(Official Video)", "[Remastered]") and a "feat." credit removed, punctuation gone.
 */
export function normalizeSongTitle(title: string): string {
    return title
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
        .replace(/\s(feat\.?|ft\.?|featuring)\s.*$/, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function normalizeArtist(artist: string): string {
    return artist.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
