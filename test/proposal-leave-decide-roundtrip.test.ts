/** ADR-0170 step 2 — `approvals.leave.decide` proposals end to end on fictional data: prepared from the assigned
 * review's native checks as the approver, signed, verified against the approver's real cookie login, rendered
 * as a card and confirmed once on the existing review command (POST /api/assistant/module-actions). Refusals:
 * the self-approval ban, a manager the request is not assigned to, another login, tampering and expiry. Also
 * the harness: a scripted model's suggestion returns the proposal. Next cookies are a framework seam;
 * identity SQL, custody, RLS and leave effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import * as schema from '../db/schema';
import {handleConfiguredModuleActionBrowserCommand} from '../core/assistant-actions/module-action-server';
import {getSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {verifyProposal,type Proposal} from '../core/proposals/proposal';
import {leaveDecideReviewPackets,prepareLeaveDecideProposal,type LeaveDecideHumanInput} from '../core/proposals/leave-decide';
import {PROPOSAL_CARD_KEYS,renderProposalCard} from '../core/proposals/card';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Hired={uid:string;employmentId:string;personId:string};
let base:Base,applicant:Hired,manager:Hired,otherManager:Hired,date:string,requestId:string;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string,role:'employee'|'hr_admin'='employee'):Promise<Hired>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
const login=(who:Hired)=>{browser.selected=who.uid;vi.stubEnv('DEV_USER_ID',who.uid);return getSession();};
beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-leave-decide-proposal-key-123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 applicant=await hire('Fictional Decide Applicant');manager=await hire('Fictional Decide Manager');otherManager=await hire('Fictional Unassigned Manager');
 const otherReport=await hire('Fictional Other Report');
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:otherReport.employmentId,managerEmploymentId:otherManager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));date=next.toISOString().slice(0,10);
 requestId=(await requestLeave(await login(applicant),{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional decide reason'})).leaveRequestId;
 await login(manager);
});
async function currentStep(){const [step]=await owner.db.select({id:schema.leaveApprovalStep.id}).from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId,requestId)).orderBy(schema.leaveApprovalStep.stepIndex);return step?.id??null;}
async function human(decision:'approved'|'rejected'='approved'):Promise<LeaveDecideHumanInput>{return{leaveRequestId:requestId,currentStepId:await currentStep(),decision,rejectReason:decision==='rejected'?'Fictional rejection reason':null};}
async function status(){const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,requestId));return row.status;}
async function propose(decision:'approved'|'rejected'='approved'):Promise<Proposal>{
 const result=await prepareLeaveDecideProposal(await getSession(),await human(decision));
 if(result.kind!=='proposal')throw Error('Fictional fixture did not prepare a proposal.');return result.proposal;
}
async function post(packet:unknown){const response=await handleConfiguredModuleActionBrowserCommand(new Request('https://fixture.test/api/assistant/module-actions',
 {method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(packet)}));return{status:response.status,body:await response.json() as Record<string,any>};}

describe('approvals.leave.decide proposal round trip',()=>{
 it.each(['approved','rejected'] as const)('prepares a %s card from the native checks and records it once on the real review command',async decision=>{
  const proposal=await propose(decision);
  expect(proposal.body).toMatchObject({what:{action:'approvals.leave.decide',entity:'leave_approval_step',effect:'decide',selectors:{startDate:date,decision}},
   forWhom:{subject:'assigned_request',subjectId:requestId},authority:{kind:'person',userId:manager.uid,personId:manager.personId},review:{route:'/assistant/approvals'},
   facts:{leaveType:'Annual Leave',startDate:date,endDate:date,days:1,decision,balanceNow:10,othersAway:0}});
  expect(proposal.body.checks.map(check=>check.check)).toEqual(['ai_controls_unpaused','assigned_step_current']);
  // No name, reason or other private text rides on the proposal.
  expect(JSON.stringify(proposal)).not.toMatch(/Fictional/);
  const me=await getSession();expect(verifyProposal(proposal,me,new Date())).toEqual({ok:true,proposal});
  const card=renderProposalCard(proposal,me,new Date());if(!card.ok)throw Error('card refused');
  expect(Object.keys(card.card).sort()).toEqual([...PROPOSAL_CARD_KEYS]);
  expect(JSON.stringify({...card.card,review:card.card.review.route})).not.toMatch(UUID);
  expect(card.card.facts.find(fact=>fact.key==='decision')?.value).toBe(decision==='approved'?'Approve':'Reject');
  const packets=leaveDecideReviewPackets(proposal,me,new Date());if(!packets.ok)throw Error('packets refused: '+packets.reason);
  const reopened=await post(packets.packets.reopen);expect(reopened.status).toBe(200);
  expect({kind:reopened.body.kind,digest:reopened.body.review.reviewedDigest}).toEqual({kind:'prepared',digest:proposal.body.what.reviewedDigest});
  expect(await status()).toBe('pending');
  const first=await post(packets.packets.confirm);expect(first.status).toBe(200);expect(first.body.kind).toBe('completed');
  const again=await post(packets.packets.confirm);expect(again.body).toEqual(first.body);
  // The decision is recorded once; whether the request is final is the owner's outcome (a later step may remain).
  const final=proposal.body.facts?.outcome!=='step_decision_if_confirmed';
  expect(first.body.receipt.receipt).toMatchObject({decision,currentStatus:final?decision:'pending'});
  expect(await status()).toBe(final?decision:'pending');
 },60000);

 it('keeps the self-approval ban: an HR administrator gets a card for another\'s request but never for their own',async()=>{
  const hr=await hire('Fictional Deciding Administrator','hr_admin');
  const own=(await requestLeave(await login(hr),{employmentId:hr.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional own reason'})).leaveRequestId;
  const [ownStep]=await owner.db.select({id:schema.leaveApprovalStep.id}).from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId,own)).orderBy(schema.leaveApprovalStep.stepIndex);
  const self=await getSession();
  expect((await prepareLeaveDecideProposal(self,await human())).kind).toBe('proposal');
  expect(await prepareLeaveDecideProposal(self,{leaveRequestId:own,currentStepId:ownStep?.id??null,decision:'approved',rejectReason:null})).toEqual({kind:'unavailable'});
  const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,own));expect(row.status).toBe('pending');
 },60000);

 it('refuses a manager the request is not assigned to',async()=>{
  const other=await login(otherManager);
  expect(await prepareLeaveDecideProposal(other,await human())).toEqual({kind:'unavailable'});
  expect(await status()).toBe('pending');
 },60000);

 it('refuses another login, tampering and expiry before any packet; the review command records nothing for them',async()=>{
  const proposal=await propose(),me=await getSession();
  const forged=JSON.parse(JSON.stringify(proposal));forged.body.what.selectors.decision='rejected';
  expect(leaveDecideReviewPackets(forged,me,new Date())).toEqual({ok:false,reason:'signature'});
  expect(leaveDecideReviewPackets(proposal,me,new Date(Date.parse(proposal.body.expiresAt)))).toEqual({ok:false,reason:'expired'});
  const other=await login(otherManager);
  expect(leaveDecideReviewPackets(proposal,other,new Date())).toEqual({ok:false,reason:'authority_mismatch'});
  expect(renderProposalCard(proposal,other,new Date())).toEqual({ok:false,reason:'authority_mismatch'});
  const response=await post({action:'approvals.leave.decide',operation:'confirm',confirmation:{action:'approvals.leave.decide',contractVersion:1,actionId:proposal.body.review.reference,reviewedDigest:proposal.body.what.reviewedDigest}});
  expect(response.status===200?response.body.kind:'refused').not.toBe('completed');
  expect(await status()).toBe('pending');
 },60000);
});

describe('harness returns the proposal for the matching suggestion',()=>{
 const run=(question:string)=>getSession().then(ctx=>runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},
  model:scriptedModel([{calls:[{name:'suggest_action',args:{action:'approvals.leave.decide'}}]},{final:{reply:'It is ready for you to review on the approvals review page.',mode:'propose'}}]),
  memory:new InMemoryTaskMemoryStore()}));
 it('issues one decide proposal when the person asks to approve, and only a pointer otherwise',async()=>{
  const asked=await run('Please approve the leave request waiting for me.');
  expect(asked.suggestion).toMatchObject({action:'approvals.leave.decide',reviewRoute:'/assistant/approvals'});
  expect(asked.proposals.map(row=>row.body.what.action)).toEqual(['approvals.leave.decide']);
  expect(asked.proposals[0].body).toMatchObject({forWhom:{subjectId:requestId},what:{selectors:{decision:'approved'}}});
  // The proposal never reaches the model: the tool result it was sent names no handle or digest.
  expect(JSON.stringify(asked.trace)).not.toContain(asked.proposals[0].body.what.reviewedDigest);
  const neutral=await run('What leave requests are waiting for me?');
  expect(neutral.proposals).toEqual([]);
  expect(await status()).toBe('pending');
 },60000);
});
