import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { createPayComponent, listPayComponents, updatePayComponent, setEmploymentPayComponent, type PayComponentInput } from '../core/pay-components';
import { createIndividualTxn, createIndividualTxnsBulk, insertIndividualTxnsTx } from '../core/payroll-individual-txn';
import { payComponentCompanyChoices, PayComponentCompanyError, assertPayComponentCompaniesTx } from '../core/pay-component-company';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const input = (code: string, patch: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code, name: code, label: code, kind: 'allowance', includedInEpf: false, includedInSocsoEis: false,
  includedInPcb: false, includedInHrdfBase: false, isNonPayable: false, prorates: false, ...patch,
});

describe('Pay Item company applicability at entry, without rewriting historical payroll', () => {
  let base: Base, ctx: SessionContext, otherCompany: string, employmentId: string;
  const date = '2026-11-01';
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => {
    await resetDb(); base = await seedBase(); ctx = adminCtx(base);
    const [other] = await owner.db.insert(s.company).values({tenantId:base.tenantId,legalName:'Other fictional company'}).returning({id:s.company.id});
    otherCompany = other.id;
    const hired = await hireEmployee(ctx, {person:{fullName:'Fictional company applicability employee',primaryEmail:'company-rule@fictional.test'},companyId:base.companyId,hiredOn:'2026-01-01',employmentType:'full_time'});
    employmentId = hired.employmentId;
  });
  afterAll(closeAll);

  it('defaults old and new omitted settings to All Companies and round-trips explicit IDs', async () => {
    const a = await createPayComponent(ctx,input('ALL'));
    const b = await createPayComponent(ctx,input('SELECTED',{appliedCompanyIds:[base.companyId]}));
    expect((await listPayComponents(ctx)).find(row=>row.id===a.id)?.appliedCompanyIds).toBeNull();
    expect((await listPayComponents(ctx)).find(row=>row.id===b.id)?.appliedCompanyIds).toEqual([base.companyId]);
    expect((await listPayComponents(ctx,{companyId:otherCompany})).map(row=>row.code)).not.toContain('SELECTED');
    await updatePayComponent(ctx,input('SELECTED',{name:'Changed description'}));
    expect((await listPayComponents(ctx)).find(row=>row.id===b.id)?.appliedCompanyIds).toEqual([base.companyId]);
  });

  it('refuses empty, forged and foreign-tenant selections with no created row', async () => {
    const other = await seedBase();
    for (const ids of [[], ['00000000-0000-0000-0000-000000000000'], [other.companyId]]) {
      await expect(createPayComponent(ctx,input('INVALID',{appliedCompanyIds:ids}))).rejects.toThrow();
    }
    expect((await listPayComponents(ctx)).some(row=>row.code==='INVALID')).toBe(false);
  });

  it('filters choices by real company administration and preserves the scope on partial-admin metadata saves', async () => {
    const {id} = await createPayComponent(ctx,input('SCOPED',{appliedCompanyIds:[otherCompany]}));
    const partial = {...ctx,grants:[{role:'hr_admin',companyId:base.companyId}]};
    const choices = await payComponentCompanyChoices(partial);
    expect(choices.canManageAll).toBe(false);expect(choices.companies.map(row=>row.id)).toEqual([base.companyId]);
    await updatePayComponent(partial,input('SCOPED',{name:'Metadata only'}));
    expect((await listPayComponents(ctx)).find(row=>row.id===id)?.appliedCompanyIds).toEqual([otherCompany]);
    await expect(updatePayComponent(partial,input('SCOPED',{appliedCompanyIds:null}))).rejects.toThrow();
  });

  it('refuses individual, bulk, fixed and import entry through their shared writers', async () => {
    const {id} = await createPayComponent(ctx,input('INELIGIBLE',{appliedCompanyIds:[otherCompany]}));
    await expect(createIndividualTxn(ctx,{companyId:base.companyId,payPeriod:'2026-11',employmentId,componentId:id,kind:'earning',txnDate:date,amount:70})).rejects.toBeInstanceOf(PayComponentCompanyError);
    await expect(createIndividualTxnsBulk(ctx,{companyId:base.companyId,payPeriod:'2026-11',employmentIds:[employmentId],rows:[{componentId:id,kind:'earning',txnDate:date,amount:70}]})).rejects.toBeInstanceOf(PayComponentCompanyError);
    await expect(setEmploymentPayComponent(ctx,{employmentId,componentId:id,amount:70,effectiveFrom:date})).rejects.toBeInstanceOf(PayComponentCompanyError);
    await expect(withTenant(ctx,tx=>insertIndividualTxnsTx(tx,ctx,{batchId:null,companyId:base.companyId,payPeriod:'2026-11',rows:[{employmentId,componentId:id,kind:'earning',txnDate:date,amount:70}]}))).rejects.toBeInstanceOf(PayComponentCompanyError);
    expect(await owner.db.select().from(s.payrollIndividualTxn).where(eq(s.payrollIndividualTxn.componentId,id))).toEqual([]);
    expect(await owner.db.select().from(s.employmentPayComponent).where(eq(s.employmentPayComponent.componentId,id))).toEqual([]);
  });

  it('retains previously saved transactions and recurring records when company applicability changes', async () => {
    const {id} = await createPayComponent(ctx,input('HISTORY'));
    await createIndividualTxn(ctx,{companyId:base.companyId,payPeriod:'2026-11',employmentId,componentId:id,kind:'earning',txnDate:date,amount:70});
    await setEmploymentPayComponent(ctx,{employmentId,componentId:id,amount:80,effectiveFrom:date});
    const read = async () => ({oneOff:await owner.db.select().from(s.payrollIndividualTxn).where(eq(s.payrollIndividualTxn.componentId,id)),fixed:await owner.db.select().from(s.employmentPayComponent).where(eq(s.employmentPayComponent.componentId,id))});
    const before = await read();expect(before.oneOff).toHaveLength(1);expect(before.fixed).toHaveLength(1);
    await updatePayComponent(ctx,input('HISTORY',{appliedCompanyIds:[otherCompany]}));
    expect(await read()).toEqual(before);
  });

  it('uses the dated company owner rather than the current employment column', async () => {
    const {id} = await createPayComponent(ctx,input('DATED',{appliedCompanyIds:[base.companyId]}));
    // A retained dated assignment remains the independent expected source after a later entity move.
    const existing = await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,employmentId));
    if (existing.length) await owner.db.update(s.assignment).set({companyId:base.companyId,validTo:'2026-07-01'}).where(eq(s.assignment.id,existing[0].id));
    else await owner.db.insert(s.assignment).values({tenantId:base.tenantId,employmentId,companyId:base.companyId,validFrom:'2026-01-01',validTo:'2026-07-01'});
    await owner.db.update(s.employment).set({companyId:otherCompany}).where(eq(s.employment.id,employmentId));
    await withTenant(ctx,tx=>assertPayComponentCompaniesTx(tx,ctx,[{componentId:id,employmentId,effectiveDate:'2026-06-01'}]));
    await expect(withTenant(ctx,tx=>assertPayComponentCompaniesTx(tx,ctx,[{componentId:id,employmentId,effectiveDate:date}]))).rejects.toBeInstanceOf(PayComponentCompanyError);
  });

  it('refuses native invalid configuration and retains company identity on deletion', async () => {
    const {id} = await createPayComponent(ctx,input('NATIVE',{appliedCompanyIds:[otherCompany]}));
    await expect(withTenant(ctx,tx=>tx.execute(sql`update public.pay_component set applied_company_ids=ARRAY[${base.companyId}::uuid,${base.companyId}::uuid] where id=${id}::uuid`))).rejects.toThrow();
    const foreign = await seedBase();
    await expect(withTenant(ctx,tx=>tx.execute(sql`update public.pay_component set applied_company_ids=ARRAY[${foreign.companyId}::uuid] where id=${id}::uuid`))).rejects.toThrow();
    await expect(withTenant(ctx,tx=>tx.delete(s.company).where(and(eq(s.company.id,otherCompany),eq(s.company.tenantId,base.tenantId))))).rejects.toThrow();
  });
});
