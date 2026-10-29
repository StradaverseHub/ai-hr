/**
 * M07 — the shipped native leave history and detail (mobile/lib/leave-history.tsx, over the shipped paged list),
 * with only native views, transport, navigation and identity injected. The server's rules are tested in
 * test/mobile-v2-leave.test.ts; this file pins what the screens do with its answers: rows open detail, chips
 * re-query, an outage keeps rows labelled stale, a command runs only after confirmation, a lost answer is retried
 * with the SAME reference, a 4xx is not "uncertain", and a stale detail offers no command.
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
import * as v2leave from '../lib/mobile-api/v2/leave';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function load(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const summary = (over: Record<string, unknown> = {}) => ({ id: ID, leaveType: 'Annual', startDate: '2026-11-02', endDate: '2026-11-04', days: 3, durationType: 'full_day', status: 'approved', displayStatus: 'approved', ...over });
const detail = (over: Record<string, unknown> = {}) => ({ outcome: 'found', request: {
  ...summary(), fromTime: null, toTime: null, appliedOn: '2026-10-01', reason: 'Family trip',
  dates: [{ date: '2026-11-02', status: 'approved', reason: null }, { date: '2026-11-03', status: 'rejected', reason: 'Short staffed' }],
  approvals: [{ level: 1, kindLabel: 'Manager', status: 'approved', names: ['Marcus'], decidedAt: '2026-10-02T02:00:00.000Z' }],
  rejection: null, cancellation: null, pendingCancellation: null, actions: { withdraw: false, cancelDates: ['2026-11-02', '2026-11-04'] }, ...over,
} });

function fixture() {
  let seq = 0;
  const apiGetPage = vi.fn<(...a: any[]) => Promise<any>>(async () => ({ items: [summary()], nextCursor: null }));
  const apiGetV2 = vi.fn<(...a: any[]) => Promise<any>>(async () => detail());
  const apiPostV2 = vi.fn<(...a: any[]) => Promise<any>>();
  const push = vi.fn(), back = vi.fn(), alert = vi.fn(), signOut = vi.fn();
  const View = ({ children }: any) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: any) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert },
    Pressable: (p: any) => <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
    RefreshControl: (p: any) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: any) => <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((item: any) => <div key={p.keyExtractor(item)}>{p.renderItem({ item })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const ui = {InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: any) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: any) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: any) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: any) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtDays: (n: unknown) => (n == null ? '—' : String(n)),
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const base = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', intlLocale: () => 'en-MY', t },
  };
  const api = { apiGetPage, apiGetV2, apiPostV2, v2Page: (path: string) => ({ kind: 'page', path, schema: null }) };
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  const screens = load('mobile/lib/leave-history.tsx', {
    ...base, './api': api, './paged-list': paged, '../../lib/mobile-api/v2/leave': v2leave,
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, back } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
  });
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2]; await act(async () => { buttons[1].onPress(); }); };
  return { ...screens, apiGetPage, apiGetV2, apiPostV2, push, alert, signOut, confirm };
}
afterEach(cleanup);

describe('leave history list', () => {
  it('lists the server’s rows with its display status, opens detail, and a chip re-queries by stored status', async () => {
    const f = fixture();
    f.apiGetPage.mockResolvedValueOnce({ items: [summary(), summary({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayStatus: 'cancellation_pending', leaveType: 'Medical' })], nextCursor: null });
    render(<f.LeaveHistoryScreen />);
    await screen.findByText('leaveStatusCancellationPending');
    expect(f.apiGetPage.mock.calls[0][0]).toMatchObject({ path: 'v2/leave/requests' });
    expect(f.apiGetPage.mock.calls[0][2]).toEqual({ employmentId: 'own' });
    fireEvent.click(screen.getByRole('button', { name: /^Medical/ }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/leave/[id]', params: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });
    fireEvent.click(screen.getByRole('button', { name: 'pending' }));
    await waitFor(() => expect(f.apiGetPage).toHaveBeenCalledTimes(2));
    expect(f.apiGetPage.mock.calls[1][2]).toEqual({ employmentId: 'own', status: 'pending' });
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('offline: rows already shown stay, labelled stale; nothing is queued', async () => {
    const f = fixture();
    render(<f.LeaveHistoryScreen />);
    await screen.findByRole('button', { name: /^Annual/ });
    f.apiGetPage.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('pull'));
    await screen.findByText(/staleData/);
    expect(screen.getByRole('button', { name: /^Annual/ })).toBeTruthy();
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });
});

describe('leave request detail', () => {
  it('renders the server’s per-date outcome and approval lines, and offers only the actions the server allows', async () => {
    const f = fixture();
    render(<f.LeaveDetailScreen id={ID} />);
    await screen.findByText(/^leaveApprovedBy Marcus\|Manager\|/);
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/leave/requests/${ID}`);
    expect(f.apiGetV2.mock.calls[0][2]).toEqual({ employmentId: 'own' });
    expect(screen.getByText('leaveDetailTitle Annual|3')).toBeTruthy();
    expect(screen.getByText('2026-11-03: rejected')).toBeTruthy();
    expect(screen.getByText('Short staffed')).toBeTruthy();
    expect(screen.queryByText('withdrawLeave')).toBeNull();
    expect(screen.getByText('cancelLeaveDates')).not.toBeDisabled();
  });

  it('withdraw runs only after confirmation, then reloads; a lost answer is retried with the SAME reference', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(detail({ status: 'pending', displayStatus: 'pending', actions: { withdraw: true, cancelDates: null } }));
    render(<f.LeaveDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('withdrawLeave'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('leaveCommandUncertain');
    const [path, , body, params] = f.apiPostV2.mock.calls[0];
    expect(path).toBe(`v2/leave/requests/${ID}/withdraw`);
    expect(params).toEqual({ employmentId: 'own' });
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/) });
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'withdrawn', id: ID });
    const reads = f.apiGetV2.mock.calls.length;
    fireEvent.click(screen.getByText('leaveCommandRetry'));
    await screen.findByText('leaveWithdrawnDone');
    expect(f.apiPostV2).toHaveBeenCalledTimes(2);
    expect(f.apiPostV2.mock.calls[1][2]).toEqual(body);
    await waitFor(() => expect(f.apiGetV2.mock.calls.length).toBeGreaterThan(reads));
  });

  it('cancel dates: picks offered dates and a reason, confirms, sends them sorted, and reports pending', async () => {
    const f = fixture();
    render(<f.LeaveDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('cancelLeaveDates'));
    expect(screen.getByText('cancelDatesReview')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-04' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-02' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'cancelReasonOptional' }), { target: { value: '  Plans changed ' } });
    fireEvent.click(screen.getByText('cancelDatesReview'));
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', id: ID, cancellationRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'pending', requestedDays: 2 });
    await f.confirm();
    await screen.findByText('leaveCancelPendingDone');
    const [path, , body] = f.apiPostV2.mock.calls[0];
    expect(path).toBe(`v2/leave/requests/${ID}/cancellation`);
    expect(body).toEqual({ requestId: expect.any(String), cancelDates: ['2026-11-02', '2026-11-04'], reason: 'Plans changed' });
  });

  it('a refusal shows the app’s own sentence for its code; a 4xx is an error, never “uncertain”', async () => {
    const f = fixture();
    render(<f.LeaveDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('cancelLeaveDates'));
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-02' }));
    fireEvent.click(screen.getByText('cancelDatesReview'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'too_close', message: 'Leave on 2026-11-02 is too close to cancel' });
    await f.confirm();
    await screen.findByText('leaveRefusalTooClose');
    fireEvent.click(await screen.findByText('cancelLeaveDates'));
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-02' }));
    fireEvent.click(screen.getByText('cancelDatesReview'));
    f.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400));
    await f.confirm(1);
    await screen.findByText('genericError');
    expect(screen.queryByText('leaveCommandUncertain')).toBeNull();
  });

  it('a stale detail (refresh failed) keeps the record, labelled stale, and offers no command', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce(detail({ status: 'pending', displayStatus: 'pending', actions: { withdraw: true, cancelDates: null } }));
    render(<f.LeaveDetailScreen id={ID} />);
    await screen.findByText('withdrawLeave');
    f.apiGetV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('refresh'));
    await screen.findByText(/staleData/);
    expect(screen.getByText('withdrawLeave')).toBeDisabled();
    expect(screen.getByText('leaveCommandsOnline')).toBeTruthy();
    expect(f.alert).not.toHaveBeenCalled();
  });

  it('not found on this employment shows that, and no action', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'refused', code: 'not_found' });
    render(<f.LeaveDetailScreen id={ID} />);
    await screen.findByText('leaveDetailMissing');
    expect(screen.queryByText('withdrawLeave')).toBeNull();
    expect(screen.queryByText('cancelLeaveDates')).toBeNull();
  });

  it('never builds a path from anything but a request UUID', () => {
    const f = fixture();
    expect(() => f.leaveRequestPath('../me')).toThrow();
    expect(f.leaveRequestPath(ID.toUpperCase(), 'withdraw')).toBe(`v2/leave/requests/${ID}/withdraw`);
  });
});
