/** Real app-role transaction/custody cases; no local execution. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {grantAssistant} from '../core/assistant-grant';
import {createOffboardingCase,tickStep,tickStepTx,setOutcome,getCase,updateCase,undoStep} from '../packs/lifecycle/service';
import {offboardingStepReviews as reviews} from '../core/assistant-actions/offboarding-step-completion-review-store';
import {OffboardingStepCompletion as C} from '../lib/assistant-actions/offboarding-step-completion-contract';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,human:{caseId:string;caseNumber:string;stepKey:string;reference:null;notes:null;confirmStepCompletion:true;acceptDerivedCaseCompletion:boolean};
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-offboarding-step-key-123456789');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');
 const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'agent'});await grantAssistant(adminCtx(b),{appUserId:userId});
 ctx={tenantId:b.tenantId,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 const c=await createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'Fictional leaver',employeeNo:'F-'+randomUUID().slice(0,8),resignationDate:'2026-10-01',lastWorkingDay:'2026-10-31'});
 human={caseId:c.id,caseNumber:c.number,stepKey:'resign_submit',reference:null,notes:null,confirmStepCompletion:true,acceptDerivedCaseCompletion:false};
});
const prepare=async()=>{const result=await reviews.prepare(ctx,human);if(result.kind!=='prepared')throw Error('expected prepared');return result.review;};
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action:C.action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function counts(){const [r]=await owner.db.execute(sql`select (select count(*) from lc_case_step where case_id=${human.caseId}::uuid and done)::int steps,(select count(*) from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${human.caseId}::uuid and event_type='lifecycle-case.step-done')::int events`);return r;}
describe('offboarding step human custody',()=>{
 it('accepts a real unlinked USER with company lifecycle staff authority, records one native event, retires plaintext and replays once',async()=>{
  const r=await prepare();expect(r.review.before.done).toBe(false);expect(await counts()).toEqual({steps:0,events:0});
  const result=await reviews.confirm(ctx,confirmation(r));expect(result.kind).toBe('completed');expect(await counts()).toEqual({steps:1,events:1});
  expect(await reviews.confirm(ctx,confirmation(r))).toEqual(result);
  const [row]=await owner.db.execute(sql`select person_id,employment_id,lifecycle_case_id,state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);
  expect(row).toMatchObject({person_id:null,employment_id:null,lifecycle_case_id:human.caseId,state:'completed',bodies:0});
 });
 it('shows and records the optional derived case completion with two distinct native events',async()=>{
  await setOutcome(adminCtx(b),human.caseNumber,'accepted');const view=await getCase(adminCtx(b),'offboarding',human.caseNumber);const remaining=view.steps.filter(step=>step.applicability==='applicable'&&!step.done);
  for(const step of remaining.slice(0,-1))await tickStep(adminCtx(b),'offboarding',human.caseNumber,step.key);
  human.stepKey=remaining.at(-1)!.key;await expect(prepare()).rejects.toThrow();human.acceptDerivedCaseCompletion=true;
  const r=await prepare();expect(r.review.after.caseStatus).toBe('completed');const result=await reviews.confirm(ctx,confirmation(r));if(result.kind!=='completed')throw Error('expected completed');
  expect(result.receipt.receipt.completionEventId).not.toBeNull();expect(result.receipt.receipt.completionEventId).not.toBe(result.receipt.receipt.stepEventId);
 });
 it.each(['case_date','step_state','definition'] as const)('refuses stale %s source without side effects',async change=>{
  const r=await prepare();if(change==='case_date')await updateCase(adminCtx(b),'offboarding',human.caseNumber,{lastWorkingDay:'2026-11-01'});
  else if(change==='step_state')await tickStep(adminCtx(b),'offboarding',human.caseNumber,'resign_submit');
  else await owner.db.insert(s.lcStepDef).values({tenantId:b.tenantId,kind:'offboarding',stepKey:'new_step',phase:0,label:'New step',ownerTeam:'HR',rule:'always',sort:99});
  const before=await counts();await expect(reviews.confirm(ctx,confirmation(r))).rejects.toThrow();expect(await counts()).toEqual(before);
 });
 it('refuses revoked staff before decrypting the body',async()=>{
  const r=await prepare();await owner.db.delete(s.lcStaff).where(eq(s.lcStaff.userId,ctx.userId!));const unwrap=vi.spyOn(vault,'unwrapDek');
  await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();await expect(reviews.confirm(ctx,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect(await counts()).toEqual({steps:0,events:0});
 });
 it('refuses another company and outcome-control substitutions',async()=>{
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional foreign company',companyLabel:'F'}).returning({id:s.company.id});
  const c=await createOffboardingCase(adminCtx(b),{companyId:company.id,fullName:'Other fictional leaver',employeeNo:'F-OTHER',resignationDate:'2026-10-01'});
  await expect(reviews.prepare(ctx,{...human,caseId:c.id,caseNumber:c.number})).rejects.toThrow();await expect(reviews.prepare(ctx,{...human,stepKey:'resign_outcome'})).rejects.toThrow();
 });
 it('refuses actor substitution, SYSTEM and digest tampering without writing',async()=>{
  const r=await prepare();await expect(reviews.confirm({...ctx,userId:undefined},confirmation(r))).rejects.toThrow();
  await expect(reviews.confirm(adminCtx(b),confirmation(r))).rejects.toThrow();await expect(reviews.confirm(ctx,{...confirmation(r),reviewedDigest:'0'.repeat(64)})).rejects.toThrow();expect(await counts()).toEqual({steps:0,events:0});
 });
 it('expires and discards pending reviews with no native event',async()=>{
  const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second' where id=${r.actionId}::uuid`);
  expect((await reviews.reopen(ctx,r.actionId)).kind).toBe('retired');expect(await counts()).toEqual({steps:0,events:0});
  const next=await prepare();expect((await reviews.discard(ctx,{action:C.action,contractVersion:1,actionId:next.actionId})).kind).toBe('retired');expect(await counts()).toEqual({steps:0,events:0});
 });
 it('refuses source reconciliation after an independently undone native step',async()=>{
  const r=await prepare();await reviews.confirm(ctx,confirmation(r));await undoStep(adminCtx(b),'offboarding',human.caseNumber,human.stepKey,'Fixture correction');await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();
 });
 it('rejects a previously committed step event as proof from the current transaction',async()=>{
  const r=await prepare(),native=await withTenant(ctx,tx=>tickStepTx(tx,ctx,'offboarding',human.caseNumber,human.stepKey));
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_offboarding_step_review_complete(${r.actionId}::uuid,${r.reviewedDigest},${human.caseId}::uuid,${native.stepEventId}::uuid,null::uuid)`))).rejects.toThrow();
  const [row]=await owner.db.execute(sql`select state from app.assistant_own_leave_review where id=${r.actionId}::uuid`);expect(row).toMatchObject({state:'awaiting_confirmation'});
 });

});
