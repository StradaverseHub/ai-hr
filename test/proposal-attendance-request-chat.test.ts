/** AI v2 W2 — an attendance correction and an overtime request prepared in chat, on fictional data, over the real
 * owners: the chat preparer reads the person's own attendance day and asks one question when something is missing,
 * the review stores run the attendance service's own preparation and save a sealed review, a signed proposal is issued,
 * Confirm submits only on an explicit Confirm and the attendance service re-checks everything (a request filed elsewhere
 * since the card, or a changed day on record, refuses), and Edit opens the existing form prefilled. Next request
 * cookies/locale/cache are framework seams; identity SQL, custody, RLS and attendance effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {checkIn,checkOut,requestAttendanceCorrection} from '../packs/attendance/service';
import {issueProposal,verifyProposal,type Proposal} from '../core/proposals/proposal';
import {prepareChatAttendanceCorrectionProposal,prepareChatOvertimeRequestProposal} from '../core/proposals/attendance-request';
import {prepareSuggestedProposal} from '../core/proposals/suggested';
import {confirmAttendanceRequestProposal} from '../core/assistant-actions/attendance-request-proposal-confirm';
import {confirmAttendanceRequestProposalAction,editAttendanceRequestProposalAction} from '../app/assistant/attendance-request-proposal-actions';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,worker:Person,colleague:Person,worked:string,unclocked:string,planned:string;
/** HR calendar days from the repository's HR date owner (Asia/Kuala_Lumpur), then plain date arithmetic. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string):Promise<Person>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-attendance-chat-custody-key-1234');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');await setModule(base.tenantId,'attendance','active');
 worker=await hire('Fictional Chat Clocker');colleague=await hire('Fictional Chat Colleague');
 worked=calendarDate(-2);unclocked=calendarDate(-3);planned=calendarDate(4);
 // The day the person forgot to clock out: a clock-in on record and no clock-out.
 await checkIn(adminCtx(base),{employmentId:worker.employmentId,date:worked,time:'08:00',manual:true});
 browser.selected=worker.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
async function counts(){const [row]=await owner.db.execute<{requests:number;pending:number}>(sql`select
 (select count(*)::int from attendance_correction where tenant_id=${base.tenantId}::uuid) as requests,
 (select count(*)::int from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation') as pending`);return row;}
const requests=()=>owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.tenantId,base.tenantId)).orderBy(schema.attendanceCorrection.createdAt);
const forgot=(date:string)=>({date,checkOut:'18:10',reason:'forgot to clock out'});
const WORDS='I forgot to clock out that day, I left at 6:10pm';
async function correction(details=forgot(worked),words=WORDS):Promise<Proposal>{
 const outcome=await prepareChatAttendanceCorrectionProposal(await caller(),details,words);
 if(outcome?.kind!=='proposal')throw Error('Fictional correction was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}
const OT_WORDS='Please plan overtime for me from 6pm to 9pm for the month-end closing';
async function overtime(date=planned):Promise<Proposal>{
 const outcome=await prepareChatOvertimeRequestProposal(await caller(),{date,plannedStartTime:'18:00',plannedEndTime:'21:00',reason:'month-end closing'},OT_WORDS);
 if(outcome?.kind!=='proposal')throw Error('Fictional overtime was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}

describe('an attendance correction from chat',()=>{
 it('asks one question when the time, the reason, a real date or the clock-in is missing, and saves nothing',async()=>{
  const ctx=await caller(),before=await counts();
  expect(await prepareChatAttendanceCorrectionProposal(ctx,{date:worked,reason:'forgot to clock out'},WORDS)).toEqual({kind:'ask',missing:['time'],options:[]});
  expect(await prepareChatAttendanceCorrectionProposal(ctx,{date:worked,checkOut:'18:10'},WORDS)).toEqual({kind:'ask',missing:['reason'],options:[]});
  expect(await prepareChatAttendanceCorrectionProposal(ctx,{date:calendarDate(1),checkOut:'18:10',reason:'forgot to clock out'},WORDS)).toEqual({kind:'ask',missing:['date'],options:[]});
  // Nothing on record that day: the clock-in is asked for, never taken from the roster.
  expect(await prepareChatAttendanceCorrectionProposal(ctx,forgot(unclocked),WORDS)).toEqual({kind:'ask',missing:['checkIn'],options:[]});
  expect(await counts()).toEqual(before);
  // The dispatcher the harness calls agrees.
  expect(await prepareSuggestedProposal(ctx,'attendance.correction.request',{date:worked},WORDS)).toMatchObject({kind:'ask',missing:['time','reason']});
 });
 it('prepares the clock-out against the day on record and submits it only on Confirm, for the existing approval',async()=>{
  const before=await counts(),proposal=await correction();
  expect(proposal.body).toMatchObject({what:{action:'attendance.correction.request',selectors:{date:worked,corrects:'check_out',checkOut:'18:10'}},
   forWhom:{subject:'own_employment',subjectId:worker.employmentId},authority:{kind:'person',userId:worker.uid,personId:worker.personId},
   review:{route:'/assistant/attendance'},facts:{startDate:worked,endDate:worked,checkIn:'08:00',checkOut:'18:10',recordedCheckIn:'08:00',outcome:'submitted_not_approved'}});
  expect(proposal.body.facts).not.toHaveProperty('recordedCheckOut');
  expect(verifyProposal(proposal,await caller(),new Date()).ok).toBe(true);
  // The reason stays in the sealed review; one review is saved and nothing is submitted.
  expect(JSON.stringify(proposal)).not.toMatch(/forgot/);
  expect(await counts()).toEqual({requests:before.requests,pending:before.pending+1});
  for(const confirm of [undefined,false,'true',1])expect(await confirmAttendanceRequestProposal(await caller(),{proposal,confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await counts()).toMatchObject({requests:0});

  const submitted=await confirmAttendanceRequestProposalAction({proposal,confirm:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  const [row]=await requests();
  expect({id:row.id,employment:row.employmentId,date:row.attendanceDate,in:row.proposedCheckIn,out:row.proposedCheckOut,status:row.status,kind:row.requestKind,reason:row.reason,ot:row.requestedOtMinutes})
   .toEqual({id:submitted.requestId,employment:worker.employmentId,date:worked,in:'08:00:00',out:'18:10:00',status:'pending',kind:'incomplete_entry',reason:'forgot to clock out',ot:null});
  // A request for the existing approval, not a clock change: the day on record is untouched until it is approved.
  const [day]=await owner.db.select({out:schema.attendance.checkOutAt}).from(schema.attendance).where(and(eq(schema.attendance.employmentId,worker.employmentId),eq(schema.attendance.attendanceDate,worked)));
  expect(day.out).toBeNull();
  // Confirming again replays the same receipt; no second request.
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal,confirm:true})).toEqual(submitted);
  expect(await counts()).toEqual({requests:1,pending:0});
 });
 it('re-checks at Confirm: a request filed on the form since the card, or a changed day on record, refuses and writes nothing',async()=>{
  const filedElsewhere=await correction();
  await requestAttendanceCorrection(await caller(),{employmentId:worker.employmentId,date:worked,checkIn:'08:00',checkOut:'18:00',reason:'Fictional form request'});
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal:filedElsewhere,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect((await requests()).map(row=>row.reason)).toEqual(['Fictional form request']);

  await checkIn(adminCtx(base),{employmentId:worker.employmentId,date:unclocked,time:'09:00',manual:true});
  const changed=await correction(forgot(unclocked));
  await checkOut(adminCtx(base),{employmentId:worker.employmentId,date:unclocked,time:'17:30',manual:true});
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal:changed,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await requests()).toHaveLength(1);
 });
 it('refuses a tampered, expired or someone else\'s card, and submits nothing',async()=>{
  const proposal=await correction();
  const forged=clone(proposal);forged.body.what.selectors.checkOut='23:00';
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  browser.selected=colleague.uid;
  expect(await confirmAttendanceRequestProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editAttendanceRequestProposalAction({proposal})).toEqual({ok:false,reason:'authority_mismatch'});
  // Correctly signed for the colleague's own login, but pointing at the worker's review and employment: the custody
  // binding refuses the confirmation and Edit refuses the employment.
  const foreign=issueProposal({...clone(proposal.body),authority:{kind:'person',tenantId:base.tenantId,userId:colleague.uid,personId:colleague.personId}} as never);
  expect(await confirmAttendanceRequestProposalAction({proposal:foreign,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await editAttendanceRequestProposalAction({proposal:foreign})).toEqual({ok:false,reason:'unavailable'});
  expect(await counts()).toMatchObject({requests:0,pending:1});
 });
 it('Edit opens the person\'s own attendance day with the time they asked for',async()=>{
  const proposal=await correction();
  expect(await editAttendanceRequestProposalAction({proposal})).toEqual({ok:true,href:`/attendance/my-records/${worked}?checkOut=18%3A10`});
  expect(await counts()).toMatchObject({requests:0});
 });
});

describe('an overtime request from chat',()=>{
 it('asks for a missing end time or reason, then shows the service\'s own minutes and submits only on Confirm',async()=>{
  const ctx=await caller(),before=await counts();
  expect(await prepareChatOvertimeRequestProposal(ctx,{date:planned,plannedStartTime:'18:00',reason:'month-end closing'},OT_WORDS)).toEqual({kind:'ask',missing:['plannedEndTime'],options:[]});
  expect(await prepareChatOvertimeRequestProposal(ctx,{date:planned,plannedStartTime:'18:00',plannedEndTime:'21:00'},OT_WORDS)).toEqual({kind:'ask',missing:['reason'],options:[]});
  expect(await counts()).toEqual(before);
  const proposal=await overtime();
  // 18:00 to 21:00 is three hours: 180 minutes, as the attendance service counted the window.
  expect(proposal.body).toMatchObject({what:{action:'attendance.overtime.request',selectors:{date:planned,plannedStartTime:'18:00',plannedEndTime:'21:00'}},
   forWhom:{subjectId:worker.employmentId},facts:{startDate:planned,plannedStart:'18:00',plannedEnd:'21:00',overtimeMinutes:180,outcome:'submitted_not_approved'}});
  expect(proposal.body.review.href).toMatch(/^\/assistant\/attendance\?flow=overtime&review=/);
  expect(await counts()).toEqual({requests:0,pending:1});
  expect(await confirmAttendanceRequestProposal(await caller(),{proposal,confirm:false})).toEqual({kind:'refused',reason:'not_confirmed'});
  const submitted=await confirmAttendanceRequestProposalAction({proposal,confirm:true});
  if(submitted.kind!=='submitted')throw Error('Fictional overtime refused: '+JSON.stringify(submitted));
  const [row]=await requests();
  expect({id:row.id,date:row.attendanceDate,start:row.plannedStartTime,end:row.plannedEndTime,minutes:row.requestedOtMinutes,kind:row.requestKind,status:row.status,in:row.proposedCheckIn})
   .toEqual({id:submitted.requestId,date:planned,start:'18:00:00',end:'21:00:00',minutes:180,kind:'self_overtime',status:'pending',in:null});
 });
 it('re-checks at Confirm: a plan filed on Plan Overtime for the same date since the card refuses',async()=>{
  const proposal=await overtime();
  await requestAttendanceCorrection(await caller(),{employmentId:worker.employmentId,date:planned,plannedStartTime:'19:00',plannedEndTime:'20:00',requestedOtMinutes:60,reason:'Fictional plan elsewhere',requestKind:'self_overtime'});
  expect(await confirmAttendanceRequestProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect((await requests()).map(row=>row.reason)).toEqual(['Fictional plan elsewhere']);
 });
 it('refuses a tampered or someone else\'s card, and Edit opens Plan Overtime on its date and window',async()=>{
  const proposal=await overtime(),forged=clone(proposal);forged.body.what.selectors.plannedEndTime='23:00';
  expect(await confirmAttendanceRequestProposalAction({proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  expect(await editAttendanceRequestProposalAction({proposal})).toEqual({ok:true,href:`/attendance/plan-ot/apply?date=${planned}&start=18%3A00&end=21%3A00`});
  browser.selected=colleague.uid;
  expect(await confirmAttendanceRequestProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await counts()).toMatchObject({requests:0});
 });
});

describe('the harness turn',()=>{
 it('prepares the correction card from a clear request and hands it to the turn, never to the model',async()=>{
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'attendance.correction.request',details:{date:worked,checkOut:'18:10',reason:'forgot to clock out'}}}]},
   {final:{reply:'Yes, I can. Your clock-out correction is ready for you to check and confirm.',mode:'propose'}}]);
  const ctx=await caller();
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question:WORDS,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(result.proposals).toHaveLength(1);expect(verifyProposal(result.proposals[0],ctx,new Date()).ok).toBe(true);
  expect(result.proposals[0].body.what.action).toBe('attendance.correction.request');
  const sent=JSON.stringify(model.requests.map(request=>request.messages));
  expect(sent).not.toContain(result.proposals[0].signature.value);expect(sent).not.toContain(worker.employmentId);
  expect(await counts()).toEqual({requests:0,pending:1});
 });
 it('prepares the overtime card when the model also passes the person\'s reason, which is never a hint',async()=>{
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'attendance.overtime.request',details:{date:planned,plannedStartTime:'18:00',plannedEndTime:'21:00',reason:'month-end closing'}}}]},
   {final:{reply:'Yes, I can. Your overtime request is ready for you to check and confirm.',mode:'propose'}}]);
  const ctx=await caller();
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question:OT_WORDS,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(result.proposals.map(proposal=>[proposal.body.what.action,proposal.body.facts?.overtimeMinutes])).toEqual([['attendance.overtime.request',180]]);
  expect(await counts()).toEqual({requests:0,pending:1});
 });
 it('sends the model the missing details with the attendance note, and prepares nothing',async()=>{
  let sent:unknown;
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'attendance.correction.request',details:{date:worked,reason:'forgot to clock out'}}}]},
   (request:ModelRequest)=>{const tool=[...request.messages].reverse().find(message=>message.role==='tool')!;sent=JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
    return{final:{reply:'What time did you clock out?',mode:'clarify'}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:await caller(),conversationId:randomUUID(),question:'I forgot to clock out that day',
   scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(sent).toMatchObject({suggested:false,action:'attendance.correction.request',reason:'missing_details',missing:['time']});
  expect((sent as {note:string}).note).toMatch(/attendance request/);expect((sent as {note:string}).note).toMatch(/one short question/);
  expect(result.trace.calls[0]).toMatchObject({tool:'suggest_action',status:'refused'});
  expect(result.proposals).toEqual([]);expect(result.suggestion).toBeNull();
  expect(await counts()).toEqual({requests:0,pending:0});
 });
});
