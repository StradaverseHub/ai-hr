const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The native app has its own installation rather than a package-manager workspace.
// Watch the shared presentation contract without pulling server dependencies into the bundle.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../lib')];
module.exports = config;
