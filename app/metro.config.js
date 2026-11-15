const fs = require('fs');
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// Three generated modules feed the offline map:
//   buddy-maplibre -> src/map/generated/maplibre.js (scripts/build-map-assets.mjs, run on npm install)
//   buddy-tiles    -> src/map/generated/tiles.js    (scripts/build-tiles.mjs, run once while online)
//   buddy-aerial   -> src/map/generated/aerial.js   (scripts/build-aerial.mjs, run once while online)
// If tiles or aerial photos were never built, those fall back to an empty set.
const generated = path.join(__dirname, 'src/map/generated');
const aliases = {
  'buddy-maplibre': () => path.join(generated, 'maplibre.js'),
  'buddy-tiles': () => {
    const built = path.join(generated, 'tiles.js');
    return fs.existsSync(built) ? built : path.join(__dirname, 'src/map/noTiles.js');
  },
  'buddy-aerial': () => {
    const built = path.join(generated, 'aerial.js');
    return fs.existsSync(built) ? built : path.join(__dirname, 'src/map/noAerial.js');
  },
};

const defaultConfig = getDefaultConfig(__dirname);
// Keep React Native's own resolver: it is what sends `react-native` to
// `react-native-macos` when building for macOS. Replacing it breaks the app.
const upstream = defaultConfig.resolver.resolveRequest;

const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (aliases[moduleName]) return { type: 'sourceFile', filePath: aliases[moduleName]() };
      return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
