/** Authored UNRUN: canonical app-role DB/source tests, not full Assistant action/custody/POST proof. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {requestProfileChange,decideProfileChange,updateOwnContact,readOwnProfileChangeSubmissionReferenceTx} from '../core/profile';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {saveProfileRoutingPolicy} from '../core/profile-routing';
import {EMPTY_PROFILE_ROUTING} from '../lib/profile-routing-policy';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiAllowance} from '../core/ai-management';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {prepareOwnProfileChangeSourceTx,confirmOwnProfileChangeSourceTx,reconcileOwnProfileChangeSourceTx,OwnProfileChangeSourceUnavailable} from '../core/assistant-actions/own-profile-change-source';
import {OWN_PROFILE_CHANGE_ACTION,OwnProfileChangeNomination,OwnProfileChangeHumanContent,OwnProfileChangeConfirmation,type OwnProfileChangePreparedSource} from '../lib/assistant-actions/own-profile-change-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},human:OwnProfileChangeHumanContent;
const preferred='profile.personal_details.preferredname',phone='profile.contact_and_permanent_address.phone';
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');
 subject=await hireEmployee(group(),{person:{fullName:'Fictional Own Profile Applicant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});
 ctx={...await entitledCtx(b,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 await saveProfileEditPolicy(group(),{keys:[preferred,phone],withdrawnReason:'Fictional approved policy'});
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId:subject.employmentId});human={action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,employmentId:subject.employmentId,proposal:{v:2,fields:[{fieldId:preferred,before:workspace.baselines[preferred],value:'PRIVATE human requested name'}],registers:[]}};
});
const prepare=(actor=ctx,value:unknown=human)=>withTenant(actor,tx=>prepareOwnProfileChangeSourceTx(tx,actor,value));
const confirm=(review:OwnProfileChangePreparedSource,actor=ctx,content:unknown=review.content)=>withTenant(actor,tx=>confirmOwnProfileChangeSourceTx(tx,actor,content,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest}));
async function state(){return{requests:await owner.db.select().from(s.profileChangeRequest).where(eq(s.profileChangeRequest.tenantId,b.tenantId)).orderBy(s.profileChangeRequest.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),master:await owner.db.select().from(s.person).where(eq(s.person.id,subject.personId))};}
describe('separate own-profile nomination/human/confirmation contracts',()=>{
 it('refuses model values, arbitrary patches and content/actor selectors in the confirmation packet',()=>{
  expect(OwnProfileChangeNomination.safeParse({action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,employmentId:subject.employmentId,fieldIds:[preferred],value:'invented'}).success).toBe(false);
  expect(OwnProfileChangeHumanContent.safeParse({...human,proposal:{preferredName:'invented'}}).success).toBe(false);
  expect(OwnProfileChangeConfirmation.safeParse({action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,reviewedDigest:'a'.repeat(64),employmentId:subject.employmentId,proposal:human.proposal,clicked:true}).success).toBe(false);
 });
});
describe('unmounted own ESS canonical approval-request source',()=>{
 it('prepares only current permitted human changes and concurrent confirmations reuse one exact native request/event',async()=>{
  const review=await prepare(),before=await state();expect(review).toMatchObject({kind:'prepared_source',content:human,consequence:'request_hr_review'});expect(Object.keys(review).sort()).toEqual(['consequence','content','kind','reviewedDigest']);expect(before.requests).toHaveLength(0);
  const receipts=await Promise.all([confirm(review),confirm(review)]);expect(new Set(receipts.map(row=>row.requestId)).size).toBe(1);expect(new Set(receipts.map(row=>row.requestedEventId)).size).toBe(1);expect(receipts.map(row=>row.replayed).sort()).toEqual([false,true]);
  const after=await state(),request=after.requests[0],events=after.events.filter(row=>row.eventType==='profile-change.requested');expect(request.proposed).toEqual(human.proposal);expect(request.status).toBe('pending');expect(after.master[0].preferredName).toBeNull();expect(events).toHaveLength(1);expect(events[0]).toMatchObject({id:receipts[0].requestedEventId,aggregateId:request.id,actorId:ctx.userId,subjectEmploymentId:subject.employmentId});expect(JSON.stringify(events[0].payload)).not.toContain('PRIVATE');
 });
 it('keeps direct contact edits outside this approval-request adapter without applying them',async()=>{
  const workspace=await readOwnProfileWorkspace(ctx,{employmentId:subject.employmentId}),before=await state();const immediate={...human,proposal:{v:2,fields:[{fieldId:phone,before:workspace.baselines[phone],value:'0114445555'}],registers:[]}};await expect(prepare(ctx,immediate)).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(before);
 });
 it('retains the ordinary exact requestId return shape and can reconcile that same native actor/event without a second ledger',async()=>{
  const review=await prepare(),native=await requestProfileChange(ctx,{employmentId:human.employmentId,proposed:human.proposal});expect(Object.keys(native)).toEqual(['requestId']);const result=await confirm(review);expect(result).toMatchObject({requestId:native.requestId,replayed:true});expect((await state()).events.filter(row=>row.eventType==='profile-change.requested')).toHaveLength(1);
 });
 it('refuses source row-version drift even when the reviewed selected field value still matches',async()=>{
  const review=await prepare();await updateOwnContact(ctx,{phone:'0112223333'});const before=await state();await expect(confirm(review)).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(before);expect(before.master[0].preferredName).toBeNull();
 });
 it.each(['field','route','grant','pause','module'] as const)('rechecks fresh %s policy/authority before any effect',async kind=>{
  const review=await prepare();if(kind==='field')await saveProfileEditPolicy(group(),{keys:[],withdrawnReason:'Fictional field revocation'});else if(kind==='route')await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:false,rules:[]});else if(kind==='grant')await revokeAssistant(group(),{appUserId:ctx.userId!});else if(kind==='pause'){const [proof]=await withTenant(group(),tx=>tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() and app.principal_snapshot_current() as allowed`));expect(proof?.allowed).toBe(true);await setAiAllowance(group(),{kind:'user',subjectId:ctx.userId!,enabled:false,dailyRequests:null,monthlyTokens:null});}else await setModule(b.tenantId,'assistant','disabled');const before=await state();await expect(confirm(review)).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(before);
 });
 it('cannot retarget to a foreign person or adopt a same-person second login pending event',async()=>{
  const other=await hireEmployee(group(),{person:{fullName:'Fictional Other Profile',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),review=await prepare();const before=await state();await expect(prepare(ctx,{...human,employmentId:other.employmentId})).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);await expect(confirm(review,ctx,{...review.content,employmentId:other.employmentId})).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(before);
  const first=await confirm(review),secondUser=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:secondUser});const otherLogin={...ctx,userId:secondUser},secondReview=await prepare(otherLogin);const pending=await state();await expect(confirm(secondReview,otherLogin)).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(pending);expect(await withTenant(otherLogin,tx=>readOwnProfileChangeSubmissionReferenceTx(tx,otherLogin,first.requestId,first.requestedEventId))).toBeNull();
 });
 it('rolls the native request and exact event back when the enclosing future-custody transaction fails, then safely retries',async()=>{
  const review=await prepare(),before=await state(),injected=Error('fictional custody completion failure');await expect(withTenant(ctx,async tx=>{await confirmOwnProfileChangeSourceTx(tx,ctx,review.content,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest});throw injected;})).rejects.toBe(injected);expect(await state()).toEqual(before);const retried=await confirm(review);expect(retried.replayed).toBe(false);expect((await state()).requests).toHaveLength(1);
 });
 it('reconciles an approved native receipt without another execution or a false Assistant approval claim',async()=>{
  const review=await prepare(),submitted=await confirm(review);await decideProfileChange(group(),{requestId:submitted.requestId,decision:'approved'});const before=await state();const reopened=await withTenant(ctx,tx=>reconcileOwnProfileChangeSourceTx(tx,ctx,submitted));expect(reopened).toMatchObject({kind:'submitted',requestId:submitted.requestId,requestedEventId:submitted.requestedEventId,currentStatus:'approved',replayed:true});expect(await state()).toEqual(before);await expect(confirm(review)).rejects.toBeInstanceOf(OwnProfileChangeSourceUnavailable);expect(await state()).toEqual(before);
 });
 it('captures retained human content and actor carriers before waiting on actual Access ownership',async()=>{
  const review=await prepare(),retained=structuredClone(review.content),retainedCtx={...ctx,roles:[...ctx.roles!],grants:ctx.grants!.map(grant=>({...grant}))};
  let ready!:()=>void,failReady!:(error:unknown)=>void,release!:()=>void,pidReady!:(pid:number)=>void,pidFail!:(error:unknown)=>void;
  const start=new Promise<void>((yes,no)=>{ready=yes;failReady=no;}),finish=new Promise<void>(yes=>{release=yes;}),pidPromise=new Promise<number>((yes,no)=>{pidReady=yes;pidFail=no;});void pidPromise.catch(()=>{});
  const timeout=setTimeout(()=>{const failure=Error('profile source handshake timed out');failReady(failure);pidFail(failure);release();},10000);
  const holder=withTenant(group(),async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);ready();await finish;});void holder.catch(failReady);
  let request:ReturnType<typeof confirm>|undefined;
  try{await start;request=withTenant(retainedCtx,async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);pidReady(row.pid);return confirmOwnProfileChangeSourceTx(tx,retainedCtx,retained,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest});});void request.catch(pidFail);
   const pid=await pidPromise;let waiting=false;for(let tries=0;tries<100;tries++){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and not granted) as waiting`);if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,10));}
   expect(waiting).toBe(true);retained.employmentId=randomUUID();retained.proposal.fields[0].value='PRIVATE retarget attempt';retainedCtx.personId=randomUUID();retainedCtx.grants[0].companyId=randomUUID();expect((await state()).requests).toHaveLength(0);
  }finally{release();clearTimeout(timeout);await holder;}
  const result=await request!;expect(result.employmentId).toBe(subject.employmentId);const [stored]=await owner.db.select().from(s.profileChangeRequest).where(and(eq(s.profileChangeRequest.id,result.requestId),eq(s.profileChangeRequest.tenantId,b.tenantId)));expect(stored.proposed).toEqual(human.proposal);
 });
});
