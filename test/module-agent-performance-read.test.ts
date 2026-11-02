/** Authored UNRUN: actual modern/standard canonical reads in the caller transaction; no model. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createModuleAgentReaders} from '../core/module-agent-readers';
import {toolsFor} from '../core/assistant-tools';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import * as perf from '../packs/performance/service';
import * as standard from '../core/performance';
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
 it('classifies actual native framework identity independently of Setup View and refuses Standard fallback for OneHR',async()=>{
  const [before]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,reviewId));
  const events=await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,reviewId)).orderBy(schema.domainEvent.id);
  const skipped=await hireEmployee(a,{person:{fullName:'Fictional native department-tree reader',primaryEmail:`fictional-framework-${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const [lineManager]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(and(eq(schema.employment.tenantId,base.tenantId),eq(schema.employment.personId,manager.personId!)));await setReportingLine(a,{subordinateEmploymentId:lineManager.id,managerEmploymentId:skipped.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
  const unassigned={...self,userId:await createAppUser(base.tenantId,skipped.personId,'manager'),personId:skipped.personId,roles:['manager']};
  const [unassignedSource]=await withTenant(unassigned,tx=>tx.execute<{header:boolean;task:boolean}>(sql`select exists(select 1 from performance_review where id=${reviewId}::uuid) as header,app.onehr_review_task_view(${reviewId}::uuid,'self') or app.onehr_review_task_view(${reviewId}::uuid,'assigned') as task`));expect(unassignedSource).toEqual({header:true,task:false});expect(await perf.getOnehrReviewForPurpose(unassigned,reviewId,undefined)).toBeNull();
  for(const ctx of [self,manager,unassigned]){
   const [identity]=await withTenant(ctx,tx=>tx.execute<{setup:boolean;review:string;cycle:string;missing:string|null}>(sql`select app.onehr_setup_function_action(${base.companyId}::uuid,'view') as setup,app.performance_review_framework(${reviewId}::uuid) as review,app.performance_cycle_framework(${cycleId}::uuid) as cycle,app.performance_review_framework(${randomUUID()}::uuid) as missing`));expect(identity).toEqual({setup:false,review:'onehr',cycle:'onehr',missing:null});
   expect(await standard.reviewForViewer(ctx,reviewId)).toBeNull();await expect(withTenant(ctx,tx=>perf.assertStandardCycleTx(tx,cycleId))).rejects.toThrow(/performance and talent review/);
  }
  await expect(standard.submitSelfReview(self,{reviewId,selfRating:4})).rejects.toThrow(/performance and talent review/);
  await expect(standard.submitManagerReview(manager,{reviewId,managerRating:4,overallRating:4})).rejects.toThrow(/performance and talent review/);
  expect(await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,reviewId))).toEqual([before]);expect(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,reviewId)).orderBy(schema.domainEvent.id)).toEqual(events);
  const {cycleId:standardCycle}=await standard.createCycle(a,{name:'Fictional actual Standard source',companyId:base.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await standard.openCycle(a,{cycleId:standardCycle});
  const [nativeStandard]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,standardCycle),eq(schema.performanceReview.employmentId,subject.employmentId)));expect(nativeStandard).toBeDefined();
  expect((await standard.reviewForViewer(self,nativeStandard.id))?.id).toBe(nativeStandard.id);await standard.submitSelfReview(self,{reviewId:nativeStandard.id,selfRating:4});await standard.submitManagerReview(manager,{reviewId:nativeStandard.id,managerRating:4,overallRating:4});await standard.releaseCycle(a,{cycleId:standardCycle});
  const choices=await withTenant(self,tx=>perf.ownPerformanceAcknowledgementChoicesTx(tx,self));expect(choices.items.some(item=>item.sourceId===nativeStandard.id&&item.action==='performance.review.acknowledge')).toBe(true);expect(choices.items.some(item=>item.sourceId===reviewId&&item.action==='performance.review.acknowledge')).toBe(false);
  const statuses=(await read()).rows;expect(statuses.filter(row=>row.reviewId===reviewId)).toMatchObject([{framework:'onehr',artifact:'review'}]);expect(statuses.filter(row=>row.reviewId===nativeStandard.id)).toMatchObject([{framework:'standard',artifact:'review'}]);
  await expect(withTenant(self,tx=>tx.execute(sql`select app.financial_performance_cycle_kind(${base.tenantId}::uuid,${cycleId}::uuid)`))).rejects.toThrow(/permission denied/);
 });
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
 it('returns closed human review directions through the actual Assistant tool without effects, and rechecks revocation',async()=>{
  const tool=toolsFor(self).find(row=>row.spec.name==='my_module_work');if(!tool)throw Error('Missing canonical tool.');
  const before=await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id);
  const result=await tool.run(self,{module:'performance'});expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected current canonical result.');expect(result.humanActions).toEqual(moduleHumanActionHandoffs('performance'));
  expect(JSON.stringify(result.humanActions)).not.toMatch(/employmentId|personId|rating|reviewedDigest|eventId|confirmOwn/);
  expect(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id)).toEqual(before);
  await revokeAssistant(a,{appUserId:self.userId!});await expect(tool.run(self,{module:'performance'})).rejects.toThrow();
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
