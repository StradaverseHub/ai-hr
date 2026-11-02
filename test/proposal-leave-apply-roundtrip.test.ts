/** ADR-0170 step 0b — one `leave.apply` proposal end to end on fictional data: prepared from the leave
 * service's own validation, signed, verified against the person's real cookie login, rendered as the card
 * hint, reopened and confirmed through the existing review command (/assistant/leave's POST owner).
 * Next request cookies/locale are framework seams; identity SQL, custody, RLS and leave effects are real. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {handleAuthenticatedOwnLeaveBrowserCommand} from '../core/assistant-actions/own-leave-server';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {verifyProposal,type Proposal} from '../core/proposals/proposal';
import {leaveApplyCardHint,leaveApplyReviewPackets,prepareLeaveApplyProposal} from '../core/proposals/leave-apply';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,applicant:{uid:string;employmentId:string;personId:string},colleague:{uid:string;employmentId:string;personId:string},date:string;
const humanText={reason:'Fictional proposal round-trip reason',employeeRemark:'Fictional proposal round-trip remark'};
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-lifecycle-storage-master-key');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 applicant=await hire('Fictional Proposal Applicant');colleague=await hire('Fictional Proposal Colleague');
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 date=next.toISOString().slice(0,10);
 browser.selected=applicant.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
/** The review page's own POST, as the selected cookie login. */
function post(body:unknown){return handleAuthenticatedOwnLeaveBrowserCommand(new Request('https://hr.example/api/assistant/own-leave',{method:'POST',
 headers:{origin:'https://hr.example',host:'hr.example','content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)}));}
async function counts(){const [row]=await owner.db.execute<{requests:number;pending:number;runs:number}>(sql`select
 (select count(*)::int from leave_request where tenant_id=${base.tenantId}::uuid) as requests,
 (select count(*)::int from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation') as pending,
 (select count(*)::int from ai_model_run where tenant_id=${base.tenantId}::uuid) as runs`);return row;}
async function propose():Promise<Proposal>{
 const result=await prepareLeaveApplyProposal(await getBrowserCommandSession(),{nomination:{action:'leave.apply',contractVersion:1,employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,date,durationType:'full_day'},
  selection:{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId},humanText},'en');
 if(result.kind!=='proposal')throw Error('Fictional fixture did not prepare a proposal: '+result.kind);
 return result.proposal;
}
const callerFor=()=>getBrowserCommandSession();

describe('leave.apply proposal round trip',()=>{
 it('prepares from the leave service checks, signs, verifies, renders and confirms once on the real review command',async()=>{
  const before=await counts(),proposal=await propose();
  expect(await counts()).toEqual({...before,pending:before.pending+1});
  expect(proposal.body).toMatchObject({what:{action:'leave.apply',entity:'leave_request',effect:'create',selectors:{date,durationType:'full_day'}},
   forWhom:{tenantId:base.tenantId,subject:'own_employment',subjectId:applicant.employmentId},authority:{kind:'person',tenantId:base.tenantId,userId:applicant.uid,personId:applicant.personId},
   review:{route:'/assistant/leave'}});
  expect(proposal.body.checks.map(check=>check.check)).toEqual(['actor_current','ai_controls_unpaused','leave_type_eligible','deduction_and_balance','review_contract']);
  expect(proposal.body.checks.every(check=>check.result==='pass')).toBe(true);
  // No private text, balance or name rides on the proposal.
  expect(JSON.stringify(proposal)).not.toMatch(/Fictional/);
  expect(Object.keys(proposal.body.what).sort()).toEqual(['action','contractVersion','effect','entity','reviewedDigest','selectors']);
  const caller=await callerFor();
  expect(verifyProposal(proposal,caller,new Date())).toEqual({ok:true,proposal});
  const hint=leaveApplyCardHint(proposal);
  expect(hint).toMatchObject({action:'leave.apply',hints:{date}});
  const page=fileURLToPath(new URL('../app'+hint.reviewHref.split('?')[0]+'/page.tsx',import.meta.url));expect(existsSync(page)).toBe(true);
  const packets=leaveApplyReviewPackets(proposal,caller,new Date());
  if(!packets.ok)throw Error('Fictional proposal refused: '+packets.reason);

  // The review page reopens exactly the reviewed effect the proposal signed.
  const reopened=await post(packets.packets.reopen);expect(reopened.status).toBe(200);
  const shown=await reopened.json();expect(shown.kind).toBe('prepared');
  expect({digest:shown.review.reviewedDigest,date:shown.review.date,actionId:shown.review.actionId,expiresAt:shown.review.expiresAt})
   .toEqual({digest:proposal.body.what.reviewedDigest,date,actionId:proposal.body.review.reference,expiresAt:proposal.body.expiresAt});
  expect(shown.review.humanText).toEqual(humanText);
  expect(await counts()).toMatchObject({requests:0,runs:0});

  // The person confirms on the page; the owning service writes the request once.
  const first=await post(packets.packets.confirm);expect(first.status).toBe(200);
  const completed=await first.json();expect(completed).toMatchObject({kind:'completed',receipt:{state:'completed',actionId:proposal.body.review.reference}});
  const repeated=await post(packets.packets.confirm);expect(await repeated.json()).toEqual(completed);
  expect(await counts()).toEqual({requests:1,pending:0,runs:0});
  const [record]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,completed.receipt.leaveRequestId));
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,completed.receipt.submissionEventId));
  expect({employment:record.employmentId,start:record.startDate,actor:event.actorId,type:event.eventType})
   .toEqual({employment:applicant.employmentId,start:date,actor:applicant.uid,type:'leave-request.submitted'});
 });

 it('refuses another person\'s login, and their review command cannot confirm the applicant\'s review',async()=>{
  const proposal=await propose();browser.selected=colleague.uid;
  const other=await callerFor();
  expect(leaveApplyReviewPackets(proposal,other,new Date())).toEqual({ok:false,reason:'authority_mismatch'});
  const response=await post({operation:'confirm',confirmation:{actionId:proposal.body.review.reference,contractVersion:1,reviewedDigest:proposal.body.what.reviewedDigest}});
  expect(response.status).not.toBe(200);expect(await counts()).toMatchObject({requests:0,pending:1});
 });

 it('refuses a tampered proposal before any packet, and the page refuses a forged digest',async()=>{
  const proposal=await propose(),caller=await callerFor();
  const forged=JSON.parse(JSON.stringify(proposal));forged.body.what.reviewedDigest='0'.repeat(64);
  expect(leaveApplyReviewPackets(forged,caller,new Date())).toEqual({ok:false,reason:'signature'});
  const response=await post({operation:'confirm',confirmation:{actionId:proposal.body.review.reference,contractVersion:1,reviewedDigest:'0'.repeat(64)}});
  expect(response.status===200?(await response.json()).kind:'refused').not.toBe('completed');
  expect(await counts()).toMatchObject({requests:0});
 });

 it('expires with its review: the proposal refuses after expiry and the page writes nothing',async()=>{
  const proposal=await propose(),caller=await callerFor();
  expect(leaveApplyReviewPackets(proposal,caller,new Date(Date.parse(proposal.body.expiresAt)))).toEqual({ok:false,reason:'expired'});
  await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${proposal.body.review.reference}::uuid`);
  const response=await post({operation:'confirm',confirmation:{actionId:proposal.body.review.reference,contractVersion:1,reviewedDigest:proposal.body.what.reviewedDigest}});
  expect(response.status===200?(await response.json()).kind:'refused').not.toBe('completed');
  expect(await counts()).toMatchObject({requests:0,pending:0});
 });
});
