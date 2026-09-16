const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Supplies the like/dislike/keep notification action icons for the track-player fork's Media3 custom buttons.
//
// The fork resolves a custom-action icon from an INTEGER index into a fixed built-in table (0..5). Its
// alternate { uri: "drawable_name" } path does not resolve on our stack, and an app-level resource override
// is masked by the fork's cached compiled resources. So we patch the fork's own drawable source files (in
// node_modules) and clear its build cache, then drive icons from JS by integer index. We override all six
// slots so the buttons can reflect state — outline when inactive, solid when active:
//
//   0 hearte_24px            -> thumb-up   outline  (like,    neutral)
//   1 heart_24px             -> thumb-up   solid    (like,    Liked)
//   2 baseline_repeat_24     -> thumb-down outline  (dislike, not disliked)
//   3 baseline_repeat_one_24 -> thumb-down solid    (dislike, disliked)
//   4 shuffle_24px           -> heart      solid    (like,    Loved)
//   5 ifl_24px               -> bookmark   outline  (keep,    audition songs only)
//
// Keep needs only ONE icon, unlike its neighbours: it is one-way (there is no un-keep) and keeping clears the
// song's `exploratory` flag, so the button removes itself rather than switching to a "kept" state.
//
// (We never use the fork's playmode/shuffle custom actions, so repurposing these slots is safe.)
// Runs during `expo prebuild`, so it re-applies after `prebuild --clean` and after any reinstall.

// Material Design thumb paths (viewBox 24x24), filled white; Android tints them per-context.
const THUMB_UP_SOLID =
  "M23,10C23,8.89 22.1,8 21,8H14.68L15.64,3.43C15.66,3.33 15.67,3.22 15.67,3.11C15.67,2.7 15.5,2.32 15.23,2.05L14.17,1L7.59,7.58C7.22,7.95 7,8.45 7,9V19A2,2 0 0,0 9,21H18C18.83,21 19.54,20.5 19.84,19.78L22.86,12.73C22.95,12.5 23,12.26 23,12V10M1,21H5V9H1V21Z";
const THUMB_UP_OUTLINE =
  "M5,9V21H1V9H5M9,21A2,2 0 0,1 7,19V9C7,8.45 7.22,7.95 7.59,7.59L14.17,1L15.23,2.06C15.5,2.33 15.67,2.7 15.67,3.11L15.64,3.43L14.69,8H21C22.11,8 23,8.9 23,10V12C23,12.26 22.95,12.5 22.86,12.73L19.84,19.78C19.54,20.5 18.83,21 18,21H9M9,19H18.03L21,12V10H12.21L13.34,4.68L9,9.03V19Z";
const THUMB_DOWN_SOLID =
  "M19,15H23V3H19M15,3H6C5.17,3 4.46,3.5 4.16,4.22L1.14,11.27C1.05,11.5 1,11.74 1,12V14A2,2 0 0,0 3,16H9.31L8.36,20.57C8.34,20.67 8.33,20.77 8.33,20.88C8.33,21.3 8.5,21.67 8.77,21.94L9.83,23L16.41,16.41C16.78,16.05 17,15.55 17,15V5C17,3.89 16.1,3 15,3Z";
const THUMB_DOWN_OUTLINE =
  "M19,15V3H23V15H19M15,3A2,2 0 0,1 17,5V15C17,15.55 16.78,16.05 16.41,16.41L9.83,23L8.77,21.94C8.5,21.67 8.33,21.3 8.33,20.88L8.36,20.57L9.31,16H3C1.89,16 1,15.1 1,14V12C1,11.74 1.05,11.5 1.14,11.27L4.16,4.22C4.46,3.5 5.17,3 6,3H15M15,5H5.97L3,12V14H11.78L10.65,19.32L15,14.97V5Z";
const HEART_SOLID =
  "M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z";
// Matches the in-app KeepControl's bookmark-outline glyph, so the same action reads the same in both places.
const BOOKMARK_OUTLINE =
  "M17,3H7A2,2 0 0,0 5,5V21L12,18L19,21V5C19,3.89 18.1,3 17,3M17,18L12,15.82L7,18V5H17V18Z";

const DRAWABLES = {
  hearte_24px: THUMB_UP_OUTLINE, // index 0
  heart_24px: THUMB_UP_SOLID, // index 1
  baseline_repeat_24: THUMB_DOWN_OUTLINE, // index 2
  baseline_repeat_one_24: THUMB_DOWN_SOLID, // index 3
  shuffle_24px: HEART_SOLID, // index 4 (Loved)
  ifl_24px: BOOKMARK_OUTLINE, // index 5 (Keep)
};

const vector = (pathData) =>
  `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="${pathData}" />
</vector>
`;

function writeDrawables(dir) {
  if (!fs.existsSync(dir)) return;
  for (const [name, pathData] of Object.entries(DRAWABLES)) {
    fs.writeFileSync(path.join(dir, `${name}.xml`), vector(pathData));
  }
}

module.exports = function withNotificationActionIcons(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      // 1) App res (override attempt; harmless if the merge doesn't favour it).
      const appDrawableDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable"
      );
      fs.mkdirSync(appDrawableDir, { recursive: true });
      writeDrawables(appDrawableDir);

      // 2) The fork's own res inside node_modules (the reliable patch — library ships thumbs directly).
      const forkAndroid = path.join(
        cfg.modRequest.projectRoot,
        "node_modules",
        "react-native-track-player",
        "android"
      );
      writeDrawables(path.join(forkAndroid, "src", "main", "res", "drawable"));

      // 3) Delete the fork module's build cache. `prebuild --clean` only cleans the app's android/, so the
      // fork's previously-compiled resources linger in node_modules/.../android/build and get repackaged,
      // masking our patched source. Removing it forces gradle to recompile the drawables from source.
      fs.rmSync(path.join(forkAndroid, "build"), { recursive: true, force: true });

      return cfg;
    },
  ]);
};
