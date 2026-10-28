/**
 * M13 (D14) — the shipped team panel's week navigation (mobile/lib/team-panel.tsx) over the v2 window, with only
 * native views, transport and identity injected. The server's rules (bounds, membership, disclosure) are tested in
 * test/mobile-v2-team.test.ts; this file pins what the panel asks for: this week by default (the server's today),
 * previous/next shift by seven days from the window shown, "This week" returns to the server's default, and the
 * panel discloses truncation and never counts pending leave as away.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';
import * as v2team from '../lib/mobile-api/v2/team';

function load(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date, Error, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const TODAY = '2026-10-28';
const answer = (from: string, over: Record<string, unknown> = {}) => ({
  enabled: true, today: TODAY, from, to: v2team.addCalendarDays(from, 6), scope: 'my_team', companies: 1, memberCount: 3, truncated: false,
  items: [
    { employmentId: 'a', name: 'Approved Away', dates: [{ date: from, status: 'approved', session: 'full_day' }] },
    { employmentId: 'b', name: 'Pending Colleague', dates: [{ date: from, status: 'pending', session: 'AM' }] },
    { employmentId: 'c', name: 'Nobody Away', dates: [] },
  ],
  ...over,
});

function fixture() {
  const calls: Record<string, string | undefined>[] = [];
  const reload = vi.fn();
  let override: Record<string, unknown> | null = null;
  // The read answers whatever window it is asked for, as the server would.
  function useApiV2(path: string, _schema: unknown, params: Record<string, string | undefined>) {
    calls.push({ path, ...params });
    return { data: { ...answer(params.from ?? TODAY), ...(override ?? {}) }, error: null, loading: false, reload };
  }
  const View = ({ children }: any) => <div>{children}</div>;
  const Text = ({ children }: any) => <span>{children}</span>;
  const native = { View, Text, Pressable: (p: any) => <button onClick={p.onPress}>{p.children}</button> };
  const ui = { Button: (p: any) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>, Muted: Text, LoadState: () => null };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const { TeamPanel } = load('mobile/lib/team-panel.tsx', {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './i18n': { t },
    './api': { useApiV2 }, './session': { useSession: () => ({ signOut: vi.fn() }) },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    'expo-router': { useFocusEffect: () => {} }, '../../lib/mobile-api/v2/team': v2team,
  });
  return { TeamPanel, calls, reload, setOverride: (value: Record<string, unknown> | null) => { override = value; } };
}
afterEach(cleanup);

describe('team availability week navigation', () => {
  it('asks for the server’s default week, then exactly seven days back or forward from the window shown', () => {
    const f = fixture();
    render(<f.TeamPanel />);
    const last = () => { const c = f.calls.at(-1)!; return { path: c.path, from: c.from, to: c.to }; };
    expect(last()).toEqual({ path: 'v2/team/availability', from: undefined, to: undefined });
    expect(screen.getByText(`teamWindow ${TODAY}|${v2team.addCalendarDays(TODAY, 6)}`)).toBeTruthy();
    // Today is inside the window: the headline counts APPROVED absence today only (pending is not away).
    expect(screen.getByText('awayToday 1|3')).toBeTruthy();
    expect(screen.getByText('teamThisWeek')).toBeDisabled();
    fireEvent.click(screen.getByText('teamPrevWeek'));
    expect(last()).toEqual({ path: 'v2/team/availability', from: '2026-10-21', to: '2026-10-27' });
    // Outside today: the headline is about the period.
    expect(screen.getByText('teamAwayInWindow 1|3')).toBeTruthy();
    fireEvent.click(screen.getByText('teamPrevWeek'));
    expect(last()).toEqual({ path: 'v2/team/availability', from: '2026-10-14', to: '2026-10-20' });
    fireEvent.click(screen.getByText('teamThisWeek'));
    expect(last()).toEqual({ path: 'v2/team/availability', from: undefined, to: undefined });
    fireEvent.click(screen.getByText('teamNextWeek'));
    expect(last()).toEqual({ path: 'v2/team/availability', from: '2026-11-04', to: '2026-11-10' });
    // Coming back to the server's today returns to its default, not a pinned date.
    fireEvent.click(screen.getByText('teamPrevWeek'));
    expect(last()).toEqual({ path: 'v2/team/availability', from: undefined, to: undefined });
    // Every window the panel asks for is within the server's bound.
    for (const c of f.calls) if (c.from) expect(v2team.windowDays(c.from, c.to!)).toBeLessThanOrEqual(v2team.TEAM_WINDOW_MAX_DAYS);
  });

  it('lists each person’s dates with status and session, says when a person has none, and discloses truncation', () => {
    const f = fixture();
    f.setOverride({ truncated: true, memberCount: 250 });
    render(<f.TeamPanel />);
    fireEvent.click(screen.getByText(/awayToday/));
    expect(screen.getByText(`${TODAY} · approved · fullDay`)).toBeTruthy();
    expect(screen.getByText(`${TODAY} · pending · halfAM`)).toBeTruthy();
    expect(screen.getByText('teamNoLeaveInWindow')).toBeTruthy();
    expect(screen.getByText('teamTruncated 3|250')).toBeTruthy();
    expect(screen.queryByText(/full_day/)).toBeNull();
  });

  it('renders nothing for a caller without team access', () => {
    const f = fixture();
    f.setOverride({ enabled: false, items: [], memberCount: 0 });
    render(<f.TeamPanel />);
    expect(screen.queryByText('teamAvailability')).toBeNull();
    act(() => {});
  });
});
