/**
 * Roster bulk operations on the shared bulk-job kernel (core/roster-bulk-worker.ts, draft migration 9920), against
 * real PostgreSQL, real RLS and real worker ticks. Equivalence is proven side by side in one tenant: group A goes
 * through the old synchronous path, group B (configured identically) through the background job, and the end states
 * are compared after mapping each group's employments to the same tokens — roster rows (cells, rest days, notes),
 * every audit event and payload (roster.manual-changes per employee, the summary events, the upload's history
 * entry, the Schedule Group events) and the outcome the screen shows. The worker runs with one step per chunk so
 * every comparison crosses many chunk transactions.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {runBulkJobTick,type BulkJobHandler} from '../core/bulk-job-worker';
import {rosterBulkJobHandler,scheduleGroupBulkJobHandler} from '../core/roster-bulk-worker';
import {enqueueRosterAssignJob,enqueueRosterCopyJob,enqueueRosterGenerateJob,enqueueRosterImportJob,enqueueScheduleGroupBulkJob,readRosterBulkJob} from '../core/roster-bulk-job';
import {assignShift,assignShiftBulk,copyRoster,createShift,generateRosterFromTemplate,setEmploymentScheduleGroupBulk,setRestDay} from '../core/roster';
import {analyzeRosterImport} from '../core/roster-import';
import {resolveWorkedDayKindTx} from '../core/toil';
import {withTenant} from '../db/client';
import {createAttendanceRule,type AttendanceRuleInput} from '../packs/attendance/service';
import {SCHEDULE_GROUP_BULK_KIND} from '../lib/roster-bulk-job';
import {BULK_JOB_ALREADY_RUNNING} from '../core/bulk-job';
import {ROSTER_BULK_ALREADY_RUNNING} from '../lib/roster-bulk-job';

let b:Base,ctx:SessionContext;
// One step per chunk transaction, so every comparison below crosses many chunks.
const handlers:BulkJobHandler[]=[{...rosterBulkJobHandler,chunkBudgetMs:1,maxStepsPerChunk:2},{...scheduleGroupBulkJobHandler,chunkBudgetMs:1,maxStepsPerChunk:2}];
const TERMINAL=['completed','failed','cancelled'];
async function runJob(id:string,until?:(state:string)=>boolean){
 for(let i=0;i<5000;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(until?.(row.state))return row.state;
  if(TERMINAL.includes(row.state)&&row.notified)return row.state;
  if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('roster job did not finish');
}
const jobRow=async(id:string)=>(await owner.client<{state:string;error:string|null;errors:{rowNum:number;ref:string;message:string}[];counters:Record<string,number>;metrics:Record<string,number>;result:unknown}[]>`select state,error,errors,counters,metrics,result from bulk_job where id=${id}::uuid`)[0];

async function makeEmp(name:string){
 const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:`rb_${randomUUID()}@t.local`}).returning({id:schema.person.id});
 const [e]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employeeCode:`RB${randomUUID().slice(0,6).toUpperCase()}`,hiredOn:'2020-01-01'})
  .returning({id:schema.employment.id,code:schema.employment.employeeCode});
 return{id:e.id,code:e.code!};
}
/** Two identically configured groups of employments; tokens map both to the same names. */
async function groups(n:number){
 const A:{id:string;code:string}[]=[],B:{id:string;code:string}[]=[];
 for(let i=0;i<n;i++){A.push(await makeEmp(`Worker ${String(i).padStart(2,'0')} A`));B.push(await makeEmp(`Worker ${String(i).padStart(2,'0')} B`));}
 const tokens=(g:typeof A)=>new Map<string,string>([...g.map((e,i)=>[e.id,`E${i}`] as [string,string]),...g.map((e,i)=>[e.code,`C${i}`] as [string,string])]);
 return{A,B,mapA:tokens(A),mapB:tokens(B)};
}
const DROP=new Set(['id','tenantId','createdAt','updatedAt']);
const ROW_EVENTS=new Set(['roster.shift.assigned','roster.rest-day.set','roster.cleared']);
function normalize(value:unknown,map:Map<string,string>):unknown{
 if(typeof value==='string')return map.get(value)??value;
 if(Array.isArray(value))return value.map(v=>normalize(v,map));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!DROP.has(k)).map(([k,v])=>[k,normalize(v,map)]));
 return value;
}
const sorted=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).sort();
async function eventIds(){return new Set((await owner.client<{id:string}[]>`select id from domain_event where tenant_id=${b.tenantId}::uuid`).map(r=>r.id));}
/** Every audit event appended since `before` (the job's own completion notice aside), normalized. */
async function newEvents(before:Set<string>,map:Map<string,string>,randomAggregate=false){
 const rows=await owner.client<{id:string;event_type:string;aggregate_type:string;aggregate_id:string;subject_employment_id:string|null;actor_id:string|null;payload:unknown}[]>`
  select id,event_type,aggregate_type,aggregate_id,subject_employment_id,actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type<>'bulk-job.finished'`;
 return sorted(rows.filter(r=>!before.has(r.id)).map(r=>normalize({type:r.event_type,aggregateType:r.aggregate_type,
  // A per-cell event's aggregate is that roster row's own (new) id; roster.copied anchors on a fresh random id.
  aggregate:randomAggregate&&r.event_type==='roster.copied'?'random':ROW_EVENTS.has(r.event_type)?'roster-row':r.aggregate_id,subject:r.subject_employment_id,actor:r.actor_id,payload:r.payload},map)));
}
async function rosterRows(ids:string[],map:Map<string,string>){
 const rows=await owner.client<{employment_id:string;shift_date:string;shift_id:string|null;is_rest_day:boolean;note:string|null}[]>`
  select employment_id,shift_date::text,shift_id,is_rest_day,note from roster_assignment where employment_id=any(${ids}::uuid[])`;
 return sorted(rows.map(r=>normalize(r,map)));
}
const mkShift=(name:string,code:string,over:Record<string,unknown>={})=>createShift(ctx,{companyId:b.companyId,name,code,startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],...over});
const ruleInput=(name:string):AttendanceRuleInput=>({name,status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,
 earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]});
/** A Schedule Group (duty roster control on) whose only allowed shift is `allowed`, holding the given employments. */
async function groupAllowing(allowedName:string,members:string[],duty=true){
 const rule=await createAttendanceRule(ctx,ruleInput(`G${randomUUID().slice(0,5)}`));
 await mkShift(allowedName,`AL${randomUUID().slice(0,4)}`,{ruleId:rule.id});
 await owner.client`update attendance_rule set duty_roster_control=${duty} where id=${rule.id}::uuid`;
 if(members.length)await owner.client`update employment set attendance_rule_id=${rule.id}::uuid where id=any(${members}::uuid[])`;
 return rule;
}
const errorOf=(href:string|null)=>new URL(href??'/','http://x').searchParams.get('error');

beforeAll(async()=>{await migrateTestDb();});
afterAll(async()=>{await closeAll();});
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});

const FROM='2027-03-01',TO='2027-03-14'; // Monday to Sunday, two weeks, in the future

describe('Generate', ()=>{
 it('writes the same cells, rest days and audit as generateRosterFromTemplate, and lands on the same banner',async()=>{
  const S=await mkShift('Day','DAY'),N=await mkShift('Night','NGT',{startTime:'21:00:00',endTime:'06:00:00'});
  const {A,B,mapA,mapB}=await groups(5);
  for(const [g] of [[A],[B]] as const){
   await setRestDay(ctx,{employmentId:g[0].id,shiftDate:'2027-03-02'});
   await assignShift(ctx,{employmentId:g[1].id,shiftDate:'2027-03-06',shiftId:N.id});
  }
  let before=await eventIds();
  const sync=await generateRosterFromTemplate(ctx,{shiftId:S.id,employmentIds:A.map(e=>e.id),from:FROM,to:TO});
  const syncEvents=await newEvents(before,mapA);
  before=await eventIds();
  const job=await enqueueRosterGenerateJob(ctx,{companyId:b.companyId,input:{shiftId:S.id,employmentIds:B.map(e=>e.id),from:FROM,to:TO}});
  expect(job).toMatchObject({state:'queued',op:'generate'});
  expect(await rosterRows(B.map(e=>e.id),mapB),'nothing is written in the request').toHaveLength(2);
  expect(await runJob(job.id)).toBe('completed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
  expect(syncEvents.filter(e=>e.includes('roster.manual-changes'))).toHaveLength(10); // working half + rest half, per employee
  const view=await readRosterBulkJob(ctx,job.id);
  expect(view.href).toBe(`/roster?companyId=${b.companyId}&month=2027-03&generated=${sync.employments}.${sync.workingRows}.${sync.restRows}`);
  const row=await jobRow(job.id);
  expect(Number(row.metrics.chunks)).toBeGreaterThan(3);
  expect(row.result).toEqual({op:'generate',...sync});
  // TOIL reads the day kind (workday / rest day / off day) through the schedule resolver: identical for both groups.
  const kinds=(g:typeof A)=>withTenant(ctx,async tx=>{const out:string[]=[];for(const e of g)for(let d=1;d<=14;d++)out.push(await resolveWorkedDayKindTx(tx,e.id,`2027-03-${String(d).padStart(2,'0')}`));return out;});
  const kindsA=await kinds(A);
  expect(kindsA).toContain('rest_day');
  expect(await kinds(B)).toEqual(kindsA);
 });

 it('refuses the whole grid before any row, with the generator\'s own sentence, when one employee may not work the shift',async()=>{
  const S=await mkShift('Day','DAY');
  const {A,B,mapB}=await groups(4);
  await groupAllowing('Only this one',[A[2].id,B[2].id]);
  let message='';
  try{await generateRosterFromTemplate(ctx,{shiftId:S.id,employmentIds:A.map(e=>e.id),from:FROM,to:TO});}catch(e){message=(e as Error).message;}
  expect(message).toContain('is not allowed by the Schedule Group');
  expect(await rosterRows(A.map(e=>e.id),new Map())).toEqual([]);
  const before=await eventIds();
  const job=await enqueueRosterGenerateJob(ctx,{companyId:b.companyId,input:{shiftId:S.id,employmentIds:B.map(e=>e.id),from:FROM,to:TO}});
  expect(await runJob(job.id)).toBe('failed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual([]);
  expect(await newEvents(before,mapB),'no audit event, no summary').toEqual([]);
  const view=await readRosterBulkJob(ctx,job.id);
  expect(view.error).toBe(message);
  expect(errorOf(view.href)).toBe(message);
  expect(new URL(view.href!,'http://x').searchParams.get('companyId')).toBe(b.companyId);
 });

 it('refuses the whole grid when someone else changes one employee before the checks have run',async()=>{
  const S=await mkShift('Day','DAY');
  const {B,mapB}=await groups(3);
  const job=await enqueueRosterGenerateJob(ctx,{companyId:b.companyId,input:{shiftId:S.id,employmentIds:B.map(e=>e.id),from:FROM,to:TO}});
  expect(await runJob(job.id,state=>state==='running')).toBe('running');
  await groupAllowing('Moved before the checks',[B[2].id]);
  expect(await runJob(job.id)).toBe('failed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual([]);
  expect((await jobRow(job.id)).error).toContain('is not allowed by the Schedule Group');
 });

 it('keeps going when someone else changes one employee after the checks, saving the others and naming the refused one',async()=>{
  const S=await mkShift('Day','DAY');
  const {B}=await groups(5);
  const job=await enqueueRosterGenerateJob(ctx,{companyId:b.companyId,input:{shiftId:S.id,employmentIds:B.map(e=>e.id),from:FROM,to:TO}});
  // Run until every check has passed and the first row has been written.
  for(let i=0;i<2000;i++){
   const [w]=await owner.client<{n:number}[]>`select count(*)::int n from bulk_job_step where job_id=${job.id}::uuid and kind in ('working','rest') and state='applied'`;
   if(w.n>0)break;
   if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));
  }
  const late=B[4];
  await groupAllowing('Moved meanwhile',[late.id]);
  expect(await runJob(job.id)).toBe('failed');
  const row=await jobRow(job.id);
  expect(row.errors).toEqual([expect.objectContaining({ref:late.code,message:expect.stringContaining('is not allowed by the Schedule Group')})]);
  expect(row.error).toContain('is not allowed by the Schedule Group');
  const saved=await owner.client<{n:number}[]>`select count(distinct employment_id)::int n from roster_assignment where employment_id=any(${B.slice(0,4).map(e=>e.id)}::uuid[])`;
  expect(saved[0].n).toBe(4);
  expect(await rosterRows([late.id],new Map())).toEqual([]);
  const [summary]=await owner.client<{payload:{employmentCount:number;rows:number}}[]>`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='roster.bulk.assigned'`;
  expect(summary.payload).toMatchObject({employmentCount:4,rows:40});
 });

 it('admits one roster job at a time per tenant and re-checks the administrator right in the worker',async()=>{
  const S=await mkShift('Day','DAY');
  const {B}=await groups(1);
  await enqueueRosterGenerateJob(ctx,{companyId:b.companyId,input:{shiftId:S.id,employmentIds:[B[0].id],from:FROM,to:TO}});
  await expect(enqueueRosterCopyJob(ctx,{companyId:b.companyId,employmentIds:[B[0].id],sourceFrom:FROM,sourceTo:TO,targetFrom:'2027-04-05'})).rejects.toThrow(ROSTER_BULK_ALREADY_RUNNING);
  expect(BULK_JOB_ALREADY_RUNNING).not.toBe(ROSTER_BULK_ALREADY_RUNNING);
  await expect(enqueueRosterGenerateJob({...ctx,roles:['manager']},{companyId:b.companyId,input:{shiftId:S.id,employmentIds:[B[0].id],from:FROM,to:TO}})).rejects.toThrow(/administrator/i);
 });
});

describe('Copy', ()=>{
 it('copies the same rows forward with the same audit as copyRoster, and lands on the same banner',async()=>{
  const S=await mkShift('Day','DAY'),N=await mkShift('Night','NGT');
  const {A,B,mapA,mapB}=await groups(4);
  for(const g of [A,B]){
   await assignShiftBulk(ctx,{employmentIds:g.map(e=>e.id),shiftDates:['2027-03-01','2027-03-02','2027-03-03'],shiftId:S.id});
   await setRestDay(ctx,{employmentId:g[0].id,shiftDate:'2027-03-06',note:'Family day'});
   await assignShift(ctx,{employmentId:g[1].id,shiftDate:'2027-03-04',shiftId:N.id});
   await setRestDay(ctx,{employmentId:g[2].id,shiftDate:'2027-03-15'}); // a target date that already has a row
  }
  let before=await eventIds();
  const sync=await copyRoster(ctx,{employmentIds:A.map(e=>e.id),sourceFrom:'2027-03-01',sourceTo:'2027-03-07',targetFrom:'2027-03-15'});
  const syncEvents=await newEvents(before,mapA,true);
  before=await eventIds();
  const job=await enqueueRosterCopyJob(ctx,{companyId:b.companyId,employmentIds:B.map(e=>e.id),sourceFrom:'2027-03-01',sourceTo:'2027-03-07',targetFrom:'2027-03-15'});
  expect(await runJob(job.id)).toBe('completed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await newEvents(before,mapB,true)).toEqual(syncEvents);
  expect((await readRosterBulkJob(ctx,job.id)).href).toBe(`/roster?companyId=${b.companyId}&month=2027-03&copied=${sync.copied}`);
 });

 it('copies nothing and files no event when the source window is empty, as copyRoster does',async()=>{
  const {B}=await groups(2);
  const before=await eventIds();
  const job=await enqueueRosterCopyJob(ctx,{companyId:b.companyId,employmentIds:B.map(e=>e.id),sourceFrom:'2027-03-01',sourceTo:'2027-03-07',targetFrom:'2027-03-15'});
  expect(await runJob(job.id)).toBe('completed');
  expect(await newEvents(before,new Map())).toEqual([]);
  expect((await readRosterBulkJob(ctx,job.id)).href).toBe(`/roster?companyId=${b.companyId}&month=2027-03&copied=0`);
 });
});

describe('The grid\'s bulk bar', ()=>{
 const dates=['2027-03-08','2027-03-09','2027-03-10'];
 it('a shift brush equals assignShiftBulk: same rows, one summary event, per-employee audit',async()=>{
  const S=await mkShift('Day','DAY');
  const {A,B,mapA,mapB}=await groups(3);
  let before=await eventIds();
  await assignShiftBulk(ctx,{employmentIds:A.map(e=>e.id),shiftDates:dates,shiftId:S.id});
  const syncEvents=await newEvents(before,mapA);
  before=await eventIds();
  const job=await enqueueRosterAssignJob(ctx,{employmentIds:B.map(e=>e.id),shiftDates:dates,brush:S.id});
  expect(await runJob(job.id)).toBe('completed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
 });

 it('a rest brush equals the per-cell loop, and stops at the same first refusal with the same cells saved',async()=>{
  const {A,B,mapA,mapB}=await groups(3);
  // The middle employee's Schedule Group has Duty Roster Control off, so every one of its cells is refused.
  await groupAllowing('Any',[A[1].id,B[1].id],false);
  let before=await eventIds(),message='';
  try{for(const e of A)for(const shiftDate of dates)await setRestDay(ctx,{employmentId:e.id,shiftDate});}catch(error){message=(error as Error).message;}
  expect(message).toContain('Duty Roster Control is Off');
  const syncEvents=await newEvents(before,mapA);
  before=await eventIds();
  const job=await enqueueRosterAssignJob(ctx,{employmentIds:B.map(e=>e.id),shiftDates:dates,brush:'rest'});
  expect(await runJob(job.id)).toBe('failed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await rosterRows([B[2].id],mapB),'nothing after the refusal').toEqual([]);
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
  expect((await readRosterBulkJob(ctx,job.id)).error).toBe(message);
 });
});

describe('Upload Shift Roster', ()=>{
 const header='employee_no,name,2027-03-01,2027-03-02,2027-03-03,2027-03-06,2027-03-07,2027-04-01';
 const csv=(g:{code:string}[],second:string)=>[header,
  `${g[0].code},x,DAY,DAY,RD,RD,OFF,DAY`,
  `${g[1].code},x,DAY,DAY,RD,RD,,`,
  `${g[2].code},x,${second},${second},${second},,(DAY),`,
  'NOPE,x,DAY,,,,,',
 ].join('\n')+'\n';
 it('writes the same groups, clears, audit and history entry as the synchronous commit, with the same result',async()=>{
  await mkShift('Day','DAY');await mkShift('Night','NGT');
  const {A,B,mapA,mapB}=await groups(3);
  for(const g of [A,B])await setRestDay(ctx,{employmentId:g[0].id,shiftDate:'2027-03-07'}); // OFF clears it
  let before=await eventIds();
  const sync=await analyzeRosterImport(ctx,{csvText:csv(A,'NGT'),month:'2027-03',companyId:b.companyId,fileName:'march.csv',dryRun:false});
  const syncEvents=await newEvents(before,mapA);
  before=await eventIds();
  const job=await enqueueRosterImportJob(ctx,{csvText:csv(B,'NGT'),month:'2027-03',companyId:b.companyId,fileName:'march.csv'});
  expect(await runJob(job.id)).toBe('completed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
  expect(syncEvents.filter(e=>e.includes('roster.bulk.uploaded'))).toHaveLength(1);
  expect(syncEvents.filter(e=>e.includes('roster.cleared'))).toHaveLength(1);
  const view=await readRosterBulkJob(ctx,job.id);
  expect(normalize(view.importResult,mapB)).toEqual(normalize(sync,mapA));
  expect(sync.committed).toBe(true);
 });

 it('stops at the same refused group as the synchronous commit: earlier groups saved, no history entry',async()=>{
  await mkShift('Day','DAY');await mkShift('Night','NGT');
  const {A,B,mapA,mapB}=await groups(3);
  // The third employee's group allows Day only, so the Night group is refused after the Day and rest groups.
  await groupAllowing('Day only',[A[2].id,B[2].id]);
  let before=await eventIds(),message='';
  try{await analyzeRosterImport(ctx,{csvText:csv(A,'NGT'),month:'2027-03',companyId:b.companyId,fileName:'march.csv',dryRun:false});}catch(e){message=(e as Error).message;}
  expect(message).toContain('is not allowed by the Schedule Group');
  const syncEvents=await newEvents(before,mapA);
  expect(syncEvents.some(e=>e.includes('roster.bulk.uploaded'))).toBe(false);
  before=await eventIds();
  const job=await enqueueRosterImportJob(ctx,{csvText:csv(B,'NGT'),month:'2027-03',companyId:b.companyId,fileName:'march.csv'});
  expect(await runJob(job.id)).toBe('failed');
  expect(await rosterRows(B.map(e=>e.id),mapB)).toEqual(await rosterRows(A.map(e=>e.id),mapA));
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
  expect((await readRosterBulkJob(ctx,job.id)).error).toBe(message);
 });
});

describe('Schedule Group bulk assignment', ()=>{
 it('moves everyone with the same per-employee events as setEmploymentScheduleGroupBulk, and lands on the same counts',async()=>{
  const {A,B,mapA,mapB}=await groups(4);
  const rule=await createAttendanceRule(ctx,ruleInput('Target'));
  await owner.client`update employment set attendance_rule_id=${rule.id}::uuid where id=any(${[A[3].id,B[3].id]}::uuid[])`; // already there
  let before=await eventIds();
  const sync=await setEmploymentScheduleGroupBulk(ctx,{employmentIds:A.map(e=>e.id),attendanceRuleId:rule.id});
  const syncEvents=await newEvents(before,mapA);
  before=await eventIds();
  const job=await enqueueScheduleGroupBulkJob(ctx,{employmentIds:B.map(e=>e.id),attendanceRuleId:rule.id,returnQuery:'scheduleGroupId=none'});
  expect(await runJob(job.id)).toBe('completed');
  expect(await newEvents(before,mapB)).toEqual(syncEvents);
  const stored=await owner.client<{id:string;rule:string|null}[]>`select id,attendance_rule_id rule from employment where id=any(${B.map(e=>e.id)}::uuid[])`;
  expect(stored.every(r=>r.rule===rule.id)).toBe(true);
  const view=await readRosterBulkJob(ctx,job.id,SCHEDULE_GROUP_BULK_KIND);
  expect(view.href).toBe(`/admin/attendance/schedule-assignment/bulk?scheduleGroupId=none&bulkChanged=${sync.changed}&bulkUnchanged=${sync.unchanged}`);
 });

 it('moves nobody and names the blocking employee, as the one-transaction batch did',async()=>{
  const day=await mkShift('Day','DAY'),night=await mkShift('Night','NGT');
  const {A,B}=await groups(3);
  const rule=await createAttendanceRule(ctx,ruleInput('Days'));
  await owner.client`insert into attendance_rule_shift(tenant_id,rule_id,shift_id) values(${b.tenantId}::uuid,${rule.id}::uuid,${day.id}::uuid)`;
  for(const g of [A,B])await owner.client`update employment set default_shift_id=${night.id}::uuid where id=${g[1].id}::uuid`;
  let message='';
  try{await setEmploymentScheduleGroupBulk(ctx,{employmentIds:A.map(e=>e.id),attendanceRuleId:rule.id});}catch(e){message=(e as Error).message;}
  expect(message).toMatch(/^Nobody was moved\. Worker 01 A/);
  const before=await eventIds();
  const job=await enqueueScheduleGroupBulkJob(ctx,{employmentIds:B.map(e=>e.id),attendanceRuleId:rule.id,returnQuery:''});
  expect(await runJob(job.id)).toBe('failed');
  expect((await readRosterBulkJob(ctx,job.id,SCHEDULE_GROUP_BULK_KIND)).error).toBe(message.replace('Worker 01 A','Worker 01 B').replace(A[1].code,B[1].code));
  expect(await newEvents(before,new Map())).toEqual([]);
  const stored=await owner.client<{rule:string|null}[]>`select attendance_rule_id rule from employment where id=any(${B.map(e=>e.id)}::uuid[])`;
  expect(stored.every(r=>r.rule===null)).toBe(true);
 });
});
