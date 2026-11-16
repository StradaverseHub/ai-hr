import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment} from '../db/schema';
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
},300_000);
afterAll(closeAll);

const read=(ctx:SessionContext,dated:boolean,companyId?:string)=>withTenant(ctx,tx=>tx.select({id:employment.id,companyId:employment.companyId,
 method:dated?employmentPaymentMethodOnSql(sql`${employment.id}`,'2026-02-01'):sql<string|null>`${employment.paymentMethod}::text`})
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
    expect(observed.statements.filter(statement=>statement.sql.includes('employment_payment_method_on')),`${name}: one set-based query`).toHaveLength(1);
   }
  }
 },120_000); // Group fixture includes 1,000 RLS-protected rows; leave headroom for hosted runners.
 it('does not substitute the current master for a known pre-history date',async()=>{
  const rows=await withTenant(fixture.personas.group,tx=>tx.select({method:employmentPaymentMethodOnSql(sql`${employment.id}`,'2025-12-31')}).from(employment));
  expect(rows.length).toBeGreaterThanOrEqual(1000);
  expect(rows.every(row=>row.method===null)).toBe(true);
 },120_000);
});
