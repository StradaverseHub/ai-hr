import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette, mobileSurfaceIsDark } from '../lib/mobile-design';

function load(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as Record<string, any> };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require(id: string) { if (id in ports) return ports[id]; if (id.endsWith('.png')) return 1; return {}; } });
  return module.exports;
}
const View = ({ children, accessibilityLabel, accessible, accessibilityElementsHidden }: any) => <div aria-label={accessibilityLabel} aria-hidden={accessibilityElementsHidden || undefined}>{children}</div>;
const Text = ({ children }: React.PropsWithChildren) => <span>{children}</span>;
afterEach(cleanup);

it.each(['dark', 'light'] as const)('keeps the complete action carousel reachable and routes to the original journeys in %s', appearance => {
  const push = vi.fn();
  const ports = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, Text, Image: () => null, ScrollView: View, useWindowDimensions: () => ({ width: 320 }), Pressable: ({ children, accessibilityLabel, onPress }: any) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button> },
    'expo-router': { router: { push } }, './visual': { alpha: (color: string) => color }, './icon': { Icon: () => null },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, appearance), appearance, reduceMotion: true }) },
    './i18n': { t: (key: string) => key },
  };
  const { QuickActions } = load('mobile/lib/home-hero.tsx', ports);
  const actions = ['leave', 'attendance', 'approvals', 'pay', 'directory', 'profile'].map(key => ({ key, icon: 'clock', label: key, href: '/' + key }));
  render(<QuickActions actions={actions} />);
  for (const action of actions) {
    fireEvent.click(screen.getByRole('button', { name: action.label, exact: true }));
    expect(push).toHaveBeenLastCalledWith(action.href);
  }
  expect(push).toHaveBeenCalledTimes(actions.length);
});

it('announces recorded worked time as one readable value rather than seven-segment decoration', () => {
  const ports = { react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, Text, StyleSheet: { absoluteFill: {}, hairlineWidth: .5 }, Platform: { OS: 'android' } },
    './design': { DesignText: Text, useTenantDesign: () => ({ palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    '../../lib/mobile-design': { mobileSurfaceIsDark },
  };
  const { TimeDisplay } = load('mobile/lib/visual.tsx', ports);
  render(<TimeDisplay seconds={29700} label="Worked today: 8h 15m" />);
  expect(screen.getByLabelText('Worked today: 8h 15m')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
