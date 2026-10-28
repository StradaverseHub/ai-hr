/** Authored UNRUN: actual OneHR human share/conversation/acknowledgement owners. Fictional career
 * words and goals are human fixture inputs, never generated facts, ratings or promotion decisions. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {OwnOnehrPlanAcknowledgementIntent} from '../lib/assistant-actions/own-onehr-plan-acknowledgement-contract';
import {prepareOwnOnehrPlanAcknowledgementTx,confirmOwnOnehrPlanAcknowledgementTx,reopenOwnOnehrPlanAcknowledgementEventTx} from '../core/assistant-actions/own-onehr-plan-acknowledgement-source';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'performance','active');await setModule(base.tenantId,'assistant','active');});
async function fixture(closed=true){
 const admin=adminCtx(base),year=Number(todayInKualaLumpur().slice(0,4)),hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 const employee=await hire('Fictional Plan Owner'),manager=await hire('Fictional Plan Manager'),userId=await createAppUser(base.tenantId,employee.personId,'employee'),managerId=await createAppUser(base.tenantId,manager.personId,'manager');
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'12',name:'Fictional Grade 12'}).returning({id:schema.jobGrade.id});for(const person of [employee,manager])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,person.employmentId));
 await setReportingLine(admin,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});await grantAssistant(admin,{appUserId:userId});await grantAssistant(admin,{appUserId:managerId});
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)},managerCtx:SessionContext={tenantId:base.tenantId,userId:managerId,personId:manager.personId,roles:['manager'],entitlements:harnessSnapshot(base.tenantId)};
 const {cycleId}=await perf.createCycle(admin,{name:'Fictional OneHR Annual',companyId:base.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await perf.configureOnehrCycle(admin,cycleId,null,defaultPolicy(framework));await perf.openCycle(admin,{cycleId});
 const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,employee.employmentId))),goalId=randomUUID();
 await perf.saveOnehrPlan(ctx,review.id,null,{career:{aspiration:'Fictional facilitation development',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:goalId,area:'Fictional facilitation',dueOn:'',onJob:'Human fixture workshop',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
 let [plan]=await owner.db.select().from(schema.onehrPlan).where(and(eq(schema.onehrPlan.employmentId,employee.employmentId),eq(schema.onehrPlan.planYear,year+1)));
 if(closed){await perf.reviewOnehrPlan(managerCtx,plan.id,plan.revision,'Agreed','Fictional recorded career conversation',true,undefined,todayInKualaLumpur());[plan]=await owner.db.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.id,plan.id));}
 return {ctx,managerCtx,admin,cycleId,reviewId:review.id,employmentId:employee.employmentId,goalId,intent:{version:1 as const,planId:plan.id,acknowledge:true as const}};
}
const prepare=(a:Awaited<ReturnType<typeof fixture>>)=>withTenant(a.ctx,tx=>prepareOwnOnehrPlanAcknowledgementTx(tx,a.ctx,a.intent));
const confirm=(a:Awaited<ReturnType<typeof fixture>>,digest:string)=>withTenant(a.ctx,tx=>confirmOwnOnehrPlanAcknowledgementTx(tx,a.ctx,a.intent,digest));
async function state(a:Awaited<ReturnType<typeof fixture>>){const [plan]=await owner.db.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.id,a.intent.planId));const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,a.intent.planId),eq(schema.domainEvent.eventType,'onehr.plan-acknowledged')));return {plan,events};}
describe('own OneHR plan acknowledgement source',()=>{
 it('accepts only an explicit acknowledgement reference, never plan text, a rating or promotion decision',()=>{
  const input={version:1,planId:randomUUID(),acknowledge:true};expect(OwnOnehrPlanAcknowledgementIntent.safeParse(input).success).toBe(true);for(const field of ['rating','career','conversation','promotion','actor','expectedRevision'])expect(OwnOnehrPlanAcknowledgementIntent.safeParse({...input,[field]:'posted'}).success).toBe(false);expect(OwnOnehrPlanAcknowledgementIntent.safeParse({...input,acknowledge:false}).success).toBe(false);
 });
 it('preserves ordinary UI void/empty payload/null subject and extends only reviewed canonical events',async()=>{
  const a=await fixture(),before=await state(a);expect(await perf.acknowledgeOnehrPlan(a.ctx,a.intent.planId,before.plan.revision)).toBeUndefined();const after=await state(a);expect(after.events).toHaveLength(1);expect(after.events[0].payload).toEqual({});expect(after.events[0].subjectEmploymentId).toBeNull();expect(after.plan.revision).toBe(before.plan.revision+1);expect(after.plan.acknowledgedAt).not.toBeNull();await expect(prepare(a)).rejects.toThrow();await expect(withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,{employmentId:a.employmentId,eventId:after.events[0].id}))).rejects.toThrow();
 });
 it('uses exact native revision/time metadata, preserves narrative/goals and reopens without another effect',async()=>{
  const a=await fixture(),before=await state(a),review=await prepare(a);expect(review.engine).toBe('onehr_plan');expect(JSON.stringify(review)).not.toMatch(/Human fixture workshop|Fictional recorded career conversation|aspiration/);const receipt=await confirm(a,review.reviewDigest),after=await state(a);expect(after.events).toHaveLength(1);expect(after.events[0].id).toBe(receipt.eventId);expect(after.events[0].subjectEmploymentId).toBe(a.employmentId);expect(after.events[0].payload).toEqual({version:1,planRevision:after.plan.revision,acknowledgedAt:after.plan.acknowledgedAt!.toISOString()});expect(after.plan.career).toEqual(before.plan.career);expect(after.plan.goals).toEqual(before.plan.goals);expect(after.plan.conversation).toBe(before.plan.conversation);expect(after.plan.managerComment).toBe(before.plan.managerComment);
  const reference={employmentId:a.employmentId,eventId:receipt.eventId};expect(await withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await state(a)).toEqual(after);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(after);
 });
 it('refuses an actually shared plan and a manager attempting the employee acknowledgement',async()=>{
  const a=await fixture(false);await expect(prepare(a)).rejects.toThrow();await perf.reviewOnehrPlan(a.managerCtx,a.intent.planId,(await state(a)).plan.revision,'Agreed','Fictional recorded career conversation',true);await expect(withTenant(a.managerCtx,tx=>prepareOwnOnehrPlanAcknowledgementTx(tx,a.managerCtx,a.intent))).rejects.toThrow();expect((await state(a)).events).toHaveLength(0);
 });
 it('refuses a visible manager target before attempting its held row lock',async()=>{
  const a=await fixture(),before=await state(a);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
  const held=withTenant(a.admin,async tx=>{await tx.select({id:schema.onehrPlan.id}).from(schema.onehrPlan).where(eq(schema.onehrPlan.id,a.intent.planId)).for('update');entered();await resume;});
  try{await started;await withTenant(a.managerCtx,async tx=>{
   await expect(prepareOwnOnehrPlanAcknowledgementTx(tx,a.managerCtx,a.intent)).rejects.toThrow();
   // A mistaken NOWAIT on the held subordinate would abort this real transaction (25P02).
   // A successful probe demonstrates the own-only refusal preceded that SQL lock attempt.
   const [probe]=await tx.execute<{ok:number}>(sql`select 1::integer as ok`);expect(probe.ok).toBe(1);
  });expect(await state(a)).toEqual(before);}finally{release();await held;}
 });
 it('refuses canonical conversation drift, Assistant revocation and module revocation before effects',async()=>{
  const a=await fixture(),review=await prepare(a);await perf.reviewOnehrPlan(a.managerCtx,a.intent.planId,(await state(a)).plan.revision,'Agreed','Different fictional human conversation',true);const before=await state(a);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();const fresh=await prepare(a);await revokeAssistant(a.admin,{appUserId:a.ctx.userId!});await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();await grantAssistant(a.admin,{appUserId:a.ctx.userId!});await setModule(base.tenantId,'performance','disabled');await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);
 });
 it('rolls back native plan and event when enclosing custody fails, then permits the original retry',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state(a);await expect(withTenant(a.ctx,async tx=>{await confirmOwnOnehrPlanAcknowledgementTx(tx,a.ctx,a.intent,review.reviewDigest);throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state(a)).toEqual(before);await confirm(a,review.reviewDigest);expect((await state(a)).events).toHaveLength(1);
 });
 it('commits once across competing direct confirmations and refuses a later changed native revision',async()=>{
  const a=await fixture(),review=await prepare(a),results=await Promise.allSettled([confirm(a,review.reviewDigest),confirm(a,review.reviewDigest)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);const receipt=results.find(row=>row.status==='fulfilled');if(!receipt||receipt.status!=='fulfilled')throw Error('Expected one native receipt.');await perf.updateOnehrGoalProgress(a.ctx,a.intent.planId,receipt.value.planRevision,a.goalId,'in_progress','Fictional human progress');await expect(withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,{employmentId:a.employmentId,eventId:receipt.value.eventId}))).rejects.toThrow();expect((await state(a)).events).toHaveLength(1);
 });
 it('refuses cross-actor/subject/native-payload tampering rather than borrowing authority',async()=>{
  const a=await fixture(),receipt=await confirm(a,(await prepare(a)).reviewDigest);await expect(withTenant(a.managerCtx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.managerCtx,{employmentId:a.employmentId,eventId:receipt.eventId}))).rejects.toThrow();await expect(withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,{employmentId:randomUUID(),eventId:receipt.eventId}))).rejects.toThrow();await expect(withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,{employmentId:a.employmentId,eventId:receipt.eventId,planRevision:receipt.planRevision}))).rejects.toThrow();
  const [forged]=await owner.db.insert(schema.domainEvent).values({tenantId:base.tenantId,aggregateType:'onehr',aggregateId:a.intent.planId,eventType:'onehr.plan-acknowledged',actorType:'user',actorId:a.ctx.userId!,subjectEmploymentId:a.employmentId,payload:{version:1,planRevision:receipt.planRevision,acknowledgedAt:receipt.acknowledgedAt,hiddenPanel:'forged'}}).returning({id:schema.domainEvent.id});await expect(withTenant(a.ctx,tx=>reopenOwnOnehrPlanAcknowledgementEventTx(tx,a.ctx,{employmentId:a.employmentId,eventId:forged.id}))).rejects.toThrow();
 });
 it('captures the selected plan before awaiting and fails fast on an actual held source row',async()=>{
  const a=await fixture(),original=a.intent.planId,review=await withTenant(a.ctx,async tx=>{const pending=prepareOwnOnehrPlanAcknowledgementTx(tx,a.ctx,a.intent);a.intent.planId=randomUUID();return pending;});expect(review.planId).toBe(original);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();a.intent.planId=original;
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;}),before=await state(a),held=withTenant(a.admin,async tx=>{await tx.select({id:schema.onehrPlan.id}).from(schema.onehrPlan).where(eq(schema.onehrPlan.id,original)).for('update');entered();await resume;});try{await started;await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);}finally{release();await held;}await confirm(a,review.reviewDigest);expect((await state(a)).events).toHaveLength(1);
 });
});
