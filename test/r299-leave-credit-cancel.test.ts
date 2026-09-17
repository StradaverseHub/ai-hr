/**
 * 3fb1a611 (r299) · CANCELLING AN APPROVED REPLACEMENT LEAVE GIVES THE CREDIT BACK — or says why it cannot.
 *
 * Replacement Leave is USED credit by credit, the one expiring first used first (consumeReplacementLeaveTx),
 * and until this round an approved one could not be cancelled at all: core/leave.ts refused it in three places
 * because there was no inverse of the consumption. restoreReplacementLeaveTx is that inverse. These cases pin:
 *   · a leave split across several credits gives EXACTLY those amounts back to EXACTLY those credits;
 *   · a partial cancellation of a segment that survived an earlier split still finds the credits its original
 *     request used (the split lineage);
 *   · a credit that has expired since the leave used it refuses the cancellation, naming the credit and date,
 *     and nothing moves;
 *   · a line manager (not an admin) can approve Replacement Leave and approve its cancellation — both write the
 *     register (migration 0469's RLS change).
 *
 * Dates come from todayInKualaLumpur(): credits are for rest days last month; the leave is taken in a week at
 * least two weeks ahead, so every cancellation date is in the future.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';

// app/me/actions.ts's framework edges, faked the way test/r266-benefit-scheme-vocabulary.test.ts fakes them, so the
// refusal can be read as the SENTENCE the employee sees (a real translator over the English catalogue).
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => null) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (ns: string) => (key: string, vals?: Record<string, unknown>) => {
    const node = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
    if (typeof node !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key}`);
    return node.replace(/\{(\w+)\}/g, (_, name) => {
      if (!vals || !(name in vals)) throw new Error(`FORMATTING_ERROR: ${ns}.${key} needs {${name}}`);
      return String(vals[name]);
    });
  },
}));
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  adminCancelLeave,
  decideLeave,
  decideLeaveCancellation,
  leaveBalance,
  LeaveCancellationNotAllowedError,
  requestLeave,
  requestLeaveCancellation,
} from '../core/leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { localizeLeaveError } from '../app/me/actions';
import { ReplacementCreditCancellationBlockedError } from '../core/leave';
import { grantLeaveCredit, setToilPolicy } from '../core/toil';

let b: Base;
let admin: SessionContext;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let mgrCtx: SessionContext;

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const [y, m] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
})();
/** Monday of the first full week starting at least 14 days from today. */
const MON = (() => {
  let d = addDays(TODAY, 14);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();
const TUE = addDays(MON, 1);
const WED = addDays(MON, 2);

async function replacementTypeId() {
  const [lt] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return lt.id;
}
const balance = async () =>
  owner.db.transaction(async (tx) => leaveBalance(tx as never, subject.employmentId, await replacementTypeId()));

/** Credits for rest days last month, earliest expiry first. Returns the accrual ids in that order. */
async function credits(days: number[], expiriesFromToday: number[]) {
  const ids: string[] = [];
  for (let i = 0; i < days.length; i++) {
    const workedDate = `${LAST_MONTH}-${String(i + 2).padStart(2, '0')}`;
    await setRestDay(admin, { employmentId: subject.employmentId, shiftDate: workedDate });
    const g = await grantLeaveCredit(admin, {
      employmentId: subject.employmentId,
      workedDate,
      days: days[i],
      reason: `credit ${i + 1}`,
      expiresOn: addDays(TODAY, expiriesFromToday[i]),
      today: TODAY,
    });
    ids.push(g.accrualId);
  }
  return ids;
}

const lots = async (ids: string[]) => {
  const rows = await owner.db
    .select({
      id: schema.toilAccrual.id,
      status: schema.toilAccrual.status,
      daysTaken: schema.toilAccrual.daysTaken,
      takenByRequestId: schema.toilAccrual.takenByRequestId,
    })
    .from(schema.toilAccrual)
    .where(inArray(schema.toilAccrual.id, ids));
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => ({ status: by.get(id)!.status, taken: Number(by.get(id)!.daysTaken), takenBy: by.get(id)!.takenByRequestId }));
};

/** Employee applies for Replacement Leave over [from, to]; the line manager approves it. */
async function approvedReplacementLeave(from: string, to: string) {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: await replacementTypeId(),
    startDate: from,
    endDate: to,
    today: TODAY,
  });
  await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
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
  await setModule(b.tenantId, 'toil', 'active');
  admin = await entitledCtx(b);
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  const hire = async (name: string) => {
    const e = await hireEmployee(adminCtx(b), {
      person: { fullName: name, primaryEmail: `r299c_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(adminCtx(b), { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    return e;
  };
  subject = await hire('Subject');
  const manager = await hire('Manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  subjectCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, subject.personId, 'employee'),
    personId: subject.personId,
    roles: ['employee'],
    entitlements: admin.entitlements,
  };
  mgrCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, manager.personId, 'manager'),
    personId: manager.personId,
    roles: ['manager'],
    entitlements: admin.entitlements,
  };
  await setToilPolicy(admin, {
    companyId: b.companyId,
    enabled: true,
    accrualBasis: 'hours_worked',
    expiryDays: 90,
    onExpiry: 'lapse',
    allowFirstScheduleEligible: false,
    autoAccrueOnApproval: false,
    carryForwardAtYearEnd: false,
  });
});

describe('Cancellation gives FIFO-split credits back exactly', () => {
  it('HR cancels a leave that used two credits: each gets back exactly what it gave', async () => {
    // Lot A 1.5 days expiring first, lot B 1.0 day expiring later.
    const [A, B] = await credits([1.5, 1], [40, 80]);
    expect(await balance()).toBe(2.5);

    const leaveId = await approvedReplacementLeave(MON, TUE); // 2 working days, approved by the LINE MANAGER
    // Used expiring-first: all of A, half of B.
    expect(await lots([A, B])).toEqual([
      { status: 'taken', taken: 1.5, takenBy: leaveId },
      { status: 'active', taken: 0.5, takenBy: null },
    ]);
    expect(await balance()).toBe(0.5);

    const out = await adminCancelLeave(admin, { leaveRequestId: leaveId, reason: 'Trip cancelled' });
    expect(out.restoredDays).toBe(2);
    expect(await lots([A, B])).toEqual([
      { status: 'active', taken: 0, takenBy: null },
      { status: 'active', taken: 0, takenBy: null },
    ]);
    expect(await balance()).toBe(2.5);

    // Given back in REVERSE order of use: B's half first, then A's one and a half.
    const restored = await owner.db
      .select({ aggregateId: schema.domainEvent.aggregateId, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'toil.restored')))
      .orderBy(asc(schema.domainEvent.sequence));
    expect(restored.map((r) => [r.aggregateId, (r.payload as { daysRestored: number }).daysRestored])).toEqual([
      [B, 0.5],
      [A, 1.5],
    ]);
  });

  it('employee asks, manager approves: cancelling the FIRST day, then a day of the surviving segment, returns the right credits', async () => {
    const [A, B, C] = await credits([1, 1, 1], [30, 60, 90]);
    const leaveId = await approvedReplacementLeave(MON, WED); // uses A, B, C in that order
    expect((await lots([A, B, C])).map((l) => l.status)).toEqual(['taken', 'taken', 'taken']);

    // Give back Monday. The original row is reused for Monday (cancelled); Tue–Wed survive as a NEW row.
    const c1 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: leaveId, cancelDates: [MON], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    expect(await lots([A, B, C])).toEqual([
      { status: 'taken', taken: 1, takenBy: leaveId },
      { status: 'taken', taken: 1, takenBy: leaveId },
      { status: 'active', taken: 0, takenBy: null }, // the last credit used is the first given back
    ]);
    expect(await balance()).toBe(1);

    const [survivor] = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(and(eq(schema.leaveRequest.employmentId, subject.employmentId), eq(schema.leaveRequest.status, 'approved')));
    expect(survivor.id, 'the survivor must be a NEW row, or the split lineage is not exercised').not.toBe(leaveId);

    // Give back Tuesday from the surviving segment: it finds the ORIGINAL request's consumption.
    const c2 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: survivor.id, cancelDates: [TUE], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c2.cancellationRequestId, decision: 'approved' });
    expect(await lots([A, B, C])).toEqual([
      { status: 'taken', taken: 1, takenBy: leaveId },
      { status: 'active', taken: 0, takenBy: null },
      { status: 'active', taken: 0, takenBy: null },
    ]);
    expect(await balance()).toBe(2);
  });
});

describe('A role-classified Replacement Leave type (production’s shape) is used and given back too', () => {
  it('a type coded RL with role replacement consumes its credits on approval and restores them on cancellation', async () => {
    // Production's replacement type is coded `RL` with `role = 'replacement'` (5ff7daff). Before 3fb1a611
    // finalizeLeaveApproval selected no `role`, so leaveTypeIs fell back to the code and an approval on this
    // type consumed NOTHING from the register — every credit stayed 'active' for the expiry sweep.
    const [rl] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'RL', name: 'Replacement Leave', role: 'replacement', paid: true, counting: 'working_days' })
      .returning({ id: schema.leaveType.id });
    const [A] = await credits([2], [45]);
    // ensureReplacementLeaveType matched on the ROLE, so the credit sits on RL, not on an auto-created type.
    const [ledgerRow] = await owner.db
      .select({ leaveTypeId: schema.leaveLedger.leaveTypeId })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.employmentId, subject.employmentId));
    expect(ledgerRow.leaveTypeId).toBe(rl.id);

    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: rl.id,
      startDate: MON,
      endDate: TUE,
      today: TODAY,
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    expect(await lots([A]), 'approval on a role-classified type must consume the register').toEqual([
      { status: 'taken', taken: 2, takenBy: res.leaveRequestId },
    ]);

    await adminCancelLeave(admin, { leaveRequestId: res.leaveRequestId });
    expect(await lots([A])).toEqual([{ status: 'active', taken: 0, takenBy: null }]);
  });
});

describe('A credit that expired since the leave used it cannot come back', () => {
  it('refuses the cancellation on every path, naming the credit and its expiry date, and nothing moves', async () => {
    const [A] = await credits([2], [50]);
    const leaveId = await approvedReplacementLeave(MON, TUE);
    expect(await balance()).toBe(0);

    // The credit's expiry has since passed (an expiry cannot be typed in the past on the Add form, so the
    // passage of time is simulated on the register).
    const expiredOn = addDays(TODAY, -1);
    await owner.db.update(schema.toilAccrual).set({ expiresOn: expiredOn }).where(eq(schema.toilAccrual.id, A));
    const [credit] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, A));

    const asked = requestLeaveCancellation(subjectCtx, { leaveRequestId: leaveId, cancelDates: [TUE], today: TODAY });
    await expect(asked).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
    await expect(asked).rejects.toThrow(new RegExp(`credit earned on ${credit.workedDate} expired on ${expiredOn}`));
    // …and THE SCREEN SAYS SO: the typed error carries the credit, and the localized sentence names it rather
    // than the generic "This leave date can't be cancelled."
    const err = await asked.catch((e) => e);
    expect(err).toBeInstanceOf(ReplacementCreditCancellationBlockedError);
    expect((err as ReplacementCreditCancellationBlockedError).credits).toEqual([
      { workedDate: credit.workedDate, expiresOn: expiredOn, state: 'expired' },
    ]);
    const shown = await localizeLeaveError(err);
    expect(shown).toContain(`the credit for the day worked on ${credit.workedDate} expired on ${expiredOn}`);
    expect(shown).not.toBe(en.leave.errors.cancellationNotAllowed);

    const hr = adminCancelLeave(admin, { leaveRequestId: leaveId });
    await expect(hr).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
    await expect(hr).rejects.toThrow(new RegExp(`expired on ${expiredOn}`));

    // Nothing moved: the leave is still approved, the ledger unchanged, the credit still used.
    const [leave] = await owner.db
      .select({ status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, leaveId));
    expect(leave.status).toBe('approved');
    expect(await balance()).toBe(0);
    expect(await lots([A])).toEqual([{ status: 'taken', taken: 2, takenBy: leaveId }]);
  });
});
