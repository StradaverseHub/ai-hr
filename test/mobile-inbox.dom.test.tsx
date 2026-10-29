/**
 * M10 (inbox part) and M14 (Home essentials) — the shipped native inbox and Home "Needs you" card (mobile/lib/inbox.tsx,
 * over the shipped paged list), with only native views, transport, navigation and identity injected. The server's
 * rules are tested in test/mobile-v2-notifications.test.ts; this file pins what the screens do with its answers:
 * unread rows are marked and read rows are not, "Open … ›" appears only for a destination the app knows, a tap marks
 * the row read FIRST and then opens the destination the server re-derived (never the one the row was loaded with), a
 * row that is gone says "no longer available", Mark all read refreshes, paging continues from the server's cursor, and
 * Home never says "nothing needs you" while a count is loading or could not be read.
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
import * as v2notifications from '../lib/mobile-api/v2/notifications';

const ID1 = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222', ID3 = '33333333-3333-4333-8333-333333333333';
type Ports = Record<string, unknown>;
type Loaded = Record<string, any>;
function load(path: string, ports: Ports): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const note = (over: Record<string, unknown> = {}) => ({
  id: ID1, title: 'Leave approved', body: 'Your leave request was approved.', severity: 'info', readAt: null as string | null,
  createdAt: '2026-10-27T01:00:00.000Z', destination: { screen: 'leaveHistory' } as { screen: string } | null, ...over,
});
const pageOf = (items: ReturnType<typeof note>[], over: Record<string, unknown> = {}) =>
  ({ enabled: true, unreadCount: items.filter((i) => i.readAt == null).length, items, nextCursor: null as string | null, ...over });
const summary = (tasks: unknown, inbox: unknown) => ({ tasks, inbox });
const OK0 = summary({ status: 'ok', count: 0 }, { status: 'ok', enabled: true, unreadCount: 0 });

function fixture() {
  const pages: unknown[] = [];
  const summaries: (() => Promise<unknown>)[] = [];
  const apiGetV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async (path) => {
    if (path === 'v2/notifications') return pages.length > 1 ? pages.shift() : pages[0];
    if (path === 'v2/home/summary') return (summaries.length > 1 ? summaries.shift()! : summaries[0] ?? (async () => OK0))();
    throw new Error('Unexpected read ' + String(path));
  });
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const push = vi.fn(), navigate = vi.fn(), signOut = vi.fn();
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text,
    Pressable: (p: { disabled?: boolean; accessibilityRole?: string; accessibilityLabel?: string; onPress?: () => void; children?: React.ReactNode }) =>
      <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.children}</button>,
    RefreshControl: (p: { onRefresh: () => void }) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: { refreshControl: React.ReactNode; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode; data: unknown[]; keyExtractor: (i: unknown) => string; renderItem: (a: { item: unknown }) => React.ReactNode; onEndReached: () => void }) =>
      <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((i) => <div key={p.keyExtractor(i)}>{p.renderItem({ item: i })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}<button onClick={p.onEndReached}>end-reached</button></div>,
  };
  const ui = {InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: { disabled?: boolean; onPress: () => void; title: string }) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>,
    LoadState: (p: { error: Error | null; hasData: boolean; loading: boolean; onRetry: () => void }) => p.error ? <div>{'error:' + p.error.name}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const base: Ports = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', intlLocale: () => 'en-MY', t },
  };
  const api = { apiGetV2, apiPostV2, apiGetPage: vi.fn() };
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  const screens = load('mobile/lib/inbox.tsx', {
    ...base, './api': api, './paged-list': paged, '../../lib/mobile-api/v2/notifications': v2notifications, './attendance-format': load('mobile/lib/attendance-format.ts', base),
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, navigate } },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
  });
  const posted = (n = 0) => apiPostV2.mock.calls[n] as [string, unknown, Record<string, unknown>];
  // Object.assign keeps the loaded module's index signature (an object spread drops it).
  return Object.assign({} as Loaded, screens, { apiGetV2, apiPostV2, push, navigate, signOut, posted, pages, summaries });
}
afterEach(cleanup);

describe('inbox list', () => {
  it('marks unread rows, offers Open only for a known destination, and shows the unread count with Mark all read', async () => {
    const f = fixture();
    f.pages.push(pageOf([note(), note({ id: ID2, title: 'Claim approved', readAt: '2026-10-27T02:00:00.000Z', destination: null }), note({ id: ID3, title: 'Odd', destination: { screen: 'admin' } })]));
    render(<f.InboxScreen />);
    await screen.findByText('Leave approved');
    expect(f.apiGetV2.mock.calls[0][0]).toBe('v2/notifications');
    expect(f.apiGetV2.mock.calls[0][2]).toEqual({});
    expect(screen.getByRole('button', { name: 'inboxUnreadLabel. Leave approved. inboxOpenLeaveHistory' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim approved' })).toBeTruthy();
    // A screen name the app does not know opens nothing and offers nothing.
    expect(screen.getByRole('button', { name: 'inboxUnreadLabel. Odd' })).toBeTruthy();
    expect(screen.getAllByText(/^inboxOpen/)).toHaveLength(1);
    expect(screen.getByText('unreadCount 2 ·')).toBeTruthy();
    expect(screen.getByText('inboxMarkAll')).not.toBeDisabled();
    expect(f.notificationHref({ screen: 'admin' })).toBeNull();
    expect(f.notificationHref({ screen: 'constructor' })).toBeNull();
    expect(f.notificationHref(null)).toBeNull();
    expect(f.notificationHref({ screen: 'pay' })).toBe('/pay');
    // The app's date-time style in the business zone (01:00Z is 09:00 in Kuala Lumpur), never the device's "10/27/2026, 1:00:00 AM".
    expect(screen.getAllByText('27 Oct 2026, 09:00')).toHaveLength(3);
    expect(screen.queryByText(/\d+\/\d+\/\d{4}/)).toBeNull();
  });

  it('a tap marks the row read first, then opens the destination the server re-derived', async () => {
    const f = fixture();
    f.pages.push(pageOf([note()]));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 0, items: [{ id: ID1, destination: { screen: 'leaveHistory' } }] });
    render(<f.InboxScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'inboxUnreadLabel. Leave approved. inboxOpenLeaveHistory' }));
    await waitFor(() => expect(f.push).toHaveBeenCalledWith('/leave/history'));
    const [path, , body] = f.posted();
    expect(path).toBe('v2/notifications/read');
    expect(body).toEqual({ ids: [ID1] });
    expect(f.apiPostV2.mock.invocationCallOrder[0]).toBeLessThan(f.push.mock.invocationCallOrder[0]);
    expect(await screen.findByRole('button', { name: 'Leave approved. inboxOpenLeaveHistory' })).toBeTruthy();
    expect(screen.getByText('unreadCount 0 ·')).toBeTruthy();
    expect(screen.getByText('inboxMarkAll')).toBeDisabled();
  });

  it('follows the fresh destination, not the loaded one', async () => {
    const f = fixture();
    f.pages.push(pageOf([note({ destination: { screen: 'pay' } })]));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 0, items: [{ id: ID1, destination: { screen: 'approvals' } }] });
    render(<f.InboxScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'inboxUnreadLabel. Leave approved. inboxOpenPay' }));
    await waitFor(() => expect(f.push).toHaveBeenCalledTimes(1));
    expect(f.push).toHaveBeenCalledWith('/approvals');
  });

  it('a gone row, or one whose destination no longer applies, says it is no longer available and opens nothing', async () => {
    const f = fixture();
    f.pages.push(pageOf([note(), note({ id: ID2, title: 'Payslip ready', destination: { screen: 'pay' } })]));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 1, items: [] });
    render(<f.InboxScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'inboxUnreadLabel. Leave approved. inboxOpenLeaveHistory' }));
    expect((await screen.findByRole('alert')).textContent).toBe('inboxGone');
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 0, items: [{ id: ID2, destination: null }] });
    fireEvent.click(screen.getByRole('button', { name: 'inboxUnreadLabel. Payslip ready. inboxOpenPay' }));
    await waitFor(() => expect(f.apiPostV2).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('alert')).textContent).toBe('inboxGone');
    expect(f.push).not.toHaveBeenCalled();
  });

  it('a row with no destination is only marked read; a refused or failed command says so and opens nothing', async () => {
    const f = fixture();
    f.pages.push(pageOf([note({ destination: null })]));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 0, items: [{ id: ID1, destination: null }] });
    render(<f.InboxScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'inboxUnreadLabel. Leave approved' }));
    expect(await screen.findByRole('button', { name: 'Leave approved' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    fireEvent.click(screen.getByRole('button', { name: 'Leave approved' }));
    expect((await screen.findByRole('alert')).textContent).toBe('inboxActionFailed');
    f.apiPostV2.mockRejectedValueOnce(new errors.SignInRequiredError());
    fireEvent.click(screen.getByRole('button', { name: 'Leave approved' }));
    await waitFor(() => expect(f.signOut).toHaveBeenCalledTimes(1));
    expect(f.push).not.toHaveBeenCalled();
  });

  it('Mark all read sends {all: true}, marks the shown rows and reloads the list', async () => {
    const f = fixture();
    f.pages.push(pageOf([note(), note({ id: ID2, title: 'Second' })]), pageOf([note({ readAt: '2026-10-27T03:00:00.000Z' }), note({ id: ID2, title: 'Second', readAt: '2026-10-27T03:00:00.000Z' })]));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'read', unreadCount: 0, items: [] });
    render(<f.InboxScreen />);
    await screen.findByText('unreadCount 2 ·');
    await act(async () => { fireEvent.click(screen.getByText('inboxMarkAll')); });
    expect(f.posted()[2]).toEqual({ all: true });
    await waitFor(() => expect(f.apiGetV2.mock.calls.filter((c: unknown[]) => c[0] === 'v2/notifications')).toHaveLength(2));
    expect(await screen.findByRole('button', { name: 'Second. inboxOpenLeaveHistory' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /inboxUnreadLabel/ })).toBeNull();
    expect(screen.getByText('unreadCount 0 ·')).toBeTruthy();
    expect(f.push).not.toHaveBeenCalled();
  });

  it('pages on from the server cursor without repeating rows', async () => {
    const f = fixture();
    f.pages.push(pageOf([note()], { nextCursor: 'c1' }), pageOf([note(), note({ id: ID2, title: 'Older' })], { unreadCount: 2 }));
    render(<f.InboxScreen />);
    await screen.findByText('Leave approved');
    fireEvent.click(screen.getByText('end-reached'));
    await screen.findByText('Older');
    expect(f.apiGetV2.mock.calls[1][2]).toEqual({ cursor: 'c1' });
    expect(screen.getAllByText('Leave approved')).toHaveLength(1);
    expect(screen.getByText('unreadCount 2 ·')).toBeTruthy();
  });

  it('says notifications are off instead of offering Mark all read', async () => {
    const f = fixture();
    f.pages.push({ enabled: false, unreadCount: 0, items: [], nextCursor: null });
    render(<f.InboxScreen />);
    await screen.findByText('notificationsOff');
    expect(screen.queryByText('inboxMarkAll')).toBeNull();
  });
});

describe('Home "Needs you"', () => {
  it('derives all clear only from two successful, settled, zero counts', () => {
    const f = fixture();
    const ok = (tasks: unknown, inbox: unknown, extra: Record<string, unknown> = {}) => f.homeNeedsView({ data: summary(tasks, inbox), error: null, loading: false, ...extra });
    expect(f.homeNeedsView({ data: null, error: null, loading: true })).toEqual({ tasks: 'loading', inbox: 'loading', allClear: false });
    expect(f.homeNeedsView({ data: null, error: new Error('x'), loading: false })).toEqual({ tasks: 'failed', inbox: 'failed', allClear: false });
    expect(ok({ status: 'ok', count: 0 }, { status: 'ok', enabled: true, unreadCount: 0 }).allClear).toBe(true);
    expect(ok({ status: 'ok', count: 0 }, { status: 'ok', enabled: false, unreadCount: 0 })).toEqual({ tasks: 0, inbox: 'off', allClear: true });
    expect(ok({ status: 'ok', count: 0 }, { status: 'ok', enabled: true, unreadCount: 0 }, { loading: true }).allClear, 'a refresh in flight').toBe(false);
    expect(ok({ status: 'unavailable' }, { status: 'ok', enabled: true, unreadCount: 0 })).toEqual({ tasks: 'failed', inbox: 0, allClear: false });
    expect(ok({ status: 'ok', count: 0 }, { status: 'unavailable' })).toEqual({ tasks: 0, inbox: 'failed', allClear: false });
    expect(ok({ status: 'ok', count: 2 }, { status: 'ok', enabled: true, unreadCount: 0 }).allClear).toBe(false);
  });

  it('shows loading, then "Couldn\'t check — retry" on failure, and all clear only after a successful retry', async () => {
    const f = fixture();
    let fail: (e: Error) => void = () => {};
    f.summaries.push(() => new Promise((_, reject) => { fail = reject; }), async () => OK0);
    render(<f.HomeNeeds />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByText('nothingNeedsYou')).toBeNull();
    await act(async () => { fail(new errors.UnavailableError()); });
    expect(await screen.findByText('homeCheckFailed')).toBeTruthy();
    expect(screen.queryByText('nothingNeedsYou')).toBeNull();
    fireEvent.click(screen.getByText('homeCheckFailed'));
    expect(await screen.findByText('nothingNeedsYou')).toBeTruthy();
    expect(f.apiGetV2.mock.calls.filter((c: unknown[]) => c[0] === 'v2/home/summary')).toHaveLength(2);
    expect(screen.queryByText('openApprovals')).toBeNull();
  });

  it('a part that could not be checked is said so, never all clear; the task count links to approvals', async () => {
    const f = fixture();
    f.summaries.push(async () => summary({ status: 'unavailable' }, { status: 'ok', enabled: true, unreadCount: 0 }));
    const { unmount } = render(<f.HomeNeeds />);
    expect(await screen.findByText('homeCheckFailed')).toBeTruthy();
    expect(screen.queryByText('nothingNeedsYou')).toBeNull();
    expect(screen.getByText('openApprovals')).toBeTruthy();
    unmount();

    const g = fixture();
    g.summaries.push(async () => summary({ status: 'ok', count: 3 }, { status: 'ok', enabled: true, unreadCount: 4 }));
    render(<g.HomeNeeds />);
    // Two tappable rows (declutter round): the approvals count opens Approvals, the unread count opens the Inbox.
    fireEvent.click(await screen.findByRole('button', { name: 'approvalsTitle, homeTasksCount 3' }));
    expect(g.push).toHaveBeenCalledWith('/approvals');
    fireEvent.click(screen.getByRole('button', { name: 'tabInbox, unreadCount 4' }));
    expect(g.navigate).toHaveBeenCalledWith('/inbox');
    expect(screen.queryByText('nothingNeedsYou')).toBeNull();
    expect(screen.queryByText('openApprovals')).toBeNull();
  });

  it('signs out on a 401 and shows nothing of an old answer', async () => {
    const f = fixture();
    f.summaries.push(async () => { throw new errors.SignInRequiredError(); });
    render(<f.HomeNeeds />);
    await waitFor(() => expect(f.signOut).toHaveBeenCalled());
    expect(screen.queryByText('nothingNeedsYou')).toBeNull();
  });
});
