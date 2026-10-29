/**
 * Mobile WOW round — the shipped files with only native views, transport and identity injected:
 *  - session.tsx: coming back to the foreground re-attaches screenshot protection (a fresh tag) BEFORE the single
 *    automatic biometric prompt of that lock; a cancelled prompt is not raised again; unlocking re-arms it; and while
 *    protection cannot be attached, private screens stay closed (unlock's own protectScreen must succeed).
 *  - ot-plan.tsx: one confirmed command under a client requestId; a lost answer retries the SAME requestId; the
 *    server's refusal is shown; the server's minutes are what the success screen reports.
 *  - directory.tsx: `enabled: false` shows the not-available line; search is sent trimmed after typing settles.
 *  - team-calendar.tsx and home-hero.tsx helpers: Monday-first month grid, month stepping, Kuala Lumpur greeting.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionState } from '../mobile/lib/session-state';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';

const stub: any = new Proxy(function () { return null; }, { get: (_t, k) => (k === '__esModule' ? false : stub), apply: () => null });
function load(path: string, ports: Record<string, unknown>, strict = true) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date, Error, Math, Number, String, Array, Object, JSON, setTimeout, clearTimeout, Promise, Map, Set, queueMicrotask,
      require: (id: string) => { if (id in ports) return ports[id]; if (!strict) return stub; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ── Session: foreground protection and the automatic biometric prompt ─────────────────────────────────────

function sessionFixture(opts: { authenticate?: () => Promise<{ success: boolean }>; preventFails?: boolean } = {}) {
  const local = { getEnrolledLevelAsync: vi.fn(async () => 3), SecurityLevel: { SECRET: 1 },
    authenticateAsync: vi.fn(opts.authenticate ?? (async () => ({ success: true }))) };
  const capture = { preventScreenCaptureAsync: vi.fn(async (_tag?: string) => { if (opts.preventFails) throw new Error('no window'); }), enableAppSwitcherProtectionAsync: vi.fn(async () => undefined) };
  let appState: ((v: string) => void) | null = null;
  const output = { exports: {} as any };
  const code = transpileModule(readFileSync('mobile/lib/session.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, require: (id: string) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === 'expo-local-authentication') return local;
    if (id === 'expo-screen-capture') return capture;
    if (id === 'expo-web-browser') return { openAuthSessionAsync: vi.fn() };
    if (id === 'react-native') return { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: (ev: string, fn: (v: string) => void) => { if (ev === 'change') appState = fn; return { remove() {} }; } } };
    if (id === './session-state') return { createSessionState };
    if (id === './protected-document') return { sweepProtectedDocuments: () => {} };
    if (id === './push-core') return { releasePushOnExit: async () => undefined };
    if (id === './i18n') return { t: (key: string) => key };
    if (id === './auth') return { hasStoredSession: async () => true, signOut: async () => undefined, assertAuthGeneration() {}, workosLogoutUrl: () => null, redirectUri: () => 'aihr://auth/callback' };
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  function Probe() { const s = output.exports.useSession(); return <div>{s.status === 'signedIn' && s.visible ? 'Private screen' : s.status}</div>; }
  const go = async (v: string) => { await act(async () => { appState!(v); await new Promise((r) => setTimeout(r, 0)); }); };
  return { local, capture, go, View: () => <output.exports.SessionProvider><Probe /></output.exports.SessionProvider> };
}

describe('app lock on return to the foreground', () => {
  it('re-attaches screenshot protection with a fresh tag, then prompts biometrics once per lock', async () => {
    const f = sessionFixture(); render(<f.View />);
    await screen.findByText('Private screen');
    expect(f.local.authenticateAsync).toHaveBeenCalledTimes(1); // launch
    expect(f.capture.preventScreenCaptureAsync.mock.calls.map((c) => c[0])).toEqual(['aihr-session']);
    await f.go('background'); await f.go('active');
    await screen.findByText('Private screen');
    expect(f.capture.preventScreenCaptureAsync.mock.calls.map((c) => c[0])).toEqual(['aihr-session', 'aihr-session-1']);
    expect(f.local.authenticateAsync).toHaveBeenCalledTimes(2);
    // Re-armed by the unlock: the next lock prompts again, under another fresh tag.
    await f.go('background'); await f.go('active');
    await screen.findByText('Private screen');
    expect(f.local.authenticateAsync).toHaveBeenCalledTimes(3);
    expect(f.capture.preventScreenCaptureAsync.mock.calls.at(-1)![0]).toBe('aihr-session-2');
  });
  it('never raises a cancelled prompt again by itself', async () => {
    let pass = true;
    const f = sessionFixture({ authenticate: async () => ({ success: pass }) }); render(<f.View />);
    await screen.findByText('Private screen');
    pass = false;
    await f.go('background'); await f.go('active');
    await screen.findByText('locked');
    expect(f.local.authenticateAsync).toHaveBeenCalledTimes(2);
    await f.go('inactive'); await f.go('active'); await f.go('inactive'); await f.go('active');
    expect(f.local.authenticateAsync).toHaveBeenCalledTimes(2);
    expect(screen.getByText('locked')).toBeInTheDocument();
  });
  it('keeps private screens closed on return to the foreground while screenshot protection cannot be attached', async () => {
    const f = sessionFixture({ preventFails: true }); render(<f.View />);
    await screen.findByText('locked');
    await f.go('background'); await f.go('active');
    expect(f.local.authenticateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText('Private screen')).not.toBeInTheDocument();
  });
});

// ── Overtime plan ─────────────────────────────────────────────────────────────────────────────────────────

function otFixture(post: (body: any) => Promise<any>) {
  const alerts: { buttons: { text: string; onPress?: () => void }[] }[] = [];
  const apiPostV2 = vi.fn((_p: string, _s: unknown, body: any, _params?: Record<string, string>) => post(body));
  class RequestRejectedError extends Error {}
  class SignInRequiredError extends Error {}
  const Text = ({ children }: any) => <span>{children}</span>;
  const View = ({ children }: any) => <div>{children}</div>;
  let uuid = 0;
  const offer = { enabled: true, employmentId: 'e1', allowed: true, reason: null, timeZone: 'Asia/Kuala_Lumpur', today: '2026-10-29' };
  const day = { outcome: 'found', timeZone: 'Asia/Kuala_Lumpur', today: '2026-10-29', day: { schedule: { shiftCode: 'A', start: '09:00', end: '18:00', crossesMidnight: false } } };
  const { OvertimePlanScreen } = load('mobile/lib/ot-plan.tsx', {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
      Alert: { alert: (_t: string, _m: string, buttons: any) => alerts.push({ buttons }) } },
    'expo-router': { router: { replace: vi.fn() } }, 'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-00000000000${++uuid}` },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'light') }) },
    './api': { apiPostV2, useApiV2: (path: string) => ({ data: path.endsWith('/offer') ? offer : day, error: null, loading: false, reload: vi.fn() }) },
    './auth': { assertAuthGeneration() {}, authGeneration: () => 1 },
    './errors': { RequestRejectedError, SignInRequiredError },
    './i18n': { t: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k) },
    './leave-request-form': { PickerField: (p: any) => <button onClick={() => p.onChange(p.mode === 'date' ? '2026-11-02' : p.label === 'otStart' ? '18:00' : '20:30')}>{p.label}</button> },
    './session': { useSession: () => ({ signOut: vi.fn(), employmentId: 'e1' }) },
    './attendance-format': { fmtCalendarDate: (d: string) => d, fmtMinutes: (m: number) => `${m}min` },
    './attendance-records': { TimeZoneNote: () => null, scheduleText: (s: any) => `${s.shiftCode} ${s.start}-${s.end}` },
    './attendance-applications': { attendanceRefusalText: (r: any) => `refused:${r.code}` },
    './icon': { Icon: () => null }, './home-hero': { tint: (c: string) => c },
    './ui': { Button: (p: any) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>, Card: View, LoadState: () => null, Muted: Text, Screen: View, Title: Text },
    '../../lib/mobile-api/v2/attendance': { AttendanceDayResult: {}, OvertimePlanOfferV2: {}, OvertimePlanResult: {} },
  });
  const fill = () => {
    fireEvent.click(screen.getByText('otDate'));
    fireEvent.click(screen.getByText('otStart')); fireEvent.click(screen.getByText('otEnd'));
    fireEvent.change(screen.getByLabelText('attReasonRequired'), { target: { value: '  Month-end close  ' } });
  };
  const confirm = async () => { await act(async () => { alerts.at(-1)!.buttons[1]!.onPress!(); await new Promise((r) => setTimeout(r, 0)); }); };
  return { OvertimePlanScreen, apiPostV2, alerts, fill, confirm, RequestRejectedError };
}

describe('plan overtime', () => {
  it('shows the roster for the chosen day and sends one confirmed plan with the server’s minutes on success', async () => {
    const f = otFixture(async (b) => ({ outcome: 'submitted', id: '11111111-1111-4111-8111-111111111111', date: b.date, minutes: 150 }));
    render(<f.OvertimePlanScreen />);
    f.fill();
    expect(screen.getByText('A 09:00-18:00')).toBeInTheDocument();
    fireEvent.click(screen.getByText('otReview'));
    expect(f.apiPostV2).not.toHaveBeenCalled(); // nothing is sent before the confirmation
    await f.confirm();
    expect(f.apiPostV2).toHaveBeenCalledTimes(1);
    expect(f.apiPostV2.mock.calls[0]![0]).toBe('v2/attendance/overtime-plans');
    expect(f.apiPostV2.mock.calls[0]![2]).toEqual({ requestId: '00000000-0000-4000-8000-000000000001', date: '2026-11-02', plannedStart: '18:00', plannedEnd: '20:30', reason: 'Month-end close' });
    expect(f.apiPostV2.mock.calls[0]![3]).toEqual({ employmentId: 'e1' });
    expect(screen.getByText('otSentTitle')).toBeInTheDocument();
    expect(screen.getByText('otSentBody 2026-11-02|150min')).toBeInTheDocument();
  });
  it('retries a lost answer under the SAME requestId and shows a refusal as the server words it', async () => {
    let n = 0;
    const f = otFixture(async () => { n += 1; if (n === 1) throw new Error('network'); return { outcome: 'refused', code: 'request_conflict' }; });
    render(<f.OvertimePlanScreen />);
    f.fill(); fireEvent.click(screen.getByText('otReview')); await f.confirm();
    expect(screen.getByText('leaveCommandUncertain')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('leaveCommandRetry')); await new Promise((r) => setTimeout(r, 0)); });
    expect(f.apiPostV2).toHaveBeenCalledTimes(2);
    expect(f.apiPostV2.mock.calls[1]![2].requestId).toBe(f.apiPostV2.mock.calls[0]![2].requestId);
    expect(screen.getByText('refused:request_conflict')).toBeInTheDocument();
  });
  it('asks for the missing pieces instead of sending', () => {
    const f = otFixture(async () => { throw new Error('unexpected'); });
    render(<f.OvertimePlanScreen />);
    fireEvent.click(screen.getByText('otReview'));
    expect(screen.getByText('otPickDate')).toBeInTheDocument();
    fireEvent.click(screen.getByText('otDate')); fireEvent.click(screen.getByText('otReview'));
    expect(screen.getByText('otPickTimes')).toBeInTheDocument();
    fireEvent.click(screen.getByText('otStart')); fireEvent.click(screen.getByText('otEnd')); fireEvent.click(screen.getByText('otReview'));
    expect(screen.getByText('attReasonMissing')).toBeInTheDocument();
    expect(f.alerts).toHaveLength(0);
  });
});

// ── Directory ─────────────────────────────────────────────────────────────────────────────────────────────

function directoryFixture(page: (params: Record<string, string | undefined>) => any) {
  const calls: Record<string, string | undefined>[] = [];
  const Text = ({ children }: any) => <span>{children}</span>;
  const View = ({ children }: any) => <div>{children}</div>;
  const { default: Directory } = load('app/directory.tsx'.replace(/^/, 'mobile/'), {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { View, Linking: { openURL: vi.fn() }, Pressable: (p: any) => <button aria-label={p.accessibilityLabel} onClick={p.onPress}>{typeof p.children === 'function' ? p.children({ pressed: false }) : p.children}</button>,
      TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} /> },
    '../lib/design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'light') }) },
    '../lib/api': { useApiV2: (_p: string, _s: unknown, params: Record<string, string | undefined>) => { calls.push(params); return { data: page(params), error: null, loading: false, reload: vi.fn() }; } },
    '../lib/icon': { Icon: () => null }, '../lib/home-hero': { initials: (n: string) => n.slice(0, 1), tint: (c: string) => c },
    '../lib/i18n': { t: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k) },
    '../lib/session': { useSession: () => ({ signOut: vi.fn() }) },
    '../lib/ui': { Button: (p: any) => <button onClick={p.onPress}>{p.title}</button>, LoadState: () => null, Muted: Text, Screen: View, Title: Text },
    '../../lib/mobile-api/v2/directory': { DirectoryPageV2: {} },
  });
  return { Directory, calls };
}

describe('staff directory', () => {
  it('says the directory is not available when the server answers enabled: false', () => {
    const f = directoryFixture(() => ({ enabled: false, items: [], total: 0, offset: 0, limit: 25 }));
    render(<f.Directory />);
    expect(screen.getByText('directoryOff')).toBeInTheDocument();
  });
  it('sends the search trimmed once typing settles, and offers more only while the server has more', async () => {
    vi.useFakeTimers();
    const person = (i: number) => ({ employmentId: `e${i}`, name: `Person ${i}`, position: null, department: null, company: 'Acme', email: null, phone: null });
    const f = directoryFixture((p) => ({ enabled: true, items: Array.from({ length: Number(p.limit) }, (_, i) => person(i)), total: 40, offset: 0, limit: Number(p.limit) }));
    render(<f.Directory />);
    expect(f.calls.at(-1)).toEqual({ q: undefined, offset: '0', limit: '25' });
    fireEvent.change(screen.getByLabelText('directorySearch'), { target: { value: '  ali  ' } });
    await act(async () => { vi.advanceTimersByTime(350); });
    expect(f.calls.at(-1)).toEqual({ q: 'ali', offset: '0', limit: '25' });
    fireEvent.click(screen.getByText('showMore'));
    expect(f.calls.at(-1)).toEqual({ q: 'ali', offset: '0', limit: '50' });
    expect(screen.queryByText('showMore')).not.toBeInTheDocument(); // all 40 shown
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────

describe('calendar and greeting helpers', () => {
  const cal = load('mobile/app/team-calendar.tsx', { react: React, 'react/jsx-runtime': jsx }, false);
  const hero = load('mobile/lib/home-hero.tsx', { react: React, 'react/jsx-runtime': jsx, './i18n': { t: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k) } }, false);
  it('lays a month out Monday-first and steps across years', () => {
    expect(cal.monthGrid('2026-10')).toMatchObject({ lead: 3 }); // 1 Oct 2026 is a Thursday
    expect(cal.monthGrid('2026-10').dates).toHaveLength(31);
    expect(cal.monthGrid('2028-02').dates.at(-1)).toBe('2028-02-29');
    expect(cal.monthGrid('2024-01').lead).toBe(0); // 1 Jan 2024 is a Monday
    expect(cal.shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(cal.shiftMonth('2026-01', -1)).toBe('2025-12');
  });
  it('greets by Kuala Lumpur time, not the phone’s zone', () => {
    expect(hero.partOfDay(Date.UTC(2026, 9, 29, 0, 30))).toBe('morning'); // 08:30 KL
    expect(hero.partOfDay(Date.UTC(2026, 9, 29, 5, 0))).toBe('afternoon'); // 13:00 KL
    expect(hero.partOfDay(Date.UTC(2026, 9, 29, 12, 0))).toBe('evening'); // 20:00 KL
    expect(hero.partOfDay(Date.UTC(2026, 9, 29, 18, 0))).toBe('evening'); // 02:00 KL
  });
  it('tints only #RRGGBB, keeps initials to two letters, and shows whole minutes', () => {
    expect(hero.tint('#1F5EFF', 0.5, 'x')).toBe('#1F5EFF80');
    expect(hero.tint('rgb(0,0,0)', 0.5, 'fallback')).toBe('fallback');
    expect(hero.initials('  nur  aisyah binti ali ')).toBe('NA');
    expect(hero.initials(null)).toBe('·');
    expect(hero.fmtDuration(3 * 3600 + 7 * 60 + 59)).toBe('durationHm 3|07');
  });
});
