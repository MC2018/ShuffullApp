import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { Recap, RecapSong } from "@/app/services/api/models";
import {
    busiestHour,
    DAY_NAMES,
    formatDayMonth,
    formatHour,
    formatLocalDay,
    formatMinutes,
    MONTH_INITIALS,
    MONTH_NAMES,
    plural,
    seasonLabel,
    songArtists,
    songTitle,
    statsStartedLine,
} from "@/app/tools/recap";
import { BarChart, HEAT_CELL_GAP, HEAT_ROW_LABEL_WIDTH, HeatGrid, ShareBar, Stat } from "./charts";

// The recap's sections (epic shuffull-workspace#35). Each one takes the whole recap and draws only its own content:
// no card, no heading, no scrolling. The container (app/(app)/recap.tsx) supplies those from RECAP_SECTIONS, so the
// layout can change, from one scrolling page to story-style cards for example, without touching a section.

export interface RecapSectionProps {
    recap: Recap;
}

export interface RecapSectionDef {
    key: string;
    title: string;
    Component: React.ComponentType<RecapSectionProps>;
}

function Empty({ children }: { children: React.ReactNode }) {
    return (
        <Text variant="body" color="textFaint">
            {children}
        </Text>
    );
}

/** A numbered row: title, subtitle, a figure on the right, and a bar for its share of the list's leader. */
function RankedRow({ rank, title, subtitle, figure, share }: { rank: number; title: string; subtitle?: string; figure: string; share: number }) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.sm }}>
            <Text variant="bodyStrong" color="textFaint" style={{ width: 20, textAlign: "right" }}>
                {rank}
            </Text>
            <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: theme.space.sm }}>
                    <Text variant="bodyStrong" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
                        {title}
                    </Text>
                    <Text variant="label" color="textMuted">
                        {figure}
                    </Text>
                </View>
                {subtitle ? (
                    <Text variant="caption" color="textFaint" numberOfLines={1}>
                        {subtitle}
                    </Text>
                ) : null}
                <ShareBar share={share} />
            </View>
        </View>
    );
}

/** "By time" / "By plays" switch for the top lists. */
function ByToggle({ byPlays, onChange }: { byPlays: boolean; onChange: (byPlays: boolean) => void }) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: "row", gap: theme.space.sm, marginBottom: theme.space.sm }}>
            <Chip label="By time" state={byPlays ? "idle" : "selected"} onPress={() => onChange(false)} />
            <Chip label="By plays" state={byPlays ? "selected" : "idle"} onPress={() => onChange(true)} />
        </View>
    );
}

/** One song with its figure, for the single-song highlights. */
function SongLine({ song, figure }: { song: RecapSong; figure: string }) {
    const theme = useTheme();
    return (
        <View style={{ gap: 2 }}>
            <Text variant="title" numberOfLines={2}>
                {songTitle(song)}
            </Text>
            <Text variant="body" color="textMuted" numberOfLines={1}>
                {songArtists(song)}
            </Text>
            <Text variant="label" color="accentTint" style={{ marginTop: theme.space.xs }}>
                {figure}
            </Text>
        </View>
    );
}

export function OverviewSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const started = statsStartedLine(recap);
    return (
        <View style={{ gap: theme.space.md }}>
            <View style={{ flexDirection: "row", gap: theme.space.lg }}>
                <Stat value={formatMinutes(recap.totalMinutes)} label="of music" />
                <Stat value={recap.plays.toLocaleString("en-US")} label={recap.plays === 1 ? "play" : "plays"} />
                <Stat value={recap.longestStreak ? plural(recap.longestStreak.days, "day") : "–"} label="longest streak" />
            </View>
            {started ? (
                <Text variant="caption" color="textMuted">
                    {started}
                </Text>
            ) : null}
        </View>
    );
}

export function MonthsSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const max = Math.max(...recap.minutesByMonth);
    const top = recap.minutesByMonth.indexOf(max);
    return (
        <View style={{ gap: theme.space.md }}>
            <BarChart values={recap.minutesByMonth} labels={MONTH_INITIALS} />
            {max > 0 ? (
                <Text variant="caption" color="textMuted">
                    Your biggest month was {MONTH_NAMES[top]}, with {formatMinutes(max)}.
                </Text>
            ) : null}
        </View>
    );
}

export function HeatmapSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const busiest = busiestHour(recap.heatmap);
    return (
        <View style={{ gap: theme.space.sm }}>
            <HeatGrid rows={recap.heatmap} rowLabels={DAY_NAMES.map(d => d.charAt(0))} />
            <View style={{ flexDirection: "row", paddingLeft: HEAT_ROW_LABEL_WIDTH + HEAT_CELL_GAP }}>
                {[0, 6, 12, 18].map(hour => (
                    <Text key={hour} variant="caption" color="textFaint" style={{ flex: 1 }}>
                        {formatHour(hour)}
                    </Text>
                ))}
            </View>
            {busiest ? (
                <Text variant="caption" color="textMuted">
                    You listened most on {DAY_NAMES[busiest.day]}s around {formatHour(busiest.hour)}.
                </Text>
            ) : null}
        </View>
    );
}

/** A ranked list with a by-time / by-plays toggle: top songs and top artists. */
function ToggledRanking<T extends { minutes: number; plays: number }>({ byMinutes, byPlays: byPlaysList, empty, row }: {
    byMinutes: T[];
    byPlays: T[];
    empty: string;
    row: (item: T) => { key: string; title: string; subtitle?: string };
}) {
    const [byPlays, setByPlays] = useState(false);
    const items = byPlays ? byPlaysList : byMinutes;
    const figureOf = (item: T) => (byPlays ? item.plays : item.minutes);
    const lead = items[0] ? figureOf(items[0]) : 0;
    return (
        <View>
            <ByToggle byPlays={byPlays} onChange={setByPlays} />
            {items.length === 0 ? <Empty>{empty}</Empty> : null}
            {items.map((item, i) => {
                const { key, title, subtitle } = row(item);
                return (
                    <RankedRow
                        key={key}
                        rank={i + 1}
                        title={title}
                        subtitle={subtitle}
                        figure={byPlays ? plural(item.plays, "play") : formatMinutes(item.minutes)}
                        share={lead > 0 ? figureOf(item) / lead : 0}
                    />
                );
            })}
        </View>
    );
}

export function TopSongsSection({ recap }: RecapSectionProps) {
    return (
        <ToggledRanking
            byMinutes={recap.topSongsByMinutes}
            byPlays={recap.topSongsByPlays}
            empty="No songs yet."
            row={song => ({ key: song.songId, title: songTitle(song), subtitle: songArtists(song) })}
        />
    );
}

export function TopArtistsSection({ recap }: RecapSectionProps) {
    return (
        <ToggledRanking
            byMinutes={recap.topArtistsByMinutes}
            byPlays={recap.topArtistsByPlays}
            empty="No artists yet."
            row={artist => ({ key: artist.artistId, title: artist.name })}
        />
    );
}

export function GenresSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const lead = recap.topGenres[0]?.minutes ?? 0;
    return (
        <View>
            {recap.topGenres.length === 0 ? <Empty>{"None of this year's songs carry a genre yet."}</Empty> : null}
            {recap.topGenres.map((genre, i) => (
                <RankedRow key={genre.tagId} rank={i + 1} title={genre.name} figure={formatMinutes(genre.minutes)} share={lead > 0 ? genre.minutes / lead : 0} />
            ))}
            {recap.topGenres.length > 0 ? (
                <Text variant="caption" color="textFaint" style={{ marginTop: theme.space.sm }}>
                    A song with two genres counts towards both. Genres are each song&apos;s tags today.
                </Text>
            ) : null}
        </View>
    );
}

/** How many genres the month-by-month grid follows. The API sends up to ten; more rows than this get cramped. */
const GENRE_SHIFT_ROWS = 5;
// Wider labels than the hour grid, for genre names, and a wider gap so twelve month cells read as columns.
const GENRE_LABEL_WIDTH = 84;
const GENRE_CELL_GAP = 3;

export function GenreShiftSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const genres = recap.topGenres.slice(0, GENRE_SHIFT_ROWS);
    if (genres.length === 0) {
        return <Empty>Nothing to follow yet.</Empty>;
    }
    // rows[genre][month] = that genre's share of the month's listening.
    const rows = genres.map(genre =>
        recap.genresByMonth.map(month => month.genres.find(g => g.tagId === genre.tagId)?.percent ?? 0));
    return (
        <View style={{ gap: theme.space.sm }}>
            <HeatGrid rows={rows} rowLabels={genres.map(g => g.name)} rowLabelWidth={GENRE_LABEL_WIDTH} cellGap={GENRE_CELL_GAP} />
            <View style={{ flexDirection: "row", gap: GENRE_CELL_GAP, paddingLeft: GENRE_LABEL_WIDTH + GENRE_CELL_GAP }}>
                {MONTH_INITIALS.map((m, i) => (
                    <Text key={i} variant="caption" color="textFaint" style={{ flex: 1, textAlign: "center" }}>
                        {m}
                    </Text>
                ))}
            </View>
            <Text variant="caption" color="textFaint">
                Brighter means a bigger share of that month&apos;s listening.
            </Text>
        </View>
    );
}

export function SeasonsSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    return (
        <View style={{ gap: theme.space.md }}>
            {recap.songOfEachSeason.map(({ season, song }) => (
                <View key={season} style={{ flexDirection: "row", gap: theme.space.md }}>
                    <Text variant="micro" color="accentTint" style={{ width: 64, marginTop: 3 }}>
                        {seasonLabel(season)}
                    </Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        {song ? (
                            <>
                                <Text variant="bodyStrong" numberOfLines={1}>
                                    {songTitle(song)}
                                </Text>
                                <Text variant="caption" color="textFaint" numberOfLines={1}>
                                    {songArtists(song)} · {formatMinutes(song.minutes)}
                                </Text>
                            </>
                        ) : (
                            <Text variant="body" color="textFaint">
                                No listens
                            </Text>
                        )}
                    </View>
                </View>
            ))}
            <Text variant="caption" color="textFaint">
                Winter is January, February and December.
            </Text>
        </View>
    );
}

export function GrowerSection({ recap }: RecapSectionProps) {
    const grower = recap.biggestGrower;
    if (!grower) {
        return <Empty>No song climbed from one month to the next yet.</Empty>;
    }
    const month = MONTH_NAMES[grower.month - 1];
    const before = MONTH_NAMES[grower.month - 2];
    return (
        <SongLine
            song={grower.song}
            figure={`${formatMinutes(grower.previousMonthMinutes)} in ${before}, then ${formatMinutes(grower.song.minutes)} in ${month}`}
        />
    );
}

export function StreaksSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const streak = recap.longestStreak;
    const session = recap.longestSession;
    return (
        <View style={{ gap: theme.space.lg }}>
            <View>
                <Text variant="micro" color="accentTint">
                    Longest daily streak
                </Text>
                {streak ? (
                    <>
                        <Text variant="title" style={{ marginTop: theme.space.xs }}>
                            {plural(streak.days, "day")} in a row
                        </Text>
                        <Text variant="caption" color="textMuted">
                            {streak.days === 1 ? formatLocalDay(streak.start) : `${formatLocalDay(streak.start)} to ${formatLocalDay(streak.end)}`}
                        </Text>
                    </>
                ) : (
                    <Empty>No listens yet.</Empty>
                )}
            </View>
            <View>
                <Text variant="micro" color="accentTint">
                    Longest session
                </Text>
                {session ? (
                    <>
                        <Text variant="title" style={{ marginTop: theme.space.xs }}>
                            {formatMinutes(session.minutes)}
                        </Text>
                        <Text variant="caption" color="textMuted">
                            {plural(session.plays, "song")} on {formatDayMonth(session.start)}, with no break of half an hour or more
                        </Text>
                    </>
                ) : (
                    <Empty>No listens yet.</Empty>
                )}
            </View>
        </View>
    );
}

export function AuditionsSection({ recap }: RecapSectionProps) {
    const theme = useTheme();
    const { auditionedSongs, keptSongs, percent } = recap.keepRate;
    return (
        <View style={{ gap: theme.space.md }}>
            <View style={{ flexDirection: "row", gap: theme.space.lg }}>
                <Stat value={formatMinutes(recap.auditionMinutes)} label="spent auditioning" />
                <Stat value={percent == null ? "–" : `${Math.round(percent)}%`} label="keep rate" />
            </View>
            <Text variant="caption" color="textMuted">
                {auditionedSongs === 0
                    ? "You didn't audition any songs this year."
                    : `Of the ${plural(auditionedSongs, "song")} you auditioned, ${keptSongs.toLocaleString("en-US")} ${keptSongs === 1 ? "is" : "are"} kept or liked now.`}
            </Text>
        </View>
    );
}

export function MostSkippedSection({ recap }: RecapSectionProps) {
    const skipped = recap.mostSkipped;
    if (!skipped) {
        return <Empty>{"You didn't skip a single song. Impressive."}</Empty>;
    }
    return <SongLine song={skipped.song} figure={`Skipped ${plural(skipped.skips, "time")} out of ${plural(skipped.song.plays, "play")}`} />;
}

/** The recap, in order. A container draws each with its title; nothing else decides what's in the recap. */
export const RECAP_SECTIONS: RecapSectionDef[] = [
    { key: "overview", title: "Your year", Component: OverviewSection },
    { key: "months", title: "Month by month", Component: MonthsSection },
    { key: "heatmap", title: "When you listen", Component: HeatmapSection },
    { key: "top-songs", title: "Top songs", Component: TopSongsSection },
    { key: "top-artists", title: "Top artists", Component: TopArtistsSection },
    { key: "genres", title: "Top genres", Component: GenresSection },
    { key: "genre-shift", title: "How your genres shifted", Component: GenreShiftSection },
    { key: "seasons", title: "Song of each season", Component: SeasonsSection },
    { key: "grower", title: "Biggest grower", Component: GrowerSection },
    { key: "streaks", title: "Streaks and sessions", Component: StreaksSection },
    { key: "auditions", title: "Auditions", Component: AuditionsSection },
    { key: "most-skipped", title: "Most skipped", Component: MostSkippedSection },
];
