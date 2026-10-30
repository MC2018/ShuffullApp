import { Button } from "react-native";
import { Playlist } from "@/app/services/db/models";

export interface DownloadPlaylistProps {
    playlist: Playlist;
    onPress: () => void;
}

export default function DownloadPlaylistButton({ onPress }: DownloadPlaylistProps) {
    return (
        <>
            <Button onPress={onPress} title="Download Playlist" />
        </>
    );
}
