/** AI v2 W2 slice 3 — an assigned approver's decision on someone else's claim or overtime request, prepared in chat, on
 * fictional data, over the real owners (approvals.claim.decide and approvals.attendance.decide).
 *
 * The chat preparer reads only the requests the native owner assigns the caller; the request is the one the approver's
 * own words name (or the number they chose), the decision and any rejection reason are their own words, and several
 * candidates are listed rather than chosen. A prepared card saves a sealed review and changes nothing; Confirm runs the
 * existing decision path with all its checks, exactly once. A non-assigned approver gets nothing, self-approval stays
 * refused, and tampered, re-signed, expired and someone else's cards are refused. Identity SQL, custody, RLS and the
 * claims and attendance services' effects are real. Authored for GitHub Actions (tests run there under the owner's
 * policy). */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {createClaimType,setClaimPolicy,submitClaim} from '../packs/claims/service';
import {requestAttendanceCorrection} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {issueProposal,type Proposal} from '../core/proposals/proposal';
import {prepareSuggestedProposal} from '../core/proposals/suggested';
import {decisionInWords,wordsNameEmployee,wordsNameDay} from '../core/proposals/assigned-decide';
import {confirmAssignedDecisionProposal,editAssignedDecisionProposal} from '../core/assistant-actions/assigned-decision-proposal-confirm';
import {claimDecisionReviews} from '../core/assistant-actions/assigned-decision-review-store';
import {ASSIGNED_CLAIM_DECISION_ACTION} from '../lib/assistant-actions/assigned-decision-contract';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type Role='employee'|'manager'|'hr_admin';
let b:Base,siti:Person,wei:Person,ravi:Person,daniel:Person,aina:Person,sitiCtx:SessionContext,weiCtx:SessionContext,mgr:SessionContext,otherMgr:SessionContext,stranger:SessionContext,claimTypeId:string;
/** HR calendar days from the repository's HR date owner. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string,departmentId?:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:departmentId??b.deptB,employmentType:'full_time',hiredOn:hiredOn()});
async function login(personId:string,role:Role):Promise<SessionContext>{
 const userId=await createAppUser(b.tenantId,personId,role);await grantAssistant(group(),{appUserId:userId});
 return {...await entitledCtx(b,[role]),userId,personId,grants:[{role,companyId:null}]};
}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-assigned-decision-chat-key-12345678');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();b=await seedBase();for(const code of ['assistant','claims','attendance'])await setModule(b.tenantId,code,'active');
 // Siti and Wei report to Ravi; Daniel manages nobody here; Aina is an unrelated colleague.
 siti=await hire('Siti Fictional',b.deptA);wei=await hire('Wei Fictional');ravi=await hire('Ravi Fictional');daniel=await hire('Daniel Fictional');aina=await hire('Aina Fictional');
 for(const report of [siti,wei])await setReportingLine(group(),{subordinateEmploymentId:report.employmentId,managerEmploymentId:ravi.employmentId,lineType:'administrative',validFrom:hiredOn()});
 claimTypeId=(await createClaimType(group(),{code:'FIC-CHAT-DECIDE',name:'Fictional Travel Claim',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:calendarDate(-30)});
 sitiCtx=await login(siti.personId,'employee');weiCtx=await login(wei.personId,'employee');mgr=await login(ravi.personId,'manager');
 otherMgr=await login(daniel.personId,'manager');stranger=await login(aina.personId,'employee');
});

const claimOf=async(who:SessionContext,person:Person,amount:number,incurredOn=todayInKualaLumpur())=>(await submitClaim(who,{employmentId:person.employmentId,claimTypeId,amount,incurredOn,description:'Fictional taxi fare'})).id;
const overtimeOf=async(who:SessionContext,person:Person,date:string)=>(await requestAttendanceCorrection(who,{employmentId:person.employmentId,date,plannedStartTime:'18:00',plannedEndTime:'21:00',requestedOtMinutes:180,reason:'Fictional planned release work',requestKind:'self_overtime'})).correctionId;
async function claimRow(id:string){const [row]=await owner.db.execute<{status:string}>(sql`select status::text as status from public.claim_request where id=${id}::uuid`);return row?.status;}
async function attendanceRow(id:string){const [row]=await owner.db.execute<{status:string;reject_reason:string|null}>(sql`select status::text as status,reject_reason from public.attendance_correction where id=${id}::uuid`);return row;}
const decisions=async(id:string)=>Array.from(await owner.db.execute<{event_type:string;actor_id:string|null;reason:string|null}>(sql`select event_type,actor_id,payload->>'rejectReason' as reason from public.domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${id}::uuid and event_type in ('claim-request.approved','claim-request.rejected','attendance-correction.approved','attendance-correction.rejected') order by id`));
const reviews=async()=>Array.from(await owner.db.execute<{id:string;state:string;action_kind:string}>(sql`select id,state,action_kind from app.assistant_own_leave_review where action_kind in ('approvals.claim.decide','approvals.attendance.decide')`));
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
/** The same card signed again with a change: integrity holds, so only the owner's own checks can refuse it. */
const resign=(proposal:Proposal,change:Record<string,unknown>)=>{const {kind:_kind,version:_version,id:_id,...draft}=clone(proposal.body);return issueProposal({...draft,...change} as never);};
async function card(who:SessionContext,action:string,details:Record<string,unknown>,words:string):Promise<Proposal>{
 const outcome=await prepareSuggestedProposal(who,action,details,words);
 if(outcome?.kind!=='proposal')throw Error('Fictional decision was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}

describe('reading the approver\'s own words',()=>{
 it('takes approve or reject only when said, never negated, never both and never in bulk',()=>{
  expect([decisionInWords('approve Siti\'s claim'),decisionInWords('Reject the overtime for Ravi on Tuesday'),decisionInWords('tolak tuntutan Siti'),decisionInWords('lulus tuntutan Siti')])
   .toEqual(['approved','rejected','rejected','approved']);
  for(const words of ['do not approve Siti\'s claim','don\'t reject it','approve or reject?','jangan lulus','approve all pending claims','Siti\'s claim',undefined])
   expect(decisionInWords(words),String(words)).toBeNull();
 });
 it('matches a name and a weekday locally, as whole words only',()=>{
  expect(wordsNameEmployee('approve Siti\'s claim','Siti Fictional')).toBe(true);
  expect(wordsNameEmployee('approve Sitiawan\'s claim','Siti Fictional')).toBe(false);
  expect(wordsNameEmployee('approve the claim','Siti Fictional')).toBe(false);
  expect(wordsNameEmployee('approve Nur Aisyah binti Ahmad\'s claim','Nur Aisyah binti Ahmad')).toBe(true);
  const today='2026-11-05';
  expect(wordsNameDay('the overtime on Tuesday','2026-11-03',today)).toBe(true);
  expect(wordsNameDay('the overtime on Tuesday','2026-11-04',today)).toBe(false);
  expect(wordsNameDay('the overtime on Tuesday','2026-10-20',today)).toBe(false);
  expect(wordsNameDay('the overtime on 3 Nov','2026-11-03',today)).toBe(true);
 });
});

describe('an assigned claim decision from chat',()=>{
 it('prepares the approval of the one claim the approver names, changes nothing, and decides exactly once on Confirm',async()=>{
  const id=await claimOf(sitiCtx,siti,42.5);
  const proposal=await card(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'approve Siti\'s claim');
  expect(proposal.body).toMatchObject({what:{action:'approvals.claim.decide',effect:'decide',entity:'claim_approval_item',selectors:{incurredOn:todayInKualaLumpur(),decision:'approved'}},
   forWhom:{subject:'assigned_request',subjectId:id},authority:{kind:'person',userId:mgr.userId,personId:ravi.personId},
   facts:{claimType:'Fictional Travel Claim',incurredOn:todayInKualaLumpur(),amount:'42.50',decision:'approved',outcome:'approval_if_native_checks_pass'},
   review:{route:'/assistant/approvals'}});
  expect(proposal.body.review.href).toBe(`/assistant/approvals?flow=claims&review=${proposal.body.review.reference}`);
  expect(proposal.body.checks.map(check=>check.check)).toEqual(['ai_controls_unpaused','assigned_approver_current','not_own_request','request_still_pending']);
  // The card names no one: the applicant stays in the sealed review.
  expect(JSON.stringify(proposal)).not.toContain('Siti');
  // Nothing happens without Confirm.
  expect(await claimRow(id)).toBe('pending');expect(await decisions(id)).toEqual([]);
  expect(await reviews()).toEqual([expect.objectContaining({id:proposal.body.review.reference,state:'awaiting_confirmation'})]);
  for(const confirm of [false,'true',1,undefined])expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await claimRow(id)).toBe('pending');expect(await decisions(id)).toEqual([]);
  const first=await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true});
  expect(first).toEqual({kind:'decided',action:'approvals.claim.decide',decision:'approved',recorded:'final'});
  expect(await claimRow(id)).toBe('approved');
  // A second press replays the recorded decision; the claims service decided once, as the approver.
  expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true})).toEqual(first);
  expect(await decisions(id)).toEqual([{event_type:'claim-request.approved',actor_id:mgr.userId,reason:null}]);
 });

 it('rejects only with the approver\'s own reason, which reaches the claims service and never the card',async()=>{
  const id=await claimOf(sitiCtx,siti,18);
  // No reason, or a reason the approver never said: nothing is prepared or saved.
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'reject Siti\'s claim')).toMatchObject({kind:'ask',missing:['reason']});
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{reason:'Duplicate of last week'},'reject Siti\'s claim')).toMatchObject({kind:'ask',missing:['reason']});
  expect(await reviews()).toEqual([]);
  const words='reject Siti\'s claim, the receipt is from last year';
  const proposal=await card(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{reason:'the receipt is from last year',decision:'approved'},words);
  expect(proposal.body.facts).toMatchObject({decision:'rejected',outcome:'rejection_if_confirmed',amount:'18.00'});
  expect(JSON.stringify(proposal)).not.toContain('receipt is from last year');
  expect(await claimRow(id)).toBe('pending');
  expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true})).toEqual({kind:'decided',action:'approvals.claim.decide',decision:'rejected',recorded:'final'});
  expect(await claimRow(id)).toBe('rejected');
  expect(await decisions(id)).toEqual([{event_type:'claim-request.rejected',actor_id:mgr.userId,reason:'the receipt is from last year'}]);
 });

 it('asks for the decision when the approver did not say it, whatever the model passes',async()=>{
  await claimOf(sitiCtx,siti,30);
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{decision:'approved'},'what about Siti\'s claim?')).toMatchObject({kind:'ask',missing:['decision']});
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'just approve all pending claims directly')).toBeNull();
  expect(await reviews()).toEqual([]);
 });

 it('lists several candidates in a fixed order instead of choosing, and prepares the number the approver says',async()=>{
  const older=await claimOf(sitiCtx,siti,12.3,calendarDate(-2)),newer=await claimOf(sitiCtx,siti,64,calendarDate(-1));
  await claimOf(weiCtx,wei,9.9,calendarDate(-3));
  const listed=await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'approve Siti\'s claim');
  expect(listed).toMatchObject({kind:'choose',more:0});
  if(listed?.kind!=='choose')throw Error('not listed');
  // Numbered in the assigned set's own order (date, then name): Wei's claim is 1, Siti's are 2 and 3.
  expect(listed.pending).toEqual([
   {request:2,applicant:'Siti Fictional',date:calendarDate(-2),claimType:'Fictional Travel Claim',amount:'12.30'},
   {request:3,applicant:'Siti Fictional',date:calendarDate(-1),claimType:'Fictional Travel Claim',amount:'64.00'}]);
  expect(await reviews()).toEqual([]);
  // A number the approver did not say is ignored; the one they said is prepared.
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{request:'3'},'approve Siti\'s claim')).toMatchObject({kind:'choose'});
  const proposal=await card(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{request:'3'},'approve number 3');
  expect(proposal.body.forWhom.subjectId).toBe(newer);
  expect(await claimRow(older)).toBe('pending');
  // Without a name or number nothing is identified, even with one candidate left on that date.
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{date:calendarDate(-2)},`approve the claim from ${calendarDate(-2)}`)).toMatchObject({kind:'choose',pending:[expect.objectContaining({request:2})]});
 });

 it('gives a non-assigned approver nothing, and the custody refuses them',async()=>{
  const id=await claimOf(sitiCtx,siti,42.5);
  for(const who of [otherMgr,stranger])expect(await prepareSuggestedProposal(who,ASSIGNED_CLAIM_DECISION_ACTION,{},'approve Siti\'s claim'),String(who.userId)).toBeNull();
  await expect(claimDecisionReviews.prepare(otherMgr,{action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:siti.employmentId,subjectId:id,decision:'approved'})).rejects.toThrow();
  expect(await reviews()).toEqual([]);expect(await claimRow(id)).toBe('pending');
 });

 it('keeps self-approval refused: the approver\'s own claim is never offered, prepared or decided',async()=>{
  const own=await claimOf(mgr,ravi,25);
  expect(await prepareSuggestedProposal(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'approve Ravi\'s claim')).toBeNull();
  await expect(claimDecisionReviews.prepare(mgr,{action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:ravi.employmentId,subjectId:own,decision:'approved'})).rejects.toThrow();
  // A card signed for the approver over their own claim, with a made-up review handle, decides nothing.
  const reference=randomUUID();
  const forged=issueProposal({what:{action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,entity:'claim_approval_item',effect:'decide',selectors:{incurredOn:todayInKualaLumpur(),decision:'approved'},reviewedDigest:'a'.repeat(64)},
   forWhom:{tenantId:b.tenantId,subject:'assigned_request',subjectId:own},authority:{kind:'person',tenantId:b.tenantId,userId:mgr.userId!,personId:ravi.personId},
   checks:[{check:'assigned_approver_current',owner:'core/approvals.ts#assertCanDecide',ruleVersion:null,result:'pass'}],
   review:{route:'/assistant/approvals',href:`/assistant/approvals?flow=claims&review=${reference}`,reference},
   facts:{decision:'approved',outcome:'approval_if_native_checks_pass'},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600_000).toISOString()});
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  // Its handle pointing at another flow is not a decision card at all.
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:resign(forged,{review:{route:'/assistant/approvals',href:`/assistant/approvals?flow=toil&review=${reference}`,reference}}),confirm:true})).toEqual({kind:'refused',reason:'wrong_action'});
  expect(await claimRow(own)).toBe('pending');expect(await decisions(own)).toEqual([]);
 });

 it('refuses tampered, re-signed, expired and someone else\'s cards before deciding anything',async()=>{
  const id=await claimOf(sitiCtx,siti,42.5);
  const proposal=await card(mgr,ASSIGNED_CLAIM_DECISION_ACTION,{},'approve Siti\'s claim');
  const tampered=clone(proposal);tampered.body.facts!.decision='rejected';tampered.body.what.selectors.decision='rejected';
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:tampered,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  // Re-signed with the other decision over the same sealed review: the custody holds the approver's own decision.
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:resign(proposal,{what:{...proposal.body.what,selectors:{...proposal.body.what.selectors,decision:'rejected'}},facts:{...proposal.body.facts,decision:'rejected',outcome:'rejection_if_confirmed'}}),confirm:true})).toEqual({kind:'refused',reason:'changed'});
  // Retargeted to another review route: not a decision card.
  const reference=proposal.body.review.reference;
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:resign(proposal,{review:{route:'/assistant/claims',href:'/assistant/claims?review='+reference,reference}}),confirm:true})).toEqual({kind:'refused',reason:'wrong_action'});
  // Pointed at someone else's request: the sealed review names another one.
  expect(await confirmAssignedDecisionProposal(mgr,{proposal:resign(proposal,{forWhom:{...proposal.body.forWhom,subjectId:randomUUID()}}),confirm:true})).toEqual({kind:'refused',reason:'changed'});
  for(const who of [otherMgr,stranger,sitiCtx])expect(await confirmAssignedDecisionProposal(who,{proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)+1000))).toEqual({kind:'refused',reason:'expired'});
  expect(editAssignedDecisionProposal(stranger,proposal)).toEqual({ok:false,reason:'authority_mismatch'});
  expect(await claimRow(id)).toBe('pending');expect(await decisions(id)).toEqual([]);
  // The genuine card still decides, and Edit opens its own review on the approvals review page.
  expect(editAssignedDecisionProposal(mgr,proposal)).toEqual({ok:true,href:proposal.body.review.href});
  expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true})).toMatchObject({kind:'decided',decision:'approved'});
 });
});

describe('an assigned overtime decision from chat',()=>{
 it('prepares the rejection of the overtime the approver names on its date, with their reason, and decides on Confirm',async()=>{
  const date=calendarDate(8),id=await overtimeOf(sitiCtx,siti,date);
  const words=`reject the overtime for Siti on ${date}, the release moved`;
  const proposal=await card(mgr,'approvals.attendance.decide',{date,reason:'the release moved'},words);
  expect(proposal.body).toMatchObject({what:{action:'approvals.attendance.decide',entity:'attendance_approval_item',selectors:{date,kind:'overtime',decision:'rejected'}},
   forWhom:{subjectId:id},facts:{startDate:date,endDate:date,plannedStart:'18:00',plannedEnd:'21:00',overtimeMinutes:180,decision:'rejected',outcome:'rejection_if_confirmed'}});
  expect(proposal.body.review.href).toBe(`/assistant/approvals?flow=attendance&review=${proposal.body.review.reference}`);
  expect(await attendanceRow(id)).toMatchObject({status:'pending',reject_reason:null});
  expect(await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true})).toMatchObject({kind:'decided',action:'approvals.attendance.decide',decision:'rejected'});
  expect(await attendanceRow(id)).toMatchObject({status:'rejected',reject_reason:'the release moved'});
  expect((await decisions(id)).map(row=>[row.event_type,row.actor_id])).toEqual([['attendance-correction.rejected',mgr.userId]]);
 });

 it('approves through the attendance service, and refuses a non-assigned approver and the requester themself',async()=>{
  const date=calendarDate(9),id=await overtimeOf(sitiCtx,siti,date);
  for(const who of [otherMgr,stranger,sitiCtx])expect(await prepareSuggestedProposal(who,'approvals.attendance.decide',{},'approve Siti\'s overtime')).toBeNull();
  const proposal=await card(mgr,'approvals.attendance.decide',{},'approve Siti\'s overtime');
  expect(proposal.body.facts).toMatchObject({decision:'approved',outcome:'attendance_decision_if_checks_pass'});
  expect(await attendanceRow(id)).toMatchObject({status:'pending'});
  const done=await confirmAssignedDecisionProposal(mgr,{proposal,confirm:true});
  expect(done).toMatchObject({kind:'decided',decision:'approved'});
  expect(await attendanceRow(id)).toMatchObject({status:done.kind==='decided'&&done.recorded==='final'?'approved':'pending'});
 });
});
