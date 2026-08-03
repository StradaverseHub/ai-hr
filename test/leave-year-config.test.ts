/**
 * Leave year — what SURVIVED the removal of Leave Year Configuration (4b0e76ae).
 *
 * This file used to cover the whole managed leave_year_config module: the pure application gate, the
 * Draft → Open → Closed lifecycle, its RLS, and the dcd8e32f/f1701466 delete guard with all six error
 * codes. 4b0e76ae removed that module — the section on every leave type's Custom Settings step, its two
 * dialogs, its four writing actions, its eight services, and (migration 0385) its rows. Those suites went
 * with it, because a test for a deleted service is not coverage, it is scaffolding.
 *
 * THREE THINGS SURVIVED, AND THEY ARE EXACTLY WHAT THIS FILE NOW PINS.
 *
 * 1. THE GRANT SWEEP, RE-HOMED. `openLeaveYear` is the only thing in the system that posts a leave year's
 *    entitlement for every eligible employment. It was reachable ONLY through the deleted section's Start
 *    button. It is now reachable through `openLeaveYearAction` on /admin/leave/generate, and the sweep case
 *    below is the old "status→open runs the grant sweep" case pointed at that action instead of at
 *    setLeaveYearStatus. Same engine, same idempotency, same leave-year.opened event.
 *
 * 2. THE ADMIN GATE, WHICH DID NOT EXIST BEFORE THIS ITEM. `openLeaveYearAction` opened with
 *    `getSession()`, `openLeaveYear` carries no admin assertion anywhere in its body, and leave_ledger RLS
 *    gates on can_see_employment rather than on admin — so an ordinary member who POSTed that server action
 *    directly would have posted accrual grants for every employment they can see. It is `requireAdmin()`
 *    now. The test below is written so that it FAILS if anyone reverts it: getSession is mocked to a real
 *    non-admin employee ctx and requireAdmin to the refusal the real one performs, so a regression to
 *    getSession() would let the sweep run and the ledger assertion would catch it.
 *
 * 3. THE FUTURE-YEAR APPLICATION GATE — the BEHAVIOUR, with the READ cut out. requestLeave no longer looks
 *    up a leave_year_config row; the rule is flat (a year strictly after the tenant-local current year is
 *    refused to an ordinary employee and allowed to an admin, stamped). Deleting the gate instead would
 *    have let an employee book next-year dates against this year's balance, and because the approval debit
 *    is stamped at the request's start date while openLeaveYear's "before" balance is an UNBOUNDED ledger
 *    read, that booking would silently REDUCE carry-forward and INCREASE forfeit. The cases below run with
 *    NO leave_year_config rows at all — the post-reset state — and are byte-identical in outcome to what
 *    the old config-reading gate produced for a tenant with no OPEN future year.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, lte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() in real Next.js THROWS to abort the request; the mock must throw too, or execution would fall
// through. The sentinel carries the target path so the tests can assert WHERE the action lands.
let sessionCtx: import('../db/client').SessionContext | null = null;
let adminGuardCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => sessionCtx) }));
// requireAdmin() resolves Clerk + the session and is unavailable in the harness. The fake mirrors the REAL
// contract on both branches: hand back the admin ctx when one is set, and redirect away when it is not —
// which is what the real requireAdmin does to a non-admin. That second branch is what makes the admin-gate
// test below real rather than decorative.
vi.mock('../lib/authz', () => ({
  requireAdmin: vi.fn(async () => {
    if (!adminGuardCtx) redirectSpy('/');
    return adminGuardCtx;
  }),
}));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// The action localises its toast before redirecting; the key-echoing fake keeps the URL assertable.
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, LeaveYearNotOpenError, entitlementYearOptions } from '../core/leave';
import { openLeaveYearAction } from '../app/admin/actions';
import { withTenant, type SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Hire an employee (as admin) and return its OWN non-admin employee ctx + ids. Hired long ago so any
 *  leave year is "opened" for it (openLeaveYear posts grants for pre-1-Jan hires).
 *
 *  fa3f4ccb: the statutory pack no longer backfills an unconfigured leave type, so the ANNUAL entitlement
 *  these grants depend on has to be CONFIGURED — an unconfigured type resolves to 0 and openLeaveYear
 *  skips it, which would make every "a grant was posted" assertion in this file vacuous. 8 days is exactly
 *  what the EA floor used to supply, so no assertion here changes. Idempotent per tenant: the helper is
 *  called several times in one test, and a duplicate active policy would fan out extra rows. */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const existing = await owner.db
    .select({ id: schema.leavePolicy.id })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId));
  if (existing.length === 0) {
    await owner.db.insert(schema.leavePolicy).values({
      tenantId: b.tenantId,
      leaveTypeId: b.annualLeaveTypeId,
      validFrom: '2015-01-01',
      accrual: { annualDays: 8 },
    });
  }
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'LY', primaryEmail: `ly_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** A calendar-counted leave type so the day math is trivial (no weekend/holiday interaction). */
async function calendarLeaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code: `LY_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: 'LY Type',
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run a server action that ends in redirect() (throws RedirectError here) and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  sessionCtx = null;
  adminGuardCtx = null;
  redirectSpy.mockClear();
});

// ── The shared entitlement-year range (4b0e76ae) ────────────────────────────────────────────────
describe('entitlementYearOptions — the ONE computed year list', () => {
  it('spans currentYear-3 .. currentYear+6, oldest first, with no gaps', () => {
    expect(entitlementYearOptions(2026)).toEqual([2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032]);
  });

  it('REACHES BACK three years — a forward-only range would silently remove past-year earned accrual', () => {
    // The Run Earned Accrual selector previously built currentYear..+6 and leaned on the configured
    // leave_year_config records for anything earlier. Those records are gone, so if this range did not
    // reach back, a tenant that ran accrual for a past year could no longer do so. That is the whole
    // reason the range is asymmetric, and it is the assertion most likely to be "tidied" away.
    const years = entitlementYearOptions(2026);
    expect(Math.min(...years)).toBe(2023);
    expect(Math.max(...years)).toBe(2032);
    expect(years).toContain(2025);
  });
});

// ── The grant sweep, re-homed onto the Generate page's action ───────────────────────────────────
describe('openLeaveYearAction — the re-homed grant sweep (4b0e76ae)', () => {
  it('posts the year’s grants, is idempotent, emits leave-year.opened, and lands back on /admin/leave/generate', async () => {
    const { employmentId } = await hireEmployeeCtx(); // hired 2020 ⇒ eligible for a 2027 grant
    adminGuardCtx = adminCtx(b);

    const before = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    const target = await captureRedirect(() => openLeaveYearAction(fd({ year: '2027' })));
    // Re-homed: the action used to redirect to /admin/leave (and, through setLeaveYearStatusAction, to the
    // Entitlements tab). Its home is the Generate page now, and the counts ride back as a toast.
    expect(target.startsWith('/admin/leave/generate')).toBe(true);
    expect(target).toContain('toast=');

    // The Jan-1 grant for 2027 was posted (balance increased for the pre-2027 hire).
    const after = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after).toBeGreaterThan(before);

    // PRESSING GENERATE TWICE IS SAFE — the plan promises this to the reporter in plain words. The dedupe
    // set is built from existing ledger accrual rows at the year start, never from leave_year_config, so
    // clearing that table (migration 0385) cannot cause a double grant either.
    await captureRedirect(() => openLeaveYearAction(fd({ year: '2027' })));
    const after2 = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after2).toBe(after);

    // Substrate: the grant sweep emitted leave-year.opened.
    const openedEvents = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave-year.opened')));
    expect(openedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT touch leave_year_config — the sweep never needed the table it used to sit beside', async () => {
    await hireEmployeeCtx();
    adminGuardCtx = adminCtx(b);
    await captureRedirect(() => openLeaveYearAction(fd({ year: '2027' })));
    const rows = await owner.db.select().from(schema.leaveYearConfig);
    expect(rows).toEqual([]);
  });

  it('refuses a year outside 2020..2100 and lands on the Generate page’s error banner', async () => {
    adminGuardCtx = adminCtx(b);
    const target = await captureRedirect(() => openLeaveYearAction(fd({ year: '1999' })));
    expect(target.startsWith('/admin/leave/generate?error=')).toBe(true);
  });
});

// ── The admin gate this item introduced ─────────────────────────────────────────────────────────
describe('openLeaveYearAction is ADMIN-ONLY (4b0e76ae — this was a real hole)', () => {
  it('a non-admin session is refused and NOTHING is granted', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // getSession() would hand this action a live NON-ADMIN member ctx — which is precisely what the old
    // `const s = await getSession()` did. requireAdmin() refuses it instead (the fake redirects, as the
    // real one does). If anyone reverts the guard to getSession(), this ctx flows straight into
    // openLeaveYear — which asserts nothing about admin, over a ledger whose RLS gates on
    // can_see_employment — and the balance assertion below fails. That is the point of writing it this way.
    sessionCtx = ctx;
    adminGuardCtx = null;

    const before = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    const target = await captureRedirect(() => openLeaveYearAction(fd({ year: '2027' })));
    expect(target).toBe('/');

    const after = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after).toBe(before);
    const accruals = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(
        and(
          eq(schema.leaveLedger.tenantId, b.tenantId),
          gte(schema.leaveLedger.effectiveOn, '2027-01-01'),
          lte(schema.leaveLedger.effectiveOn, '2027-12-31'),
        ),
      );
    expect(accruals).toEqual([]);
  });
});

// ── The future-year application gate, AFTER the reset ────────────────────────────────────────────
describe('requestLeave — the future leave-year gate survives the reset (4b0e76ae)', () => {
  const TODAY = '2026-12-18';

  /** Every case here runs against an EMPTY leave_year_config — the post-migration-0385 production state. */
  async function assertNoConfigRows() {
    const rows = await withTenant(adminCtx(b), async (tx) => tx.select().from(schema.leaveYearConfig));
    expect(rows).toEqual([]);
  }

  it('an ordinary employee still CANNOT apply into a future year, and nothing is persisted', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await assertNoConfigRows();
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2027-01-05', endDate: '2027-01-05', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearNotOpenError);
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows.length).toBe(0);
  });

  it('back-compat: a CURRENT-year request is never gated', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // targetYear 2026 == currentYear ⇒ ungated, exactly as before the rewrite.
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2026-12-20',
      endDate: '2026-12-20',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('a PAST-year request is never gated either (only STRICTLY later years are)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2025-06-02',
      endDate: '2025-06-02',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('an HR admin still CAN, and the override is still stamped on the submitted event', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await assertNoConfigRows();
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveYearNotOpenOverride).toBe(true);
    expect(payload?.targetLeaveYear).toBe(2027);
  });

  it('the refusal keeps its typed year, so the localiser still renders "{year} isn’t open yet"', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // LeaveYearNotOpenError, its localiser (app/me/actions.ts) and leave.errors.leaveYearNotOpen all stay —
    // the gate stays, so the string stays. `year` is what the message interpolates.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2029-03-01', endDate: '2029-03-01', today: TODAY }),
    ).rejects.toMatchObject({ name: 'LeaveYearNotOpenError', year: 2029 });
  });
});
