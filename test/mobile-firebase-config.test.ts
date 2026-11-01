import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const { configureFirebase } = createRequire(import.meta.url)('../mobile/build-config/firebase.cjs');
const config = { name: 'OneHR+', android: { package: 'ai.stradaverse.aihr.test', allowBackup: false }, extra: { existing: true } };
const dirs: string[] = [];
function file(value: unknown) { const dir = mkdtempSync(join(tmpdir(), 'onehr-firebase-')); dirs.push(dir); const p = join(dir, 'registration.json'); writeFileSync(p, JSON.stringify(value)); return p; }
const registration = () => ({ project_info: { project_number: '12345', project_id: 'synthetic-project' }, client: [{ client_info: { mobilesdk_app_id: '1:12345:android:synthetic', android_client_info: { package_name: config.android.package } }, api_key: [{ current_key: 'synthetic-public-client-key' }] }] });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('Android Firebase build configuration', () => {
  it('requires registration on production Android builds, while allowing explicit push-unprovisioned review builds', () => {
    expect(() => configureFirebase(config, { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production' })).toThrow('GOOGLE_SERVICES_JSON');
    expect(configureFirebase(config, { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' })).toEqual(config);
    expect(configureFirebase(config, {})).toEqual(config);
    expect(configureFirebase(config, {EAS_BUILD:'true',EAS_BUILD_PLATFORM:'android',EAS_BUILD_PROFILE:'android-local-signing'})).toEqual(config);
  });
  it('wires only the validated file path and preserves security and project settings', () => {
    const p = file(registration()); const result = configureFirebase(config, { GOOGLE_SERVICES_JSON: p });
    expect(result).toEqual({ ...config, android: { ...config.android, googleServicesFile: p } });
    expect(JSON.stringify(result)).not.toContain('synthetic-public-client-key');
  });
  it('rejects server keys, mismatched packages, incomplete and unavailable files', () => {
    expect(() => configureFirebase(config, { GOOGLE_SERVICES_JSON: file({ type: 'service_account', private_key: 'synthetic-private' }) })).toThrow('never a service-account');
    const wrong = registration(); wrong.client[0].client_info.android_client_info.package_name = 'other.app';
    expect(() => configureFirebase(config, { GOOGLE_SERVICES_JSON: file(wrong) })).toThrow('does not match');
    expect(() => configureFirebase(config, { GOOGLE_SERVICES_JSON: file({}) })).toThrow('incomplete');
    expect(() => configureFirebase(config, { GOOGLE_SERVICES_JSON: '/nonexistent/registration.json' })).toThrow('unavailable');
  });
});
