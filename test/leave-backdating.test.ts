/**
 * Configurable Backdated Leave Restriction by Leave Type (0133 / ADR-0066).
 *
 * Each leave type carries an optional `backdatingLimitDays`: a leave request whose START date is older than
 * that many days before "today" is rejected for ordinary employees with a typed, localized
 * LeaveBackdatingNotAllowedError. null ⇒ no limit (existing behaviour). HR admins (isAdmin) bypass the limit
 * (the override path) and the override is stamped onto the created leave-request event for audit. The
 * predicate is pure + `today`-injectable, and the request path always receives an explicit `today` here so
 * the boundary is deterministic (not wall-clock).
 *
 * Harness note: the block path requires a NON-admin, employee-linked ctx whose personId owns the
 * employmentId it applies for — leave_request RLS is WITH CHECK app.can_see_employment(employment_id), so an
 * unrelated ctx would fail the insert for a different reason and false-green the assertion. We therefore hire
 * an employee as admin, create an `employee`-role app_user linked to that employee's personId, and have it
 * apply for its OWN employmentId.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  exceedsBackdatingLimit,
  LeaveBackdatingNotAllowedError,
  LeaveNoDaysInRangeError,
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
    person: { fullName: 'Backdate', primaryEmail: `bd_${randomUUID().slice(0, 8)}@t.local` },
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
  return `BD_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a leave type with a (nullable) backdating limit. Calendar-counted so day math is trivial. */
async function leaveType(code: string, backdatingLimitDays: number | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      backdatingLimitDays,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Insert a WORKING-DAYS-counted leave type with a (nullable) backdating limit. Used to exercise the
 *  empty-range guard: a backdated single-day request that lands on a weekend resolves to 0 working days. */
async function workingDaysLeaveType(code: string, backdatingLimitDays: number | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'working_days',
      backdatingLimitDays,
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

describe('exceedsBackdatingLimit (pure predicate)', () => {
  it('null limit ⇒ never blocked', () => {
    expect(exceedsBackdatingLimit('2000-01-01', TODAY, null)).toBe(false);
  });
  it('exactly at the limit ⇒ allowed (not exceeded)', () => {
    // start is 3 days before today; limit 3 ⇒ daysBetween == 3, not > 3 ⇒ allowed
    expect(exceedsBackdatingLimit(shift(TODAY, -3), TODAY, 3)).toBe(false);
  });
  it('over the limit ⇒ blocked', () => {
    expect(exceedsBackdatingLimit(shift(TODAY, -5), TODAY, 3)).toBe(true);
  });
  it('future date ⇒ never blocked', () => {
    expect(exceedsBackdatingLimit(shift(TODAY, +10), TODAY, 0)).toBe(false);
  });
  it('limit 0 blocks any past date but allows today', () => {
    expect(exceedsBackdatingLimit(shift(TODAY, -1), TODAY, 0)).toBe(true);
    expect(exceedsBackdatingLimit(TODAY, TODAY, 0)).toBe(false);
  });
});

describe('requestLeave — backdating restriction', () => {
  it('blocks a non-admin over-limit request and persists nothing', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 3);
    const start = shift(TODAY, -5); // 5 days back, limit 3 ⇒ blocked
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY }),
    ).rejects.toThrow(LeaveBackdatingNotAllowedError);
    // Orphan-prevention: the throw is before any write, so no leave_request row exists.
    expect(await requestCount(employmentId)).toBe(0);
  });

  it('allows a non-admin within-window request', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 3);
    const start = shift(TODAY, -2); // 2 days back, limit 3 ⇒ allowed
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

  it('allows a non-admin future-date request even at limit 0', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 0);
    const start = shift(TODAY, +7);
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('lets an HR admin override an over-limit request (row created)', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 3);
    const start = shift(TODAY, -5);
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
    const ltId = await leaveType(uniqCode(), 3);
    const start = shift(TODAY, -5);
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.backdatedOverride).toBe(true);
    expect(payload?.daysBackdated).toBe(5);
    expect(payload?.backdatingLimitDays).toBe(3);
  });

  it('does NOT stamp the override on a normal in-window admin request', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 3);
    const start = shift(TODAY, -1); // within window ⇒ not an override
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.backdatedOverride).toBeUndefined();
    expect(payload?.daysBackdated).toBeUndefined();
  });

  // R5 Build #3 (backdating diagnose-first): an HR admin filing a BACKDATED on-behalf leave whose dates fall
  // entirely on non-working days (weekend/holiday) for a working_days type must get the TYPED, localizable
  // LeaveNoDaysInRangeError — a clear everyday reason — NOT a raw untranslated Error, and NOT the backdating
  // gate (the admin override bypasses that first). Uses adminCtx(b) (roles:['hr_admin'] ⇒ isAdmin TRUE) for
  // another employee's employmentId — exactly the on-behalf path the reporter hit.
  it('surfaces a typed LeaveNoDaysInRangeError when an admin backdates onto a weekend-only working-days type', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await workingDaysLeaveType(uniqCode(), 3); // limit 3 ⇒ the date below is also over-limit
    const sat = '2026-05-30'; // Saturday, 16 days before TODAY (2026-06-15): over-limit AND non-working
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: ltId,
        startDate: sat,
        endDate: sat,
        today: TODAY,
      }),
    ).rejects.toBeInstanceOf(LeaveNoDaysInRangeError);
    // Not the backdating gate (the admin override applied first) and nothing persisted.
    expect(await requestCount(employmentId)).toBe(0);
  });

  it('back-compat: a null-limit type never blocks a backdated request', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), null);
    const start = shift(TODAY, -365);
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: start,
      endDate: start,
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });
});

describe('updateLeaveType — backdatingLimitDays tri-state', () => {
  it('sets and reads the value via the admin service + read projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', backdatingLimitDays: 7 });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.backdatingLimitDays).toBe(7);
  });

  it('rejects a negative or non-integer limit', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(
      updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', backdatingLimitDays: -1 }),
    ).rejects.toThrow();
    await expect(
      updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', backdatingLimitDays: 2.5 }),
    ).rejects.toThrow();
  });

  it('clearing with null removes the limit (unrestricted again)', async () => {
    const ltId = await leaveType(uniqCode(), 5);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', backdatingLimitDays: null });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(types.find((x) => x.id === ltId)?.backdatingLimitDays).toBeNull();
  });

  it('a doc-only save leaves backdatingLimitDays untouched (independent tri-state)', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    // Touch ONLY the document config — backdatingLimitDays is undefined ⇒ must not change.
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', requiresDocument: true });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.backdatingLimitDays).toBe(4);
    expect(t?.requiresDocument).toBe(true);
  });

  it('a doc-only save does NOT claim a backdating change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect(before).toBeDefined();
    expect('backdatingLimitDays' in (before ?? {})).toBe(false);
    expect('backdatingLimitDays' in (after ?? {})).toBe(false);
  });

  it('a backdating save labels the change in its own audit block', async () => {
    const ltId = await leaveType(uniqCode(), 4);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'BD', backdatingLimitDays: 9 });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.backdatingLimitDays).toBe(4);
    expect(after.backdatingLimitDays).toBe(9);
  });
});

// Partial Leave Approval (ADR-0068): perDateApproval is an own tri-state on updateLeaveType, mirroring
// backdatingLimitDays above — an unrelated save must not reset it, and an explicit toggle must round-trip.
describe('updateLeaveType — perDateApproval tri-state', () => {
  it('an explicit toggle sets and reads the value via the admin service + read projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD', perDateApproval: true });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(types.find((x) => x.id === ltId)?.perDateApproval).toBe(true);
    // …and back off.
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD', perDateApproval: false });
    const after = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(after.find((x) => x.id === ltId)?.perDateApproval).toBe(false);
  });

  it('a plain rename (no perDateApproval) does NOT clear an enabled flag', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD', perDateApproval: true });
    // Touch ONLY the name — perDateApproval is undefined ⇒ must not change.
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD renamed' });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.perDateApproval).toBe(true);
    expect(t?.name).toBe('PD renamed');
  });

  it('a rename does NOT claim a perDateApproval change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD2' });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect('perDateApproval' in (before ?? {})).toBe(false);
    expect('perDateApproval' in (after ?? {})).toBe(false);
  });

  it('an explicit toggle labels the change in its own audit block', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'PD3', perDateApproval: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.perDateApproval).toBe(false);
    expect(after.perDateApproval).toBe(true);
  });
});

describe('i18n — backdatingNotAllowed renders in all 6 locales with both tokens', () => {
  it.each(LOCALES)('locale %s substitutes {typeName} and {days}', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'leave.errors' });
    const out = t('backdatingNotAllowed', { typeName: 'Annual Leave', days: 3 });
    expect(out).toContain('Annual Leave');
    expect(out).toContain('3');
    // next-intl throws on a missing/malformed placeholder; reaching here means both tokens were valid.
  });
});

// R5 Build #3: the new typed empty-range error is localized in all 6 locales (no tokens — a static string).
describe('i18n — noLeaveDaysInRange renders (non-empty) in all 6 locales', () => {
  it.each(LOCALES)('locale %s has a non-empty message', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'leave.errors' });
    const out = t('noLeaveDaysInRange');
    expect(out.length).toBeGreaterThan(0);
  });
});
