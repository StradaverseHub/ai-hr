/** After spec v20's scored run 41641279562 (mgr-queue-1, "anything waiting for my approval?": "1 leave request is waiting"
 * without who, when or an offer to open it; emp-what-1: approvals offered to an employee with nothing to approve).
 *
 * The approver's queue names the leave requests waiting for their decision, as their approvals page does: the applicant,
 * the leave type, the days and the dates reach the model as placeholders only, and the person sees the real name and date.
 * Nobody outside the approver's own queue is ever listed. The capability catalogue offers an employee without the manager
 * role exactly the decision assigned to them, only while it waits. Database test on fictional data; fixture copied from
 * test/review/review-suggested-decide-choice.test.ts. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import * as schema from '../db/schema';
import {getSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {cancelOwnLeave,requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {MAX_QUEUE_LEAVE_REQUESTS,approvalQueueWithLeaveRequests} from '../core/harness/tools';
import {approvalQueueFor} from '../core/product-context/approval-queue';
import {capabilityCatalogueFor} from '../core/product-context/capability-catalogue';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Hired={uid:string;employmentId:string;personId:string};
let base:Base,approver:Hired,first:Hired,second:Hired,outsider:Hired,otherApprover:Hired,firstId:string,secondId:string,date:string,laterDate:string;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
const NAMES={first:'Fictional Queue Applicant One',second:'Fictional Queue Applicant Two',outsider:'Fictional Queue Outsider'};
async function hire(name:string):Promise<Hired>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
const login=(who:Hired)=>{browser.selected=who.uid;vi.stubEnv('DEV_USER_ID',who.uid);return getSession();};
const nextWorkday=(from:string)=>{const day=new Date(from+'T00:00:00Z');do{day.setUTCDate(day.getUTCDate()+1);}while([0,6].includes(day.getUTCDay()));return day.toISOString().slice(0,10);};
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-queue-names-key-123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-queue-names-proposal-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 first=await hire(NAMES.first);second=await hire(NAMES.second);approver=await hire('Fictional Queue Approver');
 outsider=await hire(NAMES.outsider);otherApprover=await hire('Fictional Other Approver');
 // The approver holds the employee role only: their decisions come from the reporting line, not a manager role.
 for(const who of [first,second])await setReportingLine(adminCtx(base),{subordinateEmploymentId:who.employmentId,managerEmploymentId:approver.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:outsider.employmentId,managerEmploymentId:otherApprover.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 date=nextWorkday(todayInKualaLumpur());laterDate=nextWorkday(date);
 firstId=(await requestLeave(await login(first),{employmentId:first.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional reason one'})).leaveRequestId;
 secondId=(await requestLeave(await login(second),{employmentId:second.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:laterDate,endDate:laterDate,durationType:'full_day',reason:'Fictional reason two'})).leaveRequestId;
 // Someone else's request, waiting for another approver on the same day: never this approver's to see in the queue.
 await requestLeave(await login(outsider),{employmentId:outsider.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional reason three'});
});

type QueueRow={request:number;applicant:string;leaveType:string;days:number;starts:string;startDate:string;endDate:string};
type Queue={total:number;groups:{kind:string;count:number;reviewAction:string|null}[];leaveRequests?:QueueRow[];leaveRequestsNotListed?:number;decide?:string;note?:string};
/** The disclosed JSON of the latest tool message the model was sent. */
function lastToolResult(request:ModelRequest):Queue{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}

describe('the approval queue names the leave requests waiting for this approver',()=>{
 it('lists who, the leave type, the days and the dates of each request in the approver\'s own queue, and nobody else\'s',async()=>{
  const me=await login(approver);
  const queue=await approvalQueueWithLeaveRequests(me,base.companyId,{decide:true}) as Queue;
  expect(queue.total).toBe(2);
  expect(queue.groups).toEqual([expect.objectContaining({kind:'leave',count:2,reviewAction:'approvals.leave.decide'})]);
  // Numbered by start date as the decision card numbers them, so "the second one" is the same request there.
  expect(queue.leaveRequests).toEqual([
   {request:1,applicant:NAMES.first,leaveType:'Annual Leave',days:1,starts:expect.stringMatching(/^(this_week|next_week)$/),startDate:date,endDate:date},
   {request:2,applicant:NAMES.second,leaveType:'Annual Leave',days:1,starts:expect.stringMatching(/^(this_week|next_week)$/),startDate:laterDate,endDate:laterDate}]);
  expect(queue.decide).toBe('approvals.leave.decide');expect(queue.leaveRequestsNotListed).toBeUndefined();
  expect(queue.note).toMatch(/Name each one in your reply: who, the leave type, the days and the date/);
  expect(queue.note).toMatch(/Never decide one yourself/);
  const body=JSON.stringify(queue);
  expect(body).not.toContain(NAMES.outsider);expect(body).not.toMatch(UUID);
  for(const id of [firstId,secondId,first.employmentId,second.employmentId,first.personId])expect(body).not.toContain(id);
  // The counts are the inbox's own, unchanged.
  expect(await approvalQueueFor(me,base.companyId)).toEqual({total:queue.total,groups:queue.groups});
  // Without the decision card this turn, the requests are still named, with the page to decide them.
  const pageOnly=await approvalQueueWithLeaveRequests(me,base.companyId,{decide:false}) as Queue;
  expect(pageOnly.leaveRequests?.map(row=>row.applicant)).toEqual([NAMES.first,NAMES.second]);
  expect(pageOnly.decide).toBeUndefined();expect(pageOnly.note).toMatch(/link the page where they decide it/);
  expect(MAX_QUEUE_LEAVE_REQUESTS).toBe(5);
 },60000);
 it('gives another approver only their own queue, and a requester none of it',async()=>{
  const other=await approvalQueueWithLeaveRequests(await login(otherApprover),base.companyId,{decide:true}) as Queue;
  expect(other.leaveRequests?.map(row=>[row.applicant,row.startDate])).toEqual([[NAMES.outsider,date]]);
  const otherBody=JSON.stringify(other);for(const name of [NAMES.first,NAMES.second])expect(otherBody).not.toContain(name);
  expect(await approvalQueueWithLeaveRequests(await login(first),base.companyId,{decide:true})).toEqual({total:0,groups:[]});
 },60000);
 it('reaches the model as placeholders and the person as the real names and dates',async()=>{
  const me=await login(approver);
  const model=scriptedModel([{calls:[{name:'approval_queue'}]},request=>{
   const [one,two]=lastToolResult(request).leaveRequests!;
   return{final:{mode:'answer',reply:`Yes: ${one.applicant}'s ${one.days}-day ${one.leaveType} on ${one.startDate} and ${two.applicant}'s on ${two.startDate} are waiting for your approval. Shall I open the first decision for you to review and confirm?`}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:me,conversationId:randomUUID(),question:'anything waiting for my approval?',scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain('approval_queue');
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['approval_queue','ok']]);
  // The model saw placeholders, never a name, a date or an id.
  const sent=lastToolResult(model.requests[1]),text=JSON.stringify(sent);
  for(const secret of [NAMES.first,NAMES.second,NAMES.outsider,date,laterDate])expect(text,secret).not.toContain(secret);
  expect(text).not.toMatch(UUID);
  expect(sent.leaveRequests?.map(row=>[row.request,row.leaveType,row.days])).toEqual([[1,'Annual Leave',1],[2,'Annual Leave',1]]);
  for(const row of sent.leaveRequests!)for(const value of [row.applicant,row.startDate,row.endDate])expect(value).toMatch(/^\{\{T\d+\}\}$/);
  expect(result.trace.disclosure).toEqual([expect.objectContaining({tool:'approval_queue',entity:'approval_queue',removed:[],undeclared:[],
   withheld:expect.arrayContaining(['leaveRequests[0].applicant','leaveRequests[0].startDate','leaveRequests[1].applicant','leaveRequests[1].startDate'])})]);
  // The person sees who and when.
  expect(result.reply).toBe(`Yes: ${NAMES.first}'s 1-day Annual Leave on ${date} and ${NAMES.second}'s on ${laterDate} are waiting for your approval. Shall I open the first decision for you to review and confirm?`);
  expect(result.reads).toContain('approval_queue');
 },60000);
});

describe('the capability catalogue offers an assigned approver without the manager role exactly their decision',()=>{
 const decisions=async(who:Hired)=>(await capabilityCatalogueFor(await login(who))).filter(row=>row.kind==='action'&&row.id.startsWith('approvals.')).map(row=>row.id).sort();
 it('lists the leave decision while a leave request waits for them, and nothing to decide for anyone else',async()=>{
  expect(await decisions(approver)).toEqual(['approvals.leave.decide']);
  // The requester and someone with nothing assigned are offered no decision at all.
  expect(await decisions(first)).toEqual([]);
  const idle=await hire('Fictional Queue Idle Employee');expect(await decisions(idle)).toEqual([]);
  // Once nothing waits for them, the decision is no longer listed.
  await cancelOwnLeave(await login(first),{leaveRequestId:firstId});await cancelOwnLeave(await login(second),{leaveRequestId:secondId});
  expect(await decisions(approver)).toEqual([]);
 },60000);
});
