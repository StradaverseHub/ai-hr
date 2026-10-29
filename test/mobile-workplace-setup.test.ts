import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { validCompanyProfile, type CompanyProfile } from '../lib/mobile-connection';
import { isWorkplaceSetupLink, readWorkplaceSetupLink, setupBytes, workplaceSetupLinks, WORKPLACE_SETUP_PATH } from '../lib/mobile-workplace-setup';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { applyCompanyConnection, identityNamespace } from '../mobile/lib/config';

const pair = generateKeyPairSync('ed25519');
const trust = [{ keyId: 'operator', publicKey: pair.publicKey.export({ format: 'jwk' }).x! }];
const now = Math.floor(Date.now() / 1000);
const base: CompanyProfile = { connectionVersion: 1, apiVersion: 'v1', authProvider: 'internal', apiOrigin: 'https://hr.example.test',
  issuer: 'https://hr.example.test/auth', clientId: 'aihr-mobile', audience: 'aihr-api', id: 'shared-cloud', name: 'Acme 人事',
  hosting: 'cloud', organization: 'acme', notBefore: now - 60, expiresAt: now + 86400 };
function signed(profile: unknown = base) {
  const bytes = Buffer.from(JSON.stringify(profile));
  return JSON.stringify({ keyId: 'operator', payload: bytes.toString('base64url'), signature: sign(null, bytes, pair.privateKey).toString('base64url') });
}
afterEach(() => { applyCompanyConnection(null); vi.unstubAllGlobals(); });

describe('signed workplace setup routing', () => {
  it('round-trips and verifies on a native runtime without browser base64 globals',()=>{
    vi.stubGlobal('atob',undefined);vi.stubGlobal('btoa',undefined);
    const raw=signed(),link=workplaceSetupLinks(raw).app;
    expect(verifyCompanyProfile(readWorkplaceSetupLink(link),trust)).toMatchObject(base);
    for(const bytes of [Buffer.from([0]),Buffer.from([0,255]),Buffer.from(Array.from({length:256},(_,i)=>i))])
      expect(Buffer.from(setupBytes(bytes.toString('base64url')))).toEqual(bytes);
    for(const invalid of ['A','AB','AA=','AA+','AA/'])expect(()=>setupBytes(invalid)).toThrow();
  });
  it.each(['cloud', 'on-premise'] as const)('round-trips server and organization for %s without a directory lookup', hosting => {
    const raw = signed({ ...base, hosting }), links = workplaceSetupLinks(raw);
    expect(links.web).toContain(base.apiOrigin + WORKPLACE_SETUP_PATH + '#setup=');
    expect(new URL(links.web).search).toBe('');
    for (const link of [links.web, links.app]) {
      expect(isWorkplaceSetupLink(link)).toBe(true);
      expect(verifyCompanyProfile(readWorkplaceSetupLink(link), trust)).toMatchObject({ apiOrigin: base.apiOrigin, organization: 'acme', name: 'Acme 人事', hosting });
    }
  });
  it('includes the organization in the signature; changing it invalidates the setup', () => {
    const envelope = JSON.parse(signed());
    envelope.payload = Buffer.from(JSON.stringify({ ...base, organization: 'another-tenant' })).toString('base64url');
    const link = workplaceSetupLinks(JSON.stringify(envelope)).app;
    expect(() => verifyCompanyProfile(readWorkplaceSetupLink(link), trust)).toThrow(/signature/);
  });
  it('keeps two cloud tenants on the same server in separate credential namespaces', () => {
    const first = verifyCompanyProfile(signed(), trust), second = verifyCompanyProfile(signed({ ...base, organization: 'beta' }), trust);
    applyCompanyConnection(first); const a = identityNamespace();
    applyCompanyConnection(second); expect(identityNamespace()).not.toBe(a);
    expect(JSON.parse(a)).toContain('acme'); expect(JSON.parse(identityNamespace())).toContain('beta');
  });
  it('keeps existing signed files and their credential namespaces compatible', () => {
    const { organization: _organization, ...legacy } = base;
    const profile = verifyCompanyProfile(signed(legacy), trust); applyCompanyConnection(profile);
    expect(identityNamespace()).toBe(JSON.stringify(['internal', base.apiOrigin, base.issuer, base.clientId, base.id, base.audience]));
    expect(() => workplaceSetupLinks(signed(legacy))).toThrow(/organization/);
  });
  it.each(['', 'A-CME', 'acme/other', ' acme', 'a', 'x'.repeat(65)])('rejects a malformed signed organization %j', organization => {
    expect(() => verifyCompanyProfile(signed({ ...base, organization }), trust)).toThrow();
  });
  it('rejects tenant IDs, credentials and unsigned URL overrides', () => {
    for (const extra of [{ tenantId: 'another-tenant' }, { password: 'should-never-be-here' }, { organization: undefined }])
      expect(() => workplaceSetupLinks(signed({ ...base, ...extra }))).toThrow();
    const links = workplaceSetupLinks(signed());
    for (const link of [links.web.replace('https:', 'http:'), links.web.replace('hr.example.test', 'attacker.test'),
      links.web.replace('#setup=', '?organization=beta#setup='), links.app.replace('company#', 'company/other#'),
      links.app + '&organization=beta', links.app.replace('aihr:', 'javascript:'), links.app.replace('company', 'name:password@company')])
      expect(() => readWorkplaceSetupLink(link)).toThrow();
  });
  it('bounds and rejects malformed, duplicate, expired and unsupported setup links', () => {
    const link = workplaceSetupLinks(signed()).web;
    for (const value of [link + '&setup=again', link + '=', 'aihr://company#setup=' + 'x'.repeat(24001), 'aihr://company',
      'https://hr.example.test/not-setup#setup=abc']) expect(() => readWorkplaceSetupLink(value)).toThrow();
    expect(() => workplaceSetupLinks(signed({ ...base, expiresAt: now - 1 }))).toThrow();
    expect(() => validCompanyProfile({ ...base, authProvider: 'keycloak', issuer: base.apiOrigin + '/realms/x' })).toThrow();
    expect(isWorkplaceSetupLink('aihr://auth/callback?code=legacy')).toBe(false);
  });
});

/**
 * The phone does not have WHATWG URL. React Native installs Libraries/Blob/URL.js, a regex polyfill that knows only
 * http(s) hosts: for `aihr://company#setup=…` it reports hostname '' and pathname '/'. Load the INSTALLED polyfill
 * (Flow stripped by the app's own Babel) and run the shipped parser and verifier under it.
 */
function reactNativeUrl(): typeof URL {
  const mobile = createRequire(new URL('../mobile/package.json', import.meta.url));
  const babel = mobile('@babel/core') as typeof import('@babel/core');
  const file = mobile.resolve('react-native/Libraries/Blob/URL.js');
  const code = babel.transformSync(readFileSync(file, 'utf8'), { babelrc: false, configFile: false, filename: file,
    plugins: [mobile.resolve('@babel/plugin-transform-flow-strip-types'), mobile.resolve('@babel/plugin-transform-modules-commonjs')] })!.code!;
  const module = { exports: {} as { URL: typeof URL } };
  new Function('exports', 'module', 'require', code)(module.exports, module, (id: string) => {
    if (id === './NativeBlobModule') return { __esModule: true, default: null };
    if (id === './URLSearchParams') return { URLSearchParams };
    throw new Error('Unexpected polyfill dependency ' + id);
  });
  return module.exports.URL;
}

describe('workplace setup links on the React Native runtime', () => {
  const RNURL = reactNativeUrl();
  it('is the polyfill that cannot read an app link (the premise of the fix)', () => {
    const native = new RNURL('aihr://company#setup=abc');
    expect([native.protocol, native.hostname, native.pathname]).toEqual(['aihr:', '', '/']);
  });
  it('accepts and verifies both setup links, and still refuses the malformed ones', () => {
    const links = workplaceSetupLinks(signed());
    vi.stubGlobal('URL', RNURL);
    for (const link of [links.app, links.web]) {
      expect(isWorkplaceSetupLink(link)).toBe(true);
      expect(verifyCompanyProfile(readWorkplaceSetupLink(link), trust)).toMatchObject({ apiOrigin: base.apiOrigin, organization: 'acme' });
    }
    for (const link of [links.web.replace('https:', 'http:'), links.web.replace('hr.example.test', 'attacker.test'),
      links.web.replace('#setup=', '?organization=beta#setup='), links.web.replace('https://', 'https://user@'),
      links.app.replace('company#', 'company/other#'), links.app.replace('company#', 'company:8080#'), links.app.replace('company#', 'company?x=1#'),
      links.app + '&organization=beta', links.app + '#setup=again', links.app.replace('aihr:', 'javascript:'),
      links.app.replace('company', 'name:password@company'), links.app.replace('aihr://', 'AIHR://'), 'aihr://company', 'aihr://company#setup=']) {
      expect(() => readWorkplaceSetupLink(link)).toThrow();
    }
    // A malformed setup link is still recognised as one, so the app shows a refusal instead of ignoring it.
    expect(isWorkplaceSetupLink(links.app.replace('company', 'name:password@company'))).toBe(true);
    expect(isWorkplaceSetupLink('aihr://auth/callback?code=legacy')).toBe(false);
  });
});
