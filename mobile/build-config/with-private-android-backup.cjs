const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// Device-bound credentials, pending operations and attendance snapshots must be
// recovered from the authenticated server, never carried to another installation.
// Explicit rules cover OEM D2D paths which may ignore allowBackup=false.
const domains = ['root', 'file', 'database', 'sharedpref', 'external',
  'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const exclusions = domains.map(domain => `    <exclude domain="${domain}" path="." />`).join('\n');
const legacy = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${exclusions}
</full-backup-content>
`;
const extraction = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapabilities="true">
${exclusions}
  </cloud-backup>
  <device-transfer>
${exclusions}
  </device-transfer>
</data-extraction-rules>
`;

module.exports = function withPrivateAndroidBackup(config) {
  config.android = { ...config.android, allowBackup: false };
  config = withAndroidManifest(config, mod => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app.$['android:allowBackup'] = 'false';
    app.$['android:fullBackupContent'] = '@xml/onehr_private_backup_rules';
    app.$['android:dataExtractionRules'] = '@xml/onehr_private_data_extraction_rules';
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const directory = join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'onehr_private_backup_rules.xml'), legacy);
    await writeFile(join(directory, 'onehr_private_data_extraction_rules.xml'), extraction);
    return mod;
  }]);
};
