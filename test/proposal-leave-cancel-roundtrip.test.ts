/** ADR-0170 step 2 — `leave.cancel` proposals end to end on fictional data, over both existing paths:
 * a PENDING request through the Assistant's own review command (POST /api/assistant/module-actions), and
 * APPROVED leave through the native /leave Cancel dates action (requestLeaveCancellationAction). Each is
 * prepared from the native checks, signed, verified against the person's real cookie login, rendered as a card
 * and confirmed only on its review route. Next cookies/navigation/cache are framework seams; identity SQL,
 * custody, RLS and leave effects are real. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,redirects:[] as string[]}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{browser.redirects.push(url);throw Object.assign(Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;'+url});},notFound:()=>{throw Error('NEXT_NOT_FOUND');}}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined,revalidateTag:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import * as schema from '../db/schema';
import {handleConfiguredModuleActionBrowserCommand} from '../core/assistant-actions/module-action-server';
import {requestLeaveCancellationAction} from '../app/leave/actions';
import {getSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {decideLeave,requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {verifyProposal,type Proposal} from '../core/proposals/proposal';
import {leaveCancelReviewPackets,prepareLeaveCancelProposal} from '../core/proposals/leave-cancel';
import {PROPOSAL_CARD_KEYS,renderProposalCard} from '../core/proposals/card';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,person:{uid:string;employmentId:string;personId:string},colleague:{uid:string;employmentId:string;personId:string},weekdays:string[];
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-leave-cancel-proposal-key-123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 person=await hire('Fictional Cancel Proposal Person');colleague=await hire('Fictional Cancel Proposal Colleague');
 weekdays=[];const next=new Date(todayInKualaLumpur()+'T00:00:00Z');while(weekdays.length<6){next.setUTCDate(next.getUTCDate()+1);if(![0,6].includes(next.getUTCDay()))weekdays.push(next.toISOString().slice(0,10));}
 browser.selected=person.uid;browser.redirects=[];vi.stubEnv('DEV_USER_ID',person.uid);
});
const caller=()=>getSession();
/** The review command's own POST, as the selected cookie login. */
async function post(packet:unknown){const response=await handleConfiguredModuleActionBrowserCommand(new Request('https://fixture.test/api/assistant/module-actions',
 {method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(packet)}));return{status:response.status,body:await response.json() as Record<string,any>};}
async function pendingRequest(date=weekdays[3]){return (await requestLeave(await caller(),{employmentId:person.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional pending reason'})).leaveRequestId;}
async function approvedRequest(){
 const id=(await requestLeave(await caller(),{employmentId:person.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:weekdays[2],endDate:weekdays[4],durationType:'full_day',reason:'Fictional approved reason'})).leaveRequestId;
 await decideLeave(adminCtx(base),{leaveRequestId:id,decision:'approved'});return id;
}
async function status(id:string){const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,id));return row.status;}
async function cancellations(id:string){return owner.db.select().from(schema.leaveCancellationRequest).where(and(eq(schema.leaveCancellationRequest.tenantId,base.tenantId),eq(schema.leaveCancellationRequest.leaveRequestId,id)));}
async function propose(id:string,cancelDates?:string[]):Promise<Proposal>{
 const result=await prepareLeaveCancelProposal(await caller(),{leaveRequestId:id,...(cancelDates?{cancelDates}:{})});
 if(result.kind!=='proposal')throw Error('Fictional fixture did not prepare a proposal.');return result.proposal;
}

describe('leave.cancel proposal for a pending request',()=>{
 it('prepares from the native checks, signs, verifies, renders and withdraws once on the real review command',async()=>{
  const id=await pendingRequest(),proposal=await propose(id);
  expect(proposal.body).toMatchObject({what:{action:'leave.cancel',entity:'leave_request',effect:'withdraw',selectors:{startDate:weekdays[3],requestStatus:'pending'}},
   forWhom:{subject:'own_employment',subjectId:person.employmentId},authority:{kind:'person',userId:person.uid,personId:person.personId},review:{route:'/assistant/leave'},
   facts:{leaveType:'Annual Leave',startDate:weekdays[3],endDate:weekdays[3],days:1,outcome:'withdrawn_now'}});
  expect(proposal.body.checks.map(check=>check.check)).toEqual(['ai_controls_unpaused','own_pending_request']);
  expect(JSON.stringify(proposal)).not.toMatch(/Fictional/);expect(await status(id)).toBe('pending');
  const me=await caller();expect(verifyProposal(proposal,me,new Date())).toEqual({ok:true,proposal});
  const card=renderProposalCard(proposal,me,new Date());if(!card.ok)throw Error('card refused');
  expect(Object.keys(card.card).sort()).toEqual([...PROPOSAL_CARD_KEYS]);expect(card.card.forWhom).toBe('You');
  expect(existsSync(fileURLToPath(new URL('../app'+card.card.review.route+'/page.tsx',import.meta.url)))).toBe(true);
  const packets=leaveCancelReviewPackets(proposal,me,new Date());if(!packets.ok||packets.packets.kind!=='assistant_review')throw Error('packets refused');
  const reopened=await post(packets.packets.reopen);expect(reopened.status).toBe(200);
  expect({kind:reopened.body.kind,digest:reopened.body.review.reviewedDigest,actionId:reopened.body.review.actionId})
   .toEqual({kind:'prepared',digest:proposal.body.what.reviewedDigest,actionId:proposal.body.review.reference});
  expect(await status(id)).toBe('pending');
  const first=await post(packets.packets.confirm);expect(first.status).toBe(200);expect(first.body.kind).toBe('completed');
  const again=await post(packets.packets.confirm);expect(again.body).toEqual(first.body);
  expect(await status(id)).toBe('cancelled');
 },60000);
 it('refuses another person\'s login, tampering and expiry; the review command writes nothing for them',async()=>{
  const id=await pendingRequest(),proposal=await propose(id),me=await caller();
  const forged=JSON.parse(JSON.stringify(proposal));forged.body.what.reviewedDigest='0'.repeat(64);
  expect(leaveCancelReviewPackets(forged,me,new Date())).toEqual({ok:false,reason:'signature'});
  expect(leaveCancelReviewPackets(proposal,me,new Date(Date.parse(proposal.body.expiresAt)))).toEqual({ok:false,reason:'expired'});
  expect(renderProposalCard(forged,me,new Date())).toEqual({ok:false,reason:'signature'});
  browser.selected=colleague.uid;vi.stubEnv('DEV_USER_ID',colleague.uid);
  const other=await caller();expect(leaveCancelReviewPackets(proposal,other,new Date())).toEqual({ok:false,reason:'authority_mismatch'});
  const response=await post({action:'leave.cancel',operation:'confirm',confirmation:{action:'leave.cancel',contractVersion:1,actionId:proposal.body.review.reference,reviewedDigest:proposal.body.what.reviewedDigest}});
  expect(response.status===200?response.body.kind:'refused').not.toBe('completed');
  // A colleague cannot prepare a card for the person's request either.
  expect(await prepareLeaveCancelProposal(other,{leaveRequestId:id})).toEqual({kind:'unavailable'});
  expect(await status(id)).toBe('pending');
 },60000);
});

describe('leave.cancel proposal for approved leave',()=>{
 it('offers exactly the native dates and gives them back only through the /leave Cancel dates action',async()=>{
  const id=await approvedRequest(),proposal=await propose(id,[weekdays[4]]);
  expect(proposal.body).toMatchObject({what:{action:'leave.cancel',effect:'withdraw',selectors:{startDate:weekdays[2],requestStatus:'approved'}},
   review:{route:'/leave',href:'/leave',reference:id},facts:{cancelDates:[weekdays[4]],outcome:'give_back_requested',startDate:weekdays[2],endDate:weekdays[4]}});
  expect(proposal.body.checks.map(check=>check.check)).toEqual(['actor_current','ai_controls_unpaused','own_approved_cancellable']);
  const me=await caller(),card=renderProposalCard(proposal,me,new Date());if(!card.ok)throw Error('card refused');
  expect(JSON.stringify(card.card)).not.toMatch(UUID);
  // A date the native offer does not allow (not part of this leave) refuses the whole card.
  expect(await prepareLeaveCancelProposal(me,{leaveRequestId:id,cancelDates:[weekdays[5]]})).toEqual({kind:'unavailable'});
  expect(await cancellations(id)).toHaveLength(0);
  const packets=leaveCancelReviewPackets(proposal,me,new Date());if(!packets.ok||packets.packets.kind!=='leave_form')throw Error('packets refused');
  const form=new FormData();form.set('leaveRequestId',packets.packets.form.leaveRequestId);for(const date of packets.packets.form.cancelDate)form.append('cancelDate',date);
  await expect(requestLeaveCancellationAction(form)).rejects.toThrow('NEXT_REDIRECT');
  expect(browser.redirects.at(-1)).toMatch(/cancellation(Requested|Approved)/);
  const rows=await cancellations(id);expect(rows).toHaveLength(1);expect(rows[0].cancelDates).toEqual([weekdays[4]]);
  expect(await status(id)).toBe('approved');
 },60000);
 it('issues nothing when the leave type does not let employees cancel approved leave, or for a colleague',async()=>{
  const id=await approvedRequest();
  browser.selected=colleague.uid;vi.stubEnv('DEV_USER_ID',colleague.uid);
  expect(await prepareLeaveCancelProposal(await caller(),{leaveRequestId:id})).toEqual({kind:'unavailable'});
  browser.selected=person.uid;vi.stubEnv('DEV_USER_ID',person.uid);
  await owner.db.update(schema.leaveType).set({employeeCancelApproved:false}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
  expect(await prepareLeaveCancelProposal(await caller(),{leaveRequestId:id})).toEqual({kind:'unavailable'});
  const [counts]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from leave_cancellation_request where tenant_id=${base.tenantId}::uuid`);expect(counts.n).toBe(0);
 },60000);
});
