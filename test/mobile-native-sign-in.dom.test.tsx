import { createHash, randomFillSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeRequire = createRequire(resolve('mobile/package.json'));
function load(file: string, ports: Record<string, unknown>) {
  const output = { exports: {} as Record<string, any> };
  const code = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  runInNewContext(code, { module: output, exports: output.exports, URL, URLSearchParams, Uint8Array, console, __DEV__: false,
    require(id: string) {
      if (id in ports) return ports[id];
      throw new Error('Unexpected sign-in dependency: ' + id);
    } });
  return output.exports;
}

type BrowserResult = { type: 'cancel' | 'success'; url?: string };
function fixture() {
  const queued: Array<(url: string) => BrowserResult | Promise<BrowserResult>> = [];
  const browser = { maybeCompleteAuthSession: vi.fn(),
    openAuthSessionAsync: vi.fn(async (url: string) => {
      const next = queued.shift(); if (!next) throw new Error('Unexpected browser request');
      return next(url);
    }) };
  const crypto = { getRandomValues: (value: Uint8Array) => randomFillSync(value), randomUUID,
    CryptoDigestAlgorithm: { SHA256: 'sha256' }, CryptoEncoding: { BASE64: 'base64', HEX: 'hex' },
    digestStringAsync: async (_algorithm: string, value: string, options: { encoding: 'base64' | 'hex' }) =>
      createHash('sha256').update(value).digest(options.encoding) };
  const invariant = nativeRequire('invariant');
  const sdk = 'mobile/node_modules/expo-auth-session/src/';
  class CodedError extends Error { constructor(public code: string, message: string) { super(message); } }
  const types = load(sdk + 'AuthRequest.types.ts', {});
  const pkce = load(sdk + 'PKCE.ts', { 'expo-crypto': crypto, invariant });
  const query = load(sdk + 'QueryParams.ts', {});
  const errors = load(sdk + 'Errors.ts', { 'expo-modules-core': { CodedError } });
  const requests = load(sdk + 'AuthRequest.ts', {
    'expo-web-browser': browser, invariant, 'react-native': { Platform: { select: (options: any) => options.default } },
    './AuthRequest.types': types, './Errors': errors, './PKCE': pkce, './QueryParams': query,
    './TokenRequest': { TokenResponse: { fromQueryParams() { throw new Error('An implicit token must never be returned.'); } } },
  });
  // Load the installed hook too: the former screen must reproduce its actual request-reuse behavior.
  const hooks = load(sdk + 'AuthRequestHooks.ts', { react: React, './AuthRequest': requests,
    './Discovery': { resolveDiscoveryAsync: async (value: unknown) => value } });
  let owner = 0;
  const auth = { beginSignIn: vi.fn(() => ++owner), completeSignIn: vi.fn(async () => {}),
    redirectUri: () => 'aihr://auth/callback', discovery: { authorizationEndpoint: 'https://api.workos.com/user_management/authorize' } };
  const session = { status: 'signedOut', error: false, markSignedIn: vi.fn(async () => {}) };
  const router = { replace: vi.fn() };
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const view = load('mobile/app/sign-in.tsx', {
    'expo-auth-session': { ...types, ...requests, ...hooks }, 'expo-crypto': crypto, 'expo-web-browser': browser,
    'expo-router': { router, Redirect: () => null }, react: React, 'react/jsx-runtime': jsx,
    'react-native': { View: Container, Text: Container, StyleSheet: { create: (value: unknown) => value } },
    '../lib/auth': auth, '../lib/config': { config: { workosClientId: 'public-client' }, configProblem: () => null, identityClientId: () => 'public-client' },
    '../lib/i18n': { t: (key: string) => key }, '../lib/session': { useSession: () => session },
    '../lib/ui': { colors: {}, Button: ({ title, disabled, onPress }: any) => <button disabled={disabled} onClick={onPress}>{title}</button> },
  });
  return { View: view.default as React.ComponentType, queued, browser, auth, session, router };
}
afterEach(cleanup);

async function readyButton() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'signInButton' })).toBeEnabled());
  return screen.getByRole('button', { name: 'signInButton' });
}
describe('native sign-in — actual installed AuthRequest, PKCE and return-state parser', () => {
  it('uses fresh state and PKCE per attempt and never exchanges a cancelled attempt’s callback on retry', async () => {
    const f = fixture(); const user = userEvent.setup(); render(<f.View />);
    f.queued.push(() => ({ type: 'cancel' }));
    await user.click(await readyButton()); await readyButton();
    const first = new URL(f.browser.openAuthSessionAsync.mock.calls[0][0]);
    f.queued.push(() => ({ type: 'success', url: 'aihr://auth/callback?code=old-code&state=' + first.searchParams.get('state') }));
    await user.click(await readyButton());
    await readyButton();
    expect(f.auth.completeSignIn).not.toHaveBeenCalled();
    expect(await screen.findByText('signInFailed')).toBeInTheDocument();
    const second = new URL(f.browser.openAuthSessionAsync.mock.calls[1][0]);
    expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
    expect(second.searchParams.get('code_challenge')).not.toBe(first.searchParams.get('code_challenge'));
    f.queued.push((url) => ({ type: 'success', url: 'aihr://auth/callback?code=current-code&state=' + new URL(url).searchParams.get('state') }));
    await user.click(await readyButton());
    await waitFor(() => expect(f.auth.completeSignIn).toHaveBeenCalledTimes(1));
    const [code, verifier, attempt] = f.auth.completeSignIn.mock.calls[0] as unknown as [string, string, number];
    expect(code).toBe('current-code'); expect(attempt).toBe(3);
    expect(verifier).toHaveLength(128);
    const third = new URL(f.browser.openAuthSessionAsync.mock.calls[2][0]);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(third.searchParams.get('code_challenge'));
    expect(third.searchParams.has('client_secret')).toBe(false);
    await waitFor(() => expect(f.router.replace).toHaveBeenCalledWith('/'));
    expect(f.session.markSignedIn).toHaveBeenCalledWith(3);
  });

  it('a second tap cannot start another generation or browser while the first attempt is pending', async () => {
    const f = fixture(); const user = userEvent.setup(); let release!: (result: BrowserResult) => void;
    f.queued.push(() => new Promise((resolve) => { release = resolve; }));
    render(<f.View />); await user.click(await readyButton());
    await waitFor(() => expect(f.browser.openAuthSessionAsync).toHaveBeenCalledTimes(1));
    await user.dblClick(screen.getByRole('button', { name: 'signingIn' }));
    expect(f.auth.beginSignIn).toHaveBeenCalledTimes(1);
    expect(f.browser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
    release({ type: 'cancel' }); await readyButton();
    expect(f.auth.completeSignIn).not.toHaveBeenCalled();
  });
});
