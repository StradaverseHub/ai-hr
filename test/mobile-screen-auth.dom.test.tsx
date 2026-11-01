import { mobileVisualPorts, mobileMotionPorts } from './helpers/mobile-visual-ports';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';
function fixture(initial: string) {
  let status = initial;
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Text = ({ children }: React.PropsWithChildren) => <span>{children}</span>;
  const output = { exports: {} as { Screen: React.ComponentType<React.PropsWithChildren> } };
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View: Container, ScrollView: Container, Pressable: Container, ActivityIndicator: Container, RefreshControl: () => null, StyleSheet: { create: (value: unknown) => value } },
    'react-native-safe-area-context': { SafeAreaView: Container },
    'expo-router': { Redirect: ({ href }: { href: string }) => <p>Sign in required: {href}</p>, router: { canGoBack: vi.fn(), back: vi.fn(), replace: vi.fn() } },
    './motion': mobileMotionPorts, '../../lib/motion': mobileMotionPorts, './visual': mobileVisualPorts, './design': { Atmosphere: () => null, DesignText: Text, TenantBrand: () => <span>OneHR+</span>, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'light'), reload: vi.fn() }) },
    './session': { useSession: () => ({ status }) }, './i18n': { t: (key: string) => key }, './errors': { UnavailableError: class extends Error {} },
  };
  runInNewContext(transpileModule(readFileSync('mobile/lib/ui.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { exports: output.exports, module: output, require(id: string) { if (id in ports) return ports[id]; throw new Error('Unexpected screen dependency: ' + id); } });
  function View() { return <output.exports.Screen><p>Private profile contents</p></output.exports.Screen>; }
  return { View, set: (next: string) => { status = next; } };
}
afterEach(cleanup);
describe('shared private screen session boundary', () => {
  it.each(['signedOut', 'locked', 'loading'])('never renders private route contents while %s', status => {
    const f = fixture(status); render(<f.View />);
    expect(screen.queryByText('Private profile contents')).toBeNull();
    expect(screen.getByText('Sign in required: /sign-in')).toBeTruthy();
  });
  it('removes an existing private view immediately when its session is revoked', () => {
    const f = fixture('signedIn'), ui = render(<f.View />);
    expect(screen.getByText('Private profile contents')).toBeTruthy();
    f.set('signedOut'); ui.rerender(<f.View />);
    expect(screen.queryByText('Private profile contents')).toBeNull();
    expect(screen.getByText('Sign in required: /sign-in')).toBeTruthy();
  });
});
