import {and,eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {hireEmployee,setReportingLine,terminateEmployment,setEmploymentAssignment,ReportingCycleError,wouldCreateAdminCycle} from '../core/org';
import {orgChartSnapshot,setOrgChartRoot,recordOrgChartExport} from '../core/org-chart';
import {orgChartData} from '../core/read';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
let b:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const hire=(name:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:name+'@org-chart.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
const line=(subordinate:string,manager:string,validFrom='2024-01-01')=>setReportingLine(adminCtx(b),{subordinateEmploymentId:subordinate,managerEmploymentId:manager,lineType:'administrative',validFrom});
const snapshot=(asOf='2026-06-01')=>orgChartSnapshot(adminCtx(b),{companyIds:[b.companyId],filter:{asOf}});
describe('34b9579a date-aware permitted hierarchy and explicit roots',()=>{
 it('retains today’s superior until the future effective date, and resolves each historical range',async()=>{
  const a=await hire('First'),b2=await hire('Future'),e=await hire('Employee');await line(e.employmentId,a.employmentId);await line(e.employmentId,b2.employmentId,'2027-01-01');
  expect((await snapshot()).edges).toContainEqual({manager:a.employmentId,subordinate:e.employmentId,type:'administrative'});
  expect((await snapshot('2028-01-01')).edges).toContainEqual({manager:b2.employmentId,subordinate:e.employmentId,type:'administrative'});
  expect((await snapshot()).edges).not.toContainEqual(expect.objectContaining({manager:b2.employmentId}));
 });
 it('empty scopes fail closed, including the compatibility read',async()=>{await hire('Private');expect((await orgChartSnapshot(adminCtx(b),{companyIds:[]})).employees).toEqual([]);expect((await orgChartData(adminCtx(b),[])).employees).toEqual([]);});
 it('requires an explicit top-level fact, audits it, and prevents an overlapping superior in both directions',async()=>{
  const top=await hire('Top'),other=await hire('Other');expect((await snapshot()).employees.find(e=>e.employmentId===top.employmentId)).toMatchObject({topLevel:false,managerState:'missing'});
  await setOrgChartRoot(adminCtx(b),{employmentId:top.employmentId,validFrom:'2025-01-01',enabled:true});
  expect((await snapshot()).employees.find(e=>e.employmentId===top.employmentId)).toMatchObject({topLevel:true});
  await expect(line(top.employmentId,other.employmentId,'2026-01-01')).rejects.toThrow();
  await setOrgChartRoot(adminCtx(b),{employmentId:top.employmentId,validFrom:'2027-01-01',enabled:false});
  await line(top.employmentId,other.employmentId,'2027-01-01');
  expect((await snapshot('2028-01-01')).employees.find(e=>e.employmentId===top.employmentId)?.topLevel).toBe(false);
  await expect(setOrgChartRoot(adminCtx(b),{employmentId:top.employmentId,validFrom:'2028-01-01',enabled:true})).rejects.toThrow();
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'org-chart-root.changed'))).orderBy(s.domainEvent.sequence);expect(events).toHaveLength(2);
 });
 it('rejects a cycle that begins after the proposed start date',async()=>{
  const a=await hire('Alpha'),b2=await hire('Beta');await line(b2.employmentId,a.employmentId,'2027-01-01');
  await expect(line(a.employmentId,b2.employmentId,'2026-01-01')).rejects.toBeInstanceOf(ReportingCycleError);
 });
 it('serializes opposing concurrent canonical reporting changes; exactly one succeeds',async()=>{
  const a=await hire('Alpha'),b2=await hire('Beta');const outcomes=await Promise.allSettled([line(a.employmentId,b2.employmentId),line(b2.employmentId,a.employmentId)]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);expect((await snapshot()).edges).toHaveLength(1);
 });
 it('does not expose another employee, manager name, root editing or exports to an own-only viewer',async()=>{
  const a=await hire('ConfidentialManager'),e=await hire('OwnEmployee');await line(e.employmentId,a.employmentId);
  const userId=await createAppUser(b.tenantId,e.personId,'employee');const ctx={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee']};
  const view=await orgChartSnapshot(ctx,{companyIds:[b.companyId],filter:{asOf:'2026-01-01'}});
  expect(view.employees.map(e=>e.name)).toEqual(['OwnEmployee']);expect(view.canManage).toBe(false);expect(JSON.stringify(view)).not.toContain('ConfidentialManager');
  await expect(setOrgChartRoot(ctx,{employmentId:e.employmentId,validFrom:'2026-01-01',enabled:true})).rejects.toThrow();
  await expect(recordOrgChartExport(ctx,{companyIds:[b.companyId],asOf:'2026-01-01',employmentIds:[e.employmentId],filters:{},layout:{}})).rejects.toThrow();
 });
});

it('34b9579a: future assignment versions do not erase today’s department, and departed managers produce a vacancy flag',async()=>{
 const manager=await hire('Departing'),employee=await hire('Remaining');await line(employee.employmentId,manager.employmentId);
 await setEmploymentAssignment(adminCtx(b),{employmentId:employee.employmentId,effectiveDate:'2027-01-01',departmentId:b.deptB});
 expect((await snapshot()).employees.find(e=>e.employmentId===employee.employmentId)?.departmentId).toBe(b.deptA);
 expect((await snapshot('2028-01-01')).employees.find(e=>e.employmentId===employee.employmentId)?.departmentId).toBe(b.deptB);
 await terminateEmployment(adminCtx(b),{employmentId:manager.employmentId,terminationDate:'2025-01-01'});
 const view=await snapshot();expect(view.edges).toEqual([]);expect(view.employees.find(e=>e.employmentId===employee.employmentId)).toMatchObject({managerState:'inactive',managerName:'Departing'});
});
it('34b9579a: tenant and company filters cannot reveal another tenant’s employees',async()=>{const other=await seedBase();const view=await orgChartSnapshot(adminCtx(b),{companyIds:[other.companyId],filter:{asOf:'2026-01-01'}});expect(view.employees).toEqual([]);expect(view.options).toEqual([]);});

it('34b9579a: a concurrent root designation and manager assignment cannot both commit',async()=>{
 const a=await hire('ProposedRoot'),manager=await hire('ProposedManager');
 const outcomes=await Promise.allSettled([setOrgChartRoot(adminCtx(b),{employmentId:a.employmentId,validFrom:'2025-01-01',enabled:true}),line(a.employmentId,manager.employmentId,'2025-01-01')]);
 expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);
 const view=await snapshot();const target=view.employees.find(e=>e.employmentId===a.employmentId)!;expect(target.topLevel&&view.edges.some(edge=>edge.subordinate===a.employmentId)).toBe(false);
});

it('34b9579a: finite historical correction windows do not inherit a cycle that starts after they end',async()=>{
 const a=await hire('HistoricalAlpha'),b2=await hire('HistoricalBeta');await line(b2.employmentId,a.employmentId,'2027-01-01');
 expect(await withTenant(adminCtx(b),tx=>wouldCreateAdminCycle(tx,a.employmentId,b2.employmentId,'2024-01-01','2025-01-01'))).toBe(false);
 expect(await withTenant(adminCtx(b),tx=>wouldCreateAdminCycle(tx,a.employmentId,b2.employmentId,'2024-01-01',null))).toBe(true);
});
