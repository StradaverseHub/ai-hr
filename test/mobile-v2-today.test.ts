/**
 * Native Today (owner decisions, 12 Nov 2026) — GET /api/mobile/v2/today and its two commands, through the REAL route
 * handlers, mobileRoute, the composition (core/mobile-today.ts), the web's pure Today rules and the real message
 * catalogues. The owners' reads and commands are injected seams (their own behaviour is proven by their own suites,
 * and the database journey by test/mobile-v2-today-clock-out.test.ts); no database is touched here.
 *
 * Pinned: the full response parses against the contract with written-out values; each section fails on its own; a
 * module not in use is `off`; a foreign or missing employment is refused before any section reads; step destinations
 * and the missed clock-out dedupe; record gaps labelled in the caller's language with an unlabelled gap left out; the
 * clock-out reason label in the caller's language (Malay, with English fallback); the refusal mappings; and the step
 * kinds the app knows. The HR day is fixed (Thursday 12 November 2026 in Kuala Lumpur), so every expected date is
 * written out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), readiness: vi.fn(), loopCards: vi.fn(), payHints: vi.fn(), calendar: vi.fn(), week: vi.fn(),
  away: vi.fn(), modules: vi.fn(), autonomy: vi.fn(), confirm: vi.fn(), undo: vi.fn(),
}));
vi.mock('../lib/request-budget', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/request-budget')>(), takeRequestBudget: async () => undefined }));
vi.mock('../lib/session', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/session')>(), getMobileSession: ports.session }));
vi.mock('../db/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../db/client')>(),
  withTenant: async (_s: unknown, work: (tx: unknown) => unknown) => work({}),
  withSharedReadSnapshot: async (_s: unknown, work: () => unknown) => work(),
}));
vi.mock('../core/employee-today-reads', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/employee-today-reads')>(),
  readOwnContext: ports.context, readOwnReadiness: ports.readiness, readOwnLoopCards: ports.loopCards, readOwnPayHints: ports.payHints,
  readOwnCalendar: ports.calendar, readOwnWeek: ports.week, readManagersAway: ports.away, moduleState: ports.modules,
}));
vi.mock('../core/loops/autonomy-cards', async (importOriginal) => ({ ...await importOriginal<typeof import('../core/loops/autonomy-cards')>(), readAutonomyCardsTx: ports.autonomy }));
vi.mock('../core/loops/clock-out-confirm', () => ({ confirmMissedClockOut: ports.confirm }));
vi.mock('../core/loops/undo', () => ({ undoLoopAction: ports.undo }));
// Every shipped AI Centre catalogue carries today.loops in full, so the English fallback is pinned on a Thai catalogue
// with one label blank and one missing.
vi.mock('../messages/ai-centre/th.json', () => ({ default: { today: { loops: { clockOutReasonForgot: '' } } } }));

import { GET } from '../app/api/mobile/v2/today/route';
import { POST as clockOutPOST } from '../app/api/mobile/v2/today/clock-out/route';
import { POST as undoPOST } from '../app/api/mobile/v2/today/undo/route';
import { HomeAccessError } from '../core/employee-home';
import { recordGaps, stepDestination } from '../core/mobile-today';
import { AuthRequiredError } from '../lib/auth-errors';
import { mobileTranslator } from '../lib/mobile-api/server-text';
import { PAYROLL_ITEM_KINDS } from '../lib/pre-salary/items';
import { CLOCK_OUT_REFUSALS_V2, LOOP_UNDO_REFUSALS_V2, TODAY_STEP_KINDS, TODAY_STEP_LIMIT, TodayV2 } from '../lib/mobile-api/v2/today';

const EMP = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const CASE_CLOCK = '33333333-3333-4333-8333-333333333331';
const CASE_RECORD = '33333333-3333-4333-8333-333333333332';
const CASE_RECORD_UNLABELLED = '33333333-3333-4333-8333-333333333333';
const CASE_PASSPORT = '33333333-3333-4333-8333-333333333334';
const ACTION = '44444444-4444-4444-8444-444444444444';
const principal = { tenantId: 'tenant-a', userId: 'user-a', personId: 'person-a', roles: ['employee'], grants: [{ role: 'employee', companyId: 'company-a' }] };
const URL0 = 'https://hr.example.com/api/mobile/v2';

const item = (p: Record<string, unknown>) => ({ endDate: undefined, label: undefined, state: 'todo', action: { kind: 'open', href: '/web/only' }, ...p });
const readinessValue = (items: unknown[] = [
  item({ key: `missed_clock_out:2026-11-10`, group: 'attendance', kind: 'missed_clock_out', date: '2026-11-10', due: '2026-11-20',
    action: { kind: 'confirm', card: 'clockOut', caseId: CASE_CLOCK, date: '2026-11-10', checkIn: '09:02', proposedCheckOut: '18:00', href: '/attendance/my-records/2026-11-10' } }),
  item({ key: 'missed_clock_in:2026-11-11', group: 'attendance', kind: 'missed_clock_in', date: '2026-11-11', due: '2026-11-20' }),
  item({ key: 'leave_certificate_missing:l1', group: 'leave', kind: 'leave_certificate_missing', date: '2026-11-03', endDate: '2026-11-04', due: '2026-11-20', label: 'Fictional Medical Leave' }),
  item({ key: `bank_missing:${EMP}`, group: 'details', kind: 'bank_missing', date: null, due: '2026-11-20' }),
  item({ key: 'claim_draft:c1', group: 'claims', kind: 'claim_draft', date: '2026-11-05', due: '2026-11-18', label: 'Fictional Travel' }),
  item({ key: 'letter_acknowledge:a1', group: 'acknowledge', kind: 'letter_acknowledge', date: '2026-11-06', due: '2026-11-20' }),
  item({ key: 'leave_pending:l2', group: 'leave', kind: 'leave_pending', state: 'waiting', date: '2026-11-24', due: '2026-11-20' }),
  item({ key: 'approve_leave:t1', group: 'approvals', kind: 'approve_leave', date: null, due: '2026-11-20' }),
], failed = false) => ({ period: { payPeriod: '2026-11', start: '2026-11-01', cutOff: '2026-11-20', source: 'company' }, items, approvals: [], groups: [], failed });
const loopCardsValue = () => [
  { kind: 'clockOut', caseId: CASE_CLOCK, date: '2026-11-10', checkIn: '09:02', proposedCheckOut: '18:00', href: '/attendance/my-records/2026-11-10?checkOut=18%3A00' },
  { kind: 'record', caseId: CASE_RECORD, gaps: ['no_bank_account', 'no_tax_number', 'no_such_gap'], href: '/me?tab=bankStatutory' },
  { kind: 'record', caseId: CASE_RECORD_UNLABELLED, gaps: ['no_such_gap'], href: '/me?tab=profile' },
  { kind: 'passport', caseId: CASE_PASSPORT, expiresOn: '2026-12-01', href: '/me?tab=profile' },
];
const autonomyValue = () => [
  { kind: 'autoFixed', actionId: ACTION, date: '2026-11-11', checkOut: '18:00', undoUntil: '2026-11-12T10:00:00.000Z', employmentId: EMP },
];
const weekRows = () => [
  { date: '2026-11-09', workedMinutes: 480, scheduledMinutes: 540, checkInAt: '2026-11-09T01:00:00Z', checkOutAt: '2026-11-09T10:00:00Z' },
  { date: '2026-11-10', workedMinutes: 470, scheduledMinutes: 540, checkInAt: '2026-11-10T01:10:00Z', checkOutAt: '2026-11-10T10:00:00Z' },
  { date: '2026-11-11', workedMinutes: null, scheduledMinutes: 540, checkInAt: null, checkOutAt: null },
  { date: '2026-11-12', workedMinutes: null, scheduledMinutes: 540, checkInAt: '2026-11-12T01:00:00Z', checkOutAt: null },
  { date: '2026-11-13', workedMinutes: null, scheduledMinutes: 540, checkInAt: null, checkOutAt: null },
];
const calendarValue = () => ({ version: 1, employmentId: EMP, month: '2026-11', today: '2026-11-12', weekStartsOn: 1, payrollEnabled: true, team: null, days: [
  { date: '2026-11-05', canRequestLeave: false, entries: [{ kind: 'leave', date: '2026-11-05', status: 'approved', duration: 'full_day' }] },
  { date: '2026-11-14', canRequestLeave: false, entries: [{ kind: 'holiday', date: '2026-11-14', name: 'Fictional Harvest Day', replacement: false, tentative: false }] },
  { date: '2026-11-15', canRequestLeave: false, entries: [{ kind: 'holiday', date: '2026-11-15', name: 'Fictional Replacement Day', replacement: true, tentative: false }] },
  { date: '2026-11-17', canRequestLeave: true, entries: [{ kind: 'leave', date: '2026-11-17', status: 'approved', duration: 'full_day' }] },
  { date: '2026-11-18', canRequestLeave: true, entries: [{ kind: 'leave', date: '2026-11-18', status: 'pending', duration: 'full_day' }] },
] });

const EXPECTED_REMINDERS = [
  { kind: 'clockOut', caseId: CASE_CLOCK, date: '2026-11-10', checkIn: '09:02', proposedCheckOut: '18:00' },
  { kind: 'record', caseId: CASE_RECORD, gaps: [{ key: 'no_bank_account', label: 'No bank account' }, { key: 'no_tax_number', label: 'No tax number' }], destination: { screen: 'profileEdit' } },
  { kind: 'passport', caseId: CASE_PASSPORT, expiresOn: '2026-12-01', destination: { screen: 'profile' } },
  { kind: 'autoFixed', actionId: ACTION, date: '2026-11-11', checkOut: '18:00', undoUntil: '2026-11-12T10:00:00.000Z' },
];
const step = (p: Record<string, unknown>) => ({ endDate: null, label: null, date: null, ...p });
const EXPECTED_STEPS = [
  step({ key: 'claim_draft:c1', kind: 'claim_draft', due: '2026-11-18', date: '2026-11-05', label: 'Fictional Travel', decider: 'you', destination: null }),
  step({ key: `bank_missing:${EMP}`, kind: 'bank_missing', due: '2026-11-20', decider: 'hr', destination: { screen: 'profileEdit' } }),
  step({ key: 'missed_clock_in:2026-11-11', kind: 'missed_clock_in', due: '2026-11-20', date: '2026-11-11', decider: 'manager', destination: { screen: 'attendanceCorrection', date: '2026-11-11' } }),
  step({ key: 'leave_certificate_missing:l1', kind: 'leave_certificate_missing', due: '2026-11-20', date: '2026-11-03', endDate: '2026-11-04', label: 'Fictional Medical Leave', decider: 'you', destination: { screen: 'leaveHistory' } }),
  step({ key: 'letter_acknowledge:a1', kind: 'letter_acknowledge', due: '2026-11-20', date: '2026-11-06', decider: 'you', destination: null }),
  step({ key: `passport_renew:${CASE_PASSPORT}`, kind: 'passport_renew', due: '2026-12-01', decider: 'hr', destination: { screen: 'profileEdit' } }),
];
/** The steps sent when the reminders are read: the missed clock-out and the passport are reminders, not steps. */
const SHOWN_STEPS = EXPECTED_STEPS.slice(0, 5);
const EXPECTED_HOURS = { status: 'ok', week: { workedMinutes: 950, shiftMinutes: 540, bars: [
  { date: '2026-11-09', state: 'worked', workedMinutes: 480, scheduledMinutes: 540 },
  { date: '2026-11-10', state: 'worked', workedMinutes: 470, scheduledMinutes: 540 },
  { date: '2026-11-11', state: 'none', workedMinutes: null, scheduledMinutes: 540 },
  { date: '2026-11-12', state: 'running', workedMinutes: null, scheduledMinutes: 540 },
  { date: '2026-11-13', state: 'upcoming', workedMinutes: null, scheduledMinutes: 540 },
] } };
const EXPECTED_PAYDAY = { status: 'ok', next: { kind: 'payday', date: '2026-11-28', daysAway: 16 } };
const EXPECTED_COMING_UP = { status: 'ok', items: [
  { date: '2026-11-14', endDate: '2026-11-14', kind: 'holiday', name: 'Fictional Harvest Day' },
  { date: '2026-11-16', endDate: '2026-11-19', kind: 'managerAway', name: 'Fictional Manager' },
  { date: '2026-11-17', endDate: '2026-11-18', kind: 'leave', name: null },
  { date: '2026-11-20', endDate: '2026-11-20', kind: 'cutoff', name: null },
] };
const PANEL_READS = () => [ports.readiness, ports.loopCards, ports.payHints, ports.calendar, ports.week, ports.away, ports.autonomy, ports.modules];

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T02:00:00.000Z')); });
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  ports.session.mockResolvedValue(principal);
  ports.context.mockImplementation(async (_s: unknown, id: string) => {
    if (id !== EMP) throw new HomeAccessError('employmentUnavailable');
    return { identity: { version: 1, role: 'employee', employmentState: 'selected', selectedEmploymentId: EMP, companyEstablished: true, employments: [] }, companyId: 'company-a', hiredOn: '2024-01-01' };
  });
  ports.readiness.mockResolvedValue(readinessValue());
  ports.loopCards.mockResolvedValue(loopCardsValue());
  ports.autonomy.mockResolvedValue(autonomyValue());
  ports.payHints.mockResolvedValue({ payslips: [{ id: 'p1', period: '2026-10', runType: 'regular', runSequence: 1 }], nextPayment: { date: '2026-11-28', period: '2026-11', runType: 'regular' } });
  ports.calendar.mockResolvedValue(calendarValue());
  ports.week.mockResolvedValue(weekRows());
  ports.away.mockResolvedValue([{ employmentId: 'manager-a', name: 'Fictional Manager', from: '2026-11-16', to: '2026-11-19' }]);
  ports.modules.mockReturnValue('on');
  ports.confirm.mockResolvedValue({ kind: 'submitted' });
  ports.undo.mockResolvedValue({ kind: 'undone', by: 'employee' });
});
afterEach(() => { vi.restoreAllMocks(); });

const today = async (query = `employmentId=${EMP}`, headers: Record<string, string> = {}) => {
  const r = await GET(new Request(`${URL0}/today?${query}`, { headers }));
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null };
};
const post = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await handler(new Request(`${URL0}/today/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

describe('GET /api/mobile/v2/today', () => {
  it('answers every section from its owner, parsed by the contract, with no web link and no amount', async () => {
    const r = await today();
    expect(r.status).toBe(200);
    expect(TodayV2.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({
      date: '2026-11-12',
      reminders: { status: 'ok', items: EXPECTED_REMINDERS },
      steps: { status: 'ok', items: SHOWN_STEPS, more: 0, partial: false },
      hours: EXPECTED_HOURS, payday: EXPECTED_PAYDAY, comingUp: EXPECTED_COMING_UP,
    });
    expect(r.text).not.toMatch(/href|\/me\?|\/attendance\/|\/web\/only|runType|payslips/);
    // The proven employment, the caller's locale and the HR day reach the owners; nothing else is asked for.
    expect(ports.context).toHaveBeenCalledWith(principal, EMP);
    expect(ports.readiness).toHaveBeenCalledTimes(1);
    expect(ports.readiness).toHaveBeenCalledWith(principal, EMP, 'en', '2026-11-12');
    expect(ports.loopCards).toHaveBeenCalledTimes(1);
    expect(ports.payHints).toHaveBeenCalledTimes(1);
    expect(ports.calendar).toHaveBeenCalledWith(principal, EMP, '2026-11');
    expect(ports.week).toHaveBeenCalledWith(principal, EMP, '2026-11-12');
    expect(ports.away).toHaveBeenCalledWith(principal, EMP, '2026-11-12');
    // The person's own open undo windows only: not an administrator's view.
    expect(ports.autonomy).toHaveBeenCalledWith(expect.anything(), principal, { scopeIds: [], admin: false });
  });

  it.each([
    ['the loop cards', () => ports.loopCards.mockRejectedValue(Error('secret SQL')), { reminders: { status: 'unavailable' }, steps: 'partial' }],
    ['the open undo windows', () => ports.autonomy.mockRejectedValue(Error('secret SQL')), { reminders: { status: 'unavailable' }, steps: 'undeduped' }],
    ['the week', () => ports.week.mockRejectedValue(Error('secret SQL')), { hours: { status: 'unavailable' } }],
    ['the Home calendar', () => ports.calendar.mockRejectedValue(Error('secret SQL')), { comingUp: { status: 'unavailable' } }],
    ['the managers away', () => ports.away.mockRejectedValue(Error('secret SQL')), { comingUp: { status: 'unavailable' } }],
    ['the pay hints', () => ports.payHints.mockRejectedValue(Error('secret SQL')), { payday: { status: 'ok', next: { kind: 'cutoff', date: '2026-11-20', daysAway: 8 } }, comingUp: { status: 'unavailable' } }],
  ] as const)('a failure reading %s leaves only its own sections unavailable', async (_name, fail, changed) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail();
    const r = await today();
    expect(r.status).toBe(200);
    expect(TodayV2.safeParse(r.body).success).toBe(true);
    const steps = 'steps' in changed
      ? changed.steps === 'partial'
        // No loop cards: no passport step, no clock-out reminder to dedupe against, and never all clear.
        ? { status: 'ok', items: [EXPECTED_STEPS[0], EXPECTED_STEPS[1], step({ key: 'missed_clock_out:2026-11-10', kind: 'missed_clock_out', due: '2026-11-20', date: '2026-11-10', decider: 'manager', destination: { screen: 'attendanceCorrection', date: '2026-11-10' } }), ...EXPECTED_STEPS.slice(2, 5)], more: 0, partial: true }
        // Neither the clock-out nor the passport card is on screen as a reminder, so both steps stay.
        : { status: 'ok', items: [EXPECTED_STEPS[0], EXPECTED_STEPS[1], step({ key: 'missed_clock_out:2026-11-10', kind: 'missed_clock_out', due: '2026-11-20', date: '2026-11-10', decider: 'manager', destination: { screen: 'attendanceCorrection', date: '2026-11-10' } }), ...EXPECTED_STEPS.slice(2)], more: 0, partial: false }
      : { status: 'ok', items: SHOWN_STEPS, more: 0, partial: false };
    const { steps: _ignored, ...sections } = changed as Record<string, unknown>;
    expect(r.body).toEqual({ date: '2026-11-12', reminders: { status: 'ok', items: EXPECTED_REMINDERS }, hours: EXPECTED_HOURS, payday: EXPECTED_PAYDAY,
      comingUp: EXPECTED_COMING_UP, ...sections, steps });
    // The log names the section, never the cause.
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret SQL');
  });

  it('a failed checklist read is never all clear: steps are partial, payday shows what was read, coming up is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.readiness.mockRejectedValue(Error('secret SQL'));
    const r = await today();
    // The passport is a reminder, so no step is left, and the empty list is partial, never all clear.
    expect(r.body.steps).toEqual({ status: 'ok', items: [], more: 0, partial: true });
    expect(r.body.payday).toEqual(EXPECTED_PAYDAY);
    expect(r.body.comingUp).toEqual({ status: 'unavailable' });
    expect(r.body.hours).toEqual(EXPECTED_HOURS);
    // A checklist group the owner could not read is partial too, as the web's Next step panel says.
    ports.readiness.mockResolvedValue(readinessValue(undefined, true));
    expect((await today()).body.steps).toMatchObject({ status: 'ok', partial: true });
    // Neither step source: unavailable, never an empty list.
    ports.readiness.mockRejectedValue(Error('secret SQL'));
    ports.loopCards.mockRejectedValue(Error('secret SQL'));
    expect((await today()).body.steps).toEqual({ status: 'unavailable' });
  });

  it('a signed-out caller is 401 for the whole response, never a section marked unavailable', async () => {
    ports.week.mockRejectedValue(new AuthRequiredError('revoked'));
    const r = await today();
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'auth_required' });
  });

  it('a module not in use is off; an entitlement that could not be resolved is unavailable', async () => {
    ports.modules.mockImplementation((_s: unknown, code: string) => (code === 'attendance' || code === 'payroll' ? 'off' : 'on'));
    let r = await today();
    expect(r.body.hours).toEqual({ status: 'off' });
    expect(r.body.payday).toEqual({ status: 'off' });
    expect(ports.week).not.toHaveBeenCalled();
    expect(ports.payHints).not.toHaveBeenCalled();
    // Without payroll there is no payday in Coming up; the checklist's cut-off is still its own.
    expect(r.body.comingUp).toEqual(EXPECTED_COMING_UP);
    expect(ports.modules).toHaveBeenCalledWith(principal, 'attendance', 'company-a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.modules.mockImplementation((_s: unknown, code: string) => (code === 'attendance' || code === 'payroll' ? 'failed' : 'on'));
    r = await today();
    expect(r.body.hours).toEqual({ status: 'unavailable' });
    expect(r.body.payday).toEqual({ status: 'unavailable' });
    expect(r.body.comingUp).toEqual({ status: 'unavailable' });
    expect(r.body.reminders).toEqual({ status: 'ok', items: EXPECTED_REMINDERS });
  });

  it('refuses a foreign or stale employment before any section reads, and a missing one before anything is read', async () => {
    const foreign = await today(`employmentId=${FOREIGN}`);
    expect(foreign.status).toBe(400);
    expect(foreign.body).toEqual({ error: 'bad_request' });
    expect(ports.context).toHaveBeenCalledWith(principal, FOREIGN);
    for (const read of PANEL_READS()) expect(read).not.toHaveBeenCalled();
    // The owner's answer for another selection than the one asked for is the same refusal.
    ports.context.mockResolvedValueOnce({ identity: { version: 1, role: 'employee', employmentState: 'selected', selectedEmploymentId: FOREIGN, companyEstablished: true, employments: [] }, companyId: 'company-a', hiredOn: null });
    expect((await today()).status).toBe(400);
    ports.context.mockClear();
    for (const query of ['', 'employmentId=', 'employmentId=not-a-uuid', `employmentId=${EMP}&employmentId=${EMP}`]) {
      const r = await today(query);
      expect(r.status, query).toBe(400);
    }
    expect(ports.context).not.toHaveBeenCalled();
    for (const read of PANEL_READS()) expect(read).not.toHaveBeenCalled();
    // A signed-out caller reads nothing.
    ports.session.mockRejectedValueOnce(new AuthRequiredError());
    expect((await today()).status).toBe(401);
    expect(ports.context).not.toHaveBeenCalled();
  });

  it('labels record gaps in the caller\'s language and leaves out a gap with no label', async () => {
    const r = await today(`employmentId=${EMP}&locale=ms`);
    expect(r.body.reminders.items[1]).toEqual({ kind: 'record', caseId: CASE_RECORD,
      gaps: [{ key: 'no_bank_account', label: 'Tiada akaun bank' }, { key: 'no_tax_number', label: 'Tiada nombor cukai' }], destination: { screen: 'profileEdit' } });
    // A card whose every gap is unlabelled is not sent at all.
    expect(r.text).not.toContain(CASE_RECORD_UNLABELLED);
    expect(recordGaps(['no_bank_account', 'no_bank_account', '', 'x'.repeat(81), 'no_such_gap'], (key) => (key === 'no_such_gap' ? null : key))).toEqual([{ key: 'no_bank_account', label: 'no_bank_account' }]);
  });

  it('leaves out a passport step only while that passport\'s own card is a reminder', async () => {
    let r = await today();
    expect(r.body.reminders.items).toContainEqual({ kind: 'passport', caseId: CASE_PASSPORT, expiresOn: '2026-12-01', destination: { screen: 'profile' } });
    expect(r.body.steps.items.map((s: { kind: string }) => s.kind)).not.toContain('passport_renew');
    // Twenty clock-out cards fill the reminders (the contract's limit), so the passport is not on screen as a reminder:
    // its step is sent, and so is the missed clock-out whose card is not among them.
    const clockOuts = Array.from({ length: 20 }, (_, i) => ({ kind: 'clockOut', caseId: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
      date: `2026-10-${String(i + 1).padStart(2, '0')}`, checkIn: '09:00', proposedCheckOut: '18:00', href: '/attendance/my-records' }));
    ports.loopCards.mockResolvedValue([...clockOuts, loopCardsValue()[3]]);
    r = await today();
    expect(r.body.reminders.items).toHaveLength(20);
    expect(r.body.reminders.items.every((item: { kind: string }) => item.kind === 'clockOut')).toBe(true);
    expect(r.body.steps.items.map((s: { key: string }) => s.key)).toEqual(['claim_draft:c1', `bank_missing:${EMP}`, 'missed_clock_out:2026-11-10',
      'missed_clock_in:2026-11-11', 'leave_certificate_missing:l1', 'letter_acknowledge:a1', `passport_renew:${CASE_PASSPORT}`]);
  });

  it('sends at most TODAY_STEP_LIMIT steps and counts the rest in `more`', async () => {
    const many = Array.from({ length: TODAY_STEP_LIMIT + 3 }, (_, i) => item({ key: `claim_draft:c${String(i).padStart(2, '0')}`, group: 'claims', kind: 'claim_draft', date: '2026-11-05', due: '2026-11-18', label: 'Fictional Travel' }));
    ports.readiness.mockResolvedValue(readinessValue(many));
    ports.loopCards.mockResolvedValue([]);
    const r = await today();
    expect(r.body.steps.items).toHaveLength(TODAY_STEP_LIMIT);
    expect(r.body.steps.more).toBe(3);
    expect(r.body.steps.items[0].key).toBe('claim_draft:c00');
  });
});

describe('step destinations', () => {
  it('maps every step kind the app knows to its closed list of screens', () => {
    const at = (kind: string, date: string | null = '2026-11-11') => stepDestination({ kind: kind as never, date });
    expect(at('missed_clock_in')).toEqual({ screen: 'attendanceCorrection', date: '2026-11-11' });
    expect(at('missed_clock_out')).toEqual({ screen: 'attendanceCorrection', date: '2026-11-11' });
    expect(at('absent_no_leave')).toEqual({ screen: 'attendanceCorrection', date: '2026-11-11' });
    expect(at('late_or_early')).toEqual({ screen: 'attendanceDay', date: '2026-11-11' });
    expect(at('attendance_request_pending')).toEqual({ screen: 'attendanceDay', date: '2026-11-11' });
    expect(at('missed_clock_in', null)).toBeNull();
    for (const kind of ['leave_pending', 'leave_unpaid', 'leave_certificate_missing']) expect(at(kind)).toEqual({ screen: 'leaveHistory' });
    for (const kind of ['bank_missing', 'tax_number_missing', 'epf_number_missing', 'socso_number_missing', 'identity_missing', 'details_request_pending',
      'tp3_new_joiner', 'tp1_draft', 'tp1_pending', 'dependants_mismatch', 'passport_renew']) expect(at(kind, null), kind).toEqual({ screen: 'profileEdit' });
    for (const kind of ['overtime_pending', 'overtime_over_cap', 'claim_deadline', 'claim_receipt_missing', 'claim_draft', 'claim_pending', 'toil_pending',
      'letter_acknowledge', 'notice_acknowledge', 'review_acknowledge', 'onboarding_acknowledge']) expect(at(kind), kind).toBeNull();
  });

  it('TODAY_STEP_KINDS is the checklist\'s kinds without approvals, plus passport_renew', () => {
    const { approvals: _approvals, ...own } = PAYROLL_ITEM_KINDS;
    expect([...TODAY_STEP_KINDS].sort()).toEqual([...Object.values(own).flat(), 'passport_renew'].sort());
  });
});

describe('POST /api/mobile/v2/today/clock-out', () => {
  const command = (p: Record<string, unknown> = {}) => ({ caseId: CASE_CLOCK, reason: 'forgot', confirm: true, ...p });

  it('sends the reason as its label in the caller\'s language, or the words typed for Other', async () => {
    expect(await post(clockOutPOST, 'clock-out', command(), { 'accept-language': 'ms-MY,ms;q=0.9' })).toEqual({ status: 200, body: { outcome: 'submitted' } });
    expect(ports.confirm).toHaveBeenLastCalledWith(principal, { caseId: CASE_CLOCK, reason: 'Terlupa merekod keluar', confirm: true });
    await post(clockOutPOST, 'clock-out', command({ reason: 'device' }));
    expect(ports.confirm).toHaveBeenLastCalledWith(principal, { caseId: CASE_CLOCK, reason: 'Device problem', confirm: true });
    await post(clockOutPOST, 'clock-out', command({ reason: 'other', other: '  Left early   for a clinic visit ' }), { 'accept-language': 'zh' });
    expect(ports.confirm).toHaveBeenLastCalledWith(principal, { caseId: CASE_CLOCK, reason: 'Left early for a clinic visit', confirm: true });
  });

  it('refuses anything but an explicit Confirm, an unknown reason or an extra field, before the owner runs', async () => {
    for (const body of [command({ confirm: false }), command({ confirm: 'true' }), command({ confirm: 1 }), { caseId: CASE_CLOCK, reason: 'forgot' },
      command({ reason: 'approve' }), command({ reason: 'other' }), command({ reason: 'other', other: '' }), command({ reason: 'other', other: 'x'.repeat(501) }),
      command({ caseId: 'not-a-case' }), command({ date: '2026-11-10' }), command({ proposedCheckOut: '18:00' }), command({ other: 'only for Other' })]) {
      expect(await post(clockOutPOST, 'clock-out', body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    // Whitespace alone for Other is no reason: refused, and the owner never runs.
    expect(await post(clockOutPOST, 'clock-out', command({ reason: 'other', other: '    ' }))).toEqual({ status: 200, body: { outcome: 'refused', code: 'invalid' } });
    expect(ports.confirm).not.toHaveBeenCalled();
  });

  it('answers each owner refusal with its own code', async () => {
    for (const code of CLOCK_OUT_REFUSALS_V2) {
      ports.confirm.mockResolvedValueOnce({ kind: 'refused', reason: code });
      expect(await post(clockOutPOST, 'clock-out', command())).toEqual({ status: 200, body: { outcome: 'refused', code } });
    }
  });

  it('a repeated Confirm after a lost response goes to the owner again, which answers `pending` rather than sending a second request', async () => {
    // The owner's own answer to a second Confirm for a day that already has a waiting correction
    // (test/loop-clock-out-confirm.test.ts and test/mobile-v2-today-clock-out.test.ts prove it on the database).
    ports.confirm.mockResolvedValueOnce({ kind: 'submitted' }).mockResolvedValueOnce({ kind: 'refused', reason: 'pending' });
    expect((await post(clockOutPOST, 'clock-out', command())).body).toEqual({ outcome: 'submitted' });
    expect((await post(clockOutPOST, 'clock-out', command())).body).toEqual({ outcome: 'refused', code: 'pending' });
    expect(ports.confirm).toHaveBeenCalledTimes(2);
    expect(ports.confirm.mock.calls[0]).toEqual(ports.confirm.mock.calls[1]);
  });
});

describe('POST /api/mobile/v2/today/undo', () => {
  it('undoes through the owner and maps each refusal', async () => {
    expect(await post(undoPOST, 'undo', { actionId: ACTION, confirm: true })).toEqual({ status: 200, body: { outcome: 'undone' } });
    expect(ports.undo).toHaveBeenLastCalledWith(principal, { actionId: ACTION, confirm: true });
    for (const code of LOOP_UNDO_REFUSALS_V2) {
      ports.undo.mockResolvedValueOnce({ kind: 'refused', reason: code });
      expect(await post(undoPOST, 'undo', { actionId: ACTION, confirm: true })).toEqual({ status: 200, body: { outcome: 'refused', code } });
    }
  });
  it('refuses anything but an explicit Confirm before the owner runs', async () => {
    for (const body of [{ actionId: ACTION, confirm: false }, { actionId: ACTION }, { actionId: 'x', confirm: true }, { actionId: ACTION, confirm: true, by: 'hr' }]) {
      expect(await post(undoPOST, 'undo', body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(ports.undo).not.toHaveBeenCalled();
  });
});

describe('server text from the AI Centre catalogue', () => {
  it('resolves today.loops in Malay and falls back to English for a blank or missing label', async () => {
    const ms = await mobileTranslator('ms', 'today.loops', 'aiCentre');
    expect(ms('clockOutReasonForgot')).toBe('Terlupa merekod keluar');
    expect(ms('noSuchKey')).toBeNull();
    const th = await mobileTranslator('th', 'today.loops', 'aiCentre');
    expect(th('clockOutReasonForgot')).toBe('Forgot to clock out');
    expect(th('clockOutReasonDevice')).toBe('Device problem');
    expect(th('noSuchKey')).toBeNull();
    // The Confirm route uses the same fallback.
    await post(clockOutPOST, 'clock-out', { caseId: CASE_CLOCK, reason: 'forgot', confirm: true }, { 'accept-language': 'th' });
    expect(ports.confirm).toHaveBeenLastCalledWith(principal, { caseId: CASE_CLOCK, reason: 'Forgot to clock out', confirm: true });
    // The web catalogue is the default and does not carry today.loops.
    expect((await mobileTranslator('ms', 'today.loops'))('clockOutReasonForgot')).toBeNull();
    expect((await mobileTranslator('ms', 'controlTower.readinessScreen.gap'))('no_bank_account')).toBe('Tiada akaun bank');
  });
});
