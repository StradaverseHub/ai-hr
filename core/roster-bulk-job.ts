/** Roster bulk operations as clients of the shared bulk-job kernel (core/bulk-job.ts, draft migration 5040): the web
 * side. Each door checks the same authority the synchronous path checked, then only enqueues; the protected import
 * worker writes (core/roster-bulk-worker.ts). No roster row changes in an HTTP request. */
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,bulkJobWaitingTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,markBulkJobWatchedTx,type BulkJobRow} from './bulk-job';
import {assertRosterAdmin,assertRosterDatesWritable,captureRosterGenerateInput,rosterGenerationNominationTx,validateRosterCopyRange,NoEmploymentsSelectedError,type RosterGenerateInput} from './roster';
import {isAdmin} from '../lib/authz-model';
import {ROSTER_BULK_ALREADY_RUNNING,ROSTER_BULK_KIND,SCHEDULE_GROUP_BULK_KIND,type RosterBulkJobView,type RosterBulkOp} from '../lib/roster-bulk-job';
import type {RosterImportResult} from './roster-import';

export class RosterBulkJobError extends Error{constructor(message:string,readonly status=400){super(message);this.name='RosterBulkJobError';}}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** What the worker reads back (bulk_job.input). The upload's file is the job's source content, not input.
 * The top-level keys and their JSON types are the kind's declared input_shape (migration 5040), which the database
 * checks at admission. A shape has no null, so a key that would be null is left out and read back as null: a grid
 * brush with no company chosen, and a Schedule Group batch that takes the employees out of every group. */
export type RosterBulkInput=
 |{op:'generate';companyId:string;generate:RosterGenerateInput}
 |{op:'copy';companyId:string;copy:{employmentIds:string[];sourceFrom:string;sourceTo:string;targetFrom:string}}
 |{op:'assign';companyId?:string;assign:{employmentIds:string[];shiftDates:string[];brush:string}}
 |{op:'import';companyId:string;import:{month:string;fileName:string}};
export type ScheduleGroupBulkInput={employmentIds:string[];attendanceRuleId?:string;returnQuery:string};

/** The outcomes the synchronous paths returned, kept on the finished job (bulk_job.result). */
export type RosterBulkResult=
 |{op:'generate';employments:number;workingDates:number;restDates:number;workingRows:number;restRows:number}
 |{op:'copy';copied:number;sourceRows:number}
 |{op:'assign';assigned:number}
 |{op:'import';result:RosterImportResult};
export type ScheduleGroupBulkResult={requested:number;changed:number;unchanged:number};

const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new RosterBulkJobError(error.message===BULK_JOB_ALREADY_RUNNING?ROSTER_BULK_ALREADY_RUNNING:error.message==='Job unavailable.'?'This roster job is unavailable.':error.message,error.status);
 return error;
};
async function admit(ctx:SessionContext,kind:string,input:unknown,companyIds:readonly string[],source?:{name:string;content:Buffer},operationKey?:string){
 try{
  return await withTenant(ctx,async tx=>{
   const {row}=await enqueueBulkJobTx(tx,ctx,{kind,operationKey,companyIds,input,...(source?{source}:{})});
   return viewTx(tx,row);
  });
 }catch(error){throw kernelError(error);}
}

/** Generate a roster window from a shift's weekly pattern. Before anything is queued, the same administrator
 * check, input capture and read-only nomination as generateRosterFromTemplate (template, nominated employments,
 * the reviewed department and team), so those refusals still answer the click; the targets were admitted by the
 * caller (app/roster/command-targets.ts). Every row's guards run in the worker, which nominates again. */
export async function enqueueRosterGenerateJob(ctx:SessionContext,p:{companyId:string;input:RosterGenerateInput;operationKey?:string}){
 assertRosterAdmin(ctx);
 const input=captureRosterGenerateInput(p.input);
 await withTenant(ctx,tx=>rosterGenerationNominationTx(tx,ctx,input));
 return admit(ctx,ROSTER_BULK_KIND,{op:'generate',companyId:p.companyId,generate:input} satisfies RosterBulkInput,uuid.test(p.companyId)?[p.companyId]:[],undefined,p.operationKey);
}
/** Copy a roster window forward onto the admitted employments (rosterFormCopyTargets). */
export function enqueueRosterCopyJob(ctx:SessionContext,p:{companyId:string;employmentIds:string[];sourceFrom:string;sourceTo:string;targetFrom:string;operationKey?:string}){
 assertRosterAdmin(ctx);
 validateRosterCopyRange(p);
 const copy={employmentIds:[...new Set(p.employmentIds.filter(Boolean))],sourceFrom:p.sourceFrom,sourceTo:p.sourceTo,targetFrom:p.targetFrom};
 return admit(ctx,ROSTER_BULK_KIND,{op:'copy',companyId:p.companyId,copy} satisfies RosterBulkInput,uuid.test(p.companyId)?[p.companyId]:[],undefined,p.operationKey);
}
/** The roster grid's bulk bar: one brush over the ticked employees and the window's dates. Both rights are checked
 * here as bulkAssignAction checked them (administrator, then the dates); the worker re-checks per row. */
export async function enqueueRosterAssignJob(ctx:SessionContext,p:{companyId?:string|null;employmentIds:string[];shiftDates:string[];brush:string;operationKey?:string}){
 assertRosterAdmin(ctx);
 assertRosterDatesWritable(ctx,p.shiftDates);
 const assign={employmentIds:p.employmentIds.slice(),shiftDates:p.shiftDates.slice(),brush:p.brush};
 const companyId=p.companyId&&uuid.test(p.companyId)?p.companyId:null;
 const view=await admit(ctx,ROSTER_BULK_KIND,{op:'assign',...(companyId?{companyId}:{}),assign} satisfies RosterBulkInput,companyId?[companyId]:[],undefined,p.operationKey);
 // The creator is on the grid now; its polls keep this current (a short watched brush sends no bell notice).
 await withTenant(ctx,tx=>markBulkJobWatchedTx(tx,view.id)).catch(()=>undefined);
 return view;
}
/** Upload Shift Roster: the month grid is the job's source; the worker re-derives everything from it. */
export function enqueueRosterImportJob(ctx:SessionContext,p:{csvText:string;month:string;companyId:string;fileName?:string;operationKey?:string}){
 assertRosterAdmin(ctx);
 if(!uuid.test(p.companyId))throw new RosterBulkJobError('Choose a company before uploading.');
 const content=Buffer.from(p.csvText,'utf8');
 return admit(ctx,ROSTER_BULK_KIND,{op:'import',companyId:p.companyId,import:{month:p.month,fileName:p.fileName??''}} satisfies RosterBulkInput,[p.companyId],
  {name:(p.fileName||'roster.csv').slice(0,255),content},p.operationKey);
}
/** Put many employments in a Schedule Group (or take them out). Same refusal as setEmploymentScheduleGroupBulk for
 * an empty selection; the per-employment writer and its reverse check run in the worker. */
export function enqueueScheduleGroupBulkJob(ctx:SessionContext,p:{employmentIds:readonly string[];attendanceRuleId:string|null;returnQuery:string;operationKey?:string}){
 if(!isAdmin(ctx))throw new RosterBulkJobError('Forbidden',403);
 const ids=[...new Set(p.employmentIds.map(v=>v.trim()).filter(Boolean))].sort();
 if(ids.length===0)throw new NoEmploymentsSelectedError();
 const input:ScheduleGroupBulkInput={employmentIds:ids,...(p.attendanceRuleId===null?{}:{attendanceRuleId:p.attendanceRuleId}),returnQuery:p.returnQuery.slice(0,4000)};
 return admit(ctx,SCHEDULE_GROUP_BULK_KIND,input,[],undefined,p.operationKey);
}

const SCHEDULE_BULK_PAGE='/admin/attendance/schedule-assignment/bulk';
/** Where the synchronous action redirected for this outcome; the screen navigates there once the job has ended. */
function outcomeHref(row:BulkJobRow):string|null{
 if(!['completed','failed','cancelled'].includes(row.state))return null;
 const error=row.state==='completed'?null:(row.error??'');
 if(row.kind===SCHEDULE_GROUP_BULK_KIND){
  const input=row.plan as {returnQuery?:string}|null;
  const params=new URLSearchParams(input?.returnQuery??'');
  const result=row.result as ScheduleGroupBulkResult|null;
  if(error!==null||!result)params.set('error',error||'');
  else{params.set('bulkChanged',String(result.changed));params.set('bulkUnchanged',String(result.unchanged));}
  return `${SCHEDULE_BULK_PAGE}?${params}`;
 }
 const plan=row.plan as {op?:RosterBulkOp;companyId?:string|null;month?:string}|null;
 if(!plan?.op||plan.op==='assign'||plan.op==='import')return null;
 const q=new URLSearchParams();if(plan.companyId)q.set('companyId',plan.companyId);
 const result=row.result as RosterBulkResult|null;
 if(error!==null||!result){q.set('error',error||'');return `/roster?${q}`;}
 if(plan.month)q.set('month',plan.month);
 if(result.op==='generate')q.set('generated',`${result.employments}.${result.workingRows}.${result.restRows}`);
 else if(result.op==='copy')q.set('copied',String(result.copied));
 return `/roster?${q}`;
}
export function rosterBulkJobView(row:BulkJobRow,worker:'running'|'unavailable'='running',waiting=false):RosterBulkJobView{
 const plan=row.plan as {op?:RosterBulkOp}|null;const input=row.input as RosterBulkInput|null;
 const op=row.kind===SCHEDULE_GROUP_BULK_KIND?'schedule-group':(plan?.op??input?.op??'assign');
 const result=row.result as RosterBulkResult|null;
 return{id:row.id,kind:row.kind,op,state:row.state,stepsDone:row.steps_done,stepsTotal:row.steps_total,
  worker:row.state==='queued'?worker:'running',updatedAt:new Date(row.updated_at).toISOString(),error:row.state==='completed'?null:row.error,
  waiting:row.state==='queued'&&waiting,
  href:outcomeHref(row),importResult:row.state==='completed'&&result?.op==='import'?result.result:null};
}
async function viewTx(tx:Tx,row:BulkJobRow){
 if(row.state!=='queued')return rosterBulkJobView(row);
 return rosterBulkJobView(row,await bulkJobWorkerStatusTx(tx,row.kind),await bulkJobWaitingTx(tx,row.id));
}
/** The creator's view of one of their roster or Schedule Group bulk jobs (row security hides anyone else's).
 * `watch`: the progress screen is polling, which lets a short watched job skip its bell notice. */
export async function readRosterBulkJob(ctx:SessionContext,id:string,kind:typeof ROSTER_BULK_KIND|typeof SCHEDULE_GROUP_BULK_KIND=ROSTER_BULK_KIND,options:{watch?:boolean}={}){
 try{return await withTenant(ctx,async tx=>{
  const row=await bulkJobTx(tx,id,{kind});
  if(options.watch&&!['completed','failed','cancelled'].includes(row.state))await markBulkJobWatchedTx(tx,row.id);
  return viewTx(tx,row);
 });}catch(error){throw kernelError(error);}
}
