const fs = require('fs');
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// Two generated modules feed the offline map:
//   buddy-maplibre -> src/map/generated/maplibre.js (scripts/build-map-assets.mjs, run on npm install)
//   buddy-tiles    -> src/map/generated/tiles.js    (scripts/build-tiles.mjs, run once while online)
// If tiles were never built, buddy-tiles falls back to an empty set.
const generated = path.join(__dirname, 'src/map/generated');
const aliases = {
  'buddy-maplibre': () => path.join(generated, 'maplibre.js'),
  'buddy-tiles': () => {
    const built = path.join(generated, 'tiles.js');
    return fs.existsSync(built) ? built : path.join(__dirname, 'src/map/noTiles.js');
  },
};

const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (aliases[moduleName]) return { type: 'sourceFile', filePath: aliases[moduleName]() };
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
