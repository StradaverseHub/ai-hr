/**
 * Import Clocking Data as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; migrations 9003, 9940).
 * ADR-0096 is unchanged in what an import decides and writes; this moves WHERE it runs.
 *
 * The synchronous import held the tenant-wide Access and leave-dependency configuration locks, and every named
 * employee's clock key, for the whole file (57 s for 2,400 lines), so every clock-in waited behind it. Here:
 *  · the web request validates the file and the mapping and admits a job (one per tenant at a time, as before);
 *  · prepare reads the file and matches every line to an employment once, with no lock held (stages 1 and 2 of
 *    core/attendance-clocking-import.ts decideLines);
 *  · one step per matched employee: under that employee's own clock and leave-dependency locks, the step
 *    re-checks the employment, decides the employee's lines against their days as they stand now (stage 3:
 *    duplicates, corrected days, closed pay runs, in/out reading) and adds them (addImportedPunchesBatchTx).
 *    Chunks of about 100 ms hold the tenant locks, so a clock-in waits at most one chunk;
 *  · finalize writes the run log exactly as the synchronous import did (one clocking_import_run, one line row
 *    per data line, the needs-recalculation marks and the one summary event), in bounded transactions.
 * Every decision is per (employee, business day), so the end state equals the synchronous import's for the same
 * file (test/clocking-import-job-equivalence.test.ts). One bad line never stops the others, as before; a step
 * that is refused (its employment changed during the import) leaves that employee's lines as not imported.
 * A job that stops before anything was added leaves a Failed run, as a synchronous import that threw did; one
 * that stops after some employees were added logs those (Failed, with what was added) so nothing is hidden.
 */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {clockingImportRun,type ClockingImportLineResult} from '../db/schema';
import {isAdmin} from '../lib/authz-model';
import type {ReadLine} from '../lib/clocking-file';
import {ATTENDANCE_JOB_ALREADY_RUNNING,CLOCKING_IMPORT_KIND,type AttendanceJobProgress} from '../lib/attendance-bulk-job';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx,lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {assertModuleGate,withAttendanceTenant} from './module-gate';
import type {BulkJobHandler,BulkJobUnit} from './bulk-job-worker';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobProgress,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {
 ClockingImportError,CLOCKING_OTHER_COMPANY,addClockingImportPunchesTx,appendClockingImportRunEventTx,assertClockingFile,
 clockingActorPersonId,clockingImportChangedDays,clockingImportCounts,clockingImportDayGroups,decideClockingDaysTx,deriveStatus,
 insertClockingImportLinesTx,markClockingImportRecalcTx,matchClockingLines,readClockingEmploymentsTx,readClockingLines,
 recordFailedClockingRun,resolveClockingMapping,
 type ClockingDecidedLine,type ClockingEmploymentRow,type ClockingImportOutcome,
} from './attendance-clocking-import';

export {CLOCKING_IMPORT_KIND};
/** Step work per chunk before it commits (the tenant Access and leave-dependency locks are held meanwhile). */
export const CLOCKING_IMPORT_CHUNK_BUDGET_MS=Number(process.env.CLOCKING_IMPORT_CHUNK_BUDGET_MS??100);
/** Log lines written per finalize transaction (no tenant-wide lock is taken for them). */
const LINE_BATCH=2000;
/** Employees packed into one step, bounded by their lines: each call to the day writer has a fixed cost (schedule,
 * policy and payroll reads), so a one-day file packs two employees, while an employee with more days is alone. The
 * 3,000-employee rehearsal on a heavily loaded host held the tenant locks up to 2.7 s with eight one-day employees per
 * step; one or two keep a step near one clock-in transaction there (and well under 100 ms on a quiet host). */
export const CLOCKING_IMPORT_STEP_LINES=Number(process.env.CLOCKING_IMPORT_STEP_LINES??4);
const STEP_EMPLOYEES=2;
/** Detail of a line whose employee was not imported because the job stopped or that employee's step was refused. */
export const CLOCKING_NOT_IMPORTED='not_imported';

export type ClockingImportJobInput={mappingId:string;fileName:string;fileBytes:number;companyId?:string};
type Decision={result:ClockingImportLineResult;day:string|null;direction:'in'|'out'|null;detail:string};
/** A line kept between units: what was read, and its decision. `emp` keeps what the log and the payroll marks read. */
type StoredLine=Decision&{read:ReadLine;emp:{id:string;companyId:string}|null};
/** One step: employees in employment-id order, each with its lines in file order. The employment is kept as its id,
 * company, code and a digest of what its match depends on (never the IC or name itself). */
type StepEmployment={id:string;companyId:string;code:string|null;image:string};
type StepPayload={employees:{employment:StepEmployment;lines:ReadLine[]}[]};
/** Per employee of the step, its lines' decisions in payload order; `refused` when its employment changed. */
type StepResult={employees:{lines:(Decision&{punchId:string|null})[];refused?:string}[]};
export type ClockingImportJobPlan={
 runId:string;mapping:{id:string|null;name:string;snapshot:Record<string,unknown>};fileSha:string;fileName:string;fileBytes:number;
 companyId?:string;total:number;
 /** Lines decided in prepare that no employee step decides again (unread, unmatched, ambiguous, other company). */
 other:StoredLine[];
 runRecorded?:boolean;linesWritten?:number;
};
/** A refusal before anything was read: as the synchronous import's ClockingImportError, no run is logged. */
type RefusalPlan={refusal:string};
const planOf=(job:BulkJobRow)=>job.plan as ClockingImportJobPlan;
const inputOf=(job:BulkJobRow)=>job.input as ClockingImportJobInput;
const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const stored=(d:ClockingDecidedLine):StoredLine=>({read:d.read,result:d.result,emp:d.emp?{id:d.emp.id,companyId:d.emp.companyId}:null,day:d.day,direction:d.direction,detail:d.detail});
/** The fields a line's match and its "employed on the date" depend on; a change refuses that employee's step. */
const decisionImage=(e:ClockingEmploymentRow)=>createHash('sha256').update(JSON.stringify([e.id,e.companyId,e.code,e.cardId,e.ic,e.start,e.end])).digest('hex');
const stepEmployment=(e:ClockingEmploymentRow):StepEmployment=>({id:e.id,companyId:e.companyId,code:e.code,image:decisionImage(e)});
const refusal=(code:string,message:string):{refused:string;plan:RefusalPlan}=>({refused:message,plan:{refusal:code}});
const refusalText:Record<ClockingImportError['code'],string>={mappingNotFound:'That mapping no longer exists.',mappingInactive:'That mapping is inactive. Choose an active mapping.',
 emptyFile:'The file is empty.',fileTooLarge:'The file is larger than about 900 KB (roughly 25,000 lines). Split it into two files and import each.'};

/** Why an employee's lines were left out: the employment changed between reading the file and adding the lines. */
export const CLOCKING_EMPLOYMENT_CHANGED='This employee\'s card, code or employment dates changed during the import. Import the file again to add these clockings.';

/** Every line of the file in file order, with its decision: prepare's lines plus each employee step's outcome.
 * Lines of a step that did not apply (refused, or the job stopped first) are not imported. */
async function collectLines(tx:Tx,job:BulkJobRow,plan:ClockingImportJobPlan){
 const steps=await tx.execute<{payload:StepPayload;result:StepResult|null;state:string}>(sql`select payload,result,state from bulk_job_step where job_id=${job.id}::uuid order by seq`);
 const lines:(StoredLine&{punchId:string|null})[]=plan.other.map(l=>({...l,punchId:null}));
 for(const step of steps)step.payload.employees.forEach((employee,e)=>{
  const emp={id:employee.employment.id,companyId:employee.employment.companyId};
  const decided=step.state==='applied'?step.result?.employees[e]:undefined;
  employee.lines.forEach((read,i)=>{
   const r=decided&&!decided.refused?decided.lines[i]:undefined;
   lines.push(r?{read,emp,result:r.result,day:r.day,direction:r.direction,detail:r.detail,punchId:r.punchId}
    :{read,emp,result:'other',day:null,direction:read.direction,detail:CLOCKING_NOT_IMPORTED,punchId:null});
  });
 });
 lines.sort((a,b)=>a.read.lineNo-b.read.lineNo);
 const punchIdOf=new Map<ClockingDecidedLine,string>();
 const decided:ClockingDecidedLine[]=lines.map(l=>{
  const d:ClockingDecidedLine={read:l.read,result:l.result,emp:l.emp as ClockingEmploymentRow|null,day:l.day,direction:l.direction,detail:l.detail};
  if(l.punchId)punchIdOf.set(d,l.punchId);
  return d;
 });
 return{decided,punchIdOf};
}
type Collected=Awaited<ReturnType<typeof collectLines>>;
/** Finalize runs as several units; the collected lines are kept between them (rebuilt after a worker restart). */
const collected=new Map<string,Collected>();
async function linesOf(tx:Tx,job:BulkJobRow,plan:ClockingImportJobPlan){
 let c=collected.get(job.id);
 if(!c){c=await collectLines(tx,job,plan);collected.set(job.id,c);}
 return c;
}
async function finalizeTx<T>(ctx:SessionContext,unit:Pick<BulkJobUnit,'fenceTx'|'metric'>,phase:string,fn:(tx:Tx)=>Promise<T>):Promise<T>{
 const started=performance.now();
 const out=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('application_name',${`aihr-bulk:${CLOCKING_IMPORT_KIND}:${phase}`},true)`);await unit.fenceTx(tx);return fn(tx);});
 unit.metric(`${phase}TxMs`,performance.now()-started);
 return out;
}
/** The run row exactly as the synchronous import leaves it, then its payroll marks and summary event. */
async function recordRunTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,plan:ClockingImportJobPlan,c:Collected,failureReason:string|null){
 const counts=clockingImportCounts(c.decided);
 const changed=clockingImportChangedDays(clockingImportDayGroups(c.decided));
 const employeesUpdated=new Set(changed.map(x=>x.employmentId)).size;
 await tx.insert(clockingImportRun).values({
  id:plan.runId,tenantId:ctx.tenantId,mappingId:plan.mapping.id,mappingName:plan.mapping.name,mappingSnapshot:plan.mapping.snapshot,
  fileName:plan.fileName,fileBytes:plan.fileBytes,fileSha256:plan.fileSha,createdByPersonId:await clockingActorPersonId(tx,ctx),
  createdByUserId:ctx.userId??null,createdAt:new Date(job.created_at),totalLines:counts.total,validLines:counts.valid,importedLines:c.punchIdOf.size,
  duplicateLines:counts.duplicate,unmatchedCardLines:counts.unmatchedCard,invalidDatetimeLines:counts.invalidDateTime,otherErrorLines:counts.otherError,
  daysUpdated:changed.length,employeesUpdated,failureReason,
 });
 const recalcBatchIds=await markClockingImportRecalcTx(tx,ctx,changed);
 await appendClockingImportRunEventTx(tx,ctx,{runId:plan.runId,mapping:plan.mapping,fileName:plan.fileName,counts,importedLines:c.punchIdOf.size,
  daysUpdated:changed.length,employeesUpdated,recalcBatchIds});
 return{counts,changed};
}
function outcomeOf(plan:ClockingImportJobPlan,c:Collected):ClockingImportOutcome{
 const counts=clockingImportCounts(c.decided),imported=c.punchIdOf.size;
 return{runId:plan.runId,status:deriveStatus({failureReason:null,imported,failed:counts.total-imported}),counts,imported,
  daysUpdated:clockingImportChangedDays(clockingImportDayGroups(c.decided)).length,failureReason:null,
  ...(plan.companyId===undefined?{}:{otherCompany:c.decided.filter(d=>d.result==='other'&&d.detail===CLOCKING_OTHER_COMPANY).length})};
}

export const clockingImportJobHandler:BulkJobHandler<StepPayload>={
 kind:CLOCKING_IMPORT_KIND,
 mode:'per-step',
 chunkBudgetMs:CLOCKING_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:8,
 phaseOf:()=>'employees',
 stepRef:step=>step.payload.employees.map(e=>e.employment.code??'').filter(Boolean).join(', '),
 /** Stages 1 and 2 once, read-only and with no lock held: read every line, match it to an employment. */
 async prepare(ctx,job){
  const input=inputOf(job);
  const text=Buffer.from(job.source_content??Buffer.alloc(0)).toString('utf8');
  try{assertClockingFile(text);}catch(error){if(error instanceof ClockingImportError)return refusal(error.code,refusalText[error.code]);throw error;}
  if(!isAdmin(ctx))return refusal('notAdmin','Only an administrator can import clocking data.');
  return withAttendanceTenant(ctx,async tx=>{
   let mapping:Awaited<ReturnType<typeof resolveClockingMapping>>;
   try{mapping=await resolveClockingMapping(tx,input.mappingId);}
   catch(error){if(error instanceof ClockingImportError)return refusal(error.code,refusalText[error.code]);throw error;}
   const decided=readClockingLines(mapping.def,text);
   const matched=decided.some(d=>d.result==='imported')||decided.some(d=>d.read.cardRef)
    ?matchClockingLines(decided,await readClockingEmploymentsTx(tx),input.companyId):[];
   const byEmployment=new Map<string,ClockingDecidedLine[]>();
   for(const d of matched){const lines=byEmployment.get(d.emp!.id)??[];lines.push(d);byEmployment.set(d.emp!.id,lines);}
   const inStep=new Set(matched);
   // Employment id order, as the synchronous import took the employees' clock keys (no deadlock between imports).
   const steps:{kind:string;rowNum:number;payload:StepPayload}[]=[];
   let lineCount=0;
   for(const [,lines] of [...byEmployment.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    const last=steps[steps.length-1];
    const employee={employment:stepEmployment(lines[0].emp!),lines:lines.map(d=>d.read)};
    if(last&&lineCount+lines.length<=CLOCKING_IMPORT_STEP_LINES&&last.payload.employees.length<STEP_EMPLOYEES){last.payload.employees.push(employee);lineCount+=lines.length;continue;}
    steps.push({kind:'employees',rowNum:lines[0].read.lineNo,payload:{employees:[employee]}});lineCount=lines.length;
   }
   const plan:ClockingImportJobPlan={runId:randomUUID(),mapping:{id:mapping.id,name:mapping.name,snapshot:mapping.snapshot},fileSha:sha256(text),
    fileName:(input.fileName??'').slice(0,255),fileBytes:Math.max(0,Math.floor(Number(input.fileBytes)||0)),
    ...(input.companyId===undefined?{}:{companyId:input.companyId}),total:decided.length,other:decided.filter(d=>!inStep.has(d)).map(stored)};
   return{steps,plan,counters:{lines:decided.length,matched:matched.length,employees:byEmployment.size}};
  });
 },
 /** The synchronous import's own writer locks, held for one chunk only. */
 async beginChunkTx(tx,ctx){
  assertModuleGate(ctx,'attendance');
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 },
 /** Stage 3 and the write for the step's employees, under their own clock and leave-dependency locks. Every decision
  * is per (employee, business day), so packing employees together changes nothing an employee gets. */
 async applyStepTx(tx,ctx,job,step){
  const employees=step.payload.employees;
  const ids=employees.map(e=>e.employment.id);
  await lockLeaveDependenciesTx(tx,ctx.tenantId,ids);
  const fresh=new Map((await readClockingEmploymentsTx(tx,ids)).map(e=>[e.id,e]));
  const refused=new Set(employees.filter(e=>{const now=fresh.get(e.employment.id);return!now||decisionImage(now)!==e.employment.image;}).map(e=>e.employment.id));
  for(const id of [...ids].filter(id=>!refused.has(id)).sort())await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+id}, 0))`);
  const decidedBy=employees.map(e=>refused.has(e.employment.id)?null
   :e.lines.map(read=>({read,result:'imported',emp:fresh.get(e.employment.id)!,day:null,direction:read.direction,detail:''}) as ClockingDecidedLine));
  const decided=decidedBy.flatMap(lines=>lines??[]);
  await decideClockingDaysTx(tx,decided);
  const groups=clockingImportDayGroups(decided);
  const punchIdOf=groups.length?await addClockingImportPunchesTx(tx,ctx,planOf(job).runId,groups):new Map<ClockingDecidedLine,string>();
  const result:StepResult={employees:decidedBy.map(lines=>lines===null?{lines:[],refused:CLOCKING_EMPLOYMENT_CHANGED}
   :{lines:lines.map(d=>({result:d.result,day:d.day,direction:d.direction,detail:d.detail,punchId:punchIdOf.get(d)??null}))})};
  return{result,counters:{processed:employees.reduce((n,e)=>n+e.lines.length,0),imported:punchIdOf.size,...(refused.size?{refused:refused.size}:{})}};
 },
 /** The run log, in bounded units: the run row with its payroll marks and summary event, then the line rows. */
 async finalize(ctx,job,unit){
  const plan=planOf(job);
  if(!isAdmin(ctx))throw new BulkJobError('Only an administrator can import clocking data.',403);
  if(!plan.runRecorded){
   await finalizeTx(ctx,unit,'finalize',async tx=>{
    await recordRunTx(tx,ctx,job,plan,await linesOf(tx,job,plan),null);
    // Employees left out because their employment changed are listed on the job beside any refused step.
    const left=await tx.execute<{rowNum:number;ref:string;message:string}>(sql`select (e->'lines'->0->>'lineNo')::int as "rowNum",coalesce(e->'employment'->>'code','') as ref,r->>'refused' as message
     from bulk_job_step s cross join lateral jsonb_array_elements(s.payload->'employees') with ordinality as p(e,i)
     join lateral jsonb_array_elements(s.result->'employees') with ordinality as x(r,j) on j=i
     where s.job_id=${job.id}::uuid and s.state='applied' and r ? 'refused' order by 1`);
    if(left.length)await tx.execute(sql`update bulk_job set errors=errors||${JSON.stringify([...left].slice(0,2000))}::jsonb where id=${job.id}::uuid`);
    await tx.execute(sql`update bulk_job set plan=plan||${JSON.stringify({runRecorded:true,linesWritten:0})}::jsonb,updated_at=now() where id=${job.id}::uuid`);
   });
   return'more';
  }
  const done=plan.linesWritten??0;
  const c=await finalizeTx(ctx,unit,'lines',async tx=>{
   const c=await linesOf(tx,job,plan);
   const part=c.decided.slice(done,done+LINE_BATCH);
   if(part.length){
    await insertClockingImportLinesTx(tx,ctx.tenantId,plan.runId,part,c.punchIdOf);
    await tx.execute(sql`update bulk_job set plan=plan||${JSON.stringify({linesWritten:done+part.length})}::jsonb,updated_at=now() where id=${job.id}::uuid`);
   }
   return{...c,wrote:part.length};
  });
  if(c.wrote>0)return'more';
  collected.delete(job.id);
  return{result:outcomeOf(plan,c)};
 },
 /** A stopped job: the run log, under the creator's authority, as the synchronous import's failure path. */
 async afterTerminal(ctx,job){
  collected.delete(job.id);
  if(job.state==='completed'||!ctx)return;
  const plan=job.plan as ClockingImportJobPlan|RefusalPlan|null;
  if(plan&&'refusal' in plan)return;
  const reason=(job.error??'The import stopped.').slice(0,500);
  if(!plan){
   const input=inputOf(job);
   await recordFailedClockingRun(ctx,{mapping:null,mappingIdAsked:input?.mappingId??'',fileName:job.source_name,fileBytes:input?.fileBytes??job.source_bytes,
    fileSha:job.source_hash&&job.source_content?sha256(Buffer.from(job.source_content).toString('utf8')):'',total:0,reason});
   return;
  }
  const c=await withTenant(ctx,tx=>collectLines(tx,job,plan));
  if(!plan.runRecorded){
   if(c.punchIdOf.size===0){
    // Nothing was added: exactly the synchronous import's Failed row (no lines, no event).
    await withTenant(ctx,async tx=>{await tx.insert(clockingImportRun).values({id:plan.runId,tenantId:ctx.tenantId,mappingId:plan.mapping.id,mappingName:plan.mapping.name,
     mappingSnapshot:plan.mapping.snapshot,fileName:plan.fileName,fileBytes:plan.fileBytes,fileSha256:plan.fileSha,
     createdByPersonId:await clockingActorPersonId(tx,ctx),createdByUserId:ctx.userId??null,createdAt:new Date(job.created_at),totalLines:plan.total,failureReason:reason});});
    return;
   }
   // Some employees were added: log them (the reason makes the run read as stopped) with their marks and event.
   await withTenant(ctx,tx=>recordRunTx(tx,ctx,job,plan,c,reason));
  }
  for(let at=plan.linesWritten??0;at<c.decided.length;at+=LINE_BATCH)
   await withTenant(ctx,tx=>insertClockingImportLinesTx(tx,ctx.tenantId,plan.runId,c.decided.slice(at,at+LINE_BATCH),c.punchIdOf));
 },
};

// ─── Web side: admission and the creator's progress ───────────────────────────────────────────────────

/** A refusal the screen translates (clockingFile.import.error.<code>). */
export class ClockingImportJobRefused extends Error{constructor(readonly code:string,readonly status=400){super(code);this.name='ClockingImportJobRefused';}}
export type ClockingImportJobProgress=AttendanceJobProgress<ClockingImportOutcome>;
export function clockingImportJobProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):ClockingImportJobProgress{
 const {result,...rest}=bulkJobProgress(row);
 const refused=(row.plan as Partial<RefusalPlan>|null)?.refusal??null;
 return{...rest,result:row.state==='completed'?result as ClockingImportOutcome:null,errorCode:refused,worker:row.state==='queued'?worker:'running'};
}
async function progressTx(tx:Tx,row:BulkJobRow){return clockingImportJobProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,CLOCKING_IMPORT_KIND):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new ClockingImportJobRefused(error.message===BULK_JOB_ALREADY_RUNNING?ATTENDANCE_JOB_ALREADY_RUNNING:'unavailable',error.status);
 return error;
};
/** Start an import. The request only checks the file and the mapping and admits the job; the import worker
 * decides and writes every line. A second import while one runs for the tenant is refused (alreadyRunning). */
export async function startClockingImportJob(ctx:SessionContext,p:{mappingId:string;text:string;fileName:string;fileBytes:number;companyId?:string;operationKey?:string}):Promise<{job:ClockingImportJobProgress;existing:boolean}>{
 assertClockingFile(p.text);
 if(!isAdmin(ctx))throw new ClockingImportJobRefused('notAdmin',403);
 try{
  return await withAttendanceTenant(ctx,async tx=>{
   await resolveClockingMapping(tx,p.mappingId);
   const fileName=(p.fileName??'').slice(0,255);
   const input:ClockingImportJobInput={mappingId:p.mappingId,fileName,fileBytes:Math.max(0,Math.floor(Number(p.fileBytes)||0)),...(p.companyId===undefined?{}:{companyId:p.companyId})};
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:CLOCKING_IMPORT_KIND,operationKey:p.operationKey,source:{name:fileName||'clockings.txt',content:Buffer.from(p.text,'utf8')},input});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){throw kernelError(error);}
}
export async function getClockingImportJob(ctx:SessionContext,id:string){
 try{return await withAttendanceTenant(ctx,async tx=>progressTx(tx,await bulkJobTx(tx,id,{kind:CLOCKING_IMPORT_KIND})));}catch(error){throw kernelError(error);}
}
/** The signed-in user's most recent clocking imports, newest first (the screen rejoins a running one). */
export async function listClockingImportJobs(ctx:SessionContext){return withAttendanceTenant(ctx,async tx=>{
 const rows=await listBulkJobsTx(tx,ctx,CLOCKING_IMPORT_KIND,10);
 const worker=rows.some(r=>r.state==='queued')?await bulkJobWorkerStatusTx(tx,CLOCKING_IMPORT_KIND):'running';
 return rows.map(row=>clockingImportJobProgress(row,worker));
});}
