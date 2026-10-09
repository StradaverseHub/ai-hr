import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionState } from '../mobile/lib/session-state';

function deviceFixture(level: number) {
  const local = { getEnrolledLevelAsync: vi.fn(async () => level), SecurityLevel: { SECRET: 1 },
    hasHardwareAsync: vi.fn(async () => false), isEnrolledAsync: vi.fn(async () => false),
    authenticateAsync: vi.fn(async () => ({ success: true })) };
  const capture = { preventScreenCaptureAsync: vi.fn(async () => undefined), enableAppSwitcherProtectionAsync: vi.fn(async () => undefined) };
  const clearTokens = vi.fn(async () => undefined);
  const output = { exports: {} as { SessionProvider: React.ComponentType<React.PropsWithChildren>;
    useSession: () => { status: string; visible: boolean } } };
  const code = transpileModule(readFileSync('mobile/lib/session.tsx', 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, require: (id: string) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === 'expo-local-authentication') return local;
    if (id === 'expo-screen-capture') return capture;
    if (id === 'expo-web-browser') return { openBrowserAsync: vi.fn() };
    if (id === 'react-native') return { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
    if (id === './session-state') return { createSessionState };
    if (id === './i18n') return { t: (key: string) => key };
    if (id === './auth') return { hasStoredSession: async () => true, signOut: clearTokens, assertAuthGeneration() {}, workosLogoutUrl: () => null };
    throw new Error(`Unexpected device gate dependency: ${id}`);
  } });
  function Probe() {
    const session = output.exports.useSession();
    return <div>{session.status === 'signedIn' && session.visible ? 'Private screen' : session.status}</div>;
  }
  return { local, capture, clearTokens, View: () => <output.exports.SessionProvider><Probe /></output.exports.SessionProvider> };
}
afterEach(cleanup);

describe('native provider wiring — passcode and privacy', () => {
  it('a passcode-only device must authenticate even with no biometric hardware or enrollment', async () => {
    const f = deviceFixture(1); render(<f.View />);
    expect(await screen.findByText('Private screen')).toBeInTheDocument();
    expect(f.local.getEnrolledLevelAsync).toHaveBeenCalledTimes(1);
    expect(f.local.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
    expect(f.local.hasHardwareAsync).not.toHaveBeenCalled();
    expect(f.capture.preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
    expect(f.capture.enableAppSwitcherProtectionAsync).toHaveBeenCalledWith(1);
    expect(f.capture.enableAppSwitcherProtectionAsync.mock.invocationCallOrder[0]).toBeLessThan(f.local.authenticateAsync.mock.invocationCallOrder[0]);
  });
  it('no enrolled OS credential removes the stored session instead of showing private data', async () => {
    const f = deviceFixture(0); render(<f.View />);
    expect(await screen.findByText('signedOut')).toBeInTheDocument();
    expect(f.clearTokens).toHaveBeenCalledTimes(1);
    expect(f.local.authenticateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText('Private screen')).not.toBeInTheDocument();
  });
  it('a native privacy-protection failure keeps private screens closed', async () => {
    const f = deviceFixture(1); f.capture.preventScreenCaptureAsync.mockRejectedValueOnce(new Error('native module unavailable'));
    render(<f.View />);
    await waitFor(() => expect(screen.getByText('locked')).toBeInTheDocument());
    expect(f.local.authenticateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText('Private screen')).not.toBeInTheDocument();
  });
});
