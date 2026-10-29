/**
 * ADR-0161 — the shared workplace setup signer and the server-side verifier. Pure node: no database.
 *
 * Non-vacuity: every refusal is asserted by its CODE, and the happy path is judged by the installed
 * app's own verifier (mobile/lib/company-profile.ts), not by the server verifier under test.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SETUP_CLOCK_SKEW_SECONDS, SETUP_LIFETIME_SECONDS, WorkplaceSetupSignerError, approvedAnchor, loadSigningKey,
  setupHosting, signCompanyProfile, workplaceProfile,
} from '../lib/mobile-workplace-setup-signer';
import {
  SETUP_RENEWAL_WINDOW_SECONDS, WorkplaceSetupRefusal, verifySignedSetup, verifyWorkplaceSetup,
} from '../lib/mobile-workplace-setup-verify';
import { parseStoredSetup } from '../lib/mobile-workplace-setup-record';
import { INSTALLED_APP_TRUST } from '../lib/mobile-trust-anchors';
import { readWorkplaceSetupLink } from '../lib/mobile-workplace-setup';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';

const root = mkdtempSync(join(tmpdir(), 'aihr-setup-signer-'));
const app = join(root, 'app');
mkdirSync(app);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pair = generateKeyPairSync('ed25519');
const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
const keyPath = join(root, 'signing.pem');
writeFileSync(keyPath, pem, { mode: 0o600 });
const trust = [{ keyId: 'test-anchor', publicKey: pair.publicKey.export({ format: 'jwk' }).x! }];
const now = Math.floor(Date.now() / 1000);
const ORIGIN = 'https://hr.example.test';
const input = { origin: ORIGIN, organization: 'acme-co', name: 'Acme 人事', hosting: 'cloud' as const };

function code(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof WorkplaceSetupSignerError || error instanceof WorkplaceSetupRefusal) return error.code;
    throw error;
  }
  return 'accepted';
}
const signed = (profile = workplaceProfile(input, { now }), key: KeyObject = pair.privateKey) => signCompanyProfile(profile, key, trust, now);
/** Signs with its own key while claiming the trusted key id. */
const impostor = generateKeyPairSync('ed25519');

describe('per-customer profile derivation', () => {
  it('derives every field from the embedded-sign-in contract and the app verifier accepts the signature', () => {
    const profile = workplaceProfile({ ...input, organization: ' Acme-Co ', name: '  Acme 人事 ' }, { now });
    expect(profile).toEqual({
      connectionVersion: 1, apiVersion: 'v1', authProvider: 'internal', apiOrigin: ORIGIN, issuer: ORIGIN + '/auth',
      clientId: 'aihr-mobile', audience: 'aihr-api', id: 'acme-co', name: 'Acme 人事', organization: 'acme-co', hosting: 'cloud',
      notBefore: now - SETUP_CLOCK_SKEW_SECONDS, expiresAt: now + SETUP_LIFETIME_SECONDS,
    });
    const raw = JSON.stringify(signed(profile));
    // The installed app's verifier — independent of the server code under test.
    expect({ ...verifyCompanyProfile(raw, trust) }).toEqual(profile);
    const verified = verifyWorkplaceSetup(raw, { trust, origin: ORIGIN, organization: 'acme-co', now });
    expect(verified.keyId).toBe('test-anchor');
    expect(JSON.parse(readWorkplaceSetupLink(verified.links.web))).toEqual(JSON.parse(raw));
    expect(verified.links.web.startsWith(ORIGIN + '/login/mobile-setup#setup=')).toBe(true);
  });
  it('starts validity before the signing second so a phone clock that trails the server still accepts it', () => {
    const raw = JSON.stringify(signed());
    expect(() => verifyCompanyProfile(raw, trust, now - 60)).not.toThrow();
  });
  it('caps validity at a trust anchor expiry when the anchor carries one, and refuses an exhausted anchor', () => {
    expect(workplaceProfile(input, { now, anchor: { ...trust[0], expiresAt: now + 1000 } }).expiresAt).toBe(now + 1000);
    expect(code(() => workplaceProfile(input, { now, anchor: { ...trust[0], expiresAt: now } }))).toBe('anchor_validity');
    expect(code(() => signCompanyProfile(workplaceProfile(input, { now }), pair.privateKey, [{ ...trust[0], expiresAt: now + 10 }], now))).toBe('anchor_validity');
  });
  it.each(['http://hr.example.test', 'https://hr.example.test/path', 'https://user:pass@hr.example.test', 'https://hr.example.test/?q=1', 'not a url'])(
    'refuses the non-canonical origin %s', origin => {
      expect(code(() => workplaceProfile({ ...input, origin }, { now }))).toBe('profile_invalid');
    });
  it.each(['operator', 'root', 'a', 'Bad Code', 'x'.repeat(65), ''])('refuses the organization code %j', organization => {
    expect(code(() => workplaceProfile({ ...input, organization }, { now }))).toBe('profile_invalid');
  });
  it('refuses a display name the app would refuse, and validates hosting', () => {
    expect(code(() => workplaceProfile({ ...input, name: 'two\nlines' }, { now }))).toBe('profile_invalid');
    expect(code(() => workplaceProfile({ ...input, name: '   ' }, { now }))).toBe('profile_invalid');
    expect(setupHosting(undefined)).toBe('cloud');
    expect(setupHosting(' on-premise ')).toBe('on-premise');
    expect(code(() => setupHosting('hybrid'))).toBe('hosting_invalid');
  });
});

describe('signing key custody', () => {
  it('loads an owner-only Ed25519 key outside the application directory and matches it to its anchor', () => {
    expect(approvedAnchor(loadSigningKey(keyPath, app), trust)).toEqual(trust[0]);
  });
  it('refuses a key whose public half is not an installed app trust anchor', () => {
    const foreign = generateKeyPairSync('ed25519').privateKey;
    expect(code(() => approvedAnchor(foreign, trust))).toBe('key_untrusted');
    expect(code(() => signed(undefined, foreign))).toBe('key_untrusted');
  });
  it('refuses missing, relative, in-tree (including via a symlink), loose, non-Ed25519 and non-file keys', () => {
    const inside = join(app, 'inside.pem');
    writeFileSync(inside, pem, { mode: 0o600 });
    const link = join(root, 'link.pem');
    symlinkSync(inside, link);
    const loose = join(root, 'loose.pem');
    writeFileSync(loose, pem);
    chmodSync(loose, 0o640);
    const rsa = join(root, 'rsa.pem');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const cases: [string | undefined, string][] = [
      [undefined, 'key_not_configured'], ['  ', 'key_not_configured'], ['relative/key.pem', 'key_path_invalid'],
      [join(root, 'missing.pem'), 'key_unreadable'], [inside, 'key_path_invalid'], [link, 'key_path_invalid'],
      [loose, 'key_permissions'], [rsa, 'key_type'], [root, 'key_unreadable'],
    ];
    for (const [path, expected] of cases) expect(code(() => loadSigningKey(path, app)), String(path)).toBe(expected);
  });
  it('never puts the key path, key or payload in an error message', () => {
    for (const path of [join(app, 'inside.pem'), join(root, 'loose.pem'), join(root, 'missing.pem')]) {
      try { loadSigningKey(path, app); } catch (error) {
        expect((error as Error).message).toMatch(/^mobile-setup:[a-z_]+$/);
      }
    }
  });
});

describe('server-side re-verification (also the import acceptance rules)', () => {
  const good = () => signed();
  const expected = { trust, origin: ORIGIN, organization: 'acme-co', now };
  it('accepts a current setup for this server and organization, and flags the renewal window', () => {
    expect(code(() => verifyWorkplaceSetup(JSON.stringify(good()), expected))).toBe('accepted');
    expect(verifyWorkplaceSetup(good(), expected).expiresSoon).toBe(false);
    expect(verifyWorkplaceSetup(good(), { ...expected, now: now + SETUP_LIFETIME_SECONDS - SETUP_RENEWAL_WINDOW_SECONDS + 60 }).expiresSoon).toBe(true);
  });
  it.each([
    ['another server', () => verifyWorkplaceSetup(good(), { ...expected, origin: 'https://other.example.test' }), 'origin_mismatch'],
    ['another organization', () => verifyWorkplaceSetup(good(), { ...expected, organization: 'beta' }), 'organization_mismatch'],
    ['an unknown key id', () => verifySignedSetup(good(), [{ ...trust[0], keyId: 'other' }], now), 'untrusted_key'],
    ['a foreign key under a trusted key id', () => verifySignedSetup(signCompanyProfile(workplaceProfile(input, { now }), impostor.privateKey,
      [{ keyId: 'test-anchor', publicKey: impostor.publicKey.export({ format: 'jwk' }).x! }], now), trust, now), 'bad_signature'],
    ['a changed payload under the original signature', () => verifySignedSetup({ ...good(), payload: Buffer.from(JSON.stringify({ ...workplaceProfile(input, { now }), organization: 'beta' })).toString('base64url') }, trust, now), 'bad_signature'],
    ['an expired setup', () => verifyWorkplaceSetup(good(), { ...expected, now: now + SETUP_LIFETIME_SECONDS + 1 }), 'expired'],
    ['a setup not valid yet', () => verifyWorkplaceSetup(good(), { ...expected, now: now - 3600 }), 'not_yet_valid'],
    ['an extra envelope field', () => verifySignedSetup({ ...good(), publicKey: trust[0].publicKey }, trust, now), 'malformed'],
    ['invalid JSON', () => verifySignedSetup('{', trust, now), 'malformed'],
    ['an oversized file', () => verifySignedSetup(' '.repeat(16_385), trust, now), 'malformed'],
  ] as const)('refuses %s', (_label, run, expectedCode) => {
    expect(code(run)).toBe(expectedCode);
  });
  it('refuses a correctly signed setup without an organization (legacy) or for another sign-in provider', () => {
    const { organization: _organization, ...legacy } = workplaceProfile(input, { now });
    expect(code(() => verifySignedSetup(signCompanyProfile(legacy, pair.privateKey, trust, now), trust, now))).toBe('not_workplace');
    const keycloak = { ...legacy, authProvider: 'keycloak' as const, issuer: 'https://login.example.test/realms/acme', clientId: 'mobile', audience: 'api' };
    expect(code(() => verifySignedSetup(signCompanyProfile(keycloak, pair.privateKey, trust, now), trust, now))).toBe('not_workplace');
  });
  it('reads a stored value defensively, never failing open on an unknown shape', () => {
    const envelope = good();
    expect(parseStoredSetup({ version: 1, setup: envelope, method: 'issued', recordedAt: new Date(now * 1000).toISOString(), failure: null }))
      .toEqual({ version: 1, setup: envelope, method: 'issued', recordedAt: new Date(now * 1000).toISOString(), failure: null });
    for (const value of [null, {}, [], 'x', { version: 2, setup: envelope }, { version: 1, setup: { ...envelope, extra: 1 }, method: 'issued' }])
      expect(parseStoredSetup(value).setup, JSON.stringify(value)).toBeNull();
    expect(parseStoredSetup({ version: 1, setup: null, failure: { reason: 'Not A Code', at: 'yesterday' } }).failure).toBeNull();
  });
});

describe('custody boundaries in the source tree', () => {
  const repo = resolve(__dirname, '..');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', '.next', 'android', 'ios'].includes(entry.name) ? [] : walk(path);
    return /\.(tsx?|mts|js)$/.test(entry.name) ? [path] : [];
  });
  const valueImport = (source: string, module: string) =>
    new RegExp(`import\\s+(?!type\\b)[^;]*?from\\s+['"][^'"]*${module}['"]|import\\(\\s*['"][^'"]*${module}['"]`).test(source);
  it('only the CLI and the owner-role issuance module load the signer; no web, kernel or mobile file does', () => {
    const files = ['app', 'components', 'core', 'lib', 'mobile', 'packs', 'scripts'].flatMap(dir => walk(join(repo, dir)));
    expect(files.length).toBeGreaterThan(500);
    const loaders = files.filter(file => valueImport(readFileSync(file, 'utf8'), 'mobile-workplace-setup-signer'))
      .map(file => file.slice(repo.length + 1)).sort();
    expect(loaders).toEqual(['scripts/mobile-company-profile.ts', 'scripts/mobile-setup-issuance.ts']);
  });
  it('keeps the server-only signer, verifier and stored-value modules out of the EAS mobile archive', () => {
    const rules = readFileSync(join(repo, '.easignore'), 'utf8').split('\n').map(line => line.trim());
    expect(rules).toContain('/lib/*');
    expect(rules).toContain('!/lib/mobile-workplace-setup.ts');
    for (const name of ['mobile-workplace-setup-signer', 'mobile-workplace-setup-verify', 'mobile-workplace-setup-record', 'mobile-trust-anchors'])
      expect(rules.some(rule => rule.startsWith('!') && rule.includes(name)), name).toBe(false);
  });
  it('judges with the same anchors file the app embeds', () => {
    const anchors = JSON.parse(readFileSync(join(repo, 'mobile/connections/trust.json'), 'utf8'));
    expect(INSTALLED_APP_TRUST).toEqual(anchors);
    expect(INSTALLED_APP_TRUST.length).toBeGreaterThan(0);
    expect(Object.isFrozen(INSTALLED_APP_TRUST)).toBe(true);
    expect(statSync(join(repo, 'mobile/connections/trust.json')).size).toBeLessThan(16_384);
  });
});
