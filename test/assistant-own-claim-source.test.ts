/** Authored UNRUN: actual native Claims draft/source tests on fictional isolated fixtures. This is
 * not shared-custody idempotency, a mounted human action, reimbursement or production proof. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createClaimType,updateClaimType,setClaimPolicy,setClaimPolicyTx,saveClaimDraft,addClaimAttachment,submitDraftClaims,getEmployeeClaimTypes} from '../packs/claims/service';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiAllowance} from '../core/ai-management';
import {prepareOwnClaimDraftSourceTx,confirmOwnClaimDraftSourceTx,reconcileOwnClaimDraftSourceTx,OwnClaimDraftSourceUnavailable} from '../core/assistant-actions/own-claim-source';
import {OWN_CLAIM_DRAFT_ACTION,OwnClaimDraftNomination,OwnClaimDraftHumanContent,OwnClaimDraftConfirmation,type OwnClaimDraftPreparedSource} from '../lib/assistant-actions/own-claim-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},human:OwnClaimDraftHumanContent,typeId:string;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'claims','active');
 subject=await hireEmployee(group(),{person:{fullName:'Fictional Own Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});ctx={...await entitledCtx(b,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 typeId=(await createClaimType(group(),{code:'FICTIONAL',name:'Fictional actual receipt',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur()});
 human={action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,employmentId:subject.employmentId,draftId:null,claimTypeId:typeId,claimItemId:null,enteredAmount:200,quantityKm:null,incurredOn:todayInKualaLumpur(),description:'PRIVATE actual human receipt facts',fieldValues:null,retainedAttachmentIds:[]};
});
const native=(value=human)=>({employmentId:value.employmentId,claimTypeId:value.claimTypeId,claimItemId:value.claimItemId,amount:value.enteredAmount,quantityKm:value.quantityKm,incurredOn:value.incurredOn,description:value.description,fieldValues:value.fieldValues,...value.draftId?{id:value.draftId}:{}});
const prepare=(actor=ctx,value:unknown=human)=>withTenant(actor,tx=>prepareOwnClaimDraftSourceTx(tx,actor,value));
const confirm=(review:OwnClaimDraftPreparedSource,actor=ctx,value:unknown=review.content)=>withTenant(actor,tx=>confirmOwnClaimDraftSourceTx(tx,actor,value,{action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest}));
async function state(){return{claims:await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.tenantId,b.tenantId)).orderBy(s.claimRequest.id),attachments:await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.tenantId,b.tenantId)).orderBy(s.claimAttachment.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),payroll:await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.tenantId,b.tenantId)).orderBy(s.payrollInput.id)};}
describe('human-only Claims draft source contract',()=>{
 it('refuses model monetary/date/receipt facts and confirmation content or caller selectors',()=>{
  const refs={action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,employmentId:subject.employmentId,draftId:null,claimTypeId:typeId,claimItemId:null};expect(OwnClaimDraftNomination.safeParse(refs).success).toBe(true);expect(OwnClaimDraftNomination.safeParse({...refs,amount:12,incurredOn:human.incurredOn,receiptText:'invented'}).success).toBe(false);
  expect(OwnClaimDraftConfirmation.safeParse({action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,reviewedDigest:'a'.repeat(64),employmentId:human.employmentId,enteredAmount:12,confirmed:true}).success).toBe(false);expect(OwnClaimDraftHumanContent.safeParse({...human,retainedAttachmentIds:[randomUUID()]}).success).toBe(false);
 });
});
describe('unmounted canonical own claim DRAFT source',()=>{
 it('prepares without effects, then creates only a draft/native event over budget without reservation, submission or payroll',async()=>{
  const before=await state(),review=await prepare();expect(await state()).toEqual(before);expect(review).toMatchObject({content:human,provisionalAmount:'200.00',consequence:'draft_only_no_submission_or_reimbursement'});expect(JSON.stringify(review)).not.toContain('contentBytes');
  const receipt=await confirm(review),after=await state();expect(receipt).toMatchObject({kind:'draft_saved',employmentId:subject.employmentId,currentStatus:'draft',replayed:false});expect(after.claims).toHaveLength(1);expect(after.claims[0]).toMatchObject({id:receipt.draftId,status:'draft',amount:'200.00'});expect(after.payroll).toEqual(before.payroll);expect(after.events.filter(row=>row.eventType==='claim-request.submitted')).toHaveLength(0);const event=after.events.find(row=>row.id===receipt.savedEventId)!;expect(event).toMatchObject({eventType:'claim-request.draft-saved',aggregateId:receipt.draftId,actorId:ctx.userId,subjectEmploymentId:subject.employmentId});expect(JSON.stringify(event.payload)).not.toContain('PRIVATE');expect(JSON.stringify(event.payload)).not.toContain('amount');
  const balance=(await getEmployeeClaimTypes(ctx,subject.employmentId)).find(row=>row.id===typeId)!.balance;expect(balance.usedThisYear).toBe(0);expect(balance.reservedThisYear).toBe(0);
 });
 it('uses the native provisional price exactly and keeps the ordinary API shape; no model or copied price rules',async()=>{
  await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur(),rateConfig:{kind:'fixed_allowance',amount:25}});const review=await prepare();const nativeSaved=await saveClaimDraft(ctx,native());expect(Object.keys(nativeSaved)).toEqual(['id']);const [manual]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,nativeSaved.id));expect(review.provisionalAmount).toBe(manual.amount);expect(review.content.enteredAmount).toBe(200);const receipt=await confirm(review);const [saved]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,receipt.draftId));expect(saved.amount).toBe(manual.amount);
 });
 it('updates a human-selected own draft and retains only its freshly verified attachment references, never bytes',async()=>{
  const existing=await saveClaimDraft(ctx,native()),attachment=await addClaimAttachment(ctx,{claimRequestId:existing.id,fileName:'fictional.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-fictional')});const content={...human,draftId:existing.id,enteredAmount:50,retainedAttachmentIds:[attachment.id]},review=await prepare(ctx,content),receipt=await confirm(review);expect(receipt.draftId).toBe(existing.id);const after=await state();expect(after.claims).toHaveLength(1);expect(after.claims[0].amount).toBe('50.00');expect(after.attachments.map(row=>row.id)).toEqual([attachment.id]);expect(Object.keys(review).sort()).toEqual(['consequence','content','kind','provisionalAmount','provisionalQuantityKm','provisionalTaxable','reviewedDigest']);
 });
 it('reconciles completed native refs without repeating a create or update; native creation is not an idempotency ledger',async()=>{
  const review=await prepare(),receipt=await confirm(review),before=await state();const reopened=await withTenant(ctx,tx=>reconcileOwnClaimDraftSourceTx(tx,ctx,receipt));expect(reopened).toMatchObject({...receipt,replayed:true});expect(await state()).toEqual(before);
 });
 it.each(['catalog','policy','draft','receipt'] as const)('refuses changed %s source before a save',async kind=>{
  const existing=await saveClaimDraft(ctx,native()),review=await prepare(ctx,{...human,draftId:existing.id});
  if(kind==='catalog')await updateClaimType(group(),{id:typeId,name:'Fictional changed type',defaultTaxable:true,requiresReceipt:false});else if(kind==='policy')await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur(),rateConfig:{kind:'fixed_allowance',amount:10}});else if(kind==='draft')await saveClaimDraft(ctx,{...native(),id:existing.id,amount:20});else await addClaimAttachment(ctx,{claimRequestId:existing.id,fileName:'new.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-new')});
  const before=await state();await expect(confirm(review)).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(before);
 });
 it.each(['claims_module','assistant_module','grant','pause'] as const)('rechecks fresh %s authority before any draft effect',async kind=>{
  const review=await prepare();if(kind==='claims_module')await setModule(b.tenantId,'claims','disabled');else if(kind==='assistant_module')await setModule(b.tenantId,'assistant','disabled');else if(kind==='grant')await revokeAssistant(group(),{appUserId:ctx.userId!});else await setAiAllowance(group(),{kind:'user',subjectId:ctx.userId!,enabled:false,dailyRequests:null,monthlyTokens:null});const before=await state();await expect(confirm(review)).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(before);
 });
 it('refuses a foreign employment/draft/attachment and a different actor native-event reference',async()=>{
  const other=await hireEmployee(group(),{person:{fullName:'Fictional Other Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),otherUser=await createAppUser(b.tenantId,other.personId,'employee'),otherCtx={...ctx,userId:otherUser,personId:other.personId},otherDraft=await saveClaimDraft(otherCtx,{...native(),employmentId:other.employmentId}),otherReceipt=await addClaimAttachment(otherCtx,{claimRequestId:otherDraft.id,fileName:'other.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-other')});const mine=await saveClaimDraft(ctx,native()),before=await state();
  await expect(prepare(ctx,{...human,employmentId:other.employmentId})).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);await expect(prepare(ctx,{...human,draftId:otherDraft.id})).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);await expect(prepare(ctx,{...human,draftId:mine.id,retainedAttachmentIds:[otherReceipt.id]})).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(before);
  const ownSaved=await confirm(await prepare(ctx,{...human,draftId:mine.id})),secondUser=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:secondUser});const second={...ctx,userId:secondUser};const savedState=await state();await expect(withTenant(second,tx=>reconcileOwnClaimDraftSourceTx(tx,second,ownSaved))).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(savedState);
 });
 it('rolls back draft and exact native event when the outer custody completion fails, then can create once on explicit retry',async()=>{
  const review=await prepare(),before=await state(),injected=Error('fictional shared custody completion failure');await expect(withTenant(ctx,async tx=>{await confirmOwnClaimDraftSourceTx(tx,ctx,review.content,{action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest});throw injected;})).rejects.toBe(injected);expect(await state()).toEqual(before);const receipt=await confirm(review);expect((await state()).claims.map(row=>row.id)).toEqual([receipt.draftId]);
 });
 it('reports a later HUMAN native submission without submitting or executing again during reopen',async()=>{
  const review=await prepare(ctx,{...human,enteredAmount:50}),receipt=await confirm(review);await submitDraftClaims(ctx,{ids:[receipt.draftId],employmentId:subject.employmentId});const before=await state();const reopened=await withTenant(ctx,tx=>reconcileOwnClaimDraftSourceTx(tx,ctx,receipt));expect(reopened).toMatchObject({kind:'draft_saved',currentStatus:'pending',replayed:true,savedEventId:receipt.savedEventId});expect(await state()).toEqual(before);
 });
 it('keeps an actual concurrent native policy replacement from committing through the owned review interval',async()=>{
  const review=await prepare();let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void,pidReady!:(pid:number)=>void,pidFail!:(error:unknown)=>void;
  const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;}),pidPromise=new Promise<number>((yes,no)=>{pidReady=yes;pidFail=no;});void pidPromise.catch(()=>{});
  const timer=setTimeout(()=>{const error=Error('claim source/catalog interval timeout');fail(error);pidFail(error);release();},10000);
  const holder=withTenant(ctx,async tx=>{await prepareOwnClaimDraftSourceTx(tx,ctx,human);ready();await finish;});void holder.catch(fail);let writer:Promise<{id:string}>|undefined;
  try{await start;writer=withTenant(group(),async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);pidReady(row.pid);return setClaimPolicyTx(tx,group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur(),rateConfig:{kind:'fixed_allowance',amount:30}});});void writer.catch(pidFail);const pid=await pidPromise;let waiting=false;
   for(let tries=0;tries<100;tries++){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks where pid=${pid} and not granted) as waiting`);if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,10));}expect(waiting).toBe(true);expect((await state()).claims).toHaveLength(0);
  }finally{release();clearTimeout(timer);await holder;}await writer!;const after=await state();await expect(confirm(review)).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(after);const fresh=await prepare();expect(fresh.provisionalAmount).toBe('30.00');
 });
 it('refuses a held real policy row without effects and succeeds only after release',async()=>{
  const review=await prepare(),before=await state();let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void;const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;}),timer=setTimeout(()=>{fail(Error('claim policy interval timeout'));release();},10000);const holder=owner.db.transaction(async tx=>{await tx.select({id:s.claimPolicy.id}).from(s.claimPolicy).where(eq(s.claimPolicy.claimTypeId,typeId)).for('update');ready();await finish;});void holder.catch(fail);
  try{await start;await expect(confirm(review)).rejects.toBeInstanceOf(OwnClaimDraftSourceUnavailable);expect(await state()).toEqual(before);}finally{release();clearTimeout(timer);await holder;}expect((await confirm(review)).currentStatus).toBe('draft');
 });
});
