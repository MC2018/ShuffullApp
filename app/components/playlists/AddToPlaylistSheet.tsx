import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useDb } from "@/app/services/db/DbProvider";
import { useApi } from "@/app/services/api/ApiProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { Playlist } from "@/app/services/db/models";
import { Button, ListRow, SectionHeader, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

interface Props {
    songId: string;
    visible: boolean;
    onClose: () => void;
}

// Bottom sheet that adds/removes a song to/from the user's playlists. Each playlist shows a checkmark when the
// song is already on it; tapping toggles membership (optimistic local update + server call, reverting on error).
// A field at the bottom creates a new playlist and adds the song to it. Server already persists all of this; the
// next sync reconciles local state.
export default function AddToPlaylistSheet({ songId, visible, onClose }: Props) {
    const theme = useTheme();
    const db = useDb();
    const api = useApi();
    const userId = useCurrentUser();
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [newName, setNewName] = useState("");
    const [creating, setCreating] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [pls, member] = await Promise.all([
                DbQueries.getPlaylists(db, userId),
                DbQueries.getPlaylistIdsContainingSong(db, songId),
            ]);
            setPlaylists(pls);
            setMemberIds(new Set(member));
        } finally {
            setLoading(false);
        }
    }, [db, userId, songId]);

    useEffect(() => {
        if (visible) {
            load();
        }
    }, [visible, load]);

    const setMember = (playlistId: string, member: boolean) =>
        setMemberIds((prev) => {
            const next = new Set(prev);
            if (member) {
                next.add(playlistId);
            } else {
                next.delete(playlistId);
            }
            return next;
        });

    const toggle = async (playlist: Playlist) => {
        const wasMember = memberIds.has(playlist.playlistId);
        setMember(playlist.playlistId, !wasMember); // optimistic
        try {
            if (wasMember) {
                await api.playlistRemoveSong(playlist.playlistId, songId);
                await DbQueries.removeSongFromPlaylist(db, playlist.playlistId, songId);
            } else {
                await api.playlistAddSong(playlist.playlistId, songId);
                await DbQueries.addSongToPlaylist(db, playlist.playlistId, songId);
            }
        } catch {
            setMember(playlist.playlistId, wasMember); // revert
            Alert.alert("Couldn't update playlist", "Please try again.");
        }
    };

    const createAndAdd = async () => {
        const name = newName.trim();
        if (!name || creating) {
            return;
        }
        setCreating(true);
        try {
            const created = await api.playlistCreate(name);
            await DbQueries.updatePlaylist(db, {
                playlistId: created.playlistId,
                userId: created.userId,
                name: created.name,
                percentUntilReplayable: created.percentUntilReplayable,
                version: created.version,
            });
            await api.playlistAddSong(created.playlistId, songId);
            await DbQueries.addSongToPlaylist(db, created.playlistId, songId);
            setNewName("");
            await load();
        } catch {
            Alert.alert("Couldn't create playlist", "Please try again.");
        } finally {
            setCreating(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={{ flex: 1, justifyContent: "flex-end" }}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
                <View
                    style={{
                        backgroundColor: theme.color.bg,
                        borderTopLeftRadius: theme.radius.lg,
                        borderTopRightRadius: theme.radius.lg,
                        borderWidth: 1,
                        borderColor: theme.color.line,
                        paddingHorizontal: theme.space.lg,
                        paddingTop: theme.space.md,
                        paddingBottom: theme.space.xl,
                        maxHeight: "75%",
                    }}
                >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.space.sm }}>
                        <Text variant="bodyStrong">Add to playlist</Text>
                        <Pressable onPress={onClose} hitSlop={8}>
                            <Text variant="label" color="accent">
                                Done
                            </Text>
                        </Pressable>
                    </View>

                    {loading ? (
                        <View style={{ paddingVertical: theme.space.xl, alignItems: "center" }}>
                            <ActivityIndicator color={theme.color.accent} />
                        </View>
                    ) : (
                        <ScrollView showsVerticalScrollIndicator={false}>
                            {playlists.length === 0 ? (
                                <Text variant="body" color="textFaint" style={{ paddingVertical: theme.space.md }}>
                                    No playlists yet — create one below.
                                </Text>
                            ) : (
                                playlists.map((p) => {
                                    const member = memberIds.has(p.playlistId);
                                    return (
                                        <ListRow
                                            key={p.playlistId}
                                            title={p.name}
                                            onPress={() => toggle(p)}
                                            right={
                                                <Ionicons
                                                    name={member ? "checkmark-circle" : "ellipse-outline"}
                                                    size={24}
                                                    color={member ? theme.color.accent : theme.color.textFaint}
                                                />
                                            }
                                        />
                                    );
                                })
                            )}

                            <SectionHeader title="New playlist" />
                            <View style={{ flexDirection: "row", gap: theme.space.sm, alignItems: "flex-start" }}>
                                <TextField
                                    placeholder="Playlist name"
                                    value={newName}
                                    onChangeText={setNewName}
                                    autoCapitalize="words"
                                    style={{ flex: 1 }}
                                />
                                <Button label="Create" onPress={createAndAdd} disabled={!newName.trim() || creating} />
                            </View>
                        </ScrollView>
                    )}
                </View>
            </View>
        </Modal>
    );
}
