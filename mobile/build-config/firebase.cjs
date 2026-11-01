const fs = require('node:fs');
const path = require('node:path');

/** Build-time only. Never put the registration JSON or server credentials in extra/public env. */
function configureFirebase(config, env = process.env, projectRoot = path.resolve(__dirname, '..')) {
  const file = env.GOOGLE_SERVICES_JSON;
  const androidBuild = env.EAS_BUILD === 'true' && env.EAS_BUILD_PLATFORM === 'android' && env.EAS_BUILD_PROFILE === 'production';
  if (!file) {
    if (androidBuild) throw new Error('Android push requires the GOOGLE_SERVICES_JSON EAS file variable.');
    return config;
  }
  const resolved = path.resolve(projectRoot, file);
  if (!fs.existsSync(resolved)) throw new Error('Firebase Android registration file is unavailable.');
  let data;
  try { data = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch { throw new Error('Firebase Android registration must be valid JSON.'); }
  if (!data || typeof data !== 'object' || data.type === 'service_account' || data.private_key) {
    throw new Error('Use the Android app registration, never a service-account key.');
  }
  const clients = Array.isArray(data.client) ? data.client : [];
  const client = clients.find(c => c?.client_info?.android_client_info?.package_name === config.android?.package);
  const info = data.project_info;
  if (!client || !info?.project_number || !info?.project_id || !client.client_info?.mobilesdk_app_id ||
      !client.api_key?.some(k => typeof k.current_key === 'string' && k.current_key.length > 0)) {
    throw new Error('Firebase Android registration is incomplete or does not match this app package.');
  }
  return { ...config, android: { ...config.android, googleServicesFile: resolved } };
}
module.exports = { configureFirebase };
