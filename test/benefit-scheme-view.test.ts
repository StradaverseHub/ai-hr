/**
 * 4da751c6 — the DERIVED Benefit Scheme readout on the employee Leave tab.
 *
 * ⚠️ THE CASE THIS FILE EXISTS FOR IS THE AMBIGUOUS ONE. The approved plan promised the reporter, in
 * writing, that when different leave types pick an employee up through different rules we "say so plainly
 * and list what applies per leave type, rather than inventing a name". That state is easy to believe is
 * unreachable and quietly drop — so it is pinned here against real rules in a real database, not asserted
 * from a comment.
 *
 * The other load-bearing assertion is NEGATIVE and lives at the bottom: nothing is stored. If a future
 * round adds a benefit-scheme column or table, that test fails and someone has to read why release three
 * deleted the last one.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hireEmployee } from '../core/org';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { benefitSchemeView } from '../core/entitlement-scheme-view';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const AS_OF = '2026-06-30';
const HIRED = '2020-01-01'; // ~6 completed years at AS_OF, so a 5+ band applies

let base: Base;

async function newLeaveType(tenantId: string, code: string, name: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId, code, name, paid: true })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const BANDS = [
  { fromYears: 0, toYears: 2, days: 12 },
  { fromYears: 2, toYears: 5, days: 16 },
  { fromYears: 5, toYears: null, days: 21 },
];

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});

describe('4da751c6 · Benefit Scheme is derived from the engine, never stored', () => {
  it('names the single winning rule and reads the band for the employee’s service', async () => {
    const ctx = adminCtx(base);
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Derived Scheme', primaryEmail: 'derived.scheme@t.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: HIRED,
    } as never);

    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: base.annualLeaveTypeId,
      name: 'Grade 12-15 Annual',
      serviceBands: BANDS,
      validFrom: '2019-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Grade 12-15 (Permanent)',
      templateLineageId: tpl.lineageId,
      criteria: { companyIds: [base.companyId] },
      validFrom: '2019-01-01',
    });

    const view = await benefitSchemeView(ctx, emp.employmentId, AS_OF);

    expect(view.schemeName).toBe('Grade 12-15 (Permanent)');
    expect(view.ambiguous).toBe(false);
    // The 5+ band, chosen by the engine's own bandFor — not recomputed here.
    const annual = view.perType.find((r) => r.leaveTypeId === base.annualLeaveTypeId);
    expect(annual?.daysAtService).toBe(21);
    expect(view.serviceYears).toBeGreaterThanOrEqual(5);
  });

  it('REFUSES TO INVENT A NAME when two leave types resolve through different rules', async () => {
    const ctx = adminCtx(base);
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Split Scheme', primaryEmail: 'split.scheme@t.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: HIRED,
    } as never);

    const medicalId = await newLeaveType(base.tenantId, 'MED_X', 'Medical Leave X');

    const annualTpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: base.annualLeaveTypeId,
      name: 'Annual table',
      serviceBands: BANDS,
      validFrom: '2019-01-01',
    });
    const medicalTpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: medicalId,
      name: 'Medical table',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
      validFrom: '2019-01-01',
    });

    // TWO DIFFERENTLY-NAMED RULES, each winning for a different leave type. This is the shape that has no
    // single scheme name, and it is legal configuration rather than a mistake.
    await createEligibilityRule(ctx, {
      name: 'Grade 12-15 (Permanent)',
      templateLineageId: annualTpl.lineageId,
      criteria: { companyIds: [base.companyId] },
      validFrom: '2019-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'All full-time employees',
      templateLineageId: medicalTpl.lineageId,
      criteria: { companyIds: [base.companyId] },
      validFrom: '2019-01-01',
    });

    const view = await benefitSchemeView(ctx, emp.employmentId, AS_OF);

    expect(view.ambiguous).toBe(true);
    expect(view.schemeName).toBeNull();
    // …and the per-type list is still there, because that is what replaces the name on screen.
    expect(view.perType.length).toBeGreaterThanOrEqual(2);
    const names = view.perType.map((r) => r.ruleName);
    expect(names).toContain('Grade 12-15 (Permanent)');
    expect(names).toContain('All full-time employees');
  });

  it('a sole table with no rule is NOT ambiguity — it reports viaSoleTemplate and stays calm', async () => {
    const ctx = adminCtx(base);
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Sole Table', primaryEmail: 'sole.table@t.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: HIRED,
    } as never);
    await createEntitlementTemplate(ctx, {
      leaveTypeId: base.annualLeaveTypeId,
      name: 'The only annual table',
      serviceBands: BANDS,
      validFrom: '2019-01-01',
    });
    // No eligibility rule at all — r193 fault 3.

    const view = await benefitSchemeView(ctx, emp.employmentId, AS_OF);

    expect(view.ambiguous).toBe(false);
    const annual = view.perType.find((r) => r.leaveTypeId === base.annualLeaveTypeId);
    expect(annual?.viaSoleTemplate).toBe(true);
    expect(annual?.ruleName).toBeNull();
  });

  it('shows no Effective From rather than a guessed one when nothing moved the employee', async () => {
    const ctx = adminCtx(base);
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Never Moved', primaryEmail: 'never.moved@t.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: HIRED,
    } as never);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: base.annualLeaveTypeId,
      name: 'Annual',
      serviceBands: BANDS,
      validFrom: '2019-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone here',
      templateLineageId: tpl.lineageId,
      criteria: { companyIds: [base.companyId] },
      validFrom: '2019-01-01',
    });

    const view = await benefitSchemeView(ctx, emp.employmentId, AS_OF);
    // AGENTS 28: an absent value asserts nothing; a wrong date asserts something false.
    expect(view.effectiveFrom).toBeNull();
  });
});

describe('4da751c6 · the negative guard — this feature stores NOTHING', () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

  /**
   * ⚠️ STRIP COMMENTS FIRST — AGENTS 27, and this guard learned it the hard way on its own first run.
   * `db/schema.ts` mentions `employment.benefit_scheme_id` in FOUR comments that exist precisely to
   * record that release three deleted it. A bare string match therefore fails on the documentation of
   * the very removal it is protecting, which is the guard calling correct code a defect.
   * What we actually forbid is a live column DEFINITION, so match drizzle's own syntax against source
   * with the prose taken out.
   */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('adds no benefit-scheme column or table to the schema', () => {
    const schemaSrc = stripComments(read('db/schema.ts'));
    // release three deleted these on purpose; nothing in this round may bring them back.
    expect(schemaSrc).not.toMatch(/uuid\(['\`]benefit_scheme_id['\`]\)/);
    expect(schemaSrc).not.toMatch(/export const benefitScheme\s*=\s*pgTable/);
    expect(schemaSrc).not.toMatch(/export const schemeLeaveEntitlement\s*=\s*pgTable/);
  });

  it('the round adds no migration at all — a stored scheme would need one', () => {
    // If this ever fails, someone reintroduced storage. Read core/entitlement-scheme-view.ts's header
    // before "fixing" it by deleting this case.
    const src = stripComments(read('core/entitlement-scheme-view.ts'));
    expect(src).not.toMatch(/pgTable/);
  });

  it('the view module performs no write of any kind', () => {
    const src = read('core/entitlement-scheme-view.ts');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });

  it('does not build a second eligibility matcher — it delegates to the engine resolver', () => {
    const src = read('core/entitlement-scheme-view.ts');
    expect(src).toMatch(/buildTemplateEntitlementResolver/);
    // The band choice is the engine's, not a local re-derivation of "contiguous from 0".
    expect(src).toMatch(/bandFor\(/);
    expect(src).not.toMatch(/resolveOrgCriteriaTargets/);
  });
});
