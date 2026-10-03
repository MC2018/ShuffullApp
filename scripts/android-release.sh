#!/usr/bin/env bash
# Build the daily-driver Android app ("Shuffull", com.mc2018.shuffullapp) and install it over the existing one.
#
#   scripts/android-release.sh              # build, install -r on the attached device, print the installed version
#   scripts/android-release.sh --no-install # build only; prints the APK path
#
#   ARCHS=arm64-v8a scripts/android-release.sh   # one ABI only (faster); x86_64 for the emulator
#   ANDROID_SERIAL=<serial> ...                  # pick a device when more than one is attached (adb reads it)
#
# The release build bundles the JS, so it runs with Metro stopped. It installs alongside "Shuffull Dev"
# (com.mc2018.shuffullapp.dev, the dev client built by `pnpm android`) rather than replacing it.
#
# Signing: release is NEVER signed with android/app/debug.keystore (it is public). The key lives outside the
# repo and outside Syncthing, and its settings come from ~/.gradle/gradle.properties. Every update of the
# installed app must be signed with the SAME key, or Android refuses it and the only way out is uninstalling,
# which deletes the local DB, the downloads and any outbox rows not yet synced.

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="com.mc2018.shuffullapp"
APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
GRADLE_PROPS="${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties"
SIGNING_KEYS=(SHUFFULL_RELEASE_STORE_FILE SHUFFULL_RELEASE_STORE_PASSWORD SHUFFULL_RELEASE_KEY_ALIAS SHUFFULL_RELEASE_KEY_PASSWORD)

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/temurin-17}"
export PATH="$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH"

INSTALL=1
case "${1:-}" in
  --no-install) INSTALL=0 ;;
  "") ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac

# Same lookup as android/app/build.gradle: a Gradle property, else an env var of the same name.
signing_value() {
  local key="$1" line
  line="$(grep -E "^[[:space:]]*$key[[:space:]]*=" "$GRADLE_PROPS" 2>/dev/null | tail -1 || true)"
  if [ -n "$line" ]; then printf '%s' "${line#*=}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; else printf '%s' "${!key:-}"; fi
}

missing=()
for key in "${SIGNING_KEYS[@]}"; do [ -n "$(signing_value "$key")" ] || missing+=("$key"); done
if [ "${#missing[@]}" -gt 0 ]; then
  cat >&2 <<EOF
Release signing is not configured (missing: ${missing[*]}).

One-time setup — keep the key OUT of the repo and out of ~/MasterSync:

  mkdir -p ~/.android-keys && chmod 700 ~/.android-keys
  keytool -genkeypair -v -storetype PKCS12 -keystore ~/.android-keys/shuffull-release.p12 \\
    -alias shuffull -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Shuffull"

then add to $GRADLE_PROPS (PKCS12 uses one password for both):

  SHUFFULL_RELEASE_STORE_FILE=$HOME/.android-keys/shuffull-release.p12
  SHUFFULL_RELEASE_STORE_PASSWORD=<password>
  SHUFFULL_RELEASE_KEY_ALIAS=shuffull
  SHUFFULL_RELEASE_KEY_PASSWORD=<password>

Back the .p12 and its password up somewhere other than this machine. Lose it and the installed app can never
be updated again, only uninstalled (losing its local data). With Play App Signing it becomes the upload key.
EOF
  exit 1
fi
store="$(signing_value SHUFFULL_RELEASE_STORE_FILE)"
store="${store/#\~/$HOME}"
[ -f "$store" ] || { echo "SHUFFULL_RELEASE_STORE_FILE points at $store, which does not exist." >&2; exit 1; }

gradle_args=(assembleRelease)
[ -n "${ARCHS:-}" ] && gradle_args+=("-PreactNativeArchitectures=$ARCHS")

echo "==> building release ($(git -C "$APP" rev-parse --short=7 HEAD)${ARCHS:+, $ARCHS})"
# APP_VARIANT=production so the config embedded in the bundle (Constants.expoConfig) matches the native app.
( cd "$APP/android" && APP_VARIANT=production CI=1 ./gradlew "${gradle_args[@]}" )
echo "==> $APK"

[ "$INSTALL" = 1 ] || exit 0

echo "==> installing over the existing $PKG (data is kept)"
if ! out="$(adb install -r "$APK" 2>&1)"; then
  echo "$out" >&2
  if grep -q INSTALL_FAILED_UPDATE_INCOMPATIBLE <<<"$out"; then
    cat >&2 <<EOF

The installed $PKG is signed with a different key (the old debug-signed build, or a different release key).
Android will not update it in place. The way out is uninstalling it, which DELETES its local DB and downloads.
Before that, make sure its outbox is empty (unsynced Keeps/Likes live there):

  adb exec-out run-as $PKG cat files/SQLite/shuffull-db > /tmp/shuffull-before-uninstall.db
  sqlite3 /tmp/shuffull-before-uninstall.db 'select count(*) from requests;'   # must be 0

then: adb uninstall $PKG && $0
(run-as only works while the installed build is debuggable, i.e. the old debug-signed one.)
EOF
  elif grep -q INSTALL_FAILED_VERSION_DOWNGRADE <<<"$out"; then
    echo "The installed build has a higher versionCode (commit count). Build from a later commit." >&2
  fi
  exit 1
fi
adb shell dumpsys package "$PKG" | grep -E 'versionName|versionCode' | sed 's/^ */   /' | sort -u
