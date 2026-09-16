const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Drizzle ships migrations as .sql files that are imported as modules.
config.resolver.sourceExts.push('sql');

// expo-sqlite's web build imports a .wasm binary. Even though the web target does not use expo-sqlite,
// expo-router's require.context enumerates every file under app/ — including database.ts — so its import
// graph is walked when bundling for web. Treating .wasm as an asset keeps that walk resolvable.
config.resolver.assetExts.push('wasm');

// react-native-track-player is native-only: it calls TurboModuleRegistry.getEnforcing at module scope,
// which throws during bundle evaluation on web and takes the app down before React mounts. Point the web
// bundle at an HTMLAudioElement-backed stand-in with the same surface, so mediaManager and the transport
// components run unmodified. Covers the deep import the app uses for getPlaybackState too.
const path = require('path');
const webTrackPlayer = path.join(__dirname, 'shims/trackPlayer.web.ts');
const prevResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName.startsWith('react-native-track-player')) {
    return { type: 'sourceFile', filePath: webTrackPlayer };
  }
  return (prevResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
