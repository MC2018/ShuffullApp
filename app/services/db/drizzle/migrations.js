// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_mimic_current_db.sql';
import m0002 from './0002_remove_host_address.sql';
import m0003 from './0003_remove_user_song.sql';
import m0004 from './0004_readd_user_song.sql';
import m0005 from './0005_song_normal_name_index.sql';
import m0006 from './0006_reset_tables.sql';
import m0007 from './0007_add_notnull_req.sql';
import m0008 from './0008_add_request.sql';
import m0009 from './0009_reset_request.sql';
import m0010 from './0010_readd_request.sql';
import m0011 from './0011_add_download_manager.sql';
import m0012 from './0012_split_file_name.sql';
import m0013 from './0013_remove_current_playlist_id.sql';
import m0014 from './0014_create_downloaded_song.sql';
import m0015 from './0015_remove_current_song_id.sql';
import m0016 from './0016_add_genre_jam.sql';
import m0017 from './0017_add_tag_type.sql';
import m0018 from './0018_soft_reset_tables.sql';
import m0019 from './0019_readd_tables_with_string_ids.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009,
m0010,
m0011,
m0012,
m0013,
m0014,
m0015,
m0016,
m0017,
m0018,
m0019
    }
  }
  