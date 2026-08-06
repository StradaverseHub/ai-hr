/**
 * Carry Forward + Expiry + Auto Forfeit — the "Carry-forward & forfeiture" analytics report
 * (core/analytics.ts#carryForwardReport). The underlying carry/expiry/auto-forfeit engine is already
 * shipped (openLeaveYear, accrueEarnedLeave 2D-3, expireCarriedLeave — see test/leave-carry-forward-
 * expiry.test.ts) and the per-employee breakdown already exists (leaveEntitlementBreakdown — see
 * test/leave-entitlement-breakdown.test.ts). This suite covers ONLY the new read: does the report
 * reconcile exactly with what the engine posted, per the approved plan's worked example and edge cases.
 *
 * Design pinned by the plan (read before changing):
 *  - carried / carryForwardExpiryDate come from the shared pure helper (core/leave.ts#resolveCarryBreakdown),
 *    the SAME one leaveEntitlementBreakdown uses — so the report and the /me breakdown can never diverge.
 *  - forfeitedAtOpen / forfeitedAtExpiry are read ONLY from reason-tagged ledger rows (CARRY_FORFEIT_
 *    REASON_CAP / _EXPIRY). Reconstruction is deliberately NOT used for forfeit totals (it cannot
 *    reproduce a PAST forfeit once the engine has already run — currentBalance moves after the sweep).
 *  - Anniversary-cycle EARNED employees get a BLANK expiry (not a projected date) — expireCarriedLeave's
 *    Jan-1 "open marker" check never covers them, a real engine gap the plan flags out of scope.
 *  - Population includes same-year leavers (terminatedOn >= Jan 1 of the reported year).
 *
 * 6e9a126e RELEASE THREE — REPOINTED, and this is the reader the approved plan named as the one release
 * three would break, so every figure below is load-bearing rather than incidental. Days now come from an
 * entitlement template's band and the CARRY CAP + EXPIRY from the leave TYPE's own rule columns, which is
 * where `applyLeaveTypeRules` reads them and — decisively — the only place `expireCarriedLeave` will look
 * before deciding whether to sweep at all. Every expected figure is unchanged.
 *
 * TWO TESTS CONFIGURE DIFFERENTLY AND EACH SAYS WHY IN PLACE. (c) needs an EARNING METHOD, which only the
 * type can carry. (d) needs a DATED cap, which only the template can carry — the type's columns are not
 * effective-dated — so it configures the cap on the band and leaves the type unruled. Both shapes are live
 * resolution paths, not fixture tricks.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompanyLeaveCycle } from '../core/admin';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import { openLeaveYear, expireCarriedLeave, accrueEarnedLeave } from '../core/leave';
import { carryForwardReport } from '../core/analytics';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const hire = (hiredOn: string, name = 'CFR') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `cfr_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/**
 * The same ANNUAL configuration these tests always used, split the way release three splits it: DAYS on an
 * entitlement template's band, CARRY CAP + EXPIRY on the leave TYPE.
 *
 * The type is where they have to go. `expireCarriedLeave` gates its whole sweep on whether the TYPE
 * carries an expiry (`typeCarriesExpiry`) — a per-band expiry never reaches the loop that would honour it
 * — so an expiry configured anywhere else is silently inert and tests (a), (b) and (i) would report a
 * clean zero forfeit while asserting a real one. Configuring it here is the shape the product actually
 * resolves through, not the shape that happens to make a number appear.
 */
const annualPolicy = async (p: {
  annualDays?: number;
  carryForwardMax?: number;
  expiry?: { month: number; day: number } | null;
  from?: string;
}) => {
  const tpl = await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays ?? 12,
    validFrom: p.from ?? '2025-01-01',
  });
  await owner.db
    .update(schema.leaveType)
    .set({
      carryForwardMax: String(p.carryForwardMax ?? 5),
      carryForwardExpiryMonth: p.expiry?.month ?? null,
      carryForwardExpiryDay: p.expiry?.day ?? null,
    })
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  return tpl;
};

const post = (employmentId: string, entryType: 'accrual' | 'debit' | 'adjustment', days: number, effectiveOn: string, reason?: string | null) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
    reason: reason ?? null,
  });

const report = (year: number) => carryForwardReport(adminCtx(b), undefined, { year });

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

describe('carryForwardReport — reconciles with the real engine', () => {
  it('(a) matches what openLeaveYear + expireCarriedLeave actually posted', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // before 12, carry 5, forfeit-at-open 7 → 17
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' }); // forfeit-at-expiry 5 → 12

    const rows = await report(2026);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.employmentId).toBe(emp.employmentId);
    expect(row.carried).toBe(5);
    expect(row.carryForwardExpiryDate).toBe('2026-03-31');
    expect(row.forfeitedAtOpen).toBe(7);
    expect(row.forfeitedAtExpiry).toBe(5);
    expect(row.reasonCodes.sort()).toEqual(['cap', 'expiry']);
  });

  it("(b) the request's worked example, adapted to real entitlement figures: entitlement 14, carry cap 5, carried 5, cap-excess forfeited at open, 3 days taken from the carry window leaves 2 unconsumed → forfeited at expiry", async () => {
    // Reproduces the request's shape (entitlement 14 / used-before-carry 8 / cap 5 / 12-month expiry) with the
    // engine's actual accounting: openLeaveYear's `before` balance is the PRIOR ledger balance (here, 2024's
    // hire-year balance minus what was taken in 2024), not "entitlement minus used within the SAME year" — a
    // same-year debit reduces the current year's balance, not what carries into the NEXT year. So this test
    // takes 8 days in 2024 (reducing 2024's balance before the 2025 carry snapshot) to land on prior=6, and
    // separately proves the "2 unused → forfeited at expiry" half by taking 3 of the 5 carried days in 2025.
    await annualPolicy({ annualDays: 14, carryForwardMax: 5, expiry: { month: 3, day: 31 }, from: '2024-01-01' });
    const emp = await hire('2024-01-01');
    expect(await balance(emp.employmentId)).toBe(14); // hire grant
    await post(emp.employmentId, 'debit', -8, '2024-06-01'); // 8 days used in 2024 → prior-year-end balance 6
    expect(await balance(emp.employmentId)).toBe(6);

    await openLeaveYear(adminCtx(b), { year: 2025 }); // before=6, carry min(6,5)=5, forfeit-at-open 1 → 5+14=19
    expect(await balance(emp.employmentId)).toBe(19);
    const r2025 = await report(2025);
    expect(r2025[0].carried).toBe(5);
    expect(r2025[0].forfeitedAtOpen).toBe(1); // matches the request's "1 day forfeited immediately (exceeds limit)"

    // Take 3 of the carried 5 within the carry window → 2 days remain unconsumed and lapse at expiry.
    await post(emp.employmentId, 'debit', -3, '2025-02-01');
    const sweep = await expireCarriedLeave(adminCtx(b), { today: '2025-03-31' });
    expect(sweep.forfeited).toBe(2); // matches the request's "2 days unused → auto forfeited"

    const r2025After = await report(2025);
    expect(r2025After[0].forfeitedAtExpiry).toBe(2);
    expect(r2025After[0].forfeitedAtOpen).toBe(1);
  });

  it('(c) anniversary-cycle earned employee: 2D-3 forfeit tagged, lands in the right year row, expiry blank', async () => {
    await setCompanyLeaveCycle(adminCtx(b), { companyId: b.companyId, cycle: 'anniversary' });
    // The one test here that needs an EARNING METHOD. A method can only be configured on the leave type,
    // and `applyLeaveTypeRules` overlays a ruled type's whole rule set over the band — so the cap and
    // expiry must ride the type alongside it, or they would be overwritten with the type's NULLs.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    await owner.db
      .update(schema.leaveType)
      .set({
        accrualMethod: 'earned_monthly',
        carryForwardMax: '5',
        carryForwardExpiryMonth: 3,
        carryForwardExpiryDay: 31,
      })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'AnnivCFR', primaryEmail: `anniv_cfr_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-03-10',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    await accrueEarnedLeave(adminCtx(b), { asOf: '2027-02-28' }); // full first cycle (Mar26-Feb27) → 12
    expect(await balance(emp.employmentId)).toBe(12);
    const r = await accrueEarnedLeave(adminCtx(b), { asOf: '2027-06-15' }); // new cycle at 2027-03-01: forfeit 12−5=7
    expect(r.forfeits).toBe(1);

    // The 2D-3 forfeit is dated 2027-03-01 (the employee's own cycle start) — it falls in the 2027 report.
    const rows2027 = await report(2027);
    const row = rows2027.find((x) => x.employmentId === emp.employmentId);
    expect(row).toBeDefined();
    expect(row!.forfeitedAtOpen).toBe(7);
    expect(row!.carryForwardExpiryDate).toBeNull(); // engine gap: expireCarriedLeave never sweeps anniversary-earned
    expect(row!.forfeitedAtExpiry).toBe(0);
  });

  it('(d) entitlement cap changed between years → past-year report uses the version active at that year open', async () => {
    // ⚠️ THE ONE TEST HERE THAT CONFIGURES CARRY ON THE BAND RATHER THAN THE TYPE, and the reason is the
    // thing it is asserting. The claim is that a report for a CLOSED year resolves the configuration that
    // was in force when that year opened, not today's — so the cap has to be attached to something DATED.
    // The leave type's rule columns are not dated; an entitlement template is, by the same close-then-
    // insert supersession `leave_policy` used. So the cap rides the template's own band here, which is
    // live behaviour for a type that carries no rule columns (`policyForDatedReader` →
    // `policyFromTemplateBand`), and the leave type is deliberately left unruled so nothing overlays it.
    // No expiry is involved, so this test never reaches `expireCarriedLeave`'s type-only expiry gate.
    const p1 = await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 5 }],
      validFrom: '2025-01-01',
    });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // uses cap 5: before 12, carry 5, forfeit 7 → 17

    // Supersede the running version from 2027 with a more generous one. `updateEntitlementTemplate` is
    // close-then-insert on one lineage — exactly what the hand-written `leave_policy.validTo` update this
    // replaces used to do, and one eligibility rule keeps pointing at the lineage throughout.
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: p1.lineageId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 10 }],
      validFrom: '2027-01-01',
    });
    await openLeaveYear(adminCtx(b), { year: 2027 }); // uses cap 10 now: before 17-? see balance; carry up to 10

    const r2026 = await report(2026);
    expect(r2026[0].carried).toBe(5); // resolved from the cap-5 version active at 2026-01-01, not the current cap-10
  });

  it('(e) a manual untagged negative adjustment dated Jan-1 is NOT reported as a forfeit', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // tagged forfeit 7 at 2026-01-01
    // A second, UNTAGGED manual adjustment on the exact same date (e.g. a manual correction).
    await post(emp.employmentId, 'adjustment', -1, '2026-01-01', null);

    const rows = await report(2026);
    // Only the tagged 7 counts — the untagged -1 is invisible to the report.
    expect(rows[0].forfeitedAtOpen).toBe(7);
  });

  it('(f) a mid-year leaver with a forfeit still appears in the report', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // forfeit 7 at open
    await terminateEmployment(adminCtx(b), { employmentId: emp.employmentId, terminationDate: '2026-06-30' });

    const rows = await report(2026);
    const row = rows.find((r) => r.employmentId === emp.employmentId);
    expect(row).toBeDefined();
    expect(row!.forfeitedAtOpen).toBe(7);
  });

  it('(g) garbage &year param defaults without a 500 (parseReportYear)', async () => {
    const { parseReportYear } = await import('../core/analytics');
    const today = '2026-07-03';
    expect(parseReportYear(() => 'not-a-year', today)).toBe(2026);
    expect(parseReportYear(() => '99999', today)).toBe(2026);
    expect(parseReportYear(() => null, today)).toBe(2026);
    expect(parseReportYear(() => '2025', today)).toBe(2025);
  });

  it('(h) no-expiry policy → blank expiry, zero expiry forfeit', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: null });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // Even far in the future, nothing expires.
    await expireCarriedLeave(adminCtx(b), { today: '2030-12-31' });

    const rows = await report(2026);
    const row = rows.find((r) => r.employmentId === emp.employmentId);
    expect(row!.carryForwardExpiryDate).toBeNull();
    expect(row!.forfeitedAtExpiry).toBe(0);
  });

  it('(i) report figures match the /me breakdown for the same employee', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });

    const rows = await report(2026);
    const row = rows.find((r) => r.employmentId === emp.employmentId)!;
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-03-31');
    expect(bd).not.toBeNull();
    expect(row.carried).toBe(bd!.carriedForward);
    expect(row.carryForwardExpiryDate).toBe(bd!.carryForwardExpiryDate);
    // The breakdown's `forfeited` is capExcess + expiryForfeit (reconstructed); the report's tagged sum
    // must agree numerically for this fully-tagged, single-year scenario (no untagged rows).
    expect(row.forfeitedAtOpen + row.forfeitedAtExpiry).toBe(bd!.forfeited);
  });

  it('(j) scopeIds / department filter narrows the report the same way as other reads', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const empA = await hire('2025-01-01', 'DeptA');
    const empB = await hireEmployee(adminCtx(b), {
      person: { fullName: 'DeptB', primaryEmail: `deptb_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptB,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const all = await carryForwardReport(adminCtx(b), undefined, { year: 2026 });
    expect(all.map((r) => r.employmentId).sort()).toEqual([empA.employmentId, empB.employmentId].sort());

    const filtered = await carryForwardReport(adminCtx(b), undefined, {
      year: 2026,
      filter: { departmentId: b.deptA },
    });
    expect(filtered.map((r) => r.employmentId)).toEqual([empA.employmentId]);
  });
});
