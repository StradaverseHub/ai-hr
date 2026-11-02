/** Issue 10 — a leave application prepared in chat (`leave.apply`) on fictional data, over the real owners: the
 * chat preparer resolves the model's details against the caller's own apply menu and asks when something is missing,
 * issues a signed proposal (the one-day review, or the form card for a range or half day), Confirm submits only on an
 * explicit Confirm through the review command, which re-checks the leave service, and Edit opens the Request Leave
 * form prefilled, validated as the caller. Next request cookies/locale/cache are framework seams; identity SQL,
 * custody, RLS and leave effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {previewLeaveDeduction,requestLeave} from '../packs/leave/service';
import {listEligibleLeaveTypesFor} from '../core/read';
import {issueProposal,verifyProposal,type Proposal} from '../core/proposals/proposal';
import {LEAVE_APPLY_FORM_ROUTE,leaveApplyEditHref} from '../core/proposals/leave-apply';
import {prepareChatLeaveApplyProposal,prepareSuggestedProposal} from '../core/proposals/suggested';
import {confirmLeaveApplyProposal} from '../core/assistant-actions/leave-apply-proposal-confirm';
import {confirmLeaveApplyProposalAction,editLeaveApplyProposalAction} from '../app/assistant/leave-apply-proposal-actions';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,applicant:Person,colleague:Person,date:string,nextDate:string,compassionateId:string;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string):Promise<Person>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
const weekdayAfter=(iso:string)=>{const next=new Date(iso+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));return next.toISOString().slice(0,10);};
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-lifecycle-storage-master-key');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 // A second type on the menu, so a leave type the model leaves out or garbles is a real choice.
 const [type]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'COMPASSIONATE',name:'Compassionate Leave',paid:true,allowNegativeBalance:true})
  .returning({id:schema.leaveType.id});compassionateId=type.id;
 applicant=await hire('Fictional Chat Applicant');colleague=await hire('Fictional Chat Colleague');
 date=weekdayAfter(todayInKualaLumpur());nextDate=weekdayAfter(date);
 browser.selected=applicant.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
async function counts(){const [row]=await owner.db.execute<{requests:number;pending:number}>(sql`select
 (select count(*)::int from leave_request where tenant_id=${base.tenantId}::uuid) as requests,
 (select count(*)::int from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation') as pending`);return row;}
async function chat(details:Record<string,string>,words:string):Promise<Proposal>{
 const outcome=await prepareChatLeaveApplyProposal(await caller(),details,words,'en');
 if(outcome?.kind!=='proposal')throw Error('Fictional chat application was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

describe('missing or unclear details: one question, nothing prepared',()=>{
 it('asks for the leave type with the caller\'s own menu numbered, and for a date, and saves nothing',async()=>{
  const before=await counts(),ctx=await caller();
  // The caller's own apply menu, read from its owner and numbered by name here.
  const names=(await listEligibleLeaveTypesFor(ctx,applicant.employmentId,'en')).map(row=>String(row.name)).sort((a,b)=>a.localeCompare(b));
  expect(names).toEqual(expect.arrayContaining(['Annual Leave','Compassionate Leave']));
  const menu=names.map((leaveType,index)=>({option:index+1,leaveType}));
  expect(await prepareChatLeaveApplyProposal(ctx,{startDate:date},'I want to take leave on '+date,'en')).toEqual({kind:'ask',missing:['leaveType'],options:menu});
  expect(await prepareChatLeaveApplyProposal(ctx,{leaveType:'Sabbatical',startDate:date},'Sabbatical on '+date,'en')).toEqual({kind:'ask',missing:['leaveType'],options:menu});
  expect(await prepareChatLeaveApplyProposal(ctx,{leaveType:'annual'},'Annual leave please','en')).toEqual({kind:'ask',missing:['startDate'],options:[]});
  expect(await prepareChatLeaveApplyProposal(ctx,{leaveType:'annual',startDate:nextDate,endDate:date},'annual leave','en')).toEqual({kind:'ask',missing:['endDate'],options:[]});
  expect(await prepareChatLeaveApplyProposal(ctx,{leaveType:'annual',startDate:date,durationType:'half_day'},'half day annual leave','en')).toEqual({kind:'ask',missing:['durationType'],options:[]});
  // A number counts only when the person said it; the model's number alone is not their choice.
  expect(await prepareChatLeaveApplyProposal(ctx,{leaveType:'2',startDate:date},'on '+date,'en')).toMatchObject({kind:'ask',missing:['leaveType']});
  // The person answers the numbered question: that number picks the type at that place in the same menu.
  const chosen=names.indexOf('Compassionate Leave')+1;
  const answered=await prepareChatLeaveApplyProposal(ctx,{leaveType:String(chosen),startDate:date,endDate:nextDate},'Number '+chosen+' please','en');
  expect(answered?.kind==='proposal'&&answered.proposal.body.what.selectors.leaveTypeId).toBe(compassionateId);
  expect(await counts()).toEqual(before);
 });
 it('sends the model the missing details and the numbered menu, and the turn prepares nothing',async()=>{
  let sent:unknown;
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'leave.apply',details:{startDate:date}}}]},
   (request:ModelRequest)=>{const tool=[...request.messages].reverse().find(message=>message.role==='tool')!;sent=JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
    return{final:{reply:'Which leave type would you like? 1. Annual Leave 2. Compassionate Leave',mode:'clarify'}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:await caller(),conversationId:randomUUID(),question:'Apply leave for me on '+date+'.',
   scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(sent).toMatchObject({suggested:false,action:'leave.apply',reason:'missing_details',missing:['leaveType'],
   options:expect.arrayContaining([expect.objectContaining({leaveType:'Annual Leave'}),expect.objectContaining({leaveType:'Compassionate Leave'})])});
  expect((sent as {note:string}).note).toMatch(/one short question/);
  expect(result.trace.calls[0]).toMatchObject({tool:'suggest_action',status:'refused'});
  expect(result.proposals).toEqual([]);expect(result.suggestion).toBeNull();
  expect(await counts()).toEqual({requests:0,pending:0});
 });
});

describe('one full day: prepared, then submitted only on Confirm through the review command',()=>{
 it('prepares a signed review proposal for the caller\'s own leave and submits nothing until Confirm',async()=>{
  const before=await counts();
  const proposal=await chat({leaveType:'annual',startDate:date,reason:'family day',employmentId:colleague.employmentId},'Apply annual leave on '+date+' for a family day');
  expect(proposal.body).toMatchObject({what:{action:'leave.apply',selectors:{date,durationType:'full_day',leaveTypeId:base.annualLeaveTypeId}},
   forWhom:{subject:'own_employment',subjectId:applicant.employmentId},authority:{kind:'person',userId:applicant.uid,personId:applicant.personId},
   review:{route:'/assistant/leave'},facts:{leaveType:'Annual Leave',startDate:date,endDate:date,outcome:'submitted_not_approved'}});
  const preview=await previewLeaveDeduction(await caller(),{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',today:todayInKualaLumpur()});
  expect(proposal.body.facts?.days).toBe(preview.days);
  expect(verifyProposal(proposal,await caller(),new Date()).ok).toBe(true);
  // The reason stays in the sealed review, never on the proposal; nothing is submitted.
  expect(JSON.stringify(proposal)).not.toMatch(/family/);
  expect(await counts()).toEqual({...before,pending:before.pending+1});
  for(const confirm of [undefined,false,'true',1])
   expect(await confirmLeaveApplyProposal(await caller(),{proposal,confirm},'en')).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await counts()).toMatchObject({requests:0});

  const submitted=await confirmLeaveApplyProposalAction({proposal,confirm:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  expect(await counts()).toEqual({requests:1,pending:0});
  const [record]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,submitted.leaveRequestId));
  expect({employment:record.employmentId,type:record.leaveTypeId,start:record.startDate,end:record.endDate,status:record.status,reason:record.reason})
   .toEqual({employment:applicant.employmentId,type:base.annualLeaveTypeId,start:date,end:date,status:'pending',reason:'family day'});
  // Confirming again replays the same receipt; no second request.
  expect(await confirmLeaveApplyProposal(await caller(),{proposal,confirm:true},'en')).toEqual(submitted);
  expect(await counts()).toMatchObject({requests:1});
 });
 it('keeps a reason only when it is the person\'s own words',async()=>{
  const proposal=await chat({leaveType:'Annual Leave',startDate:date,reason:'medical appointment'},'Annual leave on '+date);
  const done=await confirmLeaveApplyProposal(await caller(),{proposal,confirm:true},'en');if(done.kind!=='submitted')throw Error('refused');
  const [record]=await owner.db.select({reason:schema.leaveRequest.reason}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,done.leaveRequestId));
  expect(record.reason).toBeNull();
 });
 it('refuses a tampered, expired or someone else\'s proposal, and submits nothing',async()=>{
  const proposal=await chat({leaveType:'annual',startDate:date},'annual leave on '+date);
  const forged=clone(proposal);forged.body.what.selectors.date=nextDate;
  expect(await confirmLeaveApplyProposal(await caller(),{proposal:forged,confirm:true},'en')).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmLeaveApplyProposal(await caller(),{proposal,confirm:true},'en',new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  browser.selected=colleague.uid;
  expect(await confirmLeaveApplyProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editLeaveApplyProposalAction({proposal})).toEqual({ok:false,reason:'authority_mismatch'});
  expect(await counts()).toMatchObject({requests:0,pending:1});
 });
 it('re-checks the leave service at Confirm: a balance spent since the card refuses, and so does an overlapping request',async()=>{
  const spent=await chat({leaveType:'annual',startDate:date},'annual leave on '+date);
  const accrual=and(eq(schema.leaveLedger.employmentId,applicant.employmentId),eq(schema.leaveLedger.entryType,'accrual'));
  await owner.db.update(schema.leaveLedger).set({days:'0'}).where(accrual);
  expect(await confirmLeaveApplyProposal(await caller(),{proposal:spent,confirm:true},'en')).toEqual({kind:'refused',reason:'unavailable'});
  expect(await counts()).toMatchObject({requests:0});
  await owner.db.update(schema.leaveLedger).set({days:'10'}).where(accrual);

  const overlapped=await chat({leaveType:'annual',startDate:nextDate},'annual leave on '+nextDate);
  await requestLeave(await caller(),{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:nextDate,endDate:nextDate,durationType:'full_day',today:todayInKualaLumpur()});
  expect(await confirmLeaveApplyProposal(await caller(),{proposal:overlapped,confirm:true},'en')).toEqual({kind:'refused',reason:'unavailable'});
  expect(await counts()).toMatchObject({requests:1});
 });
});

describe('a range or a half day: the prefilled Request Leave form is the confirm path',()=>{
 it('issues a form card from the leave service\'s own preview, and Confirm answers with the prefilled form',async()=>{
  const before=await counts();
  const proposal=await chat({leaveType:'annual',startDate:date,endDate:nextDate},'Annual leave from '+date+' to '+nextDate);
  const preview=await previewLeaveDeduction(await caller(),{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:nextDate,durationType:'full_day',today:todayInKualaLumpur()});
  expect(preview.days).toBeGreaterThan(1);
  expect(proposal.body).toMatchObject({what:{selectors:{startDate:date,endDate:nextDate,durationType:'full_day',leaveTypeId:base.annualLeaveTypeId}},
   forWhom:{subjectId:applicant.employmentId},review:{route:LEAVE_APPLY_FORM_ROUTE,href:'/leave',reference:base.annualLeaveTypeId},
   facts:{leaveType:'Annual Leave',startDate:date,endDate:nextDate,days:preview.days,outcome:'submitted_not_approved'}});
  expect(proposal.body.checks.map(check=>[check.check,check.result])).toEqual([['actor_current','pass'],['ai_controls_unpaused','pass'],['leave_type_eligible','pass'],['deduction_and_balance','pass']]);
  const href=`/leave?apply=1&applyType=${base.annualLeaveTypeId}&start=${date}&applyEnd=${nextDate}&applyDuration=full_day`;
  expect(await confirmLeaveApplyProposal(await caller(),{proposal,confirm:true},'en')).toEqual({kind:'use_form',href});
  expect(await editLeaveApplyProposalAction({proposal})).toEqual({ok:true,href});
  // No review is saved and nothing is submitted: the person submits on the form.
  expect(await counts()).toEqual(before);
 });
 it('carries a half day as one date, only for a type that allows it',async()=>{
  expect(await prepareChatLeaveApplyProposal(await caller(),{leaveType:'annual',startDate:date,durationType:'half_day_am'},'half day annual leave on '+date+' morning','en'))
   .toEqual({kind:'ask',missing:['durationType'],options:[]});
  await owner.db.update(schema.leaveType).set({durations:['half_day_am','half_day_pm']}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
  const proposal=await chat({leaveType:'annual',startDate:date,durationType:'half_day_am'},'half day annual leave on '+date+' morning');
  expect(proposal.body).toMatchObject({what:{selectors:{startDate:date,endDate:date,durationType:'half_day_am'}},review:{route:'/leave'},facts:{days:0.5}});
  expect(await leaveApplyEditHref(await caller(),proposal,'en')).toEqual({ok:true,href:`/leave?apply=1&applyType=${base.annualLeaveTypeId}&start=${date}&applyEnd=${date}&applyDuration=half_day_am`});
  expect(await prepareChatLeaveApplyProposal(await caller(),{leaveType:'annual',startDate:date,endDate:nextDate,durationType:'half_day_pm'},'half day','en'))
   .toEqual({kind:'ask',missing:['endDate'],options:[]});
 });
 it('validates the prefill as the caller: a type no longer on their menu, or another person\'s employment, is refused',async()=>{
  const proposal=await chat({leaveType:'Compassionate',startDate:date,endDate:nextDate},'compassionate leave '+date+' to '+nextDate);
  expect(proposal.body.what.selectors.leaveTypeId).toBe(compassionateId);
  await owner.db.update(schema.leaveType).set({employeeCanApply:false}).where(eq(schema.leaveType.id,compassionateId));
  expect(await leaveApplyEditHref(await caller(),proposal,'en')).toEqual({ok:false,reason:'unavailable'});
  // Correctly signed, for this login, but about the colleague's employment: never prefilled.
  const ctx:SessionContext=await caller();
  const foreign=issueProposal({...clone(proposal.body),forWhom:{...proposal.body.forWhom,subjectId:colleague.employmentId},
   what:{...proposal.body.what,selectors:{...proposal.body.what.selectors,leaveTypeId:base.annualLeaveTypeId}}} as never);
  expect(await leaveApplyEditHref(ctx,foreign,'en')).toEqual({ok:false,reason:'unavailable'});
  const tampered=clone(proposal);tampered.body.what.selectors.leaveTypeId=base.annualLeaveTypeId;
  expect(await leaveApplyEditHref(ctx,tampered,'en')).toEqual({ok:false,reason:'signature'});
 });
});

describe('the harness turn',()=>{
 it('prepares the card from a clear request and hands it to the turn, never to the model',async()=>{
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'leave.apply',details:{leaveType:'Annual Leave',startDate:date}}}]},
   {final:{reply:'Yes, I can. Your annual leave application is ready for you to check and confirm.',mode:'propose'}}]);
  const ctx=await caller();
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question:'Apply annual leave for me on '+date+'.',
   scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(result.proposals).toHaveLength(1);expect(verifyProposal(result.proposals[0],ctx,new Date()).ok).toBe(true);
  expect(result.suggestion).toMatchObject({action:'leave.apply'});
  const sentText=JSON.stringify(model.requests.map(request=>request.messages));
  expect(sentText).not.toContain(result.proposals[0].signature.value);expect(sentText).not.toContain(base.annualLeaveTypeId);
  expect(await counts()).toEqual({requests:0,pending:1});
  // The turn's preparer and the suggestion dispatcher agree.
  expect((await prepareSuggestedProposal(ctx,'leave.apply',{leaveType:'annual'},'annual leave',new Date(),'en'))?.kind).toBe('ask');
 });
});
