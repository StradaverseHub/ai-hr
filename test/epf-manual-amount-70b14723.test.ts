/**
 * Item 70b14723 — MANUAL EPF CONTRIBUTION CATEGORIES (employee amount, employer amount, or both).
 *
 * EVERY MONEY ASSERTION IS ON A GENERATED, STORED PAYSLIP, or on the bytes of the KWSP upload file. A
 * row-shape assertion would prove a column was written and nothing about what anybody is paid.
 *
 * ⚠️ THE TRAP THIS FILE IS BUILT TO AVOID, and it is the reason every case below starts the same way. A
 * fixture whose SCHEDULE figure already equals the typed figure makes every assertion here pass no matter
 * what the code does — `expect(slip.epfEmployee).toBe(500)` is vacuous the moment the Third Schedule also
 * says 500. So the fixture is chosen so the two DISAGREE, and the disagreement is asserted FIRST:
 *
 *     basic RM6,000  →  KWSP Third Schedule  660 employee / 720 employer
 *     typed          →                       500 employee / 650 employer
 *
 * Both typed figures are BELOW the schedule, which is also the case the approved plan spends most of its
 * words on: it is allowed, recorded and warned about in prose, never refused. See ADR-0087.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { InvalidEpfElectionError, setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { epf, epfContribution } from '../localization/my/payroll';
import { computeMonthlyRuns } from '../localization/my/multicycle';
import { multiCycleWorksheetMY } from '../localization/my/multicycle-worksheet';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { explainStatutory, isSetByHand } from '../core/statutory-explain';
import { reportPreview } from '../core/reporting';
import { borangAFrom } from '../lib/borang-a';
import { borangAFileEmployeesFrom, buildBorangAFile, parseBorangAFileTotals } from '../lib/kwsp-borang-a-file';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const CFG = DEFAULT_MY_STATUTORY;
const SALARY = 6000;
const TYPED_EMPLOYEE = 500;
const TYPED_EMPLOYER = 650;
const REASON = 'Pre-1998 member — contribution agreed at the grandfathered rate (KWSP ref 2026/118)';

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// PURE — the calculator. No database; the arithmetic the ADR argues about, asserted rather than described.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('70b14723 (pure) — the typed amount replaces the Third Schedule reading, per side', () => {
  it('THE DISAGREEMENT, first: the schedule and the typed figures are DIFFERENT numbers', () => {
    // Without this, every assertion in this file would pass on a fixture that happened to agree.
    expect(epf(SALARY, 0, CFG.epf)).toEqual({ employee: 660, employer: 720 });
    expect(TYPED_EMPLOYEE).not.toBe(660);
    expect(TYPED_EMPLOYER).not.toBe(720);
    // …and BOTH typed figures are BELOW the schedule, which is deliberately not refused (ADR-0087).
    expect(TYPED_EMPLOYEE).toBeLessThan(660);
    expect(TYPED_EMPLOYER).toBeLessThan(720);
  });

  it('substitutes each side, and NEITHER side is floored at statutory', () => {
    const both = { mode: 'manual_amount' as const, employeeAmount: TYPED_EMPLOYEE, employerAmount: TYPED_EMPLOYER };
    expect(epf(SALARY, 0, CFG.epf, both)).toEqual({ employee: 500, employer: 650 });
    // ONE side only: the other keeps the schedule. This is what makes the ticket's three categories the
    // three combinations of two nullable amounts rather than three enum labels.
    expect(epf(SALARY, 0, CFG.epf, { mode: 'manual_amount', employeeAmount: TYPED_EMPLOYEE })).toEqual({ employee: 500, employer: 720 });
    expect(epf(SALARY, 0, CFG.epf, { mode: 'manual_amount', employerAmount: TYPED_EMPLOYER })).toEqual({ employee: 660, employer: 650 });
    // A manual_amount election with NO amount cannot be saved (see the refusals below) and computes as the
    // schedule if one ever reached here — it elects nothing.
    expect(epf(SALARY, 0, CFG.epf, { mode: 'manual_amount' })).toEqual({ employee: 660, employer: 720 });
    // NOT rounded up to the ringgit: a typed figure is not a schedule reading, and 500.50 must stay 500.50.
    expect(epf(SALARY, 0, CFG.epf, { mode: 'manual_amount', employeeAmount: 500.5 }).employee).toBe(500.5);
    // Defence only — entry refuses a negative. The calculator must never produce one.
    expect(epf(SALARY, 0, CFG.epf, { mode: 'manual_amount', employeeAmount: -5 }).employee).toBe(0);
  });

  it('K₁ + Kₜ still equals the employee EPF exactly — ADR-0046 objection #1, answered by the placement', () => {
    const BONUS = 2000;
    // THE NON-VACUITY PARTNER: on AUTO the month is one combined lookup and Kₜ is a real, non-zero number.
    const auto = epfContribution(SALARY, BONUS, CFG.epf);
    expect(auto).toEqual({ employee: 880, employer: 960, employeeOnBonus: 220 });
    expect(auto.employeeOnBonus).toBeGreaterThan(0);
    // With a typed EMPLOYEE amount the month's figure and the same lookup on the normal wage alone are the
    // SAME number, so Kₜ = 0 by subtraction — not by a special case — and K₁ is the whole typed amount.
    const manual = epfContribution(SALARY, BONUS, CFG.epf, { mode: 'manual_amount', employeeAmount: TYPED_EMPLOYEE, employerAmount: TYPED_EMPLOYER });
    expect(manual).toEqual({ employee: 500, employer: 650, employeeOnBonus: 0 });
    expect(manual.employee - manual.employeeOnBonus, 'K₁').toBe(TYPED_EMPLOYEE);
    expect(manual.employeeOnBonus + (manual.employee - manual.employeeOnBonus)).toBe(manual.employee);
    // An EMPLOYER-only election leaves the employee side's real split completely untouched.
    const erOnly = epfContribution(SALARY, BONUS, CFG.epf, { mode: 'manual_amount', employerAmount: TYPED_EMPLOYER });
    expect(erOnly).toEqual({ employee: 880, employer: 650, employeeOnBonus: 220 });
  });

  it('applies across EVERY rule branch — Part A, Part E senior, non-citizen flat, and age ≥ 75', () => {
    const el = { mode: 'manual_amount' as const, employeeAmount: TYPED_EMPLOYEE, employerAmount: TYPED_EMPLOYER };
    const cases: { sel: { age: number; citizenship: 'citizen' | 'pr' | 'non_citizen' }; byRule: [number, number] }[] = [
      { sel: { age: 35, citizenship: 'citizen' }, byRule: [660, 720] },
      { sel: { age: 62, citizenship: 'citizen' }, byRule: [0, 240] }, // Part E: employee 0%, employer 4%
      { sel: { age: 30, citizenship: 'non_citizen' }, byRule: [120, 120] }, // flat 2%/2%
      { sel: { age: 76, citizenship: 'citizen' }, byRule: [0, 0] }, // no mandatory EPF at all
    ];
    for (const c of cases) {
      const label = `${c.sel.age}/${c.sel.citizenship}`;
      // The branch's OWN figure first — the non-vacuity partner for each of the four.
      const byRule = epfContribution(SALARY, 0, CFG.epf, undefined, c.sel);
      expect([byRule.employee, byRule.employer], label).toEqual(c.byRule);
      const typed = epfContribution(SALARY, 0, CFG.epf, el, c.sel);
      expect([typed.employee, typed.employer], `${label} honours the typed figure`).toEqual([500, 650]);
      expect(typed.employeeOnBonus, label).toBe(0);
      // ⚠️ WITH A BONUS, AND THIS IS THE HALF THAT NEEDS ITS OWN ASSERTION. On the Part A path Kₜ comes out
      // at 0 through `epf()`'s own substitution — the difference of two identical lookups — so the wrapper's
      // explicit zero is redundant THERE. It is NOT redundant on the other three branches, which never call
      // `epf()`: a non-citizen's rule figure for a RM2,000 bonus is ceil(2% × 2,000) = RM40, and left in
      // place beside a typed employee total of RM500 it would make K₁ = 460 and break K₁ + Kₜ = the
      // employee EPF for exactly the employees a hand-set figure is most often agreed for.
      const bonusRule = epfContribution(SALARY, 2000, CFG.epf, undefined, c.sel);
      const bonusTyped = epfContribution(SALARY, 2000, CFG.epf, el, c.sel);
      expect(bonusTyped.employee, `${label} + bonus: still the typed figure`).toBe(500);
      expect(bonusTyped.employeeOnBonus, `${label} + bonus: Kₜ = 0 (rule figure was ${bonusRule.employeeOnBonus})`).toBe(0);
      expect(bonusTyped.employee - bonusTyped.employeeOnBonus, `${label} + bonus: K₁`).toBe(TYPED_EMPLOYEE);
    }
    // …and the rule figures the assertions above displace are genuinely non-zero on two of the four, so the
    // loop is not passing on branches that had nothing to zero.
    expect(epfContribution(SALARY, 2000, CFG.epf, undefined, { age: 30, citizenship: 'non_citizen' }).employeeOnBonus).toBe(40);
    expect(epfContribution(SALARY, 2000, CFG.epf, undefined, { age: 35, citizenship: 'citizen' }).employeeOnBonus).toBe(220);
  });

  it('a MONTHLY amount is charged ONCE across a regular + bonus pair — ADR-0046 objection #2', () => {
    const opts = { epfElection: { mode: 'manual_amount' as const, employeeAmount: TYPED_EMPLOYEE, employerAmount: TYPED_EMPLOYER } };
    const runs = [
      { runType: 'regular' as const, payment: SALARY },
      { runType: 'bonus' as const, payment: 2000 },
    ];
    // THE NON-VACUITY PARTNER: on AUTO the bonus run charges a real increment on both sides.
    const autoM = computeMonthlyRuns({ month: 1, runs });
    expect(autoM.runs[1].epfEmployee).toBe(220);
    expect(autoM.runs[1].epfEmployer).toBe(240);
    const m = computeMonthlyRuns({ month: 1, opts, runs });
    expect(m.runs[0].epfEmployee).toBe(TYPED_EMPLOYEE);
    expect(m.runs[0].epfEmployer).toBe(TYPED_EMPLOYER);
    expect(m.runs[1].epfEmployee, 'the bonus run adds NOTHING to a monthly amount').toBe(0);
    expect(m.runs[1].epfEmployer).toBe(0);
    expect(m.monthly.epfEmployee).toBe(TYPED_EMPLOYEE);
    // …and in the OTHER order too (a bonus run that opens the month, then the regular run restating it).
    const reversed = computeMonthlyRuns({ month: 1, opts, runs: [runs[1], { ...runs[0] }] });
    expect(reversed.runs.reduce((a, r) => a + r.epfEmployee, 0)).toBe(TYPED_EMPLOYEE);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// STORED PAYSLIPS, THE KWSP FILE, THE SCREEN, THE WORKSHEET AND THE REFUSALS.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

let b: Base;
let a: SessionContext;
let seq = 0;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = adminCtx(b);
  await setCompanyStatutoryMY(a, { companyId: b.companyId, epfEmployerNo: '019632261' });
});

async function hire(name: string, ic: string, epfNumber: string, salary = SALARY) {
  seq += 1;
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `epfman_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: salary, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, epfNumber, taxCategory: 1, numChildren: 0 });
  return e;
}

/** Put an employee on the typed monthly amounts, through the SAME writer the screen uses. */
const elect = (personId: string, ic: string, epfNumber: string, p: { employee?: number; employer?: number; reason?: string }) =>
  setStatutoryProfileMY(a, {
    personId,
    icNumber: ic,
    epfNumber,
    taxCategory: 1,
    numChildren: 0,
    epfMode: 'manual_amount',
    epfEmployeeAmount: p.employee ?? null,
    epfEmployerAmount: p.employer ?? null,
    epfManualReason: p.reason ?? REASON,
  });

type Stat = Record<string, number> & {
  bases?: Record<string, number>;
  epfMode?: string;
  epfManual?: { reason: string; employee?: { system: number; applied: number }; employer?: { system: number; applied: number } };
};
const slipsOf = async (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

async function runRegular(period = '2026-07') {
  const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId });
  return batchId;
}

describe('70b14723 — the typed amount reaches the payslip, and the schedule figure travels with it', () => {
  it('the payslip carries the typed figures, NOT the schedule ones, and stamps both', async () => {
    const man = await hire('MANUAL MEMBER', '900101015001', '18690645');
    const auto = await hire('AUTO MEMBER', '900101015002', '19807671');
    await elect(man.personId, '900101015001', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });

    const batchId = await runRegular();
    const slips = await slipsOf(batchId);
    const mSlip = statOf(slips.find((s) => s.employmentId === man.employmentId)!);
    const aSlip = statOf(slips.find((s) => s.employmentId === auto.employmentId)!);

    // ── THE NON-VACUITY PARTNER, ON THE SAME RUN. The identical employee on Auto is the system's own
    //    figure, and it is NOT the typed one. Everything below is a comparison, not a coincidence.
    expect(Number(aSlip.epfEmployee), "the system's own figure for this wage").toBe(660);
    expect(Number(aSlip.epfEmployer)).toBe(720);
    expect(Number(mSlip.epfEmployee)).not.toBe(Number(aSlip.epfEmployee));

    expect(Number(mSlip.epfEmployee)).toBe(TYPED_EMPLOYEE);
    expect(Number(mSlip.epfEmployer)).toBe(TYPED_EMPLOYER);
    // The stamp: what the rule would have said, beside what was used, plus the operator's reason.
    expect(mSlip.epfManual).toEqual({
      reason: REASON,
      employee: { system: 660, applied: 500 },
      employer: { system: 720, applied: 650 },
    });
    expect(mSlip.epfMode).toBe('manual_amount');
    // The WAGE BASIS is the true wage and is untouched — which is exactly what makes the KWSP file below
    // carry a contribution that disagrees with the schedule for that wage.
    expect(Number(mSlip.bases!.epf)).toBe(SALARY);
    // …and the employee left on Auto has NO stamp at all: their payslip is byte-identical to a pre-0491 run.
    expect(aSlip.epfManual).toBeUndefined();
    expect(JSON.stringify(aSlip)).not.toContain('epfManual');
  });

  it('a side left blank keeps the schedule, and the stamp says nothing about it', async () => {
    const e = await hire('EMPLOYER ONLY', '900101015003', '18690645');
    await elect(e.personId, '900101015003', '18690645', { employer: TYPED_EMPLOYER });
    const st = statOf((await slipsOf(await runRegular()))[0]);
    expect(Number(st.epfEmployer)).toBe(TYPED_EMPLOYER);
    expect(Number(st.epfEmployee), 'the employee side is still the Third Schedule').toBe(660);
    expect(st.epfManual!.employer).toEqual({ system: 720, applied: 650 });
    // NOT `{system: 0, applied: 0}`: a zero here would assert the rule produced nothing for a side nobody
    // touched, on the one figure a reader is checking the typed amount against.
    expect(st.epfManual!.employee).toBeUndefined();
  });

  it('the typed EPF is the relief the SAME MONTH’s PCB is computed on', async () => {
    // A tax claim, not a contribution one: the employee's EPF is subtracted inside P. If the typed amount
    // were applied after the kernel composed the payslip, month N's tax would still be on the schedule
    // figure while month N+1's replay folded the typed one — a divergence nobody would ever see.
    // RM12,000, not the file's RM6,000: at RM6,000 single the monthly MTD is nil, and a test that compares
    // 0 against 0 proves nothing. The typed RM500 is still far below this wage's schedule figure (1,320).
    const TAXED = 12000;
    expect(epf(TAXED, 0, CFG.epf).employee).toBe(1320);
    const man = await hire('TAXED MANUAL', '900101015004', '18690645', TAXED);
    const auto = await hire('TAXED AUTO', '900101015005', '19807671', TAXED);
    await elect(man.personId, '900101015004', '18690645', { employee: TYPED_EMPLOYEE });
    const slips = await slipsOf(await runRegular());
    const m = statOf(slips.find((s) => s.employmentId === man.employmentId)!);
    const au = statOf(slips.find((s) => s.employmentId === auto.employmentId)!);
    expect(Number(au.pcb), 'the fixture must produce a non-zero tax, or this proves nothing').toBeGreaterThan(0);
    // LESS EPF relief ⇒ MORE chargeable income ⇒ MORE tax. The direction is the assertion.
    expect(Number(m.pcb)).toBeGreaterThan(Number(au.pcb));
  });

  it('a BONUS run in the same month adds NOTHING — the ADR-0046 mis-application', async () => {
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const ent = await entitledCtx(b);
    const man = await hire('BONUS MANUAL', '900101015006', '18690645');
    const auto = await hire('BONUS AUTO', '900101015007', '19807671');
    await elect(man.personId, '900101015006', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });

    const reg = await createBatch(ent, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(ent, { batchId: reg.batchId });
    const extra = await createAdditionalRun(ent, { companyId: b.companyId, payPeriod: '2026-07', runType: 'bonus' });
    for (const e of [man, auto]) await setPayrollInput(ent, { batchId: extra.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 2000 });
    await generatePayslips(ent, { batchId: extra.batchId });

    const bonusSlips = await slipsOf(extra.batchId);
    const mB = statOf(bonusSlips.find((s) => s.employmentId === man.employmentId)!);
    const aB = statOf(bonusSlips.find((s) => s.employmentId === auto.employmentId)!);
    // THE NON-VACUITY PARTNER: the Auto employee's bonus run charges a real increment, so "0" below is a
    // fact about the manual employee and not about bonus runs in general.
    expect(Number(aB.epfEmployee), 'Auto: the bonus run tops the month up').toBe(220);
    expect(Number(aB.epfEmployer)).toBe(240);
    expect(Number(mB.epfEmployee), 'a monthly amount is charged ONCE, by the run that carries normal pay').toBe(0);
    expect(Number(mB.epfEmployer)).toBe(0);
    // …and the MONTH totals exactly the typed figures, not twice them.
    const regSlips = await slipsOf(reg.batchId);
    const mR = statOf(regSlips.find((s) => s.employmentId === man.employmentId)!);
    expect(Number(mR.epfEmployee) + Number(mB.epfEmployee)).toBe(TYPED_EMPLOYEE);
    expect(Number(mR.epfEmployer) + Number(mB.epfEmployer)).toBe(TYPED_EMPLOYER);
    // The bonus slip's stamp reports the run's OWN increment as `system`, not the month's — so `system` and
    // `applied` are the same kind of number and the pair is a comparison.
    expect(mB.epfManual!.employee).toEqual({ system: 220, applied: 0 });
  });

  it('a REPROCESS reproduces the typed figures to the sen — there is no snapshot to defeat', async () => {
    const man = await hire('REPROCESS MANUAL', '900101015008', '18690645');
    await elect(man.personId, '900101015008', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });
    const batchId = await runRegular();
    const first = statOf((await slipsOf(batchId))[0]);
    // THE REAL REPROCESS PATH — `reprocessSubset` on a PROCESSED batch, which is what the Reprocess button
    // calls. A second `generatePayslips` with no subset is refused (the batch is no longer a draft), so
    // asserting through that would have been asserting about a code path no operator can reach.
    const reprocess = () => generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [man.employmentId], reason: 'test' } });
    await reprocess();
    const again = statOf((await slipsOf(batchId))[0]);
    expect(Number(again.epfEmployee)).toBe(TYPED_EMPLOYEE);
    expect(Number(again.epfEmployer)).toBe(TYPED_EMPLOYER);
    expect(Number(again.epfEmployee)).toBe(Number(first.epfEmployee));
    expect(again.epfManual).toEqual(first.epfManual);

    // ⚠️ AND THE HAZARD IS THE MIRROR IMAGE, pinned so it is a stated consequence rather than a surprise:
    // the amount is read LIVE, so changing it and reprocessing a run somebody has already reviewed WILL
    // move that run's figures. Only a CLOSED run is protected, by trigger.
    await elect(man.personId, '900101015008', '18690645', { employee: 123.45, employer: TYPED_EMPLOYER });
    await reprocess();
    expect(Number(statOf((await slipsOf(batchId))[0]).epfEmployee)).toBe(123.45);
  });
});

describe('70b14723 — the submission file and the screen', () => {
  it('the KWSP Borang A upload file carries the typed contributions against the TRUE wage', async () => {
    const man = await hire('FILED MEMBER', '900101015009', '18690645');
    await elect(man.personId, '900101015009', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });
    await runRegular('2026-07');

    const r = await reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-07' });
    const row = r.rows[0];
    // NON-VACUITY: the wage column is the real RM6,000, whose schedule figures are 660/720 — so the two
    // columns on this row genuinely disagree with the schedule, which is the consequence the plan discloses.
    expect(Number(row.wage)).toBe(SALARY);
    expect(epf(Number(row.wage), 0, CFG.epf)).toEqual({ employee: 660, employer: 720 });
    expect(Number(row.employee)).toBe(TYPED_EMPLOYEE);
    expect(Number(row.employer)).toBe(TYPED_EMPLOYER);

    // …and through to the EMITTED BYTES, the thing that is actually uploaded to i-Akaun.
    const form = borangAFrom({ header: r.meta.formHeader!, rows: r.rows });
    const rows = form.pages.flatMap((p) => p.rows);
    const text = buildBorangAFile({
      employer: { epfRefNo: form.employerRef, code: 'DSK', periodMonth: 8, periodYear: 2026 },
      // THROUGH `borangAFileEmployeesFrom`, which is the ONE copy of which share goes into which nine-wide
      // digit field and is what app/payroll/borang-a/shared.ts calls. Spelling the mapping out again here
      // would have made this test assert against a restatement of the production path rather than the path
      // — and it did, until a defect that zeroed the employee box left this case green.
      employees: borangAFileEmployeesFrom(rows),
    });
    // Read back OUT of the emitted characters, in CENTS, from the header, the trailer and the 02 records —
    // three independent places the figure has to be, and all three have to be the typed one.
    const totals = parseBorangAFileTotals(text);
    expect(totals.headerEmployerCents).toBe(TYPED_EMPLOYER * 100);
    expect(totals.headerEmployeeCents).toBe(TYPED_EMPLOYEE * 100);
    expect(totals.trailerEmployerCents).toBe(TYPED_EMPLOYER * 100);
    expect(totals.trailerEmployeeCents).toBe(TYPED_EMPLOYEE * 100);
    expect(totals.detailEmployerCents).toBe(TYPED_EMPLOYER * 100);
    expect(totals.detailEmployeeCents).toBe(TYPED_EMPLOYEE * 100);
    // …against the TRUE wage in the Upah field, which is the disclosed consequence.
    expect(totals.detailWageCents).toBe(SALARY * 100);
    // Cents, in the 02 record's own digit fields: 650.00 and 500.00 zero-padded to nine.
    expect(text).toContain('000065000');
    expect(text).toContain('000050000');
  });

  it('Statutory Detail reports it as set by hand THROUGH THE r364 SEAM, with no rate and no schedule name', async () => {
    const man = await hire('EXPLAINED MEMBER', '900101015010', '18690645');
    await elect(man.personId, '900101015010', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });
    const batchId = await runRegular();
    const slip = (await slipsOf(batchId))[0];
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));

    // THE NON-VACUITY PARTNER: the same payslip with the stamp removed still shows RM500 against RM6,000,
    // so the screen prints 8.33% and credits the KWSP Third Schedule — three false statements at once.
    const { epfManual: _drop, ...unstamped } = statOf(slip);
    const before = explainStatutory(unstamped, batch.runType).items.find((i) => i.key === 'epf')!;
    expect(before.ruleKind).toBe('schedule');
    expect(before.effectiveEmployeeRate).toBeCloseTo(TYPED_EMPLOYEE / SALARY, 5);
    expect(isSetByHand(before.provenance)).toBe(false);

    const e = explainStatutory(slip.statutory, batch.runType);
    const item = e.items.find((i) => i.key === 'epf')!;
    expect(item.ruleKind, 'no rule produced this amount').toBe('manual');
    expect(item.effectiveEmployeeRate).toBeNull();
    expect(item.effectiveEmployerRate).toBeNull();
    expect(item.provenance.source, 'the new member of the r364 union — not a second banner').toBe('epfManualAmount');
    expect(item.provenance.employee).toEqual({ system: 660, applied: TYPED_EMPLOYEE });
    expect(item.provenance.employer).toEqual({ system: 720, applied: TYPED_EMPLOYER });
    expect(isSetByHand(item.provenance)).toBe(true);
    expect(e.setByHand).toEqual({ keys: ['epf'], notes: [{ source: 'epfManualAmount', reason: REASON }] });
    // The other five items are untouched and keep their genuinely derived rates.
    for (const k of ['socso', 'eis'] as const) {
      const other = e.items.find((i) => i.key === k)!;
      expect(other.ruleKind, k).toBe('schedule');
      expect(isSetByHand(other.provenance), k).toBe(false);
    }
  });

  it('the Multi-Cycle Worksheet stops verdicting the month "unexplained"', async () => {
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const ent = await entitledCtx(b);
    const man = await hire('WORKSHEET MANUAL', '900101015011', '18690645');
    await elect(man.personId, '900101015011', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });

    const reg = await createBatch(ent, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(ent, { batchId: reg.batchId });
    const extra = await createAdditionalRun(ent, { companyId: b.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await setPayrollInput(ent, { batchId: extra.batchId, employmentId: man.employmentId, overtimeAmount: 0, bonusAmount: 2000 });
    await generatePayslips(ent, { batchId: extra.batchId });

    const w = await multiCycleWorksheetMY(ent, { companyIds: [b.companyId], year: '2026' });
    expect(w.employeeMonthsCompared, 'the month must reach the comparison at all').toBe(1);
    const row = w.rows[0];
    expect(row.verdict, 'reconciled, and explained by the typed amount rather than by aggregation').toBe('manual_epf_amount');
    expect(w.verdicts.unexplained).toBe(0);
    expect(w.verdicts.manual_epf_amount).toBe(1);
    // The MONEY half: the replay reproduces the typed figures rather than a fabricated schedule difference.
    expect(row.monthAsOne.epfEmployee).toBe(TYPED_EMPLOYEE);
    expect(row.paid.epfEmployee).toBe(TYPED_EMPLOYEE);
    expect(row.difference.epfEmployee).toBe(0);
    // …and it never masks a real movement: `would_change` and the ringgit totals are untouched by it.
    expect(w.verdicts.would_change).toBe(0);
    expect(w.movement.epfEmployee).toBe(0);
  });
});

describe('70b14723 — the stamp is a STAMP, not a tenth money line', () => {
  it('`epfManual` is neither a DELTA_KEY nor a STATUTORY_LINE_KEY', async () => {
    // The same fence `statutory.adjustment` sits behind. A stamp inside DELTA_KEYS would have `deltaStat`
    // subtract objects and write 0 onto every payslip in the product; a stamp inside STATUTORY_LINE_KEYS
    // would make the reprocess disclosure report "the EPF stamp moved" as a money movement on the Review
    // step. Read out of SOURCE rather than asserted from memory, so a future addition to either list is
    // caught here.
    const { STATUTORY_LINE_KEYS } = await import('../core/payslip-recompute');
    expect(STATUTORY_LINE_KEYS as readonly string[]).not.toContain('epfManual');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core/payroll.ts'), 'utf8');
    const delta = /const DELTA_KEYS = \[([^\]]*)\] as const;/.exec(src);
    expect(delta, 'DELTA_KEYS must still be a readable literal list').not.toBeNull();
    expect(delta![1]).not.toContain('epfManual');
    // …and it IS written into the payslip blob, so this is a fence rather than a statement about a key that
    // does not exist.
    expect(src).toContain('{ epfManual: epfManualStamp }');
  });
});

describe('70b14723 — what is refused at entry, and what is deliberately not', () => {
  const inst = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it('a NEGATIVE amount is refused at SAVE time — the KWSP file only throws when it is being written', async () => {
    const e = await hire('NEGATIVE MEMBER', '900101015012', '18690645');
    const err = await inst(() => elect(e.personId, '900101015012', '18690645', { employee: -1 }));
    // Identity, not just "it threw": `rejects.toThrow()` passes on the WRONG throw.
    expect(err).toBeInstanceOf(InvalidEpfElectionError);
    expect((err as Error).message).toContain('cannot be negative');
    // Nothing was written: the row still says auto with no figures.
    const [row] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect(row.epfMode).toBe('auto');
    expect(row.epfEmployeeAmount).toBeNull();
  });

  it('a manual category with NO figure, a non-numeric figure, or NO reason is refused', async () => {
    const e = await hire('BLANK MEMBER', '900101015013', '18690645');
    for (const [label, p] of [
      ['no amount on either side', { employee: null, employer: null, reason: REASON }],
      ['no reason', { employee: TYPED_EMPLOYEE, reason: '   ' }],
    ] as const) {
      const err = await inst(() =>
        setStatutoryProfileMY(a, {
          personId: e.personId,
          icNumber: '900101015013',
          taxCategory: 1,
          numChildren: 0,
          epfMode: 'manual_amount',
          epfEmployeeAmount: p.employee ?? null,
          epfEmployerAmount: ('employer' in p ? p.employer : null) ?? null,
          epfManualReason: p.reason,
        }),
      );
      expect(err, label).toBeInstanceOf(InvalidEpfElectionError);
    }
    const nan = await inst(() => elect(e.personId, '900101015013', '18690645', { employee: Number('abc') }));
    expect(nan).toBeInstanceOf(InvalidEpfElectionError);
    expect((nan as Error).message).toContain('not a number');
  });

  it('BELOW the statutory schedule is NOT refused — it is stored, used and reported', async () => {
    // The one refusal the plan deliberately does not add, with the reasons in ADR-0087. RM1 against a
    // schedule figure of 660 is stored and paid, because refusing it would close the grandfathered case.
    const e = await hire('BELOW SCHEDULE', '900101015014', '18690645');
    await elect(e.personId, '900101015014', '18690645', { employee: 1 });
    const st = statOf((await slipsOf(await runRegular()))[0]);
    expect(Number(st.epfEmployee)).toBe(1);
    expect(st.epfManual!.employee).toEqual({ system: 660, applied: 1 });
    // …and ZERO is a figure too, distinct from "no election": it is stored and charges nothing.
    await elect(e.personId, '900101015014', '18690645', { employee: 0 });
    const [row] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect(Number(row.epfEmployeeAmount)).toBe(0);
    expect(row.epfMode).toBe('manual_amount');
  });

  it('switching category CLEARS the figures the new category does not use', async () => {
    // The full-row overwrite is the mechanism, and leaving a stale amount behind would let a future run
    // apply a figure nobody can see on the screen any more.
    const e = await hire('SWITCHER', '900101015015', '18690645');
    await elect(e.personId, '900101015015', '18690645', { employee: TYPED_EMPLOYEE, employer: TYPED_EMPLOYER });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015015', taxCategory: 1, numChildren: 0, epfMode: 'auto' });
    const [row] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect(row.epfMode).toBe('auto');
    expect(row.epfEmployeeAmount).toBeNull();
    expect(row.epfEmployerAmount).toBeNull();
    expect(row.epfManualReason).toBeNull();
    // …and the next run is back on the schedule.
    expect(Number(statOf((await slipsOf(await runRegular()))[0]).epfEmployee)).toBe(660);
  });

  it('the statutory.my event carries the election BEFORE and AFTER, which it could not before', async () => {
    const e = await hire('AUDITED MEMBER', '900101015016', '18690645');
    await elect(e.personId, '900101015016', '18690645', { employee: TYPED_EMPLOYEE });
    const rows = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateType, 'employee-statutory-my'));
    const updated = rows.filter((r) => r.eventType === 'statutory.my.updated');
    const p = updated[updated.length - 1].payload as {
      epfElection: { before: Record<string, unknown> | null; after: Record<string, unknown> };
    };
    expect(p.epfElection.before, 'where the employee STARTED — the half the event never used to carry').toMatchObject({
      epfMode: 'auto',
      epfEmployeeAmount: null,
    });
    expect(p.epfElection.after).toMatchObject({
      epfMode: 'manual_amount',
      epfEmployeeAmount: '500.00',
      epfManualReason: REASON,
    });
  });
});
