/**
 * D8 — the pure shift-reminder plan (mobile/lib/shift-reminders.ts). `now` is an input, so a fixed instant is the
 * clock here: nothing reads the real time and no date can age into a failure.
 *
 * Pinned: 15 minutes before each shift start and 30 minutes after each shift end, only within the next 7 days and only
 * in the future; wall times in the zone the SERVER names (a different zone moves every instant; the device's zone is
 * never read); an overnight shift ends on the next calendar day as the roster reports it; rest/off/none days and days
 * the engine marks on leave, holiday or rest get nothing; a clock-in cancels the start reminder and a clock-out (last
 * punch out) cancels the forgot-out reminder; a started day with no clock-in gets no forgot-out reminder unless the
 * records could not be read; deterministic ids and order, so a re-plan of the same answers is identical (idempotent).
 */
import { describe, expect, it } from 'vitest';
import {
  FORGOT_OUT_AFTER_MINUTES, HORIZON_DAYS, REMINDER_PREFIX, START_LEAD_MINUTES, addDays, isShiftReminder, planShiftReminders, reminderWindow, zonedInstant,
  type RecordsAnswer, type RosterAnswer,
} from '../mobile/lib/shift-reminders';

const KL = 'Asia/Kuala_Lumpur';
const MIN = 60_000;
/** 08:00 in Kuala Lumpur on Monday 2 November 2026. */
const NOW = Date.UTC(2026, 10, 2, 0, 0);
type Day = RosterAnswer['days'][number];
const shift = (date: string, start: string, end: string, crossesMidnight = false, kind: Day['kind'] = 'shift'): Day =>
  ({ date, kind, shift: { code: 'S', name: 'Shift', start, end, crossesMidnight, workingMinutes: 480 }, plannedMinutes: 480, note: null });
const bare = (date: string, kind: Day['kind']): Day => ({ date, kind, shift: null, plannedMinutes: 0, note: null });
const roster = (days: Day[], timeZone = KL): RosterAnswer => ({ enabled: true, timeZone, days });
type RecordDay = RecordsAnswer['days'][number];
const record = (date: string, over: { punches?: RecordDay['punches']; context?: RecordDay['schedule']['context']; checkIn?: string | null; checkOut?: string | null } = {}): RecordDay => ({
  date,
  schedule: { shiftCode: 'S', start: '09:00', end: '18:00', crossesMidnight: false, scheduledMinutes: 480, rosteredRest: false, dayType: 'workday', context: over.context ?? null },
  punches: over.punches ?? [],
  outcome: { recorded: !!over.punches?.length, checkIn: over.checkIn ?? null, checkOut: over.checkOut ?? null, workedMinutes: null, lateMinutes: null, earlyOutMinutes: null, status: null },
  exception: null,
});
const records = (days: RecordDay[]): RecordsAnswer => ({ enabled: true, days });
const kl = (date: string, time: string) => zonedInstant(date, time, KL)!;
const ids = (plan: { id: string }[]) => plan.map((p) => p.id);

describe('wall time in the server-named zone', () => {
  it('converts a Kuala Lumpur wall time to its instant, and another zone to its own', () => {
    expect(zonedInstant('2026-11-03', '09:00', KL)).toBe(Date.UTC(2026, 10, 3, 1, 0));
    expect(zonedInstant('2026-11-03', '09:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 3, 0, 0));
    expect(zonedInstant('2026-11-03', '00:00', 'UTC')).toBe(Date.UTC(2026, 10, 3));
  });
  it('plans nothing for a time that does not exist there, an unknown zone or malformed input', () => {
    expect(zonedInstant('2026-03-08', '02:30', 'America/New_York')).toBeNull(); // the spring-forward gap
    expect(zonedInstant('2026-11-03', '09:00', 'Not/AZone')).toBeNull();
    expect(zonedInstant('2026-11-3', '09:00', KL)).toBeNull();
    expect(zonedInstant('2026-11-03', '24:00', KL)).toBeNull();
  });
  it('reads a window that holds every zone’s next seven days', () => {
    expect(reminderWindow(NOW)).toEqual({ from: '2026-10-31', to: '2026-11-10' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('planShiftReminders', () => {
  it('15 minutes before each start and 30 after each end, an overnight end on the next day, soonest first', () => {
    const plan = planShiftReminders(roster([shift('2026-11-02', '09:00', '18:00'), shift('2026-11-03', '22:00', '06:00', true), bare('2026-11-04', 'rest'), bare('2026-11-05', 'off'), bare('2026-11-06', 'none'), shift('2026-11-07', '08:30', '17:30', false, 'usual')]), null, NOW);
    expect(plan).toEqual([
      { id: `${REMINDER_PREFIX}start:2026-11-02`, kind: 'start', date: '2026-11-02', at: kl('2026-11-02', '09:00') - START_LEAD_MINUTES * MIN },
      { id: `${REMINDER_PREFIX}forgotOut:2026-11-02`, kind: 'forgotOut', date: '2026-11-02', at: kl('2026-11-02', '18:00') + FORGOT_OUT_AFTER_MINUTES * MIN },
      { id: `${REMINDER_PREFIX}start:2026-11-03`, kind: 'start', date: '2026-11-03', at: kl('2026-11-03', '21:45') },
      { id: `${REMINDER_PREFIX}forgotOut:2026-11-03`, kind: 'forgotOut', date: '2026-11-03', at: kl('2026-11-04', '06:30') },
      { id: `${REMINDER_PREFIX}start:2026-11-07`, kind: 'start', date: '2026-11-07', at: kl('2026-11-07', '08:15') },
      { id: `${REMINDER_PREFIX}forgotOut:2026-11-07`, kind: 'forgotOut', date: '2026-11-07', at: kl('2026-11-07', '18:00') },
    ]);
    for (const p of plan) expect(isShiftReminder(p.id)).toBe(true);
  });

  it('only the future and only the next seven days', () => {
    const plan = planShiftReminders(roster([
      shift('2026-11-01', '22:00', '06:00', true), // ended 06:00 today: start and forgot-out (06:30) are both past
      shift('2026-11-09', '07:00', '16:00'), // 06:45 on the 9th is inside the horizon (08:00 + 7 days); 16:30 is not
      shift('2026-11-10', '09:00', '18:00'), // wholly after the horizon
    ]), null, NOW);
    const horizon = NOW + HORIZON_DAYS * 86_400_000;
    for (const p of plan) { expect(p.at).toBeGreaterThan(NOW); expect(p.at).toBeLessThanOrEqual(horizon); }
    expect(ids(plan)).toEqual([`${REMINDER_PREFIX}start:2026-11-09`]);
    // Ends 07:45 today: its forgot-out reminder (08:15) is still ahead.
    expect(ids(planShiftReminders(roster([shift('2026-11-01', '23:00', '07:45', true)]), null, NOW))).toEqual([`${REMINDER_PREFIX}forgotOut:2026-11-01`]);
  });

  it('the same roster in another zone moves every reminder; the device zone is never read', () => {
    const days = [shift('2026-11-03', '09:00', '18:00')];
    const inKl = planShiftReminders(roster(days, KL), null, NOW), inTokyo = planShiftReminders(roster(days, 'Asia/Tokyo'), null, NOW);
    expect(inTokyo.map((p) => p.at)).toEqual(inKl.map((p) => p.at - 60 * MIN));
  });

  it('nothing on a day the engine knows as leave, holiday or rest', () => {
    const days = [shift('2026-11-03', '09:00', '18:00'), shift('2026-11-04', '09:00', '18:00'), shift('2026-11-05', '09:00', '18:00'), shift('2026-11-06', '09:00', '18:00')];
    const plan = planShiftReminders(roster(days), records([record('2026-11-03', { context: 'on_leave' }), record('2026-11-04', { context: 'holiday' }), record('2026-11-05', { context: 'rest_day' })]), NOW);
    expect(new Set(plan.map((p) => p.date))).toEqual(new Set(['2026-11-06']));
  });

  it('a clock-in cancels the start reminder; a clock-out (last punch out) cancels the forgot-out reminder', () => {
    const days = [shift('2026-11-02', '09:00', '18:00')];
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02', { punches: [{ at: '07:55', direction: 'in' }] })]), NOW))).toEqual([`${REMINDER_PREFIX}forgotOut:2026-11-02`]);
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02', { punches: [{ at: '07:55', direction: 'in' }, { at: '07:58', direction: 'out' }] })]), NOW))).toEqual([]);
    // In again after an out: still at work, so the forgot-out reminder stays.
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02', { punches: [{ at: '07:50', direction: 'in' }, { at: '07:52', direction: 'out' }, { at: '07:55', direction: 'in' }] })]), NOW)))
      .toEqual([`${REMINDER_PREFIX}forgotOut:2026-11-02`]);
    // A stored check-out with no punch rows (an imported or corrected day) counts too.
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02', { checkIn: '07:55', checkOut: '07:59' })]), NOW))).toEqual([]);
  });

  it('a started day with no clock-in gets no forgot-out reminder, unless the records could not be read', () => {
    const days = [shift('2026-11-02', '07:00', '16:00')];
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02')]), NOW))).toEqual([]);
    expect(ids(planShiftReminders(roster(days), null, NOW))).toEqual([`${REMINDER_PREFIX}forgotOut:2026-11-02`]);
    expect(ids(planShiftReminders(roster(days), records([record('2026-11-02', { punches: [{ at: '07:05', direction: 'in' }] })]), NOW))).toEqual([`${REMINDER_PREFIX}forgotOut:2026-11-02`]);
  });

  it('a re-plan of the same answers is identical; attendance off or unusable rows plan nothing', () => {
    const answer = roster([shift('2026-11-03', '09:00', '18:00'), shift('2026-11-04', '22:00', '06:00', true)]);
    expect(planShiftReminders(answer, null, NOW)).toEqual(planShiftReminders(answer, null, NOW));
    expect(new Set(ids(planShiftReminders(answer, null, NOW))).size).toBe(4);
    expect(planShiftReminders({ ...answer, enabled: false }, null, NOW)).toEqual([]);
    expect(planShiftReminders(null, null, NOW)).toEqual([]);
    const broken = { ...shift('2026-11-03', '09:00', '18:00'), shift: { code: 'S', name: 'S', start: null, end: '18:00', crossesMidnight: false, workingMinutes: 0 } };
    expect(planShiftReminders(roster([broken, shift('2026-11-04', '18:00', '09:00')]), null, NOW)).toEqual([]); // no start; an end before its start without crossing midnight
  });
});
