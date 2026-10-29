/** ADR-0151 wave 1: own pending claim cancellation through the generic review functions of migration 0670.
 * Real migrated database and real native claims service; fictional fixtures only. */
import {createHash,randomUUID} from 'node:crypto';
import * as dbClient from '../db/client';
import {newDek,newKid,wrapDek,sealUnderDek} from '../lib/pii/vault';
import {newPrivateReviewNonce,privateReviewCommitment} from '../core/assistant-actions/private-review-commitment';
import {withOwnClaimCancellationSubjectTx,prepareOwnClaimCancellationSourceTx} from '../core/assistant-actions/own-claim-cancellation-source';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setAiFeature} from '../core/ai-management';
import {withAgentActionGuard} from '../core/assistant-actions/agent-action-guard';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createClaimType,setClaimPolicy,submitClaim,decideClaim,cancelClaimTx} from '../packs/claims/service';
import {prepareClaimCancellationReview,confirmClaimCancellationReview,reopenClaimCancellationReview,discardClaimCancellationReview,listClaimCancellationReviews,readClaimCancellationChoices} from '../core/assistant-actions/claim-cancellation-review-store';
import {OWN_CLAIM_CANCELLATION_ACTION as action} from '../lib/assistant-actions/own-claim-cancellation-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},typeId:string,claimId:string;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)') is not null as ok`);expect(installed.ok,'Migration 0670 must be installed.').toBe(true);});
afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-claim-cancel-custody-key-123456789');
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'claims','active');
 subject=await hireEmployee(group(),{person:{fullName:'Fictional Cancellation Owner',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});
 ctx={...await entitledCtx(b,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 typeId=(await createClaimType(group(),{code:'FIC-CANCEL',name:'Fictional cancellable travel',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
 claimId=(await submitClaim(ctx,{employmentId:subject.employmentId,claimTypeId:typeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional taxi fare'})).id;
});
const human=(id=claimId)=>({action,contractVersion:1 as const,employmentId:subject.employmentId,claimId:id,cancel:true as const});
const prepare=async(who=ctx,value:unknown=human())=>(await prepareClaimCancellationReview(who,value)).review;
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const confirm=(r:{actionId:string;reviewedDigest:string},who=ctx)=>confirmClaimCancellationReview(who,confirmation(r));
async function state(){return{claims:await owner.db.select({id:s.claimRequest.id,status:s.claimRequest.status}).from(s.claimRequest).where(eq(s.claimRequest.tenantId,b.tenantId)).orderBy(s.claimRequest.id),
 cancelled:await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'claim-request.cancelled'))).orderBy(s.domainEvent.id)};}
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.action_kind,r.state,r.receipt_subject_kind,r.receipt_subject_id,r.receipt_event_id,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

describe('ADR-0151 own claim cancellation custody',()=>{
 it('lists the own pending claim and prepares a sealed review without any effect',async()=>{
  const choices=await readClaimCancellationChoices(ctx);expect(choices).toMatchObject({kind:'choices',claims:[{claimId,employmentId:subject.employmentId,amount:'42.50',claimTypeName:'Fictional cancellable travel'}]});
  const before=await state(),r=await prepare();expect(await state()).toEqual(before);
  expect(r.review).toEqual({employmentId:subject.employmentId,claimId,claimTypeName:'Fictional cancellable travel',incurredOn:todayInKualaLumpur(),amount:'42.50',status:'pending'});
  expect(r.consequence).toBe('pending_claim_cancelled_no_payment');
  expect(await custody(r.actionId)).toMatchObject({action_kind:'claims.cancel',state:'awaiting_confirmation',receipt_subject_kind:'claim_request',receipt_subject_id:claimId,receipt_event_id:null,bodies:1});
 });
 it('cancels exactly once across duplicate deliveries and retires the private body',async()=>{
  const r=await prepare(),results=await Promise.all([confirm(r),confirm(r)]);
  expect(results[0]).toEqual(results[1]);expect(results[0].kind).toBe('completed');
  const after=await state();expect(after.claims).toEqual([{id:claimId,status:'cancelled'}]);expect(after.cancelled).toHaveLength(1);
  if(results[0].kind!=='completed')throw Error('Expected completed');expect(results[0].receipt.receipt).toEqual({kind:'cancelled',claimId,cancelledEventId:after.cancelled[0].id,employmentId:subject.employmentId,currentStatus:'cancelled'});
  expect(await custody(r.actionId)).toMatchObject({state:'completed',receipt_event_id:after.cancelled[0].id,intent_digest:null,reviewed_digest:null,bodies:0});
  // A completed review never cancels again; reopening reads the canonical receipt.
  expect((await reopenClaimCancellationReview(ctx,r.actionId)).kind).toBe('completed');expect((await state()).cancelled).toHaveLength(1);
  const [linked]=await withTenant(ctx,tx=>tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${action},${r.actionId}::uuid) as completed`));expect(linked.completed).toBe(true);
 });
 it('refuses when the claim changed after review (decided by the approver), leaving everything unchanged',async()=>{
  const r=await prepare();await decideClaim(group(),{claimRequestId:claimId,decision:'approve'});const before=await state();
  await expect(confirm(r)).rejects.toThrow();expect(await state()).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation'});
 });
 it('refuses a wrong digest, another login of the same person, and another employee\'s claim',async()=>{
  const r=await prepare();await expect(confirm({actionId:r.actionId,reviewedDigest:'0'.repeat(64)})).rejects.toThrow();
  const second=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:second});const who={...ctx,userId:second};
  await expect(confirm(r,who)).rejects.toThrow();expect((await listClaimCancellationReviews(who)).reviews).toEqual([]);
  const other=await hireEmployee(group(),{person:{fullName:'Fictional Other Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const otherUser=await createAppUser(b.tenantId,other.personId,'employee'),otherCtx={...ctx,userId:otherUser,personId:other.personId};
  const foreign=(await submitClaim(otherCtx,{employmentId:other.employmentId,claimTypeId:typeId,amount:10,incurredOn:todayInKualaLumpur(),description:'Fictional other fare'})).id;
  await expect(prepare(ctx,{...human(foreign)})).rejects.toThrow();await expect(prepare(ctx,{...human(foreign),employmentId:other.employmentId})).rejects.toThrow();
  expect((await state()).claims.every(row=>row.status==='pending')).toBe(true);
 });
 it('rechecks the Assistant grant on confirmation but still lets the person discard',async()=>{
  const r=await prepare();await revokeAssistant(group(),{appUserId:ctx.userId!});const before=await state();
  await expect(confirm(r)).rejects.toThrow();expect(await state()).toEqual(before);
  expect((await discardClaimCancellationReview(ctx,{action,contractVersion:1,actionId:r.actionId})).receipt.state).toBe('discarded');
  expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0});
 });
 it('allows one pending review per claim and refuses a cancellation committed in another transaction as proof',async()=>{
  const r=await prepare();await expect(prepare()).rejects.toThrow();
  const prior=await withTenant(ctx,tx=>cancelClaimTx(tx,ctx,claimId,subject.employmentId));
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_generic_review_complete(${r.actionId}::uuid,${action},${r.reviewedDigest},${prior.eventId}::uuid)`))).rejects.toThrow();
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null});
 });
});

// Compatibility fixture authored from the pre-WP9 writer at 057dc9e12. It deliberately does not call
// createGenericOwnReviewStore: a retained pre-upgrade sealed row must reopen and complete after this refactor.
async function legacyClaimCancellationReview(){
 return withTenant(ctx,tx=>withOwnClaimCancellationSubjectTx(tx,ctx,claimId,async(fresh,own)=>{
  const native=await prepareOwnClaimCancellationSourceTx(tx,fresh,human());
  const body={reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest};
  const binding={tenantId:fresh.tenantId,userId:fresh.userId!,personId:fresh.personId!,employmentId:own.employmentId,companyId:own.companyId};
  const actionId=randomUUID(),intentDigest=createHash('sha256').update(JSON.stringify(body.content)).digest('hex'),reviewedDigest=privateReviewCommitment([1,action,binding],body);
  const identity=JSON.stringify([1,action,actionId,binding,intentDigest,reviewedDigest]);
  const dek=newDek();try{
   const kid=newKid(),wrappedDek=wrapDek(dek,'assistant:module-action:key:'+identity),ciphertext=sealUnderDek(dek,kid,JSON.stringify(body),'assistant:module-action:body:'+identity);
   await tx.execute(sql`select app.assistant_generic_review_prepare(${action},${actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${own.claimId}::uuid,${intentDigest},${reviewedDigest},${kid},${wrappedDek},${ciphertext})`);
   return {actionId,reviewedDigest};
  }finally{dek.fill(0);}
 }));
}
describe('WP9 retained pre-upgrade claim cancellation rows',()=>{
 it('reopens a pre-WP9 sealed review and commits its cancellation once through the generic family',async()=>{
  const old=await legacyClaimCancellationReview();
  const reopened=await reopenClaimCancellationReview(ctx,old.actionId);expect(reopened.kind).toBe('prepared');
  if(reopened.kind==='prepared')expect(reopened.review.reviewedDigest).toBe(old.reviewedDigest);
  const done=await confirm(old);expect(done.kind).toBe('completed');
  expect(await reopenClaimCancellationReview(ctx,old.actionId)).toEqual(done);
  expect(await confirm(old)).toEqual(done);expect((await state()).cancelled).toHaveLength(1);
 });
 it('keeps the retained review digest-bound and permits login-only retirement after grant removal',async()=>{
  const old=await legacyClaimCancellationReview(),before=await state();
  await expect(confirm({...old,reviewedDigest:'0'.repeat(64)})).rejects.toThrow();expect(await state()).toEqual(before);
  await revokeAssistant(group(),{appUserId:ctx.userId!});
  await expect(confirm(old)).rejects.toThrow();
  expect((await discardClaimCancellationReview(ctx,{action,contractVersion:1,actionId:old.actionId})).receipt.state).toBe('discarded');
  expect(await state()).toEqual(before);
 });
});

describe('WP9 uncertain confirmation reconciliation',()=>{
 it('reopens a committed cancellation after a simulated lost reply, without repeating the effect',async()=>{
  const review=await prepare(),real=dbClient.withTenant;
  const lostReply:typeof withTenant=async(who,work,options)=>{await real(who,work,options);throw Error('Fictional lost reply after commit');};
  const spy=vi.spyOn(dbClient,'withTenant').mockImplementationOnce(lostReply);
  try{await expect(confirm(review)).rejects.toThrow();}finally{spy.mockRestore();}
  expect((await state()).cancelled).toHaveLength(1);
  const reopened=await reopenClaimCancellationReview(ctx,review.actionId);expect(reopened.kind).toBe('completed');
  expect(await confirm(review)).toEqual(reopened);expect((await state()).cancelled).toHaveLength(1);
 });
});


describe('WP9 shared registry prerequisites at confirmation',()=>{
 it('refuses a fresh module pause and resumes the same digest after the pause is lifted',async()=>{
  const review=await prepare(),before=await state();await setAiFeature(group(),'hr_assistant',false);
  expect(await readClaimCancellationChoices(ctx)).toEqual({kind:'unavailable'});await expect(confirm(review)).rejects.toThrow();expect(await state()).toEqual(before);
  await setAiFeature(group(),'hr_assistant',true);expect((await confirm(review)).kind).toBe('completed');
 });
 it('reads the current registered module state rather than a retained enabled snapshot',async()=>{
  const review=await prepare(),before=await state();await setModule(b.tenantId,'claims','disabled');
  await expect(confirm(review)).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('refuses a handoff with no human review adapter',async()=>{
  await expect(withTenant(ctx,tx=>withAgentActionGuard(tx,ctx,'employees.import'))).rejects.toThrow();
  expect((await state()).cancelled).toHaveLength(0);
 });
});
