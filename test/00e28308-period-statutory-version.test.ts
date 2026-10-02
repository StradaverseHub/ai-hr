/**
 * 00e28308 — A PAYROLL MONTH RECORDS WHICH STATUTORY RULES IT WAS OPENED UNDER.
 *
 * `pay_period.statutory_version` has existed since migration 0066 and, outside the payroll-history
 * importer, nothing wrote it: `createBatch` and `createAdditionalRun` both inserted the month with the
 * column null, no code path UPDATEs it, and the comment at the find-or-create claimed the snapshot
 * happened "when payslips are first generated (2C-4)" — which no code did. Every month opened by the
 * kernel therefore had no record at all of the ruleset behind its figures.
 *
 * The stamp is written by the INSERT that opens the month and by nothing else, and each arm below exists
 * because of a specific way this could go wrong while looking right:
 *   (a) a fresh month records the RESOLVED version — asserted against a tenant override with a version
 *       nobody could have hardcoded, so the arm cannot pass off a built-in constant as a resolution;
 *   (b) a SECOND run in the same month does NOT move the recorded version, asserted while a fresh
 *       resolution would answer DIFFERENTLY — a same-value second run would prove nothing;
 *   (c) a month that already existed stays NULL, through find-or-create AND through payslip generation,
 *       so a backfill cannot be added later without failing here. The reporter approved the refusal to
 *       backfill: we know which rules were CURRENT when an old month ran, not which that run used;
 *   (d) every monetary field retains the pre-change golden, with exact current provenance additions;
 *   (e) the Borang A read and the CP39 file still carry their OWN version, resolved their own way;
 *   (f) an IMPOSSIBLE month still opens. `pay_period.period` is free text with no CHECK and the wizard's
 *       only guard is `<input type="month">`, which Firefox and desktop Safari render as a text box, so a
 *       run under '2026-13' is reachable and the suite already pins that it commits. Resolving a ruleset
 *       'as of' a date that does not exist threw out of createBatch when this round was first written —
 *       found by test/cp39-form-report.test.ts, and pinned here at the stamp rather than at the screen.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { cp39FileForBatch } from '../localization/my/cp39-file';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';

const MONTH = '2026-05';
/** A version string that exists nowhere in the source tree, so an arm asserting it cannot be satisfied
 *  by any constant the kernel could have named. */
const OVERRIDE_VERSION = 'TEST-OVERRIDE-9.9';

/**
 * The payslip's immutable statutory snapshot for the fixture below (RM5,000 basic, no allowance, no OT,
 * category 1, no children, 2026-05), CAPTURED FROM THE CODE AS IT STOOD BEFORE THIS ROUND. It is quoted
 * here in full rather than spot-checked: the blob is what the payslip PDF, the Borang A / CP39 filings
 * and the EA form all read, so an accidental change to any key in it is a change to a filing.
 *
 * `version` is composed from the pack constant instead of written out, because it is the one key here
 * that is not a figure — a statutory version bump must not have to edit a golden payroll assertion.
 */
const GOLDEN_STATUTORY = {
  bases: { epf: 5000, epfAdditional: 0, hrdf: 5000, pcb: 5000, socsoEis: 5000 },
  eisEmployee: 9.9,
  eisEmployer: 9.9,
  epfEmployee: 550,
  epfEmployer: 650,
  epfMode: 'auto',
  hrdf: 0,
  lp: 0,
  pcb: 0,
  pcbBonus: 0,
  pcbMeta: {
    // r380 records the selected scheme without changing this ordinary resident's money.
    calculationScheme: 'resident',
    P1: 27000.05,
    epfClaimed: 0,
    month: 5,
    n: 7,
    pcbPaid: 0,
    reliefs: {
      children: 0,
      disabledIndividual: 0,
      disabledSpouse: 0,
      individual: 9000,
      lp: 0,
      spouse: 0,
      total: 9000,
    },
    trace: {
      B: -250,
      K1: 550,
      K2: 492.85,
      K2t: 0,
      Kt: 0,
      M: 20000,
      R: 0.03,
      Y1: 5000,
      Y2: 5000,
      Yt: 0,
      Z: 0,
      category: 1,
      childCount: 0,
      childCountVersion: 1,
      // r359 — Q joined the trace when the slip's Q and C were corrected to the spec's meanings. This
      // exact-shape guard is what forces that to be noticed rather than absorbed, which is the same
      // service it did for `ytdGross` in r354.
      childDeductionPerChild: 2000,
      childWorking: { mode: 'manual', table: null, rows: [], categoryUnits: {}, headCount: 0, disabledIndividual: false, disabledSpouse: false },
      lpAccumulated: 0,
      lpCurrent: 0,
      mtdAdditionalCalc: 0,
      mtdAdditionalFloored: 0,
      mtdNormalCalc: 0,
      mtdNormalFloored: 0,
      taxOnP1: 0,
      zakatCurrent: 0,
      zakatLeftover: 0,
    },
    // 4011903e (r354) — Y joins the snapshot. This is an EXACT-SHAPE guard over the whole stored
    // payload, which is its value: a new member of `pcbMeta` has to be noticed here and accounted
    // for rather than arriving unremarked. Zero because this fixture has no prior month, which is a
    // true statement about Y and not a placeholder — the same reason `ytdNet` is 0 beside it.
    ytdGross: 0,
    ytdNet: 0,
  },
  // A complete cash-only run records actual zero benefit evidence, including empty ownership arrays.
  pcbNonCash: {
    version: 1,
    current: { bik: { entered: 0, exempt: 0, taxable: 0 }, vola: { entered: 0, exempt: 0, taxable: 0 } },
    ownedCurrent: { bik: { entered: 0, exempt: 0, taxable: 0 }, vola: { entered: 0, exempt: 0, taxable: 0 } },
    owned: { bik: 0, vola: 0 }, cumulative: { bik: 0, vola: 0 }, before: { bik: 0, vola: 0 },
    accumulated: { bik: 0, vola: 0, complete: true }, cashNormal: 5000,
    entries: [], ownedEntries: [], eaEntries: [], ownedEaEntries: [],
  },
  pcbNormalPreZakat: 0,
  skbbkSubject: false,
  socsoEmployee: 24.75,
  socsoEmployer: 86.65,
  socsoSkbbk: 0,
  version: DEFAULT_MY_STATUTORY.version,
  zakat: 0,
  zakatInTotal: true,
};

let base: Base;
let a: SessionContext;
let employmentId: string;

const clone = (x: StatutoryRuleset): StatutoryRuleset => JSON.parse(JSON.stringify(x));

/** A tenant statutory override (ADR-0019), identical to the verified default except for its version —
 *  so it changes WHICH VERSION resolves without changing a single figure. */
function overrideAt(effectiveFrom: string, version: string) {
  const data = clone(DEFAULT_MY_STATUTORY);
  data.version = version;
  return owner.db.insert(schema.statutoryRuleset).values({
    tenantId: base.tenantId,
    country: 'MY',
    version,
    effectiveFrom,
    data,
    createdAt: new Date(`${effectiveFrom}T00:00:00Z`),
  });
}

async function periodRow(period = MONTH) {
  const [row] = await owner.db
    .select({
      id: schema.payPeriod.id,
      status: schema.payPeriod.status,
      statutoryVersion: schema.payPeriod.statutoryVersion,
    })
    .from(schema.payPeriod)
    .where(eq(schema.payPeriod.period, period));
  return row;
}

/** Every stored column of the one payslip, minus the identifiers and the clock. */
async function payslipFigures(batchId: string) {
  const [row] = await owner.db
    .select({
      basicSalary: schema.payslip.basicSalary,
      allowance: schema.payslip.allowance,
      overtimePay: schema.payslip.overtimePay,
      bonus: schema.payslip.bonus,
      daysWorked: schema.payslip.daysWorked,
      coverageFrom: schema.payslip.coverageFrom,
      coverageTo: schema.payslip.coverageTo,
      grossPay: schema.payslip.grossPay,
      statutory: schema.payslip.statutory,
      otherDeductions: schema.payslip.otherDeductions,
      totalDeductions: schema.payslip.totalDeductions,
      netPay: schema.payslip.netPay,
      employerCost: schema.payslip.employerCost,
      version: schema.payslip.version,
    })
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  return row;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  // `createAdditionalRun` is entitlement-gated (ADR-0077 slice 3) and `entitledCtx` snapshots
  // point-in-time, so the grant is written before the context is built.
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
  // The employer references the two filings in arm (e) refuse to print without: KWSP's for the Borang A
  // header, LHDN's for the CP39 file.
  await setCompanyStatutoryMY(a, {
    companyId: base.companyId,
    epfEmployerNo: '019632261',
    lhdnEmployerNo: 'E 908915-10',
  });
  const e = await hireEmployee(a, {
    person: { fullName: 'Ruleset Stamp', primaryEmail: 'rs@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2025-01-01',
  });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: '900101011234',
    epfNumber: '17955667',
    // The CP39 file refuses a line with no TIN (arm (e) exercises the real builder, not a stub).
    taxNumber: 'SG23607354000',
    taxCategory: 1,
    numChildren: 0,
  });
  employmentId = e.employmentId;
});
afterAll(async () => {
  await closeAll();
});

describe('00e28308 · the month records the ruleset version it was opened under', () => {
  it('(a) a fresh payroll run records the RESOLVED ruleset version on its period', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(a, { batchId });

    const period = await periodRow();
    // Not null FIRST: every remaining equality in this arm would also hold between two nulls.
    expect(period.statutoryVersion, 'the month it was opened under must be recorded, not left null').not.toBeNull();
    expect(period.statutoryVersion).toBe(DEFAULT_MY_STATUTORY.version);
    // …and it is the SAME string the run stamped on the payslip it produced, which is the whole point:
    // the month's record and the figures' record name one ruleset.
    const slip = await payslipFigures(batchId);
    expect(period.statutoryVersion).toBe((slip.statutory as { version: string }).version);
  });

  it('(a-resolved) the version comes from the RESOLUTION, not from a constant in the kernel', async () => {
    // An override effective inside the month, identical to the default except for its version. If the
    // stamp were a hardcoded Malaysian literal — the country-pack drift the ratchet exists to stop —
    // this arm is the one that catches it.
    await overrideAt('2026-01-01', OVERRIDE_VERSION);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(a, { batchId });

    const period = await periodRow();
    expect(period.statutoryVersion, 'the recorded version must be the one that resolved for this month').toBe(
      OVERRIDE_VERSION,
    );
    expect(period.statutoryVersion).not.toBe(DEFAULT_MY_STATUTORY.version);
    // The override changed no figure, only which version resolved — so the payslip agrees with it.
    const slip = await payslipFigures(batchId);
    expect((slip.statutory as { version: string }).version).toBe(OVERRIDE_VERSION);
  });

  it('(b) a SECOND run in the same month does not change the recorded version, even when the resolution has moved', async () => {
    const first = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(a, { batchId: first.batchId });
    const opened = (await periodRow()).statutoryVersion;
    expect(opened).toBe(DEFAULT_MY_STATUTORY.version);

    // A ruleset activated AFTER the month was opened, effective inside it. A fresh resolution now
    // answers differently — which is what makes this arm mean something: a second run that simply
    // re-stamped would move the month's record, and a month whose recorded version moved is worse than
    // a month with none.
    await overrideAt('2026-01-01', OVERRIDE_VERSION);
    const second = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: MONTH,
      runType: 'bonus',
    });
    // A bonus run pays only the employees it has a bonus figure for, so without this the run generates
    // no payslip and the resolution assertion below would have nothing to read.
    await setPayrollInput(a, { batchId: second.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await generatePayslips(a, { batchId: second.batchId });

    const after = await periodRow();
    expect(after.statutoryVersion, 'the second run must not re-stamp the month').toBe(opened);
    expect(after.statutoryVersion).not.toBe(OVERRIDE_VERSION);
    // The second run really did resolve the new ruleset — so the arm above is not passing because the
    // override was inert.
    const [bonusSlip] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, second.batchId));
    expect(
      (bonusSlip.statutory as { version: string }).version,
      'the second run resolved the new ruleset, so the unchanged period stamp is a decision, not a coincidence',
    ).toBe(OVERRIDE_VERSION);
    // Exactly one period for the month — the second run found the parent, it did not open a new one.
    const all = await owner.db.select({ id: schema.payPeriod.id }).from(schema.payPeriod);
    expect(all).toHaveLength(1);
  });

  it('(c) a period that already existed stays NULL — through find-or-create AND through generation', async () => {
    // A month exactly as the kernel left one before this change: opened, no version recorded. This is
    // the shape of every pay_period row on production, and the reporter approved leaving them alone.
    await owner.db.insert(schema.payPeriod).values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      period: MONTH,
      status: 'open',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    expect(
      (await periodRow()).statutoryVersion,
      'find-or-create must reuse an existing month untouched — no backfill',
    ).toBeNull();

    await generatePayslips(a, { batchId });
    expect(
      (await periodRow()).statutoryVersion,
      'generating payslips must not backfill the month either — the stamp is written at open, or not at all',
    ).toBeNull();

    // And no second period row was opened beside it to carry the version instead.
    const all = await owner.db
      .select({ period: schema.payPeriod.period, statutoryVersion: schema.payPeriod.statutoryVersion })
      .from(schema.payPeriod);
    expect(all).toEqual([{ period: MONTH, statutoryVersion: null }]);
  });

  it('(d) every payslip monetary figure retains its golden and new provenance identifies the authoritative selection', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(a, { batchId });
    const slip = await payslipFigures(batchId);

    const [selection] = await owner.db.select().from(schema.employmentTaxSelectionMy).where(and(
      eq(schema.employmentTaxSelectionMy.tenantId, base.tenantId),
      eq(schema.employmentTaxSelectionMy.employmentId, employmentId),
      eq(schema.employmentTaxSelectionMy.companyId, base.companyId),
    ));
    expect(selection).toMatchObject({ scheme: 'resident', transitionState: 'resolved', version: 1 });
    expect(selection.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Golden, captured from the code as it stood BEFORE the period stamp was added (RM5,000 basic, no
    // allowance, no OT, category 1, no children, 2026-05). Every stored column, so a change to any
    // figure — or to the immutable statutory snapshot the filings and the PDF read — fails here.
    expect(slip).toEqual({
      basicSalary: '5000.00',
      allowance: '0.00',
      overtimePay: '0.00',
      bonus: '0.00',
      daysWorked: '31.00',
      coverageFrom: '2026-05-01',
      coverageTo: '2026-05-31',
      grossPay: '5000.00',
      statutory: {
        ...GOLDEN_STATUTORY,
        pcbMeta: {
          ...GOLDEN_STATUTORY.pcbMeta,
          taxSelectionId: selection.id,
          taxSelectionVersion: selection.version,
          taxSelectionSource: 'income_tax_resident',
        },
      },
      otherDeductions: '0.00',
      totalDeductions: '584.65',
      netPay: '4415.35',
      employerCost: '5746.55',
      version: 1,
    });
  });

  it('(e) the filings still carry their own version, resolved their own way', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(a, { batchId });

    const borangA = await reportPreview(a, {
      companyId: base.companyId,
      reportId: 'my.borang-a',
      periodKey: MONTH,
    });
    expect((borangA.meta as { statutoryVersion: string }).statutoryVersion).toBe(DEFAULT_MY_STATUTORY.version);

    const cp39 = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: MONTH });
    expect(cp39.statutoryVersion).toBe(DEFAULT_MY_STATUTORY.version);

    // Both filings read the PAYSLIPS' own versions, not the period's — which is why they are unaffected
    // by the column this round started writing, and why they stay right for a month with no period stamp.
    expect((await periodRow()).statutoryVersion).toBe(DEFAULT_MY_STATUTORY.version);
  });

  it('(f) an impossible month still opens, and records no version rather than failing', async () => {
    // Reachable only this way, and the reason is worth stating: createBatch derives batch_date as
    // `<period>-28`, which Postgres refuses as a DATE for '2026-13', so the wizard's own payment-date
    // field has to be supplied for the batch to commit at all. That is the same route
    // test/cp39-form-report.test.ts takes.
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-13',
      paymentDate: '2026-12-28',
    });
    expect(batchId, 'opening a month the period text cannot represent must still succeed').toBeTruthy();
    const period = await periodRow('2026-13');
    expect(period, 'the pay_period row is there — this is not the refused path').toBeTruthy();
    expect(
      period.statutoryVersion,
      'a month that does not exist has no ruleset to resolve, so nothing is recorded',
    ).toBeNull();
  });
});
