# Shuffull app

The client for [Shuffull](https://github.com/MC2018/Shuffull), a self-hosted music library. One TypeScript codebase
(Expo, React Native, Expo Router) runs on Android, the web and an Electron desktop app; iOS is configured but not
built from this repo today. It talks to the Shuffull API over HTTP (`https://shuffull-api.clausius.app` unless the
login screen says otherwise), keeps a local SQLite copy of the library, and can download songs to play offline.

## Get started

Use **pnpm**, not npm: the version is pinned in `package.json` (`packageManager`), and `pnpm-workspace.yaml` holds
the hoisted layout and the security overrides that npm would ignore.

```bash
pnpm install
pnpm test                 # Vitest: pure logic, schemas and the query layer on in-memory SQLite
pnpm lint
pnpm exec tsc --noEmit    # typecheck (there is no script for it)
```

| Target | Run |
|---|---|
| Android (dev client) | `pnpm android`, then `APP_VARIANT=development pnpm start --dev-client` |
| Android (release) | `pnpm android:release` |
| Web | `pnpm web` |
| Desktop (Electron) | `pnpm desktop` builds the web export and opens it; `pnpm desktop:run` reopens the last build |

The app uses a development build, not Expo Go: it carries native modules Expo Go doesn't have (track player,
argon2, background actions).

## Where things are

- `app/` holds the screens (file-based routes, see [Expo Router](https://docs.expo.dev/router/introduction)) and
  everything under them: `services/` (API client, sync and outbox, local DB, downloads, playback), `components/`,
  `tools/`.
- `app/services/db/` is the local database: Drizzle schema, queries and the SQL migrations in `drizzle/`.
  `database.ts` opens it on mobile, `database.web.ts` on web and desktop.
- `desktop/` is the Electron shell around the web build.
- `tests/` is the Vitest suite. It runs under Node, so it imports only modules that don't need React Native.
- `android/` is committed and is what Android builds use; `app.config.ts` mirrors its IDs and schemes.

## Android: two apps on one phone

| | App ID | Build | Needs Metro |
|---|---|---|---|
| **Shuffull** (daily driver) | `com.mc2018.shuffullapp` | `pnpm android:release` | no, JS is bundled |
| **Shuffull Dev** (orange icon) | `com.mc2018.shuffullapp.dev` | `pnpm android` | yes: `APP_VARIANT=development pnpm start --dev-client` |

They install side by side, each with its own local DB and login, but both talk to the same server
account. The installed build is shown at the bottom of Home (`1.0.0+<commit> (<commit count>)`).

The release build is signed with a private key kept outside the repo; `scripts/android-release.sh`
prints the one-time setup when it is missing. Every update of the installed daily driver has to be
signed with that same key, or Android refuses it and the only way out is an uninstall, which deletes
its local data.
