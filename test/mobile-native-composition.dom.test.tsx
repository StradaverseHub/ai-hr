import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mobileDesignTemplate } from '../lib/mobile-design';
import { MOBILE_DESTINATIONS, newMobileBlock } from '../lib/mobile-composition';
function fixture() {
  const design = mobileDesignTemplate('editorial'), calls: string[] = [], push = vi.fn();
  design.composition.pages = [{ id: 'home', title: 'Our space', blocks: [newMobileBlock('text', 'intro'), { ...newMobileBlock('action', 'open'), target: 'benefits', title: 'Explore benefits' }] }, { id: 'benefits', title: 'Benefits', blocks: [newMobileBlock('leave', 'balances')] }];
  design.composition.pages[0].blocks[0].body = 'A place for our people.';
  const View = ({ children }: React.PropsWithChildren) => <div>{children}</div>, Text = ({ children }: React.PropsWithChildren) => <span>{children}</span>;
  const ports: Record<string, unknown> = {
    'react': React, 'react/jsx-runtime': jsx, 'react-native': { View }, 'expo-router': { router: { push, replace: push } },
    '../../lib/mobile-composition': { MOBILE_DESTINATIONS },
    './api': { useApi: (path: string) => { calls.push(path); return { loading: false, error: null, reload() {}, data: { cards: Array.from({ length: 6 }, (_, i) => ({ leaveTypeId: i, leaveType: `Leave ${i}`, isCurrentCycle: true, canApplyFor: i })) } }; } },
    './clock-panel': { ClockPanel: () => <p>Attendance</p> }, './team-panel': { TeamPanel: () => <p>Team</p> },
    './design': { DesignText: Text, TenantSurface: View, useTenantDesign: () => ({ design, palette: design.composition.themes.light }) },
    './session': { useSession: () => ({ employmentId: 'current', signOut() {} }) }, './i18n': { t: (key: string) => key },
    './ui': { Screen: View, Title: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>, Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>, LoadState: () => null, Muted: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>, fmtDays: String, fmtMoney: String },
  };
  const module = { exports: {} as { ComposedPage: React.ComponentType<{ design: typeof design; id?: string }> } };
  runInNewContext(transpileModule(readFileSync('mobile/lib/composed-page.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText, { exports: module.exports, module, require(id: string) { if (!(id in ports)) throw new Error('Missing composition port ' + id); return ports[id]; } });
  return { ...module.exports, design, calls, push };
}
afterEach(cleanup);
it('renders custom composition and internal navigation without loading unrelated HR data', () => {
  const f = fixture(); render(<f.ComposedPage design={f.design} />);
  expect(screen.getByText('A place for our people.')).toBeTruthy(); expect(f.calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Explore benefits' }));
  expect(f.push).toHaveBeenCalledWith({ pathname: '/custom', params: { id: 'benefits' } });
});
it('binds a custom screen to the existing leave endpoint and keeps every leave type visible', () => {
  const f = fixture(); render(<f.ComposedPage design={f.design} id="benefits" />);
  expect(f.calls).toEqual(['leave']); expect(screen.getAllByText(/^Leave \d:/)).toHaveLength(6);
});
