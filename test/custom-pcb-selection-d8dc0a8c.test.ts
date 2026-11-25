/**
 * Board d8dc0a8c / ADR 0183 — custom PCB on the employer-scoped Income Tax Resident selection, against the database.
 *
 * Covers the writer (validation, keep-the-saved-number rule, audit), the 7370 constraint, the single and group
 * resolvers, the person-only refusal, and real payroll runs: a regular run deducts the fixed amount, a bonus run in
 * the same month deducts nothing more, a custom rate follows the Non-Resident working, and a missing number stops
 * payroll instead of falling back to the standard formula. Fictional fixtures only.
 */
import {randomUUID} from 'node:crypto';
import {and, eq, sql} from 'drizzle-orm';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {withTenant, type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {batchDetail} from '../core/payroll';
import {createAdditionalRun, createBatch, generatePayslips, setPayrollInput} from '../packs/payroll/service';
import {setStatutoryProfileMY, setTaxProfileMY} from '../localization/my/statutory';
import {getTaxSelectionMY, resolveTaxSelectionMY, resolveTaxSelectionsMY, saveTaxSelectionMY} from '../localization/my/tax-selection';
import {closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base} from './harness';

let b: Base, ctx: SessionContext, e: Awaited<ReturnType<typeof hireEmployee>>;
let ic = 31000;
const NAME = 'Synthetic Custom PCB';
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
  ctx = {...await entitledCtx(b, ['hr_admin']), grants: [{role: 'hr_admin', companyId: null}]};
  e = await hireEmployee(ctx, {person: {fullName: NAME, primaryEmail: `custom_pcb_${randomUUID().slice(0, 8)}@example.test`},
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01'});
  await setCompensation(ctx, {employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01'});
  await setStatutoryProfileMY(ctx, {personId: e.personId, icNumber: `900101${String(ic++).padStart(6, '0')}`, taxCategory: 1});
});

const save = (scheme: string, customValue?: string) =>
  saveTaxSelectionMY(ctx, {employmentId: e.employmentId, expectedCompanyId: b.companyId, scheme, ...(customValue === undefined ? {} : {customValue})});
const row = async () => (await owner.db.select().from(schema.employmentTaxSelectionMy)
  .where(eq(schema.employmentTaxSelectionMy.employmentId, e.employmentId)))[0];
const resolve = () => withTenant(ctx, tx => resolveTaxSelectionMY(tx, {tenantId: b.tenantId, employmentId: e.employmentId, companyId: b.companyId, payPeriod: '2026-06', legacyScheme: 'resident', resident: true}));
async function run(payPeriod: string) {
  const batch = await createBatch(ctx, {companyId: b.companyId, payPeriod});
  await generatePayslips(ctx, {batchId: batch.batchId});
  return {batchId: batch.batchId, slip: await slipOf(batch.batchId)};
}
async function slipOf(batchId: string) {
  const slip = (await batchDetail(ctx, batchId))!.slips.find(s => s.name === NAME)!;
  return slip.statutory as unknown as {pcb: number; pcbBonus: number; pcbMeta: Record<string, unknown>};
}

describe('custom PCB selection writer (board d8dc0a8c)', () => {
  it('saves a fixed amount with the selection, audits both numbers and resolves it for payroll', async () => {
    const saved = await save('custom_fixed', '450');
    expect(saved).toMatchObject({scheme: 'custom_fixed', customPcbAmount: '450.00', customPcbRate: null, version: 2});
    expect(await getTaxSelectionMY(ctx, e.employmentId)).toMatchObject({scheme: 'custom_fixed', customPcbAmount: 450, customPcbRate: null});
    expect(await resolve()).toMatchObject({scheme: 'custom_fixed', customPcb: {amount: 450, rate: null}, selectionVersion: 2});
    const [event] = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, saved.id),
      eq(schema.domainEvent.eventType, 'employee.tax-scheme.selected'))).orderBy(sql`${schema.domainEvent.occurredAt} desc`).limit(1);
    expect(event.payload).toMatchObject({before: {scheme: 'resident', customPcbAmount: null, customPcbRate: null},
      after: {scheme: 'custom_fixed', customPcbAmount: '450.00', customPcbRate: null}});
  });

  it('refuses a missing or malformed number, and keeps the saved one only for the same choice', async () => {
    await expect(save('custom_fixed')).rejects.toMatchObject({name: 'TaxSelectionError', code: 'custom_value_missing'});
    await expect(save('custom_fixed', '  ')).rejects.toMatchObject({code: 'custom_value_missing'});
    for (const [scheme, value] of [['custom_fixed', '0'], ['custom_fixed', 'abc'], ['custom_fixed', '1,000'], ['custom_rate', '100.5'], ['custom_rate', '0']] as const) {
      await expect(save(scheme, value), `${scheme} ${value}`).rejects.toMatchObject({code: 'custom_value_invalid'});
    }
    expect(await row()).toMatchObject({scheme: 'resident', customPcbAmount: null, customPcbRate: null, version: 1});
    await save('custom_rate', '27.5');
    // A re-save of the same choice without a number (an import repeating it) keeps the number.
    expect(await save('custom_rate')).toMatchObject({scheme: 'custom_rate', customPcbRate: '27.50'});
    // Switching to the other custom choice needs its own number.
    await expect(save('custom_fixed')).rejects.toMatchObject({code: 'custom_value_missing'});
    // Leaving custom clears both numbers.
    expect(await save('non_resident')).toMatchObject({scheme: 'non_resident', customPcbAmount: null, customPcbRate: null});
    await expect(save('custom_rate')).rejects.toMatchObject({code: 'custom_value_missing'});
  });

  it('is employer-scoped: a person-only write cannot choose a custom option, the card write can', async () => {
    await expect(setTaxProfileMY(ctx, {personId: e.personId, taxResidency: 'custom_fixed', customPcbValue: '450'}))
      .rejects.toMatchObject({code: 'invalid_scheme'});
    await setTaxProfileMY(ctx, {personId: e.personId, employmentId: e.employmentId, expectedCompanyId: b.companyId,
      taxCategory: 1, taxResidency: 'custom_fixed', customPcbValue: '450'});
    expect(await row()).toMatchObject({scheme: 'custom_fixed', customPcbAmount: '450.00'});
    // The person record's own residency is unchanged by the employer's custom choice.
    const [person] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect(person.taxResidency).toBe('resident');
  });

  it('cannot store a custom scheme without its number, or a number on any other scheme', async () => {
    const id = (await row()).id;
    const attempt = (set: Partial<typeof schema.employmentTaxSelectionMy.$inferInsert>) => owner.db.update(schema.employmentTaxSelectionMy)
      .set({...set, version: sql`${schema.employmentTaxSelectionMy.version} + 1`}).where(eq(schema.employmentTaxSelectionMy.id, id));
    // drizzle wraps the driver error; the violated constraint is named on its cause.
    const violated = async (write: Promise<unknown>) => {
      try { await write; return null; } catch (error) {
        const cause = (error as {cause?: {constraint_name?: string}}).cause;
        return cause?.constraint_name ?? String(error);
      }
    };
    expect(await violated(attempt({scheme: 'custom_fixed'}))).toBe('employment_tax_selection_my_custom_pcb_check');
    expect(await violated(attempt({scheme: 'custom_rate', customPcbRate: '100.01'}))).toBe('employment_tax_selection_my_custom_pcb_check');
    expect(await violated(attempt({customPcbAmount: '450.00'}))).toBe('employment_tax_selection_my_custom_pcb_check');
    expect(await violated(attempt({scheme: 'custom_fixed', customPcbAmount: '450.00', customPcbRate: '10.00'}))).toBe('employment_tax_selection_my_custom_pcb_check');
    expect(await violated(attempt({scheme: 'flat_rate' as never}))).toBe('employment_tax_selection_my_scheme_check');
    expect(await violated(attempt({scheme: 'custom_fixed', customPcbAmount: '450.00'}))).toBeNull();
  });

  it('answers the group resolver exactly as the single resolver', async () => {
    await save('custom_rate', '30');
    const single = await resolve();
    const group = await withTenant(ctx, tx => resolveTaxSelectionsMY(tx, {tenantId: b.tenantId, companyId: b.companyId, payPeriod: '2026-06',
      employees: [{employmentId: e.employmentId, legacyScheme: 'resident', resident: true}]}));
    expect(group.get(e.employmentId)).toEqual({ok: true, value: single});
    expect(single).toMatchObject({scheme: 'custom_rate', customPcb: {amount: null, rate: 30}});
  });
});

describe('custom PCB in payroll runs (board d8dc0a8c)', () => {
  it('deducts the fixed amount on the regular run and nothing more on a bonus run in the same month', async () => {
    await save('custom_fixed', '450');
    const regular = await run('2026-06');
    expect(regular.slip.pcb).toBe(450);
    expect(regular.slip.pcbMeta).toMatchObject({calculationScheme: 'custom_fixed', customPcb: {amount: 450}});
    const bonus = await createAdditionalRun(ctx, {companyId: b.companyId, payPeriod: '2026-06', runType: 'bonus'});
    await setPayrollInput(ctx, {batchId: bonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 2000});
    await generatePayslips(ctx, {batchId: bonus.batchId});
    expect((await slipOf(bonus.batchId)).pcb).toBe(0);
  });

  it('applies a custom rate the Non-Resident way: RM3,000 at 30% is RM900', async () => {
    await save('custom_rate', '30');
    const {slip} = await run('2026-06');
    expect(slip.pcb).toBe(900);
    expect(slip.pcbMeta).toMatchObject({calculationScheme: 'custom_rate', customPcb: {rate: 30}});
  });

  it('uses the number saved when the run was processed; a later change does not rewrite it', async () => {
    await save('custom_fixed', '450');
    const june = await run('2026-06');
    await save('custom_fixed', '500');
    expect((await slipOf(june.batchId)).pcb).toBe(450);
    expect((await run('2026-07')).slip.pcb).toBe(500);
  });

  it('refuses a selection whose number is missing rather than falling back to the standard formula', async () => {
    const saved = await save('custom_fixed', '450');
    // Only a pre-7370 row could lose its number. Build one inside a transaction that is always rolled back, so the
    // constraint is never absent outside it, and ask the payroll resolver about it there.
    const rolledBack = new Error('roll back');
    await expect(owner.db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE employment_tax_selection_my DROP CONSTRAINT employment_tax_selection_my_custom_pcb_check`);
      await tx.update(schema.employmentTaxSelectionMy).set({customPcbAmount: null, version: saved.version + 1})
        .where(eq(schema.employmentTaxSelectionMy.id, saved.id));
      const args = {tenantId: b.tenantId, companyId: b.companyId, payPeriod: '2026-06'};
      await expect(resolveTaxSelectionMY(tx, {...args, employmentId: e.employmentId})).rejects.toMatchObject({code: 'custom_value_missing'});
      const group = await resolveTaxSelectionsMY(tx, {...args, employees: [{employmentId: e.employmentId}]});
      expect(group.get(e.employmentId)).toMatchObject({ok: false, error: {code: 'custom_value_missing'}});
      throw rolledBack;
    })).rejects.toBe(rolledBack);
    expect(await row()).toMatchObject({customPcbAmount: '450.00'});
  });
});
