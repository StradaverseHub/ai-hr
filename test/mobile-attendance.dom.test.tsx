/**
 * M12 (D13) — the shipped native attendance screens (mobile/lib/attendance-*.tsx, over the shipped paged list), with
 * only native views, transport, navigation and identity injected. The server's rules are tested in
 * test/mobile-v2-attendance.test.ts; this file pins what the screens do with its answers: the four parts of a day stay
 * apart, an overnight shift is shown crossing midnight, the zone the server names is said, months step by the
 * server's window, a request runs only after confirmation with the SAME reference on retry, a 4xx is not
 * "uncertain", a stale answer offers no command, and the replacement-leave form sends the kernel's own day type.
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
import * as contract from '../lib/mobile-api/v2/attendance';

const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ZONE = 'Asia/Kuala_Lumpur';
function load(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, Intl, Math, Number, String, JSON, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}

const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-07-07',
  schedule: { shiftCode: 'NIGHT', start: '22:00', end: '06:00', crossesMidnight: true, scheduledMinutes: 420, rosteredRest: false, dayType: 'workday', context: null },
  punches: [{ at: '06:00', direction: 'out' }, { at: '22:00', direction: 'in' }],
  outcome: { recorded: true, checkIn: '22:00', checkOut: '06:00', workedMinutes: 420, lateMinutes: 0, earlyOutMinutes: 0, status: 'present' },
  exception: null, ...over,
});
const records = (over: Record<string, unknown> = {}) => ({ enabled: true, employmentId: 'own', timeZone: ZONE, today: '2026-07-20', from: '2026-07-01', to: '2026-07-31',
  days: [day(), day({ date: '2026-07-08', schedule: { shiftCode: null, start: null, end: null, crossesMidnight: false, scheduledMinutes: null, rosteredRest: true, dayType: 'rest_day', context: 'rest_day' }, punches: [], outcome: { recorded: true, checkIn: '09:00', checkOut: null, workedMinutes: null, lateMinutes: null, earlyOutMinutes: null, status: 'present' }, exception: 'odd' })], ...over });
const rosterPage = { enabled: true, employmentId: 'own', timeZone: ZONE, from: '2026-07-01', to: '2026-07-31',
  days: [{ date: '2026-07-07', kind: 'shift', shift: { code: 'NIGHT', name: 'Night', start: '22:00', end: '06:00', crossesMidnight: true, workingMinutes: 420 }, plannedMinutes: 420, note: null }],
  totals: { workDays: 1, rosteredDays: 1, restDays: 0, plannedMinutes: 420 } };
const summary = (over: Record<string, unknown> = {}) => ({ id: APP, date: '2026-07-08', application: 'correction', requestKind: null, status: 'pending', displayStatus: 'pending',
  asked: { checkIn: '09:00', checkOut: '18:00', requestedOtMinutes: null, plannedStart: null, plannedEnd: null, clockEntries: null }, submittedOn: '2026-07-09', ...over });
const dayResult = (over: Record<string, unknown> = {}) => ({ outcome: 'found', timeZone: ZONE, today: '2026-07-20', day: day({ date: '2026-07-08' }), applications: [summary()], correction: { offered: true, blockedBy: null }, ...over });
const detail = (over: Record<string, unknown> = {}) => ({ outcome: 'found', timeZone: ZONE, application: {
  ...summary(), reason: 'Badge reader down', remark: null, original: { checkIn: '08:00', checkOut: null, capturedAt: '2026-07-09T01:00:00.000Z' }, rejectReason: null, decidedAt: null, hasAttachment: false,
  routing: { templateName: 'Clock review', templateVersion: 1, currentLevel: 2, levels: [
    { level: 1, name: 'Review 1', status: 'approved', approvers: [{ kind: 'person', name: 'Marcus' }], decision: { actorName: 'Marcus', actingMode: 'assigned', decidedAt: '2026-07-09T02:00:00.000Z', remarks: 'Checked gate log' } },
    { level: 2, name: 'Review 2', status: 'waiting', approvers: [{ kind: 'hr', name: '' }], decision: null }] },
  actions: { withdraw: true }, ...over } });

function fixture() {
  let seq = 0;
  const get = vi.fn<(path: string, params: Record<string, unknown>) => Promise<any>>(async (path) => {
    if (path === 'v2/attendance/records') return records();
    if (path === 'v2/attendance/roster') return rosterPage;
    if (path === 'v2/attendance/day') return dayResult();
    if (path === 'v2/attendance/applications') return { items: [], nextCursor: null, enabled: true, employmentId: 'own', timeZone: ZONE, counts: { pending: 2, approved: 1, rejected: 0, cancelled: 0 } };
    if (path.startsWith('v2/attendance/applications/')) return detail();
    throw new Error('unexpected read ' + path);
  });
  const apiGetPage = vi.fn<(...a: any[]) => Promise<any>>(async () => ({ items: [summary()], nextCursor: null }));
  const apiPostV2 = vi.fn<(...a: any[]) => Promise<any>>();
  const push = vi.fn(), back = vi.fn(), replace = vi.fn(), alert = vi.fn(), signOut = vi.fn();
  /** useApiV2, scoped by path and params as the real one is, over the injected `get`. */
  function useApiV2(path: string, _schema: unknown, params: Record<string, unknown>) {
    const key = JSON.stringify([path, params]);
    const [state, setState] = React.useState<{ key: string; data: any; error: Error | null; loading: boolean }>({ key, data: null, error: null, loading: true });
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
      let live = true;
      setState((s) => ({ key, data: s.key === key ? s.data : null, error: null, loading: true }));
      get(path, JSON.parse(key)[1]).then((data) => { if (live) setState({ key, data, error: null, loading: false }); },
        (error: Error) => { if (live) setState((s) => ({ key, data: s.key === key ? s.data : null, error, loading: false })); });
      return () => { live = false; };
    }, [key, tick]);
    const reload = React.useCallback(() => setTick((n) => n + 1), []);
    return state.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
  }
  const View = ({ children, accessibilityLabel }: any) => <div aria-label={accessibilityLabel}>{children}</div>;
  const Text = ({ children, accessibilityRole }: any) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert },
    Pressable: (p: any) => <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} disabled={p.editable === false} onChange={(e) => p.onChangeText(e.target.value)} />,
    RefreshControl: (p: any) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: any) => <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((item: any) => <div key={p.keyExtractor(item)}>{p.renderItem({ item })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const ui = {InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: any) => <button disabled={p.disabled} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, SectionLabel: Text, Row: ({ label, value }: any) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: any) => <div>{onRefresh && <button onClick={onRefresh}>refresh</button>}{children}</div>,
    LoadState: (p: any) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtDays: (n: unknown) => (n == null ? '—' : String(n)),
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const i18n = { appLocale: () => 'en', intlLocale: () => 'en-MY', t };
  const base = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': i18n,
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
    'expo-router': { router: { push, back, replace } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    'react-native-safe-area-context': { SafeAreaView: View },
    '../../lib/mobile-api/v2/attendance': contract,
  };
  const api = { useApiV2, apiGetPage, apiPostV2, v2Page: (path: string) => ({ kind: 'page', path, schema: null }) };
  // D9: the platform picker is the leave form's; here it sets a fixed value per field so the flow can be driven.
  const picks: Record<string, string> = { attProposedIn: '09:05', attProposedOut: '18:10', attWorkedDate: '2026-07-04', attClaimStart: '09:00', attClaimEnd: '17:00' };
  const PickerField = (p: any) => <button disabled={p.disabled} aria-label={p.label} onClick={() => p.onChange(picks[p.label])}>{`${p.label}=${p.value ?? ''}`}</button>;
  const format = load('mobile/lib/attendance-format.ts', { './i18n': i18n });
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  // D8: a fresh roster re-plans shift reminders through this signal (mobile/lib/shift-reminder-signal.ts).
  const recordsLib = load('mobile/lib/attendance-records.tsx', { ...base, './api': api, './attendance-format': format, './shift-reminder-signal': { requestShiftReminderRefresh: () => {} } });
  const applications = load('mobile/lib/attendance-applications.tsx', { ...base, './api': api, './paged-list': paged, './attendance-format': format, './attendance-records': recordsLib });
  const requests = load('mobile/lib/attendance-requests.tsx', { ...base, './api': api, './attendance-format': format, './attendance-records': recordsLib, './attendance-applications': applications, './leave-request-form': { PickerField } });
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2]; await act(async () => { buttons[1].onPress(); }); };
  return { ...recordsLib, ...applications, ...requests, fmtZoneName: format.fmtZoneName, get, apiGetPage, apiPostV2, push, back, replace, alert, signOut, confirm };
}
afterEach(cleanup);

describe('records and roster', () => {
  it('shows each day’s schedule, result and exception apart, the overnight shift crossing midnight, and the server’s zone', async () => {
    const f = fixture();
    render(<f.AttendanceHomeScreen />);
    await screen.findByText('NIGHT 22:00–06:00 attNextDay');
    expect(f.get.mock.calls[0]).toEqual(['v2/attendance/records', { employmentId: 'own' }]);
    // The note names the zone for people ("Malaysia Time"), never the raw IANA id.
    const zoneName = f.fmtZoneName(ZONE);
    expect(zoneName).not.toBe(ZONE);
    expect(screen.getByText(`attTimeZone ${zoneName}`)).toBeTruthy();
    expect(screen.getByText('attInOut 22:00|06:00')).toBeTruthy();
    expect(screen.getByText('attRestDay')).toBeTruthy();
    expect(screen.getByText('attException attExceptionOdd')).toBeTruthy();
    expect(screen.getAllByText('attStatusPresent')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /attExceptionOdd/ }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/attendance/[date]', params: { date: '2026-07-08' } });
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('steps a month from the server’s own window, and the roster tab reads the same month', async () => {
    const f = fixture();
    render(<f.AttendanceHomeScreen />);
    await screen.findByText('NIGHT 22:00–06:00 attNextDay');
    fireEvent.click(screen.getByRole('button', { name: 'attPrevMonth' }));
    await waitFor(() => expect(f.get).toHaveBeenCalledWith('v2/attendance/records', { employmentId: 'own', from: '2026-06-01', to: '2026-06-30' }));
    fireEvent.click(screen.getByText('attTabRoster'));
    await waitFor(() => expect(f.get).toHaveBeenCalledWith('v2/attendance/roster', { employmentId: 'own', from: '2026-06-01', to: '2026-06-30' }));
    await screen.findByText('NIGHT · 22:00–06:00 attNextDay · attRosterRostered');
    fireEvent.click(screen.getByText('attThisMonth'));
    await waitFor(() => expect(f.get).toHaveBeenLastCalledWith('v2/attendance/roster', { employmentId: 'own' }));
  });

  it('a module that is off says so; an outage on a cold start shows no rows and no command', async () => {
    const f = fixture();
    f.get.mockImplementation(async () => records({ enabled: false, employmentId: null, days: [] }));
    render(<f.AttendanceHomeScreen />);
    await screen.findByText('attModuleOff');
    cleanup();
    const g = fixture();
    g.get.mockRejectedValue(new errors.NetworkUnavailableError());
    render(<g.AttendanceDayScreen date="2026-07-08" />);
    await screen.findByText(/error:NetworkUnavailableError/);
    expect(screen.queryByText('attRequestCorrection')).toBeNull();
    expect(screen.queryByText(/staleData/)).toBeNull();
  });
});

describe('one day', () => {
  it('lists the clockings on record and the day’s applications, and opens the correction for an offered day', async () => {
    const f = fixture();
    render(<f.AttendanceDayScreen date="2026-07-08" />);
    await screen.findByText('attPunchIn: 22:00');
    expect(f.get.mock.calls[0]).toEqual(['v2/attendance/day', { employmentId: 'own', date: '2026-07-08' }]);
    expect(screen.getByText('attPunchOut: 06:00')).toBeTruthy();
    expect(screen.getByText('attOvernightNote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /attKindCorrection/ }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/attendance/request/[id]', params: { id: APP } });
    fireEvent.click(screen.getByText('attRequestCorrection'));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/attendance/correction', params: { date: '2026-07-08' } });
  });

  it('a day with a pending application offers no correction; a stale answer disables it', async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(dayResult({ correction: { offered: false, blockedBy: 'pending' } }));
    render(<f.AttendanceDayScreen date="2026-07-08" />);
    await screen.findByText('attCorrectionPending');
    expect(screen.queryByText('attRequestCorrection')).toBeNull();
    cleanup();
    const g = fixture();
    render(<g.AttendanceDayScreen date="2026-07-08" />);
    await screen.findByText('attRequestCorrection');
    g.get.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('refresh'));
    await screen.findByText(/staleData/);
    expect(screen.getByText('attRequestCorrection')).toBeDisabled();
    expect(screen.getByText('attCommandsOnline')).toBeTruthy();
  });
});

describe('own applications', () => {
  it('lists the server’s rows with counts on the chips and opens detail', async () => {
    const f = fixture();
    render(<f.AttendanceApplicationsScreen />);
    await screen.findByText('attFilterCount attDisplayPending|2');
    expect(f.apiGetPage.mock.calls[0][0]).toMatchObject({ path: 'v2/attendance/applications' });
    expect(f.apiGetPage.mock.calls[0][2]).toEqual({ employmentId: 'own' });
    fireEvent.click(screen.getByRole('button', { name: /attKindCorrection, attDisplayPending/ }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/attendance/request/[id]', params: { id: APP } });
    fireEvent.click(screen.getByText('attFilterCount attDisplayApproved|1'));
    await waitFor(() => expect(f.apiGetPage).toHaveBeenCalledTimes(2));
    expect(f.apiGetPage.mock.calls[1][2]).toEqual({ employmentId: 'own', status: 'approved' });
  });

  it('renders the recorded route level by level; withdraw runs only after confirmation and a lost answer is retried with the SAME reference', async () => {
    const f = fixture();
    render(<f.AttendanceApplicationScreen id={APP} />);
    await screen.findByText('attRoute Clock review|1');
    expect(f.get.mock.calls[0]).toEqual([`v2/attendance/applications/${APP}`, { employmentId: 'own' }]);
    expect(screen.getByText(/^attLevelApproved 1\|Review 1\|Marcus\|/)).toBeTruthy();
    expect(screen.getByText('attLevelWaiting 2|Review 2|attHr')).toBeTruthy();
    expect(screen.getByText('attRemarks Checked gate log')).toBeTruthy();
    expect(screen.getByText('attOriginal 08:00|—')).toBeTruthy();
    fireEvent.click(screen.getByText('attWithdraw'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('leaveCommandUncertain');
    const [path, , body, params] = f.apiPostV2.mock.calls[0];
    expect(path).toBe(`v2/attendance/applications/${APP}/withdraw`);
    expect(params).toEqual({ employmentId: 'own' });
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/) });
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'withdrawn', id: APP });
    fireEvent.click(screen.getByText('leaveCommandRetry'));
    await screen.findByText('attWithdrawn');
    expect(f.apiPostV2.mock.calls[1][2]).toEqual(body);
  });

  it('a refusal is the app’s own sentence and is not “uncertain”; an overtime plan offers no withdraw', async () => {
    const f = fixture();
    render(<f.AttendanceApplicationScreen id={APP} />);
    fireEvent.click(await screen.findByText('attWithdraw'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'not_withdrawable', message: 'This request is no longer waiting for a decision, so it can no longer be withdrawn.' });
    await f.confirm();
    await screen.findByText('attRefusalNotWithdrawable');
    expect(screen.queryByText('leaveCommandUncertain')).toBeNull();
    cleanup();
    const g = fixture();
    g.get.mockResolvedValueOnce(detail({ application: 'overtime', actions: { withdraw: false } }));
    render(<g.AttendanceApplicationScreen id={APP} />);
    await screen.findByText('attOvertimeOnWeb');
    expect(screen.queryByText('attWithdraw')).toBeNull();
    cleanup();
    const h = fixture();
    render(<h.AttendanceApplicationScreen id="not-a-uuid" />);
    await screen.findByText('attNotFound');
  });
});

describe('correction request', () => {
  it('shows the clockings on record read only, sends proposed times and the reason after confirmation, and retries with the same body', async () => {
    const f = fixture();
    render(<f.AttendanceCorrectionScreen date="2026-07-08" />);
    await screen.findByText('attOnRecord');
    expect(screen.getByText('attPunchIn: 22:00')).toBeTruthy();
    expect(screen.getByText('attProposedIn=22:00'), 'the form opens on the day’s own pair, as the web form does').toBeTruthy();
    fireEvent.click(screen.getByText('attReview'));
    expect(screen.getByText('attReasonMissing')).toBeTruthy();
    expect(f.alert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'attProposedIn' }));
    fireEvent.click(screen.getByRole('button', { name: 'attProposedOut' }));
    fireEvent.change(screen.getByLabelText('attReasonRequired'), { target: { value: '  Badge reader down ' } });
    fireEvent.click(screen.getByText('attReview'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('leaveCommandUncertain');
    const [path, , body, params] = f.apiPostV2.mock.calls[0];
    expect(path).toBe('v2/attendance/corrections');
    expect(params).toEqual({ employmentId: 'own' });
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/), date: '2026-07-08', checkIn: '09:05', checkOut: '18:10', reason: 'Badge reader down' });
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', id: APP, date: '2026-07-08' });
    fireEvent.click(screen.getByText('leaveCommandRetry'));
    await screen.findByText('attCorrectionSent');
    expect(f.apiPostV2.mock.calls[1][2]).toEqual(body);
    fireEvent.click(screen.getByText('attViewApplication'));
    expect(f.replace).toHaveBeenCalledWith({ pathname: '/attendance/request/[id]', params: { id: APP } });
  });

  it('a kernel refusal is told in the app’s words with a fresh reference next time; a 4xx is not uncertain', async () => {
    const f = fixture();
    render(<f.AttendanceCorrectionScreen date="2026-07-08" />);
    await screen.findByText('attOnRecord');
    fireEvent.change(screen.getByLabelText('attReasonRequired'), { target: { value: 'r' } });
    fireEvent.click(screen.getByText('attReview'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'payroll_closed', message: 'closed' });
    await f.confirm();
    await screen.findByText('attRefusalPayrollClosed');
    fireEvent.click(screen.getByText('attReview'));
    f.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400));
    await f.confirm(1);
    await screen.findByText('genericError');
    expect(screen.queryByText('leaveCommandUncertain')).toBeNull();
    expect(f.apiPostV2.mock.calls[1][2].requestId).not.toBe(f.apiPostV2.mock.calls[0][2].requestId);
  });
});

describe('replacement leave', () => {
  const offer = (over: Record<string, unknown> = {}) => ({ employmentId: 'own', timeZone: ZONE, today: '2026-07-20', allowed: true, reason: null, requiresFirstScheduleConsent: true,
    leaveType: { id: APP, name: 'Replacement Leave' }, tiers: { halfDayMinutes: 240, fullDayMinutes: 480 }, ordinaryDayAllowed: false, ...over });
  const facts = (review: unknown) => ({ outcome: 'found', timeZone: ZONE, day: { date: '2026-07-04', dayType: 'rest_day', shiftCode: null, shiftStart: null, shiftEnd: null, actualClockIn: '09:00', actualClockOut: '17:00', approvedOvertime: null, review } });

  it('says the kernel’s reason when not allowed', async () => {
    const f = fixture();
    f.get.mockImplementation(async () => offer({ allowed: false, reason: 'first_schedule_protected' }));
    render(<f.ReplacementLeaveScreen />);
    await screen.findByText('attRlOffFirstSchedule');
    expect(screen.queryByText('attWorkedDate=')).toBeNull();
  });

  it('reads the day’s facts and the kernel’s review, needs the reason and consent, and sends the kernel’s day type after confirmation', async () => {
    const f = fixture();
    f.get.mockImplementation(async (path: string, params: Record<string, unknown>) => {
      if (path === 'v2/attendance/replacement-leave') return offer();
      if (path === 'v2/attendance/replacement-leave/day') return facts(params.start ? { state: 'ready', reason: null, eligibleMinutes: 480, creditDays: 1, crossesMidnight: false } : null);
      throw new Error('unexpected ' + path);
    });
    render(<f.ReplacementLeaveScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'attWorkedDate' }));
    await screen.findByText('attDayType: attRestDay');
    expect(f.get).toHaveBeenCalledWith('v2/attendance/replacement-leave/day', { employmentId: 'own', date: '2026-07-04' });
    fireEvent.click(screen.getByRole('button', { name: 'attClaimStart' }));
    fireEvent.click(screen.getByRole('button', { name: 'attClaimEnd' }));
    await screen.findByText('attRlCredit 1');
    expect(f.get).toHaveBeenCalledWith('v2/attendance/replacement-leave/day', { employmentId: 'own', date: '2026-07-04', start: '09:00', end: '17:00' });
    expect(screen.getByText('attReview')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('attReasonRequired'), { target: { value: 'Covered the stock take' } });
    expect(screen.getByText('attReview'), 'consent is still required').toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'attRlConsent' }));
    fireEvent.click(screen.getByText('attReview'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', id: APP, totalDays: 1 });
    await f.confirm();
    await screen.findByText('attRlSent');
    const [path, , body, params] = f.apiPostV2.mock.calls[0];
    expect(path).toBe('v2/attendance/replacement-leave');
    expect(params).toEqual({ employmentId: 'own' });
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/), rows: [{ workedDate: '2026-07-04', dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }], reason: 'Covered the stock take', firstScheduleConsent: true });
  });

  it('a window the kernel refuses cannot be sent', async () => {
    const f = fixture();
    f.get.mockImplementation(async (path: string, params: Record<string, unknown>) =>
      path === 'v2/attendance/replacement-leave' ? offer({ requiresFirstScheduleConsent: false })
        : facts(params.start ? { state: 'refused', reason: 'belowThreshold', eligibleMinutes: 60, creditDays: null, crossesMidnight: false } : null));
    render(<f.ReplacementLeaveScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'attWorkedDate' }));
    await screen.findByText('attDayType: attRestDay');
    fireEvent.click(screen.getByRole('button', { name: 'attClaimStart' }));
    fireEvent.click(screen.getByRole('button', { name: 'attClaimEnd' }));
    await screen.findByText('attRlBelow');
    fireEvent.change(screen.getByLabelText('attReasonRequired'), { target: { value: 'r' } });
    expect(screen.getByText('attReview')).toBeDisabled();
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });
});
