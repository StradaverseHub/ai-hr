/** Actual app-role custody and current native-event proof; executed only in hosted focused checks. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {grantAssistant} from '../core/assistant-grant';
import {createOffboardingCase,tickStep,setOutcome,getCase,updateCase,undoStep,undoStepTx} from '../packs/lifecycle/service';
import {offboardingStepUndoReviews as reviews} from '../core/assistant-actions/offboarding-step-undo-review-store';
import {readOffboardingStepUndoChoices} from '../core/assistant-actions/offboarding-step-undo-source';
import {OffboardingStepUndo as C} from '../lib/assistant-actions/offboarding-step-undo-contract';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {z} from 'zod';
let b:Base,ctx:SessionContext,human:z.infer<typeof C.Human>;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-offboarding-undo-key-123456789');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');
 const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'manager'});await grantAssistant(adminCtx(b),{appUserId:userId});
 ctx={tenantId:b.tenantId,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 const c=await createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'Fictional undo subject',employeeNo:'U-'+randomUUID().slice(0,8),resignationDate:'2026-10-01',lastWorkingDay:'2026-10-31'});
 human={caseId:c.id,caseNumber:c.number,stepKey:'resign_submit',reason:null,confirmUndo:true,acceptCaseReopening:false};
 await tickStep(ctx,'offboarding',c.number,human.stepKey,{reference:'retained reference',notes:'retained notes'});
});
const prepare=async()=>{const result=await reviews.prepare(ctx,human);if(result.kind!=='prepared')throw Error('expected prepared');return result.review;};
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action:C.action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function counts(){const [r]=await owner.db.execute(sql`select (select count(*) from lc_case_step where case_id=${human.caseId}::uuid and done)::int steps,(select count(*) from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${human.caseId}::uuid and event_type='lifecycle-case.step-undone')::int events`);return r;}
async function finishCase(){await setOutcome(adminCtx(b),human.caseNumber,'accepted');const view=await getCase(adminCtx(b),'offboarding',human.caseNumber);for(const step of view.steps.filter(step=>step.applicability==='applicable'&&!step.done))await tickStep(adminCtx(b),'offboarding',human.caseNumber,step.key);expect((await getCase(adminCtx(b),'offboarding',human.caseNumber)).case.status).toBe('completed');}
describe('bounded offboarding undo custody',()=>{
 it('accepts an unlinked lifecycle manager, retains metadata, records exactly once and erases completed review plaintext',async()=>{
  const r=await prepare();expect(r.review.before).toMatchObject({done:true,reference:'retained reference',notes:'retained notes'});expect(await counts()).toEqual({steps:1,events:0});
  const result=await reviews.confirm(ctx,confirmation(r));expect(result.kind).toBe('completed');expect(await counts()).toEqual({steps:0,events:1});expect(await reviews.confirm(ctx,confirmation(r))).toEqual(result);
  const [step]=await owner.db.select().from(s.lcCaseStep).where(and(eq(s.lcCaseStep.caseId,human.caseId),eq(s.lcCaseStep.stepKey,human.stepKey)));expect(step).toMatchObject({done:false,doneBy:null,doneAt:null,reference:'retained reference',notes:'retained notes'});
  const [row]=await owner.db.execute(sql`select person_id,employment_id,lifecycle_case_id,state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);expect(row).toMatchObject({person_id:null,employment_id:null,lifecycle_case_id:human.caseId,state:'completed',bodies:0});
 });
 it('requires distinct human case-reopening consent and records the exact derived event pair',async()=>{
  await finishCase();await expect(prepare()).rejects.toThrow();human.acceptCaseReopening=true;const r=await prepare();expect(r.review.reopensCase).toBe(true);
  const result=await reviews.confirm(ctx,confirmation(r));if(result.kind!=='completed')throw Error('expected completed');expect(result.receipt.receipt.reopeningEventId).not.toBeNull();expect(result.receipt.receipt.reopeningEventId).not.toBe(result.receipt.receipt.stepEventId);
  const view=await getCase(adminCtx(b),'offboarding',human.caseNumber);expect(view.case.status).toBe('in_progress');expect(view.case.completedAt).toBeNull();expect(await reviews.reopen(ctx,r.actionId)).toEqual(result);
 });
 it.each(['case_date','step_state','definition'] as const)('refuses stale %s without another native effect',async change=>{
  const r=await prepare();if(change==='case_date')await updateCase(adminCtx(b),'offboarding',human.caseNumber,{lastWorkingDay:'2026-11-01'});else if(change==='step_state')await undoStep(ctx,'offboarding',human.caseNumber,human.stepKey);else await owner.db.insert(s.lcStepDef).values({tenantId:b.tenantId,kind:'offboarding',stepKey:'new_step',phase:0,label:'New step',ownerTeam:'HR',rule:'always',sort:99});
  const before=await counts();await expect(reviews.confirm(ctx,confirmation(r))).rejects.toThrow();expect(await counts()).toEqual(before);
 });
 it('refuses revoked staff before decrypting',async()=>{const r=await prepare();await owner.db.delete(s.lcStaff).where(eq(s.lcStaff.userId,ctx.userId!));const unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();await expect(reviews.confirm(ctx,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect(await counts()).toEqual({steps:1,events:0});});
 it('offers only done non-outcome steps to current company lifecycle managers and refuses stale agent/module carriers',async()=>{
  const choice=await readOffboardingStepUndoChoices(ctx,{caseNumber:human.caseNumber});expect(choice).toEqual({kind:'choices',cases:[{caseId:human.caseId,caseNumber:human.caseNumber,steps:[{key:'resign_submit',label:expect.any(String)}]}],truncated:false});
  await owner.db.update(s.lcStaff).set({level:'agent'}).where(eq(s.lcStaff.userId,ctx.userId!));expect(await readOffboardingStepUndoChoices(ctx,{caseNumber:human.caseNumber})).toEqual({kind:'unavailable'});await expect(prepare()).rejects.toThrow();await owner.db.update(s.lcStaff).set({level:'manager'}).where(eq(s.lcStaff.userId,ctx.userId!));await setModule(b.tenantId,'lifecycle',null);expect(await readOffboardingStepUndoChoices(ctx,{caseNumber:human.caseNumber})).toEqual({kind:'unavailable'});
 });
 it('refuses foreign company, mismatched case number and outcome-control nominations',async()=>{
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional foreign company',companyLabel:'F'}).returning({id:s.company.id});const c=await createOffboardingCase(adminCtx(b),{companyId:company.id,fullName:'Other fictional leaver',employeeNo:'U-OTHER',resignationDate:'2026-10-01'});
  await expect(reviews.prepare(ctx,{...human,caseId:c.id,caseNumber:c.number})).rejects.toThrow();await expect(reviews.prepare(ctx,{...human,caseNumber:c.number})).rejects.toThrow();await expect(reviews.prepare(ctx,{...human,stepKey:'resign_outcome'})).rejects.toThrow();
 });
 it('refuses SYSTEM, another login and substituted digest',async()=>{const r=await prepare();await expect(reviews.confirm({...ctx,userId:undefined},confirmation(r))).rejects.toThrow();await expect(reviews.confirm(adminCtx(b),confirmation(r))).rejects.toThrow();await expect(reviews.confirm(ctx,{...confirmation(r),reviewedDigest:'0'.repeat(64)})).rejects.toThrow();expect(await counts()).toEqual({steps:1,events:0});});
 it('expires and discards without changing native state',async()=>{const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second' where id=${r.actionId}::uuid`);expect((await reviews.reopen(ctx,r.actionId)).kind).toBe('retired');const next=await prepare();expect((await reviews.discard(ctx,{action:C.action,contractVersion:1,actionId:next.actionId})).kind).toBe('retired');expect(await counts()).toEqual({steps:1,events:0});});
 it('refuses recovery after redo and after a second undo with an identical logical row (ABA)',async()=>{
  const r=await prepare();await reviews.confirm(ctx,confirmation(r));const [first]=await owner.db.execute<{hash:string;version:string}>(sql`select encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') hash,a.xmin::text version from lc_case_step a where case_id=${human.caseId}::uuid and step_key=${human.stepKey}`);
  await tickStep(ctx,'offboarding',human.caseNumber,human.stepKey,{reference:'retained reference',notes:'retained notes'});await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();await undoStep(ctx,'offboarding',human.caseNumber,human.stepKey);
  const [second]=await owner.db.execute<{hash:string;version:string}>(sql`select encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') hash,a.xmin::text version from lc_case_step a where case_id=${human.caseId}::uuid and step_key=${human.stepKey}`);expect(second.hash).toBe(first.hash);expect(second.version).not.toBe(first.version);await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();
 });
 it('rejects an already committed native undo as proof from the current top transaction',async()=>{
  const r=await prepare(),native=await withTenant(ctx,tx=>undoStepTx(tx,ctx,'offboarding',human.caseNumber,human.stepKey));await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_offboarding_step_undo_review_complete(${r.actionId}::uuid,${r.reviewedDigest},${human.caseId}::uuid,${native.stepEventId}::uuid,null::uuid)`))).rejects.toThrow();const [row]=await owner.db.execute(sql`select state from app.assistant_own_leave_review where id=${r.actionId}::uuid`);expect(row).toMatchObject({state:'awaiting_confirmation'});
 });
 it('rolls back the native undo when the custody completion write refuses',async()=>{
  const r=await prepare();await expect(withTenant(ctx,async tx=>{const native=await undoStepTx(tx,ctx,'offboarding',human.caseNumber,human.stepKey);await tx.execute(sql`select app.assistant_offboarding_step_undo_review_complete(${r.actionId}::uuid,${'0'.repeat(64)},${human.caseId}::uuid,${native.stepEventId}::uuid,null::uuid)`);})).rejects.toThrow();expect(await counts()).toEqual({steps:1,events:0});
 });
});
