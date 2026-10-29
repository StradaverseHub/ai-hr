/** ADR-0151 wave 1b: an ASSIGNED approver decides someone else's pending claim, attendance request or
 * replacement-leave (TOIL) request through the generic assigned-review store (migration 0671).
 * Real migrated database and the real native decision services; fictional fixtures only.
 * Authored UNRUN (tests run on GitHub Actions under the owner's policy). */
import {z} from 'zod';
import {setAgentActionPause} from '../core/ai-inventory';
import {createGenericAssignedReviewStore} from '../core/assistant-actions/generic-assigned-review-store';
import {AssignedClaimDecision} from '../lib/assistant-actions/assigned-decision-contract';
import {assignedDecisionUnavailable,withAssignedClaimSubjectTx,prepareAssignedClaimSourceTx,confirmAssignedClaimSourceTx,reconcileAssignedClaimSourceTx} from '../core/assistant-actions/assigned-decision-sources';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createClaimType,setClaimPolicy,submitClaim,cancelClaim,decideClaim,decideClaimTx} from '../packs/claims/service';
import {requestAttendanceCorrection,decideAttendanceCorrection,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../packs/attendance/service';
import {setToilPolicy,submitReplacementLeaveRequest,cancelOwnReplacementLeaveRequest,decideReplacementLeaveRequest,decideReplacementLeaveRequestTx} from '../packs/leave/service';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews,readClaimDecisionChoices,readAttendanceDecisionChoices,readToilDecisionChoices} from '../core/assistant-actions/assigned-decision-review-store';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '../lib/assistant-actions/assigned-decision-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type Decision='approved'|'rejected';
type Role='employee'|'manager'|'hr_admin'|'super_admin';
/** The store surface these tests use; each concrete store is structurally assignable to it. */
type Store={
 prepare(ctx:SessionContext,input:unknown):Promise<{review:{actionId:string;reviewedDigest:string;review:unknown;consequence:string}}>;
 confirm(ctx:SessionContext,input:{actionId:string;reviewedDigest:string}):Promise<{kind:string;receipt:unknown}>;
 reopen(ctx:SessionContext,value:unknown):Promise<{kind:string}>;
 discard(ctx:SessionContext,input:{actionId:string}):Promise<{kind:string;receipt:{state:string}}>;
 list(ctx:SessionContext):Promise<{reviews:{actionId:string}[]}>;
};
type Kind={
 action:string;store:Store;choices:(ctx:SessionContext)=>Promise<unknown>;table:string;subjectKind:string;decided:(decision:Decision)=>string;
 create():Promise<string>;human(id:string,decision?:Decision):Record<string,unknown>;
 /** The item changes elsewhere after review (cancelled by its owner or decided by someone else). */
 elsewhere(id:string):Promise<unknown>;
 /** The native approval in the caller's transaction, returning its committed event. */
 nativeTx(tx:Tx,who:SessionContext,id:string):Promise<string>;
 /** The native service's own decision path for the same caller (no Assistant). */
 nativeDecide(who:SessionContext,id:string):Promise<unknown>;
};

let b:Base,subject:Person,manager:Person,hrPerson:Person,outsider:Person,subjectCtx:SessionContext,mgr:SessionContext,hr:SessionContext,stranger:SessionContext,claimTypeId:string,seq:number;
/** HR calendar days from the repository's HR date owner. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
const groupOf=(base:Base)=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
const group=()=>groupOf(b);
/** Only the subject sits in department A, so a department-A attendance workflow resolves one direct manager. */
const hire=(name:string,departmentId?:string,base:Base=b)=>hireEmployee(groupOf(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:departmentId??base.deptB,employmentType:'full_time',hiredOn:hiredOn()});
async function login(personId:string,role:Role,base:Base=b):Promise<SessionContext>{
 const userId=await createAppUser(base.tenantId,personId,role);await grantAssistant(groupOf(base),{appUserId:userId});
 return {...await entitledCtx(base,[role]),userId,personId,grants:[{role,companyId:null}]};
}
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)') is not null as ok`);expect(installed.ok,'Migration 0671 must be installed.').toBe(true);});
afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-assigned-decision-custody-key-1234');
 await resetDb();b=await seedBase();seq=0;for(const code of ['assistant','claims','attendance','toil'])await setModule(b.tenantId,code,'active');
 subject=await hire('Fictional Decision Subject',b.deptA);manager=await hire('Fictional Line Manager');hrPerson=await hire('Fictional HR Approver');outsider=await hire('Fictional Unrelated Colleague');
 await setReportingLine(group(),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:hiredOn()});
 await setCompensation(group(),{employmentId:subject.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:hiredOn()});
 await setToilPolicy(group(),{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});
 claimTypeId=(await createClaimType(group(),{code:'FIC-DECIDE',name:'Fictional decidable travel',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
 subjectCtx=await login(subject.personId,'employee');mgr=await login(manager.personId,'manager');hr=await login(hrPerson.personId,'hr_admin');stranger=await login(outsider.personId,'employee');
});

const KINDS:Record<'claim'|'attendance'|'toil',Kind>={
 claim:{action:ASSIGNED_CLAIM_DECISION_ACTION,store:claimDecisionReviews,choices:readClaimDecisionChoices,table:'claim_request',subjectKind:'claim_request',decided:d=>'claim-request.'+d,
  async create(){return (await submitClaim(subjectCtx,{employmentId:subject.employmentId,claimTypeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional taxi fare'})).id;},
  human:(id,decision='approved')=>({action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision,...decision==='rejected'?{note:'Fictional explicit rejection reason'}:{}}),
  elsewhere:id=>cancelClaim(subjectCtx,id),
  async nativeTx(tx,who,id){return (await decideClaimTx(tx,who,{claimRequestId:id,decision:'approve'})).eventId;},
  nativeDecide:(who,id)=>decideClaim(who,{claimRequestId:id,decision:'approve'})},
 attendance:{action:ASSIGNED_ATTENDANCE_DECISION_ACTION,store:attendanceDecisionReviews,choices:readAttendanceDecisionChoices,table:'attendance_correction',subjectKind:'attendance_correction',decided:d=>'attendance-correction.'+d,
  // A future planned overtime request (deferred approval: no attendance day is needed or written).
  async create(){return (await requestAttendanceCorrection(subjectCtx,{employmentId:subject.employmentId,date:calendarDate(7+seq++),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Fictional planned release work',requestKind:'self_overtime'})).correctionId;},
  human:(id,decision='approved')=>({action:ASSIGNED_ATTENDANCE_DECISION_ACTION,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision,...(decision==='rejected'?{note:'Fictional explicit rejection reason'}:{})}),
  elsewhere:id=>decideAttendanceCorrection(group(),{correctionId:id,decision:'approved'}),
  async nativeTx(tx,who,id){await decideAttendanceCorrection(who,{correctionId:id,decision:'approved'},tx);const [row]=await tx.execute<{id:string}>(sql`select id from public.domain_event where aggregate_id=${id}::uuid and event_type='attendance-correction.approved' order by id desc limit 1`);return row.id;},
  nativeDecide:(who,id)=>decideAttendanceCorrection(who,{correctionId:id,decision:'approved'})},
 toil:{action:ASSIGNED_TOIL_DECISION_ACTION,store:toilDecisionReviews,choices:readToilDecisionChoices,table:'replacement_leave_request',subjectKind:'replacement_leave_request',decided:d=>'replacement-leave-request.'+d,
  async create(){const date=calendarDate(-3-seq++);await setRestDay(group(),{employmentId:subject.employmentId,shiftDate:date});
   return (await submitReplacementLeaveRequest(subjectCtx,{employmentId:subject.employmentId,unit:'day',lines:[{workedDate:date,days:1}],reason:'Fictional rest-day release support',today:todayInKualaLumpur()})).requestId;},
  human:(id,decision='approved')=>({action:ASSIGNED_TOIL_DECISION_ACTION,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision,note:'Fictional approver note'}),
  elsewhere:id=>cancelOwnReplacementLeaveRequest(subjectCtx,{requestId:id}),
  async nativeTx(tx,who,id){return (await decideReplacementLeaveRequestTx(tx,who,{requestId:id,decision:'approved'})).eventId;},
  nativeDecide:(who,id)=>decideReplacementLeaveRequest(who,{requestId:id,decision:'rejected'})},
};
const receiptOf=(done:{kind:string;receipt:unknown})=>(done.receipt as {receipt:unknown}).receipt;
async function native(k:Kind,id:string){
 const [row]=await owner.db.execute<{status:string}>(sql`select status::text as status from ${sql.raw('public.'+k.table)} where id=${id}::uuid`);
 const events=await owner.db.execute<{id:string;event_type:string;actor_id:string|null}>(sql`select id,event_type,actor_id from public.domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${id}::uuid order by id`);
 return {status:row?.status,events:Array.from(events)};
}
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.action_kind,r.state,r.user_id,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_kind,r.receipt_subject_id,r.receipt_event_id,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

describe.each(['claim','attendance','toil'] as const)('ADR-0151 assigned %s decision custody',name=>{
 const k=()=>KINDS[name];
 const prepare=async(who:SessionContext,value:unknown)=>(await k().store.prepare(who,value)).review;
 const confirm=(r:{actionId:string;reviewedDigest:string},who:SessionContext)=>k().store.confirm(who,{actionId:r.actionId,reviewedDigest:r.reviewedDigest});

 it.each(['approved','rejected'] as const)('decides %s exactly once across duplicate deliveries and completes with that event',async decision=>{
  const id=await k().create(),before=await native(k(),id);expect(before.status).toBe('pending');
  expect(await k().choices(mgr)).toMatchObject({kind:'choices',items:[{subjectId:id,employmentId:subject.employmentId,employeeName:'Fictional Decision Subject'}]});
  const r=await prepare(mgr,k().human(id,decision));expect(await native(k(),id)).toEqual(before);
  expect(r.review).toMatchObject({subjectId:id,employmentId:subject.employmentId,employeeName:'Fictional Decision Subject'});
  expect(await custody(r.actionId)).toMatchObject({action_kind:k().action,state:'awaiting_confirmation',user_id:mgr.userId,person_id:manager.personId,employment_id:subject.employmentId,company_id:b.companyId,
   decision_subject_person_id:subject.personId,receipt_subject_kind:k().subjectKind,receipt_subject_id:id,receipt_event_id:null,bodies:1});
  const [first,second]=await Promise.all([confirm(r,mgr),confirm(r,mgr)]);
  expect(first).toEqual(second);expect(first.kind).toBe('completed');
  const after=await native(k(),id),decided=after.events.filter(e=>e.event_type===k().decided(decision));
  expect(after.status).toBe(decision);expect(decided).toHaveLength(1);expect(decided[0].actor_id).toBe(mgr.userId);
  expect(after.events.filter(e=>/\.(approved|rejected)$/.test(e.event_type))).toHaveLength(1);
  expect(receiptOf(first)).toEqual({kind:'decided',subjectId:id,eventId:decided[0].id,employmentId:subject.employmentId,decision,recorded:'final',currentStatus:decision});
  expect(await custody(r.actionId)).toMatchObject({state:'completed',receipt_event_id:decided[0].id,intent_digest:null,reviewed_digest:null,bodies:0});
  if(name==='claim'){const [claim]=await owner.db.select({decidedBy:schema.claimRequest.decidedByEmploymentId}).from(schema.claimRequest).where(eq(schema.claimRequest.id,id));expect(claim.decidedBy).toBe(manager.employmentId);}
  // A later identical confirmation and a reopen read the canonical receipt and never decide again.
  expect(await confirm(r,mgr)).toEqual(first);expect(await k().store.reopen(mgr,r.actionId)).toEqual(first);
  await expect(k().store.discard(mgr,{actionId:r.actionId})).rejects.toThrow();expect(await native(k(),id)).toEqual(after);
 });

 it('refuses after the item changed elsewhere since the review, writing nothing, and still allows discard',async()=>{
  const id=await k().create(),r=await prepare(mgr,k().human(id,'rejected'));await k().elsewhere(id);const before=await native(k(),id);expect(before.status).not.toBe('pending');
  await expect(confirm(r,mgr)).rejects.toThrow();await expect(k().store.reopen(mgr,r.actionId)).rejects.toThrow();
  expect(await native(k(),id)).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
  expect((await k().store.discard(mgr,{actionId:r.actionId})).receipt.state).toBe('discarded');expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0});
 });

 it('refuses a mismatched subject, another login, and a foreign tenant',async()=>{
  const id=await k().create(),before=await native(k(),id);
  // Mismatched references are refused BEFORE any valid review exists, so the refusals are not the uniqueness rule.
  await expect(prepare(mgr,{...k().human(id),employmentId:manager.employmentId})).rejects.toThrow();
  await expect(prepare(mgr,{...k().human(id),employmentId:outsider.employmentId})).rejects.toThrow();
  await expect(prepare(mgr,{...k().human(id),subjectId:randomUUID()})).rejects.toThrow();
  const r=await prepare(mgr,k().human(id));
  await expect(confirm({actionId:r.actionId,reviewedDigest:'0'.repeat(64)},mgr)).rejects.toThrow();
  const second=await login(manager.personId,'manager');
  await expect(confirm(r,second)).rejects.toThrow();await expect(k().store.reopen(second,r.actionId)).rejects.toThrow();
  await expect(k().store.discard(second,{actionId:r.actionId})).rejects.toThrow();expect((await k().store.list(second)).reviews).toEqual([]);
  const foreign=await seedBase();for(const code of ['assistant','claims','attendance','toil'])await setModule(foreign.tenantId,code,'active');
  const foreignHr=await login((await hire('Fictional Foreign HR Approver',undefined,foreign)).personId,'hr_admin',foreign);
  await expect(confirm(r,foreignHr)).rejects.toThrow();await expect(k().store.reopen(foreignHr,r.actionId)).rejects.toThrow();
  await expect(k().store.discard(foreignHr,{actionId:r.actionId})).rejects.toThrow();expect((await k().store.list(foreignHr)).reviews).toEqual([]);
  await expect(prepare(foreignHr,k().human(id))).rejects.toThrow();
  expect(await native(k(),id)).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
 });

 it('refuses a caller without decision authority at preparation',async()=>{
  const id=await k().create(),before=await native(k(),id);
  expect(await k().choices(stranger)).toMatchObject({kind:'choices',items:[]});
  await expect(prepare(stranger,k().human(id))).rejects.toThrow();expect((await k().store.list(stranger)).reviews).toEqual([]);
  expect(await native(k(),id)).toEqual(before);
 });

 it('never lets the decider decide their own request, even as super_admin, in the adapter or in SQL',async()=>{
  const self=await login(subject.personId,'super_admin'),id=await k().create(),before=await native(k(),id);
  expect(await k().choices(self)).toMatchObject({kind:'choices',items:[]});
  await expect(prepare(self,k().human(id))).rejects.toThrow();expect((await k().store.list(self)).reviews).toEqual([]);
  // The SQL owner refuses independently of the adapter: own subject person, a misnamed subject person, and a
  // decider person that is not the login's person.
  const call=(who:SessionContext,person:string|null,subjectPerson:string)=>withTenant(who,tx=>tx.execute(sql`select app.assistant_assigned_review_prepare(${k().action},${randomUUID()}::uuid,${person}::uuid,${subject.employmentId}::uuid,${b.companyId}::uuid,${subjectPerson}::uuid,${id}::uuid,${'a'.repeat(64)},${'b'.repeat(64)},${'0123456789abcdef'},${'fictional-wrapped-key'},${'fictional-ciphertext'}) as review`));
  await expect(call(self,subject.personId,subject.personId)).rejects.toThrow();
  await expect(call(self,subject.personId,manager.personId)).rejects.toThrow();
  await expect(call(self,manager.personId,subject.personId)).rejects.toThrow();
  await expect(call(self,null,subject.personId)).rejects.toThrow();
  // Control: the same call shape is accepted for a different decider, so the refusals above are the self rule.
  await expect(call(mgr,manager.personId,subject.personId)).resolves.toBeDefined();
  const [held]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_own_leave_review where user_id=${self.userId}::uuid`);expect(held.n).toBe(0);
  expect(await native(k(),id)).toEqual(before);
  // Non-vacuity: the native service itself still lets a super_admin decide their own item; only the Assistant refuses.
  await k().nativeDecide(self,id);expect((await native(k(),id)).status).not.toBe('pending');
 });

 it('rechecks the Assistant grant on confirmation but still lets the decider discard',async()=>{
  const id=await k().create(),r=await prepare(mgr,k().human(id));await revokeAssistant(group(),{appUserId:mgr.userId!});const before=await native(k(),id);
  await expect(confirm(r,mgr)).rejects.toThrow();await expect(k().store.reopen(mgr,r.actionId)).rejects.toThrow();expect(await native(k(),id)).toEqual(before);
  expect((await k().store.list(mgr)).reviews.map(row=>row.actionId)).toEqual([r.actionId]);
  expect((await k().store.discard(mgr,{actionId:r.actionId})).receipt.state).toBe('discarded');
  expect(await custody(r.actionId)).toMatchObject({state:'discarded',intent_digest:null,reviewed_digest:null,bodies:0});expect(await native(k(),id)).toEqual(before);
 });

 it('lets two approvers each hold one pending review of the same item, but not one approver two',async()=>{
  const id=await k().create(),mine=await prepare(mgr,k().human(id,'approved')),theirs=await prepare(hr,k().human(id,'rejected'));
  await expect(prepare(mgr,k().human(id,'rejected'))).rejects.toThrow();
  expect(await custody(mine.actionId)).toMatchObject({state:'awaiting_confirmation',user_id:mgr.userId,receipt_subject_id:id});
  expect(await custody(theirs.actionId)).toMatchObject({state:'awaiting_confirmation',user_id:hr.userId,receipt_subject_id:id});
  expect((await k().store.list(mgr)).reviews.map(row=>row.actionId)).toEqual([mine.actionId]);expect((await k().store.list(hr)).reviews.map(row=>row.actionId)).toEqual([theirs.actionId]);
  expect((await confirm(mine,mgr)).kind).toBe('completed');
  await expect(confirm(theirs,hr)).rejects.toThrow();
  const after=await native(k(),id);expect(after.status).toBe('approved');
  expect(after.events.filter(e=>e.event_type===k().decided('approved'))).toHaveLength(1);expect(after.events.filter(e=>e.event_type===k().decided('rejected'))).toHaveLength(0);
  expect(await custody(theirs.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null});
  expect((await k().store.discard(hr,{actionId:theirs.actionId})).receipt.state).toBe('discarded');
  await expect(prepare(mgr,k().human(id,'approved'))).rejects.toThrow();
 });

 it('refuses a decision event committed in an earlier transaction as completion proof',async()=>{
  const id=await k().create(),r=await prepare(mgr,k().human(id,'approved')),eventId=await withTenant(mgr,tx=>k().nativeTx(tx,mgr,id));
  await expect(withTenant(mgr,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${k().action},${r.reviewedDigest},${eventId}::uuid)`))).rejects.toThrow();
  // The own-review family never accepts an assigned kind at all.
  await expect(withTenant(mgr,tx=>tx.execute(sql`select app.assistant_generic_review_complete(${r.actionId}::uuid,${k().action},${r.reviewedDigest},${eventId}::uuid)`))).rejects.toThrow();
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
 });

 it('links the completed review to its native outcome only for the deciding login',async()=>{
  const id=await k().create(),r=await prepare(mgr,k().human(id,'approved')),done=await confirm(r,mgr);expect(done.kind).toBe('completed');
  const reference={source:'review',action:k().action,actionId:r.actionId};
  const outcome=await withTenant(mgr,tx=>readCompletedNativeOutcomeTx(tx,mgr,reference));
  expect(outcome.evidence).toEqual({action:k().action,sourceId:r.actionId,eventId:(receiptOf(done) as {eventId:string}).eventId,currentStatus:'approved'});
  expect(Number.isFinite(Date.parse(outcome.sourceExpiresAt))).toBe(true);
  await expect(withTenant(hr,tx=>readCompletedNativeOutcomeTx(tx,hr,reference))).rejects.toThrow();
  await expect(withTenant(subjectCtx,tx=>readCompletedNativeOutcomeTx(tx,subjectCtx,reference))).rejects.toThrow();
 });
});

describe('ADR-0151 assigned claim decision: another tenant\'s item',()=>{
 it('cannot be prepared by an approver or HR administrator of this tenant',async()=>{
  const foreign=await seedBase();for(const code of ['assistant','claims'])await setModule(foreign.tenantId,code,'active');
  const typeId=(await createClaimType(groupOf(foreign),{code:'FIC-FOREIGN',name:'Fictional foreign travel',defaultTaxable:false,requiresReceipt:false})).id;
  await setClaimPolicy(groupOf(foreign),{claimTypeId:typeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
  const claimant=await hire('Fictional Foreign Claimant',undefined,foreign),claimantCtx=await login(claimant.personId,'employee',foreign);
  const foreignClaim=(await submitClaim(claimantCtx,{employmentId:claimant.employmentId,claimTypeId:typeId,amount:10,incurredOn:todayInKualaLumpur(),description:'Fictional foreign fare'})).id;
  const human={action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:claimant.employmentId,subjectId:foreignClaim,decision:'approved'};
  await expect(claimDecisionReviews.prepare(mgr,human)).rejects.toThrow();await expect(claimDecisionReviews.prepare(hr,human)).rejects.toThrow();
  const [row]=await owner.db.select({status:schema.claimRequest.status}).from(schema.claimRequest).where(eq(schema.claimRequest.id,foreignClaim));expect(row.status).toBe('pending');
  expect((await claimDecisionReviews.list(hr)).reviews).toEqual([]);
 });
});

describe('ADR-0151 assigned decision reviews after a login relink',()=>{
 /** Modelled on the leave-decision custody (0655 index/discard bind the login's CURRENT person, ADR-0131).
  * NOTE: expected to fail today: 0671 assistant_assigned_reviews_index and the discard path of
  * assistant_assigned_review_read filter by login only, not by the login's current person. */
 it('hides and refuses the former person\'s review exactly like an unknown action, and restores it after relinking back',async()=>{
  const id=await KINDS.claim.create(),r=(await claimDecisionReviews.prepare(mgr,KINDS.claim.human(id))).review;
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional relinked person',primaryEmail:randomUUID()+'@fixture.test'}).returning({id:schema.person.id});
  await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,mgr.userId!));const relinked={...mgr,personId:p.id};
  await expect(claimDecisionReviews.confirm(relinked,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();
  expect((await claimDecisionReviews.list(relinked)).reviews).toEqual([]);
  const refusal=async(actionId:string)=>{try{await claimDecisionReviews.discard(relinked,{actionId});}catch(error){return error;}throw Error('Expected a generic refusal');};
  const former=await refusal(r.actionId),unknown=await refusal(randomUUID());expect(String(former)).toBe(String(unknown));
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
  await owner.db.update(schema.appUser).set({personId:manager.personId}).where(eq(schema.appUser.id,mgr.userId!));
  expect((await claimDecisionReviews.list(mgr)).reviews.map(row=>row.actionId)).toEqual([r.actionId]);
  expect((await claimDecisionReviews.discard(mgr,{actionId:r.actionId})).receipt.state).toBe('discarded');
 });
});

describe('ADR-0151 assigned attendance decision in a multi-level workflow',()=>{
 /** Existing native fixture shape (test/attendance-workflow.test.ts): direct manager, then HR, frozen at submission.
  * NOTE: this currently fails at the manager's confirmation. The adapter calls decideAttendanceCorrection without
  * expectedStageIndex (core/assistant-actions/assigned-decision-sources.ts, confirmAssignedAttendanceSourceTx),
  * and decideAttendanceWorkflowStageTx refuses any routed request whose expectedStageIndex differs from the
  * current stage (core/attendance-workflow.ts). The expectations below are the intended behaviour. */
 it('records a non-final level as recorded:level with the request still pending, then the final level settles it',async()=>{
  await saveAttendanceWorkflow(group(),{companyId:b.companyId,code:'FIC_OT_TWO',name:'Fictional two-level overtime',description:'Fictional route',applicationType:'self_overtime',priority:100,criteria:{departmentIds:[b.deptA]},
   stages:[{name:'Manager review',level:{kind:'direct_manager',employmentId:null,alternates:[]}},{name:'HR review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}],active:true});
  await setAttendanceWorkflowEnabled(group(),b.companyId,'self_overtime',true);
  const k=KINDS.attendance,id=await k.create();
  const [flow]=await owner.db.select({stages:schema.attendanceWorkflowRequest.stages}).from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId,id));
  expect(flow?.stages).toHaveLength(2);
  const first=(await k.store.prepare(mgr,k.human(id,'approved'))).review,level=await k.store.confirm(mgr,{actionId:first.actionId,reviewedDigest:first.reviewedDigest});
  expect(level.kind).toBe('completed');
  const afterLevel=await native(k,id),stage=afterLevel.events.filter(e=>e.event_type==='attendance-workflow.stage.decided');
  expect(afterLevel.status).toBe('pending');expect(stage).toHaveLength(1);expect(stage[0].actor_id).toBe(mgr.userId);
  expect(afterLevel.events.filter(e=>e.event_type==='attendance-correction.approved')).toHaveLength(0);
  expect(receiptOf(level)).toEqual({kind:'decided',subjectId:id,eventId:stage[0].id,employmentId:subject.employmentId,decision:'approved',recorded:'level',currentStatus:'pending'});
  expect(await custody(first.actionId)).toMatchObject({state:'completed',receipt_event_id:stage[0].id,bodies:0});
  const last=(await k.store.prepare(hr,k.human(id,'approved'))).review,final=await k.store.confirm(hr,{actionId:last.actionId,reviewedDigest:last.reviewedDigest});
  const settled=await native(k,id),approved=settled.events.filter(e=>e.event_type==='attendance-correction.approved');
  expect(settled.status).toBe('approved');expect(approved).toHaveLength(1);
  expect(receiptOf(final)).toEqual({kind:'decided',subjectId:id,eventId:approved[0].id,employmentId:subject.employmentId,decision:'approved',recorded:'final',currentStatus:'approved'});
  // The manager's level receipt still names its own level event, now reading the settled status.
  expect(receiptOf(await k.store.reopen(mgr,first.actionId) as {kind:string;receipt:unknown})).toEqual({kind:'decided',subjectId:id,eventId:stage[0].id,employmentId:subject.employmentId,decision:'approved',recorded:'level',currentStatus:'approved'});
 });
});

describe('claim rejection human reason and independent reviewed decisions',()=>{
 it('requires a reason for new rejections, binds and records it on the native event',async()=>{
  const k=KINDS.claim,id=await k.create(),content=k.human(id,'rejected');
  await expect(claimDecisionReviews.prepare(mgr,{...content,note:undefined})).rejects.toThrow();
  await expect(claimDecisionReviews.prepare(mgr,{...content,note:'   '})).rejects.toThrow();
  await expect(claimDecisionReviews.prepare(mgr,{...k.human(id),note:'Approval note would be lost'})).rejects.toThrow();
  const result=await claimDecisionReviews.prepare(mgr,{...content,note:'Original human rejection reason'});
  expect(result.review.content.note).toBe('Original human rejection reason');
  await claimDecisionReviews.confirm(mgr,result.review);
  const [event]=await owner.db.execute<{payload:{rejectReason:string}}>(sql`select payload from public.domain_event where aggregate_id=${id}::uuid and event_type='claim-request.rejected'`);
  expect(event.payload.rejectReason).toBe('Original human rejection reason');
 });
 it('reads and completes an actual old-writer sealed no-reason rejection without changing its digest',async()=>{
  const c=AssignedClaimDecision,legacy=createGenericAssignedReviewStore({action:c.action,human:c.Human.extend({note:z.never().optional()}),consequence:c.consequence,prepared:c.Prepared,completed:c.Completed,retired:c.Retired,index:c.Index,indexKind:c.indexKind,withSubject:withAssignedClaimSubjectTx,prepare:(tx,ctx,human)=>prepareAssignedClaimSourceTx(tx,ctx,c.Human.parse(human)),confirm:(tx,ctx,human,digest)=>confirmAssignedClaimSourceTx(tx,ctx,c.Human.parse(human),digest),reconcile:reconcileAssignedClaimSourceTx,unavailable:assignedDecisionUnavailable});
  const id=await KINDS.claim.create(),old=await legacy.prepare(mgr,{...KINDS.claim.human(id,'rejected'),note:undefined});
  const reopened=await claimDecisionReviews.reopen(mgr,old.review.actionId);expect(reopened.kind).toBe('prepared');
  if(reopened.kind!=='prepared')throw Error('Expected original saved review');
  expect(reopened.review.reviewedDigest).toBe(old.review.reviewedDigest);expect(reopened.review.content.note).toBeUndefined();
  await claimDecisionReviews.confirm(mgr,old.review);
  const [event]=await owner.db.execute<{payload:Record<string,unknown>|null}>(sql`select payload from public.domain_event where aggregate_id=${id}::uuid and event_type='claim-request.rejected'`);
  expect(event.payload?.rejectReason).toBeUndefined();
 });
 it('keeps the first native commit when a later selected review loses authority; reopening never duplicates it',async()=>{
  const firstId=await KINDS.claim.create(),secondId=await KINDS.claim.create(),first=await claimDecisionReviews.prepare(mgr,KINDS.claim.human(firstId)),second=await claimDecisionReviews.prepare(mgr,KINDS.claim.human(secondId));
  await claimDecisionReviews.confirm(mgr,first.review);await revokeAssistant(group(),{appUserId:mgr.userId!});
  await expect(claimDecisionReviews.confirm(mgr,second.review)).rejects.toThrow();
  const [row]=await owner.db.execute<{first:string;second:string;count:number}>(sql`select (select status::text from public.claim_request where id=${firstId}::uuid) as first,(select status::text from public.claim_request where id=${secondId}::uuid) as second,(select count(*)::int from public.domain_event where aggregate_id=${firstId}::uuid and event_type='claim-request.approved') as count`);
  expect(row).toEqual({first:'approved',second:'pending',count:1});
 });
});

it('enforces the assigned kind own pause without browser scope while allowing private retirement',async()=>{
 const k=KINDS.claim,id=await k.create(),otherId=await k.create(),first=await claimDecisionReviews.prepare(mgr,k.human(id)),second=await claimDecisionReviews.prepare(mgr,k.human(otherId)),before=await native(k,id);
 await setAgentActionPause(group(),'approvals.claim.decide',true);
 await expect(claimDecisionReviews.confirm(mgr,first.review)).rejects.toThrow();await expect(claimDecisionReviews.reopen(mgr,first.review.actionId)).rejects.toThrow();expect(await native(k,id)).toEqual(before);
 expect((await claimDecisionReviews.discard(mgr,{actionId:first.review.actionId})).kind).toBe('retired');
 await setAgentActionPause(group(),'approvals.claim.decide',false);expect((await claimDecisionReviews.confirm(mgr,second.review)).kind).toBe('completed');
});
