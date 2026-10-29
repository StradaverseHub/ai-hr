import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mobileDesignTemplate } from '../lib/mobile-design';
import { MOBILE_DESTINATIONS, newMobileBlock } from '../lib/mobile-composition';
import * as v2tasks from '../lib/mobile-api/v2/tasks';
import { UnavailableError } from '../mobile/lib/errors';

const taskRow = (kind: string, name: string) => ({ id: `${kind}-one`, kind, subject: { name, code: null }, createdAt: '2026-10-28T01:00:00.000Z', nativeDecision: kind === 'leave', webPath: kind === 'leave' ? null : '/approvals' });
type TasksRead = { loading: boolean; error: Error | null; data: { items: ReturnType<typeof taskRow>[]; nextCursor: string | null } | null };
function fixture() {
  const design = mobileDesignTemplate('editorial'), calls: string[] = [], push = vi.fn(), v2params: unknown[] = [], v2schemas: unknown[] = [];
  const tasks: TasksRead = { loading: false, error: null, data: { items: [taskRow('leave', 'Scoped colleague')], nextCursor: null } };
  design.composition.pages = [{ id: 'home', title: 'Our space', blocks: [newMobileBlock('text', 'intro'), { ...newMobileBlock('action', 'open'), target: 'benefits', title: 'Explore benefits' }] }, { id: 'benefits', title: 'Benefits', blocks: [newMobileBlock('leave', 'balances')] }];
  design.composition.pages[0].blocks[0].body = 'A place for our people.';
  const View = ({ children }: React.PropsWithChildren) => <div>{children}</div>, Text = ({ children }: React.PropsWithChildren) => <span>{children}</span>;
  const ports: Record<string, unknown> = {
    'react': React, 'react/jsx-runtime': jsx, 'react-native': { View }, 'expo-router': { router: { push, replace: push } },
    '../../lib/mobile-composition': { MOBILE_DESTINATIONS },
    '../../lib/mobile-api/v2/tasks': v2tasks,
    './api': { useApiV2: (path: string, schema: unknown, params: unknown) => { calls.push(path); v2params.push(params); v2schemas.push(schema); return { ...tasks, reload() {} }; }, useApi: (path: string) => { calls.push(path); return { loading: false, error: null, reload() {}, data: path === 'tasks' ? { total: 1, items: [{ id: 'one', kind: 'leave', subject: 'Scoped colleague' }] } : { cards: Array.from({ length: 6 }, (_, i) => ({ leaveTypeId: i, leaveType: `Leave ${i}`, isCurrentCycle: true, canApplyFor: i })) } }; } },
    './home-cards': { ClockSummary: () => <p>Clock summary</p>, LeaveSummary: () => <p>Leave summary</p>, PayslipRow: () => <p>Payslip row</p> },
    './inbox': { HomeNeeds: () => <p>Needs you rows</p> },
    './team-panel': { TeamPanel: ({ compact }: { compact?: boolean }) => <p>{compact ? 'Team compact' : 'Team'}</p> },
    './design': { DesignText: Text, TenantSurface: View, useTenantDesign: () => ({ design, palette: design.composition.themes.light }) },
    './session': { useSession: () => ({ employmentId: 'current', signOut() {} }) }, './i18n': { t: (key: string) => key },
    './ui': { Screen: View, Title: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>, Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>, LoadState: () => null, Muted: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>, fmtDays: String, fmtMoney: String },
  };
  const module = { exports: {} as { ComposedPage: React.ComponentType<{ design: typeof design; id?: string }> } };
  runInNewContext(transpileModule(readFileSync('mobile/lib/composed-page.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText, { exports: module.exports, module, require(id: string) { if (!(id in ports)) throw new Error('Missing composition port ' + id); return ports[id]; } });
  return { ...module.exports, design, calls, push, tasks, v2params, v2schemas };
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

// A custom page keeps the tenant's list; Home shows the two "Needs you" rows instead (test below).
it('reads the canonical v2 task list rather than treating unread notifications as tasks, and links to approvals', () => {
  const f = fixture(); f.design.composition.pages[1].blocks = [newMobileBlock('tasks', 'pending')];
  render(<f.ComposedPage design={f.design} id="benefits" />);
  // M14: the v2 list (every kind the approvals screen shows), never v1 `tasks`, which omits replacement leave and notice acknowledgements.
  expect(f.calls).toEqual(['v2/tasks']); expect(f.v2schemas).toEqual([v2tasks.TasksPageV2]);
  expect(f.v2params[0]).toEqual({ limit: expect.stringMatching(/^(4|20)$/) });
  expect(screen.getByText('task_leave: Scoped colleague')).toBeTruthy();
  expect(screen.queryByText('nothingNeedsYou')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'openApprovals' }));
  expect(f.push).toHaveBeenCalledWith('/approvals');
});

it('shows kinds v1 omits, so waiting replacement leave or a notice acknowledgement is never "nothing needs you"', () => {
  const f = fixture(); f.design.composition.pages[1].blocks = [newMobileBlock('tasks', 'pending')];
  f.tasks.data = { items: [taskRow('replacementLeave', 'Replacement colleague'), taskRow('noticeAcknowledgement', '')], nextCursor: null };
  render(<f.ComposedPage design={f.design} id="benefits" />);
  expect(screen.getByText('task_replacementLeave: Replacement colleague')).toBeTruthy();
  expect(screen.getByText('task_noticeAcknowledgement: —')).toBeTruthy();
  expect(screen.queryByText('nothingNeedsYou')).toBeNull();
  expect(screen.getByRole('button', { name: 'openApprovals' })).toBeTruthy();
});

it('says "nothing needs you" only for a settled, successful, empty list — never while loading, failed or stale', () => {
  const cases: [TasksRead, boolean][] = [
    [{ loading: true, error: null, data: null }, false],
    [{ loading: false, error: new UnavailableError(), data: null }, false],
    // An outage keeps the last rows on screen (stale); even an empty stale answer is not "all clear".
    [{ loading: false, error: new UnavailableError(), data: { items: [], nextCursor: null } }, false],
    [{ loading: true, error: null, data: { items: [], nextCursor: null } }, false],
    [{ loading: false, error: null, data: { items: [], nextCursor: null } }, true],
  ];
  for (const [read, clear] of cases) {
    const f = fixture(); f.design.composition.pages[1].blocks = [newMobileBlock('tasks', 'pending')];
    Object.assign(f.tasks, read);
    const { unmount } = render(<f.ComposedPage design={f.design} id="benefits" />);
    expect(screen.queryByText('nothingNeedsYou') !== null, JSON.stringify({ loading: read.loading, error: !!read.error, data: !!read.data })).toBe(clear);
    expect(screen.queryByRole('button', { name: 'openApprovals' })).toBeNull();
    unmount();
  }
});

it('Home is a summary: compact clock card (no clocking), Needs-you rows, three balances, compact team, one payslip row', () => {
  const f = fixture();
  f.design.composition.pages[0].blocks = (['clock', 'tasks', 'leave', 'team', 'pay'] as const).map(kind => ({ ...newMobileBlock(kind, kind), detail: 'expanded' as const }));
  render(<f.ComposedPage design={f.design} />);
  for (const text of ['Clock summary', 'Needs you rows', 'Leave summary', 'Team compact', 'Payslip row']) expect(screen.getByText(text)).toBeTruthy();
  // The summaries read their own endpoints; the page itself loads no task list, balances or payslips.
  expect(f.calls).toEqual([]);
});
it('a custom page keeps its tenant-chosen detail, but its clock section is still the summary card: clocking happens on the Clock tab only', () => {
  const f = fixture();
  f.design.composition.pages[1].blocks = [newMobileBlock('clock', 'clock'), newMobileBlock('team', 'team')];
  render(<f.ComposedPage design={f.design} id="benefits" />);
  expect(screen.getByText('Clock summary')).toBeTruthy(); expect(screen.getByText('Team')).toBeTruthy();
});
it('no destination the app can open is a claims screen', () => {
  const mod = fixture() as unknown as { mobileDestination: (target: string) => unknown };
  for (const target of MOBILE_DESTINATIONS) expect(JSON.stringify(mod.mobileDestination(target))).not.toMatch(/claim/i);
  // An unknown id (e.g. a "claims" page a future catalogue might name) is a tenant page, never the deleted claims route.
  expect(mod.mobileDestination('claims')).toEqual({ pathname: '/custom', params: { id: 'claims' } });
});
