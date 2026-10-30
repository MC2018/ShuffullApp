import { Recap, RecapSchema } from "../api/models";

// Made-up recap for development builds only: Settings → Developer → "Open the recap with sample data" shows it, so
// every section can be looked at (and screenshotted) without a server that has a year of listens. Nothing here is
// real user data. It starts in March, so the "stats started" line shows too.

const song = (songId: string, name: string, artists: string[], minutes: number, plays: number) =>
    ({ songId, name, artists, minutes, plays });

// Evenings and weekend afternoons, a little on weekday mornings.
function sampleHeatmap(): number[][] {
    return Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => {
        const weekend = day === 0 || day === 6;
        if (hour >= 19 && hour <= 23) {
            return 40 + 12 * (hour - 19) + (weekend ? 30 : 0);
        }
        if (weekend && hour >= 13 && hour <= 17) {
            return 55;
        }
        if (!weekend && hour >= 7 && hour <= 8) {
            return 25;
        }
        return hour < 2 ? 8 : 0;
    }));
}

const minutesByMonth = [0, 0, 310, 1220, 1480, 1730, 2105, 1960, 1525, 1640, 2290, 830];
const genreShares: Record<string, number[]> = {
    "tag-rock": [0, 0, 62, 55, 48, 40, 35, 33, 38, 44, 51, 57],
    "tag-jpop": [0, 0, 10, 18, 25, 33, 41, 46, 39, 30, 22, 18],
    "tag-electronic": [0, 0, 20, 21, 24, 28, 30, 26, 22, 25, 29, 31],
    "tag-metal": [0, 0, 5, 9, 8, 6, 4, 6, 12, 19, 24, 22],
    "tag-funk": [0, 0, 8, 6, 9, 12, 14, 11, 7, 5, 4, 6],
};
const genreNames: Record<string, string> = {
    "tag-rock": "Rock",
    "tag-jpop": "J-Pop",
    "tag-electronic": "Electronic",
    "tag-metal": "Metal",
    "tag-funk": "Funk",
};

/** Parsed on call, through the real schema, so the sample can't drift from what the screen reads. */
export function sampleRecap(): Recap {
    return RecapSchema.parse({
        year: 2026,
        timeZone: "America/New_York",
        from: "2026-01-01T05:00:00Z",
        to: "2027-01-01T05:00:00Z",
        firstListen: "2026-03-14T18:22:05Z",
        totalMinutes: minutesByMonth.reduce((a, b) => a + b, 0),
        plays: 4812,
        minutesByMonth,
        heatmap: sampleHeatmap(),
        topSongsByMinutes: [
            song("s1", "Everybody Wants You", ["Billy Squier"], 412.5, 98),
            song("s2", "Idol", ["YOASOBI"], 388, 121),
            song("s3", "Ghost Rule", ["DECO*27"], 301.2, 77),
            song("s4", "Blue Monday", ["New Order"], 288.9, 39),
            song("s5", "Night Dancer", ["imase"], 260, 70),
        ],
        topSongsByPlays: [
            song("s2", "Idol", ["YOASOBI"], 388, 121),
            song("s1", "Everybody Wants You", ["Billy Squier"], 412.5, 98),
            song("s6", "Ievan Polkka", ["Otomania", "Hatsune Miku"], 140.3, 92),
            song("s3", "Ghost Rule", ["DECO*27"], 301.2, 77),
            song("s5", "Night Dancer", ["imase"], 260, 70),
        ],
        topArtistsByMinutes: [
            { artistId: "a1", name: "YOASOBI", minutes: 1240, plays: 390 },
            { artistId: "a2", name: "Billy Squier", minutes: 905, plays: 210 },
            { artistId: "a3", name: "Camellia", minutes: 770, plays: 160 },
            { artistId: "a4", name: "DECO*27", minutes: 612, plays: 150 },
            { artistId: "a5", name: "New Order", minutes: 480, plays: 66 },
        ],
        topArtistsByPlays: [
            { artistId: "a1", name: "YOASOBI", minutes: 1240, plays: 390 },
            { artistId: "a2", name: "Billy Squier", minutes: 905, plays: 210 },
            { artistId: "a3", name: "Camellia", minutes: 770, plays: 160 },
            { artistId: "a4", name: "DECO*27", minutes: 612, plays: 150 },
            { artistId: "a6", name: "Hatsune Miku", minutes: 300, plays: 140 },
        ],
        topGenres: Object.keys(genreShares).map(tagId => ({
            tagId,
            name: genreNames[tagId],
            minutes: Math.round(genreShares[tagId].reduce((sum, pct, i) => sum + (pct / 100) * minutesByMonth[i], 0)),
        })),
        genresByMonth: minutesByMonth.map((total, i) => ({
            month: i + 1,
            totalMinutes: total,
            genres: Object.keys(genreShares).map(tagId => ({
                tagId,
                name: genreNames[tagId],
                minutes: (genreShares[tagId][i] / 100) * total,
                percent: genreShares[tagId][i],
            })),
        })),
        auditionMinutes: 1384,
        keepRate: { auditionedSongs: 212, keptSongs: 61, percent: 28.77 },
        longestStreak: { days: 47, start: "2026-06-02", end: "2026-07-18" },
        longestSession: { start: "2026-08-15T17:10:00Z", end: "2026-08-15T23:52:00Z", minutes: 384.5, plays: 91 },
        biggestGrower: { song: song("s3", "Ghost Rule", ["DECO*27"], 96, 24), month: 10, previousMonthMinutes: 4 },
        songOfEachSeason: [
            { season: "winter", song: song("s7", "Snow Halation", ["μ's"], 58, 15) },
            { season: "spring", song: song("s1", "Everybody Wants You", ["Billy Squier"], 160, 38) },
            { season: "summer", song: song("s2", "Idol", ["YOASOBI"], 190, 59) },
            { season: "autumn", song: song("s3", "Ghost Rule", ["DECO*27"], 205, 52) },
        ],
        mostSkipped: { song: song("s8", "Never Gonna Give You Up", ["Rick Astley"], 12.4, 58), skips: 51 },
    });
}
