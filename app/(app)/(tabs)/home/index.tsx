import { Button, View } from "react-native";
import { useEffect, useState } from "react";
import { router } from "expo-router";
import { Tag } from "@/app/services/db/models";
import PlayPauseButton from "@/app/components/music-control/atoms/PlayPauseButton";
import { isAnyNullish } from "@/app/tools";
import DownloadButton from "@/app/components/downloading/atoms/DownloadButton";
import { logout } from "@/app/services/auth/auth";
import Skimmer from "@/app/components/music-control/atoms/Skimmer";
import PlayerBar from "@/app/components/music-control/organisms/PlayerBar";
import DbQueries from "@/app/services/db/queries";
import { TagList } from "@/app/components/tags/molecules/TagList";
import { useDb } from "@/app/services/db/DbProvider";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { DownloadPriority } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";

export default function HomeScreen() {
    const db = useDb();
    const downloader = useDownloader();
    const { songId } = useActiveSong();
    const [tags, setTags] = useState<Tag[]>([]);

    const handleGenreJamEditorSelected = () => {
        router.push("/home/genre-jam");
    };

    useEffect(() => {
        (async () => {
            if (songId == undefined) {
                return;
            }

            const dbSongTags = await DbQueries.getTagsFromSong(db, songId);
            setTags(dbSongTags);
        })();
    }, [songId]);

    const handleDownload = async () => {
        const song = await MediaManager.getCurrentlyPlayingSong();

        if (isAnyNullish(song, downloader)) {
            return;
        }

        await downloader!.addSongToDownloadQueue(song!.songId, DownloadPriority.Medium);
    };

    return (
        <>
            <View
                style={{
                    flex: 1,
                    justifyContent: "center",
                    alignItems: "center",
                }}>
                <Button onPress={handleGenreJamEditorSelected} title="Genre Jam Selector"></Button>
                <Button onPress={logout} title="Logout" />
                <PlayPauseButton />
                <DownloadButton onPress={handleDownload}></DownloadButton>
                <Skimmer></Skimmer>
                <TagList tags={tags}></TagList>
            </View>
            <PlayerBar></PlayerBar>
        </>
    );
}
