import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {ensurePayrollBasicVarianceSample,getCustomReport,listCustomReports,updateCustomReport} from '../core/custom-reports';
import {payrollComparisonOptions,payrollComparisonPayItems,payrollComparisonSpec} from '../core/report-payroll-comparison';
import {MasterReportAccessError} from '../core/employee-master-access';
import {DEFAULT_PAYROLL_COMPARISON} from '../lib/payroll-period-comparison';
import {setPayrollPermissionGrant} from '../packs/payroll/service';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
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
 it('gives the landing dialog the same ordered pay items under current company permissions',async()=>{
  const companies=await owner.client<{id:string}[]>`
   insert into company(tenant_id,legal_name)
   select ${b.tenantId}::uuid,'Fictional reporting company '||n from generate_series(1,71) n returning id`;
  const group=[b.companyId,...companies.map(company=>company.id)];
  const employees=await owner.client<{company_id:string}[]>`
   with people as (
    insert into person(tenant_id,full_name,primary_email)
    select ${b.tenantId}::uuid,'Fictional reporting employee '||n,'report-options-'||n||'@example.invalid'
    from generate_series(1,1152) n returning id
   )
   insert into employment(tenant_id,person_id,company_id,hired_on)
   select ${b.tenantId}::uuid,p.id,c.id,'2024-01-01'::date
   from (select id,row_number() over(order by id)n from people)p
   join unnest(${group}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
   returning company_id`;
  expect(employees).toHaveLength(1152);
  expect(new Set(employees.map(employee=>employee.company_id))).toEqual(new Set(group));
  for(const scope of [group,[b.companyId]]){
   const fullStarted=performance.now();
   const full=await payrollComparisonOptions(ctx,scope);
   const fullMs=Math.round(performance.now()-fullStarted);
   const optionsStarted=performance.now();
   const payItems=await payrollComparisonPayItems(ctx,scope);
   const pickerMs=Math.round(performance.now()-optionsStarted);
   expect(full.companies).toHaveLength(scope.length);
   expect(full.payItems.length).toBeGreaterThan(2);
   expect(payItems).toEqual(full.payItems);
   console.info('Reports pay-item comparison',{companies:scope.length,fullMs,pickerMs});
  }
  await setPayrollPermissionGrant(ctx,{companyId:group[1],permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
  await expect(payrollComparisonPayItems(ctx,group)).rejects.toBeInstanceOf(MasterReportAccessError);
  await expect(payrollComparisonPayItems(ctx,[b.companyId])).resolves.toEqual((await payrollComparisonOptions(ctx,[b.companyId])).payItems);
 },90000);
 it('denies revoked identity grants, a forged role, missing user, inactive Payroll and foreign scope',async()=>{
  const other=await seedBase();
  await expect(ensurePayrollBasicVarianceSample(ctx,[other.companyId])).rejects.toThrow();
  await expect(ensurePayrollBasicVarianceSample({...ctx,userId:undefined},[b.companyId])).rejects.toThrow();
  await expect(ensurePayrollBasicVarianceSample({...ctx,roles:['super_admin']},[b.companyId])).rejects.toThrow();
  await setModule(b.tenantId,'payroll','disabled');
  await expect(ensurePayrollBasicVarianceSample({...await entitledCtx(b),grants:ctx.grants},[b.companyId])).rejects.toThrow();
  await setModule(b.tenantId,'payroll','active');
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,ctx.userId!));
  await expect(ensurePayrollBasicVarianceSample(ctx,[b.companyId])).rejects.toThrow();expect(await definitions()).toEqual([]);
 });
});
