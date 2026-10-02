/**
 * DEV FIXTURE — A PAYABLE, EXPLAINABLE PCB PAYSLIP ON THE DEMO TENANT.  `pnpm dev:fixture-pcb-detail`
 *
 * ⚠️ WHY THIS FILE EXISTS, AND WHY IT IS COMMITTED. The CLAUDE.md §8 render check for the PCB / MTD
 * Calculation Detail needs a PROCESSED payslip whose working is worth reading, and a seeded database
 * cannot produce one. Three rounds have now written this fixture from scratch and thrown it away —
 * r361, r369 and r372 — each paying the same evening for the same three traps. It is committed for the
 * reason `scripts/dev-fixture-pooled-leave.ts` gives for itself: so the next round does not pay it a
 * fourth time, and so the render check on this screen is a real render rather than a 200.
 *
 * ── THE THREE TRAPS, WHICH ARE THE WHOLE REASON THIS IS NOT FOUR LINES ─────────────────────────────
 *
 * 1. A SEEDED DATABASE CANNOT BE PAID, AND THE BATCH MUST BE SCOPED RATHER THAN THE SEED REPAIRED.
 *    `db/seed.ts` leaves one employment with NO compensation row. `preProcessChecksTx` counts that as a
 *    blocker, so `generatePayslips` refuses the WHOLE batch with `PreProcessBlockedError` — "1 employee
 *    in scope is not ready" — even though the employee this fixture just created is perfectly ready.
 *    The fix is to SCOPE the batch to `employmentIds`, because the readiness check is scoped to the
 *    batch's own scope. It is NOT to give the seed's employment a salary: inventing pay for somebody
 *    else's fixture changes what every other render check on this database sees, silently.
 *
 *    Separately, `generatePayslips` REFUSES `entitlementsExempt: 'seeding'` — it throws
 *    `EntitlementsExemptForBillableError` on the billable `typed_pay_components`. So the context below
 *    carries a REAL snapshot from `resolveEntitlementsTx`, as scripts/anomaly-sweep.ts does, and no
 *    exemption marker anywhere.
 *
 * 2. `(tenant_id, ic_number)` IS UNIQUE, so a hardcoded IC collides the second time this runs and the
 *    failure is a wall of SQL that names no constraint. The IC below keeps the reference slip's own
 *    date-of-birth prefix and takes its last six digits from the run stamp.
 *
 * 3. ⚠️ THE DEMO TENANT DOES NOT PRODUCE A BONUS PAYSLIP, AND THIS IS TENANT CONFIGURATION, NOT CODE.
 *    `setPayrollInput({ bonusAmount: 30000 })` returns WITHOUT ERROR and the payslip still comes back
 *    stamped `pcbBonus = 0`, `trace.Yt = 0`, `trace.totalMtdYear = undefined`. Meanwhile
 *    `test/r361-pcb-mtd-results.test.ts` drives the identical path on the HARNESS tenant with the same
 *    `bonus: 30000` and asserts `slipResultAdditional > 0` — and passes. So the additional-remuneration
 *    leg of the calculation (sequence 9.8, and 9.7's substitution) renders its captions, its zeroes and
 *    its "No additional remuneration this month" wording correctly, but is NOT exercised by this
 *    fixture. Do not read a clean render of those two steps as evidence that the leg works. Finding out
 *    which demo-tenant setting withholds it is unfinished business and is worth its own item; r372 lost
 *    most of an evening to it and stopped rather than claim the leg had rendered.
 *
 * 4. IT RUNS ONCE PER SEED, AND IT SAYS SO RATHER THAN THROWING SQL AT YOU. `createBatch` allows exactly
 *    ONE regular run per (company, pay period), so a second invocation against the same database dies
 *    with "A payroll process already exists for this period" and a stack trace into core/payroll.ts —
 *    which reads like a product defect and is not one. The precondition is therefore checked up front
 *    and refused in words, naming the fix. Run `pnpm db:seed` first, then this, in that order.
 *
 * ── WHAT IT MAKES, AND WHY EACH CHOICE IS DELIBERATE ───────────────────────────────────────────────
 *
 * ONE employee on the demo tenant, hired 2026-01-01, paid for TWO months (2026-05 and 2026-06) so the
 * accumulated block (the reporter's sequence 3) carries real prior figures rather than a column of
 * zeroes that proves nothing about the accumulators.
 *
 * ⚠️ THE TAX POSITION IS THE AGENCY REFERENCE'S OWN, and that is the point of the fixture rather than a
 * flourish. Category 2 (married, spouse not working) and an s.48 grid of ONE child under 18 plus ONE
 * disabled child in full-time tertiary study. That is TWO children on record and a weighted C of
 * 1 + 8 = 9 — exactly what the reference slip prints (C = 9.00 beside a grid of 1 and 1, printed p.27
 * of the LHDN specification decides the weighting). Sequence 2 therefore renders its two numbers as two
 * VISIBLY DIFFERENT figures, which is the only way to check that the head count and the agency's C have
 * not been collapsed into one — the confusion r359 shipped on the EA and r364 corrected.
 *
 * A ZAKAT, also not decoration: without it [C], [D] and the deducted figure are all the same number and
 * a reader comparing the screen with the PDF cannot tell a leg from a total.
 *
 * NOT A MIGRATION AND NOT PRODUCTION DATA. It writes one employee and two payroll runs onto the demo
 * tenant, through the same service functions the product uses; it configures nothing.
 */
import { eq } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { DEMO_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
// ADR-0080 D9 and D7/D4: `scripts/` is scanned by both import ratchets, so a fixture consumes payroll
// through the pack FACADE and jurisdiction through the REGISTRY, exactly as app code does. Importing
// ../core/payroll or ../localization/my directly here is a gate failure, and the allowlists only shrink.
import { requirePackFor } from '../localization/registry';
import {
  createBatch,
  generatePayslips,
  setPayrollInput,
  listProcessedPayslipsAcross,
  upsertPayComponent,
  setEmploymentPayComponent,
} from '../packs/payroll/service';

const refusal = demoSeedRefusal(process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
// Optional r380 synthetic variants: still behind the disposable-demo database guard above.
const requestedScheme = process.env.DEV_PCB_SCHEME ?? 'resident';
if (!['resident','non_resident','rep','knowledge_worker','c_suite'].includes(requestedScheme)) throw new Error('Unknown fixture PCB scheme');
const typedBonus = process.env.DEV_PCB_TYPED_BONUS === '1';
if (requestedScheme !== 'resident' || typedBonus) {
  for (const databaseUrl of [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL]) {
    const target = new URL(databaseUrl ?? '');
    if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.port !== '5433') {
      throw new Error('Synthetic incentive/bonus variants require the disposable localhost:5433 database');
    }
  }
}


/** The reference slip's own position — see the header on why these two categories and not others. */
const CHILD_GRID = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };

/**
 * The two months, and the ONE list both the precondition check and the run loop read. A second copy is
 * how the check comes to pass for a month the loop then fails on.
 * May pays nothing extra so the accumulated block has real prior figures; June carries the bonus and the
 * zakat. See trap 3 on what the bonus does NOT do on this tenant.
 */
const PERIODS: readonly (readonly [string, number, number])[] = [
  ['2026-05', 0, 0],
  ['2026-06', 30000, 40],
];

async function main() {
  const tenantId = DEMO_TENANT_ID;
  const demo = await owner.db.select({ id: schema.tenant.id }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (demo.length === 0) {
    console.error(`No demo tenant ${tenantId} in this database. Run \`pnpm db:seed\` first.`);
    process.exit(1);
  }

  // A REAL entitlement snapshot, never an exemption marker — trap 1 in the header.
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, tenantId));
  const ctx: SessionContext = { tenantId, roles: ['hr_admin'], entitlements };

  // ⚠️ `company.name` DOES NOT EXIST; the column is `legal_name`. Costs one confusing failure per round.
  const [company] = await owner.db
    .select({ id: schema.company.id, legalName: schema.company.legalName })
    .from(schema.company)
    .where(eq(schema.company.tenantId, tenantId))
    .limit(1);
  if (!company) {
    console.error('No company on the demo tenant. Run `pnpm db:seed` first.');
    process.exit(1);
  }
  const [dept] = await owner.db
    .select({ id: schema.department.id })
    .from(schema.department)
    .where(eq(schema.department.companyId, company.id))
    .limit(1);

  // The identities the render check can sign in as: the dev switcher resolves a `dev_user` cookie, and
  // the screen's own `scopedAdmin()` needs one of these grants.
  const grants = await owner.db
    .select({ id: schema.appUser.id, role: schema.roleAssignment.role })
    .from(schema.appUser)
    .innerJoin(schema.roleAssignment, eq(schema.roleAssignment.appUserId, schema.appUser.id))
    .where(eq(schema.appUser.tenantId, tenantId)).orderBy(schema.appUser.id, schema.roleAssignment.role);
  const adminIds = [...new Set(grants.filter((g) => g.role === 'hr_admin' || g.role === 'super_admin').map((g) => g.id))];
  if (!adminIds[0]) throw new Error('Fixture needs a seeded HR administrator');
  ctx.userId = adminIds[0];

  /**
   * ⚠️ TRAP 4, CHECKED BEFORE ANYTHING IS WRITTEN. One regular run per (company, pay period) is the
   * product's rule, so a second invocation cannot succeed — and it must not get halfway, leaving a
   * hired employee with no payslip behind. Checked first, refused in words.
   */
  const clash = await owner.db
    .select({ payPeriod: schema.payrollBatch.payPeriod })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.companyId, company.id));
  const taken = PERIODS.map(([p]) => p).filter((p) => clash.some((b) => b.payPeriod === p));
  if (taken.length > 0) {
    console.error(`This fixture has already run against this database (payroll runs exist for ${taken.join(', ')}).`);
    console.error('It creates ONE regular run per month and the product allows only one, so it cannot run twice.');
    console.error('Re-seed first:  pnpm db:seed  &&  pnpm dev:fixture-pcb-detail');
    process.exit(1);
  }

  const stamp = Date.now();
  const e = await hireEmployee(ctx, {
    person: { fullName: 'PCB Detail Probe', primaryEmail: `pcb.detail.${stamp}@acme.test` },
    companyId: company.id,
    departmentId: dept?.id,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: 14000,
    monthlyAllowance: 800,
    effectiveFrom: '2026-01-01',
  });
  // The MY statutory setters come off the resolved pack, not a direct localization/my import:
  // `pack.statutory.set`/`.setTax` ARE setStatutoryProfileMY/setTaxProfileMY (localization/country-pack.ts),
  // so this is the same function through the seam every other caller uses.
  const pack = requirePackFor('MY');
  // Trap 2: a unique IC per run, keeping the reference's date-of-birth prefix.
  await pack.statutory.set(ctx, {
    personId: e.personId,
    icNumber: `850302${String(stamp).slice(-6)}`,
    taxCategory: 2,
    ...(requestedScheme === 'c_suite' ? {epfCitizenship:'non_citizen' as const} : {}),
  });
  await pack.statutory.setTax(ctx, {
    personId: e.personId,
    taxCategory: 2,
    taxResidency: requestedScheme === 'non_resident' ? 'non_resident' : 'resident',
    numChildren: 2,
    childReliefMode: 'auto_table',
    childReliefTable: CHILD_GRID,
    disabledIndividual: false,
    disabledSpouse: false,
  });


  if (!pack.statutory.saveTaxSelection) throw new Error('Fixture pack lacks scoped tax selection');
  await pack.statutory.saveTaxSelection(ctx, {
    employmentId:e.employmentId,expectedCompanyId:company.id,scheme:requestedScheme,
  });
  if (typedBonus) {
    const component = await upsertPayComponent(ctx, {code:'PCB_DETAIL_BONUS',name:'Synthetic PCB detail bonus',
      kind:'allowance',includedInEpf:true,includedInSocsoEis:false,includedInPcb:true,
      includedInHrdfBase:false,isNonPayable:false,prorates:false,epfBonus2012:true,
      pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',eaFormLine:'EA_B1A'});
    await setEmploymentPayComponent(ctx, {employmentId:e.employmentId,componentId:component.id,
      amount:30000,effectiveFrom:'2026-06-01',effectiveTo:'2026-06-30'});
  }

  for (const [payPeriod, bonus, zakat] of PERIODS) {
    // Trap 1: SCOPED to this employment, so the seed's compensation-less employment cannot block the run.
    const { batchId } = await createBatch(ctx, {
      companyId: company.id,
      payPeriod,
      scope: { employmentIds: [e.employmentId] },
    });
    await setPayrollInput(ctx, {
      batchId,
      employmentId: e.employmentId,
      overtimeAmount: 0,
      bonusAmount: typedBonus ? 0 : bonus,
      zakat,
    });
    await generatePayslips(ctx, { batchId });
  }

  const rows = await listProcessedPayslipsAcross(ctx, {
    companyIds: [company.id],
    employmentId: e.employmentId,
  });
  const june = rows.find((r) => r.payPeriod === '2026-06') ?? rows[0];
  const [slip] = await owner.db
    .select({ statutory: schema.payslip.statutory })
    .from(schema.payslip)
    .where(eq(schema.payslip.id, june.id))
    .limit(1);
  const st = slip?.statutory as { pcb?: number; pcbBonus?: number; pcbMeta?: { trace?: Record<string, number> } };
  const trace = st?.pcbMeta?.trace;

  if (typedBonus && !(Number(trace?.Yt) > 0 && Number(st?.pcbBonus) > 0)) throw new Error('Typed bonus fixture failed to exercise additional remuneration');
  console.log('PCB detail dev fixture applied. Scheme: ' + requestedScheme);
  console.log(`  payslip        ${june.id}   (${june.payPeriod}, ${company.legalName})`);
  console.log(`  sign in as     dev_user=${adminIds[0] ?? '(no hr_admin grant found)'}`);
  console.log(`  screen         /payroll/pcb-detail?payslipId=${june.id}`);
  console.log(`  document       /payroll/pcb-detail/download?payslipId=${june.id}&lang=en`);
  console.log(`  deducted PCB   ${st?.pcb}`);
  console.log(`  C (weighted)   ${trace?.childCount}   — two children on record; see the header`);
  // Trap 3, reported every run rather than left for the reader to discover on the rendered page.
  if (!st?.pcbBonus) {
    console.log('  ⚠️ NO ADDITIONAL-REMUNERATION LEG on this payslip: pcbBonus=' + String(st?.pcbBonus) +
      ', trace.Yt=' + String(trace?.Yt) + ', trace.totalMtdYear=' + String(trace?.totalMtdYear) + '.');
    console.log('     The bonus was submitted and accepted. This is demo-tenant configuration, not code —');
    console.log('     test/r361-pcb-mtd-results.test.ts drives the same path on the harness tenant and');
    console.log('     asserts an additional leg > 0. Steps 9.7 and 9.8 render UNEXERCISED; see trap 3.');
  }
  await owner.client.end();
}

/**
 * ⚠️ AN EXPLICIT EXIT, WHICH `dev-fixture-pooled-leave.ts` DOES NOT NEED AND THIS DOES.
 *
 * That fixture writes rows through ONE handle — the `owner` pool it opened — and closing it lets node
 * drain. This one calls the SERVICE functions (`hireEmployee`, `setCompensation`, `generatePayslips`),
 * which go through the module-level pool in db/client.ts keyed on DATABASE_URL. So there are TWO pools
 * open and closing `owner` leaves the other one holding the event loop: the script did all of its work,
 * printed all of its output, and then sat there until something sent it SIGTERM — `pnpm` reported
 * `ELIFECYCLE Command failed` and exit 143 on a run that had in fact succeeded completely. A fixture
 * that always reports failure is a fixture nobody trusts, so the exit is explicit.
 */
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
