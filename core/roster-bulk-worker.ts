/** Roster bulk operations on the shared bulk-job kernel (core/bulk-job-worker.ts; draft migration 9920), worker side.
 *
 * Every operation used to run in one transaction that held the tenant's Access lock (and the audit chain) for the
 * whole grid: about 26 s for a 1,200-employee month. Here each employee's rows are one step (Generate: one per half
 * of the generator), written in short chunk transactions through the SAME writers, guards and events the
 * synchronous path used:
 *  - per employee: the duty-roster guard (its roster.manual-changes event), the Schedule Group check, the upserts;
 *  - once per operation: the same thin summary event (roster.bulk.assigned / roster.bulk.rest-day.set /
 *    roster.copied, or the upload's per-group events and its roster.bulk.uploaded history entry).
 *
 * ALL-OR-NOTHING IS KEPT WHERE IT WAS PROMISED. Generate, Copy, the grid's shift brush, each upload group and the
 * Schedule Group batch refused the whole grid before writing anything. Their first steps are CHECK steps: the same
 * guards, in the same order (visibility, the duty guard by employment id, the Schedule Group check in employment
 * order, the rest half), each inside a savepoint that is always rolled back, so a check commits nothing but its own
 * applied marker. The first refused check ends the job before any row is written, with the same sentence. The
 * upload's groups and the grid's rest/clear loop committed one by one and stopped at the first refusal; the job
 * writes exactly what that run would have written (earlier groups, earlier cells), then fails with the same sentence.
 * Every write step still re-checks its own employee, so a change made by someone else while the job runs is refused
 * for that employee (recorded on the job), never written past.
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

/** Step work per chunk transaction before it commits. One employee-month half costs about 10–40 ms on a quiet host. */
export const ROSTER_BULK_CHUNK_BUDGET_MS=Number(process.env.ROSTER_BULK_CHUNK_BUDGET_MS??150);

type EmployeeStep={employmentId:string;ref:string};
type CellStep={employmentId:string;ref:string;date:string};
type ImportCellsStep={group:number;employmentId:string;ref:string;cells:RosterImportCell[]};
type ImportSummaryStep={group:number};
type ImportClearStep={cell:RosterImportCell;ref:string};
/** A rolled-back check. `group` is the upload group it belongs to (absent for single-brush operations). */
type CheckStep={ids?:string[];employmentId?:string;ref?:string;half?:'working'|'rest';group?:number};
type GeneratePlan={op:'generate';companyId:string;month:string;shiftId:string;templateCompanyId:string|null;workingDates:string[];restDates:string[];
 reviewed?:ReviewedRosterDepartment;departmentId?:string;employments:number;summarized?:boolean};
type CopyPlan={op:'copy';companyId:string;month:string;sourceFrom:string;sourceTo:string;targetFrom:string;offsetDays:number;employmentScope:number|'all-visible';summarized?:boolean};
type AssignPlan={op:'assign';companyId:string|null;brush:string;shiftDates:string[];employments:number;summarized?:boolean};
type ImportPlan={op:'import';companyId:string;month:string;fileName:string;result:RosterImportResult;
 groups:{brush:string;dates:string[]}[];summarized?:boolean};
type RosterPlan=GeneratePlan|CopyPlan|AssignPlan|ImportPlan;
type Steps=BulkJobPrepared['steps'];

/** Thrown to roll back a check's savepoint after its guards passed. */
class CheckRollback extends Error{constructor(){super('roster bulk check rollback');this.name='CheckRollback';}}
async function label(tx:Tx,kind:string,phase:string){await tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);}
/** The roster's own wording for a refusal, as the synchronous actions showed it (app/roster/actions.ts
 * readableError): a domain refusal speaks for itself, and any database failure is the roster's own sentence. */
const rosterMessage=(error:unknown)=>{
 if(isDatabaseError(error)){publicErrorMessage(error);return ROSTER_WRITE_FAILED;} // logged under a reference
 return rosterReadableError(error).slice(0,4000);
};
/** A non-transient database failure inside a step becomes the roster's own sentence (transient ones are retried). */
async function asRosterRefusal<T>(run:()=>Promise<T>):Promise<T>{
 try{return await run();}
 catch(error){if(!isTransientBulkJobError(error)&&isDatabaseError(error))throw new Error(rosterMessage(error));throw error;}
}
/** Runs `check` in a savepoint that is always rolled back: the guards run for real, nothing they write survives. */
async function rolledBack(tx:Tx,check:(tx:Tx)=>Promise<unknown>){
 try{await tx.transaction(async sp=>{await check(sp);throw new CheckRollback();});}
 catch(error){if(error instanceof CheckRollback)return;throw error;}
}
const sortedIds=(ids:readonly string[])=>[...new Set(ids)].sort();
const isCheck=(kind:string)=>kind.startsWith('check_');
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
 * The check steps of one shift brush (assignShiftBulk) and/or one rest brush (setRestDayBulk) over these employments,
 * in the synchronous order: visibility of all, the shift half's duty guard (ascending id), its Schedule Group check
 * (employment order), then the rest half's duty guard (ascending id).
 */
function brushChecks(ids:readonly string[],refs:Map<string,string>,halves:{working:boolean;rest:boolean},group?:number):Steps{
 if(!ids.length||(!halves.working&&!halves.rest))return [];
 const g=group===undefined?{}:{group};const sorted=sortedIds(ids);
 const one=(kind:string,employmentId:string,half?:'working'|'rest')=>({kind,rowNum:null,payload:{employmentId,ref:refs.get(employmentId)??'',...(half?{half}:{}),...g} satisfies CheckStep});
 return [
  {kind:'check_visible',rowNum:null,payload:{ids:sorted,...g} satisfies CheckStep},
  ...(halves.working?sorted.map(id=>one('check_duty',id,'working')):[]),
  ...(halves.working?ids.map(id=>one('check_allowed',id)):[]),
  ...(halves.rest?sorted.map(id=>one('check_duty',id,'rest')):[]),
 ];
}
/** The values one employee's check covers, exactly as the synchronous writer built them. */
async function checkValuesTx(tx:Tx,plan:RosterPlan,step:CheckStep){
 const id=step.employmentId!;
 if(plan.op==='copy'){
  const read=await tx.execute<{shift_date:string;shift_id:string|null;is_rest_day:boolean;note:string|null}>(sql`select shift_date::text,shift_id,is_rest_day,note
   from roster_assignment where employment_id=${id}::uuid and shift_date between ${plan.sourceFrom}::date and ${plan.sourceTo}::date`);
  return [...read].map(r=>({employmentId:id,shiftDate:new Date(Date.parse(`${r.shift_date}T00:00:00Z`)+plan.offsetDays*86_400_000).toISOString().slice(0,10),shiftId:r.shift_id,isRestDay:r.is_rest_day,note:r.note}));
 }
 const brush=plan.op==='generate'?{shiftId:plan.shiftId,working:plan.workingDates,rest:plan.restDates}
  :plan.op==='assign'?{shiftId:plan.brush,working:plan.shiftDates,rest:[] as string[]}
  :(()=>{const g=(plan as ImportPlan).groups[step.group!];return g.brush==='rest'?{shiftId:'',working:[] as string[],rest:g.dates}:{shiftId:g.brush,working:g.dates,rest:[] as string[]};})();
 return step.half==='rest'
  ?brush.rest.map(shiftDate=>({employmentId:id,shiftDate,shiftId:null,isRestDay:true}))
  :brush.working.map(shiftDate=>({employmentId:id,shiftDate,shiftId:brush.shiftId,isRestDay:false}));
}

/** The first refused check, once all checks have run (checks always precede writes): its upload group, if any. */
type CheckOutcome={failed:boolean;group:number|null};
async function checkOutcomeTx(tx:Tx,job:BulkJobRow,cache:Map<string,unknown>):Promise<CheckOutcome>{
 const cached=cache.get('checks') as CheckOutcome|undefined;if(cached)return cached;
 const [row]=await tx.execute<{seq:number|null;grp:number|null}>(sql`select seq,(payload->>'group')::int grp from bulk_job_step
  where job_id=${job.id}::uuid and state='failed' and kind like 'check\\_%' order by seq limit 1`);
 const outcome={failed:row?.seq!==undefined&&row?.seq!==null,group:row?.grp??null};
 cache.set('checks',outcome);return outcome;
}
/** Whether an earlier write step was refused (the sequential loops stop there). */
async function writeStoppedTx(tx:Tx,job:BulkJobRow,cache:Map<string,unknown>){
 if(cache.get('stopped')===true)return true;
 if(cache.get('stopped')===false)return false;
 const [row]=await tx.execute<{failed:boolean}>(sql`select exists(select 1 from bulk_job_step where job_id=${job.id}::uuid and state='failed' and kind not like 'check\\_%') as failed`);
 cache.set('stopped',Boolean(row?.failed));return Boolean(row?.failed);
}
/** Per chunk: the upload's code directory, read once per chunk transaction under the chunk's locks. */
const chunkState=new Map<string,{directory?:RosterImportDirectory}>();
async function stepTotalsTx(tx:Tx,job:BulkJobRow){
 const [row]=await tx.execute<{applied:number;employees:number;workingSteps:number;restSteps:number;failed:number;working:number;rest:number;rows:number;source:number;error:string|null}>(sql`select
   count(*) filter (where state='applied' and not coalesce((result->>'skipped')::boolean,false))::int applied,
   count(distinct payload->>'employmentId') filter (where state='applied' and not coalesce((result->>'skipped')::boolean,false))::int employees,
   count(*) filter (where kind='working' and state='applied' and not coalesce((result->>'skipped')::boolean,false))::int "workingSteps",
   count(*) filter (where kind='rest' and state='applied' and not coalesce((result->>'skipped')::boolean,false))::int "restSteps",
   count(*) filter (where state='failed')::int failed,
   coalesce(sum((result->>'workingRows')::int) filter (where state='applied'),0)::int working,
   coalesce(sum((result->>'restRows')::int) filter (where state='applied'),0)::int rest,
   coalesce(sum((result->>'rows')::int) filter (where state='applied'),0)::int "rows",
   coalesce(sum((result->>'sourceRows')::int) filter (where state='applied'),0)::int source,
   (select error from bulk_job_step f where f.job_id=${job.id}::uuid and f.state='failed' order by f.seq limit 1) error
  from bulk_job_step where job_id=${job.id}::uuid and kind not like 'check\\_%'`);
 const [check]=await tx.execute<{error:string|null}>(sql`select error from bulk_job_step where job_id=${job.id}::uuid and state='failed' and kind like 'check\\_%' order by seq limit 1`);
 return {...row,checkError:check?.error??null};
}
/** The job stops on the first refused row's own sentence (or the upload's first refused group). */
class RosterBulkStopped extends Error{constructor(message:string){super(message);this.name='RosterBulkStopped';}}
const isRefusal=(error:unknown)=>!isTransientBulkJobError(error);
async function fencedTx<T>(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,fn:(tx:Tx)=>Promise<T>){
 return withTenant(ctx,async tx=>{await label(tx,job.kind,'finalize');await unit.fenceTx(tx);return fn(tx);});
}
const markSummarizedTx=(tx:Tx,job:BulkJobRow)=>tx.execute(sql`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||'{"summarized":true}'::jsonb where id=${job.id}::uuid`);
const rosterLocks=async(tx:Tx,ctx:SessionContext)=>{await lockAccessConfigurationTx(tx,ctx.tenantId);await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);};

/** Nominate once (short read transactions); every guard runs later in the chunked check and write steps. */
async function prepareRoster(ctx:SessionContext,job:BulkJobRow):Promise<BulkJobPrepared|BulkJobRefused>{
 const input=job.input as RosterBulkInput;
 const kind=job.kind;
 let plan:RosterPlan|null=null;
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
   // Two write steps per employee, one per half of the generator (assignShiftBulk, then setRestDayBulk): each half
   // is the employee's own duty-guard event in the synchronous run too, so the audit is the same and a step is half
   // as long.
   const halves=[...(workingDates.length?['working']:[]),...(restDates.length?['rest']:[])];
   return{plan,counters:{employees:nominated.ids.length},steps:[
    ...brushChecks(nominated.ids,nominated.refs,{working:workingDates.length>0,rest:restDates.length>0}),
    ...nominated.ids.flatMap((employmentId,i)=>halves.map(half=>({kind:half,rowNum:i+1,payload:{employmentId,ref:nominated.refs.get(employmentId)??''} satisfies EmployeeStep}))),
   ]};
  }
  if(input.op==='copy'){
   const c=input.copy;const {offsetDays}=validateRosterCopyRange(c);
   plan={op:'copy',companyId:input.companyId,month:c.targetFrom.slice(0,7),sourceFrom:c.sourceFrom,sourceTo:c.sourceTo,targetFrom:c.targetFrom,offsetDays,
    employmentScope:c.employmentIds.length>0?c.employmentIds.length:'all-visible'};
   const nominated=await withTenant(ctx,async tx=>{
    await label(tx,kind,'prepare');await rosterLocks(tx,ctx);
    const ids=await rosterCopyNomineesTx(tx,c);
    return{ids,refs:await refsTx(tx,ids)};
   });
   return{plan,counters:{employees:nominated.ids.length},steps:[
    ...brushChecks(nominated.ids,nominated.refs,{working:true,rest:false}),
    ...nominated.ids.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:nominated.refs.get(employmentId)??''} satisfies EmployeeStep})),
   ]};
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
   return{plan,counters:{employees:a.employmentIds.length},steps:[
    ...brushChecks(a.employmentIds,refs,{working:true,rest:false}),
    ...a.employmentIds.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:{employmentId,ref:refs.get(employmentId)??''} satisfies EmployeeStep})),
   ]};
  }
  // Upload Shift Roster: the same planner as the preview, from the job's stored file.
  const u=input.import;
  const csvText=(job.source_content??Buffer.alloc(0)).toString('utf8');
  const nomination=await rosterImportPlan(ctx,{csvText,month:u.month,companyId:input.companyId,fileName:u.fileName,dryRun:false});
  const {groups,clears}=rosterImportWriteGroups(nomination.changes);
  const importPlan:ImportPlan={op:'import',companyId:input.companyId,month:u.month,fileName:u.fileName,result:nomination.result,groups:groups.map(g=>({brush:g.brush,dates:g.dates}))};
  plan=importPlan;
  assertRosterDatesWritable(ctx,[...new Set(nomination.changes.map(cell=>cell.date))]);
  const refs=new Map(nomination.changes.map(cell=>[cell.employmentId,cell.employeeCode]));
  // Each group was one transaction that committed before the next began: all groups' checks run first, and the first
  // refused group ends the upload with the earlier groups written and no history entry.
  const steps:Steps=groups.flatMap((g,i)=>brushChecks(g.employmentIds,refs,{working:g.brush!=='rest',rest:g.brush==='rest'},i));
  groups.forEach((g,i)=>{
   for(const employmentId of g.employmentIds){
    const cells=g.cells.filter(cell=>cell.employmentId===employmentId);
    steps.push({kind:'cells',rowNum:cells[0]?.sourceRow??null,payload:{group:i,employmentId,ref:cells[0]?.employeeCode??'',cells} satisfies ImportCellsStep});
   }
   steps.push({kind:'summary',rowNum:null,payload:{group:i} satisfies ImportSummaryStep});
  });
  for(const cell of clears)steps.push({kind:'clear',rowNum:cell.sourceRow,payload:{cell,ref:cell.employeeCode} satisfies ImportClearStep});
  return{plan:importPlan,counters:{cells:nomination.changes.length},steps};
 }catch(error){
  if(!isRefusal(error))throw error;
  return{refused:rosterMessage(error),plan:plan??basePlan(input)};
 }
}
function basePlan(input:RosterBulkInput):Partial<RosterPlan>{
 if(input.op==='generate')return{op:'generate',companyId:input.companyId,month:String(input.generate?.from??'').slice(0,7)};
 if(input.op==='copy')return{op:'copy',companyId:input.companyId,month:String(input.copy?.targetFrom??'').slice(0,7)};
 return{op:input.op,companyId:input.companyId} as Partial<RosterPlan>;
}

async function applyCheckStep(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:BulkJobStep,cache:Map<string,unknown>):Promise<BulkJobStepOutcome>{
 // After the first refused check the outcome is decided; the remaining checks are not needed.
 if(cache.get('checkFailed')===true)return{result:{skipped:true}};
 const plan=job.plan as RosterPlan;const p=step.payload as CheckStep;
 try{
  await asRosterRefusal(()=>rolledBack(tx,async sp=>{
   if(step.kind==='check_visible')return assertVisibleTx(sp,p.ids??[]);
   const values=await checkValuesTx(sp,plan,p);
   if(step.kind==='check_duty'){if(values.length)await assertDutyRosterWriteTx(sp,ctx,values);return;}
   await assertShiftsAllowedForEmploymentsTx(sp,values.map(v=>({employmentId:v.employmentId,shiftId:v.shiftId,shiftDate:v.shiftDate})));
  }));
 }catch(error){if(!isTransientBulkJobError(error))cache.set('checkFailed',true);throw error;}
 return{result:{checked:true}};
}

async function applyRosterStep(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:BulkJobStep,cache:Map<string,unknown>):Promise<BulkJobStepOutcome>{
 assertRosterAdmin(ctx);
 if(isCheck(step.kind))return applyCheckStep(tx,ctx,job,step,cache);
 const plan=job.plan as RosterPlan;
 const checks=await checkOutcomeTx(tx,job,cache);
 const sequential=plan.op==='import'||step.kind==='cell';
 // All-or-nothing: a refused check means no row of the grid (or of that upload group onwards) is written.
 if(checks.failed&&(plan.op!=='import'||checks.group===null||step.kind==='clear'||(step.payload as {group?:number}).group!>=checks.group))return{result:{skipped:true},counters:{skipped:1}};
 if(sequential&&await writeStoppedTx(tx,job,cache))return{result:{skipped:true},counters:{skipped:1}};
 try{return await asRosterRefusal(()=>applyWrite(tx,ctx,job,plan,step));}
 catch(error){if(sequential&&!isTransientBulkJobError(error))cache.set('stopped',true);throw error;}
}
async function applyWrite(tx:Tx,ctx:SessionContext,job:BulkJobRow,plan:RosterPlan,step:BulkJobStep):Promise<BulkJobStepOutcome>{
 if(plan.op==='generate'){
  const {employmentId}=step.payload as EmployeeStep;
  if(plan.reviewed){
   // Narrowed to this employee: the reviewed department, company scope and team as the writer checked them.
   await assertReviewedDepartmentMembersTx(tx,ctx,plan.reviewed,plan.templateCompanyId,[employmentId]);
  }else if(plan.departmentId){
   if(!(await rosterDepartmentMembersTx(tx,{departmentId:plan.departmentId,templateCompanyId:plan.templateCompanyId},[employmentId])).length)
    throw new RosterCommandRefusal('selection','The department selection changed. Prepare it again.');
  }
  if(step.kind==='rest'){
   // The employee's working half was refused (a change made meanwhile): its rest half is not written either.
   // Steps come in pairs, so the employee's working half is the step just before (a primary-key read).
   const [working]=plan.workingDates.length?await tx.execute<{state:string}>(sql`select state from bulk_job_step where job_id=${job.id}::uuid and seq=${step.seq-1} and kind='working' and payload->>'employmentId'=${employmentId}`):[];
   if(working?.state==='failed')return{result:{skipped:true},counters:{skipped:1}};
   const restRows=await writeRosterRestRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.restDates});
   return{result:{restRows},counters:{saved:1}};
  }
  const workingRows=await writeRosterShiftRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.workingDates,shiftId:plan.shiftId});
  return{result:{workingRows},counters:{saved:1}};
 }
 if(plan.op==='copy'){
  const {employmentId}=step.payload as EmployeeStep;
  await lockLeaveDependenciesTx(tx,ctx.tenantId,[employmentId]);
  const copied=await copyRosterRowsTx(tx,ctx,{employmentIds:[employmentId],sourceFrom:plan.sourceFrom,sourceTo:plan.sourceTo,offsetDays:plan.offsetDays});
  return{result:copied,counters:{saved:1}};
 }
 if(plan.op==='assign'){
  if(step.kind==='cell'){
   const {employmentId,date}=step.payload as CellStep;
   if(plan.brush==='rest')await setRestDay(ctx,{employmentId,shiftDate:date},tx);
   else await clearRoster(ctx,{employmentId,shiftDate:date},tx);
   return{result:{rows:1},counters:{saved:1}};
  }
  const {employmentId}=step.payload as EmployeeStep;
  const rows=await writeRosterShiftRowsTx(tx,ctx,{employmentIds:[employmentId],shiftDates:plan.shiftDates,shiftId:plan.brush});
  return{result:{rows},counters:{saved:1}};
 }
 const state=chunkState.get(job.id)??{};chunkState.set(job.id,state);
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
    if(plan.workingDates.length&&t.workingSteps>0)await appendRosterBulkAssignedTx(tx,ctx,{shiftId:plan.shiftId,employmentCount:t.workingSteps,dateCount:plan.workingDates.length,rows:t.working});
    if(plan.restDates.length&&t.restSteps>0)await appendRosterBulkRestDayTx(tx,ctx,{anchorId:plan.shiftId,shiftId:plan.shiftId,employmentCount:t.restSteps,dateCount:plan.restDates.length,rows:t.rest});
   }else if(plan.op==='copy'&&t.source>0){
    await appendRosterCopiedTx(tx,ctx,{sourceFrom:plan.sourceFrom,sourceTo:plan.sourceTo,targetFrom:plan.targetFrom,offsetDays:plan.offsetDays,rows:t.rows,employmentScope:plan.employmentScope});
   }else if(plan.op==='assign'&&plan.brush!=='rest'&&plan.brush!=='clear'&&t.applied>0){
    await appendRosterBulkAssignedTx(tx,ctx,{shiftId:plan.brush,employmentCount:t.applied,dateCount:plan.shiftDates.length,rows:t.rows});
   }else if(plan.op==='import'&&!t.checkError&&t.failed===0){
    const r=plan.result;
    await recordRosterUploadTx(tx,ctx,{companyId:plan.companyId,month:plan.month,fileName:plan.fileName,employees:r.employees,rowsRead:r.rowsRead,changed:r.changed,rejected:r.rejects.length});
   }
   await markSummarizedTx(tx,job);
  }
  return t;
 });
 if(totals.checkError!==null)throw new RosterBulkStopped(totals.checkError);
 if(totals.failed>0)throw new RosterBulkStopped(totals.error??'');
 if(plan.op==='generate')return{result:{op:'generate',employments:totals.employees,workingDates:plan.workingDates.length,restDates:plan.restDates.length,workingRows:totals.working,restRows:totals.rest}};
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
 phaseOf:kind=>isCheck(kind)?'checking':'writing',
 prepare:prepareRoster,
 async beginChunkTx(tx,ctx,job){
  chunkState.set(job.id,{});
  assertRosterAdmin(ctx);
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const plan=job.plan as RosterPlan|null;
  if(plan?.op==='generate'&&plan.reviewed&&!await isAiPrincipalCurrentTx(tx,ctx))throw new RosterCommandRefusal('permission','Current calling authority could not be confirmed.');
  await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
 },
 applyStepTx:(tx,ctx,job,step,cache)=>applyRosterStep(tx,ctx,job,step,cache),
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
 phaseOf:kind=>isCheck(kind)?'checking':'writing',
 /** All or nothing, as setEmploymentScheduleGroupBulk: first a check step per employment, in ascending id order, that
  * runs the same per-employment writer and reverse check and is rolled back; the first refusal names the employee
  * and nobody is moved. Then the writes, one employment each. */
 async prepare(ctx,job){
  const input=job.input as ScheduleGroupBulkInput;
  const plan:SchedulePlan={returnQuery:input.returnQuery,attendanceRuleId:input.attendanceRuleId,requested:0};
  try{
   assertScheduleAdmin(ctx);
   const ids=sortedIds(input.employmentIds.map(v=>v.trim()).filter(Boolean));
   if(ids.length===0)throw new NoEmploymentsSelectedError();
   plan.requested=ids.length;
   const refs=await withTenant(ctx,tx=>refsTx(tx,ids));
   const payload=(employmentId:string)=>({employmentId,ref:refs.get(employmentId)??''});
   return{plan,counters:{requested:ids.length},steps:[
    ...ids.map(employmentId=>({kind:'check_group',rowNum:null,payload:payload(employmentId)})),
    ...ids.map((employmentId,i)=>({kind:'employee',rowNum:i+1,payload:payload(employmentId)})),
   ]};
  }catch(error){
   if(!isRefusal(error))throw error;
   return{refused:scheduleGroupMessage(error),plan};
  }
 },
 async beginChunkTx(tx,ctx){assertScheduleAdmin(ctx);await tx.execute(sql`select app.access_workforce_write_lock()`);},
 async applyStepTx(tx,ctx,job,step,cache){
  const plan=job.plan as SchedulePlan;const {employmentId}=step.payload;
  if(step.kind==='check_group'){
   if(cache.get('checkFailed')===true)return{result:{skipped:true}};
   try{
    await rolledBack(tx,async sp=>{
     try{await setEmploymentScheduleGroupTx(sp,ctx,{employmentId,attendanceRuleId:plan.attendanceRuleId});}
     catch(e){
      if(e instanceof ShiftNotInScheduleGroupError){const who=await whoTx(sp,employmentId);throw new ScheduleGroupBulkRefusedError(who?.name??employmentId,who?.code??null,e);}
      throw e;
     }
    });
   }catch(e){
    if(isTransientBulkJobError(e))throw e;
    cache.set('checkFailed',true);throw new Error(scheduleGroupMessage(e));
   }
   return{result:{checked:true}};
  }
  if(await checkOutcomeTx(tx,job,cache).then(c=>c.failed))return{result:{skipped:true},counters:{skipped:1}};
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
     count(*) filter (where kind='employee' and state='applied' and (result->>'changed')::boolean)::int changed,
     count(*) filter (where kind='employee' and state='applied' and not coalesce((result->>'skipped')::boolean,false) and not (result->>'changed')::boolean)::int unchanged,
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
