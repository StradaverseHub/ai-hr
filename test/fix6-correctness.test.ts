/**
 * Fix-6 — six clear-cut correctness bugfixes (audit #11/#19/#20/#21/#33/#34), each in a different module.
 * Red-first: every block asserts the corrected behaviour and was confirmed to FAIL against the pre-fix code.
 *
 *  #11 amendLoanAction must NOT wipe a loan's notes when the inline amend form omits the notes field.
 *  #19 closeReplacementLeaveYear must sweep each company at its OWN leaveCycle boundary (mixed-cycle tenant).
 *  #20 hiring with provisionalEndOn must make sweepDueReviews open a review for the new hire.
 *  #21 approving a REPLACEMENT must decrement the TOIL register even when the tenant is NOT entitled to
 *      the `toil` module (no later double-debit).
 *  #33 update/deleteIndividualTxn on an absent row must throw TxnNotFoundError, not BatchNotDraftError.
 *  #34 the raw cp38ForPeriod query must return exactly one row for a supersede boundary month (exclusive validTo).
 *
 * ADR-0077 slice 3: TOIL is a per-TENANT entitlement row, not the TOIL_ENABLED deployment flag. `seedBase`
 * seeds NO `toil` row (it is absent from LEGACY_ENABLED_MODULE_CODES) and a missing row is DISABLED (C7),
 * so the #19 / #21 blocks grant it with `setModule` and resolve a REAL snapshot with `entitledCtx`.
 * `adminCtx` cannot stand in: its snapshot is derived from `legacyEnabledModulesIn` over this process's
 * env, which never contains `toil`, so every gated TOIL entry point would refuse under it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// #11 needs the server action, which calls requireAdmin() (session) + redirect(). Stub both so the action's
// FormData→amendLoan mapping (the actual buggy line) runs against the real DB and the success-redirect is inert.
let amendActionCtx: SessionContext | null = null;
vi.mock('../lib/authz', async (importActual) => {
  const actual = await importActual<typeof import('../lib/authz')>();
  return { ...actual, requireAdmin: vi.fn(async () => amendActionCtx) };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { requestLeave, decideLeave } from '../core/leave';
import { createLoan, getLoanWithSchedule } from '../core/loans';
import { amendLoanAction } from '../app/admin/loans/actions';
import {
  accrueToil,
  closeReplacementLeaveYear,
  runToilExpiry,
  setToilPolicy,
  type ToilPolicyInput,
} from '../core/toil';
import { sweepDueReviews } from '../core/employment-review';
import {
  createIndividualTxn,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnNotFoundError,
} from '../core/payroll-individual-txn';
import { cp38RowsForPeriod, setCp38 } from '../core/cp38';
import { isModuleEnabled } from '../core/entitlements';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let base: Base;
let icSeq = 0;
const nextIc = () => `9001010${String(10000 + icSeq++).slice(-5)}`;
const uniqEmail = () => `fix6_${randomUUID().slice(0, 8)}@t.local`;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

async function hireFT(name: string, opts: { hiredOn?: string; provisionalEndOn?: string | null; companyId?: string; deptId?: string } = {}) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: opts.companyId ?? base.companyId,
    departmentId: opts.deptId ?? base.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2026-01-01',
    provisionalEndOn: opts.provisionalEndOn ?? null,
  });
  return e;
}

// ── #11 — amend a loan's duration via the FormData/action path must preserve its notes ──────────────
describe('#11 amendLoanAction preserves notes when the amend form omits notes', () => {
  it('keeps the original notes after a duration-only amend', async () => {
    const a = adminCtx(base);
    amendActionCtx = a;
    const e = await hireFT('Loan Notes');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId,
      loanType: 'personal',
      principal: 1200,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
      notes: 'Original advance — repay over a year',
    });

    // The inline amend form sends ONLY loanId + durationMonths (no notes field at all).
    const fd = new FormData();
    fd.set('loanId', loanId);
    fd.set('durationMonths', '6');
    await amendLoanAction(fd); // redirect() is stubbed inert

    const after = await getLoanWithSchedule(a, loanId);
    expect(after!.loan.durationMonths).toBe(6);
    expect(after!.loan.notes).toBe('Original advance — repay over a year'); // survives
  });
});

// ── #19 — mixed-cycle multi-company tenant: each company swept at its own boundary ──────────────────
describe('#19 closeReplacementLeaveYear sweeps each company at its own leaveCycle boundary', () => {
  const policy = (companyId: string): ToilPolicyInput => ({
    companyId,
    enabled: true,
    accrualBasis: 'hours_worked',
    expiryDays: 365,
    onExpiry: 'lapse',
    allowFirstScheduleEligible: true,
    autoAccrueOnApproval: false,
    carryForwardAtYearEnd: false,
  });

  /** `a` must be a TOIL-entitled context — `accrueToil` is gated on the `toil` module. */
  async function bankRestDay(a: SessionContext, employmentId: string, restDay: string) {
    await setRestDay(a, { employmentId, shiftDate: restDay });
    await checkIn(a, { employmentId, date: restDay, time: '08:00:00' });
    await checkOut(a, { employmentId, date: restDay, time: '17:00:00' });
    await accrueToil(a, { employmentId, workedDate: restDay });
  }

  /** The `asOf` boundary stamped on an accrual's terminal toil.lapsed event. */
  async function lapseBoundary(accrualId: string): Promise<string | undefined> {
    const [row] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, accrualId), eq(schema.domainEvent.eventType, 'toil.lapsed')));
    return (row?.payload as { asOf?: string } | undefined)?.asOf;
  }

  it('each company is swept at its OWN boundary: calendar at asOf, anniversary at the employee cycle start', async () => {
    // Grant the `toil` module to this tenant, then resolve a real snapshot from its rows — the
    // entitlement replaces the old `TOIL_ENABLED = 'true'` env write. No teardown counterpart is
    // needed: `resetDb()` truncates `tenant_module` before every test.
    await setModule(base.tenantId, 'toil', 'active');
    const a = await entitledCtx(base);
    expect(isModuleEnabled(a, 'toil')).toBe(true); // the gate really is OPEN for this context

    // Company A = calendar (the seeded company); Company B = anniversary, created here.
    await owner.db.update(schema.company).set({ leaveCycle: 'calendar' }).where(eq(schema.company.id, base.companyId));
    const [cB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd', leaveCycle: 'anniversary' })
      .returning({ id: schema.company.id });
    const [dB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: cB.id, name: 'Ops B' })
      .returning({ id: schema.department.id });

    await setToilPolicy(a, policy(base.companyId));
    await setToilPolicy(a, policy(cB.id));

    // A: calendar company → boundary is asOf (2026-12-31).
    const empA = await hireFT('Cal A', { hiredOn: '2024-01-01' });
    await bankRestDay(a, empA.employmentId, '2026-07-04');
    const accA = (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, empA.employmentId)))[0];

    // B: anniversary company, hired in NOVEMBER → its own cycle boundary for asOf 2026-12-31 is 2026-11-01.
    const empB = await hireFT('Anniv B', { hiredOn: '2024-11-01', companyId: cB.id, deptId: dB.id });
    await bankRestDay(a, empB.employmentId, '2026-07-04');
    const accB = (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, empB.employmentId)))[0];

    const r = await closeReplacementLeaveYear(a, { asOf: '2026-12-31' });
    expect(r.processed).toBe(2); // both companies' accruals swept

    // Each accrual must be stamped at ITS OWN company's boundary. The pre-fix code applied one arbitrary
    // company's leaveCycle to every row, so one of these two would carry the wrong boundary.
    expect(await lapseBoundary(accA.id)).toBe('2026-12-31'); // calendar company
    expect(await lapseBoundary(accB.id)).toBe('2026-11-01'); // anniversary company, own cycle start
  });
});

// ── #20 — a new hire's provisionalEndOn must open an auto-review ─────────────────────────────────────
describe('#20 hire provisionalEndOn auto-opens a review via sweepDueReviews', () => {
  it('opens a probation review for a full_time hire with a near provisional end', async () => {
    const a = adminCtx(base);
    // Provisional end soon enough that due_date (end − 1 month) <= today.
    const e = await hireFT('New Probation', { hiredOn: '2026-05-01', provisionalEndOn: '2026-07-15' });
    const { opened } = await sweepDueReviews(a, { today: '2026-06-20' });
    expect(opened).toBe(1);
    const reviews = await owner.db
      .select()
      .from(schema.employmentReview)
      .where(eq(schema.employmentReview.employmentId, e.employmentId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewType).toBe('probation');
    expect(reviews[0].endDate).toBe('2026-07-15');
  });
});

// ── #21 — REPLACEMENT approval decrements the register even with the `toil` module off (no double-debit) ──
describe('#21 REPLACEMENT consume-on-approve is decoupled from the toil module entitlement', () => {
  const policy = (companyId: string): ToilPolicyInput => ({
    companyId,
    enabled: true,
    accrualBasis: 'hours_worked',
    expiryDays: 90,
    onExpiry: 'lapse',
    allowFirstScheduleEligible: true,
    autoAccrueOnApproval: false,
    carryForwardAtYearEnd: false,
  });

  async function replacementTypeId(): Promise<string> {
    const [row] = await owner.db.select({ id: schema.leaveType.id }).from(schema.leaveType).where(eq(schema.leaveType.code, 'REPLACEMENT'));
    return row.id;
  }
  async function replacementBalance(employmentId: string): Promise<number> {
    const [row] = await owner.db
      .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
      .from(schema.leaveLedger)
      .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
      .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
    return Number(row?.bal ?? 0);
  }

  it('approving a REPLACEMENT with the module off consumes the accrual, so a later expiry does not re-debit', async () => {
    const setup = adminCtx(base);
    const e = await hireFT('Replacement Off', { hiredOn: '2024-01-01' });
    await setCompensation(setup, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });

    // Entitle the tenant to `toil` → accrue one rest-day credit. Each snapshot below is resolved AFTER the
    // row it depends on, because a snapshot is point-in-time exactly as it is for a real session.
    await setModule(base.tenantId, 'toil', 'active');
    const on = await entitledCtx(base);
    expect(isModuleEnabled(on, 'toil')).toBe(true);
    await setToilPolicy(on, policy(base.companyId));
    await setRestDay(on, { employmentId: e.employmentId, shiftDate: '2026-07-04' });
    await checkIn(on, { employmentId: e.employmentId, date: '2026-07-04', time: '08:00:00' });
    await checkOut(on, { employmentId: e.employmentId, date: '2026-07-04', time: '17:00:00' });
    const acc = await accrueToil(on, { employmentId: e.employmentId, workedDate: '2026-07-04' });
    expect(await replacementBalance(e.employmentId)).toBe(1);

    // REVOKE the entitlement (no row ⇒ disabled, C7) and re-resolve, then approve a REPLACEMENT leave
    // request (1 working day) through the now-ungated context. This is the whole point of #21 — the
    // gate must be genuinely CLOSED here, so assert it rather than trusting the row write.
    await setModule(base.tenantId, 'toil', null);
    const off = await entitledCtx(base);
    expect(isModuleEnabled(off, 'toil')).toBe(false);
    const typeId = await replacementTypeId();
    const req = await requestLeave(off, { employmentId: e.employmentId, leaveTypeId: typeId, startDate: '2026-07-06', endDate: '2026-07-06' });
    await decideLeave(off, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    // The register must have been decremented (accrual fully consumed) despite the module being off.
    const consumed = (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, acc.accrualId)))[0];
    expect(consumed.status).toBe('taken');
    expect(await replacementBalance(e.employmentId)).toBe(0); // ledger debit + accrual taken net to 0

    // Re-grant and run the expiry sweep (it is gated): there must be NO second debit (no negative balance).
    await setModule(base.tenantId, 'toil', 'active');
    const back = await entitledCtx(base);
    await runToilExpiry(back, { today: '2026-12-31' });
    expect(await replacementBalance(e.employmentId)).toBe(0); // still 0, never negative
  });
});

// ── #33 — absent-row txn ops throw TxnNotFoundError, not BatchNotDraftError ──────────────────────────
describe('#33 update/deleteIndividualTxn on an absent row throws TxnNotFoundError', () => {
  it('update of a nonexistent txn id', async () => {
    const a = adminCtx(base);
    await expect(updateIndividualTxn(a, { id: randomUUID(), amount: 10 })).rejects.toBeInstanceOf(TxnNotFoundError);
  });
  it('delete of a nonexistent txn id', async () => {
    const a = adminCtx(base);
    await expect(deleteIndividualTxn(a, { id: randomUUID() })).rejects.toBeInstanceOf(TxnNotFoundError);
  });
  it('a real draft-batch txn still updates/deletes (no false positive)', async () => {
    const a = adminCtx(base);
    const e = await hireFT('Txn OK');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const { id } = await createIndividualTxn(a, { batchId, employmentId: e.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 100 });
    await expect(updateIndividualTxn(a, { id, amount: 150 })).resolves.toMatchObject({ id });
    await expect(deleteIndividualTxn(a, { id })).resolves.toMatchObject({ id });
  });
});

// ── #34 — the raw cp38ForPeriod query returns exactly ONE row for a supersede boundary month ─────────
describe('#34 cp38 supersede boundary month yields exactly one raw row (exclusive validTo)', () => {
  it('after a supersede, the boundary month matches only the successor row', async () => {
    const a = adminCtx(base);
    const e = await hireFT('CP38 Boundary');
    // Old row 2026-03 → closed at 2026-06-01 when the new row starts; new row open from 2026-06.
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/OLD', amount: 200, validFrom: '2026-03-01' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/NEW', amount: 150, validFrom: '2026-06-01' });

    const rows = await withTenant(a as SessionContext, (tx) => cp38RowsForPeriod(tx, [e.employmentId], '2026-06'));
    expect(rows).toHaveLength(1); // only CP38/NEW; the closed CP38/OLD must NOT match the boundary month
    expect(rows[0].cp38Ref).toBe('CP38/NEW');
  });
});
