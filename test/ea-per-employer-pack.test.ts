/**
 * ADR-0077 slice 6 — AN EA FORM IS BUILT BY ITS OWN EMPLOYER'S PACK, not by the employment's.
 *
 * WHAT IT USED TO DO. `employeeEaStatement` / `employeeEaStatements` resolved ONE country pack from the
 * employment's CURRENT company and then generated EVERY employer's form with it:
 *
 *     const country = <the employment's current company's country>;
 *     const pack = packFor(country);
 *     for (const c of await pack.eaCompaniesInYear(...)) pack.eaStatement(ctx, { companyId: c.companyId });
 *
 * b7b22514 had already established that an EA form is one EMPLOYER's statement of what IT paid, and split
 * the AMOUNTS per employer. What it did not split was the JURISDICTION. So after an Entity Transfer across
 * a border, the prior employer's form was still produced under the destination country's law — a foreign
 * employer's annual tax statement, on that employer's letterhead, computed under Malaysian rules.
 *
 * With MY the only registered pack that is unobservable, which is why nothing caught it. This file
 * REGISTERS A SECOND COUNTRY PACK so the two are separable, the same technique (and the same safety
 * argument) as test/ot-report-per-company-pack.test.ts: test/pack-registry.test.ts:28 asserts
 * `listPacks('country')` EXACTLY equals ['country-my'], so a leak across files fails loudly there rather
 * than silently here.
 *
 * THE MARKER IS `statutoryVersion`, deliberately: it is the field that says WHICH RULESET produced the
 * form, so a form carrying the wrong one is exactly the defect stated in the form's own data.
 *
 * LATENT, NOT LIVE. Production has nine companies, all Malaysian, in one tenant — every employer resolves
 * to the same pack today and no form on the box is wrong. This is about the second country landing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createMovementEvent } from '../core/movement';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaCompanies, employeeEaStatement, employeeEaStatements } from '../core/reporting';
import { registerPack, packById } from '../packs/registry';
import { packFor } from '../localization/registry';

/** The tell. A form built by the YY pack says so; one built by MY does not. */
const YY_VERSION = 'yy-statutory-2026';

beforeAll(() => {
  const my = packFor('MY');
  if (!my) throw new Error('the MY pack must be registered for this test to mean anything');
  registerPack({
    id: 'country-yy',
    kind: 'country',
    country: 'YY',
    pack: {
      ...my,
      country: 'YY',
      // Everything else is MY's, so the ONLY difference between the two forms is which pack made it —
      // which is precisely the thing under test. A wholesale second jurisdiction would prove less.
      eaStatement: async (ctx, p) => {
        const base = await my.eaStatement(ctx, p);
        return base ? { ...base, statutoryVersion: YY_VERSION } : null;
      },
    },
  });
});

describe('the second pack is really registered — otherwise everything below is vacuous', () => {
  it('country-yy resolves', () => {
    expect(packById('country-yy')).toBeTruthy();
    expect(packFor('YY')).toBeTruthy();
  });
});

describe('against the real database', () => {
  let b: Base;
  /** The destination entity, in the OTHER jurisdiction. */
  let coYY: string;
  let deptYY: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(closeAll);

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    const [co] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Overseas Holdings', country: 'YY', currency: 'SGD' })
      .returning({ id: schema.company.id });
    coYY = co.id;
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: coYY, name: 'Overseas Operations' })
      .returning({ id: schema.department.id });
    deptYY = d.id;
  });

  /**
   * Paid by the Malaysian company for January, transferred across the border on 1 February, paid by the
   * foreign entity for February. The smallest fixture in which "the employment's jurisdiction" and "this
   * employer's jurisdiction" are different answers.
   */
  async function transferredAcrossBorder() {
    const a = adminCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: 'Crossed Border', primaryEmail: `cb_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2018-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2018-01-01' });
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101015555',
      taxCategory: 1,
      numChildren: 0,
    });

    const janMY = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: janMY.batchId });

    await createMovementEvent(a, {
      employmentId: E.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-02-01',
      companyId: coYY,
      departmentId: deptYY,
      remarks: 'Cross-border group restructure',
    });

    const febYY = await createBatch(a, { companyId: coYY, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: febYY.batchId });

    return E;
  }

  it('the fixture really does span two jurisdictions', async () => {
    const E = await transferredAcrossBorder();
    const employers = await employeeEaCompanies(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    expect(employers.map((c) => c.companyId), 'oldest employer first').toEqual([b.companyId, coYY]);
  });

  it('each form is produced by ITS OWN employer’s pack — the defect was one pack for the whole year', async () => {
    const E = await transferredAcrossBorder();
    const forms = await employeeEaStatements(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    expect(forms).toHaveLength(2);

    const [formMY, formYY] = forms;
    expect(formMY.employerId).toBe(b.companyId);
    expect(formYY.employerId).toBe(coYY);

    // THE LOAD-BEARING PAIR. Pre-fix, BOTH carried YY_VERSION: the pack came from the employment's
    // current company, which after the transfer is the foreign one. The Malaysian employer's C.P.8A was
    // being generated under another country's ruleset and filed under a Malaysian E number.
    expect(formMY.statutoryVersion, 'the Malaysian employer’s form must not be built by the YY pack').not.toBe(
      YY_VERSION,
    );
    expect(formYY.statutoryVersion, 'the foreign employer’s form must be built by the YY pack').toBe(YY_VERSION);
  });

  it('a form asked for BY EMPLOYER uses that employer’s pack, both directions', async () => {
    const E = await transferredAcrossBorder();
    const a = adminCtx(b);

    // This is the EA screen's employer switcher and the PDF route's ?company= — the two callers that can
    // name a PAST employer. Pre-fix both of these came back with YY_VERSION.
    const scopedMY = await employeeEaStatement(a, {
      employmentId: E.employmentId,
      year: '2026',
      companyId: b.companyId,
    });
    const scopedYY = await employeeEaStatement(a, {
      employmentId: E.employmentId,
      year: '2026',
      companyId: coYY,
    });
    expect(scopedMY!.statutoryVersion).not.toBe(YY_VERSION);
    expect(scopedYY!.statutoryVersion).toBe(YY_VERSION);
  });

  it('an unscoped read still means the CURRENT employer — the default did not move', async () => {
    const E = await transferredAcrossBorder();
    const unscoped = await employeeEaStatement(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    expect(unscoped!.employerId).toBe(coYY);
    expect(unscoped!.statutoryVersion).toBe(YY_VERSION);
  });

  it('an employer whose jurisdiction has NO pack is skipped, not rendered under someone else’s law', async () => {
    const E = await transferredAcrossBorder();
    // The prior employer moves to a jurisdiction this installation does not model — the D-14
    // non-statutory tier, which `updateCompany` reaches by declaration. A non-statutory company owes no
    // statutory form; producing a Malaysian one for it would be the same defect wearing a different hat.
    await owner.db
      .update(schema.company)
      .set({ country: 'TH', statutoryTier: 'non_statutory' })
      .where(eq(schema.company.id, b.companyId));

    const forms = await employeeEaStatements(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    expect(forms.map((f) => f.employerId), 'only the employer we can compute a form for').toEqual([coYY]);
    // And it is still the right pack for the one that survived.
    expect(forms[0].statutoryVersion).toBe(YY_VERSION);
  });

  it('an employee who never crossed a border is untouched — the single-jurisdiction path is the 99%', async () => {
    const a = adminCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: 'Stayed Home', primaryEmail: `sh_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2018-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 4000, effectiveFrom: '2018-01-01' });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900202025555', taxCategory: 1, numChildren: 0 });
    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });

    const forms = await employeeEaStatements(a, { employmentId: E.employmentId, year: '2026' });
    expect(forms).toHaveLength(1);
    expect(forms[0].employerId).toBe(b.companyId);
    expect(forms[0].statutoryVersion).not.toBe(YY_VERSION);
  });
});
