/**
 * WP-B1 (APR-020) — the Calibration destination: the read-only list screen, and (D-P1-32 PT-X5) that it is a tab of
 * Performance & Talent rather than a sidebar row.
 * The service's authority facts (who sees which session) are pinned against real RLS in
 * test/performance-calibration-list.test.ts.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: vi.fn() }));

import { CalibrationList } from '../app/(app)/performance/onehr/calibration-list';
import { Sidebar } from '../components/sidebar';
import { calibrationToDo, calibrationWindowState, sortCalibrationSessions, type CalibrationListSession } from '../packs/performance/onehr/calibration-list-model';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';

const t = en.onehr.calibrationList;
afterEach(cleanup);

const row = (over: Partial<CalibrationListSession>): CalibrationListSession => ({
  id: over.name ?? 'id', name: 'Session', tier: 'hod', cycleId: 'c', cycleName: 'Annual 2026', cycleClosed: false, companyName: 'Acme Sdn Bhd',
  window: 'open', opensOn: null, closesOn: null, people: 3, toDo: 2, lock: 'open', axes: ['performance', 'potential'], href: `/performance/assessment/calibration/${over.name ?? 'id'}`, ...over,
});

function page(sessions: CalibrationListSession[], boards?: Record<string, string>) {
  return render(<NextIntlClientProvider locale="en" messages={en}><CalibrationList sessions={sessions} boards={boards} /></NextIntlClientProvider>);
}

describe('Calibration list screen', () => {
  it('shows the empty state and nothing else when no session is assigned', () => {
    page([]);
    expect(screen.getByText(t.empty)).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('groups by tier in Group, BG, BU, Department, Final order and keeps the service order inside a group', () => {
    const sessions = sortCalibrationSessions([
      row({ name: 'Final override', tier: 'final', companyName: null }),
      row({ name: 'Dept closed', tier: 'hod', window: 'closed' }),
      row({ name: 'Dept open', tier: 'hod', window: 'open', closesOn: '2026-11-30' }),
      row({ name: 'BU cohort', tier: 'bu', window: 'upcoming', opensOn: '2026-12-01', lock: 'partial' }),
      row({ name: 'BG box', tier: 'bg', lock: 'locked' }),
      row({ name: 'Group review', tier: 'group', companyName: null }),
    ]);
    page(sessions);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([t.tiers.group, t.tiers.bg, t.tiers.bu, t.tiers.hod, t.tiers.final]);
    const dept = screen.getByRole('region', { name: t.tiers.hod });
    expect(within(dept).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dept open', 'Dept closed']);
    expect(within(dept).getByText(t.closesOn.replace('{date}', '2026-11-30'))).toBeTruthy();
    const bu = screen.getByRole('region', { name: t.tiers.bu });
    expect(within(bu).getByText(t.window.upcoming)).toBeTruthy();
    expect(within(bu).getByText(t.opensOn.replace('{date}', '2026-12-01'))).toBeTruthy();
    expect(within(bu).getByText(t.lock.partial)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: t.tiers.group })).getByText(t.groupWide)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'BG box' }).getAttribute('href')).toBe('/performance/assessment/calibration/BG box');
  });

  it('links a session whose Talent Box the viewer holds to its standalone board, and only that row (PT-TB)', () => {
    page([row({ name: 'BG box', tier: 'bg', axes: ['both'] }), row({ name: 'BU cohort', tier: 'bu' })], { 'BG box': '/performance/calibration/talent-box?session=BG%20box' });
    const board = screen.getByRole('link', { name: en.performanceArea.tabs.cal.talentBox });
    expect(board.getAttribute('href')).toBe('/performance/calibration/talent-box?session=BG%20box');
    expect(within(screen.getByRole('region', { name: t.tiers.bg })).getAllByRole('link').map((a) => a.textContent)).toEqual(['BG box', en.performanceArea.tabs.cal.talentBox]);
    expect(within(screen.getByRole('region', { name: t.tiers.bu })).getAllByRole('link').map((a) => a.textContent)).toEqual(['BU cohort']);
  });

  it('offers no write control: links into the session are the only interactive elements', () => {
    page([row({ name: 'A' }), row({ name: 'B', tier: 'bu' })]);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

describe('Calibration list model', () => {
  const policy = defaultPolicy(framework);
  it('derives the window from the tier cells the calibration writer asserts, and the dates in Kuala Lumpur', () => {
    const now = new Date('2026-10-27T04:00:00Z');
    const w = { ...policy, windows: { pm_hod: { opensAt: '2026-10-01T00:00:00+08:00', closesAt: '2026-10-31T23:59:00+08:00' }, pot_hod: { opensAt: '2026-11-01T00:00:00+08:00', closesAt: '2026-11-15T00:00:00+08:00' } } };
    expect(calibrationWindowState(w, 'hod', false, now)).toEqual({ window: 'open', opensOn: '2026-10-01', closesOn: '2026-11-15' });
    expect(calibrationWindowState(w, 'hod', true, now).window).toBe('closed');
    expect(calibrationWindowState({ ...policy, windows: { tb_bgceo: { opensAt: '2026-12-01T00:00:00+08:00', closesAt: null } } }, 'bg', false, now).window).toBe('upcoming');
    expect(calibrationWindowState({ ...policy, windows: { pm_buceo: { opensAt: null, closesAt: '2026-10-01T00:00:00+08:00' }, pot_buceo: { opensAt: null, closesAt: '2026-10-01T00:00:00+08:00' } } }, 'bu', false, now).window).toBe('closed');
    // Group and Final have no window cell: open while the cycle is live.
    expect(calibrationWindowState(policy, 'group', false, now).window).toBe('open');
    // A late-evening Kuala Lumpur instant is that KL day, not the UTC one.
    expect(calibrationWindowState({ ...policy, windows: { tb_bgceo: { opensAt: null, closesAt: '2026-11-30T16:30:00Z' } } }, 'bg', false, now).closesOn).toBe('2026-12-01');
  });
  it('counts to do from open parts only, and a locked department part leaves nothing to do', () => {
    const entry = (reviewId: string, frozen = false) => ({ reviewId, companyId: 'c', employmentId: reviewId, personId: reviewId, performanceLocked: false, potentialLocked: false, performanceReady: true, frozen, decisions: [] });
    const entries = [entry('a'), entry('b'), entry('c', true)];
    expect(calibrationToDo(policy, 'hod', { lockedAt: null, performanceLockedAt: null, potentialLockedAt: null }, entries)).toBe(2);
    expect(calibrationToDo(policy, 'hod', { lockedAt: null, performanceLockedAt: new Date(), potentialLockedAt: new Date() }, entries)).toBe(0);
    expect(calibrationToDo(policy, 'bu', { lockedAt: null, performanceLockedAt: null, potentialLockedAt: null }, [{ ...entry('a'), performanceLocked: true, potentialLocked: true }, entry('b')])).toBe(1);
  });
});

describe('Calibration in the rail (D-P1-32 PT-X5)', () => {
  // The Calibration row retired into the Performance & Talent area: the area's Calibration strip (tab-model.ts) is
  // where its gate lives now, and the rail offers only the area entry, to every viewer with the module.
  function rail(props: { canAdministerOnehr?: boolean; canApprove?: boolean; isAdmin?: boolean; enabledModules?: string[] | null }) {
    render(<NextIntlClientProvider locale="en" messages={en}>
      <Sidebar isAdmin={props.isAdmin ?? false} canApprove={props.canApprove ?? false} canAdministerOnehr={props.canAdministerOnehr}
        enabledModules={props.enabledModules === undefined ? ['leave', 'performance'] : props.enabledModules} defaultCollapsed={false} />
    </NextIntlClientProvider>);
    const strat = screen.queryByRole('button', { name: /Strat/ });
    if (strat) fireEvent.click(strat);
    return { calibration: document.querySelector('a[href^="/performance/calibration"]'), area: document.querySelector('a[href="/performance/home"]') };
  }
  it.each([{}, { canApprove: true }, { isAdmin: true }, { canAdministerOnehr: true }])('offers no Calibration row, only Performance & Talent (%o)', (props) => {
    const { calibration, area } = rail(props);
    expect(calibration).toBeNull();
    expect(area).not.toBeNull();
  });
  it('offers neither when the performance module is not on the plan', () => {
    const { calibration, area } = rail({ canAdministerOnehr: true, enabledModules: ['leave'] });
    expect(calibration).toBeNull();
    expect(area).toBeNull();
  });
});
