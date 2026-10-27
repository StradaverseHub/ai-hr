/** Authored UNRUN. Requires both coordinated Lifecycle source/shared-custody drafts. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiAllowance} from '../core/ai-management';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {createOnboardingCase,tickStep,undoStep,updateCase,cancelCase} from '../packs/lifecycle/service';
import {ONBOARDING_STEPS} from '../core/lifecycle-defaults';
import {prepareOwnLifecycleAcknowledgementSourceTx,confirmOwnLifecycleAcknowledgementSourceTx} from '../core/assistant-actions/own-lifecycle-acknowledgement-source';
import {prepareLifecycleAckReview,confirmLifecycleAckReview,reopenLifecycleAckReview,discardLifecycleAckReview,listLifecycleAckReviews} from '../core/assistant-actions/lifecycle-ack-review-store';
import {OWN_LIFECYCLE_ACKNOWLEDGEMENT_ACTION as action,type OwnLifecycleAcknowledgementHumanContent} from '../lib/assistant-actions/own-lifecycle-acknowledgement-contract';
import {LifecycleAckReviewConfirmation} from '../lib/assistant-actions/lifecycle-ack-review-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,number:string,human:OwnLifecycleAcknowledgementHumanContent;
const admin=()=>adminCtx(b);
async function readyCase(email:string,personId?:string,employmentId?:string){const c=await createOnboardingCase(admin(),{companyId:b.companyId,fullName:'Fictional equipment recipient',employeeNo:'F-'+randomUUID().slice(0,8),joinDate:todayInKualaLumpur(),laptopRequired:true,carparkRequired:false,newhireEmail:email,personId,employmentId});for(const step of ONBOARDING_STEPS.filter(s=>s.phase===0&&s.rule!=='carpark'))await tickStep(admin(),'onboarding',c.number,step.key);await tickStep(admin(),'onboarding',c.number,'laptop_dist');return c;}
const content=(caseId:string):OwnLifecycleAcknowledgementHumanContent=>({action,contractVersion:1,caseId,contactNumber:'012-345',serialNumber:'FIC-PRIVATE-SERIAL',accessories:'Human-entered mouse',pcType:'Laptop',hasMonitor:false,monitorSerial:null,receiptEmail:null,acknowledged:true});
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_lifecycle_ack_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)') is not null and to_regprocedure('app.lc_my_daa_custody_source(uuid)') is not null as ok`);expect(installed.ok,'Coordinated Lifecycle source and custody helpers must be installed.').toBe(true);});afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-lifecycle-review-key-123456789');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');const email=randomUUID()+'@fixture.test',[person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional prehire recipient',primaryEmail:email}).returning({id:s.person.id});const userId=await createAppUser(b.tenantId,person.id,'employee');await grantAssistant(admin(),{appUserId:userId});ctx={tenantId:b.tenantId,userId,personId:person.id,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};const c=await readyCase(email);number=c.number;human=content(c.id);});
const prepare=async(who=ctx,input:unknown=human)=>(await prepareLifecycleAckReview(who,input)).review;
const confirmation=(r:Awaited<ReturnType<typeof prepare>>)=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
const confirm=(r:Awaited<ReturnType<typeof prepare>>,who=ctx)=>confirmLifecycleAckReview(who,confirmation(r));
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.person_id,r.employment_id,r.company_id,r.lifecycle_case_id,r.lifecycle_case_person_id,r.lifecycle_submitted_event_id,r.state,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}
async function state(){return{cases:await owner.db.select().from(s.lcCase).where(eq(s.lcCase.tenantId,b.tenantId)).orderBy(s.lcCase.id),steps:await owner.db.select().from(s.lcCaseStep).where(eq(s.lcCaseStep.tenantId,b.tenantId)).orderBy(s.lcCaseStep.caseId,s.lcCaseStep.stepKey),history:await owner.db.select().from(s.lcHistory).where(eq(s.lcHistory.tenantId,b.tenantId)).orderBy(s.lcHistory.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
/** This fixed-purpose receipt remains available while general NULL-subject audit rows do not. */
async function assertExactSelfReceiptWithoutAudit(who:SessionContext,caseId:string,eventId:string){
 await withTenant(who,async tx=>{
  const [permission]=await tx.execute<{admin:boolean}>(sql`select app.is_admin() as admin`);
  expect(permission.admin).toBe(false);
  expect(await tx.select({id:s.domainEvent.id}).from(s.domainEvent).where(eq(s.domainEvent.id,eventId))).toEqual([]);
  const [row]=await tx.execute<{reference:{caseId:string;submittedEventId:string}|null}>(sql`select app.lc_my_daa_reference(${caseId}::uuid,${eventId}::uuid) as reference`);
  expect(row.reference).toMatchObject({caseId,submittedEventId:eventId});
 });
 const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,eventId));
 expect(event).toMatchObject({tenantId:who.tenantId,aggregateType:'lifecycle-case',aggregateId:caseId,eventType:'lifecycle-case.daa-submitted',actorType:'user',actorId:who.userId,subjectEmploymentId:null,payload:{action:'daa.submitted'}});
}
describe('failed-only Lifecycle acknowledgement custody fixture regressions',()=>{
it.each(['pause'] as const)('checks current %s before metadata/body decryption but leaves login-only discard available',async (kind:'grant'|'module'|'pause')=>{const r=await prepare();if(kind==='grant')await revokeAssistant(admin(),{appUserId:ctx.userId!});else if(kind==='module')await setModule(b.tenantId,'lifecycle','disabled');else await setAiAllowance({...admin(),grants:[{role:'hr_admin',companyId:null}]},{kind:'user',subjectId:ctx.userId!,enabled:false,dailyRequests:null,monthlyTokens:null});const before=await state(),unwrap=vi.spyOn(vault,'unwrapDek');unwrap.mockClear();await expect(confirm(r)).rejects.toThrow();await expect(reopenLifecycleAckReview(ctx,r.actionId)).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();const index=await listLifecycleAckReviews(ctx);expect(index.reviews.map(row=>row.actionId)).toEqual([r.actionId]);expect(JSON.stringify(index)).not.toMatch(/PRIVATE|caseId|caseNumber|contact|serial|employment|personId/);expect((await discardLifecycleAckReview(ctx,retirement(index.reviews[0]))).receipt.state).toBe('discarded');expect(unwrap).not.toHaveBeenCalled();expect(await state()).toEqual(before);});
it('uses shared admission/expiry and erases via the actual CURRENT case association added after preparation',async()=>{const rows=[];for(let n=0;n<5;n++)rows.push(await prepare());await expect(prepare()).rejects.toThrow();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '12 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${rows[0].actionId}::uuid`);await withTenant(ctx,tx=>tx.execute(sql`select app.assistant_own_leave_reviews_expire_own(1)`));expect(await custody(rows[0].actionId)).toMatchObject({state:'expired',bodies:0,intent_digest:null,reviewed_digest:null});const h=await hireEmployee(admin(),{person:{fullName:'Fictional later-linked case subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});// Adversarial physical association witness, NOT a supported native post-creation linking workflow.
// The legacy API creates links only at case creation; PDPA must still capture an actual current
// association arriving after review. Use real canonical hire IDs and only this exact tenant/case.
const linked=await owner.db.update(s.lcCase).set({personId:h.personId,employmentId:h.employmentId}).where(and(eq(s.lcCase.tenantId,b.tenantId),eq(s.lcCase.id,human.caseId))).returning({id:s.lcCase.id});expect(linked).toEqual([{id:human.caseId}]);const unwrap=vi.spyOn(vault,'unwrapDek');unwrap.mockClear();await expect(reopenLifecycleAckReview(ctx,rows[1].actionId)).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();await erasePersonPii(admin(),{subjectEmploymentId:h.employmentId,scope:'contact',requestRef:'FICTIONAL-CURRENT-LIFECYCLE-LINK',reason:'Fictional current native case association erasure'});for(const r of rows)expect(await custody(r.actionId)).toMatchObject({bodies:0,intent_digest:null,reviewed_digest:null});const audit=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'pii.erased'));expect(audit).toHaveLength(1);expect((audit[0].payload as {erasedFields:string[]}).erasedFields).toContain('assistantPreparedReviews');});
});
