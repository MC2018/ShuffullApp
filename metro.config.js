const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Drizzle ships migrations as .sql files that are imported as modules.
config.resolver.sourceExts.push('sql');

// expo-sqlite's web build imports a .wasm binary. Even though the web target does not use expo-sqlite,
// expo-router's require.context enumerates every file under app/ — including database.ts — so its import
// graph is walked when bundling for web. Treating .wasm as an asset keeps that walk resolvable.
config.resolver.assetExts.push('wasm');

module.exports = config;
