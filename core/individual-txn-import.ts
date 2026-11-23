import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,asc,desc,eq,inArray,lt,or,sql} from 'drizzle-orm';
import {INDIVIDUAL_IMPORT_MAX_CSV_BYTES,INDIVIDUAL_IMPORT_PAGE_ROWS,INDIVIDUAL_IMPORT_STEP_ROWS} from '../lib/individual-import-job';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {domainEvent,payComponent,payrollBatch,payrollIndividualTxn,payrollTxnImportAttempt as attempt,payrollTxnImportOutcome as outcomeTable,type PayrollTxnImportBinding} from '../db/schema';
import {adminCompaniesTx} from './read';
import {isAdmin} from '../lib/authz-model';
import {analyzeTxnImport,txnImportReason} from './payroll-txn-import';
import {BatchNotDraftError,WRITABLE_BATCH_STATUSES,createIndividualTxnsBulkTx,deleteImportedIndividualTxnsTx,lockNativePayrollPeriodsTx,deriveIndividualTxnAmountTx,resolveDailyImportInput,type PayRule,type WritableBatchStatus} from '../packs/payroll/service';
import {parseIndividualImport} from '../lib/individual-txn-import-contract';
import type {IndividualImportMethod,TxnImportPreview,TxnImportRow} from '../lib/payroll-txn-import-schema';
import type {IndividualImportAttempt,IndividualImportAttemptState,IndividualImportOutcome,IndividualImportPage,IndividualImportPageRow,IndividualImportSummary} from '../lib/individual-txn-import-model';
import {actorOn,creatorOf,resolveImportActors} from './import-actor-label';

const uuid=z.uuid();
export class IndividualImportError extends Error {}
const deny=()=>{throw new IndividualImportError('importAccessDenied');};
async function scope(ctx:SessionContext,ids:string[],tx?:Tx){
 if(ctx.agent||!ctx.userId||!isAdmin(ctx))deny();
 const allowed=new Set((await (tx?adminCompaniesTx(tx):withTenant(ctx,t=>adminCompaniesTx(t)))).map(c=>c.id));
 if(!ids.length||ids.some(id=>!allowed.has(id)))deny();
 return [...new Set(ids)].sort();
}
const safePreview=(p:TxnImportPreview):TxnImportPreview=>({...p,rows:p.rows.map(row=>row.reason==='unexpected'?{...row,detail:undefined}:row)});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const snapshot=(row:typeof payrollIndividualTxn.$inferSelect)=>JSON.parse(JSON.stringify(row)) as Record<string,unknown>;
function matchesImportedSnapshot(row:typeof payrollIndividualTxn.$inferSelect,recorded:Record<string,unknown>|undefined){
 const current=snapshot(row);
 // Receipts written before explicit input methods have no calculationMethod key. NULL retains
 // that exact legacy interpretation; an explicit method must still invalidate reversal.
 if(recorded&&!Object.hasOwn(recorded,'calculationMethod')&&current.calculationMethod===null)delete current.calculationMethod;
 // 792053e5 — receipts written before the pricing marker have no marker keys. Marking the row (the one-off script or
 // a later re-pricing) is not an operator change; a re-priced amount still differs and still refuses reversal.
 for(const key of ['pricingSource','pricingRef','pricedAt'])if(recorded&&!Object.hasOwn(recorded,key))delete current[key];
 return isDeepStrictEqual(current,recorded);
}
type IndividualAnalysis=Extract<Awaited<ReturnType<typeof analyzeTxnImport>>,{kind:'individual'}>;
type ResolvedRow=IndividualAnalysis['resolved'] extends Map<number,infer Row>?Row:never;
function canonicalBinding(r:ResolvedRow):PayrollTxnImportBinding{return {
 employmentId:r.employmentId,companyId:r.companyId,departmentId:r.departmentId,componentId:r.componentId,
 intendedCycleId:r.intendedCycleId??null,targetBatchId:r.targetBatchId,targetCycle:r.targetCycle,payPeriod:r.payPeriod,
 txnDate:r.txnDate,kind:r.kind,quantity:r.quantity,unit:r.unit,sourceRef:r.sourceRef,notes:r.notes,
 ...(r.explicitDailyRuleHash ? {dailyRuleHash:r.explicitDailyRuleHash} : {}),
};}
async function eventIds(tx:Tx,id:string){return (await tx.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,id),eq(domainEvent.aggregateType,'payroll-individual-txn'))).orderBy(asc(domainEvent.id))).map(e=>e.id);}
/** 0ec0ee00 — every row's event ids in one read (revert verifies up to 10,000 rows). Same order as eventIds. */
async function eventIdsByRow(tx:Tx,ctx:SessionContext,ids:string[]):Promise<Map<string,string[]>>{
 if(!ids.length)return new Map();
 const rows=await tx.execute<{id:string;events:string[]}>(sql`select aggregate_id as id,jsonb_agg(id order by id) as events from domain_event
  where tenant_id=${ctx.tenantId}::uuid and aggregate_type='payroll-individual-txn' and aggregate_id=any(${uuidArray(ids)}::uuid[]) group by aggregate_id`);
 return new Map([...rows].map(row=>[row.id,row.events]));
}
const uuidArray=(ids:readonly string[])=>{for(const id of ids)uuid.parse(id);return `{${ids.join(',')}}`;};
const intArray=(values:readonly number[])=>`{${values.map(value=>{if(!Number.isSafeInteger(value))throw new IndividualImportError('importFailed');return value;}).join(',')}}`;
function project(r:typeof attempt.$inferSelect,outcomes:IndividualImportOutcome[]=r.outcomes):IndividualImportAttempt{return {id:r.id,sourceName:r.sourceName,method:r.method,createdBy:r.createdBy,createdAt:r.createdAt.toISOString(),state:r.state,records:r.records,preview:safePreview(r.preview),outcomes,written:r.written,recalcBatchIds:r.recalcBatchIds,revertedAt:r.revertedAt?.toISOString()??null,revertedBy:r.revertedBy,processed:r.processed,revertedCount:r.revertedCount};}
/** Inline outcomes (attempts confirmed before stage 2) or the step-written outcome rows, in row order. */
async function outcomesOf(tx:Tx,r:typeof attempt.$inferSelect):Promise<IndividualImportOutcome[]>{
 if(r.outcomes.length||r.state==='validated')return r.outcomes;
 return (await tx.select({outcome:outcomeTable.outcome}).from(outcomeTable).where(eq(outcomeTable.attemptId,r.id)).orderBy(asc(outcomeTable.rowNum))).map(row=>row.outcome);
}
async function owned(tx:Tx,ctx:SessionContext,id:string,scopeIds:string[],lock=false){
 uuid.parse(id);await scope(ctx,scopeIds,tx);
 const query=tx.select().from(attempt).where(and(eq(attempt.id,id),eq(attempt.tenantId,ctx.tenantId)));
 const [r]=await(lock?query.for('update'):query);
 if(!r||r.companyIds.some(c=>!scopeIds.includes(c)))deny();return r;
}
async function stamp(tx:Tx,ctx:SessionContext,id:string,event:string,extra:Record<string,unknown>={}){
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-txn-import',aggregateId:id,eventType:`payroll.txn-import.${event}`,actor:actorOf(ctx),payload:extra});
}
/** Persist the exact validated source. Repeated upload operation IDs cannot overwrite its meaning. */
export async function validateIndividualImport(ctx:SessionContext,p:{operationId:string;sourceName:string;csv:string;method:IndividualImportMethod;scopeIds:string[];allowPreviousDaily?:boolean}):Promise<IndividualImportAttempt>{
 uuid.parse(p.operationId);if(p.method!=='monthly'&&p.method!=='daily')throw new IndividualImportError('templateMismatch');
 if(typeof p.csv!=='string'||new TextEncoder().encode(p.csv).byteLength>INDIVIDUAL_IMPORT_MAX_CSV_BYTES)throw new IndividualImportError('contentTooLarge');
 const ids=await scope(ctx,p.scopeIds);
 const name=p.sourceName.trim();if(!name.toLowerCase().endsWith('.xlsx')||name.length>255)throw new IndividualImportError('invalidFormat');
 let records:Record<string,string>[]=[],fileError:string|undefined;
 try{records=parseIndividualImport(p.csv,p.method,{allowPreviousDaily:p.allowPreviousDaily});}catch(e){fileError=e instanceof Error?e.message:'templateMismatch';}
 const analysis=fileError?null:await analyzeTxnImport(ctx,{kind:'individual',scopeIds:ids,records});
 const bindings:Record<string,PayrollTxnImportBinding>=analysis?.kind==='individual'?Object.fromEntries([...analysis.resolved].map(([number,row])=>[String(number),canonicalBinding(row)])):{};
 const preview=fileError?{kind:'individual' as const,total:0,valid:0,invalid:0,rows:[],fileError}:analysis!.preview;
 const sanitized=safePreview(preview);
 const sourceHash=digest(JSON.stringify({method:p.method,csv:p.csv}));
 return withTenant(ctx,async tx=>{
  await scope(ctx,ids,tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+ctx.userId+':'+p.operationId},0))`);
  const [old]=await tx.select().from(attempt).where(and(eq(attempt.operationId,p.operationId),eq(attempt.createdBy,ctx.userId!),eq(attempt.tenantId,ctx.tenantId)));
  if(old){if(old.sourceHash!==sourceHash||JSON.stringify(old.companyIds)!==JSON.stringify(ids))throw new IndividualImportError('operationChanged');return project(old);}
  const [r]=await tx.insert(attempt).values({tenantId:ctx.tenantId,operationId:p.operationId,createdBy:ctx.userId!,companyIds:ids,sourceName:name,sourceHash,method:p.method,records,bindings,preview:sanitized,totalRows:preview.total,invalidRows:preview.invalid}).returning();
  await stamp(tx,ctx,r.id,'validated',{total:preview.total,valid:preview.valid,invalid:preview.invalid});return project(r);
 });
}

/** 0ec0ee00 — where a step-written import stands. */
export type IndividualImportProgress={state:IndividualImportAttemptState;total:number;processed:number;written:number;revertedCount:number};
type StepState={id:string;state:IndividualImportAttemptState;method:IndividualImportMethod;companyIds:string[];total:number;processed:number;written:number;
 recalcBatchIds:string[];fileError:string|null;rows:TxnImportRow[];bindings:Record<string,PayrollTxnImportBinding>};
const progressOf=(r:{state:IndividualImportAttemptState;total:number;processed:number;written:number;revertedCount?:number}):IndividualImportProgress=>
 ({state:r.state,total:r.total,processed:r.processed,written:r.written,revertedCount:r.revertedCount??0});
/** The next step's preview rows and stored bindings, sliced in SQL: a step never parses the whole preview. */
async function readStep(tx:Tx,ctx:SessionContext,id:string,scopeIds:string[],lock:boolean):Promise<StepState>{
 uuid.parse(id);await scope(ctx,scopeIds,tx);
 const [r]=await tx.execute<{id:string;state:IndividualImportAttemptState;method:IndividualImportMethod;company_ids:string[];total:number;processed:number;written:number;recalc_batch_ids:string[];file_error:string|null;rows:TxnImportRow[];bindings:Record<string,PayrollTxnImportBinding>}>(sql`
  select a.id,a.state,a.method,a.company_ids,coalesce(a.total_rows,jsonb_array_length(a.preview->'rows'))::int as total,a.processed,a.written,a.recalc_batch_ids,
   case when a.total_rows is null or a.total_rows=0 then a.preview->>'fileError' end as file_error,
   case when a.state in ('validated','importing') then (select coalesce(jsonb_agg(e order by i),'[]'::jsonb) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i)
    where i>a.processed and i<=a.processed+${INDIVIDUAL_IMPORT_STEP_ROWS}) else '[]'::jsonb end as rows,
   case when a.state in ('validated','importing') then (select coalesce(jsonb_object_agg(b.key,b.value),'{}'::jsonb) from jsonb_each(a.bindings) b
    where (case when b.key ~ '^[0-9]{1,6}$' then b.key::int end) between a.processed+2 and a.processed+1+${INDIVIDUAL_IMPORT_STEP_ROWS}) else '{}'::jsonb end as bindings
  from payroll_txn_import_attempt a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid ${lock?sql`for update of a`:sql``}`);
 if(!r||r.company_ids.some(c=>!scopeIds.includes(c)))deny();
 return {id:r.id,state:r.state,method:r.method,companyIds:r.company_ids,total:r.total,processed:r.processed,written:r.written,recalcBatchIds:r.recalc_batch_ids,
  fileError:r.file_error,rows:r.rows,bindings:r.bindings};
}

/**
 * 0ec0ee00 — one confirmation step: the next INDIVIDUAL_IMPORT_STEP_ROWS rows in one short transaction that owns only
 * those rows' payroll periods and step-scoped bindings. The stored whole-file analysis decides which rows may be
 * written; each of them is re-checked against a fresh analysis of the whole stored file focused on this step, so the
 * file digest (sourceRef), row numbers and run targeting are those the reviewer approved. Outcomes are appended to
 * payroll_txn_import_outcome and the attempt's progress moves in the same transaction, so a step either commits in
 * full or not at all and a resumed worker continues after the last committed step. The attempt is completed only
 * by the step that records the last row.
 */
export async function confirmIndividualImportStep(ctx:SessionContext,p:{id:string;scopeIds:string[]}):Promise<IndividualImportProgress>{
 const nominee=await withTenant(ctx,tx=>readStep(tx,ctx,p.id,p.scopeIds,false));
 if(nominee.state!=='validated'&&nominee.state!=='importing')return progressOf(nominee);
 if(nominee.fileError)throw new IndividualImportError(nominee.fileError);
 const selections=nominee.rows.filter(row=>row.ok).flatMap(row=>{const b=nominee.bindings[String(row.rowNum)];return b?[{companyId:b.companyId,payPeriod:b.payPeriod}]:[];});
 const [{records}]=await withTenant(ctx,tx=>tx.select({records:attempt.records}).from(attempt).where(eq(attempt.id,nominee.id)));
 return withTenant(ctx,async tx=>{
  if(selections.length)await lockNativePayrollPeriodsTx(tx,ctx,selections);
  const r=await readStep(tx,ctx,p.id,p.scopeIds,true);
  // Another runner moved this attempt since the nominee read: report where it is; the caller reads again.
  if((r.state!=='validated'&&r.state!=='importing')||r.processed!==nominee.processed)return progressOf(r);
  const writable=r.rows.filter(row=>row.ok).map(row=>row.rowNum);
  // The bounded owner helper locks only this step's immutable canonical identities.
  // Employment intentionally has no runtime UPDATE grant, so ordinary SELECT FOR SHARE is unavailable.
  if(writable.length){try{await tx.execute(sql`select app.payroll_txn_import_lock_step_bindings(${r.id}::uuid,${intArray(writable)}::int[])`);}catch{throw new IndividualImportError('previewChanged');}}
  const analysis=writable.length?await analyzeTxnImport(ctx,{kind:'individual',scopeIds:p.scopeIds,records,focus:new Set(writable)}):null;
  if(analysis&&analysis.kind!=='individual')throw new IndividualImportError('templateMismatch');
  const fresh=new Map((analysis?safePreview(analysis.preview).rows:[]).map(row=>[row.rowNum,row]));
  const outcomes:IndividualImportOutcome[]=[],targets=new Set<string>();
  for(const original of r.rows){
   // A row the reviewer saw refused is never written; it keeps the verdict the reviewer saw.
   if(!original.ok){outcomes.push({row:original,state:'invalid'});continue;}
   const row=fresh.get(original.rowNum)??original;
   const resolved=analysis?.resolved.get(original.rowNum);
   const originalBinding=r.bindings[String(original.rowNum)];
   // An unbound legacy attempt or a changed lookup must never acquire a new payee/target on confirmation.
   if(!resolved||!row.ok||!originalBinding||!isDeepStrictEqual(originalBinding,canonicalBinding(resolved))||original.amount!==row.amount){
    outcomes.push({row:{...row,ok:false,reason:'previewChanged'},state:'failed'});continue;
   }
   try{
    const result=await tx.transaction(async savepoint=>{
     if(resolved.targetBatchId)await savepoint.select({id:payrollBatch.id}).from(payrollBatch).where(eq(payrollBatch.id,resolved.targetBatchId)).for('update');
     const [item]=await savepoint.select({rule:payComponent.rule}).from(payComponent).where(eq(payComponent.id,resolved.componentId)).for('share');
     if(!item)throw new IndividualImportError('previewChanged');
     const rule=item.rule as PayRule|null;
     if (r.method === 'daily') {
      const daily = resolveDailyImportInput(rule, resolved.explicitDailyInput);
      if ('reason' in daily || daily.unit !== resolved.unit ||
          resolved.explicitDailyRuleHash && resolved.explicitDailyRuleHash !== digest(JSON.stringify(rule ?? null))) throw new IndividualImportError('previewChanged');
     }
     const priced=await deriveIndividualTxnAmountTx(savepoint,ctx,{componentId:resolved.componentId,employmentId:resolved.employmentId,companyId:resolved.companyId,payPeriod:resolved.payPeriod,quantity:resolved.quantity,unit:resolved.unit,effectiveDate:resolved.txnDate});
     if(priced.derived&&priced.amount.toFixed(2)!==row.amount)throw new IndividualImportError('previewChanged');
     const result=await createIndividualTxnsBulkTx(savepoint,ctx,{
      ...(resolved.targetBatchId?{batchId:resolved.targetBatchId}:{companyId:resolved.companyId,payPeriod:resolved.payPeriod}),
      employmentIds:[resolved.employmentId],intendedCycleId:resolved.intendedCycleId,
      rows:[{kind:resolved.kind,componentId:resolved.componentId,txnDate:resolved.txnDate,amount:resolved.amount,quantity:resolved.quantity,unit:resolved.unit,notes:resolved.notes,source:'import',sourceRef:resolved.sourceRef}],
     });
     const [created]=await savepoint.select().from(payrollIndividualTxn).where(eq(payrollIndividualTxn.id,result.ids[0]));
     if(!created)throw new IndividualImportError('importFailed');
     return {row,state:'imported' as const,transactionId:created.id,snapshot:snapshot(created),eventIds:await eventIds(savepoint,created.id)};
    });outcomes.push(result);
    if(resolved.targetBatchId)targets.add(resolved.targetBatchId);
   }catch(e){const failure:{reason:string;detail?:Record<string,string|number>}=e instanceof IndividualImportError?{reason:e.message}:txnImportReason(e);if(failure.reason==='unexpected')delete failure.detail;outcomes.push({row:{...row,ok:false,...failure},state:'failed'});}
  }
  // A processed run this step wrote to will need recalculation; remembered per step, so a stopped import keeps it.
  const recalc=[...r.recalcBatchIds];
  if(targets.size){
   const processedRuns=await tx.select({id:payrollBatch.id}).from(payrollBatch).where(and(inArray(payrollBatch.id,[...targets]),eq(payrollBatch.status,'processed')));
   for(const run of processedRuns.map(x=>x.id).sort())if(!recalc.includes(run))recalc.push(run);
  }
  if(outcomes.length)await tx.insert(outcomeTable).values(outcomes.map(o=>({attemptId:r.id,rowNum:o.row.rowNum,tenantId:ctx.tenantId,state:o.state,transactionId:o.transactionId??null,outcome:o})));
  const processed=r.processed+outcomes.length,written=r.written+outcomes.filter(o=>o.state==='imported').length;
  const state:IndividualImportAttemptState=processed>=r.total?'completed':'importing';
  await tx.update(attempt).set({state,processed,written,recalcBatchIds:recalc}).where(eq(attempt.id,r.id));
  if(state==='completed'){
   const [failed]=await tx.execute<{count:number}>(sql`select count(*)::int as count from payroll_txn_import_outcome where attempt_id=${r.id}::uuid and state='failed'`);
   await stamp(tx,ctx,r.id,'confirmed',{written,failed:failed.count});
  }
  return progressOf({state,total:r.total,processed,written});
 });
}

/**
 * 0ec0ee00 — a step kept failing: keep every row already written (they stay revertable) and say so. Returns the
 * attempt's state afterwards; an attempt that finished meanwhile is left as it is.
 */
export async function stopIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[];reason:string}):Promise<IndividualImportAttemptState>{
 return withTenant(ctx,async tx=>{
  const r=await readStep(tx,ctx,p.id,p.scopeIds,true);
  if(r.state!=='validated'&&r.state!=='importing')return r.state;
  await tx.update(attempt).set({state:'stopped'}).where(eq(attempt.id,r.id));
  await stamp(tx,ctx,r.id,'stopped',{reason:p.reason,written:r.written,processed:r.processed});
  return 'stopped';
 });
}

/** Confirmation writes every row, step by step, in this call (direct callers and tests; the Import Log uses the worker). */
export async function confirmIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[]}, reportProgress?: (processed: number) => Promise<void>):Promise<IndividualImportAttempt>{
 let idle=0,last=-1;
 for(;;){
  const step=await confirmIndividualImportStep(ctx,p);
  if(reportProgress)await reportProgress(step.processed);
  if(step.state!=='validated'&&step.state!=='importing')break;
  idle=step.processed===last?idle+1:0;last=step.processed;
  if(idle>3)throw new IndividualImportError('importFailed');
 }
 return withTenant(ctx,async tx=>{const r=await owned(tx,ctx,p.id,p.scopeIds);return project(r,await outcomesOf(tx,r));});
}
export async function listIndividualImports(ctx:SessionContext,scopeIds:string[],before?:{at:string;id:string}, legacyOnly = false):Promise<IndividualImportAttempt[]>{
 await scope(ctx,scopeIds);if(before){z.iso.datetime().parse(before.at);uuid.parse(before.id);}
 return withTenant(ctx,async tx=>{
  const rows=await tx.select().from(attempt).where(and(eq(attempt.tenantId,ctx.tenantId),sql`${attempt.companyIds} <@ ${JSON.stringify(scopeIds)}::jsonb`,legacyOnly ? sql`not exists (select 1 from payroll_individual_import_job job where job.attempt_id = ${attempt.id})` : undefined,before?or(lt(attempt.createdAt,new Date(before.at)),and(eq(attempt.createdAt,new Date(before.at)),lt(attempt.id,before.id))):undefined)).orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(101);
  const visible=rows.filter(r=>r.companyIds.every(c=>scopeIds.includes(c)));
  const actors=await resolveImportActors(tx,'payroll_individual_attempt',visible.map(r=>r.id));
  return visible.map(r=>({...project(r),createdByActor:creatorOf(actors,r.id)}));
 });
}
async function importEvents(tx:Tx,id:string,actors:Awaited<ReturnType<typeof resolveImportActors>>){
 const events=await tx.select({type:domainEvent.eventType,at:domainEvent.occurredAt,actorId:domainEvent.actorId,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.aggregateId,id),eq(domainEvent.aggregateType,'payroll-txn-import'))).orderBy(asc(domainEvent.occurredAt),asc(domainEvent.id));
 return events.map(event=>({type:event.type.slice('payroll.txn-import.'.length),at:event.at.toISOString(),actorId:event.actorId,actor:actorOn(actors,id,event.actorId),...(typeof (event.payload as {reason?:unknown})?.reason==='string'?{reason:(event.payload as {reason:string}).reason}:{})}));
}
/** The whole attempt, every row included. API and tests; the Import Log pages read the summary and one page of rows. */
export async function readIndividualImport(ctx:SessionContext,id:string,scopeIds:string[]):Promise<IndividualImportAttempt>{return withTenant(ctx,async tx=>{
 const r=await owned(tx,ctx,id,scopeIds),item=project(r,await outcomesOf(tx,r));
 const actors=await resolveImportActors(tx,'payroll_individual_attempt',[id]),jobs=await tx.execute<{id:string}>(sql`select id from payroll_individual_import_job where attempt_id=${id}::uuid limit 1`);
 return {...item,createdByActor:creatorOf(actors,id),revertedByActor:item.revertedBy?actorOn(actors,id,item.revertedBy):null,jobId:[...jobs][0]?.id??null,events:await importEvents(tx,id,actors)};
 });}

/**
 * 0ec0ee00 — an Import Log entry's counts and facts without its rows. Counts come from the summary columns, the step
 * outcome table or (attempts confirmed before stage 2) the inline outcomes, never from parsing the rows in the app.
 */
export async function readIndividualImportSummary(ctx:SessionContext,id:string,scopeIds:string[]):Promise<IndividualImportSummary>{
 uuid.parse(id);
 return withTenant(ctx,async tx=>{
  await scope(ctx,scopeIds,tx);
  const [r]=await tx.execute<{id:string;source_name:string;method:IndividualImportMethod;created_at:Date;state:IndividualImportAttemptState;company_ids:string[];
   total:number;invalid:number;processed:number;written:number;reverted_count:number;reverted_at:Date|null;reverted_by:string|null;
   file_error:string|null;inline_outcomes:number;inline_failed:number;periods:string[];cycles:string[];job_id:string|null}>(sql`
   select a.id,a.source_name,a.method,a.created_at,a.state,a.company_ids,
    coalesce(a.total_rows,(a.preview->>'total')::int,0) as total,coalesce(a.invalid_rows,(a.preview->>'invalid')::int,0) as invalid,
    a.processed,a.written,a.reverted_count,a.reverted_at,a.reverted_by,
    case when a.total_rows is null or a.total_rows=0 then a.preview->>'fileError' end as file_error,
    case when a.processed=0 and a.state<>'validated' then jsonb_array_length(a.outcomes) else 0 end as inline_outcomes,
    case when a.processed=0 and a.state<>'validated' then (select count(*)::int from jsonb_array_elements(a.outcomes) o where o->>'state'<>'imported') else 0 end as inline_failed,
    facts.periods,facts.cycles,
    (select j.id from payroll_individual_import_job j where j.attempt_id=a.id limit 1) as job_id
   from payroll_txn_import_attempt a
   cross join lateral (select coalesce((select jsonb_agg(distinct x.v order by x.v) from (select e->>'__pay_period' as v from jsonb_array_elements(a.records) e) x where x.v<>'' ),'[]'::jsonb) as periods,
     coalesce((select jsonb_agg(distinct x.v order by x.v) from (select e->>'__configured_cycle' as v from jsonb_array_elements(a.records) e) x where x.v<>''),'[]'::jsonb) as cycles) facts
   where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid`);
  if(!r||r.company_ids.some(c=>!scopeIds.includes(c)))deny();
  const stepWritten=r.processed>0||(r.inline_outcomes===0&&r.state!=='validated');
  const failed=r.state==='validated'?0:stepWritten?r.processed-r.written:r.inline_failed;
  const actors=await resolveImportActors(tx,'payroll_individual_attempt',[id]);
  return {id:r.id,sourceName:r.source_name,method:r.method,createdAt:new Date(r.created_at).toISOString(),state:r.state,
   total:r.total,valid:r.total-r.invalid,invalid:r.invalid,processed:stepWritten?r.processed:r.state==='validated'?0:r.inline_outcomes,
   written:r.written,failed,revertedCount:r.reverted_count,fileError:r.file_error,revertedAt:r.reverted_at?new Date(r.reverted_at).toISOString():null,
   periods:r.periods.slice(0,24),cycles:r.cycles.slice(0,24),hasErrors:r.invalid>0||failed>0,
   createdByActor:creatorOf(actors,id),revertedByActor:r.reverted_by?actorOn(actors,id,r.reverted_by):null,jobId:r.job_id,
   events:await importEvents(tx,id,actors)};
 });
}

type RowSlice={state:IndividualImportAttemptState;total:number;processed:number;records:[number,Record<string,string>][];rows:[number,TxnImportRow][];inline:[number,IndividualImportOutcome][]|null};
/** 0ec0ee00 — one page of an Import Log batch: the uploaded values, verdicts and outcomes of rows `from`..`to` (1-based). */
export async function listIndividualImportRows(ctx:SessionContext,id:string,scopeIds:string[],page:number):Promise<IndividualImportPage>{
 uuid.parse(id);
 const size=INDIVIDUAL_IMPORT_PAGE_ROWS;
 return withTenant(ctx,async tx=>{
  await scope(ctx,scopeIds,tx);
  const [head]=await tx.execute<{company_ids:string[];total:number}>(sql`select a.company_ids,coalesce(a.total_rows,jsonb_array_length(a.preview->'rows'))::int as total
   from payroll_txn_import_attempt a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid`);
  if(!head||head.company_ids.some(c=>!scopeIds.includes(c)))deny();
  const pages=Math.max(1,Math.ceil(head.total/size)),current=Math.min(Math.max(0,Math.floor(Number.isFinite(page)?page:0)),pages-1);
  const from=current*size+1,to=from+size-1;
  const [slice]=await tx.execute<RowSlice>(sql`
   select a.state,coalesce(a.total_rows,jsonb_array_length(a.preview->'rows'))::int as total,a.processed,
    (select coalesce(jsonb_agg(jsonb_build_array(i,e) order by i),'[]'::jsonb) from jsonb_array_elements(a.records) with ordinality t(e,i) where i between ${from} and ${to}) as records,
    (select coalesce(jsonb_agg(jsonb_build_array(i,e) order by i),'[]'::jsonb) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i) where i between ${from} and ${to}) as rows,
    case when a.processed=0 and a.state<>'validated' and jsonb_array_length(a.outcomes)>0 then
     (select coalesce(jsonb_agg(jsonb_build_array(i,e) order by i),'[]'::jsonb) from jsonb_array_elements(a.outcomes) with ordinality t(e,i) where i between ${from} and ${to}) end as inline
   from payroll_txn_import_attempt a where a.id=${id}::uuid`);
  const stepped=slice.state!=='validated'&&!slice.inline
   ?new Map((await tx.select({rowNum:outcomeTable.rowNum,outcome:outcomeTable.outcome}).from(outcomeTable)
     .where(and(eq(outcomeTable.attemptId,id),sql`${outcomeTable.rowNum} between ${from+1} and ${to+1}`)).orderBy(asc(outcomeTable.rowNum))).map(row=>[row.rowNum,row.outcome]))
   :new Map<number,IndividualImportOutcome>();
  const records=new Map(slice.records),rows=new Map(slice.rows),inline=new Map(slice.inline??[]);
  const out:IndividualImportPageRow[]=[];
  for(let i=from;i<=Math.min(to,slice.total);i++){
   const verdict=rows.get(i)??null,record=records.get(i)??null;
   const recorded=slice.inline?inline.get(i):stepped.get(i+1);
   if(slice.state==='validated'||!recorded){
    out.push({rowNum:i+1,record,row:verdict,outcome:slice.state==='validated'?(verdict?.ok?'valid':'invalid'):(verdict?.ok?'pending':'invalid'),snapshotUnit:null});
   }else{
    const unit=recorded.snapshot?.unit;
    out.push({rowNum:i+1,record,row:recorded.row,outcome:recorded.state,snapshotUnit:typeof unit==='string'?unit:null});
   }
  }
  return {rows:out,total:slice.total,page:current,pages};
 });
}

/** 0ec0ee00 — every refused row with its uploaded values, for the row-error download. */
export async function listIndividualImportFailures(ctx:SessionContext,id:string,scopeIds:string[]):Promise<{row:TxnImportRow;record:Record<string,string>|null}[]>{
 uuid.parse(id);
 return withTenant(ctx,async tx=>{
  await scope(ctx,scopeIds,tx);
  const [r]=await tx.execute<{company_ids:string[];failures:[number,TxnImportRow][];records:Record<string,string>[]}>(sql`
   select a.company_ids,a.records,
    case when a.state='validated' then
      (select coalesce(jsonb_agg(jsonb_build_array(i,e) order by i),'[]'::jsonb) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i) where (e->>'ok')::boolean is not true)
     when a.processed=0 and jsonb_array_length(a.outcomes)>0 then
      (select coalesce(jsonb_agg(jsonb_build_array(i,e->'row') order by i),'[]'::jsonb) from jsonb_array_elements(a.outcomes) with ordinality t(e,i) where (e->'row'->>'ok')::boolean is not true)
     else
      (select coalesce(jsonb_agg(x.pair order by x.i),'[]'::jsonb) from (
        select o.row_num-1 as i,jsonb_build_array(o.row_num-1,o.outcome->'row') as pair from payroll_txn_import_outcome o where o.attempt_id=a.id and o.state<>'imported'
        union all
        select i,jsonb_build_array(i,e) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i) where i>a.processed and (e->>'ok')::boolean is not true) x)
    end as failures
   from payroll_txn_import_attempt a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid`);
  if(!r||r.company_ids.some(c=>!scopeIds.includes(c)))deny();
  return r.failures.map(([i,row])=>({row,record:r.records[i-1]??null}));
 });
}

type ImportedRow={rowNum:number;transactionId:string;snapshot:Record<string,unknown>|undefined;eventIds:string[]|undefined};
type RevertState={id:string;state:IndividualImportAttemptState;total:number;processed:number;written:number;revertedCount:number;revertCursor:number;
 confirmProcessed:boolean;inline:boolean;companyIds:string[]};
async function readRevert(tx:Tx,ctx:SessionContext,id:string,scopeIds:string[],lock:boolean):Promise<RevertState>{
 uuid.parse(id);await scope(ctx,scopeIds,tx);
 const [r]=await tx.execute<{id:string;state:IndividualImportAttemptState;total:number;processed:number;written:number;reverted_count:number;revert_cursor:number;
  revert_confirm_processed:boolean;inline:boolean;company_ids:string[]}>(sql`
  select a.id,a.state,coalesce(a.total_rows,jsonb_array_length(a.preview->'rows'))::int as total,a.processed,a.written,a.reverted_count,a.revert_cursor,
   a.revert_confirm_processed,(a.processed=0 and jsonb_array_length(a.outcomes)>0) as inline,a.company_ids
  from payroll_txn_import_attempt a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid ${lock?sql`for update of a`:sql``}`);
 if(!r||r.company_ids.some(c=>!scopeIds.includes(c)))deny();
 return {id:r.id,state:r.state,total:r.total,processed:r.processed,written:r.written,revertedCount:r.reverted_count,revertCursor:r.revert_cursor,
  confirmProcessed:r.revert_confirm_processed,inline:r.inline,companyIds:r.company_ids};
}
/** Imported rows after `cursor`, in row order: from the outcome table, or from the inline outcomes of older attempts. */
async function importedAfter(tx:Tx,r:RevertState,cursor:number,limit:number|null):Promise<ImportedRow[]>{
 const rows=await tx.execute<{row_num:number;transaction_id:string;snapshot:Record<string,unknown>|null;event_ids:string[]|null}>(r.inline?sql`
  select x.row_num,x.o->>'transactionId' as transaction_id,x.o->'snapshot' as snapshot,x.o->'eventIds' as event_ids
  from (select (o->'row'->>'rowNum')::int as row_num,o from payroll_txn_import_attempt a,jsonb_array_elements(a.outcomes) o where a.id=${r.id}::uuid and o->>'state'='imported') x
  where x.row_num>${cursor} order by x.row_num ${limit==null?sql``:sql`limit ${limit}`}`:sql`
  select o.row_num,o.transaction_id,o.outcome->'snapshot' as snapshot,o.outcome->'eventIds' as event_ids from payroll_txn_import_outcome o
  where o.attempt_id=${r.id}::uuid and o.state='imported' and o.row_num>${cursor} order by o.row_num ${limit==null?sql``:sql`limit ${limit}`}`);
 return [...rows].map(row=>({rowNum:row.row_num,transactionId:row.transaction_id,snapshot:row.snapshot??undefined,eventIds:row.event_ids??undefined}));
}
/**
 * Every given imported row must still exist, belong to the caller's scope and match what the import wrote, with no
 * later event; its run must be writable and a processed run needs the acknowledgement. Set-based: one read each for
 * rows, events and runs. With `lock`, runs and then rows are held FOR UPDATE (payroll processing uses these locks).
 */
async function verifyRevertable(tx:Tx,ctx:SessionContext,scopeIds:string[],imported:ImportedRow[],confirmProcessed:boolean,lock:boolean){
 const ids=imported.map(row=>row.transactionId);
 if(!ids.length)return [];
 const read=()=>tx.select().from(payrollIndividualTxn).where(inArray(payrollIndividualTxn.id,ids)).orderBy(asc(payrollIndividualTxn.id));
 const nominee=await read();
 const batchIds=[...new Set(nominee.map(row=>row.batchId).filter((v):v is string=>!!v))].sort();
 // Lock all run statuses before inspecting or removing any row. Payroll processing uses these same locks.
 const batches=batchIds.length?await (lock
  ?tx.select({id:payrollBatch.id,status:payrollBatch.status}).from(payrollBatch).where(inArray(payrollBatch.id,batchIds)).orderBy(asc(payrollBatch.id)).for('update')
  :tx.select({id:payrollBatch.id,status:payrollBatch.status}).from(payrollBatch).where(inArray(payrollBatch.id,batchIds))):[];
 const rows=lock?await read().for('update'):nominee;
 if(rows.length!==ids.length||rows.some(row=>row.batchId&&!batchIds.includes(row.batchId)))throw new IndividualImportError('importRowsChanged');
 const byId=new Map(imported.map(row=>[row.transactionId,row])),events=await eventIdsByRow(tx,ctx,ids);
 for(const row of rows){
  const original=byId.get(row.id)!;
  if(!row.companyId||!scopeIds.includes(row.companyId)||!matchesImportedSnapshot(row,original.snapshot)||!isDeepStrictEqual(events.get(row.id)??[],original.eventIds))throw new IndividualImportError('importRowsChanged');
 }
 const status=new Map(batches.map(batch=>[batch.id,batch.status]));
 if(batchIds.some(id=>!WRITABLE_BATCH_STATUSES.includes(status.get(id) as WritableBatchStatus)))throw new BatchNotDraftError();
 if(!confirmProcessed&&batchIds.some(id=>status.get(id)==='processed'))throw new IndividualImportError('confirmProcessedRevert');
 return rows;
}
/** Bounded error codes only: driver exceptions may contain payroll values. */
export const individualImportErrorCode=(e:unknown,fallback:string)=>e instanceof IndividualImportError?e.message:e instanceof BatchNotDraftError?'revertFailed':fallback;

/**
 * Start (or join) a revert: under the attempt's row lock, every remaining imported row is proved unchanged and
 * revertable before anything is removed, and the attempt moves to reverting. A refusal changes nothing.
 * `jobStalled`: the batch's queue entry is no longer reverting, so a revert left half-done is handed back first.
 */
async function beginRevertTx(tx:Tx,ctx:SessionContext,p:{id:string;scopeIds:string[];confirmProcessed:boolean},jobStalled:boolean):Promise<IndividualImportAttemptState>{
 let r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
 if(r.state==='reverted')return r.state;
 if(r.state==='reverting'&&!jobStalled)return r.state;
 if(r.state==='reverting'){
  await tx.update(attempt).set({state:r.revertedCount===0&&(r.inline||r.processed===r.total)?'completed':'stopped'}).where(eq(attempt.id,r.id));
  r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
 }
 if(r.state==='importing'&&jobStalled){
  // The worker stopped this import but could not record it (for example, its creator lost access).
  await tx.update(attempt).set({state:'stopped'}).where(eq(attempt.id,r.id));
  r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
 }
 if((r.state!=='completed'&&r.state!=='stopped')||r.written-r.revertedCount<=0)throw new IndividualImportError('revertUnavailable');
 await verifyRevertable(tx,ctx,p.scopeIds,await importedAfter(tx,r,r.revertCursor,null),p.confirmProcessed,false);
 await tx.update(attempt).set({state:'reverting',revertRequestedBy:ctx.userId!,revertConfirmProcessed:p.confirmProcessed}).where(eq(attempt.id,r.id));
 return 'reverting';
}
async function recordRefusal(ctx:SessionContext,p:{id:string;scopeIds:string[]},e:unknown){
 // Log a refused reversal separately after rollback, without publishing protected row details.
 await withTenant(ctx,async tx=>{const r=await readRevert(tx,ctx,p.id,p.scopeIds,false);await stamp(tx,ctx,r.id,'revert-refused',{reason:e instanceof IndividualImportError?e.message:'payrollControls'});}).catch(()=>{});
}
/**
 * 0ec0ee00 — a refused or failed revert step hands the batch back: completed when nothing was removed from a finished
 * import, otherwise stopped with the rows still written. Returns the attempt's state afterwards.
 */
export async function handBackIndividualImportRevert(ctx:SessionContext,p:{id:string;scopeIds:string[]},e:unknown):Promise<IndividualImportAttemptState>{
 return withTenant(ctx,async tx=>{
  const r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
  if(r.state!=='reverting')return r.state;
  const back=r.revertedCount===0&&(r.inline||r.processed===r.total)?'completed':'stopped';
  await tx.update(attempt).set({state:back}).where(eq(attempt.id,r.id));
  await stamp(tx,ctx,r.id,'revert-refused',{reason:e instanceof IndividualImportError?e.message:'payrollControls',reverted:r.revertedCount});
  return back;
 });
}
/**
 * 0ec0ee00 — one revert step: the next INDIVIDUAL_IMPORT_STEP_ROWS imported rows, in one short transaction that owns
 * only their payroll periods, runs and rows. Each is re-proved unchanged under those locks and removed set-based.
 * The attempt is reverted only by the step that removes the last written row.
 */
export async function revertIndividualImportStep(ctx:SessionContext,p:{id:string;scopeIds:string[]}):Promise<IndividualImportProgress>{
 const nominee=await withTenant(ctx,async tx=>{
  const r=await readRevert(tx,ctx,p.id,p.scopeIds,false);
  if(r.state!=='reverting')return {r,selections:[]};
  const slice=await importedAfter(tx,r,r.revertCursor,INDIVIDUAL_IMPORT_STEP_ROWS);
  const ids=slice.map(row=>row.transactionId);
  // Own every payroll period these rows (and their runs) are filed under, as deleting one row by hand does.
  const periods=ids.length?await tx.execute<{companyId:string|null;payPeriod:string|null}>(sql`
   select t.company_id as "companyId",t.pay_period as "payPeriod" from payroll_individual_txn t where t.id=any(${uuidArray(ids)}::uuid[])
   union select b.company_id,b.pay_period from payroll_individual_txn t join payroll_batch b on b.id=t.batch_id where t.id=any(${uuidArray(ids)}::uuid[])`):[];
  const fromSnapshots=slice.flatMap(row=>typeof row.snapshot?.companyId==='string'&&typeof row.snapshot?.payPeriod==='string'?[{companyId:row.snapshot.companyId,payPeriod:row.snapshot.payPeriod}]:[]);
  return {r,selections:[...[...periods].flatMap(x=>x.companyId&&x.payPeriod?[{companyId:x.companyId,payPeriod:x.payPeriod}]:[]),...fromSnapshots]};
 });
 if(nominee.r.state!=='reverting')return progressOf(nominee.r);
 return withTenant(ctx,async tx=>{
  if(nominee.selections.length)await lockNativePayrollPeriodsTx(tx,ctx,nominee.selections);
  const r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
  if(r.state!=='reverting'||r.revertCursor!==nominee.r.revertCursor)return progressOf(r);
  const slice=await importedAfter(tx,r,r.revertCursor,INDIVIDUAL_IMPORT_STEP_ROWS);
  if(!slice.length&&r.revertedCount<r.written)throw new IndividualImportError('importRowsChanged');
  const rows=await verifyRevertable(tx,ctx,p.scopeIds,slice,r.confirmProcessed,true);
  await deleteImportedIndividualTxnsTx(tx,ctx,rows);
  const revertedCount=r.revertedCount+rows.length,revertCursor=slice.at(-1)?.rowNum??r.revertCursor;
  if(revertedCount>=r.written){
   await tx.update(attempt).set({state:'reverted',revertedCount,revertCursor,revertedAt:new Date(),revertedBy:ctx.userId!}).where(eq(attempt.id,r.id));
   await stamp(tx,ctx,r.id,'reverted',{count:r.written});
   return progressOf({...r,state:'reverted',revertedCount});
  }
  await tx.update(attempt).set({revertedCount,revertCursor}).where(eq(attempt.id,r.id));
  return progressOf({...r,revertedCount});
 });
}
async function revertSteps(ctx:SessionContext,p:{id:string;scopeIds:string[]}){
 let idle=0,last=-1;
 for(;;){
  const step=await revertIndividualImportStep(ctx,p);
  if(step.state!=='reverting')return step;
  idle=step.revertedCount===last?idle+1:0;last=step.revertedCount;
  if(idle>3)throw new IndividualImportError('revertFailed');
 }
}
/** Whole-batch reversal in this call: refuses any changed row before removing anything; original outcomes remain immutable. */
export async function revertIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[];confirmProcessed:boolean}):Promise<IndividualImportAttempt>{
 try{await withTenant(ctx,tx=>beginRevertTx(tx,ctx,p,false));}catch(e){await recordRefusal(ctx,p,e);throw e;}
 try{await revertSteps(ctx,p);}catch(e){await handBackIndividualImportRevert(ctx,p,e).catch(()=>{});throw e;}
 return withTenant(ctx,async tx=>{const r=await owned(tx,ctx,p.id,p.scopeIds);return project(r,await outcomesOf(tx,r));});
}
/**
 * 0ec0ee00 — the Import Log's Revert. The refusals are decided now, in the request; a batch uploaded through the
 * background queue is then reverted by the worker in steps under this administrator's session, so a 10,000-row
 * revert never runs in a page request. An attempt with no queue entry (validated before the queue) reverts here.
 */
export async function requestIndividualImportRevert(ctx:SessionContext,p:{id:string;scopeIds:string[];confirmProcessed:boolean}):Promise<{state:IndividualImportAttemptState;queued:boolean}>{
 let queued=false,state:IndividualImportAttemptState;
 try{
  state=await withTenant(ctx,async tx=>{
   const [job]=await tx.execute<{id:string;state:string}>(sql`select id,state from payroll_individual_import_job where attempt_id=${p.id}::uuid limit 1`);
   const begun=await beginRevertTx(tx,ctx,p,!!job&&job.state!=='reverting');
   if(job&&begun==='reverting'){
    const context=JSON.stringify({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,grants:ctx.grants,roles:ctx.roles});
    const [flag]=await tx.execute<{ok:boolean}>(sql`select app.payroll_individual_import_request_revert(${job.id}::uuid,${context}::jsonb) as ok`);
    queued=flag?.ok===true||job.state==='reverting';
   }
   return begun;
  });
 }catch(e){await recordRefusal(ctx,p,e);throw e;}
 if(state==='reverting'&&!queued){
  try{state=(await revertSteps(ctx,p)).state;}catch(e){await handBackIndividualImportRevert(ctx,p,e).catch(()=>{});throw e;}
 }
 return {state,queued};
}
