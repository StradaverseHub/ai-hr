const { configureFirebase } = require('./build-config/firebase.cjs');

// EAS file variables are resolved on the builder; only their path enters Expo configuration.
module.exports = ({ config }) => configureFirebase(config);
