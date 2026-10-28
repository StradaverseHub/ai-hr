/** Protected-document custody (mobile/lib/protected-document.ts) and its lifecycle sweeps (mobile/lib/session.tsx). */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionState } from '../mobile/lib/session-state';

function load(path: string, require: (id: string) => unknown) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, require });
  return module.exports;
}
function storage() {
  const files = new Map<string, Uint8Array>(), dirs = new Set<string>();
  const failures = { write: false, delete: false };
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = join(parts); }
    get exists() { return dirs.has(this.uri); }
    create() { dirs.add(this.uri); }
    delete() { if (failures.delete) throw new Error('busy'); dirs.delete(this.uri); for (const k of [...files.keys()]) if (k.startsWith(this.uri + '/')) files.delete(k); }
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = join(parts); }
    get exists() { return files.has(this.uri); }
    write(bytes: Uint8Array) { files.set(this.uri, failures.write ? bytes.slice(0, 1) : bytes); if (failures.write) throw new Error('disk full'); }
    delete() { if (failures.delete) throw new Error('busy'); files.delete(this.uri); }
  }
  let n = 0;
  const documents = load('mobile/lib/protected-document.ts', (id) => {
    if (id === 'expo-file-system') return { Directory, File, Paths: { cache: 'cache' } };
    if (id === 'expo-crypto') return { randomUUID: () => `0000000${++n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` };
    throw new Error('Unexpected protected-document dependency ' + id);
  });
  return { documents, files, dirs, failures };
}
const pdf = new TextEncoder().encode('%PDF-1.7 synthetic');
afterEach(cleanup);

describe('protected document custody', () => {
  it('writes each document under a fresh random name in its own cache folder, and deletes it once', () => {
    const f = storage();
    const a = f.documents.writeProtectedDocument(pdf, 'application/pdf'), b = f.documents.writeProtectedDocument(pdf, 'application/pdf');
    expect(a.uri).toMatch(/^cache\/aihr-protected\/[0-9a-f-]{36}\.pdf$/);
    expect(b.uri).not.toBe(a.uri);
    expect(a).toMatchObject({ mimeType: 'application/pdf', size: pdf.byteLength });
    expect(f.files.get(a.uri)).toEqual(pdf);
    a.delete(); a.delete();
    expect(f.files.has(a.uri)).toBe(false);
    expect(f.files.has(b.uri)).toBe(true);
  });

  it('leaves no partial file behind when the write fails, and refuses an unknown type', () => {
    const f = storage();
    f.failures.write = true;
    expect(() => f.documents.writeProtectedDocument(pdf, 'application/pdf')).toThrow('disk full');
    expect(f.files.size).toBe(0);
    expect(() => f.documents.writeProtectedDocument(pdf, 'text/html')).toThrow();
  });

  it('sweeps every leftover and never throws, with or without a folder', () => {
    const f = storage();
    f.documents.sweepProtectedDocuments();
    f.documents.writeProtectedDocument(pdf, 'application/pdf'); f.documents.writeProtectedDocument(pdf, 'application/pdf');
    f.failures.delete = true;
    expect(() => f.documents.sweepProtectedDocuments()).not.toThrow();
    expect(f.files.size).toBe(2);
    f.failures.delete = false;
    f.documents.sweepProtectedDocuments();
    expect(f.files.size).toBe(0);
    expect(f.dirs.has('cache/aihr-protected')).toBe(false);
  });
});

describe('session lifecycle sweeps', () => {
  function sessionFixture() {
    const sweep = vi.fn(), clearTokens = vi.fn(async () => undefined), listeners: Record<string, (value: string) => void> = {};
    const exports = load('mobile/lib/session.tsx', (id) => {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return jsx;
      if (id === 'expo-local-authentication') return { getEnrolledLevelAsync: async () => 1, SecurityLevel: { SECRET: 1 }, authenticateAsync: async () => ({ success: true }) };
      if (id === 'expo-screen-capture') return { preventScreenCaptureAsync: async () => undefined, enableAppSwitcherProtectionAsync: async () => undefined };
      if (id === 'expo-web-browser') return { openAuthSessionAsync: vi.fn() };
      if (id === 'react-native') return { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: (type: string, fn: (value: string) => void) => { listeners[type] = fn; return { remove() {} }; } } };
      if (id === './session-state') return { createSessionState };
      if (id === './i18n') return { t: (key: string) => key };
      if (id === './auth') return { hasStoredSession: async () => true, signOut: clearTokens, assertAuthGeneration() {}, workosLogoutUrl: () => null, redirectUri: () => 'aihr://auth/callback' };
      if (id === './protected-document') return { sweepProtectedDocuments: sweep };
      throw new Error('Unexpected session dependency ' + id);
    });
    const probe: { current?: { status: string; employmentId: string | null; setEmploymentId: (id: string | null) => void; signOut: () => Promise<void> } } = {};
    function Probe() { probe.current = exports.useSession(); return <div>{probe.current!.status}</div>; }
    render(<exports.SessionProvider><Probe /></exports.SessionProvider>);
    return { sweep, clearTokens, listeners, probe };
  }

  it('sweeps on launch, on a real employment switch, on background (not on inactive) and on logout', async () => {
    const f = sessionFixture();
    await waitFor(() => expect(screen.getByText('signedIn')).toBeTruthy());
    expect(f.sweep).toHaveBeenCalledTimes(1); // launch
    const switchTo = f.probe.current!.setEmploymentId;
    act(() => switchTo('employment-a'));
    expect(f.sweep).toHaveBeenCalledTimes(2);
    expect(f.probe.current!.employmentId).toBe('employment-a');
    expect(f.probe.current!.setEmploymentId).toBe(switchTo); // still a stable callback
    act(() => f.probe.current!.setEmploymentId('employment-a'));
    expect(f.sweep).toHaveBeenCalledTimes(2);
    act(() => f.listeners.change('inactive'));
    expect(f.sweep).toHaveBeenCalledTimes(2);
    act(() => f.listeners.change('background'));
    expect(f.sweep).toHaveBeenCalledTimes(3);
    await act(async () => { await f.probe.current!.signOut(); });
    expect(f.sweep).toHaveBeenCalledTimes(4);
    expect(f.clearTokens).toHaveBeenCalledOnce();
  });
});
