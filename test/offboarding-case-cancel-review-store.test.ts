import {assertReviewBodyPendingParentContract} from './helpers/review-body-pending-parent-contract';
/** Authored UNRUN pending coordinator source review, mounting and exact-SHA hosted dispatch. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {withTenant} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {createOffboardingCase,reopenCase,cancelCase} from '../packs/lifecycle/service';
import {createOffboardingCaseCancelReviews} from '../core/assistant-actions/offboarding-case-cancel-review-store';
import {readOffboardingCaseCancelChoices} from '../core/assistant-actions/offboarding-case-cancel-source';
import {OffboardingCaseCancel as C} from '../lib/assistant-actions/offboarding-case-cancel-contract';
import {erasePersonPii} from '../core/pdpa';
import {revokeAssistant} from '../core/assistant-grant';
import {adminCtx,closeAll,migrateTestDb,owner,setModule,seedBase} from './harness';
import {caseCancelFixture,caseCancelSnapshot,type CaseCancelFixture} from './helpers/offboarding-case-cancel-db-fixture';
let f:CaseCancelFixture,reviews:ReturnType<typeof createOffboardingCaseCancelReviews>;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-case-cancel-review-key-12345');f=await caseCancelFixture();reviews=createOffboardingCaseCancelReviews();});
const prepare=async()=>{const r=await reviews.prepare(f.ctx,f.human);if(r.kind!=='prepared')throw Error('expected prepared');return r.review;};
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action:C.action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const privateRow=async(id:string)=>{const [row]=await owner.db.execute(sql`select state,intent_digest,reviewed_digest,offboarding_cancel_effect_commitment commitment,offboarding_cancel_case_version version,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where id=${id}::uuid`);return row;};
it('cancels exactly once for an unlinked lifecycle manager, preserves every related row/version and retires the private body/commitment',async()=>{
 const before=await caseCancelSnapshot(f),r=await prepare();expect(await privateRow(r.actionId)).toMatchObject({state:'awaiting_confirmation',commitment:expect.stringMatching(/^[a-f0-9]{64}$/),version:null,bodies:1});
 const result=await reviews.confirm(f.ctx,confirmation(r));expect(result.kind).toBe('completed');const after=await caseCancelSnapshot(f);expect(after.c).toEqual({...before.c,status:'cancelled',cancelReason:f.human.reason});expect(after.related).toEqual(before.related);expect(await reviews.confirm(f.ctx,confirmation(r))).toEqual(result);expect(await reviews.reopen(f.ctx,r.actionId)).toEqual(result);
 expect(await privateRow(r.actionId)).toMatchObject({state:'completed',commitment:null,version:expect.stringMatching(/^[0-9]+$/),bodies:0,intent_digest:null,reviewed_digest:null});expect(JSON.stringify(result)).not.toContain('effect_commitment');expect(JSON.stringify(result)).not.toContain(f.human.reason);
 if(result.kind!=='completed')throw Error('expected completed');const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,result.receipt.receipt.eventId));expect(event.payload).toEqual({action:'case.cancelled',number:f.number});
});
it('offers one minimal case only through current manager authority',async()=>{expect(await readOffboardingCaseCancelChoices(f.ctx,{caseNumber:f.number})).toEqual({kind:'choices',cases:[{caseId:f.caseId,caseNumber:f.number}],truncated:false});await owner.db.update(s.lcStaff).set({level:'agent'}).where(eq(s.lcStaff.userId,f.ctx.userId!));expect(await readOffboardingCaseCancelChoices(f.ctx,{caseNumber:f.number})).toEqual({kind:'unavailable'});await expect(prepare()).rejects.toThrow();});
it.each(['staff','role','person','assistant','module','pause','subject'] as const)('refuses stale %s before decrypting or invoking cancellation',async change=>{
 const r=await prepare();if(change==='staff')await owner.db.delete(s.lcStaff).where(eq(s.lcStaff.userId,f.ctx.userId!));else if(change==='role')await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,f.ctx.userId!));
 else if(change==='person'){const [p]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'New fictional link',primaryEmail:randomUUID()+'@fixture.invalid'}).returning({id:s.person.id});await owner.db.update(s.appUser).set({personId:p.id}).where(eq(s.appUser.id,f.ctx.userId!));}
 else if(change==='assistant')await revokeAssistant(adminCtx(f.b),{appUserId:f.ctx.userId!});else if(change==='module')await setModule(f.b.tenantId,'lifecycle',null);
 else if(change==='pause')await owner.db.insert(s.aiControlPolicy).values({tenantId:f.b.tenantId,kind:'feature',scopeKey:'feature:hr_assistant',featureId:'hr_assistant',enabled:false});
 else{const [p]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Changed case subject',primaryEmail:randomUUID()+'@fixture.invalid'}).returning({id:s.person.id});await owner.db.update(s.lcCase).set({personId:p.id}).where(eq(s.lcCase.id,f.caseId));}
 const before=await caseCancelSnapshot(f),unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.reopen(f.ctx,r.actionId)).rejects.toThrow();await expect(reviews.confirm(f.ctx,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect(await caseCancelSnapshot(f)).toEqual(before);
});
it('refuses a changed related source before the native case write',async()=>{const r=await prepare();await owner.db.update(s.itRequisitionItem).set({note:'New native work'}).where(eq(s.itRequisitionItem.requisitionId,f.reqId));const before=await caseCancelSnapshot(f);await expect(reviews.confirm(f.ctx,confirmation(r))).rejects.toThrow();expect(await caseCancelSnapshot(f)).toEqual(before);});
it('expires/discards pending content and clears its private commitment through shared state transitions',async()=>{
 const a=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '12 minutes',expires_at=now()-interval '1 minute' where id=${a.actionId}::uuid`);expect((await reviews.reopen(f.ctx,a.actionId)).kind).toBe('retired');expect(await privateRow(a.actionId)).toMatchObject({state:'expired',bodies:0,commitment:null});
 const b=await prepare();expect((await reviews.discard(f.ctx,{action:C.action,contractVersion:1,actionId:b.actionId})).kind).toBe('retired');expect(await privateRow(b.actionId)).toMatchObject({state:'discarded',bodies:0,commitment:null});
});
it('clears private prediction/body atomically through canonical subject erasure with real nullable-actor privacy binding',async()=>{
 f=await caseCancelFixture(true);reviews=createOffboardingCaseCancelReviews();const r=await prepare();expect(f.subject).not.toBeNull();await erasePersonPii(adminCtx(f.b),{subjectEmploymentId:f.subject!.employmentId,scope:'contact',requestRef:'FICTIONAL-CASE-CANCEL-ERASURE',reason:'Fictional subject request'});expect(await privateRow(r.actionId)).toMatchObject({state:'refused',bodies:0,commitment:null,intent_digest:null,reviewed_digest:null});
});
it('refuses SYSTEM, another login, foreign company, swapped number and posted composite effects',async()=>{
 const r=await prepare();await expect(reviews.confirm({...f.ctx,userId:undefined},confirmation(r))).rejects.toThrow();await expect(reviews.confirm(adminCtx(f.b),confirmation(r))).rejects.toThrow();const [company]=await owner.db.insert(s.company).values({tenantId:f.b.tenantId,legalName:'Other fictional company',companyLabel:'Other'}).returning({id:s.company.id});const c=await createOffboardingCase(adminCtx(f.b),{companyId:company.id,fullName:'Other case',employeeNo:randomUUID(),resignationDate:'2026-10-01'});
 for(const patch of [{caseId:c.id,caseNumber:c.number},{caseNumber:c.number},{cancelReturn:true},{effectiveDate:'2026-11-01'}])await expect(reviews.prepare(f.ctx,{...f.human,...patch})).rejects.toThrow();
});
it('refuses historical reopen/recancel and identical case UPDATE laundering but allows later IT-only work with unchanged case',async()=>{
 const r=await prepare();await reviews.confirm(f.ctx,confirmation(r));await owner.db.update(s.itRequisition).set({notes:'Later legitimate IT work'}).where(eq(s.itRequisition.id,f.reqId));expect((await reviews.reopen(f.ctx,r.actionId)).kind).toBe('completed');
 await owner.db.execute(sql`update lc_case set cancel_reason=cancel_reason where id=${f.caseId}::uuid`);await expect(reviews.reopen(f.ctx,r.actionId)).rejects.toThrow();await reopenCase(f.ctx,'offboarding',f.number);await cancelCase(f.ctx,'offboarding',f.number,f.human.reason);await expect(reviews.reopen(f.ctx,r.actionId)).rejects.toThrow();
});
it('uses the shared five-pending limit and native UTF-16/trim reason limits without creating another ledger',async()=>{const r=[];for(let n=0;n<5;n++)r.push(await prepare());await expect(prepare()).rejects.toThrow();expect(r).toHaveLength(5);await expect(reviews.prepare(f.ctx,{...f.human,reason:'🙂'.repeat(251)})).rejects.toThrow();});

it('binds a genuine linked case subject and preserves employment while completing its nullable-actor receipt',async()=>{
 f=await caseCancelFixture(true);const r=await prepare(),before=await owner.db.select().from(s.employment).where(eq(s.employment.id,f.subject!.employmentId));const result=await reviews.confirm(f.ctx,confirmation(r));expect(result.kind).toBe('completed');expect(await owner.db.select().from(s.employment).where(eq(s.employment.id,f.subject!.employmentId))).toEqual(before);
 if(result.kind!=='completed')throw Error('expected completed');const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,result.receipt.receipt.eventId));expect(event.subjectEmploymentId).toBe(f.subject!.employmentId);
});
it('refuses another real tenant before unwrapping the private review',async()=>{
 const r=await prepare(),other=await seedBase(),unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.reopen(adminCtx(other),r.actionId)).rejects.toThrow();await expect(reviews.prepare(adminCtx(other),f.human)).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();
});
it('rejects dedicated/generic hybrid custody fields and loss of actual case/company scope',async()=>{
 const r=await prepare();for(const column of ['knowledge_article_id','decision_request_id','testing_execution_id','payroll_close_batch_id','receipt_subject_id','offboarding_step_key']){
  let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=${column==='offboarding_step_key'?'unexpected-step':randomUUID()} where id=${r.actionId}::uuid`);}catch(e){error=e;}expect(pgSqlState(error),column).toBe('23514');
 }
 for(const column of ['company_id','lifecycle_case_id']){let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=null where id=${r.actionId}::uuid`);}catch(e){error=e;}expect(pgSqlState(error),column).toBe('23514');}
 expect(await privateRow(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1,commitment:expect.any(String)});
});

it('preserves canonical erasure of already completed custody in a later transaction',async()=>{
 f=await caseCancelFixture(true);const r=await prepare();await reviews.confirm(f.ctx,confirmation(r));await erasePersonPii(adminCtx(f.b),{subjectEmploymentId:f.subject!.employmentId,scope:'contact',requestRef:'FICTIONAL-COMPLETED-ERASURE',reason:'Fictional completed subject request'});expect(await privateRow(r.actionId)).toMatchObject({state:'completed',bodies:0,commitment:null,intent_digest:null,reviewed_digest:null});
});

it('shared body contract: real Lifecycle pending writes and terminal retarget refusal',async()=>{await assertReviewBodyPendingParentContract({ctx:f.ctx,kind:C.action,businessSnapshot:()=>caseCancelSnapshot(f),prepare,retire:r=>reviews.discard(f.ctx,{action:C.action,contractVersion:1,actionId:r.actionId})});});
