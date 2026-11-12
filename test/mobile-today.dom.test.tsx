/**
 * Native Today (owner decisions, 12 November 2026) — the shipped Today sections (mobile/lib/today.tsx) and their copy
 * (mobile/lib/today-copy.ts), with only native views, transport, navigation and identity injected. The server's rules
 * are tested beside its routes; this file pins what the screens do with its answers:
 *   • a reminder decides nothing: a missed clock-out is sent only after a reason AND the confirmation dialog, with the
 *     case id and reason only (never a date or time); refusals, sign-in loss and lost responses each say what happened,
 *     and a lost response never offers an immediate second send;
 *   • Undo is confirmed first and posts only the action id;
 *   • a section the server could not check says so with a retry, never "nothing to do"; a module that is off draws nothing;
 *   • a step with no native screen offers no button; destinations map only to the app's own fixed screens;
 *   • every language has every key, with the same placeholders as English.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';
import * as errors from '../mobile/lib/errors';
import * as contract from '../lib/mobile-api/v2/today';

const CASE = '11111111-1111-4111-8111-111111111111', ACTION = '22222222-2222-4222-8222-222222222222';
type Loaded = Record<string, any>;
function load(path: string, ports: Record<string, unknown>): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, Intl, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}

function fixture(locale = 'en') {
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const push = vi.fn(), signOut = vi.fn();
  const dialogs: { title: string; message: string; buttons: { text?: string; style?: string; onPress?: () => void }[] }[] = [];
  const View = ({ children, accessibilityLabel }: { children?: React.ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text,
    Pressable: (p: { accessibilityLabel?: string; onPress?: () => void; children?: React.ReactNode; style?: unknown }) => <button aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: { accessibilityLabel?: string; value: string; onChangeText: (v: string) => void }) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
  };
  const ui = {
    Button: (p: { disabled?: boolean; onPress: () => void; title: string }) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Chip: (p: { selected?: boolean; disabled?: boolean; onPress: () => void; title: string }) => <button aria-pressed={!!p.selected} disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Muted: Text,
  };
  const i18n = { appLocale: () => locale, intlLocale: () => 'en-MY', t: (k: string) => k };
  const base = { react: React, 'react/jsx-runtime': jsx, './i18n': i18n };
  const copy = load('mobile/lib/today-copy.ts', base);
  const mod = load('mobile/lib/today.tsx', {
    ...base, 'react-native': native, './ui': ui, './errors': errors, './today-copy': copy, '../../lib/mobile-api/v2/today': contract,
    './api': { apiPostV2, useApiV2: vi.fn() },
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './in-app-alert': { InAppAlert: { approval: (title: string, message: string, buttons: never[]) => { dialogs.push({ title, message, buttons }); } } },
    './attendance-format': load('mobile/lib/attendance-format.ts', base),
    './icon': { Icon: () => null },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'light') }) },
    'expo-router': { useRouter: () => ({ push }), useFocusEffect: () => {} },
  });
  const press = (dialog = dialogs.length - 1, label?: string) => {
    const d = dialogs[dialog]!; const b = label ? d.buttons.find((x) => x.text === label) : d.buttons[d.buttons.length - 1];
    b!.onPress?.();
  };
  return Object.assign({} as Loaded, mod, { copy, apiPostV2, push, signOut, dialogs, press });
}
afterEach(cleanup);

const clockOut = { kind: 'clockOut', caseId: CASE, date: '2026-11-11', checkIn: '09:02', proposedCheckOut: '18:00' } as const;
const autoFixed = { kind: 'autoFixed', actionId: ACTION, date: '2026-11-10', checkOut: '18:00', undoUntil: '2026-11-13T10:00:00.000Z' } as const;
const ok = (items: unknown[]) => ({ status: 'ok', items });

describe('pure rules', () => {
  it('maps every destination to a fixed app screen', () => {
    const f = fixture();
    expect(f.todayHref({ screen: 'attendanceCorrection', date: '2026-11-11' })).toEqual({ pathname: '/attendance/correction', params: { date: '2026-11-11' } });
    expect(f.todayHref({ screen: 'attendanceDay', date: '2026-11-11' })).toEqual({ pathname: '/attendance/[date]', params: { date: '2026-11-11' } });
    expect(['profile', 'profileEdit', 'leave', 'leaveHistory', 'approvals', 'pay'].map((screen) => f.todayHref({ screen })))
      .toEqual(['/profile', '/profile/edit', '/leave', '/leave/history', '/approvals', '/pay']);
  });

  it('builds a Confirm only from a chosen reason, and never carries a date or time', () => {
    const f = fixture();
    expect(f.clockOutCommand(CASE, null, '')).toBeNull();
    expect(f.clockOutCommand(CASE, 'forgot', 'ignored')).toEqual({ caseId: CASE, reason: 'forgot', confirm: true });
    expect(f.clockOutCommand(CASE, 'other', '   ')).toBeNull();
    expect(f.clockOutCommand(CASE, 'other', 'x'.repeat(501))).toBeNull();
    expect(f.clockOutCommand(CASE, 'other', '  Site  visit\n ran late ')).toEqual({ caseId: CASE, reason: 'other', other: 'Site visit ran late', confirm: true });
    for (const command of [f.clockOutCommand(CASE, 'device', ''), f.clockOutCommand(CASE, 'other', 'a')]) expect(contract.ClockOutConfirmCommandV2.safeParse(command).success).toBe(true);
    expect(contract.ClockOutConfirmCommandV2.safeParse({ caseId: CASE, reason: 'forgot', confirm: false }).success).toBe(false);
    expect(contract.ClockOutConfirmCommandV2.safeParse({ caseId: CASE, reason: 'forgot', confirm: true, date: '2026-11-11' }).success).toBe(false);
  });

  it('words distances and keeps a scale that never computes a figure', () => {
    const f = fixture();
    expect([0, 1, 5].map(f.daysAwayText)).toEqual(['Today', 'Tomorrow', 'In 5 days']);
    expect(f.barScale({ bars: [{ date: '2026-11-10', state: 'worked', workedMinutes: 500, scheduledMinutes: 480 }], workedMinutes: 500, shiftMinutes: 480 })).toBe(500);
    expect(f.barScale({ bars: [], workedMinutes: 0, shiftMinutes: null })).toBe(60);
  });
});

describe('reminders', () => {
  it('says it could not check, with a retry, and never "nothing needs you"', () => {
    const f = fixture(), onReload = vi.fn();
    render(<f.TodayReminders section={{ status: 'unavailable' }} onReload={onReload} />);
    expect(screen.getByRole('alert').textContent).toBe('Reminders could not be checked.');
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
    fireEvent.click(screen.getByText('Check again'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('an empty answer is all clear, and a non-empty one is labelled as prepared by AI Centre', () => {
    const f = fixture();
    const { rerender } = render(<f.TodayReminders section={ok([])} onReload={() => {}} />);
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
    rerender(<f.TodayReminders section={ok([clockOut])} onReload={() => {}} />);
    expect(screen.getByText('Prepared by AI Centre · you decide')).toBeTruthy();
  });

  it('sends a missed clock-out only after a reason and the confirmation, then says it went for approval', async () => {
    const f = fixture();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted' });
    render(<f.TodayReminders section={ok([clockOut])} onReload={() => {}} />);
    expect(screen.getByText('Did you leave at 18:00 on Wed, 11 Nov 2026?')).toBeTruthy();
    expect(screen.getByText('Send correction')).toBeDisabled();
    fireEvent.click(screen.getByText('Forgot to clock out'));
    fireEvent.click(screen.getByText('Send correction'));
    expect(f.apiPostV2).not.toHaveBeenCalled();
    expect(f.dialogs).toHaveLength(1);
    expect(f.dialogs[0].message).toBe('Clock-out 18:00 on Wed, 11 Nov 2026. Reason: Forgot to clock out. Your approver decides it.');
    f.press(0, 'cancel');
    expect(f.apiPostV2).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Send correction'));
    f.press(1, 'Send correction');
    await screen.findByText('Sent for approval. You can follow it in your attendance requests.');
    expect(f.apiPostV2).toHaveBeenCalledTimes(1);
    const [path, schema, body] = f.apiPostV2.mock.calls[0]!;
    expect(path).toBe('v2/today/clock-out');
    expect(schema).toBe(contract.ClockOutConfirmResultV2);
    expect(body).toEqual({ caseId: CASE, reason: 'forgot', confirm: true });
    expect(screen.queryByText('Send correction')).toBeNull();
  });

  it('passes the typed reason for Other and opens the correction form on Edit', async () => {
    const f = fixture();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted' });
    render(<f.TodayReminders section={ok([clockOut])} onReload={() => {}} />);
    fireEvent.click(screen.getByText('Other'));
    expect(screen.getByText('Send correction')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type the reason'), { target: { value: ' Client  meeting ' } });
    fireEvent.click(screen.getByText('Send correction'));
    f.press();
    await waitFor(() => expect(f.apiPostV2).toHaveBeenCalledTimes(1));
    expect(f.apiPostV2.mock.calls[0]![2]).toEqual({ caseId: CASE, reason: 'other', other: 'Client meeting', confirm: true });
    cleanup();
    const g = fixture();
    render(<g.TodayReminders section={ok([clockOut])} onReload={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(g.push).toHaveBeenCalledWith({ pathname: '/attendance/correction', params: { date: '2026-11-11' } });
  });

  it('a refusal says nothing was sent; a lost response asks to check before a second send', async () => {
    const f = fixture(), onReload = vi.fn();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'changed' }).mockRejectedValueOnce(new Error('network'));
    render(<f.TodayReminders section={ok([clockOut])} onReload={onReload} />);
    fireEvent.click(screen.getByText('Device problem'));
    fireEvent.click(screen.getByText('Send correction')); f.press();
    await screen.findByText(/This day has changed since the reminder was prepared/);
    fireEvent.click(screen.getByText('Send correction')); f.press();
    await screen.findByText('We could not confirm it was sent. Check again before sending it a second time.');
    expect(screen.getByText('Send correction')).toBeDisabled();
    fireEvent.click(screen.getByText('Check again'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('a request refused before anything was recorded says nothing was sent; losing sign-in signs out', async () => {
    const f = fixture();
    f.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400)).mockRejectedValueOnce(new errors.SignInRequiredError());
    render(<f.TodayReminders section={ok([clockOut])} onReload={() => {}} />);
    fireEvent.click(screen.getByText('Forgot to clock out'));
    fireEvent.click(screen.getByText('Send correction')); f.press();
    await screen.findByText('Nothing was sent. Try again later, or use Edit.');
    fireEvent.click(screen.getByText('Send correction')); f.press();
    await waitFor(() => expect(f.signOut).toHaveBeenCalledTimes(1));
  });

  it('Undo is confirmed first, posts only the action id, and reports the outcome', async () => {
    const f = fixture();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'expired' }).mockResolvedValueOnce({ outcome: 'undone' });
    render(<f.TodayReminders section={ok([autoFixed])} onReload={() => {}} />);
    expect(screen.getByText('Clock-out set to 18:00 on Tue, 10 Nov 2026')).toBeTruthy();
    expect(screen.getByText(/undo it by 13 Nov/)).toBeTruthy();
    fireEvent.click(screen.getByText('Undo'));
    expect(f.apiPostV2).not.toHaveBeenCalled();
    expect(f.dialogs[0].buttons.find((b: { text?: string }) => b.text === 'Undo')?.style).toBe('destructive');
    f.press();
    await screen.findByText('The undo window has closed. Ask HR if the time is wrong.');
    fireEvent.click(screen.getByText('Undo')); f.press();
    await screen.findByText('Undone. The day is back as it was.');
    expect(f.apiPostV2.mock.calls.map((c) => [c[0], c[2]])).toEqual([['v2/today/undo', { actionId: ACTION, confirm: true }], ['v2/today/undo', { actionId: ACTION, confirm: true }]]);
  });

  it('record and passport reminders only open the person\'s own profile', () => {
    const f = fixture();
    render(<f.TodayReminders section={ok([
      { kind: 'record', caseId: CASE, gaps: [{ key: 'bankAccount', label: 'Bank account number' }], destination: { screen: 'profileEdit' } },
      { kind: 'passport', caseId: '33333333-3333-4333-8333-333333333333', expiresOn: '2026-12-20', destination: { screen: 'profile' } },
    ])} onReload={() => {}} />);
    expect(screen.getByText('· Bank account number')).toBeTruthy();
    fireEvent.click(screen.getByText('Fill in'));
    fireEvent.click(screen.getByText('Update your details'));
    expect(f.push.mock.calls).toEqual([['/profile/edit'], ['/profile']]);
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });
});

describe('sections', () => {
  const step = (over: Record<string, unknown> = {}) => ({ key: 'k1', kind: 'missed_clock_out', due: '2026-11-20', date: '2026-11-11', endDate: null, label: null, decider: 'manager', destination: { screen: 'attendanceCorrection', date: '2026-11-11' }, ...over });

  it('steps open their screen; a step with no native screen offers no button; partial is never all clear', () => {
    const f = fixture();
    render(<f.TodaySteps section={{ status: 'ok', partial: true, more: 2, items: [step(), step({ key: 'k2', kind: 'claim_receipt_missing', label: 'Travel', decider: 'you', destination: null })] }} onReload={() => {}} />);
    expect(screen.getByText('Some steps could not be checked, so this list may be incomplete.')).toBeTruthy();
    expect(screen.queryByText('You are all caught up.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'No clock-out recorded. Wed, 11 Nov · Due Fri, 20 Nov · Your manager decides' }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/attendance/correction', params: { date: '2026-11-11' } });
    expect(screen.getByText('Claim receipt missing · Travel')).toBeTruthy();
    expect(screen.getByText('Finish this on the web')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('2 more on the web')).toBeTruthy();
  });

  it('hours and payday draw nothing when their module is off, and say so with a retry when unchecked', () => {
    const f = fixture(), onReload = vi.fn();
    const { container } = render(<><f.TodayHours section={{ status: 'off' }} today="2026-11-12" onReload={onReload} /><f.TodayPayday section={{ status: 'off' }} onReload={onReload} /></>);
    expect(container.textContent).toBe('');
    cleanup();
    render(<><f.TodayHours section={{ status: 'unavailable' }} today="2026-11-12" onReload={onReload} /><f.TodayPayday section={{ status: 'unavailable' }} onReload={onReload} /><f.TodayComingUpList section={{ status: 'unavailable' }} onReload={onReload} /></>);
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(["This week's hours could not be loaded.", 'Payday could not be checked.', 'Coming up could not be checked.']);
    for (const b of screen.getAllByText('Check again')) fireEvent.click(b);
    expect(onReload).toHaveBeenCalledTimes(3);
  });

  it('shows the server\'s week, payday date (never an amount) and coming up', () => {
    const f = fixture();
    render(<>
      <f.TodayHours today="2026-11-12" onReload={() => {}} section={{ status: 'ok', week: { workedMinutes: 990, shiftMinutes: 540, bars: [
        { date: '2026-11-10', state: 'worked', workedMinutes: 495, scheduledMinutes: 540 },
        { date: '2026-11-11', state: 'worked', workedMinutes: 495, scheduledMinutes: 540 },
        { date: '2026-11-12', state: 'running', workedMinutes: null, scheduledMinutes: 540 },
        { date: '2026-11-13', state: 'upcoming', workedMinutes: null, scheduledMinutes: 540 }] } }} />
      <f.TodayPayday onReload={() => {}} section={{ status: 'ok', next: { kind: 'payday', date: '2026-11-28', daysAway: 16 } }} />
      <f.TodayComingUpList onReload={() => {}} section={{ status: 'ok', items: [
        { date: '2026-11-14', endDate: '2026-11-15', kind: 'leave', name: null },
        { date: '2026-11-18', endDate: '2026-11-18', kind: 'managerAway', name: 'Aina' },
        { date: '2026-12-25', endDate: '2026-12-25', kind: 'holiday', name: 'Christmas Day' }] }} />
    </>);
    expect(screen.getByText('attHoursMinutes worked this week')).toBeTruthy();
    expect(screen.getByLabelText(/Thu, 12 Nov, On the clock/)).toBeTruthy();
    expect(screen.getByText('Next payday')).toBeTruthy();
    expect(screen.getByText('In 16 days')).toBeTruthy();
    expect(screen.getByText('Your leave')).toBeTruthy();
    expect(screen.getByText('Sat, 14 Nov – Sun, 15 Nov')).toBeTruthy();
    expect(screen.getByText('Aina away')).toBeTruthy();
    expect(screen.getByText('Christmas Day')).toBeTruthy();
    expect(screen.queryByText(/RM|MYR/)).toBeNull();
  });
});

describe('copy', () => {
  it('every language has every key, non-blank, with exactly the English placeholders', () => {
    const f = fixture();
    const catalogues = f.copy.TODAY_CATALOGUES as Record<string, Record<string, string>>;
    const en = catalogues.en!;
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(Object.keys(catalogues).sort()).toEqual(['en', 'ms', 'ta', 'th', 'vi', 'zh']);
    for (const [code, table] of Object.entries(catalogues)) {
      expect(Object.keys(table).sort(), code).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(table)) {
        expect(text.trim().length, `${code}.${key}`).toBeGreaterThan(0);
        expect(vars(text), `${code}.${key}`).toEqual(vars(en[key]!));
      }
    }
    for (const kind of contract.TODAY_STEP_KINDS) expect(en[`step_${kind}`], kind).toBeTruthy();
    for (const kind of ['payday', 'cutoff', 'leave', 'holiday', 'managerAway']) expect(en[`coming_${kind}`], kind).toBeTruthy();
  });

  it('renders in the person\'s language', () => {
    const f = fixture('ms');
    render(<f.TodayReminders section={{ status: 'unavailable' }} onReload={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('Peringatan tidak dapat disemak.');
  });
});
