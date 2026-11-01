import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contract from '../lib/mobile-design';

function fixture() {
  let response: { config: unknown } | null = { config: { ...contract.DEFAULT_MOBILE_DESIGN, brandName: 'Tenant A', accent: 'jade' } };
  const reload = vi.fn(), signOut = vi.fn();
  let foreground: (state: string) => void = () => {};
  const prefs = { appearance: 'auto' as 'auto' | 'light' | 'dark' };
  const output = { exports: {} as { PublicDesignProvider: React.ComponentType<React.PropsWithChildren>; TenantDesignProvider: React.ComponentType<React.PropsWithChildren>; useTenantDesign: () => { design: contract.MobileDesign; palette: { accent: string } } } };
  const code = transpileModule(readFileSync('mobile/lib/design.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, require(id: string) {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === '../../lib/mobile-design') return contract;
    if (id === './session') return { useSession: () => ({ signOut }) };
    if (id === './preferences') return { useDisplayPrefs: () => ({ appearance: prefs.appearance, language: 'auto' }) };
    if (id === './api') return { useApi: (path: string, params: unknown, onAuth: unknown) => { expect(path).toBe('design'); expect(params).toEqual({ schema: '2', artwork: '1' }); expect(onAuth).toBe(signOut); return { data: response, reload }; } };
    if (id === 'react-native') return { useColorScheme: () => 'light', AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) }, AppState: { addEventListener: (_: string, callback: typeof foreground) => { foreground = callback; return { remove() {} }; } } };
    throw new Error('Unexpected native design dependency: ' + id);
  } });
  function Probe() { const { design, palette } = output.exports.useTenantDesign(); return <p>{design.brandName} {palette.accent}</p>; }
  function View() { return <output.exports.TenantDesignProvider><Probe /></output.exports.TenantDesignProvider>; }
  function PublicView() { return <output.exports.PublicDesignProvider><Probe /></output.exports.PublicDesignProvider>; }
  return { View, PublicView, Probe, reload, prefs, foreground: (state: string) => foreground(state), set(value: typeof response) { response = value; } };
}
afterEach(cleanup);
describe('store-app tenant design consumption', () => {
  it('uses a readable accent outside the authenticated design provider on the light sign-in and lock screens', () => {
    const f = fixture(); render(<f.Probe />); expect(screen.getByText('OneHR+ #176747')).toBeTruthy();
  });
  it('applies phone appearance before sign-in and honors personal dark/light choices without tenant requests', () => {
    const f = fixture(), ui = render(<f.PublicView />);
    expect(screen.getByText('OneHR+ #176747')).toBeTruthy();
    f.prefs.appearance = 'dark'; ui.rerender(<f.PublicView />);
    expect(screen.getByText('OneHR+ #b9f3d5')).toBeTruthy();
    f.prefs.appearance = 'light'; ui.rerender(<f.PublicView />);
    expect(screen.getByText('OneHR+ #176747')).toBeTruthy();
    expect(f.reload).not.toHaveBeenCalled();
  });
  it('uses the published contract, requests a new release on return and replaces branding', () => {
    const f = fixture(), ui = render(<f.View />);
    expect(screen.getByText('Tenant A #b9f3d5')).toBeTruthy();
    f.foreground('active'); expect(f.reload).toHaveBeenCalledTimes(1);
    f.set({ config: { ...contract.DEFAULT_MOBILE_DESIGN, brandName: 'Tenant B', appearance: 'system', accent: 'cobalt' } });
    ui.rerender(<f.View />); expect(screen.getByText('Tenant B #174bb5')).toBeTruthy(); expect(screen.queryByText(/Tenant A/)).toBeNull();
  });
  it('lets the person’s own Light or Dark choice win over the company appearance, and Automatic follow it again', () => {
    const f = fixture(), ui = render(<f.View />);
    expect(screen.getByText('Tenant A #b9f3d5')).toBeTruthy(); // the company design's dark jade
    f.prefs.appearance = 'light'; ui.rerender(<f.View />);
    expect(screen.getByText('Tenant A #176747')).toBeTruthy(); // light jade
    f.prefs.appearance = 'auto'; ui.rerender(<f.View />);
    expect(screen.getByText('Tenant A #b9f3d5')).toBeTruthy();
  });
  it('never restores another account’s design after unmount or malformed configuration', () => {
    const f = fixture(), ui = render(<f.View />); ui.unmount(); f.set(null);
    const next = render(<f.View />); expect(screen.queryByText(/Tenant A/)).toBeNull(); expect(screen.getByText(/OneHR\+/)).toBeTruthy();
    f.set({ config: { ...contract.DEFAULT_MOBILE_DESIGN, brandName: 'Injected', script: 'alert(1)' } });
    next.rerender(<f.View />); expect(screen.queryByText(/Injected/)).toBeNull();
  });
});
