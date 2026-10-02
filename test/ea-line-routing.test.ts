/**
 * ea54fe6e — PAY ITEM → EA LINE → C.P.8A BOX.
 *
 * `pay_component.ea_form_line` has been storable, validated and audited since ADR-0035 wave 1, and until
 * r228 nothing read it: the EA summed `payslip.allowance` into one lump and no EA surface looked at
 * pay_component at all. This file pins the read that finally joins them, and the four properties that
 * make it safe to ship onto a tax document:
 *
 *   1. THE VOCABULARY AND THE TABLE STAY IN STEP, IN BOTH DIRECTIONS. Adding a value to EA_FORM_LINES
 *      without a target — or targeting a box that is not an EaField — fails here rather than silently
 *      routing nothing. This is the ratchet that matters: `cleanEaLine` NULLS an unknown value, so the
 *      failure mode without it is an operator's mapping quietly disappearing on the next save.
 *   2. ROUTING MOVES MONEY, IT NEVER ADDS ANY. `partB.gross` is identical with and without a mapping.
 *   3. IT IS OFF FOR EVERY YEAR WE CANNOT STAND BEHIND. Per-component stamping began 2026-08-01, so a
 *      2026 form would print an Aug–Dec subtotal in a box captioned as the whole year (AGENTS 28).
 *   4. A HAND AMENDMENT STILL WINS. The reporter asked for exactly that precedence, in writing:
 *      Pay Item mapping → auto-calculated amount → manual amendment → final EA amount.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement } from '../core/reporting';
import { setEaOverride } from '../core/ea-override';
import { seedPayComponentCatalog, setEmploymentPayComponent, listPayComponents } from '../core/pay-components';
import { EA_FORM_LINES } from '../core/pay-components';
import {
  EA_BUCKET_SOURCE_FIELD,
  EA_FIELDS,
  EA_LINE_TO_FIELD,
  EA_PART_B_COMPONENTS,
  EA_ROUTING_FROM_YEAR,
} from '../localization/my/reports';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ── The table, with no database ──────────────────────────────────────────────────────────────────────
describe('ea54fe6e — the routing vocabulary and the box table are one thing', () => {
  it('every EA_FORM_LINES value routes to a real EaField, or is the one documented exception', () => {
    for (const line of EA_FORM_LINES) {
      if (line === 'allowance_exempt') continue; // memo line — see EA_LINE_TO_FIELD's header
      const target = (EA_LINE_TO_FIELD as Record<string, string>)[line];
      expect(target, `${line} has no EA box`).toBeTruthy();
      expect(EA_FIELDS as readonly string[], `${line} → ${target} is not an EA field`).toContain(target);
    }
  });

  it('and nothing routes FROM a value the vocabulary does not offer', () => {
    // The reverse direction. Without it a renamed EA_FORM_LINES value leaves a dead table entry behind
    // that reads as covered — and `cleanEaLine` would be nulling the operator's stored mapping meanwhile.
    for (const key of Object.keys(EA_LINE_TO_FIELD)) {
      expect(EA_FORM_LINES as readonly string[], `${key} is in the table but not the vocabulary`).toContain(key);
    }
  });

  it('every routed box belongs to the printed Part B or Part C total', () => {
    // Routing that lands money in a box outside EA_PART_B_COMPONENTS would move it OUT of the printed
    // total — the form would stop reconciling, which is the §0 invariant the whole EA rests on.
    for (const target of Object.values(EA_LINE_TO_FIELD)) {
      expect([...EA_PART_B_COMPONENTS, 'pension', 'annuity'], `${target} is routed but never summed`).toContain(target);
    }
  });

  it('every bucket source is itself a summed Part B box', () => {
    // The subtraction side of the move. If a source were not in the total, routing would ADD money.
    for (const source of Object.values(EA_BUCKET_SOURCE_FIELD)) {
      expect(EA_PART_B_COMPONENTS as readonly string[]).toContain(source);
    }
  });

  it('every EA_FORM_LINES value has a dropdown label in all six catalogues', () => {
    // The MISSING_MESSAGE class, caught here rather than on a rendered page: a value added to the
    // vocabulary and not to `messages/*.json` throws at render, passes tsc, the suite and `next build`.
    for (const loc of LOCALES) {
      const cat = JSON.parse(readFileSync(`messages/${loc}.json`, 'utf8')) as {
        payComponents: Record<string, string>;
      };
      for (const line of EA_FORM_LINES) {
        expect(cat.payComponents[`eaLine_${line}`], `${loc}: eaLine_${line}`).toBeTruthy();
      }
    }
  });
});


// ── The read, against real payslips ──────────────────────────────────────────────────────────────────
const ROUTED_YEAR = String(EA_ROUTING_FROM_YEAR);
const PRE_YEAR = String(EA_ROUTING_FROM_YEAR - 1);

describe('ea54fe6e — routing on a real payroll year', () => {
  let base: Base;
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

  /**
   * One employee on a RM400 HOUSING allowance, paid for two months of `year`.
   *
   * `typed_pay_components` is the gate the whole feature sits behind: without it the kernel pays no
   * itemised component, `payslip.allowance` is 0.00 and `componentLines` is never stamped — so a test
   * that forgets it asserts against an employee who was paid nothing and passes for the wrong reason.
   * Dates start in 2024 because a component effective in the SAME month as the run is not yet in force.
   */
  async function seed(year: string) {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const housing = (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === 'HOUSING');
    expect(housing, 'the seeded catalogue must carry HOUSING').toBeTruthy();
    const E = await hireEmployee(a, {
      person: { fullName: 'Rou Ting', primaryEmail: 'rou.ting@ea.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
    await setEmploymentPayComponent(a, {
      employmentId: E.employmentId,
      componentId: housing!.id,
      amount: 400,
      effectiveFrom: '2024-01-01',
    });
    for (const m of ['01', '02']) {
      const batch = await createBatch(a, { companyId: base.companyId, payPeriod: `${year}-${m}` });
      await generatePayslips(a, { batchId: batch.batchId });
    }
    return { E, housingId: housing!.id };
  }

  /**
   * Set the mapping on the pay item.
   *
   * Written straight to the column on purpose. The VALIDATED save path (cleanEaLine → attrsOf → the
   * audit diff) already has its own test at test/pay-item-fields.test.ts:144; going through
   * `upsertPayComponent` here would instead couple this file to the unrelated PCB remuneration-type
   * validation the catalogue's seeded rows do not satisfy, and a fixture failing on a rule this feature
   * does not touch teaches nothing. What is under test here is the READ.
   */
  const mapPayItem = (id: string, line: string | null) =>
    owner.db.update(schema.payComponent).set({ eaFormLine: line }).where(eq(schema.payComponent.id, id));

  it('blank taxable income defaults to B1(a) and remains fully reported', async () => {
    const a = adminCtx(base);
    const { E } = await seed(ROUTED_YEAR);
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });

    expect(ea!.routing.unmapped.map((u) => u.code)).not.toContain('HOUSING');
    expect(ea!.partB.allowances).toBeCloseTo(0, 2);
    expect(ea!.partB.grossSalary).toBeCloseTo(10800, 2);
    expect(ea!.partB.directorFee).toBeCloseTo(0, 2);
  });

  it('a MAPPED pay item moves to its own box, and the printed total does not change', async () => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(ROUTED_YEAR);

    // The mapping is read at GENERATION time, not stamped on the payslip — so the same payroll data can
    // be read twice, which is what makes the total comparison below exact rather than approximate.
    const before = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });
    await mapPayItem(housingId, 'director_fee');
    const after = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });

    expect(before!.partB.allowances).toBeCloseTo(0, 2);
    expect(before!.partB.grossSalary).toBeCloseTo(10800, 2);
    expect(after!.partB.allowances).toBeCloseTo(0, 2);
    expect(after!.partB.directorFee).toBeCloseTo(800, 2);
    expect(after!.routing.unmapped.map((u) => u.code)).not.toContain('HOUSING');

    // THE INVARIANT THE WHOLE FEATURE RESTS ON: routing MOVES money, it never adds any. A form that
    // reconciled before a mapping reconciles after it, to the cent.
    expect(after!.partB.gross).toBeCloseTo(before!.partB.gross, 2);
  });

  it('routing is OFF for an earlier year with a missing saved item stamp — the partial-year trap', async () => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(PRE_YEAR);
    const owned = await owner.db.select({ id: schema.payslip.id }).from(schema.payslip).where(eq(schema.payslip.employmentId, E.employmentId)).orderBy(schema.payslip.id);
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'componentLines'` }).where(eq(schema.payslip.id, owned[0].id));
    await mapPayItem(housingId, 'director_fee');
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: PRE_YEAR });

    expect(ea!.routing.active).toBe(false);
    // The mapping is set and deliberately ignored: printing an Aug–Dec subtotal in a box captioned as
    // the whole year is a confident wrong number on a document someone files a tax return on.
    expect(ea!.partB.directorFee).toBeCloseTo(0, 2);
    expect(ea!.partB.allowances).toBeCloseTo(800, 2);
  });

  it('complete earlier-year processed item detail uses the latest reporting assignment without duplicates', async () => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(PRE_YEAR);
    await mapPayItem(housingId, 'EA_B1B');
    const first = await employeeEaStatement(a, { employmentId: E.employmentId, year: PRE_YEAR });
    expect(first!.routing.active).toBe(true);
    expect(first!.partB.directorFee).toBeCloseTo(800, 2);
    expect(first!.partB.allowances).toBeCloseTo(0, 2);
    expect(first!.partB.grossSalary).toBeCloseTo(10000, 2);
    await mapPayItem(housingId, 'EA_B1C');
    const changed = await employeeEaStatement(a, { employmentId: E.employmentId, year: PRE_YEAR });
    expect(changed!.partB.directorFee).toBeCloseTo(0, 2);
    expect(changed!.partB.allowances).toBeCloseTo(800, 2);
    expect(changed!.partB.gross).toBeCloseTo(first!.partB.gross, 2);
  });

  it('the unmapped warning is computed even in a year that does not route yet', async () => {
    // So the mapping can be finished BEFORE the first year that needs it, rather than being discovered
    // on the form that needed it.
    const a = adminCtx(base);
    const { E } = await seed(PRE_YEAR);
    const owned = await owner.db.select({ id: schema.payslip.id }).from(schema.payslip).where(eq(schema.payslip.employmentId, E.employmentId)).orderBy(schema.payslip.id);
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'componentLines'` }).where(eq(schema.payslip.id, owned[0].id));
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: PRE_YEAR });
    expect(ea!.routing.active).toBe(false);
    expect(ea!.routing.unmapped.map((u) => u.code)).toContain('HOUSING');
    expect(ea!.routing.fromYear).toBe(EA_ROUTING_FROM_YEAR);
  });

  it.each([['EA_C1', 'pension'], ['EA_C2', 'annuity']] as const)('explicit %s moves processed amounts to Part C without leaving them in Part B', async (code, field) => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(ROUTED_YEAR);
    await mapPayItem(housingId, code);
    const first = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });
    const again = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });
    expect(first!.partB.grossSalary).toBeCloseTo(10000, 2);
    expect(first!.partB.allowances).toBeCloseTo(0, 2);
    expect(first!.partB.gross).toBeCloseTo(10000, 2);
    expect(first!.partC[field]).toBeCloseTo(800, 2);
    expect(first!.partC.total).toBeCloseTo(800, 2);
    expect(first!.partB.gross + first!.partC.total).toBeCloseTo(10800, 2);
    expect(again!.partC).toEqual(first!.partC);
    await setEaOverride(a, { employmentId: E.employmentId, year: ROUTED_YEAR, field, amount: 750, reason: 'verified annual classification correction' });
    const amended = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });
    expect(amended!.partC[field]).toBe(750);
    expect(amended!.overrides.find(row => row.field === field)?.original).toBe(800);
  });

  it('a hand amendment still beats the routed figure, and the routed figure is what it amended', async () => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(ROUTED_YEAR);
    await mapPayItem(housingId, 'director_fee');
    await setEaOverride(a, {
      employmentId: E.employmentId,
      year: ROUTED_YEAR,
      field: 'directorFee',
      amount: 750,
      reason: 'agreed with the director',
    });
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });

    expect(ea!.partB.directorFee).toBeCloseTo(750, 2);
    // The routed figure survives as the ORIGINAL, which is what makes the amendment auditable rather
    // than an unexplained number — the reporter asked for that trail by name.
    const ov = ea!.overrides.find((o) => o.field === 'directorFee');
    expect(ov?.original).toBeCloseTo(800, 2);
    expect(ov?.amended).toBeCloseTo(750, 2);
  });

  it('`allowance_exempt` marks an item as mapped without moving a figure', async () => {
    const a = adminCtx(base);
    const { E, housingId } = await seed(ROUTED_YEAR);
    await mapPayItem(housingId, 'allowance_exempt');
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });

    // Mapped — so it stops being reported as an omission…
    expect(ea!.routing.unmapped.map((u) => u.code)).not.toContain('HOUSING');
    // …but the exempt figure has ONE derivation (the PCB exemption ledger) and does not gain a second.
    expect(ea!.partB.allowances).toBeCloseTo(800, 2);
  });

  it('a payslip that predates component stamping routes nothing rather than guessing', async () => {
    // No componentLines on the slip ⇒ nothing to route and nothing to report unmapped. The figures are
    // exactly what they were before this feature existed, which is what makes it safe for closed years.
    const a = adminCtx(base);
    const { E, housingId } = await seed(ROUTED_YEAR);
    await mapPayItem(housingId, 'director_fee');
    await owner.db
      .update(schema.payslip)
      .set({ statutory: {} })
      .where(eq(schema.payslip.employmentId, E.employmentId));
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: ROUTED_YEAR });

    expect(ea!.partB.directorFee).toBeCloseTo(0, 2);
    expect(ea!.routing.unmapped).toEqual([]);
  });
});
