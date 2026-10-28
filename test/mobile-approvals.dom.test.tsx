/**
 * M08 — the shipped native approvals list and decision screen (mobile/lib/approval-decision.tsx, over the shipped
 * paged list), with only native views, transport, navigation and identity injected. The server's rules are tested
 * in test/mobile-v2-approvals.test.ts; this file pins what the screens do with its answers: native rows open the
 * detail and read-only kinds open the web, a decision runs only after a confirmation that repeats it, a rejection
 * needs a reason, per-date choice sends the approved dates, a lost answer is retried with the SAME reference, and a
 * refusal reloads the task and says why.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';
import * as errors from '../mobile/lib/errors';
import * as v2tasks from '../lib/mobile-api/v2/tasks';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Ports = Record<string, unknown>;
type Loaded = Record<string, any>;
function load(path: string, ports: Ports): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const item = (over: Record<string, unknown> = {}) => ({ id: ID, kind: 'leave', subject: { name: 'Aisyah', code: null }, createdAt: '2026-10-28T01:00:00.000Z', nativeDecision: true, webPath: null, ...over });
const leaveTask = (over: Record<string, unknown> = {}) => ({ outcome: 'found', task: {
  kind: 'leave', id: ID, subject: { name: 'Aisyah', code: 'E001' }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: true,
  leaveType: 'Annual', startDate: '2026-11-02', endDate: '2026-11-04', days: 3, durationType: 'full_day', fromTime: null, toTime: null, hours: null,
  employeeReason: 'Family trip', hasDocument: false, dates: [], expected: { stepIndex: 0 },
  teamCover: [{ name: 'Badrul', dates: [{ date: '2026-11-03', status: 'pending' }] }], ...over,
} });
const perDate = () => leaveTask({ expected: { stepIndex: null }, dates: [
  { date: '2026-11-02', days: 1, status: 'pending' }, { date: '2026-11-03', days: 1, status: 'pending' }, { date: '2026-11-04', days: 1, status: 'pending' }] });

function fixture() {
  let seq = 0;
  const apiGetPage = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ items: [item()], nextCursor: null }));
  const apiGetV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => leaveTask());
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const push = vi.fn(), back = vi.fn(), alert = vi.fn(), signOut = vi.fn(), openURL = vi.fn(async () => true);
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert }, Linking: { openURL },
    Pressable: (p: { disabled?: boolean; accessibilityRole?: string; accessibilityLabel?: string; accessibilityState?: { checked?: boolean }; onPress?: () => void; children?: React.ReactNode }) =>
      <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: { accessibilityLabel?: string; value: string; onChangeText: (v: string) => void }) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
    RefreshControl: (p: { onRefresh: () => void }) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: { refreshControl: React.ReactNode; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode; data: unknown[]; keyExtractor: (i: unknown) => string; renderItem: (a: { item: unknown }) => React.ReactNode }) =>
      <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((i) => <div key={p.keyExtractor(i)}>{p.renderItem({ item: i })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const ui = {
    Button: (p: { disabled?: boolean; onPress: () => void; title: string }) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: { children?: React.ReactNode; onRefresh?: () => void }) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: { error: Error | null; hasData: boolean; loading: boolean; onRetry: () => void }) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtDays: (n: unknown) => (n == null ? '—' : String(n)),
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const base: Ports = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', t },
  };
  const api = { apiGetPage, apiGetV2, apiPostV2, v2Page: (path: string) => ({ kind: 'page', path, schema: null }) };
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  const screens = load('mobile/lib/approval-decision.tsx', {
    ...base, './api': api, './paged-list': paged, '../../lib/mobile-api/v2/tasks': v2tasks,
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, back } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
  });
  /** Press the confirming (second) button of the Nth alert. */
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2] as { onPress?: () => void }[]; await act(async () => { buttons[1].onPress?.(); }); };
  const posted = (n = 0) => apiPostV2.mock.calls[n] as [string, unknown, Record<string, unknown>];
  // Object.assign keeps the loaded module's index signature (an object spread drops it).
  return Object.assign({} as Loaded, screens, { apiGetPage, apiGetV2, apiPostV2, push, alert, openURL, signOut, confirm, posted });
}
afterEach(cleanup);

describe('approvals list', () => {
  it('a native kind opens its detail; a read-only kind shows an Open on web chip that opens the company origin', async () => {
    const f = fixture();
    f.apiGetPage.mockResolvedValueOnce({ items: [
      item(),
      item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'claim', subject: { name: 'Chong', code: null }, nativeDecision: false, webPath: '/approvals?category=claim&task=claim&requestId=cccccccc-cccc-4ccc-8ccc-cccccccccccc#row' }),
    ], nextCursor: null });
    render(<f.ApprovalsScreen />);
    await screen.findByText('task_claim');
    expect((f.apiGetPage.mock.calls[0][0] as { path: string }).path).toBe('v2/tasks');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'task_leave · Aisyah' }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/approvals/[kind]/[id]', params: { kind: 'leave', id: ID } });
    fireEvent.click(screen.getByRole('link', { name: 'openOnWeb: task_claim · Chong' }));
    expect(f.openURL).toHaveBeenCalledWith('https://hr.test/approvals?category=claim&task=claim&requestId=cccccccc-cccc-4ccc-8ccc-cccccccccccc#row');
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('never builds a path or a web URL from anything but a native kind, a UUID and a relative path', () => {
    const f = fixture();
    expect(() => f.taskPath('claim', ID)).toThrow();
    expect(() => f.taskPath('leave', '../me')).toThrow();
    expect(f.taskPath('attendance', ID.toUpperCase(), 'decision')).toBe(`v2/tasks/attendance/${ID}/decision`);
    expect(f.webUrl('//evil.test/x')).toBeNull();
    expect(f.webUrl('https://evil.test')).toBeNull();
    expect(f.webUrl('/notices/x')).toBe('https://hr.test/notices/x');
  });
});

describe('approval detail', () => {
  it('shows who and what, the team cover and the confirm hint; approve runs only after a confirmation that repeats it', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('Aisyah · E001');
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/tasks/leave/${ID}`);
    expect(screen.getByText('approvalLeaveLine Annual|leaveDateSpan 2026-11-02|2026-11-04|3')).toBeTruthy();
    expect(screen.getByText('approvalTeamCoverLine Badrul|approvalTeamPendingDate 2026-11-03')).toBeTruthy();
    expect(screen.getByText('approvalConfirmHint')).toBeTruthy();
    fireEvent.click(screen.getByText('approvalApprove'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(String(f.alert.mock.calls[0][1])).toContain('Aisyah|approvalLeaveLine Annual');
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'pending_next_step' });
    await f.confirm();
    await screen.findByText('approvalDoneNext');
    const [path, , body] = f.posted();
    expect(path).toBe(`v2/tasks/leave/${ID}/decision`);
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/), decision: 'approve', expected: { stepIndex: 0 } });
  });

  it('a rejection needs a reason, and the confirmation repeats it', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('Aisyah · E001');
    expect(screen.getByText('approvalReject')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: '   ' } });
    expect(screen.getByText('approvalReject')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: ' Short staffed ' } });
    fireEvent.click(screen.getByText('approvalReject'));
    expect(String(f.alert.mock.calls[0][1])).toContain('Short staffed');
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'rejected' });
    await f.confirm();
    await screen.findByText('approvalDoneRejected');
    expect(f.posted()[2]).toEqual({ requestId: expect.any(String), decision: 'reject', reason: 'Short staffed', expected: { stepIndex: 0 } });
  });

  it('per-date: every pending date starts checked; unchecking one needs a reason and sends only the approved dates', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(perDate());
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByRole('checkbox', { name: '2026-11-03' });
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-03' }));
    expect(screen.getByText('approvalApprove')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: 'Stock take' } });
    fireEvent.click(screen.getByText('approvalApprove'));
    expect(String(f.alert.mock.calls[0][1])).toBe('approvalConfirmPartial Aisyah|2026-11-02, 2026-11-04|2026-11-03|Stock take');
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    await f.confirm();
    await screen.findByText('approvalDoneApproved');
    expect(f.posted()[2]).toEqual({ requestId: expect.any(String), decision: 'approve', dates: ['2026-11-02', '2026-11-04'], reason: 'Stock take', expected: { stepIndex: null } });
  });

  it('a lost answer is retried with the SAME reference; a 4xx is an error, never “uncertain”', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click(await screen.findByText('approvalApprove'));
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('approvalUncertain');
    expect(screen.queryByText('approvalApprove')).toBeNull();
    const body = f.posted()[2];
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    fireEvent.click(screen.getByText('approvalRetry'));
    await screen.findByText('approvalDoneApproved');
    expect(f.apiPostV2).toHaveBeenCalledTimes(2);
    expect(f.posted(1)[2]).toEqual(body);

    const g = fixture();
    render(<g.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click((await screen.findAllByText('approvalApprove')).at(-1)!);
    g.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400));
    await g.confirm();
    await screen.findByText('genericError');
    expect(screen.queryByText('approvalUncertain')).toBeNull();
  });

  it('a refusal reloads the task and says why; the reloaded expected step is what the next decision sends', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click(await screen.findByText('approvalApprove'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'stale_step' });
    f.apiGetV2.mockResolvedValueOnce(leaveTask({ expected: { stepIndex: 1 } }));
    await f.confirm();
    await screen.findByText('approvalRefusalStale');
    await waitFor(() => expect(f.apiGetV2).toHaveBeenCalledTimes(2));
    // While the reload is in flight the copy is not fresh, so the decision waits for it.
    await waitFor(() => expect(screen.getByText('approvalApprove')).not.toBeDisabled());
    fireEvent.click(screen.getByText('approvalApprove'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    await f.confirm(1);
    await screen.findByText('approvalDoneApproved');
    expect(f.posted(1)[2]).toMatchObject({ expected: { stepIndex: 1 } });
    expect(f.posted(1)[2].requestId).not.toBe(f.posted(0)[2].requestId);
  });

  it('a task that is not the caller’s shows the refusal and no decision', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'refused', code: 'self_approval' });
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('approvalRefusalSelf');
    expect(screen.queryByText('approvalApprove')).toBeNull();
    expect(screen.queryByText('approvalReject')).toBeNull();
  });

  it('a cancellation asks no reason (the kernel records none); a stale copy offers no decision', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'found', task: {
      kind: 'leaveCancellation', id: ID, subject: { name: 'Aisyah', code: null }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: false,
      leaveType: 'Annual', originalStart: '2026-11-02', originalEnd: '2026-11-04', cancelDates: ['2026-11-04'], requestedDays: 1, employeeReason: null, expected: { stepIndex: null },
    } });
    render(<f.ApprovalDetailScreen kind="leaveCancellation" id={ID} />);
    await screen.findByText('approvalCancellationLine Annual|2026-11-04|1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('approvalReject')).not.toBeDisabled();
    f.apiGetV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('refresh'));
    await screen.findByText(/staleData/);
    expect(screen.getByText('approvalReject')).toBeDisabled();
    expect(screen.getByText('approvalApprove')).toBeDisabled();
    expect(screen.getByText('approvalOnline')).toBeTruthy();
    expect(f.alert).not.toHaveBeenCalled();
  });
});
