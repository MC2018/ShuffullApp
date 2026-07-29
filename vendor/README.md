# Vendored packages

## react-native-track-player-4.1.1-lovegaoshi-33a3ecd.tgz

Prebuilt artifact of `github:lovegaoshi/react-native-track-player#33a3ecd0522c4d47576153b820c1da68942813cd`
(the fork this app pins), with `lib/` already compiled by tsc and the lifecycle scripts stripped.

Why a tarball instead of the git URL: the fork's `prepare` script is `yarn build`, and installing a
git-hosted dependency makes the package manager run that build in a sandbox at install time. That made
every install depend on yarn + network + the sandbox's PATH quirks — and under pnpm it failed outright
(`spawn ENOENT`, exit 127: yarn is invisible inside pnpm's prepare environment). A prebuilt tarball
removes the build step from installs entirely: deterministic, offline, works identically under npm and
pnpm.

To update the fork:
1. Clone/checkout the desired commit of lovegaoshi/react-native-track-player.
2. `npm install && npx tsc` (produces `lib/`).
3. Repack honoring the package.json `files` globs with lifecycle scripts stripped (see the `_vendored`
   marker inside the tarball's package.json), name it with the new short SHA, update the `file:` spec in
   package.json, and `pnpm install`.
