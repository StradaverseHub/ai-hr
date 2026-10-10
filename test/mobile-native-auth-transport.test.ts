import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthState } from '../mobile/lib/auth-state';
import { createInstallationStore } from '../mobile/lib/installation-store';
import { providerLogoutUrl, sessionIdFromToken } from '../mobile/lib/provider-logout';
import { SessionChangedError, SignInRequiredError, UnavailableError } from '../mobile/lib/errors';

function token(sid: string) {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, sid })).toString('base64url')}.signature`;
}
function fixture(keycloak = false) {
  const namespace = keycloak ? 'keycloak-profile' : 'workos-profile';
  let stored: string | null = JSON.stringify({ refreshToken: 'stored-refresh', sessionId: 'stored-session', namespace });
  const files = new Map([['aihr-installation-v1', '1']]);
  class File {
    constructor(_directory: unknown, private name: string) {}
    get exists() { return files.has(this.name); }
    textSync() { return files.get(this.name); }
    write(value: string) { files.set(this.name, value); }
  }
  const deviceValues = new Map<string, string>();
  const secure = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5, getItemAsync: vi.fn(async (key: string) => key === 'aihr.refreshToken' ? stored : deviceValues.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { if (key === 'aihr.refreshToken') stored = value; else deviceValues.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { if (key === 'aihr.refreshToken') stored = null; else deviceValues.delete(key); }) };
  const response = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
    access_token: token('new-session'), refresh_token: 'rotated-refresh',
  })));
  const output = { exports: {} as { refresh: () => Promise<string>; hasStoredSession: () => Promise<boolean>;
    beginSignIn: () => number; completeSignIn: (code: string, verifier: string, owner: number) => Promise<void>;
    signOut: () => Promise<void>; workosLogoutUrl: () => string | null } };
  const deviceModule = { exports: {} };
  runInNewContext(transpileModule(readFileSync('mobile/lib/device-registration.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    { exports: deviceModule.exports, module: deviceModule, require: (id: string) => { if (id === 'expo-secure-store') return secure; throw new Error(id); } });
  const code = transpileModule(readFileSync('mobile/lib/auth.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, fetch: response, AbortController, URLSearchParams, atob, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'expo-auth-session') return { makeRedirectUri: () => 'aihr://auth/callback' };
      if (id === 'expo-secure-store') return secure;
      if (id === 'expo-file-system') return { File, Paths: { document: 'sandbox' } };
      if (id === './device-registration') return deviceModule.exports;
      if (id === './auth-state') return { createAuthState };
      if (id === './installation-store') return { createInstallationStore };
      if (id === './provider-logout') return { providerLogoutUrl, sessionIdFromToken };
      if (id === './config') return { config: { authProvider: keycloak ? 'keycloak' : 'workos', issuer: 'https://identity.test/realms/test', workosClientId: 'public-client-id', scheme: 'aihr' }, configProblem: () => null, identityClientId: () => 'public-client-id', identityNamespace: () => namespace };
      if (id === './errors') return { SignInRequiredError, UnavailableError };
      throw new Error(`Unexpected auth adapter dependency: ${id}`);
    } });
  return { auth: output.exports, response, secure, files, stored: () => stored };
}
afterEach(() => vi.useRealTimers());

describe('native WorkOS exchange — shipped adapter', () => {
  it.each([429, 500, 503])('HTTP %s is an outage and preserves the stored credential', async (status) => {
    const f = fixture(); const original = f.stored();
    f.response.mockResolvedValueOnce(new Response('', { status }));
    await expect(f.auth.refresh()).rejects.toBeInstanceOf(UnavailableError);
    expect(f.stored()).toBe(original); expect(f.secure.deleteItemAsync).not.toHaveBeenCalled();
  });
  it('rejects malformed credential types without storing them', async () => {
    const f = fixture(); const original = f.stored();
    f.response.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 42, refresh_token: {} })));
    await expect(f.auth.refresh()).rejects.toBeInstanceOf(UnavailableError);
    expect(f.stored()).toBe(original); expect(f.secure.setItemAsync).not.toHaveBeenCalled();
  });
  it('rotation stores both refresh credential and provider session id, never the access token', async () => {
    const f = fixture(); const access = await f.auth.refresh();
    expect(JSON.parse(f.stored()!)).toEqual({ refreshToken: 'rotated-refresh', sessionId: 'new-session', namespace: 'workos-profile', idToken: null });
    expect(f.stored()).not.toContain(access);
    expect(f.auth.workosLogoutUrl()).toContain('session_id=new-session');
    expect(f.secure.setItemAsync).toHaveBeenCalledWith('aihr.refreshToken', expect.any(String), { keychainAccessible: 5 });
    const body = JSON.parse(String(f.response.mock.calls[0][1]?.body));
    expect(body).toEqual({ client_id: 'public-client-id', grant_type: 'refresh_token', refresh_token: 'stored-refresh' });
    expect(body).not.toHaveProperty('client_secret');
  });
  it('restores the logout session id on cold launch without requiring a network refresh', async () => {
    const f = fixture(); await f.auth.hasStoredSession();
    expect(f.auth.workosLogoutUrl()).toContain('session_id=stored-session');
    expect(f.response).not.toHaveBeenCalled();
  });
  it('a stale secure read cannot overwrite a newer account logout id', async () => {
    const f = fixture(); let release!: (value: string) => void;
    const oldValue = f.stored()!;
    f.secure.getItemAsync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = f.auth.hasStoredSession().catch((error: unknown) => error);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await f.auth.completeSignIn('code', 'verifier', f.auth.beginSignIn());
    release(oldValue);
    expect(await old).toBeInstanceOf(SessionChangedError);
    expect(f.auth.workosLogoutUrl()).toContain('session_id=new-session');
  });
  it('explicit and revoked-session logout persist a tombstone even when Keychain deletion fails', async () => {
    for (const explicit of [true, false]) {
      const f = fixture(); f.secure.deleteItemAsync.mockRejectedValueOnce(new Error('Keychain unavailable'));
      if (explicit) await expect(f.auth.signOut()).rejects.toThrow('Keychain unavailable');
      else {
        f.response.mockResolvedValueOnce(new Response('', { status: 401 }));
        await expect(f.auth.refresh()).rejects.toBeInstanceOf(SignInRequiredError);
      }
      expect(f.files.get('aihr-installation-v1')).toBe('signed-out');
      expect(await f.auth.hasStoredSession()).toBe(false);
    }
  });
  it('a stalled WorkOS request times out while preserving credentials', async () => {
    vi.useFakeTimers(); const f = fixture(); const original = f.stored();
    f.response.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = f.auth.refresh().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toBeInstanceOf(UnavailableError);
    expect(f.stored()).toBe(original);
  });
});

describe('native Keycloak exchange — shipped adapter', () => {
  it('uses form encoding, PKCE redirect and a public client with no secret', async () => {
    const f = fixture(true);
    await f.auth.completeSignIn('code', 'verifier', f.auth.beginSignIn());
    const [url, init] = f.response.mock.calls[0];
    expect(url).toBe('https://identity.test/realms/test/protocol/openid-connect/token');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({ client_id: 'public-client-id', grant_type: 'authorization_code', code: 'code', code_verifier: 'verifier', redirect_uri: 'aihr://auth/callback' });
    expect(JSON.parse(f.stored()!).namespace).toBe('keycloak-profile');
    expect(body.has('client_secret')).toBe(false);
  });
  it('rejects a cold-launch credential from another deployment before any token exchange', async () => {
    const f = fixture(true);
    f.secure.getItemAsync.mockResolvedValueOnce(JSON.stringify({ refreshToken: 'foreign', namespace: 'other-profile' }));
    expect(await f.auth.hasStoredSession()).toBe(false);
    expect(f.response).not.toHaveBeenCalled();
  });
});
