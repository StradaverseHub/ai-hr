import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment,compensation} from '../db/schema';
import {compensationAmendmentHistory} from '../core/comp';
import {employmentPaymentMethodOnSql} from '../core/employment-payment-method';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let fixture:ScaleFixture;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();const base=await seedBase();
 fixture=await buildScaleFixture(base,{employments:1000,events:0});
 // Installation backfill has the same value as the existing master, with no invented earlier date.
 await owner.client`insert into employment_payment_method_history(tenant_id,employment_id,effective_on,payment_method,source)
  select tenant_id,id,'2026-01-01',payment_method::text,'legacy_snapshot' from employment where tenant_id=${base.tenantId}::uuid`;
 // Reader fixtures use the actual native compensation IDs. No amount is copied into audit payloads.
 await owner.client`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload)
  select c.tenant_id,'compensation',c.id,'compensation.amended','system',c.employment_id,
   jsonb_build_object('effectiveFrom','2026-01-15','payrollEffectiveFrom','2026-02-01','informationOnly',false,'reason','Fictional group-scale amendment')
  from compensation c where c.tenant_id=${base.tenantId}::uuid`;

},300_000);
afterAll(closeAll);

const read=(ctx:SessionContext,dated:boolean,companyId?:string)=>withTenant(ctx,tx=>tx.select({id:employment.id,companyId:employment.companyId,
 method:dated?employmentPaymentMethodOnSql(sql`${employment.id}`,'2026-02-01',sql`${employment.paymentMethod}::text`):sql<string|null>`${employment.paymentMethod}::text`})
 .from(employment).where(companyId?eq(employment.companyId,companyId):undefined).orderBy(asc(employment.id)));

describe('dated payment-method reader at group scale',()=>{
 it('preserves visible rows, order, count and methods for every group and single-company persona',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.employmentIds.length).toBeGreaterThanOrEqual(1000);
  for(const [name,ctx] of Object.entries(fixture.personas)){
   for(const companyId of [undefined,fixture.singleCompanyId]){
    const previous=await read(ctx,false,companyId);
    const observed=await observeStatements(()=>read(ctx,true,companyId));
    expect(previous.length,`${name}: nonempty authorized source`).toBeGreaterThan(0);
    expect(observed.result,name).toEqual(previous);
    const canonical=await withTenant(ctx,tx=>tx.select({id:employment.id,companyId:employment.companyId,
     method:sql<string|null>`app.employment_payment_method_on(${employment.id},'2026-02-01'::date)`})
     .from(employment).where(companyId?eq(employment.companyId,companyId):undefined).orderBy(asc(employment.id)));
    expect(observed.result,name+': native dated-owner equivalence').toEqual(canonical);
    expect(observed.statements.filter(statement=>statement.sql.includes('employment_payment_method_history')),`${name}: one set-based query`).toHaveLength(1);
   }
  }
 },120_000); // Group fixture includes 1,000 RLS-protected rows; leave headroom for hosted runners.
 it('reads salary amendment references as one bounded subject query for group, multi and single-company HR',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);expect(fixture.employmentIds.length).toBeGreaterThanOrEqual(1000);
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const [expected]=await withTenant(ctx,tx=>tx.select({employmentId:employment.id,compensationId:compensation.id,basicSalary:compensation.basicSalary,currency:compensation.currency})
    .from(employment).innerJoin(compensation,eq(compensation.employmentId,employment.id)).where(eq(employment.companyId,fixture.singleCompanyId)).orderBy(asc(employment.id)).limit(1));
   expect(expected,name+': nonempty authorized salary source').toBeDefined();
   const observed=await observeStatements(()=>compensationAmendmentHistory(ctx,expected.employmentId));
   expect(observed.result).toMatchObject({page:1,hasMore:false,rows:[{compensationId:expected.compensationId,basicSalary:expected.basicSalary,currency:expected.currency,effectiveFrom:'2026-01-15',payrollFrom:'2026-02-01'}]});
   expect(observed.statements.filter(statement=>statement.sql.includes('inner join "compensation"')&&statement.sql.includes('limit'))).toHaveLength(1);
  }
 },120_000);
 it('does not substitute the current master for a known pre-history date',async()=>{
  const rows=await withTenant(fixture.personas.group,tx=>tx.select({method:employmentPaymentMethodOnSql(sql`${employment.id}`,'2025-12-31')}).from(employment));
  expect(rows.length).toBeGreaterThanOrEqual(1000);
  expect(rows.every(row=>row.method===null)).toBe(true);
 },120_000);
});
