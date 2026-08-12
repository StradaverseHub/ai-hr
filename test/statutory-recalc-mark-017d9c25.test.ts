/**
 * Feedback 017d9c25 (r187) — changing a Pay Item marks the runs it makes stale.
 *
 * Keying a one-off transaction against a processed run already marks it (core/payroll-individual-txn.ts
 * calls markBatchNeedsRecalc on every add / change / remove); recomputing attendance already marks it.
 * Changing a PAY ITEM did not — which is exactly why the reporter's January figures sat there looking
 * settled after they unticked EPF. The run said nothing, and Close would have accepted it.
 *
 * The mark drives machinery that already exists: app/payroll/[batchId]/page.tsx renders `needsRecalc`,
 * and closeBatch refuses while it is set. So the whole of this item's step 5 is one call at the right
 * moment, plus the predicate that keeps a RENAME from making every open run in the tenant look stale.
 */
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, markRunsAffectedByPayComponent } from '../core/payroll';
import {
  isStatutoryRelevantChange,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;

const input = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name: `${code} component`,
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: false,
  ...over,
});

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function hire(email: string, ic: string, basic = 4000) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
  return e;
}

const batchRow = async (batchId: string) =>
  (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];

const enableTypedComponents = async () => {
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(base);
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('017d9c25 — isStatutoryRelevantChange (pure)', () => {
  it('a statutory flag, the kind, the amount rule and the PCB classification all count', () => {
    for (const f of ['includedInEpf', 'includedInSocsoEis', 'includedInPcb', 'includedInHrdfBase', 'kind', 'isNonPayable', 'prorates', 'roundingMethod', 'rule', 'epfBonus2012', 'pcbRemunerationType', 'pcbExemptionCode']) {
      expect(isStatutoryRelevantChange([f])).toBe(true);
    }
  });

  it('presentation-only edits do NOT count — a rename must not make every open run look stale', () => {
    expect(isStatutoryRelevantChange(['name'])).toBe(false);
    expect(isStatutoryRelevantChange(['label'])).toBe(false);
    expect(isStatutoryRelevantChange(['eaFormLine'])).toBe(false);
    expect(isStatutoryRelevantChange(['displayCategory'])).toBe(false);
    expect(isStatutoryRelevantChange(['name', 'label', 'displayCategory'])).toBe(false);
    expect(isStatutoryRelevantChange([])).toBe(false);
    // …but a rename bundled WITH a statutory flag change still counts.
    expect(isStatutoryRelevantChange(['name', 'includedInEpf'])).toBe(true);
  });
});

describe('017d9c25 — the mark lands on the processed run, naming the employees', () => {
  it('marks a processed run carrying the item, and names only the employees who carry it', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PARK', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    const carrier = await hire('carrier@acme.test', '900101015201');
    const other = await hire('other@acme.test', '900101015202');
    await setEmploymentPayComponent(a, { employmentId: carrier.employmentId, componentId: await idByCode('PARK'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });

    // Nothing is marked yet — the run was just processed from its own inputs.
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    const marked = await markRunsAffectedByPayComponent(a, { componentId: await idByCode('PARK'), code: 'PARK' });
    expect(marked).toHaveLength(1);
    expect(marked[0].batchId).toBe(batchId);
    expect(marked[0].employmentIds).toEqual([carrier.employmentId]);

    const row = await batchRow(batchId);
    expect(row.needsRecalcAt).not.toBeNull();
    expect(row.recalcEmploymentIds).toEqual([carrier.employmentId]);
    // The employee who does not carry the item is NOT named — a reprocess screen that lists everybody
    // is a screen nobody reads.
    expect(row.recalcEmploymentIds).not.toContain(other.employmentId);
  });

  it('a DRAFT run is never marked — a draft recalculates by being generated', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PARK', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    const e = await hire('draft@acme.test', '900101015203');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('PARK'), amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await enableTypedComponents();

    const marked = await markRunsAffectedByPayComponent(a, { componentId: await idByCode('PARK'), code: 'PARK' });
    expect(marked).toEqual([]);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
  });

  it('marking is idempotent — saving the same Pay Item twice does not duplicate the employment set', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PARK', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    const e = await hire('idem@acme.test', '900101015204');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('PARK'), amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });

    const id = await idByCode('PARK');
    await markRunsAffectedByPayComponent(a, { componentId: id, code: 'PARK' });
    await markRunsAffectedByPayComponent(a, { componentId: id, code: 'PARK' });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
  });

  it('an unrelated Pay Item marks nothing', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PARK', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    await upsertPayComponent(a, input('UNUSED', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    const e = await hire('unrel@acme.test', '900101015205');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('PARK'), amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });

    expect(await markRunsAffectedByPayComponent(a, { componentId: await idByCode('UNUSED'), code: 'UNUSED' })).toEqual([]);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
  });
});

describe('017d9c25 — the master-save action is the caller', () => {
  const ACTIONS = fs.readFileSync(path.join(process.cwd(), 'app/admin/pay-components/actions.ts'), 'utf8');

  it('updateComponentAction gates the mark on isStatutoryRelevantChange', () => {
    expect(ACTIONS).toContain('isStatutoryRelevantChange(changed)');
    expect(ACTIONS).toContain('markRunsAffectedByPayComponent(s, { componentId: id, code: input.code })');
  });

  it('imports the payroll kernel through the pack facade, not core/payroll directly (ADR-0080 ratchet)', () => {
    expect(ACTIONS).toContain("from '@/packs/payroll/service'");
    expect(ACTIONS).not.toContain("from '@/core/payroll'");
  });
});
