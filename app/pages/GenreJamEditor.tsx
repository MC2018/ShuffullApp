import { Button, ScrollView, Text, View, StyleSheet, TextInput, TouchableOpacity, Modal } from "react-native";
import React, { ReactNode, useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import { MediaManager, generateId } from "../tools";
import PlayerBar, { totalPlayerBarHeight } from "../components/music-control/organisms/PlayerBar";
import { FilterPillInfo, WhitelistingMode, WhitelistingStatus } from "../components/whitelist-filter/atoms/FilterSelectionPill";
import { GenreJam } from "../services/db/models";
import { SongFilters } from "../types/SongFilters";
import FilterSelectionType from "../components/whitelist-filter/molecules/FilterSelectionType";
import { TagType } from "../services/db/schema";
import FilterPillSelector from "../components/whitelist-filter/molecules/FilterPillSelector";
import ModalPopupTemplate from "../components/common/templates/ModalPopupTemplate";

export default function GenreJamEditor({ navigation, route }: any) {
    const db = useDb();
    const [ modalVisible, setModalVisible ] = useState(false);
    const { userId } = route.params;
    const [ filterType, setFilterType ] = useState<FilterType>();
    const [ modalContents, setModalContents ] = useState<ReactNode>();
    const [filters, setFilters] = useState({
        playlists: [] as FilterPillInfo<string>[],
        artists: [] as FilterPillInfo<string>[],
        genres: [] as FilterPillInfo<string>[],
        timePeriods: [] as FilterPillInfo<string>[],
        languages: [] as FilterPillInfo<string>[],
    });
    type FilterType = keyof typeof filters;
    const handleUpdatedSelection = (filterType: FilterType, pillInfo: FilterPillInfo<string>, newStatus: WhitelistingStatus) => {
        setFilters(prevFilters => {
            const newFilter = prevFilters[filterType].map(x => 
                x.id === pillInfo.id ? { ...x, whitelistingStatus: newStatus } : x
            );
            const newFilters = { ...prevFilters, [filterType]: newFilter };

            
            return newFilters;
        });
    };

    const handleEditRequest = (filterType: FilterType) => {
        configureSelectedFilter(filterType);
    };

    useEffect(() => {
        (async () => {
            const playlists = await DbQueries.getPlaylists(db, userId);
            const artists = await DbQueries.getArtists(db);
            const tags = await DbQueries.getTags(db);
            const genres = tags.filter(x => x.type == TagType.Genre);
            const timePeriods = tags.filter(x => x.type == TagType.TimePeriod);
            const languages = tags.filter(x => x.type == TagType.Language);
            const newFilters = {
                playlists: playlists.map(playlist => ({ id: playlist.playlistId, displayName: playlist.name, selected: false, whitelistingStatus: WhitelistingStatus.None })),
                artists: artists.map(artist => ({ id: artist.artistId, displayName: artist.name, selected: false, whitelistingStatus: WhitelistingStatus.None })),
                genres: genres.map(tag => ({ id: tag.tagId, displayName: tag.name, selected: false, whitelistingStatus: WhitelistingStatus.None })),
                timePeriods: timePeriods.map(tag => ({ id: tag.tagId, displayName: tag.name, selected: false, whitelistingStatus: WhitelistingStatus.None })),
                languages: languages.map(tag => ({ id: tag.tagId, displayName: tag.name, selected: false, whitelistingStatus: WhitelistingStatus.None })),
            };
            setFilters(newFilters);
        })();
    }, []);

    const configureSelectedFilter = async (newFilterType: FilterType) => {
        setFilterType(newFilterType);
        setModalVisible(true);
    }

    useEffect(() => {
        let newModalContents;
        let pillsInfo;
        
        if (filterType == undefined) {
            newModalContents = <></>;
        } else {
            pillsInfo = filters[filterType];
            newModalContents = <FilterPillSelector pillsInfo={pillsInfo} onUpdateSelection={(pillInfo, newStatus) => handleUpdatedSelection(filterType, pillInfo, newStatus)}></FilterPillSelector>;
        }

        setModalContents(newModalContents);
    }, [filters, filterType]);

    const generateGenreJam = (name: string) => {
        const genreJam: GenreJam = {
            genreJamId: generateId(),
            name: name,
            whitelists: {
                artistIds: filters.artists.filter(x => x.whitelistingStatus == WhitelistingStatus.Whitelisted).map(x => x.id),
                playlistIds: filters.playlists.filter(x => x.whitelistingStatus == WhitelistingStatus.Whitelisted).map(x => x.id),
                genreIds: filters.genres.filter(x => x.whitelistingStatus == WhitelistingStatus.Whitelisted).map(x => x.id),
                timePeriodIds: filters.timePeriods.filter(x => x.whitelistingStatus == WhitelistingStatus.Whitelisted).map(x => x.id),
                languageIds: filters.languages.filter(x => x.whitelistingStatus == WhitelistingStatus.Whitelisted).map(x => x.id),
            },
            blacklists: {
                artistIds: filters.artists.filter(x => x.whitelistingStatus == WhitelistingStatus.Blacklisted).map(x => x.id),
                playlistIds: filters.playlists.filter(x => x.whitelistingStatus == WhitelistingStatus.Blacklisted).map(x => x.id),
                genreIds: filters.genres.filter(x => x.whitelistingStatus == WhitelistingStatus.Blacklisted).map(x => x.id),
                timePeriodIds: filters.timePeriods.filter(x => x.whitelistingStatus == WhitelistingStatus.Blacklisted).map(x => x.id),
                languageIds: filters.languages.filter(x => x.whitelistingStatus == WhitelistingStatus.Blacklisted).map(x => x.id),
            },
        };
        return genreJam;
    };

    const handleSetAndStart = async () => {
        const genreJam = generateGenreJam("TODO");
        const songFilters = SongFilters.fromGenreJam(genreJam, false);
        MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <>
        <View
            style={{
                flex: 1,
                paddingBottom: totalPlayerBarHeight
            }}>
            <Text style={{fontSize: 24, marginBottom: 20}}>Genre Jam Editor</Text>
            <Button title="Set and Start" onPress={handleSetAndStart} />

            <Text style={{fontSize: 24}}>Primary Filters</Text>
            <FilterSelectionType title="Playlists" pillsInfo={filters.playlists} onEditRequest={() => handleEditRequest("playlists")}></FilterSelectionType>
            <FilterSelectionType title="Artists" pillsInfo={filters.artists} onEditRequest={() => handleEditRequest("artists")}></FilterSelectionType>
            
            <Text style={{fontSize: 24, marginTop: 20}}>Secondary Filters</Text>
            <FilterSelectionType title="Genres" pillsInfo={filters.genres} onEditRequest={() => handleEditRequest("genres")}></FilterSelectionType>
            <FilterSelectionType title="Time Periods" pillsInfo={filters.timePeriods} onEditRequest={() => handleEditRequest("timePeriods")}></FilterSelectionType>
            <FilterSelectionType title="Languages" pillsInfo={filters.languages} onEditRequest={() => handleEditRequest("languages")}></FilterSelectionType>

            {/* Modal */}
            <ModalPopupTemplate visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
                {modalContents}
            </ModalPopupTemplate>
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}

const styles = StyleSheet.create({
    whitelistText: {
        fontSize: 20,
    },
    blacklistText: {
        fontSize: 20,
        paddingTop: 10,
    },
    clickModalText: {
        fontSize: 16
    },
    modalGrayView: {
        backgroundColor: "#00000055",
        width: "100%",
        height: "100%"
    },
    modalView: {
        backgroundColor: "white",
        height: "85%",
        width: "80%",
        margin: "auto"
    },
});