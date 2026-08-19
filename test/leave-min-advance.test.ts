/**
 * Minimum Advance Days rule for leave types (0159 / feedback 0b0fb6c3 Scenario 1).
 *
 * Each leave type carries an optional `minAdvanceDays`: a leave request whose START date arrives with fewer
 * than that many days of notice from "today" is rejected for ordinary employees with a typed, localized
 * LeaveAdvanceNoticeRequiredError BEFORE any write. null ⇒ no requirement (existing behaviour). Exactly N
 * days of notice is allowed ("at least N days before"). A backdated start always lacks notice. HR admins
 * (isAdmin) bypass the rule (the override path) and the override is stamped onto the created leave-request
 * event for audit. Admins may attach a per-type custom block message through the EXISTING
 * leave_type.custom_messages JSONB (0147) under the `minAdvanceDays` rule key; when set, requestLeave passes
 * it through the typed error VERBATIM and localizeLeaveError renders it as-is instead of the interpolated
 * default. Mirrors test/leave-backdating.test.ts + test/leave-custom-messages.test.ts end-to-end.
 *
 * ADVANCE NOTICE — CALENDAR DAYS OR WORKING DAYS (feedback 7daac043, migration 0447). The requirement above
 * is now read in a configurable UNIT, `leave_type.min_advance_day_type`. NULL — every row in every existing
 * database, because 0447 backfills nothing — means calendar days, so everything the paragraph above
 * describes is still exactly what an unconfigured type does. 'working_days' counts only the days the
 * employee is rostered to work, over the HALF-OPEN window [today, startDate): the start date itself is
 * counted in neither unit, which is what keeps "7 calendar" and "7 working" in step on a week with no
 * weekend in it. The golden cases below assert the null-column behaviour is byte-identical; the
 * working-days cases assert the same request that a calendar reading LETS THROUGH is refused once the unit
 * changes, because that difference is the entire point of the reporter's request.
 *
 * Harness note (same as leave-backdating): the block path requires a NON-admin, employee-linked ctx whose
 * personId owns the employmentId it applies for — leave_request RLS is WITH CHECK app.can_see_employment,
 * so an unrelated ctx would fail the insert for a different reason and false-green the assertion.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  lacksMinAdvanceNotice,
  lacksMinAdvanceNoticeIn,
  noticeDaysGiven,
  resolveAdvanceNoticeDayType,
  LeaveAdvanceNoticeRequiredError,
} from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;

/** Hire an employee (as admin) and return its OWN non-admin employee ctx + ids. */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'MinAdvance', primaryEmail: `ma_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** A unique leave-type code matching the leave_type_code_shape check (^[A-Z][A-Z0-9_]{1,31}$). */
function uniqCode(): string {
  return `MA_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a calendar-counted leave type with a (nullable) min-advance requirement + optional custom messages.
 *  `minAdvanceDayType` is left NULL by default — the pre-0447 state of every existing row, and the state the
 *  golden cases in this file assert is unchanged. */
async function leaveType(
  code: string,
  minAdvanceDays: number | null,
  customMessages?: Record<string, string> | null,
  minAdvanceDayType?: 'calendar_days' | 'working_days' | null,
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      minAdvanceDays,
      minAdvanceDayType: minAdvanceDayType ?? null,
      customMessages: customMessages ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** A NATIONAL public holiday (state + company both null), the plainest row the holiday resolver admits. */
async function addHoliday(date: string): Promise<void> {
  await owner.db
    .insert(schema.holiday)
    .values({ tenantId: b.tenantId, country: 'MY', holidayDate: date, name: `PH ${date}` });
}

/** Count leave_request rows for an employment (owner connection bypasses RLS — pure assertion read). */
async function requestCount(employmentId: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveRequest.id })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
  return rows.length;
}

/** Shift an ISO yyyy-mm-dd by N days (negative = into the past). */
function shift(today: string, deltaDays: number): string {
  const ms = Date.parse(`${today}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const TODAY = '2026-06-15';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('lacksMinAdvanceNotice (pure predicate)', () => {
  it('null requirement ⇒ never blocked', () => {
    expect(lacksMinAdvanceNotice(shift(TODAY, +1), TODAY, null)).toBe(false);
    expect(lacksMinAdvanceNotice(shift(TODAY, -365), TODAY, null)).toBe(false);
  });
  it('exactly at the requirement ⇒ allowed ("at least N days before")', () => {
    // start is 7 days after today; min 7 ⇒ daysBetween == 7, not < 7 ⇒ allowed
    expect(lacksMinAdvanceNotice(shift(TODAY, +7), TODAY, 7)).toBe(false);
  });
  it('under the requirement ⇒ blocked (the reporter\'s Scenario 1: 5 days of notice, min 7)', () => {
    expect(lacksMinAdvanceNotice(shift(TODAY, +5), TODAY, 7)).toBe(true);
  });
  it('a backdated start always lacks notice', () => {
    expect(lacksMinAdvanceNotice(shift(TODAY, -3), TODAY, 7)).toBe(true);
  });
  it('min 0 blocks only past start dates (today itself is allowed)', () => {
    expect(lacksMinAdvanceNotice(shift(TODAY, -1), TODAY, 0)).toBe(true);
    expect(lacksMinAdvanceNotice(TODAY, TODAY, 0)).toBe(false);
    expect(lacksMinAdvanceNotice(shift(TODAY, +1), TODAY, 0)).toBe(false);
  });
});

// ── 7daac043 · the UNIT the requirement is read in ────────────────────────────────────────────────────
//
// TODAY is Monday 2026-06-15 and the default roster is Mon–Fri, so:
//   → 2026-06-24 (Wed) is 9 calendar days out and 7 WORKING days out (one weekend inside the window);
//   → 2026-06-23 (Tue) is 8 calendar days out and 6 WORKING days out.
// A requirement of 7 therefore lets 2026-06-23 through on the calendar reading and refuses it on the
// working-days one. That single divergence is the whole of the reporter's request, and every case below
// is built on it rather than on a hand-picked number.
const WED_9_CAL_7_WORK = '2026-06-24';
const TUE_8_CAL_6_WORK = '2026-06-23';
const THU_INSIDE_WINDOW = '2026-06-18';
const MON_FRI = [1, 2, 3, 4, 5];

describe('resolveAdvanceNoticeDayType — NULL means calendar days, and so does anything unrecognised', () => {
  it('reads the stored column into exactly one of two readings', () => {
    // NULL is every leave_type row in every existing database: 0447 backfills nothing.
    expect(resolveAdvanceNoticeDayType(null)).toBe('calendar_days');
    expect(resolveAdvanceNoticeDayType(undefined)).toBe('calendar_days');
    expect(resolveAdvanceNoticeDayType('calendar_days')).toBe('calendar_days');
    expect(resolveAdvanceNoticeDayType('working_days')).toBe('working_days');
    // The DB CHECK refuses a third value, but a hand-edited row must not leave the engine guessing: it
    // falls back to the reading that was in force before this column existed.
    expect(resolveAdvanceNoticeDayType('business_days')).toBe('calendar_days');
  });
});

describe('noticeDaysGiven (pure) — the two readings of the same window', () => {
  it('calendar days is the pre-0447 arithmetic, unchanged', () => {
    expect(noticeDaysGiven(TODAY, WED_9_CAL_7_WORK, 'calendar_days')).toBe(9);
    expect(noticeDaysGiven(TODAY, TUE_8_CAL_6_WORK, 'calendar_days')).toBe(8);
  });

  it('working days skips the weekend inside the window', () => {
    expect(noticeDaysGiven(TODAY, WED_9_CAL_7_WORK, 'working_days', MON_FRI, new Set())).toBe(7);
    expect(noticeDaysGiven(TODAY, TUE_8_CAL_6_WORK, 'working_days', MON_FRI, new Set())).toBe(6);
  });

  it('working days also skips a public holiday inside the window', () => {
    expect(noticeDaysGiven(TODAY, WED_9_CAL_7_WORK, 'working_days', MON_FRI, new Set([THU_INSIDE_WINDOW]))).toBe(6);
  });

  it('the window is HALF-OPEN, so the two readings agree when nothing non-working intervenes', () => {
    // Mon → Fri of the same week: 4 whole days of notice on either reading. If the start date itself were
    // counted, working days would report 5 here and "7 working" would be laxer than "7 calendar".
    const friday = '2026-06-19';
    expect(noticeDaysGiven(TODAY, friday, 'calendar_days')).toBe(4);
    expect(noticeDaysGiven(TODAY, friday, 'working_days', MON_FRI, new Set())).toBe(4);
  });

  it('the start date itself is never counted, in either reading', () => {
    expect(noticeDaysGiven(TODAY, TODAY, 'calendar_days')).toBe(0);
    expect(noticeDaysGiven(TODAY, TODAY, 'working_days', MON_FRI, new Set())).toBe(0);
  });

  it('a backdated start gives a negative calendar count and an empty working window', () => {
    // The SIGN differs; the CONCLUSION does not — both still lack any positive requirement, which is the
    // semantics 0159 shipped and this must preserve.
    expect(noticeDaysGiven(TODAY, shift(TODAY, -3), 'calendar_days')).toBe(-3);
    expect(noticeDaysGiven(TODAY, shift(TODAY, -3), 'working_days', MON_FRI, new Set())).toBe(0);
    expect(lacksMinAdvanceNoticeIn(shift(TODAY, -3), TODAY, 7, 'working_days', MON_FRI, new Set())).toBe(true);
  });

  it('an omitted roster falls back to Mon–Fri and no holidays, like resolveSchedule does', () => {
    expect(noticeDaysGiven(TODAY, WED_9_CAL_7_WORK, 'working_days')).toBe(7);
  });
});

describe('lacksMinAdvanceNoticeIn — the 3-arg wrapper is exactly the calendar basis', () => {
  it('the working-days reading refuses what the calendar reading allows', () => {
    // The headline divergence, asserted as one pair on ONE date so the two readings cannot both be right.
    expect(lacksMinAdvanceNoticeIn(TUE_8_CAL_6_WORK, TODAY, 7, 'calendar_days')).toBe(false);
    expect(lacksMinAdvanceNoticeIn(TUE_8_CAL_6_WORK, TODAY, 7, 'working_days', MON_FRI, new Set())).toBe(true);
  });

  it('exactly N working days of notice is allowed ("at least N days before")', () => {
    expect(lacksMinAdvanceNoticeIn(WED_9_CAL_7_WORK, TODAY, 7, 'working_days', MON_FRI, new Set())).toBe(false);
  });

  it('a null requirement is never blocked on either reading', () => {
    expect(lacksMinAdvanceNoticeIn(TUE_8_CAL_6_WORK, TODAY, null, 'working_days', MON_FRI, new Set())).toBe(false);
  });

  it('the 3-arg wrapper agrees with the calendar basis on every case above (one rule, one computation)', () => {
    for (const start of [WED_9_CAL_7_WORK, TUE_8_CAL_6_WORK, TODAY, shift(TODAY, -3), shift(TODAY, +30)]) {
      for (const min of [null, 0, 7]) {
        expect(lacksMinAdvanceNotice(start, TODAY, min)).toBe(
          lacksMinAdvanceNoticeIn(start, TODAY, min, 'calendar_days'),
        );
      }
    }
  });
});

describe('requestLeave — minimum advance-notice rule', () => {
  it('blocks a non-admin under-notice request and persists nothing', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7);
    const start = shift(TODAY, +5); // 5 days of notice, min 7 ⇒ blocked
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY }),
    ).rejects.toThrow(LeaveAdvanceNoticeRequiredError);
    // Orphan-prevention: the throw is before any write, so no leave_request row exists.
    expect(await requestCount(employmentId)).toBe(0);
  });

  it('allows a non-admin request submitted exactly at the required notice', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7);
    const start = shift(TODAY, +7); // exactly 7 days of notice ⇒ allowed
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('back-compat: a null-requirement type never blocks a short-notice request', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), null);
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: shift(TODAY, +1),
      endDate: shift(TODAY, +1),
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('Scenario 1: a custom message wins — the typed error carries it verbatim', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const custom =
      'Please select "Emergency Leave" if your leave application is submitted less than 7 days before the leave start date.';
    const ltId = await leaveType(uniqCode(), 7, { minAdvanceDays: custom });
    const start = shift(TODAY, +5); // 5 days of notice, min 7 ⇒ blocked
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
      const err = e as LeaveAdvanceNoticeRequiredError;
      // The localizer returns `e.customMessage ?? default`, so this is exactly what the employee sees.
      expect(err.customMessage).toBe(custom);
      expect(err.message).toBe(custom);
    }
  });

  it('Scenario 2: no custom message ⇒ error carries none and falls back to the interpolated default', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, null); // no customMessages
    const start = shift(TODAY, +5);
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
      const err = e as LeaveAdvanceNoticeRequiredError;
      expect(err.customMessage).toBeUndefined();
      // The default interpolated message still carries the structured tokens for the localizer.
      expect(err.minDays).toBe(7);
    }
  });

  it('an empty-string custom message for the rule key falls back to the default (treated as absent)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // A raw empty string in the map — the pass-through uses `|| undefined`, so it must NOT become the message.
    const ltId = await leaveType(uniqCode(), 7, { minAdvanceDays: '' });
    const start = shift(TODAY, +5);
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      expect((e as LeaveAdvanceNoticeRequiredError).customMessage).toBeUndefined();
    }
  });

  it('a backdating custom message does NOT leak into the advance-notice error (per-rule keying)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, { backdatingLimitDays: 'wrong rule message' });
    const start = shift(TODAY, +5);
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
      expect((e as LeaveAdvanceNoticeRequiredError).customMessage).toBeUndefined();
    }
  });

  it('lets an HR admin override an under-notice request (row created)', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7);
    const start = shift(TODAY, +5);
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('stamps the override onto the leave-request.submitted event payload', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7);
    const start = shift(TODAY, +5);
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.advanceNoticeOverride).toBe(true);
    expect(payload?.daysInAdvance).toBe(5);
    expect(payload?.minAdvanceDays).toBe(7);
  });

  it('does NOT stamp the override on a normal in-notice admin request', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7);
    const start = shift(TODAY, +10); // enough notice ⇒ not an override
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.advanceNoticeOverride).toBeUndefined();
    expect(payload?.daysInAdvance).toBeUndefined();
  });
});

describe('requestLeave — the requirement read in WORKING days (7daac043)', () => {
  it('THE GOLDEN CASE: a null day-type column behaves byte-identically to before 0447', async () => {
    // 8 calendar days of notice against a requirement of 7. This is the request the working-days reading
    // refuses two cases below; on the column every existing row carries, it must still go through.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7); // minAdvanceDayType left NULL
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: TUE_8_CAL_6_WORK,
      endDate: TUE_8_CAL_6_WORK,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('the SAME request is refused once the type is read in working days', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days'); // 6 working days < 7
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltId,
        startDate: TUE_8_CAL_6_WORK,
        endDate: TUE_8_CAL_6_WORK,
        today: TODAY,
      }),
    ).rejects.toThrow(LeaveAdvanceNoticeRequiredError);
    // Fails before any write, exactly as the calendar reading does.
    expect(await requestCount(employmentId)).toBe(0);
  });

  it('allows a request submitted at exactly N working days of notice', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days'); // 7 working days == 7
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: WED_9_CAL_7_WORK,
      endDate: WED_9_CAL_7_WORK,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('a public holiday inside the window does not count towards the notice given', async () => {
    // Same date that passed at exactly 7 above; one gazetted Thursday inside the window takes it to 6.
    const { ctx, employmentId } = await hireEmployeeCtx();
    await addHoliday(THU_INSIDE_WINDOW);
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days');
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltId,
        startDate: WED_9_CAL_7_WORK,
        endDate: WED_9_CAL_7_WORK,
        today: TODAY,
      }),
    ).rejects.toThrow(LeaveAdvanceNoticeRequiredError);
  });

  it('the typed error says WHICH reading refused it, and the default message says "working day(s)"', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days');
    try {
      await requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltId,
        startDate: TUE_8_CAL_6_WORK,
        endDate: TUE_8_CAL_6_WORK,
        today: TODAY,
      });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
      const err = e as LeaveAdvanceNoticeRequiredError;
      expect(err.dayType).toBe('working_days');
      expect(err.minDays).toBe(7);
      expect(err.message).toContain('working day(s)');
    }
  });

  it('a calendar-days refusal still carries the calendar reading and its original wording', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7); // NULL column
    try {
      await requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltId,
        startDate: shift(TODAY, +5),
        endDate: shift(TODAY, +5),
        today: TODAY,
      });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      const err = e as LeaveAdvanceNoticeRequiredError;
      expect(err.dayType).toBe('calendar_days');
      expect(err.message).not.toContain('working');
    }
  });

  it('a custom message still wins VERBATIM on a working-days type — it is never re-worded', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const custom = 'Please select "Emergency Leave" if you cannot give the required notice.';
    const ltId = await leaveType(uniqCode(), 7, { minAdvanceDays: custom }, 'working_days');
    try {
      await requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltId,
        startDate: TUE_8_CAL_6_WORK,
        endDate: TUE_8_CAL_6_WORK,
        today: TODAY,
      });
      throw new Error('expected LeaveAdvanceNoticeRequiredError');
    } catch (e) {
      const err = e as LeaveAdvanceNoticeRequiredError;
      expect(err.customMessage).toBe(custom);
      expect(err.message).toBe(custom);
    }
  });

  it('an HR override stamps the notice GIVEN in the unit the rule was judged in, and names that unit', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days');
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: TUE_8_CAL_6_WORK,
      endDate: TUE_8_CAL_6_WORK,
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.advanceNoticeOverride).toBe(true);
    // 6 WORKING days, not the 8 calendar days the wall calendar would have reported. The unit rides with it
    // so the record stays readable even after the leave type is reconfigured.
    expect(payload?.daysInAdvance).toBe(6);
    expect(payload?.minAdvanceDays).toBe(7);
    expect(payload?.advanceNoticeDayType).toBe('working_days');
  });

  it('a calendar-days override still stamps the calendar figure, and says so', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 7); // NULL column
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: shift(TODAY, +5),
      endDate: shift(TODAY, +5),
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.daysInAdvance).toBe(5);
    expect(payload?.advanceNoticeDayType).toBe('calendar_days');
  });
});

describe('updateLeaveType — minAdvanceDays tri-state', () => {
  it('sets and reads the value via the admin service + read projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: 7 });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBe(7);
  });

  it('rejects a negative or non-integer requirement', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: -1 })).rejects.toThrow();
    await expect(updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: 2.5 })).rejects.toThrow();
  });

  it('clearing with null removes the requirement (unrestricted again)', async () => {
    const ltId = await leaveType(uniqCode(), 5);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: null });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(types.find((x) => x.id === ltId)?.minAdvanceDays).toBeNull();
  });

  it('a doc-only save leaves minAdvanceDays untouched (independent tri-state)', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    // Touch ONLY the document config — minAdvanceDays is undefined ⇒ must not change.
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', requiresDocument: true });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBe(4);
    expect(t?.requiresDocument).toBe(true);
  });

  it('a backdating-only save leaves minAdvanceDays untouched (the two rules are independent)', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', backdatingLimitDays: 9 });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBe(4);
    expect(t?.backdatingLimitDays).toBe(9);
  });

  it('a doc-only save does NOT claim a minAdvanceDays change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect(before).toBeDefined();
    expect('minAdvanceDays' in (before ?? {})).toBe(false);
    expect('minAdvanceDays' in (after ?? {})).toBe(false);
  });

  it('a min-advance save labels the change in its own audit block against the correct prior value', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: 9 });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.minAdvanceDays).toBe(4);
    expect(after.minAdvanceDays).toBe(9);
  });
});

describe('updateLeaveType — customMessages.minAdvanceDays (now a known rule key)', () => {
  it('setting a custom message under minAdvanceDays persists via the service', async () => {
    const ltId = await leaveType(uniqCode(), 7, null);
    const custom = 'Please apply at least a week ahead.';
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'MA',
      minAdvanceDays: 7,
      customMessages: { minAdvanceDays: custom },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect((t?.customMessages as Record<string, string> | null)?.minAdvanceDays).toBe(custom);
  });

  it('rejects a minAdvanceDays message over 500 chars', async () => {
    const ltId = await leaveType(uniqCode(), 7, null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: 'MA',
        minAdvanceDays: 7,
        customMessages: { minAdvanceDays: 'x'.repeat(501) },
      }),
    ).rejects.toThrow(/500 characters/);
  });

  it('authoring the min-advance message does not clobber the backdating message (read-then-patch)', async () => {
    const ltId = await leaveType(uniqCode(), 7, { backdatingLimitDays: 'bd msg' });
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'MA',
      customMessages: { minAdvanceDays: 'ma msg' },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const cm = types.find((x) => x.id === ltId)?.customMessages as Record<string, string> | null;
    expect(cm?.minAdvanceDays).toBe('ma msg');
    // The pre-existing, un-edited key must survive the patch.
    expect(cm?.backdatingLimitDays).toBe('bd msg');
  });

  it('clearing the min-advance message (blank) removes only that key', async () => {
    const ltId = await leaveType(uniqCode(), 7, { backdatingLimitDays: 'bd msg', minAdvanceDays: 'to clear' });
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'MA',
      customMessages: { minAdvanceDays: '   ' }, // whitespace-only ⇒ treated as absent
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const cm = types.find((x) => x.id === ltId)?.customMessages as Record<string, string> | null;
    expect(cm?.minAdvanceDays).toBeUndefined();
    expect(cm?.backdatingLimitDays).toBe('bd msg');
  });
});

describe('updateLeaveType — minAdvanceDayType rides the same tri-state (7daac043)', () => {
  it('round-trips the day type through the service and the read projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'MA',
      minAdvanceDays: 7,
      minAdvanceDayType: 'working_days',
    });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBe(7);
    // The projection is what the admin select reads back — unprojected, the card would render Calendar Days
    // on every reload for a type actually configured in working days ("my setting didn't save").
    expect(t?.minAdvanceDayType).toBe('working_days');
  });

  it('a figure saved WITHOUT a day type stores calendar days — the reading that was already in force', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: 7 });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.minAdvanceDayType).toBeNull();
  });

  it('BLANK DAYS CLEARS THE DAY TYPE TOO — "no requirement, in working days" is not a state', async () => {
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days');
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', minAdvanceDays: null });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBeNull();
    expect(t?.minAdvanceDayType).toBeNull();
  });

  it('an unrelated save leaves BOTH columns untouched (one marker, one decision)', async () => {
    const ltId = await leaveType(uniqCode(), 7, null, 'working_days');
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', requiresDocument: true });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.minAdvanceDays).toBe(7);
    expect(t?.minAdvanceDayType).toBe('working_days');
  });

  it('refuses a day type outside the closed set (defence in depth behind the DB CHECK)', async () => {
    const ltId = await leaveType(uniqCode(), null);
    // Asserted by MESSAGE, not a bare rejects.toThrow(): updateLeaveType throws for a dozen reasons.
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: 'MA',
        minAdvanceDays: 7,
        minAdvanceDayType: 'business_days' as 'calendar_days',
      }),
    ).rejects.toThrow(/Calendar Days or Working Days/);
  });

  it('the audit diff records the UNIT beside the figure — 7 calendar and 7 working are different rules', async () => {
    const ltId = await leaveType(uniqCode(), 7);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'MA',
      minAdvanceDays: 7,
      minAdvanceDayType: 'working_days',
    });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    // The FIGURE did not move. Without the unit in the diff this save would read as no change at all.
    expect(before.minAdvanceDays).toBe(7);
    expect(after.minAdvanceDays).toBe(7);
    expect(before.minAdvanceDayType).toBeNull();
    expect(after.minAdvanceDayType).toBe('working_days');
  });

  it('a doc-only save does NOT claim a minAdvanceDayType change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), 4, null, 'working_days');
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'MA', requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    expect('minAdvanceDayType' in ((payload?.before as Record<string, unknown>) ?? {})).toBe(false);
    expect('minAdvanceDayType' in ((payload?.after as Record<string, unknown>) ?? {})).toBe(false);
  });
});

// ── The contract BETWEEN the panel and the action (AGENTS.md rule 17) ─────────────────────────────────
//
// The defect this pins does not live in either file: it lives in the SEAM. A Day Type select rendered
// OUTSIDE the advance-notice sub-form, or read by the action outside the `minAdvance=1` marker, still
// type-checks and still passes every service test in this file — and silently resets the unit every time an
// administrator saves an unrelated card on the same screen. Only a source-shape assertion across BOTH files
// sees it.
const root = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (rel: string) => readFileSync(root + rel, 'utf8');
/** Strip comments: the comments beside these changes deliberately name the very strings asserted below. */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the Day Type select lives INSIDE the advance-notice sub-form', () => {
  const panel = codeOnly(readSrc('components/leave-type-panel.tsx'));
  /** The Advance notice card: from its section title down to the help line that closes it. */
  const subForm = (): string => {
    const from = panel.indexOf("{t('advanceNoticeSectionTitle')}");
    const to = panel.indexOf("{t('advanceNoticeSectionHelp')}", from);
    expect(from, 'the Advance notice sub-form still exists').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return panel.slice(from, to);
  };

  it('renders the select, and it rides this card’s own tri-state marker', () => {
    const block = subForm();
    expect(block).toContain('name="minAdvance" value="1"');
    expect(block).toContain('name="minAdvanceDayType"');
    // Both options, with the literal values the DB CHECK and the service accept.
    expect(block).toContain('value="calendar_days"');
    expect(block).toContain('value="working_days"');
  });

  it('reuses the Maximum Consecutive labels verbatim — one choice cannot read as two on one screen', () => {
    const block = subForm();
    expect(block).toContain("t('conditionStep.maxConsecutiveUnitCalendar')");
    expect(block).toContain("t('conditionStep.maxConsecutiveUnitWorking')");
  });

  it('defaults to Calendar Days, so a type configured before 0447 saves back the reading it had', () => {
    expect(subForm()).toContain("minAdvanceDayType ?? 'calendar_days'");
  });

  // The two options READ IDENTICALLY on the screen — both leave the same "7" in the box above — so the
  // difference has to be stated in product. Without this line the administrator is given a two-option
  // select and no in-product statement of what Working Days counts, nor of the fact that saved types are
  // untouched. A missing help key is invisible to tsc, to i18n-check and to every service test here.
  it('states IN PRODUCT what the two options mean, right under the select', () => {
    const block = subForm();
    expect(block).toContain("t('minAdvanceDayTypeHelp')");
    // Under the select, not appended to the card's closing help line — it explains THIS control.
    expect(block.indexOf("t('minAdvanceDayTypeHelp')")).toBeGreaterThan(block.indexOf('name="minAdvanceDayType"'));
  });

  it('the whole card is still hidden for Emergency Leave (EL is deliberately never notice-guarded)', () => {
    expect(panel).toContain("code !== 'EMERGENCY'");
  });
});

describe('app/admin/actions.ts reads the select ONLY under the advance-notice marker', () => {
  const actions = codeOnly(readSrc('app/admin/actions.ts'));

  it('the field is read inside the touchMinAdvance block and nowhere else', () => {
    const from = actions.indexOf("const touchMinAdvance = fd.get('minAdvance')");
    const to = actions.indexOf('const requestRuleFields', from);
    expect(from, 'the advance-notice marker is still read').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = actions.slice(from, to);
    expect(block).toContain("fd.get('minAdvanceDayType')");
    // Exactly one reader in the whole file: a second one outside the marker is how an unrelated save
    // silently resets a setting nobody touched.
    expect([...actions.matchAll(/fd\.get\('minAdvanceDayType'\)/g)]).toHaveLength(1);
  });

  it('a blank number forwards a cleared PAIR, never a unit with no figure', () => {
    const from = actions.indexOf("const touchMinAdvance = fd.get('minAdvance')");
    const to = actions.indexOf('const requestRuleFields', from);
    const block = actions.slice(from, to);
    expect(block).toContain('{ minAdvanceDays: null, minAdvanceDayType: null }');
  });
});

describe('i18n — advanceNoticeRequired renders in all 6 locales with both tokens', () => {
  it.each(LOCALES)('locale %s substitutes {typeName} and {days}', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'leave.errors' });
    const out = t('advanceNoticeRequired', { typeName: 'Annual Leave', days: 7 });
    expect(out).toContain('Annual Leave');
    expect(out).toContain('7');
    // next-intl throws on a missing/malformed placeholder; reaching here means both tokens were valid.
  });

  it.each(LOCALES)('locale %s carries the WORKING-days variant with the same two tokens', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'leave.errors' });
    const out = t('advanceNoticeRequiredWorking', { typeName: 'Annual Leave', days: 7 });
    expect(out).toContain('Annual Leave');
    expect(out).toContain('7');
    // It must be a DIFFERENT sentence from the calendar one, or the whole point of the branch is lost.
    expect(out).not.toBe(t('advanceNoticeRequired', { typeName: 'Annual Leave', days: 7 }));
  });

  it.each(LOCALES)('locale %s labels the admin Day Type select', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'admin.leave' });
    expect(t('minAdvanceDayTypeLabel')).toBeTruthy();
  });

  it.each(LOCALES)('locale %s explains the two options, and says saved types do not change', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'admin.leave' });
    const help = t('minAdvanceDayTypeHelp');
    expect(help).toBeTruthy();
    // It must name BOTH readings in that locale's own words — a help line that describes only one of them
    // leaves the administrator guessing at the choice it is supposed to explain.
    const cond = createTranslator({ locale, messages, namespace: 'admin.leave.conditionStep' });
    expect(help).toContain(cond('maxConsecutiveUnitCalendar'));
    expect(help).toContain(cond('maxConsecutiveUnitWorking'));
    // …and it must be longer than the label it sits under: this is the explanation, not a second caption.
    expect(help.length).toBeGreaterThan(t('minAdvanceDayTypeLabel').length);
  });
});

describe('migration — min_advance_days applies cleanly to a fresh test DB', () => {
  it('the leave_type.min_advance_days column exists and round-trips an integer', async () => {
    // A fresh migrateTestDb() ran in beforeAll; a round-trip insert/select proves the column is present and
    // typed (would throw "column does not exist" on a DB missing this migration).
    const ltId = await leaveType(uniqCode(), 7);
    const [row] = await owner.db
      .select({ ma: schema.leaveType.minAdvanceDays })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, ltId));
    expect(row?.ma).toBe(7);
  });

  it('0447 · min_advance_day_type exists, defaults to NULL, and holds only the two known readings', async () => {
    const nullRow = await leaveType(uniqCode(), 7); // no day type supplied
    const [asStored] = await owner.db
      .select({ dt: schema.leaveType.minAdvanceDayType })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, nullRow));
    // NULL, with no backfill — the reading every existing row keeps.
    expect(asStored?.dt).toBeNull();

    const workingRow = await leaveType(uniqCode(), 7, null, 'working_days');
    const [w] = await owner.db
      .select({ dt: schema.leaveType.minAdvanceDayType })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, workingRow));
    expect(w?.dt).toBe('working_days');

    // The CHECK is the last line of defence against a hand-edited row the engine would have to guess at.
    await expect(
      owner.db
        .insert(schema.leaveType)
        .values({
          tenantId: b.tenantId,
          code: uniqCode(),
          name: 'bad day type',
          paid: true,
          counting: 'calendar_days',
          minAdvanceDays: 7,
          minAdvanceDayType: 'business_days',
        }),
    ).rejects.toThrow(/min_advance_day_type/);
  });
});
