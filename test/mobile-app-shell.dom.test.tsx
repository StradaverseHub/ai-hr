import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { dailyDestinationForPath } from '../mobile/lib/navigation-routes';

function fixture() {
  let path = '/approvals/profile/synthetic-task';
  const navigate = vi.fn();
  const View = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Pressable = (p: any) => <button role={p.accessibilityRole} aria-label={p.accessibilityLabel} aria-selected={p.accessibilityState?.selected} onClick={p.onPress}>{p.children}</button>;
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, Pressable }, 'react-native-safe-area-context': { SafeAreaView: View },
    'expo-router': { router: { navigate }, usePathname: () => path },
    'expo-symbols': { SymbolView: () => null }, './icon': { Icon: () => null },
    './design': { TenantBrand: () => <span>OneHR+</span>, DesignText: View, useTenantDesign: () => ({ appearance: 'dark', palette: {}, design: { schemaVersion: 1 } }) },
    './i18n': { t: (key: string) => key }, './navigation-routes': { dailyDestinationForPath },
    './tenant-navigation': { TenantNavigation: () => <div>Published destinations</div> },
  };
  function load(file: string) {
    const output = { exports: {} as any };
    runInNewContext(transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
      { module: output, exports: output.exports, require: (id: string) => { if (id in ports) return ports[id]; throw new Error(id); } });
    return output.exports;
  }
  ports['./daily-navigation'] = load('mobile/lib/daily-navigation.tsx');
  return { ...load('mobile/lib/app-shell.tsx'), navigate, setPath: (value: string) => { path = value; } };
}
afterEach(cleanup);
it('keeps a single header and five destinations around a pushed approval form, and navigation never approves it', () => {
  const f = fixture(), approve = vi.fn();
  render(<f.SignedInShell><label>Reason<input /></label><button onClick={approve}>Approve</button></f.SignedInShell>);
  expect(screen.getByText('OneHR+')).toBeTruthy(); expect(screen.getAllByRole('tab')).toHaveLength(5);
  expect(screen.getByRole('tab', { name: 'approvalsTitle' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'tabClock' })); expect(f.navigate).toHaveBeenCalledWith('/clock'); expect(approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'qaSettings' })); expect(f.navigate).toHaveBeenCalledWith('/settings'); expect(approve).not.toHaveBeenCalled();
});
it('keeps the frame while page content changes between loading, an error and a detail', () => {
  const f = fixture(), ui = render(<f.SignedInShell><p>Loading profile</p></f.SignedInShell>);
  for (const body of ['Profile unavailable', 'Profile details']) {
    f.setPath('/profile'); ui.rerender(<f.SignedInShell><p>{body}</p></f.SignedInShell>);
    expect(screen.getByText(body)).toBeTruthy(); expect(screen.getByText('OneHR+')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(5); expect(screen.getByRole('tab', { name: 'tabMe' }).getAttribute('aria-selected')).toBe('true');
  }
});
it.each([
  ['/', '/'], ['/clock', '/clock'], ['/attendance/correction', '/clock'], ['/attendance/request/task', '/clock'],
  ['/leave/history', '/leave'], ['/leave/request', '/leave'], ['/approvals/claim/task', '/work'], ['/work', '/work'],
  ['/profile/edit', '/me'], ['/pay/ea', '/me'], ['/settings', '/me'], ['/pending-submissions', '/me'], ['/integrity-keys', '/me'],
])('retains the parent destination for %s', (path, parent) => { expect(dailyDestinationForPath(path)).toBe(parent); });
