/** Authored UNRUN. Two genuine generations use actual public canonical commands, independent
 * evaluations and bounded promotions. Requires normally coordinated installed migrations; never
 * forges a candidate/receipt/PASS, installs schema inline or activates a model/provider. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setReportingLine} from '../core/workforce-commands';
import {grantAssistant} from '../core/assistant-grant';
import {erasePersonPii} from '../core/pdpa';
import {prepareOrgActionReview,confirmOrgActionReview,reopenOrgActionReview} from '../core/assistant-actions/org-action-review-store';
import * as nativeReaders from '../core/assistant-actions/completed-outcome-readers';
import {recordOwnNativeOutcomeAssociation,reopenOwnNativeOutcomeAssociation} from '../core/module-native-outcomes';
import {createCanonicalSpecialistCandidate,evaluateCanonicalSpecialistCandidate,promoteCanonicalSpecialistCandidate,runGovernedSpecialistJob} from '../core/module-agent-releases';
import {MODULE_CATALOG} from '../packs/catalog';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,admin:SessionContext,author:SessionContext,reviewer:SessionContext,second:SessionContext,promoter:SessionContext;
let authorEmployment:string,managerA:{employmentId:string;personId:string},managerB:{employmentId:string;personId:string};
const action='org.reporting.change' as const;
beforeAll(async()=>{
 await migrateTestDb();
 const [installed]=await owner.db.execute<{ready:boolean}>(sql`select to_regprocedure('app.agent_candidate_native_signals_current(uuid)') is not null and to_regprocedure('app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)') is not null and exists(select 1 from pg_constraint where conrelid='public.ai_agent_candidate'::regclass and contype='c' and pg_get_constraintdef(oid) like '%canonical_followup_v1%') as ready`);
 expect(installed.ready,'Install coordinated diagnostic/native outcome migrations through the normal migration owner first.').toBe(true);
});
afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur().slice(0,4)+'-01-01'});
async function actor(name:string){
 const hired=await hire(name),userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
 return{hired,ctx:{...await entitledCtx(base),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext};
}
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-native-generations-key-123456789');await resetDb();base=await seedBase();
 for(const module of MODULE_CATALOG.filter(row=>!row.isCore))await setModule(base.tenantId,module.code,'active');
 admin={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 const first=await actor('Fictional native generation author'),one=await actor('Fictional independent reviewer one'),two=await actor('Fictional independent reviewer two');
 author=first.ctx;reviewer=one.ctx;second=two.ctx;authorEmployment=first.hired.employmentId;
 // S8 (WP11): the approver is independent of the author and of both evaluators.
 promoter=(await actor('Fictional independent promoter')).ctx;
 managerA=await hire('Fictional original functional manager');managerB=await hire('Fictional replacement functional manager');
 // Genuine nonempty Org evidence for author AND both independent evaluators. A functional
 // manager is recorded, leaving the real missing-administrative-manager diagnostic meaningful.
 for(const id of [first.hired.employmentId,one.hired.employmentId,two.hired.employmentId])await setReportingLine(admin,{subordinateEmploymentId:id,managerEmploymentId:managerA.employmentId,lineType:'functional',validFrom:todayInKualaLumpur()});
});
async function counts(){const [row]=await owner.db.execute<{jobs:number;candidates:number;promotions:number;used:number;rollbacks:number;links:number;captures:number}>(sql`select
 (select count(*)::int from public.ai_agent_job_receipt where tenant_id=${base.tenantId}::uuid) as jobs,
 (select count(*)::int from public.ai_agent_candidate where tenant_id=${base.tenantId}::uuid) as candidates,
 (select count(*)::int from public.ai_agent_promotion where tenant_id=${base.tenantId}::uuid) as promotions,
 coalesce((select sum(used_jobs)::int from public.ai_agent_promotion where tenant_id=${base.tenantId}::uuid),0) as used,
 (select count(*)::int from public.ai_agent_rollback where tenant_id=${base.tenantId}::uuid) as rollbacks,
 (select count(*)::int from public.ai_native_outcome_association where tenant_id=${base.tenantId}::uuid) as links,
 (select count(*)::int from app.native_outcome_source_capture where tenant_id=${base.tenantId}::uuid) as captures`);return row;}
async function reportingState(){return{
 lines:await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.tenantId,base.tenantId)).orderBy(s.reportingLine.id),
 events:await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.tenantId}=${base.tenantId}::uuid and ${s.domainEvent.eventType} like 'reporting-line.%'`).orderBy(s.domainEvent.id),
};}
async function nativeChange(managerEmploymentId:string){
 const prepared=await prepareOrgActionReview(author,{action,contractVersion:1,subordinateEmploymentId:authorEmployment,managerEmploymentId,lineType:'functional',validFrom:todayInKualaLumpur(),confirmReportingChange:true});
 const review=prepared.review,confirmation={action,contractVersion:1 as const,actionId:review.actionId,reviewedDigest:review.reviewedDigest};
 const done=await confirmOrgActionReview(author,confirmation);if(done.kind!=='completed')throw Error('Expected actual canonical reporting completion.');
 return{review,confirmation,done};
}
async function link(jobId:string,native:Awaited<ReturnType<typeof nativeChange>>){
 const input={jobId,reference:{source:'review' as const,action,actionId:native.review.actionId},nonce:randomUUID(),consented:true as const};
 const association=await recordOwnNativeOutcomeAssociation(author,input);return{association,input};
}
async function candidate(version:number,associationId:string){return createCanonicalSpecialistCandidate(author,{module:'org',version,playbook:'canonical_followup_v1',nativeSignalIds:[associationId]});}
async function evaluateAndPromote(value:Awaited<ReturnType<typeof candidate>>,maxJobs:number){
 const one=await evaluateCanonicalSpecialistCandidate(reviewer,value.candidateId),two=await evaluateCanonicalSpecialistCandidate(second,value.candidateId);
 for(const report of [one,two])expect(report).toMatchObject({module:'org',state:'complete',nativeEvidence:'present',securityFailures:0,qualityFailures:0});
 expect(one.evaluationId).not.toBe(two.evaluationId);
 return promoteCanonicalSpecialistCandidate(promoter,{candidateId:value.candidateId,maxJobs,hours:1});
}
async function firstGeneration(maxJobs=1){
 const origin=await runGovernedSpecialistJob(author,{module:'org'},{nonce:randomUUID()});expect(origin.mode).toBe('baseline');
 const firstNative=await nativeChange(managerB.employmentId),firstLink=await link(origin.jobId,firstNative);
 const firstCandidate=await candidate(1,firstLink.association.associationId),firstPromotion=await evaluateAndPromote(firstCandidate,maxJobs),nonce=randomUUID();
 const firstJob=await runGovernedSpecialistJob(author,{module:'org'},{nonce});expect(firstJob.mode).toBe('promoted');expect(firstJob.effects).toEqual([]);
 const secondNative=await nativeChange(managerA.employmentId),secondLink=await link(firstJob.jobId,secondNative);
 return{origin,firstNative,firstLink,firstCandidate,firstPromotion,firstJob,secondNative,secondLink};
}
async function twoGenerations(){
 const first=await firstGeneration(),secondCandidate=await candidate(2,first.secondLink.association.associationId),secondPromotion=await evaluateAndPromote(secondCandidate,2),nonce=randomUUID();
 const secondJob=await runGovernedSpecialistJob(author,{module:'org'},{nonce});expect(secondJob.mode).toBe('promoted');
 const [stored]=await owner.db.execute<{promotion_id:string}>(sql`select promotion_id from public.ai_agent_job_receipt where id=${secondJob.jobId}::uuid`);expect(stored.promotion_id).toBe(secondPromotion.promotionId);
 return{...first,secondCandidate,secondPromotion,secondJob,nonce};
}
describe('real native-backed specialist generations',()=>{
 it('links two canonical generations, independently evaluates each, and replays exact commands without another native change or permit',async()=>{
  const f=await twoGenerations(),before=await counts(),native=await reportingState();
  expect(f.secondCandidate.candidateDigest).not.toBe(f.firstCandidate.candidateDigest);
  expect(f.secondJob.specialist?.module).toBe('org');expect(f.secondJob.effects).toEqual([]);
  expect(f.secondLink.association).toMatchObject({module:'org',action,causalCredit:false,quality:'not_assessed'});
  expect(await recordOwnNativeOutcomeAssociation(author,f.secondLink.input)).toEqual(f.secondLink.association);
  expect(await reopenOwnNativeOutcomeAssociation(author,{associationId:f.secondLink.association.associationId})).toEqual(f.secondLink.association);
  expect(await confirmOrgActionReview(author,f.secondNative.confirmation)).toEqual(f.secondNative.done);
  expect(await runGovernedSpecialistJob(author,{module:'org'},{nonce:f.nonce})).toMatchObject({jobId:f.secondJob.jobId,replayed:true,mode:'promoted'});
  expect(await counts()).toEqual(before);expect(before).toMatchObject({jobs:3,candidates:2,promotions:2,used:2,rollbacks:0,links:2,captures:2});
  expect(await reportingState()).toEqual(native);
 },90_000);
 it('performs the second-generation canonical check before held-custody refusal, never retires the valid promotion, and succeeds after release',async()=>{
  const f=await firstGeneration(2),before=await counts(),native=await reportingState(),nonce=randomUUID(),completedSources:string[]=[];
  const original=nativeReaders.readCompletedNativeOutcomeTx,read=vi.spyOn(nativeReaders,'readCompletedNativeOutcomeTx').mockImplementation(async(...args)=>{const result=await original(...args);completedSources.push(result.evidence.sourceId);return result;});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  // Holder intentionally takes NO Access/source lock. Only actual metadata custody conflicts,
  // so a release/signal/config refusal cannot falsely stand in for the transitive native ordering.
  const held=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'native-outcome:v1:'+base.tenantId+':'+author.userId},0))`);entered();await resume;});
  try{await Promise.race([started,held.then(()=>{throw Error('Custody holder ended before the test interval.');})]);
   await expect(candidate(2,f.secondLink.association.associationId)).rejects.toThrow();
   expect(completedSources).toContain(f.secondNative.review.actionId);
   await expect(runGovernedSpecialistJob(author,{module:'org'},{nonce})).rejects.toThrow();
   expect(await counts()).toEqual(before);expect(await reportingState()).toEqual(native);
  }finally{release();await held;read.mockRestore();}
  const next=await candidate(2,f.secondLink.association.associationId);expect(next.state).toBe('unevaluated');
  const job=await runGovernedSpecialistJob(author,{module:'org'},{nonce});expect(job.mode).toBe('promoted');
  expect(await counts()).toEqual({...before,candidates:before.candidates+1,jobs:before.jobs+1,used:before.used+1});
  expect(await reportingState()).toEqual(native);
 },90_000);
 it('invalidates retained native evidence after actual non-actor privacy erasure while leaving human completion and canonical reporting history intact',async()=>{
  const f=await twoGenerations(),before=await counts(),native=await reportingState();expect(managerA.personId).not.toBe(author.personId);
  await erasePersonPii(admin,{subjectEmploymentId:managerA.employmentId,scope:'contact',requestRef:'FICTIONAL-NATIVE-GENERATION-ERASURE',reason:'Fictional original manager privacy request'});
  expect(await reportingState()).toEqual(native);
  await expect(reopenOwnNativeOutcomeAssociation(author,{associationId:f.secondLink.association.associationId})).rejects.toThrow();
  expect(await reopenOrgActionReview(author,f.secondNative.review.actionId)).toEqual(f.secondNative.done);
  await expect(evaluateCanonicalSpecialistCandidate(reviewer,f.secondCandidate.candidateId)).rejects.toThrow();
  const fallback=await runGovernedSpecialistJob(author,{module:'org'},{nonce:randomUUID()});expect(fallback).toMatchObject({mode:'baseline',specialist:{coverage:'canonical_domain_guidance_only',requiresFreshNativeReview:true},effects:[]});
  const after=await counts();expect(after).toEqual({...before,jobs:before.jobs+1,rollbacks:before.rollbacks+1,links:0,captures:0});
  const [retirement]=await owner.db.execute<{reason:string}>(sql`select reason from public.ai_agent_rollback where promotion_id=${f.secondPromotion.promotionId}::uuid`);expect(retirement.reason).toBe('source_changed');
  expect(await reportingState()).toEqual(native);
 },90_000);
});
