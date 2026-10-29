const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The native app has its own installation rather than a package-manager workspace.
// Watch the shared presentation contract without pulling server dependencies into the bundle.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../lib')];
// Shared runtime contracts resolve their validator from the native installation, including EAS
// archives which deliberately contain no root node_modules or server package manifest.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  zod: path.resolve(__dirname, 'node_modules/zod'),
};
module.exports = config;
