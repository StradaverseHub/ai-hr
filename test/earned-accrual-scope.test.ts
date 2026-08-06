/**
 * feedback 2c7c6385 — "Run Earned Accrual" scope + preview (dry-run) coverage.
 *
 * The bare fire-immediately button is replaced with a scoped, preview-then-confirm flow over the SAME
 * idempotent accrual engine. These tests lock the four load-bearing guarantees:
 *   • dryRun writes NOTHING (no ledger rows, no audit event) yet returns the full grouped breakdown.
 *   • preview MUST NOT LIE — the dry-run numbers equal the real commit's grant + per-group entitlement.
 *   • the scope filters (company / grade / leave-type) narrow the target population correctly.
 *   • a scoped re-run is idempotent (grants 0 the second time) and the commit event carries the scope.
 * Plus the pure Leave-Year → asOf mapping (asOfForLeaveYear).
 *
 * 6e9a126e RELEASE THREE — REPOINTED. The scope filters, the grouped breakdown and the dry-run/commit
 * equality are all engine behaviour that survived intact; only the fixture that configures "12 days,
 * earned monthly" moved. Days now come from an entitlement template band and the earning method from the
 * leave TYPE, so `earnedPolicy()` writes both halves. NOTE the grade-scope test still hires one graded and
 * one ungraded employee against ONE grade-less template: the scope filter being exercised is
 * accrueEarnedLeave's `gradeIds` argument, which narrows the POPULATION and has nothing to do with how
 * entitlement resolves — that separation is exactly why this test did not need re-thinking.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, asOfForLeaveYear } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

const ledgerCount = async () => {
  const [r] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.tenantId, b.tenantId));
  return r.n;
};
const ledgerSum = async () => {
  const [r] = await owner.db
    .select({ s: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.tenantId, b.tenantId));
  return Number(r.s);
};
const accrualEvents = async () => {
  const rows = await owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.eventType, 'leave.earned-accrual.run'),
      ),
    );
  return rows;
};

const mkGrade = async (code: string, name: string, rank: number) => {
  const [g] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code, name, rank })
    .returning({ id: schema.jobGrade.id });
  return g.id;
};
const mkCompany = async (legalName: string) => {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: 'Ops' })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
};
const mkType = async (code: string, name: string) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name, paid: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};
const earnedPolicy = async (leaveTypeId: string, days = 12) => {
  await seedEntitlement(adminCtx(b), { leaveTypeId, annualDays: days, validFrom: '2026-01-01' });
  await owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: 'earned_monthly' })
    .where(eq(schema.leaveType.id, leaveTypeId));
};

const hire = (companyId: string, departmentId: string, gradeId: string | null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Acc', primaryEmail: `acc_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const run = (p: Parameters<typeof accrueEarnedLeave>[1]) => accrueEarnedLeave(adminCtx(b), p);

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('asOfForLeaveYear — Leave Year → asOf mapping (product decision 1)', () => {
  it('current year → to-date; past year → year-end; future year → full-year projection', () => {
    const today = '2026-07-10';
    expect(asOfForLeaveYear(2026, today)).toBe('2026-07-10'); // current → to-date
    expect(asOfForLeaveYear(2025, today)).toBe('2025-12-31'); // past → full cycle
    expect(asOfForLeaveYear(2027, today)).toBe('2027-12-31'); // future → full-year projection (600=50×12)
  });
});

describe('feedback 2c7c6385 — scoped earned accrual + dry-run preview', () => {
  it('dryRun writes NOTHING (no ledger rows, no audit event) yet returns the grouped breakdown', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    const gradeA = await mkGrade('A', 'Grade A', 1);
    await hire(b.companyId, b.deptA, gradeA);
    await hire(b.companyId, b.deptA, null);

    const res = await run({ asOf: '2026-06-15', dryRun: true });

    // no writes at all
    expect(await ledgerCount()).toBe(0);
    expect((await accrualEvents()).length).toBe(0);
    // grouped breakdown: one row per Company×Grade×Type
    expect(res.granted).toBe(2);
    expect(res.breakdown.length).toBe(2);
    const graded = res.breakdown.find((g) => g.gradeName === 'Grade A')!;
    const ungraded = res.breakdown.find((g) => g.gradeName === null)!;
    expect(graded.employeeCount).toBe(1);
    expect(graded.leaveTypeCode).toBe('ANNUAL');
    expect(graded.accrualPeriod).toBe(2026);
    expect(graded.method).toBe('earned_monthly');
    expect(graded.entitlementGenerated).toBe(6); // Jan–Jun
    expect(ungraded.entitlementGenerated).toBe(6);
  });

  it('preview MUST NOT LIE — dry-run granted/breakdown equals the real commit', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    const gradeA = await mkGrade('A', 'Grade A', 1);
    await hire(b.companyId, b.deptA, gradeA);
    await hire(b.companyId, b.deptA, null);

    const preview = await run({ asOf: '2026-06-15', dryRun: true });
    const commit = await run({ asOf: '2026-06-15' });

    expect(commit.granted).toBe(preview.granted);
    expect(commit.forfeits).toBe(preview.forfeits);
    // same grouped numbers
    const norm = (r: typeof preview.breakdown) =>
      r
        .map((g) => `${g.companyId}|${g.gradeId}|${g.leaveTypeId}=${g.employeeCount}:${g.entitlementGenerated}`)
        .sort();
    expect(norm(commit.breakdown)).toEqual(norm(preview.breakdown));
    // and the committed ledger actually holds the previewed total
    const previewTotal = preview.breakdown.reduce((s, g) => s + g.entitlementGenerated, 0);
    expect(await ledgerSum()).toBe(previewTotal); // 12
  });

  it('company scope narrows to the selected company only', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    const beta = await mkCompany('Beta Sdn Bhd');
    await hire(b.companyId, b.deptA, null);
    await hire(beta.companyId, beta.deptId, null);

    const all = await run({ asOf: '2026-06-15', dryRun: true });
    expect(new Set(all.breakdown.map((g) => g.companyId)).size).toBe(2);

    const scoped = await run({ asOf: '2026-06-15', companyIds: [b.companyId], dryRun: true });
    expect(scoped.granted).toBe(1);
    expect(scoped.breakdown.every((g) => g.companyId === b.companyId)).toBe(true);
  });

  it('grade scope narrows to the selected grade only', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    const gradeA = await mkGrade('A', 'Grade A', 1);
    await hire(b.companyId, b.deptA, gradeA);
    await hire(b.companyId, b.deptA, null); // ungraded

    const scoped = await run({ asOf: '2026-06-15', gradeIds: [gradeA], dryRun: true });
    expect(scoped.granted).toBe(1);
    expect(scoped.breakdown.length).toBe(1);
    expect(scoped.breakdown[0].gradeName).toBe('Grade A');
  });

  it('leave-type scope narrows to the selected type only', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    const sickId = await mkType('SICK', 'Sick Leave');
    await earnedPolicy(sickId, 14);
    await hire(b.companyId, b.deptA, null);

    const all = await run({ asOf: '2026-06-15', dryRun: true });
    expect(new Set(all.breakdown.map((g) => g.leaveTypeCode))).toEqual(new Set(['ANNUAL', 'SICK']));

    const scoped = await run({ asOf: '2026-06-15', leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(scoped.breakdown.every((g) => g.leaveTypeCode === 'ANNUAL')).toBe(true);
  });

  it('a scoped real run is idempotent and the commit event carries the scope (audit distinguishes manual vs cron)', async () => {
    await earnedPolicy(b.annualLeaveTypeId);
    await hire(b.companyId, b.deptA, null);

    const first = await run({ asOf: '2026-06-15', companyIds: [b.companyId] });
    expect(first.granted).toBe(1);
    const afterFirst = await ledgerSum();

    const second = await run({ asOf: '2026-06-15', companyIds: [b.companyId] });
    expect(second.granted).toBe(0); // nothing more to grant
    expect(second.breakdown[0].entitlementGenerated).toBe(0);
    expect(await ledgerSum()).toBe(afterFirst); // ledger unchanged

    const events = await accrualEvents();
    expect(events.length).toBe(2);
    const payload = events[0].payload as { companyIds?: string[] };
    expect(payload.companyIds).toEqual([b.companyId]);
  });
});
