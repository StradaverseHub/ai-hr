import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createInAppAlertState } from '../mobile/lib/in-app-alert-state';

afterEach(cleanup);
function fixture(platform = 'android') {
  let path = '/approvals/leave/id', generation = 1, employmentId = 'employment-A';
  const listeners = new Map<string, (value?: string) => void>();
  const nativeAlert = vi.fn(), submit = vi.fn();
  const appState = { currentState: 'active', addEventListener: (event: string, callback: (value?: string) => void) => { listeners.set(event, callback); return { remove: () => listeners.delete(event) }; } };
  const View = ({ children, pointerEvents, importantForAccessibility }: any) => <div data-pointer-events={pointerEvents} data-accessibility={importantForAccessibility}>{children}</div>;
  const Text = ({ children, accessibilityRole }: any) => accessibilityRole === 'header' ? <h2>{children}</h2> : <span>{children}</span>;
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, ScrollView: View, Alert: { alert: nativeAlert }, AppState: appState, Platform: { OS: platform },
      BackHandler: { addEventListener: (_event: string, callback: () => boolean) => { listeners.set('back', callback); return { remove: () => listeners.delete('back') }; } },
      Pressable: ({ children, onPress, accessibilityLabel }: any) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
      Modal: () => { throw new Error('A protected confirmation must not open a native modal window'); } },
    'expo-router': { usePathname: () => path }, './auth': { authGeneration: () => generation },
    './session': { useSession: () => ({ employmentId }) },
    './design': { DesignText: Text, useTenantDesign: () => ({ appearance: 'dark', palette: { text: '#fff', card: '#111', button: '#c0f000', onButton: '#111', border: '#333' } }) },
    './i18n': { t: (key: string) => key }, './in-app-alert-state': { createInAppAlertState },
  };
  const output = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync('mobile/lib/in-app-alert.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module: output, exports: output.exports, require: (id: string) => { if (id in ports) return ports[id]; throw new Error(id); } });
  const { InAppAlert, InAppAlertBoundary } = output.exports;
  const show = () => InAppAlert.alert('Approve request?', 'Recorded facts and consequence', [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: submit }]);
  function App() { return <InAppAlertBoundary><p>Private form</p><button onClick={show}>Review</button></InAppAlertBoundary>; }
  return { App, show, submit, nativeAlert, setPath: (next: string) => { path = next; }, changeAccount: () => { generation++; employmentId = 'employment-B'; }, event: (name: string) => { if (name === 'background') appState.currentState = name; listeners.get(name === 'background' ? 'change' : name)?.(name); } };
}

it('Android confirmation stays in the same window, blocks underlying controls and submits only after an explicit Confirm', () => {
  const f = fixture(); render(<f.App />); fireEvent.click(screen.getByText('Review'));
  expect(screen.getByText('Recorded facts and consequence')).toBeTruthy(); expect(f.nativeAlert).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  expect(screen.getByText('Private form').parentElement).toHaveAttribute('data-pointer-events', 'none');
  expect(screen.getByText('Private form').parentElement).toHaveAttribute('data-accessibility', 'no-hide-descendants');
  fireEvent.click(screen.getByText('Confirm')); expect(f.submit).toHaveBeenCalledTimes(1); expect(screen.queryByText('Approve request?')).toBeNull();
});
it.each(['Cancel', 'back', 'blur', 'background'])('%s dismisses the Android confirmation without submitting', event => {
  const f = fixture(); render(<f.App />); fireEvent.click(screen.getByText('Review'));
  if (event === 'Cancel') fireEvent.click(screen.getByText(event)); else act(() => f.event(event));
  expect(f.submit).not.toHaveBeenCalled(); expect(screen.queryByText('Approve request?')).toBeNull(); expect(f.nativeAlert).not.toHaveBeenCalled();
});
it('navigation and account changes remove the previous context’s confirmation', () => {
  const f = fixture(), ui = render(<f.App />); fireEvent.click(screen.getByText('Review')); f.setPath('/me'); ui.rerender(<f.App />);
  expect(screen.queryByText('Approve request?')).toBeNull(); fireEvent.click(screen.getByText('Review')); f.changeAccount(); ui.rerender(<f.App />);
  expect(screen.queryByText('Approve request?')).toBeNull(); expect(f.submit).not.toHaveBeenCalled();
});
it('iOS retains its existing native confirmation implementation', () => {
  const f = fixture('ios'); render(<f.App />); fireEvent.click(screen.getByText('Review'));
  expect(f.nativeAlert).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled(); expect(screen.queryByText('Approve request?')).toBeNull();
});
