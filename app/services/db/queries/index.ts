import * as misc from "./_misc";
import * as artist from "./artist";
import * as decision from "./decision";
import * as downloadedSong from "./downloadedSong";
import * as downloadQueue from "./downloadQueue";
import * as genreJam from "./genreJam";
import * as listen from "./listen";
import * as listenStats from "./listenStats";
import * as localSessionData from "./localSessionData";
import * as playlist from "./playlist";
import * as recentlyPlayedSong from "./recentlyPlayedSong";
import * as request from "./request";
import * as song from "./song";
import * as tag from "./tag";
import * as user from "./user";
import * as userSong from "./userSong";

const DbQueries = {
    ...misc,
    ...artist,
    ...decision,
    ...downloadedSong,
    ...downloadQueue,
    ...genreJam,
    ...listen,
    ...listenStats,
    ...localSessionData,
    ...playlist,
    ...recentlyPlayedSong,
    ...request,
    ...song,
    ...tag,
    ...user,
    ...userSong
}

export default DbQueries;