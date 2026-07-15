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
 * Harness note (same as leave-backdating): the block path requires a NON-admin, employee-linked ctx whose
 * personId owns the employmentId it applies for — leave_request RLS is WITH CHECK app.can_see_employment,
 * so an unrelated ctx would fail the insert for a different reason and false-green the assertion.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, lacksMinAdvanceNotice, LeaveAdvanceNoticeRequiredError } from '../core/leave';
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

/** Insert a calendar-counted leave type with a (nullable) min-advance requirement + optional custom messages. */
async function leaveType(
  code: string,
  minAdvanceDays: number | null,
  customMessages?: Record<string, string> | null,
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
      customMessages: customMessages ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
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

describe('i18n — advanceNoticeRequired renders in all 6 locales with both tokens', () => {
  it.each(LOCALES)('locale %s substitutes {typeName} and {days}', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'leave.errors' });
    const out = t('advanceNoticeRequired', { typeName: 'Annual Leave', days: 7 });
    expect(out).toContain('Annual Leave');
    expect(out).toContain('7');
    // next-intl throws on a missing/malformed placeholder; reaching here means both tokens were valid.
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
});
