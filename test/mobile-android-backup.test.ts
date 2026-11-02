import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const mobileRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
const { compileModsAsync, AndroidConfig, XML } = mobileRequire('expo/config-plugins');
const secureStore = mobileRequire('expo-secure-store/app.plugin.js');
const backup = mobileRequire('./build-config/with-private-android-backup.cjs');
const appConfig = JSON.parse(readFileSync(new URL('../mobile/app.json', import.meta.url), 'utf8')).expo;
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function generate(defaultSecureStore = false, reverse = false) {
  const root = mkdtempSync(join(tmpdir(), 'onehr-backup-policy-'));
  directories.push(root);
  const main = join(root, 'android/app/src/main');
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".MainApplication" android:allowBackup="true" android:fullBackupContent="@xml/secure_store_backup_rules" android:dataExtractionRules="@xml/secure_store_data_extraction_rules" /></manifest>');
  let config: any = { name: 'OneHR+', slug: 'onehr-backup-fixture', android: { package: 'ai.stradaverse.aihr.test', allowBackup: true } };
  const secure = (value: any) => secureStore(value, { configureAndroidBackup: defaultSecureStore });
  config = reverse ? secure(backup(config)) : backup(secure(config));
  await compileModsAsync(config, { projectRoot: root, platforms: ['android'] });
  return { root, main };
}

describe('Android private-data backup boundary', () => {
  it('registers the app policy after SecureStore without its permissive defaults', () => {
    expect(appConfig.android.allowBackup).toBe(false);
    expect(appConfig.plugins.find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-secure-store'))
      .toEqual(['expo-secure-store', { configureAndroidBackup: false }]);
    expect(appConfig.plugins.at(-1)).toBe('./build-config/with-private-android-backup.cjs');
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    'generates closed legacy/cloud/D2D rules through actual Expo mods (SecureStore defaults=%s, reverse=%s)',
    async (defaults, reverse) => {
      const { main } = await generate(defaults, reverse);
      const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(join(main, 'AndroidManifest.xml'));
      const attributes = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest).$;
      expect(attributes['android:allowBackup']).toBe('false');
      expect(attributes['android:fullBackupContent']).toBe('@xml/onehr_private_backup_rules');
      expect(attributes['android:dataExtractionRules']).toBe('@xml/onehr_private_data_extraction_rules');
      const legacy = await XML.parseXMLAsync(readFileSync(join(main, 'res/xml/onehr_private_backup_rules.xml'), 'utf8'));
      const modern = await XML.parseXMLAsync(readFileSync(join(main, 'res/xml/onehr_private_data_extraction_rules.xml'), 'utf8'));
      const policy = modern['data-extraction-rules'];
      const sections = [legacy['full-backup-content'], policy['cloud-backup'][0], policy['device-transfer'][0]];
      for (const section of sections) {
        expect(section.include).toBeUndefined();
        const rules = section.exclude.map((entry: any) => entry.$);
        // Independent coverage inventory includes current widget, secure credentials,
        // offline files/databases, external app files and device-protected storage.
        for (const domain of ['sharedpref', 'database', 'file', 'root', 'external',
          'device_sharedpref', 'device_database', 'device_file', 'device_root']) {
          expect(rules).toContainEqual({ domain, path: '.' });
        }
        expect(rules).toHaveLength(9);
      }
      expect(policy['cloud-backup'][0].$.disableIfNoEncryptionCapabilities).toBe('true');
    },
  );
});
