import { ScrollView } from "react-native";
import LocalDownloadsSelector from "../atoms/LocalDownloadsSelector";
import { Playlist } from "@/app/services/db/models";
import PlaylistSelector from "../atoms/PlaylistSelector";
import SongCollectionSelector from "../atoms/SongCollectionSelector";

export interface SongCollectionScrollViewProps {
    playlists: Playlist[];
    onSelected: (playlist: Playlist) => void;
}

export default function SongCollectionScrollView({ playlists, onSelected }: SongCollectionScrollViewProps) {
    return (
        <ScrollView horizontal={true}>
            <LocalDownloadsSelector />
            {playlists.map((playlist) => (
                <PlaylistSelector
                key={playlist.playlistId}
                playlist={playlist}
                onSelectPlaylist={onSelected}></PlaylistSelector>
            ))}
            <SongCollectionSelector collectionName="Liked Songs" imageSource={require("@/assets/images/default-album-art.jpg")} onSelected={() => console.log("oi")}></SongCollectionSelector>
        </ScrollView>
    );
}
