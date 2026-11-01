import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

function fixture(hasHistory: boolean) {
  const router = { canGoBack: vi.fn(() => hasHistory), back: vi.fn(), replace: vi.fn() };
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const module = { exports: {} as { HeaderBack: React.ComponentType<{ onPress?: () => void }> } };
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'expo-router': { router },
    'react-native-safe-area-context': { SafeAreaView: Container },
    'react-native': { View: Container, ScrollView: Container, RefreshControl: () => null,
      StyleSheet: { create: (value: unknown) => value },
      Pressable: ({ children, onPress, accessibilityLabel }: any) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button> },
    './design': { DesignText: Container, TenantBrand: () => null,
      useTenantDesign: () => ({ palette: { accent: 'blue' } }) },
    './errors': {}, './i18n': { t: (key: string) => key },
  };
  runInNewContext(transpileModule(readFileSync('mobile/lib/ui.tsx', 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require: (name: string) => {
    if (name in ports) return ports[name]; throw new Error('Missing UI port ' + name);
  } });
  return { HeaderBack: module.exports.HeaderBack, router };
}
afterEach(cleanup);

it('returns a cold-entry detail screen to Home when there is no navigation history', () => {
  const f = fixture(false); render(<f.HeaderBack />);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(f.router.replace).toHaveBeenCalledWith('/');
  expect(f.router.back).not.toHaveBeenCalled();
});
it('preserves normal stack Back when there is a previous screen', () => {
  const f = fixture(true); render(<f.HeaderBack />);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(f.router.back).toHaveBeenCalledOnce();
  expect(f.router.replace).not.toHaveBeenCalled();
});
it('keeps an explicit in-screen return action instead of changing routes', () => {
  const f = fixture(false), onPress = vi.fn(); render(<f.HeaderBack onPress={onPress} />);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(onPress).toHaveBeenCalledOnce();
  expect(f.router.back).not.toHaveBeenCalled();
  expect(f.router.replace).not.toHaveBeenCalled();
});
