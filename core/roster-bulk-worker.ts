/** Roster bulk operations on the shared bulk-job kernel (core/bulk-job-worker.ts; draft migration 9920), worker side.
 *
 * Every operation used to run in one transaction that held the tenant's Access lock (and the audit chain) for the
 * whole grid: about 26 s for a 1,200-employee month. Here each employee's rows are one step, written in short chunk
 * transactions through the SAME writers, guards and events the synchronous path used:
 *  - per employee: the duty-roster guard (its roster.manual-changes event), the Schedule Group check, the upserts;
 *  - once per operation: the same thin summary event (roster.bulk.assigned / roster.bulk.rest-day.set /
 *    roster.copied, or the upload's per-group events and its roster.bulk.uploaded history entry).
 *
 * ALL-OR-NOTHING IS KEPT WHERE IT WAS PROMISED. Generate, Copy, the grid's shift brush and each upload group refused
 * the whole grid before writing anything. Their prepare step runs the same guards first, in the same order, in
 * short rolled-back transactions ("validate"): a refusal ends the job before any row is written, with the same
 * sentence. The upload's groups and the grid's rest/clear loop committed one by one and stopped at the first
 * refusal; the job writes exactly what that run would have written (earlier groups, earlier cells), then fails with
 * the same sentence. Each step still re-checks its own employee, so a change made by someone else while the job
 * runs is refused for that employee (recorded on the job), never written past.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {publicErrorMessage} from '../lib/public-error';
import {isDatabaseError} from '../lib/db-error';
import {isAdmin} from '../lib/authz-model';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobPrepared,type BulkJobRefused,type BulkJobStep,type BulkJobStepOutcome,type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx} from '../packs/leave/service';
import {isAiPrincipalCurrentTx} from './ai-principal';
import {assertDutyRosterWriteTx,DutyRosterWriteRefusal} from './schedule-group-controls';
import {
 appendRosterBulkAssignedTx,appendRosterBulkRestDayTx,appendRosterCopiedTx,assertReviewedDepartmentMembersTx,assertRosterAdmin,
 assertRosterDatesWritable,assertShiftsAllowedForEmploymentsTx,captureRosterGenerateInput,clearRoster,copyRosterRowsTx,
 recordRosterUploadTx,rosterCopyNomineesTx,rosterDepartmentMembersTx,rosterGenerationDates,rosterGenerationNominationTx,
 RosterCommandRefusal,setRestDay,validateRosterCopyRange,writeRosterRestRowsTx,writeRosterShiftRowsTx,
 setEmploymentScheduleGroupTx,ScheduleGroupBulkRefusedError,ScheduleGroupNotFoundError,NoEmploymentsSelectedError,ShiftNotInScheduleGroupError,
 type ReviewedRosterDepartment,
} from './roster';
import {assertRosterImportCellsCurrentTx,rosterImportDirectoryTx,rosterImportPlan,rosterImportWriteGroups,type RosterImportCell,type RosterImportDirectory,type RosterImportResult} from './roster-import';
import {employment,person} from '../db/schema';
import {eq} from 'drizzle-orm';
import {ROSTER_BULK_KIND,ROSTER_WRITE_FAILED,SCHEDULE_GROUP_BULK_KIND,SCHEDULE_GROUP_BULK_UNEXPECTED,rosterReadableError} from '../lib/roster-bulk-job';
import type {RosterBulkInput,RosterBulkResult,ScheduleGroupBulkInput,ScheduleGroupBulkResult} from './roster-bulk-job';

/** Step work per chunk transaction before it commits. One employee-month costs about 20–40 ms. */
export const ROSTER_BULK_CHUNK_BUDGET_MS=Number(process.env.ROSTER_BULK_CHUNK_BUDGET_MS??150);
/** Target wall time of one rolled-back validation transaction. */
const VALIDATE_TARGET_MS=Number(process.env.ROSTER_BULK_VALIDATE_TARGET_MS??150);

type EmployeeStep={employmentId:string;ref:string};
type CellStep={employmentId:string;ref:string;date:string};
type ImportCellsStep={group:number;employmentId:string;ref:string;cells:RosterImportCell[]};
type ImportSummaryStep={group:number};
type ImportClearStep={cell:RosterImportCell;ref:string};
type GeneratePlan={op:'generate';companyId:string;month:string;shiftId:string;templateCompanyId:string|null;workingDates:string[];restDates:string[];
 reviewed?:ReviewedRosterDepartment;departmentId?:string;employments:number;summarized?:boolean};
type CopyPlan={op:'copy';companyId:string;month:string;sourceFrom:string;sourceTo:string;targetFrom:string;offsetDays:number;employmentScope:number|'all-visible';summarized?:boolean};
type AssignPlan={op:'assign';companyId:string|null;brush:string;shiftDates:string[];employments:number;summarized?:boolean};
type ImportPlan={op:'import';companyId:string;month:string;fileName:string;result:RosterImportResult;
 groups:{brush:string;dates:string[]}[];refusal?:string|null;summarized?:boolean};
type RosterPlan=GeneratePlan|CopyPlan|AssignPlan|ImportPlan;

/** Thrown to roll back a validation transaction after its checks passed. */
class ValidateRollback extends Error{constructor(){super('roster bulk validation rollback');this.name='ValidateRollback';}}
const ROLLBACK=new ValidateRollback();
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function label(tx:Tx,kind:string,phase:string){await tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);}
/** The roster's own wording for a refusal, as the synchronous actions showed it (app/roster/actions.ts
 * readableError): a domain refusal speaks for itself, and any database failure is the roster's own sentence. */
const rosterMessage=(error:unknown)=>{
 if(isDatabaseError(error)){publicErrorMessage(error);return ROSTER_WRITE_FAILED;} // logged under a reference
 return rosterReadableError(error).slice(0,4000);
};

/**
 * Runs the synchronous path's guards over `items` in short transactions that always roll back. Adaptive chunks of
 * about VALIDATE_TARGET_MS; a busy refusal waits and retries the chunk (never surfaced). The first refusal is thrown.
 */
async function validate<T>(ctx:SessionContext,kind:string,items:readonly T[],begin:(tx:Tx)=>Promise<void>,check:(tx:Tx,chunk:readonly T[])=>Promise<void>,initial=4){
 let size=initial;
 for(let start=0;start<items.length;){
  const chunk=items.slice(start,start+size);let ms=0;
  for(let attempt=0;;attempt++){
   const began=performance.now();
   try{await withTenant(ctx,async tx=>{await label(tx,kind,'validate');await begin(tx);await check(tx,chunk);throw ROLLBACK;});}
   catch(error){
    if(error===ROLLBACK){ms=performance.now()-began;break;}
    if(isTransientBulkJobError(error)&&attempt<40){await sleep(Math.min(2000,50*2**Math.min(attempt,6)));continue;}
    throw error;
   }
  }
  start+=chunk.length;
  size=Math.max(1,Math.min(200,Math.round(size*Math.min(2,Math.max(0.25,VALIDATE_TARGET_MS/Math.max(ms,1))))));
 }
}
const rosterLocks=(ctx:SessionContext)=>async(tx:Tx)=>{await lockAccessConfigurationTx(tx,ctx.tenantId);await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);};
const sortedIds=(ids:readonly string[])=>[...new Set(ids)].sort();
/** assertDutyRosterWriteTx's first refusal covers every employment at once, before any per-employee check. */
async function assertVisibleTx(tx:Tx,ids:readonly string[]){
 if(!ids.length)return;
 const [row]=await tx.execute<{n:number}>(sql`select count(*)::int n from employment where id=any(${'{'+[...new Set(ids)].join(',')+'}'}::uuid[])`);
 if(Number(row?.n)!==new Set(ids).size)throw new DutyRosterWriteRefusal('permission','An employee is unavailable in your company scope.');
}
async function refsTx(tx:Tx,ids:readonly string[]){
 const rows=ids.length?await tx.execute<{id:string;code:string|null}>(sql`select id,employee_code code from employment where id=any(${'{'+[...new Set(ids)].join(',')+'}'}::uuid[])`):[];
 return new Map([...rows].map(row=>[row.id,row.code??'']));
}
/**
 * The guards of one shift brush (assignShiftBulk) and/or one rest brush (setRestDayBulk) over these employments,
 * in the synchronous order: visibility, the shift half's duty guard (ascending id), its Schedule Group check
 * (employment order), then the rest half's duty guard.
 */
async function validateBrushes(ctx:SessionContext,kind:string,ids:readonly string[],shift:{dates:readonly string[];shiftId:string}|null,rest:{dates:readonly string[]}|null){
 const begin=rosterLocks(ctx),sorted=sortedIds(ids);
 if(!ids.length||(!shift?.dates.length&&!rest?.dates.length))return;
 await validate(ctx,kind,[sorted],begin,(tx,[all])=>assertVisibleTx(tx,all),1);
 if(shift?.dates.length){
  await validate(ctx,kind,sorted,begin,(tx,chunk)=>assertDutyRosterWriteTx(tx,ctx,chunk.flatMap(employmentId=>shift.dates.map(shiftDate=>({employmentId,shiftDate,shiftId:shift.shiftId,isRestDay:false})))));
  await validate(ctx,kind,ids,begin,(tx,chunk)=>assertShiftsAllowedForEmploymentsTx(tx,chunk.flatMap(employmentId=>shift.dates.map(shiftDate=>({employmentId,shiftId:shift.shiftId,shiftDate})))),16);
 }
 if(rest?.dates.length)await validate(ctx,kind,sorted,begin,(tx,chunk)=>assertDutyRosterWriteTx(tx,ctx,chunk.flatMap(employmentId=>rest.dates.map(shiftDate=>({employmentId,shiftDate,shiftId:null,isRestDay:true})))));
}

/** Per chunk: the Access and leave-configuration locks the synchronous writer took first, plus caches that are only
 * valid inside this one transaction (the reviewed department's company scope and team, the upload's directory). */
const chunkState=new Map<string,{companies?:Set<string>;team?:Set<string>|null;directory?:RosterImportDirectory;failed?:boolean}>();
async function priorFailureTx(tx:Tx,job:BulkJobRow){
 const state=chunkState.get(job.id);if(state?.failed)return true;
 const [row]=await tx.execute<{failed:boolean}>(sql`select exists(select 1 from bulk_job_step where job_id=${job.id}::uuid and state='failed') as failed`);
 if(row?.failed&&state)state.failed=true;
 return Boolean(row?.failed);
}
async function stepTotalsTx(tx:Tx,job:BulkJobRow){
 const [row]=await tx.execute<{applied:number;failed:number;working:number;rest:number;rows:number;source:number;error:string|null}>(sql`select
   count(*) filter (where state='applied' and not coalesce((result->>'skipped')::boolean,false))::int applied,
   count(*) filter (where state='failed')::int failed,
   coalesce(sum((result->>'workingRows')::int) filter (where state='applied'),0)::int working,
   coalesce(sum((result->>'restRows')::int) filter (where state='applied'),0)::int rest,
   coalesce(sum((result->>'rows')::int) filter (where state='applied'),0)::int "rows",
   coalesce(sum((result->>'sourceRows')::int) filter (where state='applied'),0)::int source,
   (select error from bulk_job_step f where f.job_id=${job.id}::uuid and f.state='failed' order by f.seq limit 1) error
  from bulk_job_step where job_id=${job.id}::uuid`);
 return row;
}
/** The job stops on the first refused row's own sentence (or the upload's first refused group). */
class RosterBulkStopped extends Error{constructor(message:string){super(message);this.name='RosterBulkStopped';}}
const isRefusal=(error:unknown)=>!isTransientBulkJobError(error);
async function fencedTx<T>(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,fn:(tx:Tx)=>Promise<T>){
 return withTenant(ctx,async tx=>{await label(tx,job.kind,'finalize');await unit.fenceTx(tx);return fn(tx);});
}
const markSummarizedTx=(tx:Tx,job:BulkJobRow)=>tx.execute(sql`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||'{"summarized":true}'::jsonb where id=${job.id}::uuid`);

async function prepareRoster(ctx:SessionContext,job:BulkJobRow):Promise<BulkJobPrepared|BulkJobRefused>{
 const input=job.input as RosterBulkInput;
 const kind=job.kind;
 let plan:RosterPlan|null=null;
 const refused=(error:unknown):BulkJobRefused=>({refused:rosterMessage(error),plan:plan??basePlan(input)});
 try{
  assertRosterAdmin(ctx);
  if(input.op==='generate'){
   const p=captureRosterGenerateInput(input.generate);
   plan={op:'generate',companyId:input.companyId,month:p.from.slice(0,7),shiftId:p.shiftId,templateCompanyId:null,workingDates:[],restDates:[],employments:0,
    ...(p.reviewedDepartment?{reviewed:p.reviewedDepartment}:{}),...(p.departmentId&&!p.reviewedDepartment?{departmentId:p.departmentId}:{})};
   const nominated=await withTenant(ctx,async tx=>{
    await label(tx,kind,'prepare');
    const {tpl,employmentIds:ids}=await rosterGenerationNominationTx(tx,ctx,p);
    return{tpl,ids,refs:await refsTx(tx,ids)};
   });
   const {workingDates,restDates}=rosterGenerationDates(nominated.tpl,p);
   plan={...plan,templateCompanyId:nominated.tpl.companyId,workingDates,restDates,employments:nominated.ids.length};
   await validateBrushes(ctx,kind,nominated.ids,{dates:workingDates,shiftId:p.shiftId},{dates:restDates});
   return{plan,counters:{employees:nominated.ids.length},steps:nominated.ids.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:nominated.refs.get(employmentId)??''} satisfies EmployeeStep}))};
  }
  if(input.op==='copy'){
   const c=input.copy;const {offsetDays}=validateRosterCopyRange(c);
   plan={op:'copy',companyId:input.companyId,month:c.targetFrom.slice(0,7),sourceFrom:c.sourceFrom,sourceTo:c.sourceTo,targetFrom:c.targetFrom,offsetDays,
    employmentScope:c.employmentIds.length>0?c.employmentIds.length:'all-visible'};
   const nominated=await withTenant(ctx,async tx=>{
    await label(tx,kind,'prepare');await rosterLocks(ctx)(tx);
    const ids=await rosterCopyNomineesTx(tx,c);
    return{ids,refs:await refsTx(tx,ids)};
   });
   if(nominated.ids.length){
    const begin=rosterLocks(ctx);
    await validate(ctx,kind,[nominated.ids],begin,(tx,[all])=>assertVisibleTx(tx,all),1);
    const rowsFor=async(tx:Tx,ids:readonly string[])=>{
     const read=await tx.execute<{employment_id:string;shift_date:string;shift_id:string|null;is_rest_day:boolean;note:string|null}>(sql`select employment_id,shift_date::text,shift_id,is_rest_day,note
      from roster_assignment where shift_date between ${c.sourceFrom}::date and ${c.sourceTo}::date and employment_id=any(${'{'+ids.join(',')+'}'}::uuid[])`);
     return [...read].map(r=>({employmentId:r.employment_id,shiftDate:new Date(Date.parse(`${r.shift_date}T00:00:00Z`)+offsetDays*86_400_000).toISOString().slice(0,10),shiftId:r.shift_id,isRestDay:r.is_rest_day,note:r.note}));
    };
    await validate(ctx,kind,sortedIds(nominated.ids),begin,async(tx,chunk)=>{const values=await rowsFor(tx,chunk);if(values.length)await assertDutyRosterWriteTx(tx,ctx,values);});
    await validate(ctx,kind,nominated.ids,begin,async(tx,chunk)=>assertShiftsAllowedForEmploymentsTx(tx,(await rowsFor(tx,chunk)).map(v=>({employmentId:v.employmentId,shiftId:v.shiftId,shiftDate:v.shiftDate}))),16);
   }
   return{plan,counters:{employees:nominated.ids.length},steps:nominated.ids.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:nominated.refs.get(employmentId)??''} satisfies EmployeeStep}))};
  }
  if(input.op==='assign'){
   const a=input.assign;
   plan={op:'assign',companyId:input.companyId,brush:a.brush,shiftDates:a.shiftDates,employments:a.employmentIds.length};
   assertRosterDatesWritable(ctx,a.shiftDates);
   const refs=await withTenant(ctx,tx=>refsTx(tx,a.employmentIds));
   if(a.brush==='rest'||a.brush==='clear'){
    // The synchronous bar wrote one cell per transaction, in this order, and stopped at the first refusal.
    const cells=a.employmentIds.flatMap(employmentId=>a.shiftDates.map(date=>({employmentId,date,ref:refs.get(employmentId)??''} satisfies CellStep)));
    return{plan,counters:{cells:cells.length},steps:cells.map((payload,i)=>({kind:'cell',rowNum:i+1,payload}))};
   }
   if(!a.employmentIds.length||!a.shiftDates.length)return{plan,counters:{},steps:[]};
   await validateBrushes(ctx,kind,a.employmentIds,{dates:a.shiftDates,shiftId:a.brush},null);
   return{plan,counters:{employees:a.employmentIds.length},steps:a.employmentIds.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:refs.get(employmentId)??''} satisfies EmployeeStep}))};
  }
  // Upload Shift Roster: the same planner as the preview, from the job's stored file.
  const u=input.import;
  const csvText=(job.source_content??Buffer.alloc(0)).toString('utf8');
  const nomination=await rosterImportPlan(ctx,{csvText,month:u.month,companyId:input.companyId,fileName:u.fileName,dryRun:false});
  const {groups,clears}=rosterImportWriteGroups(nomination.changes);
  const importPlan:ImportPlan={op:'import',companyId:input.companyId,month:u.month,fileName:u.fileName,result:nomination.result,groups:groups.map(g=>({brush:g.brush,dates:g.dates})),refusal:null};
  plan=importPlan;
  assertRosterDatesWritable(ctx,[...new Set(nomination.changes.map(cell=>cell.date))]);
  // Each group was one transaction that committed before the next began: the first refused group ends the upload
  // with the earlier groups saved and no history entry.
  let writable=groups.length;
  for(let g=0;g<groups.length;g++){
   const group=groups[g];
   try{await validateBrushes(ctx,kind,group.employmentIds,group.brush==='rest'?null:{dates:group.dates,shiftId:group.brush},group.brush==='rest'?{dates:group.dates}:null);}
   catch(error){if(!isRefusal(error))throw error;importPlan.refusal=rosterMessage(error);writable=g;break;}
  }
  const steps:BulkJobPrepared['steps']=[];
  for(let g=0;g<writable;g++){
   for(const employmentId of groups[g].employmentIds){
    const cells=groups[g].cells.filter(cell=>cell.employmentId===employmentId);
    steps.push({kind:'cells',rowNum:cells[0]?.sourceRow??null,payload:{group:g,employmentId,ref:cells[0]?.employeeCode??'',cells} satisfies ImportCellsStep});
   }
   steps.push({kind:'summary',rowNum:null,payload:{group:g} satisfies ImportSummaryStep});
  }
  if(importPlan.refusal===null)for(const cell of clears)steps.push({kind:'clear',rowNum:cell.sourceRow,payload:{cell,ref:cell.employeeCode} satisfies ImportClearStep});
  return{plan:importPlan,counters:{cells:nomination.changes.length},steps};
 }catch(error){
  if(!isRefusal(error))throw error;
  return refused(error);
 }
}
function basePlan(input:RosterBulkInput):Partial<RosterPlan>{
 if(input.op==='generate')return{op:'generate',companyId:input.companyId,month:String(input.generate?.from??'').slice(0,7)};
 if(input.op==='copy')return{op:'copy',companyId:input.companyId,month:String(input.copy?.targetFrom??'').slice(0,7)};
 return{op:input.op,companyId:input.companyId} as Partial<RosterPlan>;
}

async function applyRosterStep(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:BulkJobStep):Promise<BulkJobStepOutcome>{
 assertRosterAdmin(ctx);
 const plan=job.plan as RosterPlan;
 const state=chunkState.get(job.id)??{};chunkState.set(job.id,state);
 if(plan.op==='generate'){
  const {employmentId}=step.payload as EmployeeStep;
  if(plan.reviewed){
   // Narrowed to this employee: the reviewed department, company scope and team as the writer checked them.
   await assertReviewedDepartmentMembersTx(tx,ctx,plan.reviewed,plan.templateCompanyId,[employmentId]);
  }else if(plan.departmentId){
   if(!(await rosterDepartmentMembersTx(tx,{departmentId:plan.departmentId,templateCompanyId:plan.templateCompanyId},[employmentId])).length)
    throw new RosterCommandRefusal('selection','The department selection changed. Prepare it again.');
  }
  const workingRows=await writeRosterShiftRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.workingDates,shiftId:plan.shiftId});
  const restRows=await writeRosterRestRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.restDates});
  return{result:{workingRows,restRows},counters:{saved:1}};
 }
 if(plan.op==='copy'){
  const {employmentId}=step.payload as EmployeeStep;
  await lockLeaveDependenciesTx(tx,ctx.tenantId,[employmentId]);
  const copied=await copyRosterRowsTx(tx,ctx,{employmentIds:[employmentId],sourceFrom:plan.sourceFrom,sourceTo:plan.sourceTo,offsetDays:plan.offsetDays});
  return{result:copied,counters:{saved:1}};
 }
 if(plan.op==='assign'){
  if(step.kind==='cell'){
   if(await priorFailureTx(tx,job))return{result:{skipped:true},counters:{skipped:1}};
   const {employmentId,date}=step.payload as CellStep;
   if(plan.brush==='rest')await setRestDay(ctx,{employmentId,shiftDate:date},tx);
   else await clearRoster(ctx,{employmentId,shiftDate:date},tx);
   return{result:{rows:1},counters:{saved:1}};
  }
  const {employmentId}=step.payload as EmployeeStep;
  const rows=await writeRosterShiftRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.shiftDates,shiftId:plan.brush});
  return{result:{rows},counters:{saved:1}};
 }
 // Upload: the synchronous commit stopped at its first refusal, so nothing after a refused step is written.
 if(await priorFailureTx(tx,job))return{result:{skipped:true},counters:{skipped:1}};
 state.directory??=await rosterImportDirectoryTx(ctx,plan.companyId,tx);
 if(step.kind==='cells'){
  const {group,employmentId,cells}=step.payload as ImportCellsStep;const g=plan.groups[group];
  await assertRosterImportCellsCurrentTx(ctx,tx,state.directory,cells);
  const rows=g.brush==='rest'
   ?await writeRosterRestRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:g.dates})
   :await writeRosterShiftRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:g.dates,shiftId:g.brush});
  return{result:{group,rows},counters:{saved:1}};
 }
 if(step.kind==='summary'){
  const {group}=step.payload as ImportSummaryStep;const g=plan.groups[group];
  const [done]=await tx.execute<{n:number;rows:number}>(sql`select count(*)::int n,coalesce(sum((result->>'rows')::int),0)::int "rows" from bulk_job_step
   where job_id=${job.id}::uuid and kind='cells' and state='applied' and (payload->>'group')::int=${group}`);
  if(Number(done?.n)>0){
   if(g.brush==='rest')await appendRosterBulkRestDayTx(tx,ctx,{anchorId:plan.companyId,shiftId:null,employmentCount:Number(done.n),dateCount:g.dates.length,rows:Number(done.rows)});
   else await appendRosterBulkAssignedTx(tx,ctx,{shiftId:g.brush,employmentCount:Number(done.n),dateCount:g.dates.length,rows:Number(done.rows)});
  }
  return{result:{group,summary:true}};
 }
 const {cell}=step.payload as ImportClearStep;
 await assertRosterImportCellsCurrentTx(ctx,tx,state.directory,[cell]);
 await clearRoster(ctx,{employmentId:cell.employmentId,shiftDate:cell.date},tx);
 return{result:{rows:1},counters:{saved:1}};
}

async function finalizeRoster(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<{result:RosterBulkResult}>{
 assertRosterAdmin(ctx);
 const plan=job.plan as RosterPlan;
 const totals=await fencedTx(ctx,job,unit,async tx=>{
  const t=await stepTotalsTx(tx,job);
  if(!plan.summarized){
   // The operation's one summary event, for the rows actually written, once (the plan flag survives a restart).
   if(plan.op==='generate'&&t.applied>0){
    if(plan.workingDates.length)await appendRosterBulkAssignedTx(tx,ctx,{shiftId:plan.shiftId,employmentCount:t.applied,dateCount:plan.workingDates.length,rows:t.working});
    if(plan.restDates.length)await appendRosterBulkRestDayTx(tx,ctx,{anchorId:plan.shiftId,shiftId:plan.shiftId,employmentCount:t.applied,dateCount:plan.restDates.length,rows:t.rest});
   }else if(plan.op==='copy'&&t.source>0){
    await appendRosterCopiedTx(tx,ctx,{sourceFrom:plan.sourceFrom,sourceTo:plan.sourceTo,targetFrom:plan.targetFrom,offsetDays:plan.offsetDays,rows:t.rows,employmentScope:plan.employmentScope});
   }else if(plan.op==='assign'&&plan.brush!=='rest'&&plan.brush!=='clear'&&t.applied>0){
    await appendRosterBulkAssignedTx(tx,ctx,{shiftId:plan.brush,employmentCount:t.applied,dateCount:plan.shiftDates.length,rows:t.rows});
   }else if(plan.op==='import'&&!plan.refusal&&t.failed===0){
    const r=plan.result;
    await recordRosterUploadTx(tx,ctx,{companyId:plan.companyId,month:plan.month,fileName:plan.fileName,employees:r.employees,rowsRead:r.rowsRead,changed:r.changed,rejected:r.rejects.length});
   }
   await markSummarizedTx(tx,job);
  }
  return t;
 });
 if(plan.op==='import'&&plan.refusal)throw new RosterBulkStopped(plan.refusal);
 if(totals.failed>0)throw new RosterBulkStopped(totals.error??'');
 if(plan.op==='generate')return{result:{op:'generate',employments:totals.applied,workingDates:plan.workingDates.length,restDates:plan.restDates.length,workingRows:totals.working,restRows:totals.rest}};
 if(plan.op==='copy')return{result:{op:'copy',copied:totals.source>0?totals.rows:0,sourceRows:totals.source}};
 if(plan.op==='assign')return{result:{op:'assign',assigned:totals.rows}};
 return{result:{op:'import',result:{...plan.result,committed:true}}};
}

export const rosterBulkJobHandler:BulkJobHandler={
 kind:ROSTER_BULK_KIND,
 mode:'per-step',
 chunkBudgetMs:ROSTER_BULK_CHUNK_BUDGET_MS,
 maxStepsPerChunk:32,
 // A row another writer keeps locked is retried, then recorded as not saved instead of holding up the job.
 transientStepLimit:100,
 stepRef:step=>String((step.payload as {ref?:string}).ref??''),
 prepare:prepareRoster,
 async beginChunkTx(tx,ctx,job){
  chunkState.set(job.id,{});
  assertRosterAdmin(ctx);
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const plan=job.plan as RosterPlan|null;
  if(plan?.op==='generate'&&plan.reviewed&&!await isAiPrincipalCurrentTx(tx,ctx))throw new RosterCommandRefusal('permission','Current calling authority could not be confirmed.');
  await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
 },
 applyStepTx:(tx,ctx,job,step)=>applyRosterStep(tx,ctx,job,step),
 finalize:finalizeRoster,
 async describeFailure(job,error){return{error:rosterMessage(error),errors:job.errors??[]};},
 async afterTerminal(_ctx,job){chunkState.delete(job.id);},
};

// ── Schedule Group bulk assignment ─────────────────────────────────────────────────────────────────────

/** The Schedule Group screens are administrator-only (requireAdmin); the worker re-checks the creator's fresh role. */
class ScheduleGroupAuthorityLost extends Error{constructor(){super(SCHEDULE_GROUP_BULK_UNEXPECTED);this.name='ScheduleGroupAuthorityLost';}}
const assertScheduleAdmin=(ctx:SessionContext)=>{if(!isAdmin(ctx))throw new ScheduleGroupAuthorityLost();};
/** The refusals the Schedule Group screen prints as they are (app/admin/attendance/schedule-assignment/actions.ts
 * messageFor); anything else is stored as a code the screen renders as its own "unexpected error" sentence. */
const scheduleGroupMessage=(error:unknown)=>error instanceof ShiftNotInScheduleGroupError||error instanceof ScheduleGroupNotFoundError
 ||error instanceof ScheduleGroupBulkRefusedError||error instanceof NoEmploymentsSelectedError||error instanceof RosterBulkStopped
 ?error.message.slice(0,4000):SCHEDULE_GROUP_BULK_UNEXPECTED;
async function whoTx(tx:Tx,employmentId:string){
 const [who]=await tx.select({name:person.fullName,code:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,employmentId)).limit(1);
 return who;
}
type SchedulePlan={returnQuery:string;attendanceRuleId:string|null;requested:number};

export const scheduleGroupBulkJobHandler:BulkJobHandler<EmployeeStep>={
 kind:SCHEDULE_GROUP_BULK_KIND,
 mode:'per-step',
 chunkBudgetMs:ROSTER_BULK_CHUNK_BUDGET_MS,
 maxStepsPerChunk:32,
 transientStepLimit:100,
 stepRef:step=>step.payload.ref,
 /** All or nothing, as setEmploymentScheduleGroupBulk: the same per-employment writer and reverse check over every
  * employment in ascending id order, rolled back; the first refusal names the employee and nobody is moved. */
 async prepare(ctx,job){
  const input=job.input as ScheduleGroupBulkInput;
  const plan:SchedulePlan={returnQuery:input.returnQuery,attendanceRuleId:input.attendanceRuleId,requested:0};
  try{
   assertScheduleAdmin(ctx);
   const ids=sortedIds(input.employmentIds.map(v=>v.trim()).filter(Boolean));
   if(ids.length===0)throw new NoEmploymentsSelectedError();
   plan.requested=ids.length;
   const begin=async(tx:Tx)=>{await tx.execute(sql`select app.access_workforce_write_lock()`);};
   await validate(ctx,job.kind,ids,begin,async(tx,chunk)=>{
    await lockLeaveDependenciesTx(tx,ctx.tenantId,chunk);
    for(const employmentId of chunk){
     try{await setEmploymentScheduleGroupTx(tx,ctx,{employmentId,attendanceRuleId:input.attendanceRuleId});}
     catch(e){
      if(e instanceof ShiftNotInScheduleGroupError){const who=await whoTx(tx,employmentId);throw new ScheduleGroupBulkRefusedError(who?.name??employmentId,who?.code??null,e);}
      throw e;
     }
    }
   },8);
   const refs=await withTenant(ctx,tx=>refsTx(tx,ids));
   return{plan,counters:{requested:ids.length},steps:ids.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:refs.get(employmentId)??''}}))};
  }catch(error){
   if(!isRefusal(error))throw error;
   return{refused:scheduleGroupMessage(error),plan};
  }
 },
 async beginChunkTx(tx,ctx){assertScheduleAdmin(ctx);await tx.execute(sql`select app.access_workforce_write_lock()`);},
 async applyStepTx(tx,ctx,job,step){
  const plan=job.plan as SchedulePlan;const {employmentId}=step.payload;
  try{
   const r=await setEmploymentScheduleGroupTx(tx,ctx,{employmentId,attendanceRuleId:plan.attendanceRuleId});
   const counters:Record<string,number>=r.changed?{changed:1}:{unchanged:1};
   return{result:{changed:r.changed},counters};
  }catch(e){
   if(isTransientBulkJobError(e))throw e;
   // Someone changed this employee's shifts (or the group) while the job ran: name them, as the batch refusal does.
   if(e instanceof ShiftNotInScheduleGroupError){const who=await whoTx(tx,employmentId);const name=who?.code?`${who.name} (${who.code})`:(who?.name??employmentId);throw new Error(`${name} cannot join this Schedule Group: ${e.message}`);}
   throw new Error(scheduleGroupMessage(e));
  }
 },
 async finalize(ctx,job,unit){
  assertScheduleAdmin(ctx);
  const plan=job.plan as SchedulePlan;
  const t=await fencedTx(ctx,job,unit,async tx=>{
   const [row]=await tx.execute<{changed:number;unchanged:number;failed:number;error:string|null}>(sql`select
     count(*) filter (where state='applied' and (result->>'changed')::boolean)::int changed,
     count(*) filter (where state='applied' and not (result->>'changed')::boolean)::int unchanged,
     count(*) filter (where state='failed')::int failed,
     (select error from bulk_job_step f where f.job_id=${job.id}::uuid and f.state='failed' order by f.seq limit 1) error
    from bulk_job_step where job_id=${job.id}::uuid`);
   return row;
  });
  if(t.failed>0)throw new RosterBulkStopped(t.error??SCHEDULE_GROUP_BULK_UNEXPECTED);
  const result:ScheduleGroupBulkResult={requested:plan.requested,changed:t.changed,unchanged:t.unchanged};
  return{result};
 },
 async describeFailure(job,error){return{error:scheduleGroupMessage(error),errors:job.errors??[]};},
};
