import { GenericDb } from "../GenericDb";
import { CreateUserSongRequest, Song, UpdateSongLastPlayedRequest, UserSong } from "../models";
import { withTransaction } from "../transaction";
import { LikeStatus, RequestType } from "@/app/enums";
import { shouldPromoteOnLike } from "@/app/tools/promotion";
import { generateId } from "@/app/tools/pure";
import { addRequests, enqueueSongRetag } from "./request";
import { getSong, markSongKept, markSongPromoted } from "./song";
import { addUserSong, getUserSong, setUserSongLikeStatus, updateUserSongLastPlayed } from "./userSong";

// A user decision is its local state AND the outbox row that tells the server, written in one transaction. Written
// apart, a crash or a failed insert between them left the song liked on the phone with nothing queued, so the server
// never heard and the next pull put the old rating back. Everything below gets `tx`, so the nested writers join this
// transaction rather than wait behind it (transaction.ts).

/**
 * Records a like/dislike/love and queues its push. A Like or Love on an audition or weak-tagged song also queues
 * a strong re-tag and clears the flags locally, so it leaves the audition view at once. Returns the song as it was
 * before, and whether it was promoted.
 */
export async function recordLikeStatus(db: GenericDb, userId: string, songId: string, likeStatus: LikeStatus):
    Promise<{ song: Song | undefined; promoted: boolean }> {
    return await withTransaction(db, async tx => {
        await setUserSongLikeStatus(tx, userId, songId, likeStatus);
        await addRequests(tx, [{
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.SetSongLikeStatus,
            userId,
            songId,
            likeStatus,
        }]);

        const song = await getSong(tx, songId);
        const promoted = song != undefined && shouldPromoteOnLike(song.exploratory, song.tagsStale, likeStatus);
        if (promoted) {
            await enqueueSongRetag(tx, userId, songId, "strong");
            await markSongPromoted(tx, songId);
        }
        return { song, promoted };
    });
}

/** Records a Keep of an audition song and queues it. False, and nothing written, for a song that isn't one. */
export async function recordKeep(db: GenericDb, userId: string, songId: string): Promise<boolean> {
    return await withTransaction(db, async tx => {
        const song = await getSong(tx, songId);
        if (song == undefined || !song.exploratory) {
            return false;
        }

        await enqueueSongRetag(tx, userId, songId, "weak");
        await markSongKept(tx, songId);
        return true;
    });
}

/**
 * Stamps a song as played at `playedAt` and queues the stamp, creating the UserSong row if there is none yet. Returns
 * the row. This is what makes an audition song "heard" (deriveAuditionRowState), so it is the write a mix's purge
 * ends up keying off. The normal player calls it as a song starts; audition mode only once its heard rule is met.
 */
export async function recordPlayed(db: GenericDb, userId: string, songId: string, playedAt: Date): Promise<UserSong> {
    return await withTransaction(db, async tx => {
        let userSong = await getUserSong(tx, userId, songId);

        if (userSong == undefined) {
            // TODO: remove CreateUserSongRequest
            const newUserSongRequest: CreateUserSongRequest = {
                userId: userId,
                songId: songId,
                requestId: generateId(),
                timeRequested: playedAt,
                requestType: RequestType.CreateUserSong
            };

            userSong = {
                userId: newUserSongRequest.userId,
                songId: newUserSongRequest.songId,
                lastPlayed: newUserSongRequest.timeRequested,
                version: newUserSongRequest.timeRequested,
                likeStatus: LikeStatus.Neutral
            };
            await addUserSong(tx, userSong);
            await addRequests(tx, [newUserSongRequest]);
        }

        const updateSongLastPlayedRequest: UpdateSongLastPlayedRequest = {
            requestId: generateId(),
            lastPlayed: playedAt,
            songId: songId,
            timeRequested: playedAt,
            requestType: RequestType.UpdateSongLastPlayed,
            userId: userId
        };
        await updateUserSongLastPlayed(tx, userId, songId, playedAt);
        await addRequests(tx, [updateSongLastPlayedRequest]);
        return userSong;
    });
}
