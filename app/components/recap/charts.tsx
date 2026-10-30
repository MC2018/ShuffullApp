import React from "react";
import { View } from "react-native";
import { Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import type { Theme } from "@/app/theme/tokens";
import { scaleToMax } from "@/app/tools/recap";

// The recap's charts, drawn with plain Views: there's no chart library in the app, and these are bars and grids.

/** The tallest bar in the accent, the other non-empty ones deeper, an empty one as a plain line. */
function barColor(value: number, max: number, theme: Theme): string {
    if (value <= 0) {
        return theme.color.line;
    }
    return value === max ? theme.color.accent : theme.color.accentDeep;
}

/** Vertical bars, one per value, with a label under each. The tallest bar is drawn in the accent. */
export function BarChart({ values, labels, height = 96 }: { values: number[]; labels: readonly string[]; height?: number }) {
    const theme = useTheme();
    const scaled = scaleToMax(values);
    const max = Math.max(...values);
    return (
        <View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 4 }}>
                {scaled.map((share, i) => (
                    <View key={i} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
                        <View
                            style={{
                                height: values[i] > 0 ? `${Math.max(share * 100, 3)}%` : 2,
                                borderRadius: 4,
                                backgroundColor: barColor(values[i], max, theme),
                            }}
                        />
                    </View>
                ))}
            </View>
            <View style={{ flexDirection: "row", gap: 4, marginTop: theme.space.xs }}>
                {labels.map((label, i) => (
                    <Text key={i} variant="caption" color="textFaint" style={{ flex: 1, textAlign: "center" }}>
                        {label}
                    </Text>
                ))}
            </View>
        </View>
    );
}

/** HeatGrid's default row label width and cell gap. A row of column labels under it is indented by their sum. */
export const HEAT_ROW_LABEL_WIDTH = 18;
export const HEAT_CELL_GAP = 2;

/**
 * A grid of cells shaded by value: rows × columns, with a label at the start of each row. Shading is relative to the
 * grid's largest cell, so the busiest cell is full accent and an empty one is the plain surface.
 */

export function HeatGrid({ rows, rowLabels, rowLabelWidth = HEAT_ROW_LABEL_WIDTH, cellGap = HEAT_CELL_GAP }: {
    rows: number[][];
    rowLabels: readonly string[];
    rowLabelWidth?: number;
    cellGap?: number;
}) {
    const theme = useTheme();
    const max = Math.max(0, ...rows.flat());
    return (
        <View style={{ gap: cellGap }}>
            {rows.map((cells, r) => (
                <View key={r} style={{ flexDirection: "row", alignItems: "center", gap: cellGap }}>
                    <Text variant="caption" color="textFaint" numberOfLines={1} style={{ width: rowLabelWidth }}>
                        {rowLabels[r]}
                    </Text>
                    {cells.map((value, c) => (
                        <View
                            key={c}
                            style={{
                                flex: 1,
                                aspectRatio: 1,
                                borderRadius: 2,
                                backgroundColor: value > 0 && max > 0 ? theme.color.accent : theme.color.surfaceAlt,
                                opacity: value > 0 && max > 0 ? 0.2 + 0.8 * (value / max) : 1,
                            }}
                        />
                    ))}
                </View>
            ))}
        </View>
    );
}

/** A thin horizontal bar, `share` (0 to 1) of the way across. For ranked lists. */
export function ShareBar({ share }: { share: number }) {
    const theme = useTheme();
    return (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.color.surfaceAlt, marginTop: 6 }}>
            <View style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%`, height: 4, borderRadius: 2, backgroundColor: theme.color.accent }} />
        </View>
    );
}

/** A big number with a caption under it, for the headline figures. */
export function Stat({ value, label }: { value: string; label: string }) {
    const theme = useTheme();
    return (
        <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="title" numberOfLines={1}>
                {value}
            </Text>
            <Text variant="caption" color="textMuted" style={{ marginTop: theme.space.xs }}>
                {label}
            </Text>
        </View>
    );
}
