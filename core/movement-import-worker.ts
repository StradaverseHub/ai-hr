/** Movement import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; kind row in draft 9910). The
 * job's own writes (its plan marker) go through unit.set in a fenced transaction; nothing here writes the job store.
 *
 * The synchronous confirmation saved each employee in its own transaction (all of that employee's movements or none;
 * other employees still go through), so this kind is `per-step` with one step per employee: nothing is staged,
 * and an employee's movements become visible when its chunk commits, exactly as before. Every chunk transaction takes
 * the session limits and every lock the employee transaction took, in the same order (beginMovementChunkTx: the
 * exclusive Access lock, reference admission, the type catalogue, the workforce writer and leave-dependency locks), so
 * ending or blacklisting the employment of a person with a login, and changing who someone reports to or which company
 * they belong to, keep today's serialisation. Each employee then runs in a savepoint through commitMovementEmployee
 * with the chunk's shared reads: the lean single pass when it covers the employee, otherwise the very same reference
 * body. The confirmation (failed items and the confirmed event) is one short transaction at the end, under the
 * initiator's freshly resolved authority. */
import {sql} from 'drizzle-orm';
import {createTranslator} from 'next-intl';
import {withTenant,type SessionContext} from '../db/client';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobStep} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {ImportHistoryError,recordImportFailure} from './import-history';
import {beginMovementChunkTx,commitMovementEmployee,movementCommitCounts,movementExcludedEmployee,movementRefusedEmployee,planMovementCommit,type MovementChunkReads,type MovementCommitEmployee,type MovementEmployeeOutcome} from './movement-import';
import {chosenMovementEmployees,confirmableMovementAttemptTx,movementAttemptSource,movementCommitFailure,movementConfirmCommitInput,recordMovementConfirmation,type MovementImportPlan,type MovementUploadResult} from './movement-import-history';
import {MOVEMENT_IMPORT_KIND,type MovementImportJobInput} from './movement-import-job';
import {defaultLocale,isLocale} from '../i18n/config';
import {messagesForLocale} from '../i18n/catalogs';
import type {MovementImportEmployee,MovementImportRecord,MovementImportResult} from '../lib/movement-import-contract';
import {movementImportIssueText} from '../lib/movement-import-issues';
import type {PersonnelLabelResolver} from '../lib/personnel-import-contract';

/** Wall-clock step work per chunk before it commits. One employee's commit (checks, rehearsal and the movements)
 * is usually longer than this, so a chunk normally holds the Access lock for exactly one employee. */
export const MOVEMENT_IMPORT_CHUNK_BUDGET_MS=Number(process.env.MOVEMENT_IMPORT_CHUNK_BUDGET_MS??100);
type StepPayload={key:string;records:MovementImportRecord[]};
/** What the job keeps between units (no movement values: those stay in the step payloads, removed at the end). */
export type MovementImportStoredPlan={sourceName:string;attemptId:string;attemptPlan?:MovementImportPlan;selection?:number[];total?:number;names?:[string,string][];
 commit?:{inputHash:string;fingerprints:Record<string,string>;catalogueHash?:string;acknowledgeClosedPayroll:boolean};
 /** File order: an employee with no chosen row is kept as read; the others point at their step. */
 order?:{key:string;seq?:number;excluded?:MovementImportEmployee}[];
 /** A confirmed attempt answers with its recorded counts, as the synchronous confirmation did. */
 already?:MovementUploadResult;
 /** A refusal before any step: `failure` is the Import History text the synchronous confirmation recorded for it
  * (absent: that refusal was not recorded on the attempt). */
 refused?:true;failure?:string;
 /** Set in the confirmation's own transaction, so a repeated finalize never confirms twice. */
 confirmed?:boolean};
const inputOf=(job:BulkJobRow)=>job.input as MovementImportJobInput|null;
const planOf=(job:BulkJobRow)=>(job.plan??{sourceName:inputOf(job)?.sourceName??'',attemptId:inputOf(job)?.attemptId??''}) as MovementImportStoredPlan;
const isTransient=(error:unknown)=>isTransientBulkJobError(error);
/** The text recordImportFailure stores for this error. */
const historyText=(error:unknown)=>error instanceof ImportHistoryError?error.message:'The operation failed; no changes were committed.';

/** The resolver the confirmation request used (next-intl for the screen's language), built the same way here. */
const resolvers=new Map<string,Promise<PersonnelLabelResolver>>();
export function movementImportResolver(locale:string):Promise<PersonnelLabelResolver>{
 const chosen=isLocale(locale)?locale:defaultLocale;
 let found=resolvers.get(chosen);
 if(!found){
  found=messagesForLocale(chosen).then(messages=>{
   const t=createTranslator({locale:chosen,messages:messages as never}) as unknown as {(key:string):string;has(key:string):boolean};
   return (key:string,fallback:string)=>t.has(key)?t(key):fallback;
  });
  resolvers.set(chosen,found);found.catch(()=>resolvers.delete(chosen));
 }
 return found;
}
/** The screen's message for a refusal: the Import History sentence, or the route's finite code in words. */
async function refusalText(job:BulkJobRow,error:unknown){
 if(error instanceof ImportHistoryError)return error.message;
 return movementImportIssueText('change_refused',await movementImportResolver(inputOf(job)?.locale??defaultLocale));
}
function stepEmployee(plan:MovementImportStoredPlan,payload:StepPayload,names:Map<string,string>):MovementCommitEmployee{
 const commit=plan.commit!;
 return{key:payload.key,records:payload.records,names,selection:plan.selection!,inputHash:commit.inputHash,fingerprints:commit.fingerprints,catalogueHash:commit.catalogueHash,
  history:{attemptId:plan.attemptId},acknowledgeClosedPayroll:commit.acknowledgeClosedPayroll,batchId:plan.attemptId};
}
/** The reads of the chunk transaction now open for a job (replaced at every chunk start, never kept across one). */
const chunkReads=new Map<string,MovementChunkReads>();
const namesOf=(plan:MovementImportStoredPlan,cache:Map<string,unknown>)=>{let names=cache.get('names') as Map<string,string>|undefined;if(!names){names=new Map(plan.names??[]);cache.set('names',names);}return names;};

export const movementImportJobHandler:BulkJobHandler<StepPayload>={
 kind:MOVEMENT_IMPORT_KIND,
 mode:'per-step',
 chunkBudgetMs:MOVEMENT_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:4,
 // A step that keeps meeting lock or serialization refusals is recorded as that employee's refused change.
 transientStepLimit:30,
 phaseOf:()=>'employees',
 isTransient,
 stepRef:step=>step.payload.records[0]?.employeeCode??'',
 /** The confirmation's checks and file read, once, with no tenant lock held. */
 async prepare(ctx,job){
  const input=inputOf(job)!;const resolve=await movementImportResolver(input.locale);
  const base:MovementImportStoredPlan={sourceName:input.sourceName,attemptId:input.attemptId};
  const refuse=async(error:unknown,recorded:boolean)=>{
   if(isTransient(error))throw error;
   return{refused:await refusalText(job,error),plan:{...base,refused:true as const,...(recorded?{failure:historyText(error)}:{})}};
  };
  let held:Awaited<ReturnType<typeof confirmableMovementAttemptTx>>;
  try{held=await withTenant(ctx,tx=>confirmableMovementAttemptTx(tx,ctx,input.attemptId,input.previewHash));}catch(error){return refuse(error,true);}
  if('already' in held)return{steps:[],plan:{...base,already:held.already}};
  let source:Awaited<ReturnType<typeof movementAttemptSource>>;
  try{source=await movementAttemptSource(ctx,held,{resolve});}catch(error){return refuse(error,error instanceof ImportHistoryError);}
  let selected:MovementImportPlan['employees'];
  try{selected=chosenMovementEmployees(held.plan,input.employees);}catch(error){return refuse(error,false);}
  const commitInput=movementConfirmCommitInput(held.plan,source,selected,input);
  let planned:Awaited<ReturnType<typeof planMovementCommit>>;
  try{planned=await planMovementCommit(ctx,commitInput);}catch(error){if(isTransient(error))throw error;return refuse(movementCommitFailure(error,resolve),true);}
  const names=new Map(planned.names),order:NonNullable<MovementImportStoredPlan['order']>=[],steps:{kind:string;rowNum:number;payload:StepPayload}[]=[];
  for(const {key,records} of planned.groups){
   const excluded=movementExcludedEmployee({key,records,names,selection:planned.selection});
   if(excluded){order.push({key,excluded});continue;}
   order.push({key,seq:steps.length});steps.push({kind:'employee',rowNum:Math.min(...records.map(r=>r.row)),payload:{key,records}});
  }
  const plan:MovementImportStoredPlan={...base,attemptPlan:held.plan,selection:planned.selection,total:planned.total,names:planned.names,order,
   commit:{inputHash:commitInput.inputHash,fingerprints:commitInput.fingerprints,catalogueHash:commitInput.catalogueHash,acknowledgeClosedPayroll:commitInput.acknowledgeClosedPayroll===true}};
  return{steps,plan,counters:{employees:steps.length,movements:planned.selection.length}};
 },
 /** The steps become runnable only while the attempt still passes the confirmation checks, under its row lock. */
 async commitPrepareTx(tx,ctx,job,prepared){
  const input=inputOf(job)!;
  if(!('refused' in prepared)&&!(prepared.plan as MovementImportStoredPlan).already){
   const held=await confirmableMovementAttemptTx(tx,ctx,input.attemptId,input.previewHash);
   if('already' in held)throw new ImportHistoryError('This import is already being saved.');
  }
  return{attemptId:input.attemptId};
 },
 /** Every lock an employee transaction takes, once for the chunk, and the reads its employees share (see
  * MovementChunkReads): one employee's commit then runs about a third of the statements it ran alone. */
 async beginChunkTx(tx,ctx,job){chunkReads.set(job.id,await beginMovementChunkTx(tx,ctx));},
 /** One employee, all or nothing, in a savepoint of the chunk; a refusal is that employee's failed rows. */
 async applyStepTx(tx,ctx,job,step,cache){
  const plan=planOf(job);
  const outcome=await commitMovementEmployee(ctx,stepEmployee(plan,step.payload,namesOf(plan,cache)),Number.POSITIVE_INFINITY,body=>tx.transaction(body),isTransient,chunkReads.get(job.id));
  const counters:Record<string,number>={...(outcome.status==='imported'?{imported:outcome.count}:outcome.status==='failed'?{refused:outcome.count}:{}),...(outcome.path?{[outcome.path+'Employees']:1}:{})};
  return{result:outcome,counters};
 },
 /** The result in file order, then the confirmation in one short transaction fenced on the lease. */
 async finalize(ctx,job,unit){
  chunkReads.delete(job.id);
  const plan=planOf(job);
  if(plan.already)return{result:plan.already};
  const steps=await withTenant(ctx,tx=>tx.execute<{seq:number;state:string;payload:StepPayload;result:MovementEmployeeOutcome|null}>(sql`select seq,state,payload,result from bulk_job_step where job_id=${job.id}::uuid order by seq`));
  const bySeq=new Map([...steps].map(s=>[s.seq,s]));const names=new Map(plan.names??[]);
  const result:MovementImportResult={employees:[],imported:0,failed:0,excluded:(plan.total??0)-(plan.selection?.length??0),byEventType:[],batchId:plan.attemptId,attemptId:plan.attemptId};
  for(const entry of plan.order??[]){
   if(entry.excluded){result.employees.push(entry.excluded);continue;}
   const step=bySeq.get(entry.seq!);if(!step)throw new Error('Movement import step unavailable.');
   const outcome=step.state==='applied'&&step.result?step.result:movementRefusedEmployee(stepEmployee(plan,step.payload,names));
   if(outcome.status==='imported')result.imported+=outcome.count;else if(outcome.status==='failed')result.failed+=outcome.count;
   result.employees.push(outcome.employee);
  }
  result.byEventType=movementCommitCounts(result.employees);
  const resolve=await movementImportResolver(inputOf(job)?.locale??defaultLocale);
  if(plan.confirmed)return{result:{...result,attemptId:plan.attemptId,alreadyCommitted:false} satisfies MovementUploadResult};
  const started=performance.now();
  const confirmed=await recordMovementConfirmation(ctx,{attemptId:plan.attemptId,plan:plan.attemptPlan!,result,acknowledgeClosedPayroll:plan.commit?.acknowledgeClosedPayroll,resolve},{
   before:async tx=>{await tx.execute(sql`select set_config('application_name','aihr-bulk:movement_import:finalize',true)`);await unit.fenceTx(tx);},
   // The marker commits with the confirmation, through the sealed job update (the hook above fenced this transaction).
   after:async tx=>{await unit.set(tx,{planMerge:{confirmed:true}});},
  });
  unit.metric('confirmTxMs',performance.now()-started);
  return{result:confirmed};
 },
 /** Import History for a job that stopped before its confirmation, under the creator's authority (best effort). */
 async afterTerminal(ctx,job){
  chunkReads.delete(job.id);
  if(job.state==='completed'||!ctx)return;
  const plan=planOf(job),attemptId=job.attempt_id??plan.attemptId;
  if(!attemptId||plan.confirmed)return;
  // A refusal the synchronous confirmation did not record (for example no valid employee chosen) stays unrecorded.
  if(plan.refused&&plan.failure===undefined)return;
  await recordImportFailure(ctx,attemptId,'movement','failed',new ImportHistoryError(plan.failure??job.error??'The movement import stopped.'));
 },
};
export type {BulkJobStep};
