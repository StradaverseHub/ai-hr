import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {ensurePayrollBasicVarianceSample,getCustomReport,listCustomReports,updateCustomReport} from '../core/custom-reports';
import {payrollComparisonSpec} from '../core/report-payroll-comparison';
import {DEFAULT_PAYROLL_COMPARISON} from '../lib/payroll-period-comparison';
import {setPayrollPermissionGrant} from '../packs/payroll/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};});
const definitions=()=>owner.db.select().from(schema.customReport).where(eq(schema.customReport.tenantId,b.tenantId)).orderBy(asc(schema.customReport.createdAt),asc(schema.customReport.id));
async function peer(){
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'sample-'+randomUUID()}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin'});
 return {...ctx,userId:user.id};
}
describe('explicit Payroll Basic Variance example',()=>{
 it('serializes concurrent requests into one private definition and one creation audit',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>ensurePayrollBasicVarianceSample(ctx,[b.companyId])));
  expect(new Set(results.map(result=>result.id)).size).toBe(1);
  const rows=await definitions();expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({name:'Payroll Basic Variance',createdByUserId:ctx.userId,shared:false,datasetId:'payroll_period_comparison',spec:{payrollComparison:DEFAULT_PAYROLL_COMPARISON}});
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,rows[0].id),eq(schema.domainEvent.eventType,'custom-report.created'))).orderBy(asc(schema.domainEvent.sequence));
  expect(events).toHaveLength(1);expect(JSON.stringify(events[0].payload)).not.toContain('employeeName');
 });
 it('reopens its own edited example without overwriting settings or exposing another private owner',async()=>{
  const first=await ensurePayrollBasicVarianceSample(ctx,[b.companyId]),saved=await getCustomReport(ctx,first.id,[b.companyId]);expect(saved).not.toBeNull();
  const changed=payrollComparisonSpec({...DEFAULT_PAYROLL_COMPARISON,minVariance:'25.00'});
  await updateCustomReport(ctx,{id:first.id,name:'Payroll Basic Variance',spec:changed,version:saved!.version,companyIds:[b.companyId]});
  expect(await ensurePayrollBasicVarianceSample(ctx,[b.companyId])).toEqual(first);
  expect((await getCustomReport(ctx,first.id,[b.companyId]))?.spec.payrollComparison?.minVariance).toBe('25.00');
  const other=await peer();expect(await getCustomReport(other,first.id,[b.companyId])).toBeNull();
  expect(await listCustomReports(other,{category:'payroll',companyIds:[b.companyId]})).toEqual([]);
  const second=await ensurePayrollBasicVarianceSample(other,[b.companyId]);expect(second.id).not.toBe(first.id);
  expect((await definitions()).map(row=>row.createdByUserId).sort()).toEqual([ctx.userId,other.userId].sort());
 });
 it('rechecks financial authority before returning even an existing example',async()=>{
  await ensurePayrollBasicVarianceSample(ctx,[b.companyId]);
  await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
  await expect(ensurePayrollBasicVarianceSample(ctx,[b.companyId])).rejects.toThrow();expect(await definitions()).toHaveLength(1);
 });
 it('denies revoked identity grants, a forged role, missing user, inactive Payroll and foreign scope',async()=>{
  const other=await seedBase();
  await expect(ensurePayrollBasicVarianceSample(ctx,[other.companyId])).rejects.toThrow();
  await expect(ensurePayrollBasicVarianceSample({...ctx,userId:undefined},[b.companyId])).rejects.toThrow();
  await expect(ensurePayrollBasicVarianceSample({...ctx,roles:['super_admin']},[b.companyId])).rejects.toThrow();
  await setModule(b.tenantId,'payroll','disabled');
  await expect(ensurePayrollBasicVarianceSample({...adminCtx(b),grants:ctx.grants},[b.companyId])).rejects.toThrow();
  await setModule(b.tenantId,'payroll','active');
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,ctx.userId!));
  await expect(ensurePayrollBasicVarianceSample(ctx,[b.companyId])).rejects.toThrow();expect(await definitions()).toEqual([]);
 });
});
