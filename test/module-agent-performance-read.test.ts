/** Authored UNRUN: actual modern/standard canonical reads in the caller transaction; no model. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createModuleAgentReaders} from '../core/module-agent-readers';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,a:SessionContext,self:SessionContext,manager:SessionContext,subject:{employmentId:string;personId:string},cycleId:string,reviewId:string;
const year=Number(todayInKualaLumpur().slice(0,4));
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'performance','active');await setModule(base.tenantId,'assistant','active');a=await entitledCtx(base);
 const hire=(name:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 subject=await hire('Fictional Own Modern Review');const mgr=await hire('Fictional Assigned Manager');
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'12',name:'Fictional Grade12'}).returning();await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.tenantId,base.tenantId));
 await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:mgr.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
 self={tenantId:base.tenantId,personId:subject.personId,userId:await createAppUser(base.tenantId,subject.personId,'employee'),roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};
 manager={tenantId:base.tenantId,personId:mgr.personId,userId:await createAppUser(base.tenantId,mgr.personId,'manager'),roles:['manager'],entitlements:harnessSnapshot(base.tenantId)};
 await grantAssistant(a,{appUserId:self.userId!});
 ({cycleId}=await perf.createCycle(a,{name:'Fictional OneHR year end',companyId:base.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));await perf.configureOnehrCycle(a,cycleId,null,defaultPolicy(framework));await perf.openCycle(a,{cycleId});
 const [r]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=r.id;
});
const read=(ctx=self,limit=25)=>withTenant(ctx,tx=>perf.ownPerformanceWorkStatusesTx(tx,ctx,limit));
const assertMinimal=(rows:Awaited<ReturnType<typeof read>>['rows'])=>{for(const row of rows)expect(Object.keys(row).sort()).toEqual(['framework','artifact','reviewId','planId','cycleName','periodEnd','status','released'].sort());};
describe('current own Performance framework metadata',()=>{
 it('reads real OneHR and standard reviews once each with explicit framework and no unreleased content',async()=>{
  const standard=await perf.createCycle(a,{name:'Fictional standard period',companyId:base.companyId,periodStart:`${year-1}-01-01`,periodEnd:`${year-1}-12-31`});await perf.openCycle(a,standard);
  const result=await read();expect(result.rows.filter(row=>row.reviewId===reviewId)).toEqual([{framework:'onehr',artifact:'review',reviewId,planId:null,cycleName:'Fictional OneHR year end',periodEnd:`${year}-12-31`,status:'open',released:null}]);expect(result.rows.some(row=>row.framework==='standard'&&row.cycleName==='Fictional standard period'&&row.released===false)).toBe(true);assertMinimal(result.rows);
  expect(JSON.stringify(result)).not.toMatch(/rating|score|remark|panel|salary|reviewer|competenc|kpis|feedback/i);
 });
 it('projects actual own draft-plan status without private career, goals, remarks or release inference',async()=>{
  await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'PRIVATE_CAREER_POISON',mobility:'stay',mobilityNote:'PRIVATE_MOBILITY_POISON',targetProfileId:null},goals:[]});
  const result=await read(),plan=result.rows.find(row=>row.artifact==='plan');expect(plan).toMatchObject({framework:'onehr',artifact:'plan',reviewId,status:'draft',released:null});expect(plan?.planId).toBeTruthy();assertMinimal(result.rows);expect(JSON.stringify(result)).not.toContain('PRIVATE_');
 });
 it('does not union a manager/admin role into colleagues own projections or accept a foreign person carrier',async()=>{
  const own=await read(),managed=await read(manager),admin=await read(a);expect(own.rows.some(row=>row.reviewId===reviewId)).toBe(true);expect(managed.rows.some(row=>row.reviewId===reviewId)).toBe(false);expect(admin.rows).toEqual([]);
  await expect(withTenant(self,tx=>perf.ownPerformanceWorkStatusesTx(tx,{...self,personId:manager.personId}))).rejects.toThrow();
  await expect(withTenant(self,tx=>perf.ownPerformanceWorkStatusesTx(tx,{...self,tenantId:randomUUID()}))).rejects.toThrow();
 });
 it('omits actual foreign-company reviews even where the current admin could otherwise read that company',async()=>{
  const [foreign]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Foreign Company'}).returning();const [foreignDepartment]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:foreign.id,name:'Fictional Foreign Department'}).returning({id:schema.department.id});const employee=await hireEmployee(a,{person:{fullName:'PRIVATE_FOREIGN_PERSON',primaryEmail:randomUUID()+'@example.test'},companyId:foreign.id,departmentId:foreignDepartment.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});const cycle=await perf.createCycle(a,{name:'PRIVATE_FOREIGN_CYCLE',companyId:foreign.id,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await perf.openCycle(a,cycle);
  const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycle.cycleId),eq(schema.performanceReview.employmentId,employee.employmentId)));expect(review).toBeTruthy();const result=await read();expect(result.rows.some(row=>row.reviewId===review.id)).toBe(false);expect(JSON.stringify(result)).not.toContain('PRIVATE_FOREIGN');expect((await read(a)).rows).toEqual([]);
 });
 it('rechecks actual participation removal rather than falling back to the legacy shared header',async()=>{
  const [part]=await owner.db.select().from(schema.assessmentParticipationSnapshot).where(and(eq(schema.assessmentParticipationSnapshot.cycleId,cycleId),eq(schema.assessmentParticipationSnapshot.employmentId,subject.employmentId)));const config=await perf.getOnehrCycle(a,cycleId);await perf.setAssessmentParticipation(a,cycleId,config!.revision,subject.employmentId,part.revision,'remove');
  expect((await read()).rows.filter(row=>row.reviewId===reviewId)).toEqual([]);
 });
 it('rechecks module/login and Assistant revocation in the mounted module-read owner',async()=>{
  const view=await withTenant(self,tx=>createModuleAgentReaders(self,tx,()=>true).moduleWork('performance'));expect((view.data as Awaited<ReturnType<typeof read>>).rows.some(row=>row.reviewId===reviewId)).toBe(true);
  await revokeAssistant(a,{appUserId:self.userId!});await expect(withTenant(self,tx=>createModuleAgentReaders(self,tx,()=>true).moduleWork('performance'))).rejects.toThrow();
  await setModule(base.tenantId,'performance','disabled');await expect(read()).rejects.toThrow();await setModule(base.tenantId,'performance','active');await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,self.userId!));await expect(read()).rejects.toThrow();
 });
 it('retains actual supplied-transaction visibility and reports truncation across the combined union',async()=>{
  await expect(withTenant(self,async tx=>{await perf.saveOnehrPlanTx(tx,self,reviewId,null,{career:{aspiration:'Fictional source read',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[]});const inTx=await perf.ownPerformanceWorkStatusesTx(tx,self,1);expect(inTx.rows).toHaveLength(1);expect(inTx.truncated).toBe(true);throw Error('fictional read fixture rollback');})).rejects.toThrow('fictional read fixture rollback');expect((await read()).rows.filter(row=>row.artifact==='plan')).toEqual([]);await expect(read(self,26)).rejects.toThrow();
 });
});
