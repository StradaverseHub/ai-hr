/**
 * M10 (D6) push and D8 shift reminders — the shipped native modules (mobile/lib/push-core.ts, mobile/lib/push.tsx and
 * the session's sign-out), with only native views, the OS notification module, secure storage, transport and identity
 * injected. The server's rules are tested in test/mobile-v2-push.test.ts and the plan in test/mobile-shift-reminders.test.ts.
 *
 * Pinned: permission is never asked at launch, only from "Turn on notifications" (Inbox) or "Allow notifications" (Me);
 * a granted permission enrolls THIS installation's token for the selected employment's session; denied says so and
 * offers the phone's settings; "Turn off" stores the phone's choice and revokes; a refused module hides the control;
 * reminders are on by default and scheduled from the roster with generic text on the private reminder channel, only
 * this app's reminders are ever cancelled, the switch turns them off and the permission state is said honestly; a tap
 * opens only what the server's read command answers (or the Inbox), once, and a malformed push opens the Inbox without
 * a request; leaving the account revokes and cancels within its time budget; the session revokes BEFORE it clears tokens.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errors from '../mobile/lib/errors';
import { createSessionState } from '../mobile/lib/session-state';
import * as v2push from '../lib/mobile-api/v2/push';
import * as v2attendance from '../lib/mobile-api/v2/attendance';
import * as v2notifications from '../lib/mobile-api/v2/notifications';

type Loaded = Record<string, any>;
function load(path: string, ports: Record<string, unknown>): Loaded {
  const module = { exports: {} as Loaded };
  // ES2022, not transpileModule's ES5 default: ES5 spreads a Set (`[...listeners]` in push-core's stores) into an EMPTY
  // array, so no screen was ever told a store changed. Metro/Hermes compile the spread correctly; only this harness did not.
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Error, Intl,
      // Resolved at call time, so a test's fake timers reach the module too.
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms), clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
      require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const INSTALL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', NOTE = '11111111-2222-4333-8444-555555555555', TOKEN = 'ab'.repeat(32);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function notificationsFake(initial: 'granted' | 'denied' | 'undetermined', grant: 'granted' | 'denied' = 'granted') {
  let permission = initial;
  const scheduled = new Map<string, Record<string, any>>([['other-app-local', { identifier: 'other-app-local' }]]);
  const listeners: Record<string, ((value: any) => void)[]> = { token: [], received: [], response: [] };
  const sub = (kind: string) => (fn: (value: any) => void) => { listeners[kind].push(fn); return { remove: () => { listeners[kind] = listeners[kind].filter((f) => f !== fn); } }; };
  const status = () => ({ status: permission, granted: permission === 'granted', canAskAgain: permission !== 'denied', expires: 'never', ios: { status: permission === 'granted' ? 2 : permission === 'denied' ? 1 : 0 } });
  return {
    scheduled, listeners, setPermission: (p: typeof permission) => { permission = p; },
    IosAuthorizationStatus: { PROVISIONAL: 3 }, AndroidImportance: { DEFAULT: 5, HIGH: 6 }, AndroidNotificationVisibility: { PRIVATE: 2 }, SchedulableTriggerInputTypes: { DATE: 'date' },
    getPermissionsAsync: vi.fn(async () => status()),
    requestPermissionsAsync: vi.fn(async () => { permission = grant; return status(); }),
    setNotificationChannelAsync: vi.fn(async () => null),
    getDevicePushTokenAsync: vi.fn(async () => ({ type: 'ios', data: TOKEN })),
    getAllScheduledNotificationsAsync: vi.fn(async () => [...scheduled.values()].map((r) => ({ identifier: r.identifier }))),
    cancelScheduledNotificationAsync: vi.fn(async (id: string) => { scheduled.delete(id); }),
    scheduleNotificationAsync: vi.fn(async (r: Record<string, any>) => { scheduled.set(r.identifier, r); return r.identifier; }),
    setNotificationHandler: vi.fn(),
    addPushTokenListener: vi.fn(sub('token')),
    addNotificationReceivedListener: vi.fn(sub('received')),
    addNotificationResponseReceivedListener: vi.fn(sub('response')),
    getLastNotificationResponse: vi.fn(() => null),
    clearLastNotificationResponse: vi.fn(),
  };
}

function fixture(o: { permission?: 'granted' | 'denied' | 'undetermined'; grant?: 'granted' | 'denied'; stored?: Record<string, string>; delivery?: 'available' | 'unavailable'; enrollmentRefusal?: string; status?: string } = {}) {
  const Notifications = notificationsFake(o.permission ?? 'undetermined', o.grant);
  const stored = new Map(Object.entries(o.stored ?? {}));
  const SecureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    getItemAsync: vi.fn(async (k: string) => stored.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { stored.set(k, v); }),
  };
  const today = isoDay(Date.now());
  const day = (n: number) => isoDay(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000);
  const rosterDays = [1, 2].map((n) => ({ date: day(n), kind: 'shift', shift: { code: 'M', name: 'Morning', start: '09:00', end: '18:00', crossesMidnight: false, workingMinutes: 480 }, plannedMinutes: 480, note: null }));
  const apiGetV2 = vi.fn(async (path: string, _schema?: unknown, _query?: Record<string, unknown>) => {
    if (path === 'v2/attendance/roster') return { enabled: true, employmentId: 'own-emp', timeZone: 'Asia/Kuala_Lumpur', from: day(-2), to: day(8), days: rosterDays, totals: { workDays: 2, rosteredDays: 2, restDays: 0, plannedMinutes: 960 } };
    if (path === 'v2/attendance/records') return { enabled: true, employmentId: 'own-emp', timeZone: 'Asia/Kuala_Lumpur', today, from: day(-2), to: day(8), days: [] };
    throw new Error('Unexpected read ' + path);
  });
  const apiPostV2 = vi.fn(async (path: string, _schema: unknown, _body: Record<string, unknown>) => {
    if (path === 'v2/push/enrollment') return o.enrollmentRefusal ? { outcome: 'refused', code: o.enrollmentRefusal } : { outcome: 'registered', platform: 'ios', provider: 'apns', change: 'created', delivery: o.delivery ?? 'available' };
    if (path === 'v2/push/revoke') return { outcome: 'revoked', revoked: true };
    if (path === 'v2/notifications/read') return { outcome: 'read', unreadCount: 0, items: [{ id: NOTE, destination: { screen: 'leaveHistory' } }] };
    throw new Error('Unexpected command ' + path);
  });
  const push = vi.fn(), openSettings = vi.fn(async () => undefined), signOut = vi.fn(async () => undefined);
  const session = { employmentId: 'own-emp', signOut, status: o.status ?? 'signedIn' };
  const installation = vi.fn(async (check: () => void) => { check(); return INSTALL; });
  const t = (k: string) => k;
  const core = load('mobile/lib/push-core.ts', {
    'react-native': { Platform: { OS: 'ios' }, Linking: { openSettings } }, 'expo-notifications': Notifications, 'expo-secure-store': SecureStore,
    'expo-constants': { __esModule: true, default: { expoConfig: { version: '1.0.3' } } }, 'expo-crypto': { randomUUID: () => crypto.randomUUID() },
    './api': { apiGetV2, apiPostV2 }, './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' }, './errors': errors, './i18n': { appLocale: () => 'en', t },
    './submission-native': { nativeIntegrityInstallationId: installation },
    './shift-reminders': load('mobile/lib/shift-reminders.ts', {}),
    '../../lib/mobile-api/v2/push': v2push, '../../lib/mobile-api/v2/attendance': v2attendance,
  });
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  const ui = {InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: { title: string; onPress: () => void; disabled?: boolean }) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, SectionLabel: Text,
  };
  const Switch = (p: { value: boolean; disabled?: boolean; accessibilityLabel?: string; onValueChange: (v: boolean) => void }) =>
    <input type="checkbox" role="switch" aria-label={p.accessibilityLabel} checked={p.value} disabled={p.disabled} onChange={(e) => p.onValueChange(e.target.checked)} />;
  const screens = load('mobile/lib/push.tsx', {
    react: React, 'react/jsx-runtime': jsx, 'react-native': { AppState: { addEventListener: () => ({ remove() {} }) }, Switch, View, Pressable: (p: { accessibilityLabel?: string; disabled?: boolean; onPress?: () => void; children?: React.ReactNode }) => <button aria-label={p.accessibilityLabel} disabled={p.disabled} onClick={p.onPress}>{p.children}</button> },
    'expo-notifications': Notifications, 'expo-router': { router: { push } }, './api': { apiPostV2 },
    './design': { DesignText: Text, useTenantDesign: () => ({ palette: { text: 'black' } }) }, './errors': errors, './i18n': { t },
    './inbox': { notificationHref: (d: { screen?: string } | null | undefined) => (d?.screen === 'leaveHistory' ? '/leave/history' : null) },
    './push-core': core, './session': { useSession: () => session }, './shift-reminder-signal': load('mobile/lib/shift-reminder-signal.ts', {}),
    './shift-reminders': load('mobile/lib/shift-reminders.ts', {}), './ui': ui, '../../lib/mobile-api/v2/notifications': v2notifications,
  });
  const posted = (path: string) => apiPostV2.mock.calls.filter((c) => c[0] === path) as unknown as [string, unknown, Record<string, any>, Record<string, string>][];
  const ours = () => [...Notifications.scheduled.keys()].filter((k) => k.startsWith('aihr-shift:')).sort();
  // Object.assign keeps the loaded module's index signature (an object spread drops it).
  return Object.assign({} as Loaded, screens, { core, Notifications, SecureStore, stored, apiGetV2, apiPostV2, posted, push, openSettings, signOut, installation, ours, day });
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('push on the Inbox', () => {
  it('never asks at launch; "Turn on notifications" asks, then enrolls this installation for the selected employment', async () => {
    const f = fixture({ permission: 'undetermined' });
    render(<><f.PushLifecycle /><f.PushPrompt /></>);
    await screen.findByText('pushOffBody');
    expect(f.Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(f.posted('v2/push/enrollment')).toHaveLength(0);
    fireEvent.click(screen.getByText('pushTurnOn'));
    await screen.findByText('pushOnBody');
    expect(f.Notifications.requestPermissionsAsync).toHaveBeenCalledOnce();
    const [[, , body, params]] = f.posted('v2/push/enrollment');
    expect(body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), installationId: INSTALL, platform: 'ios', token: TOKEN, permission: 'granted', locale: 'en', appVersion: '1.0.3' });
    expect(params).toEqual({ employmentId: 'own-emp' });
    expect(f.installation).toHaveBeenCalled();
  });

  it('a denied permission says so, offers the settings and enrolls nothing', async () => {
    const f = fixture({ permission: 'denied' });
    render(<><f.PushLifecycle /><f.PushPrompt /></>);
    fireEvent.click(await screen.findByText('pushOpenSettings'));
    expect(screen.getByText('pushDeniedBody')).toBeTruthy();
    expect(f.openSettings).toHaveBeenCalledOnce();
    expect(f.posted('v2/push/enrollment')).toHaveLength(0);
    // Refusing the OS prompt after "Turn on" lands in the same honest state.
    const g = fixture({ permission: 'undetermined', grant: 'denied' });
    cleanup();
    render(<><g.PushLifecycle /><g.PushPrompt /></>);
    fireEvent.click(await screen.findByText('pushTurnOn'));
    await screen.findByText('pushDeniedBody');
    expect(g.posted('v2/push/enrollment')).toHaveLength(0);
  });

  it('enrolls on its own once permission exists; "Turn off" is remembered on this phone and revoked', async () => {
    const f = fixture({ permission: 'granted' });
    render(<><f.PushLifecycle /><f.PushPrompt /></>);
    await screen.findByText('pushOnBody');
    expect(f.posted('v2/push/enrollment')).toHaveLength(1);
    fireEvent.click(screen.getByText('pushTurnOff'));
    await screen.findByText('pushOffBody');
    await waitFor(() => expect(f.posted('v2/push/revoke')).toHaveLength(1));
    expect(f.posted('v2/push/revoke')[0][2]).toEqual({ requestId: expect.any(String), installationId: INSTALL, reason: 'turned_off' });
    expect(f.stored.get('aihr.push.optOut')).toBe('1');
    // The phone's choice holds: a later sync enrolls nothing.
    await f.core.syncPush('own-emp', true);
    expect(f.posted('v2/push/enrollment')).toHaveLength(1);
  });

  it('says plainly when the server sends no pushes yet, and shows nothing when the company has notifications off', async () => {
    const f = fixture({ permission: 'granted', delivery: 'unavailable' });
    render(<><f.PushLifecycle /><f.PushPrompt /></>);
    await screen.findByText('pushServerOffBody');
    cleanup();
    const g = fixture({ permission: 'granted', enrollmentRefusal: 'notifications_off' });
    const { container } = render(<><g.PushLifecycle /><g.PushPrompt /></>);
    await waitFor(() => expect(g.posted('v2/push/enrollment')).toHaveLength(1));
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('opening a notification', () => {
  const response = (identifier: string, data: Record<string, unknown> | null, date = 1) => ({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { date, request: { identifier, content: { data } } } });
  it('resolves the id through the read command and opens only the screen the server names, once', async () => {
    const f = fixture({ permission: 'granted' });
    f.respondToNotification(response('remote-1', { notificationId: NOTE.toUpperCase() }));
    await waitFor(() => expect(f.push).toHaveBeenCalledWith('/leave/history'));
    expect(f.posted('v2/notifications/read').map((c) => c[2])).toEqual([{ ids: [NOTE] }]);
    f.respondToNotification(response('remote-1', { notificationId: NOTE }));
    await new Promise((r) => setTimeout(r, 5));
    expect(f.posted('v2/notifications/read')).toHaveLength(1);
    expect(f.Notifications.clearLastNotificationResponse).toHaveBeenCalled();
  });
  it('a malformed or steering push opens the Inbox with no request; a reminder opens the Clock', async () => {
    const f = fixture({ permission: 'granted' });
    f.respondToNotification(response('remote-2', { notificationId: 'javascript:alert(1)', url: 'https://evil.example', screen: 'admin' }));
    await waitFor(() => expect(f.push).toHaveBeenCalledWith('/inbox'));
    f.respondToNotification(response('remote-3', null));
    f.respondToNotification(response('aihr-shift:start:2026-11-03', { aihrReminder: 'start' }));
    await waitFor(() => expect(f.push).toHaveBeenCalledWith('/clock'));
    expect(f.posted('v2/notifications/read')).toHaveLength(0);
  });
});

describe('shift reminders on Me', () => {
  it('are on by default and scheduled from the roster with generic text on the private channel', async () => {
    const f = fixture({ permission: 'granted' });
    render(<><f.PushLifecycle /><f.ShiftReminderSetting /></>);
    await waitFor(() => expect(f.ours()).toHaveLength(4));
    expect(f.ours()).toEqual([`aihr-shift:forgotOut:${f.day(1)}`, `aihr-shift:forgotOut:${f.day(2)}`, `aihr-shift:start:${f.day(1)}`, `aihr-shift:start:${f.day(2)}`]);
    const start = f.Notifications.scheduled.get(`aihr-shift:start:${f.day(1)}`)!;
    expect(start.content).toEqual({ title: 'reminderTitle', body: 'reminderStartBody', data: { aihrReminder: 'start' }, sound: true });
    expect(start.trigger).toEqual({ type: 'date', date: Date.parse(`${f.day(1)}T00:45:00Z`), channelId: 'aihr-reminders' });
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
    expect(f.Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    // The roster window is read for the selected employment.
    expect(f.apiGetV2.mock.calls.find((c) => c[0] === 'v2/attendance/roster')?.[2]).toMatchObject({ employmentId: 'own-emp' });
  });

  it('the switch turns them off on this phone and cancels only this app’s reminders', async () => {
    const f = fixture({ permission: 'granted' });
    render(<><f.PushLifecycle /><f.ShiftReminderSetting /></>);
    await waitFor(() => expect(f.ours()).toHaveLength(4));
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText('reminderStateOff');
    await waitFor(() => expect(f.ours()).toEqual([]));
    expect(f.Notifications.scheduled.has('other-app-local')).toBe(true);
    expect(f.stored.get('aihr.reminders.enabled')).toBe('0');
  });

  it('without permission they say so and "Allow notifications" asks; denied points to the settings', async () => {
    const f = fixture({ permission: 'undetermined' });
    render(<><f.PushLifecycle /><f.ShiftReminderSetting /></>);
    await screen.findByText('reminderStateBlocked');
    expect(f.ours()).toEqual([]);
    // Blocked reminders are not shown as ON.
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText('reminderAllowShort'));
    await waitFor(() => expect(f.ours()).toHaveLength(4));
    expect(f.Notifications.requestPermissionsAsync).toHaveBeenCalledOnce();
    cleanup();
    const g = fixture({ permission: 'denied' });
    render(<><g.PushLifecycle /><g.ShiftReminderSetting /></>);
    await screen.findByText('reminderStateBlocked');
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText('reminderAllowShort'));
    expect(g.openSettings).toHaveBeenCalledTimes(1);
    // The full sentence stays one tap away, behind the info control.
    fireEvent.click(screen.getByRole('button', { name: 'moreInfo' }));
    expect(screen.getByText('reminderDenied reminderExplain')).toBeTruthy();
    // Turning the switch on while denied opens Settings; it does not pretend to turn anything on.
    fireEvent.click(screen.getByRole('switch'));
    expect(g.openSettings).toHaveBeenCalledTimes(2);
    expect(g.stored.get('aihr.reminders.enabled')).not.toBe('0');
  });

  it('turning the switch on while permission is not yet asked asks for it, and shows ON once granted', async () => {
    const f = fixture({ permission: 'undetermined' });
    render(<><f.PushLifecycle /><f.ShiftReminderSetting /></>);
    await screen.findByText('reminderStateBlocked');
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(f.ours()).toHaveLength(4));
    expect(f.Notifications.requestPermissionsAsync).toHaveBeenCalledOnce();
    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true));
  });

  it('a stored "off" is honoured from the start', async () => {
    const f = fixture({ permission: 'granted', stored: { 'aihr.reminders.enabled': '0' } });
    render(<><f.PushLifecycle /><f.ShiftReminderSetting /></>);
    await screen.findByText('reminderStateOff');
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect(f.Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('any sign-out removes them', async () => {
    const f = fixture({ permission: 'granted', status: 'signedOut' });
    f.Notifications.scheduled.set('aihr-shift:start:x', { identifier: 'aihr-shift:start:x' });
    render(<f.PushSessionWatcher />);
    await waitFor(() => expect(f.ours()).toEqual([]));
    expect(f.Notifications.scheduled.has('other-app-local')).toBe(true);
  });
});

describe('leaving the account', () => {
  it('revokes with the exit reason and cancels reminders, and never waits past its budget', async () => {
    const f = fixture({ permission: 'granted' });
    f.Notifications.scheduled.set('aihr-shift:start:x', { identifier: 'aihr-shift:start:x' });
    await f.core.releasePushOnExit('company', 'own-emp');
    expect(f.posted('v2/push/revoke').map((c) => c[2].reason)).toEqual(['company_switch']);
    expect(f.ours()).toEqual([]);
    vi.useFakeTimers();
    f.apiPostV2.mockImplementation(() => new Promise<never>(() => {}));
    let done = false;
    const exit = f.core.releasePushOnExit('logout', 'own-emp').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(f.core.EXIT_BUDGET_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await exit;
    expect(done).toBe(true);
  });

  it('the session revokes BEFORE it clears the tokens', async () => {
    const order: string[] = [];
    const release = vi.fn(async (..._args: unknown[]) => { order.push('release'); });
    const clearTokens = vi.fn(async () => { order.push('clear'); });
    const exports = load('mobile/lib/session.tsx', {
      react: React, 'react/jsx-runtime': jsx,
      'expo-local-authentication': { getEnrolledLevelAsync: async () => 1, SecurityLevel: { SECRET: 1 }, authenticateAsync: async () => ({ success: true }) },
      'expo-screen-capture': { preventScreenCaptureAsync: async () => undefined, enableAppSwitcherProtectionAsync: async () => undefined },
      'expo-web-browser': { openAuthSessionAsync: vi.fn() },
      'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
      './session-state': { createSessionState }, './i18n': { t: (k: string) => k },
      './auth': { hasStoredSession: async () => true, signOut: clearTokens, assertAuthGeneration() {}, workosLogoutUrl: () => null, redirectUri: () => 'aihr://auth/callback' },
      './protected-document': { sweepProtectedDocuments: () => {} }, './push-core': { releasePushOnExit: release },
    });
    const probe: { current?: { status: string; signOut: () => Promise<void>; setEmploymentId: (id: string | null) => void } } = {};
    function Probe() { probe.current = exports.useSession(); return <div>{probe.current!.status}</div>; }
    render(<exports.SessionProvider><Probe /></exports.SessionProvider>);
    await screen.findByText('signedIn');
    act(() => probe.current!.setEmploymentId('employment-b'));
    await act(async () => { await probe.current!.signOut(); });
    expect(release).toHaveBeenCalledWith('logout', 'employment-b');
    expect(order).toEqual(['release', 'clear']);
  });
});
