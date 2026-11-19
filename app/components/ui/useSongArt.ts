import { useEffect, useState } from "react";
import { ImageURISource } from "react-native";
import { Song } from "@/app/services/db/models";
import { Downloader } from "@/app/services/downloader/Downloader";

/**
 * A song's album art: the downloaded file if there is one, else the server's. Undefined until it resolves, which
 * AlbumArt shows as the default art.
 */
export function useSongArt(song: Song): ImageURISource | undefined {
    const [art, setArt] = useState<ImageURISource>();
    useEffect(() => {
        let cancelled = false;
        Downloader.resolveAlbumArt(song)
            .then((resolved) => {
                if (!cancelled) {
                    setArt(resolved);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [song]);
    return art;
}
