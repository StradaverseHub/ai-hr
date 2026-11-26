import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,asc,desc,eq,inArray,lt,or,sql} from 'drizzle-orm';
import {INDIVIDUAL_IMPORT_MAX_CSV_BYTES,INDIVIDUAL_IMPORT_PAGE_ROWS,INDIVIDUAL_IMPORT_STEP_CEILING_MS,INDIVIDUAL_IMPORT_STEP_ROWS,INDIVIDUAL_IMPORT_STEP_TARGET_MS,INDIVIDUAL_IMPORT_TICK_MS} from '../lib/individual-import-job';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {domainEvent,payComponent,payrollBatch,payrollIndividualTxn,payrollTxnImportAttempt as attempt,payrollTxnImportOutcome as outcomeTable,type PayrollTxnImportBinding} from '../db/schema';
import {adminCompaniesTx} from './read';
import {isAdmin} from '../lib/authz-model';
import {analyzeTxnImport,txnImportReason} from './payroll-txn-import';
import {BatchNotDraftError,WRITABLE_BATCH_STATUSES,createIndividualTxnsBulkTx,deleteImportedIndividualTxnsTx,lockNativePayrollPeriodsTx,deriveIndividualTxnAmountTx,priceIndividualTxnInputTx,resolveDailyImportInput,type PayRule,type WritableBatchStatus} from '../packs/payroll/service';
import {lockPayComponentCatalogReadTx} from './pay-component-catalog-lock';
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
 // 7b5b1665 — a One Total for the Month row written with its Input Type records that method in its receipt, so it
 // reverses only while the saved method is still the one written (an edit from Amount to Qty refuses reversal).
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
 // 7b5b1665 — the approved Input Type is part of what the reviewer saw; a change to it refuses as previewChanged.
 ...(r.calculationMethod ? {calculationMethod:r.calculationMethod} : {}),
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
 fileError:string|null;rows:TxnImportRow[];bindings:Record<string,PayrollTxnImportBinding>};
const progressOf=(r:{state:IndividualImportAttemptState;total:number;processed:number;written:number;revertedCount?:number}):IndividualImportProgress=>
 ({state:r.state,total:r.total,processed:r.processed,written:r.written,revertedCount:r.revertedCount??0});
/**
 * While an import is being written its progress is the outcome table itself (rows recorded, rows imported), so a
 * write transaction appends outcomes without rewriting the attempt row (whose 10 MB of source the immutability
 * trigger would compare on every update). The attempt's own columns are set once, when it completes or stops.
 * `slice` also returns the next INDIVIDUAL_IMPORT_STEP_ROWS preview rows and their stored bindings, sliced in SQL.
 */
async function readStep(tx:Tx,ctx:SessionContext,id:string,scopeIds:string[],lock:boolean,slice=true):Promise<StepState>{
 uuid.parse(id);await scope(ctx,scopeIds,tx);
 const [r]=await tx.execute<{id:string;state:IndividualImportAttemptState;method:IndividualImportMethod;company_ids:string[];total:number;processed:number;written:number;file_error:string|null;rows:TxnImportRow[]|null;bindings:Record<string,PayrollTxnImportBinding>|null}>(sql`
  select a.id,a.state,a.method,a.company_ids,coalesce(a.total_rows,jsonb_array_length(a.preview->'rows'))::int as total,p.processed,p.written,
   case when a.total_rows is null or a.total_rows=0 then a.preview->>'fileError' end as file_error,
   case when ${slice} and a.state in ('validated','importing') then (select coalesce(jsonb_agg(e order by i),'[]'::jsonb) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i)
    where i>p.processed and i<=p.processed+${INDIVIDUAL_IMPORT_STEP_ROWS}) end as rows,
   case when ${slice} and a.state in ('validated','importing') then (select coalesce(jsonb_object_agg(b.key,b.value),'{}'::jsonb) from jsonb_each(a.bindings) b
    where (case when b.key ~ '^[0-9]{1,6}$' then b.key::int end) between p.processed+2 and p.processed+1+${INDIVIDUAL_IMPORT_STEP_ROWS}) end as bindings
  from payroll_txn_import_attempt a
  cross join lateral (select case when a.state in ('validated','importing') then (select count(*)::int from payroll_txn_import_outcome o where o.attempt_id=a.id) else a.processed end as processed,
   case when a.state in ('validated','importing') then (select count(*)::int from payroll_txn_import_outcome o where o.attempt_id=a.id and o.state='imported') else a.written end as written) p
  where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid ${lock?sql`for update of a`:sql``}`);
 if(!r||r.company_ids.some(c=>!scopeIds.includes(c)))deny();
 return {id:r.id,state:r.state,method:r.method,companyIds:r.company_ids,total:r.total,processed:r.processed,written:r.written,
  fileError:r.file_error,rows:r.rows??[],bindings:r.bindings??{}};
}
/** A write transaction ran past the hard ceiling: it is rolled back and retried with fewer rows. */
class StepOverrun extends Error {}
/**
 * Writes `part` (consecutive preview rows) in the caller's transaction and returns one outcome per row, in order.
 * Rows of the same payee, run and cycle are written by one createIndividualTxnsBulkTx call (its own checks, one
 * insert and one event per row); a group the writer refuses is retried row by row, so each row keeps its own outcome.
 */
async function writeRows(tx:Tx,ctx:SessionContext,method:IndividualImportMethod,part:TxnImportRow[],bindings:Record<string,PayrollTxnImportBinding>,
 fresh:Map<number,TxnImportRow>,resolvedRows:Map<number,ResolvedRow>,ceilingAt:number):Promise<IndividualImportOutcome[]>{
 const outcomes=new Map<number,IndividualImportOutcome>();
 const candidates:{row:TxnImportRow;resolved:ResolvedRow}[]=[];
 for(const original of part){
  // A row the reviewer saw refused is never written; it keeps the verdict the reviewer saw.
  if(!original.ok){outcomes.set(original.rowNum,{row:original,state:'invalid'});continue;}
  const row=fresh.get(original.rowNum)??original,resolved=resolvedRows.get(original.rowNum),binding=bindings[String(original.rowNum)];
  // An unbound legacy attempt or a changed lookup must never acquire a new payee/target on confirmation.
  if(!resolved||!row.ok||!binding||!isDeepStrictEqual(binding,canonicalBinding(resolved))||original.amount!==row.amount){
   outcomes.set(original.rowNum,{row:{...row,ok:false,reason:'previewChanged'},state:'failed'});continue;
  }
  candidates.push({row,resolved});
 }
 const fail=(row:TxnImportRow,e:unknown)=>{const failure:{reason:string;detail?:Record<string,string|number>}=e instanceof IndividualImportError?{reason:e.message}:txnImportReason(e);if(failure.reason==='unexpected')delete failure.detail;outcomes.set(row.rowNum,{row:{...row,ok:false,...failure},state:'failed'});};
 if(candidates.length){
  const runs=[...new Set(candidates.map(c=>c.resolved.targetBatchId).filter((v):v is string=>!!v))].sort();
  if(runs.length)await tx.select({id:payrollBatch.id}).from(payrollBatch).where(inArray(payrollBatch.id,runs)).orderBy(asc(payrollBatch.id)).for('update');
  const items=new Map((await tx.select({id:payComponent.id,rule:payComponent.rule}).from(payComponent)
   .where(inArray(payComponent.id,[...new Set(candidates.map(c=>c.resolved.componentId))])).orderBy(asc(payComponent.id)).for('share')).map(item=>[item.id,item.rule as PayRule|null]));
  const ready:typeof candidates=[];
  for(const c of candidates){
   const {resolved,row}=c;
   try{
    if(!items.has(resolved.componentId))throw new IndividualImportError('previewChanged');
    const rule=items.get(resolved.componentId)??null;
    if(method==='daily'){
     const daily=resolveDailyImportInput(rule,resolved.explicitDailyInput);
     if('reason' in daily||daily.unit!==resolved.unit||resolved.explicitDailyRuleHash&&resolved.explicitDailyRuleHash!==digest(JSON.stringify(rule??null)))throw new IndividualImportError('previewChanged');
    }
    // 7b5b1665 — a One Total for the Month row with an Input Type: Amount still needs a formula Pay Item, and Qty,
    // Hours, Days or Units must still price, with the entry pricing owner, to the previewed amount.
    if(resolved.calculationMethod==='amount'){
     if(rule?.kind!=='formula'&&rule?.kind!=='formula_builder')throw new IndividualImportError('previewChanged');
    }else if(resolved.calculationMethod==='formula'){
     if(rule?.kind!=='formula_builder')throw new IndividualImportError('previewChanged');
     const priced=await tx.transaction(savepoint=>priceIndividualTxnInputTx(savepoint,ctx,{componentId:resolved.componentId,employmentId:resolved.employmentId,companyId:resolved.companyId,payPeriod:resolved.payPeriod,txnDate:resolved.txnDate,
      quantity:resolved.quantity,unit:resolved.unit,amount:0,method:'formula',cycleId:resolved.intendedCycleId??null,batchId:resolved.targetBatchId}));
     if(priced.amount.toFixed(2)!==row.amount)throw new IndividualImportError('previewChanged');
    }
    // A typed-amount item has nothing to re-price; a calculating item must still price to the previewed amount.
    else if(rule!=null){
     const priced=await tx.transaction(savepoint=>deriveIndividualTxnAmountTx(savepoint,ctx,{componentId:resolved.componentId,employmentId:resolved.employmentId,companyId:resolved.companyId,payPeriod:resolved.payPeriod,quantity:resolved.quantity,unit:resolved.unit,effectiveDate:resolved.txnDate}));
     if(priced.derived&&priced.amount.toFixed(2)!==row.amount)throw new IndividualImportError('previewChanged');
    }
    ready.push(c);
   }catch(e){fail(row,e);}
  }
  const groups=new Map<string,typeof ready>();
  for(const c of ready){const r=c.resolved,key=[r.targetBatchId??'',r.companyId,r.payPeriod,r.employmentId,r.intendedCycleId??''].join('|');groups.set(key,[...(groups.get(key)??[]),c]);}
  const written:{row:TxnImportRow;id:string;batchId:string|null}[]=[];
  const write=(target:typeof ready)=>tx.transaction(savepoint=>{const r=target[0].resolved;return createIndividualTxnsBulkTx(savepoint,ctx,{
   ...(r.targetBatchId?{batchId:r.targetBatchId}:{companyId:r.companyId,payPeriod:r.payPeriod}),employmentIds:[r.employmentId],intendedCycleId:r.intendedCycleId,
   rows:target.map(({resolved:x})=>({kind:x.kind,componentId:x.componentId,txnDate:x.txnDate,amount:x.amount,quantity:x.quantity,unit:x.unit,notes:x.notes,source:'import',sourceRef:x.sourceRef,
    ...(x.calculationMethod?{calculationMethod:x.calculationMethod}:{})})),
  });});
  for(const group of groups.values()){
   if(Date.now()>ceilingAt&&part.length>1)throw new StepOverrun();
   try{const result=await write(group);if(result.ids.length!==group.length)throw new IndividualImportError('importFailed');group.forEach((c,i)=>written.push({row:c.row,id:result.ids[i],batchId:c.resolved.targetBatchId}));}
   catch{
    for(const c of group){
     try{const result=await write([c]);written.push({row:c.row,id:result.ids[0],batchId:c.resolved.targetBatchId});}catch(e){fail(c.row,e);}
    }
   }
  }
  if(written.length){
   const ids=written.map(w=>w.id);
   const created=new Map((await tx.select().from(payrollIndividualTxn).where(inArray(payrollIndividualTxn.id,ids))).map(row=>[row.id,row]));
   const events=await eventIdsByRow(tx,ctx,ids);
   const runs=[...new Set(written.map(w=>w.batchId).filter((v):v is string=>!!v))];
   const processedRuns=new Set(runs.length?(await tx.select({id:payrollBatch.id}).from(payrollBatch).where(and(inArray(payrollBatch.id,runs),eq(payrollBatch.status,'processed')))).map(x=>x.id):[]);
   for(const w of written){
    const row=created.get(w.id);
    if(!row){fail(w.row,new IndividualImportError('importFailed'));continue;}
    // A processed run this row reached will need recalculation; kept with the row, so a stopped import still names it.
    outcomes.set(w.row.rowNum,{row:w.row,state:'imported',transactionId:row.id,snapshot:snapshot(row),eventIds:events.get(row.id)??[],...(w.batchId&&processedRuns.has(w.batchId)?{recalcBatchId:w.batchId}:{})});
   }
  }
 }
 return part.map(row=>outcomes.get(row.rowNum)!);
}
/** Counts and processed runs recorded so far, for the attempt's own columns when it completes or stops. */
async function finalCounts(tx:Tx,id:string,recalcBefore:string[]){
 const [c]=await tx.execute<{processed:number;written:number;failed:number;recalc:string[]}>(sql`select count(*)::int as processed,count(*) filter (where state='imported')::int as written,
  count(*) filter (where state='failed')::int as failed,coalesce(jsonb_agg(distinct outcome->>'recalcBatchId') filter (where outcome ? 'recalcBatchId'),'[]'::jsonb) as recalc
  from payroll_txn_import_outcome where attempt_id=${id}::uuid`);
 return {...c,recalc:[...recalcBefore,...c.recalc.filter(id=>!recalcBefore.includes(id)).sort()]};
}

/**
 * 0ec0ee00 — one tick of confirmation. The next INDIVIDUAL_IMPORT_STEP_ROWS rows are re-checked against a fresh
 * analysis of the whole stored file focused on them (same digest/sourceRef, row numbers and run targeting the reviewer
 * approved), then written by short transactions, each owning only its rows' payroll periods and step-scoped bindings.
 * Each transaction is time-budgeted: rows are added until about INDIVIDUAL_IMPORT_STEP_TARGET_MS of work, and one
 * that passes INDIVIDUAL_IMPORT_STEP_CEILING_MS is rolled back and retried with fewer rows, so payroll processing and
 * other writers of those periods never wait long. Outcomes are appended in the same transaction as the rows, so a
 * resumed worker continues after the last committed transaction. The attempt completes with its last row.
 */
export async function confirmIndividualImportStep(ctx:SessionContext,p:{id:string;scopeIds:string[]},options:{tickMs?:number;timings?:number[]}={}):Promise<IndividualImportProgress>{
 const nominee=await withTenant(ctx,tx=>readStep(tx,ctx,p.id,p.scopeIds,false));
 if(nominee.state!=='validated'&&nominee.state!=='importing')return progressOf(nominee);
 if(nominee.fileError)throw new IndividualImportError(nominee.fileError);
 const writable=nominee.rows.filter(row=>row.ok).map(row=>row.rowNum);
 let analysis:IndividualAnalysis|null=null;
 if(writable.length){
  const [{records}]=await withTenant(ctx,tx=>tx.select({records:attempt.records}).from(attempt).where(eq(attempt.id,nominee.id)));
  const fresh=await analyzeTxnImport(ctx,{kind:'individual',scopeIds:p.scopeIds,records,focus:new Set(writable)});
  if(fresh.kind!=='individual')throw new IndividualImportError('templateMismatch');
  analysis=fresh;
 }
 const freshRows=new Map((analysis?safePreview(analysis.preview).rows:[]).map(row=>[row.rowNum,row]));
 const resolvedRows=analysis?.resolved??new Map<number,ResolvedRow>();
 const tickEnds=Date.now()+(options.tickMs??INDIVIDUAL_IMPORT_TICK_MS);
 let offset=0,size=Math.min(32,INDIVIDUAL_IMPORT_STEP_ROWS),last:IndividualImportProgress=progressOf(nominee);
 while(offset<nominee.rows.length){
  const part=nominee.rows.slice(offset,offset+size);
  const selections=part.filter(row=>row.ok).flatMap(row=>{const b=nominee.bindings[String(row.rowNum)];return b?[{companyId:b.companyId,payPeriod:b.payPeriod}]:[];});
  const started=Date.now();
  let result:{progress:IndividualImportProgress;moved:boolean};
  try{
   result=await withTenant(ctx,async tx=>{
    // 7b5b1665 — rows with an Input Type are priced and written under the shared catalogue lock. Take it BEFORE the
    // payroll period, in generation's catalogue → period order, never as an upgrade after owning the period.
    if(part.some(row=>row.ok&&nominee.bindings[String(row.rowNum)]?.calculationMethod))await lockPayComponentCatalogReadTx(tx,ctx);
    if(selections.length)await lockNativePayrollPeriodsTx(tx,ctx,selections);
    const r=await readStep(tx,ctx,p.id,p.scopeIds,true,false);
    // Another runner moved this attempt meanwhile: report where it is; the caller reads again.
    if((r.state!=='validated'&&r.state!=='importing')||r.processed!==nominee.processed+offset)return {progress:progressOf(r),moved:true};
    const lockable=part.filter(row=>row.ok&&nominee.bindings[String(row.rowNum)]).map(row=>row.rowNum);
    // The bounded owner helper locks only these rows' immutable canonical identities.
    // Employment intentionally has no runtime UPDATE grant, so ordinary SELECT FOR SHARE is unavailable.
    if(lockable.length){try{await tx.execute(sql`select app.payroll_txn_import_lock_step_bindings(${r.id}::uuid,${intArray(lockable)}::int[])`);}catch{throw new IndividualImportError('previewChanged');}}
    const outcomes=await writeRows(tx,ctx,r.method,part,nominee.bindings,freshRows,resolvedRows,started+INDIVIDUAL_IMPORT_STEP_CEILING_MS);
    await tx.insert(outcomeTable).values(outcomes.map(o=>({attemptId:r.id,rowNum:o.row.rowNum,tenantId:ctx.tenantId,state:o.state,transactionId:o.transactionId??null,outcome:o})));
    const processed=r.processed+outcomes.length,written=r.written+outcomes.filter(o=>o.state==='imported').length;
    if(processed>=r.total){
     const [head]=await tx.select({recalc:attempt.recalcBatchIds}).from(attempt).where(eq(attempt.id,r.id));
     const counts=await finalCounts(tx,r.id,head.recalc);
     await tx.update(attempt).set({state:'completed',processed:counts.processed,written:counts.written,recalcBatchIds:counts.recalc}).where(eq(attempt.id,r.id));
     await stamp(tx,ctx,r.id,'confirmed',{written:counts.written,failed:counts.failed});
     return {progress:progressOf({state:'completed',total:r.total,processed:counts.processed,written:counts.written}),moved:false};
    }
    // The first transaction marks the attempt importing; later ones only append outcomes.
    if(r.state==='validated')await tx.update(attempt).set({state:'importing'}).where(eq(attempt.id,r.id));
    return {progress:progressOf({state:'importing',total:r.total,processed,written}),moved:false};
   });
  }catch(e){
   if(e instanceof StepOverrun&&size>1){size=Math.max(1,Math.floor(size/2));continue;}
   throw e;
  }
  const elapsed=Date.now()-started;
  options.timings?.push(elapsed);
  last=result.progress;
  if(result.moved||last.state!=='importing')return last;
  offset+=part.length;
  // Aim the next transaction at the target from this one's measured cost per row.
  size=Math.max(1,Math.min(INDIVIDUAL_IMPORT_STEP_ROWS,Math.floor(part.length*INDIVIDUAL_IMPORT_STEP_TARGET_MS/Math.max(elapsed,1))));
  if(Date.now()>tickEnds)break;
 }
 return last;
}

/**
 * 0ec0ee00 — a step kept failing: keep every row already written (they stay revertable) and say so. Returns the
 * attempt's state afterwards; an attempt that finished meanwhile is left as it is.
 */
export async function stopIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[];reason:string}):Promise<IndividualImportAttemptState>{
 return withTenant(ctx,async tx=>{
  const r=await readStep(tx,ctx,p.id,p.scopeIds,true,false);
  if(r.state!=='validated'&&r.state!=='importing')return r.state;
  const [head]=await tx.select({recalc:attempt.recalcBatchIds}).from(attempt).where(eq(attempt.id,r.id));
  const counts=await finalCounts(tx,r.id,head.recalc);
  await tx.update(attempt).set({state:'stopped',processed:counts.processed,written:counts.written,recalcBatchIds:counts.recalc}).where(eq(attempt.id,r.id));
  await stamp(tx,ctx,r.id,'stopped',{reason:p.reason,written:counts.written,processed:counts.processed});
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
    case when a.state='importing' then (select count(*)::int from payroll_txn_import_outcome o where o.attempt_id=a.id) else a.processed end as processed,
    case when a.state='importing' then (select count(*)::int from payroll_txn_import_outcome o where o.attempt_id=a.id and o.state='imported') else a.written end as written,
    a.reverted_count,a.reverted_at,a.reverted_by,
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
        select i,jsonb_build_array(i,e) from jsonb_array_elements(a.preview->'rows') with ordinality t(e,i) where (e->>'ok')::boolean is not true
         and not exists(select 1 from payroll_txn_import_outcome o where o.attempt_id=a.id and o.row_num=i+1)) x)
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
 * `jobState`: the batch's queue state. When the queue no longer reverts (or imports) it, a revert (or an import) left
 * half-done is handed back first; a revert or import still running there is joined, never interrupted.
 */
async function beginRevertTx(tx:Tx,ctx:SessionContext,p:{id:string;scopeIds:string[];confirmProcessed:boolean},jobState:string|null):Promise<IndividualImportAttemptState>{
 let r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
 if(r.state==='reverted')return r.state;
 if(r.state==='reverting'&&(jobState===null||jobState==='reverting'))return r.state;
 if(r.state==='reverting'){
  await tx.update(attempt).set({state:r.revertedCount===0&&(r.inline||r.processed===r.total)?'completed':'stopped'}).where(eq(attempt.id,r.id));
  r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
 }
 if(r.state==='importing'&&(jobState==='stopped'||jobState==='failed')){
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
 * 0ec0ee00 — one tick of a revert: the next imported rows, removed by short transactions that each own only their
 * rows' payroll periods, runs and rows, time-budgeted like confirmation (about INDIVIDUAL_IMPORT_STEP_TARGET_MS each,
 * rolled back and retried smaller past INDIVIDUAL_IMPORT_STEP_CEILING_MS). Each row is re-proved unchanged under
 * those locks and removed set-based. The attempt is reverted only by the transaction that removes the last row.
 */
export async function revertIndividualImportStep(ctx:SessionContext,p:{id:string;scopeIds:string[]},options:{tickMs?:number;timings?:number[]}={}):Promise<IndividualImportProgress>{
 const tickEnds=Date.now()+(options.tickMs??INDIVIDUAL_IMPORT_TICK_MS);
 let size=Math.min(64,INDIVIDUAL_IMPORT_STEP_ROWS);
 for(;;){
  const nominee=await withTenant(ctx,async tx=>{
   const r=await readRevert(tx,ctx,p.id,p.scopeIds,false);
   if(r.state!=='reverting')return {r,selections:[],count:0};
   const slice=await importedAfter(tx,r,r.revertCursor,size);
   const ids=slice.map(row=>row.transactionId);
   // Own every payroll period these rows (and their runs) are filed under, as deleting one row by hand does.
   const periods=ids.length?await tx.execute<{companyId:string|null;payPeriod:string|null}>(sql`
    select t.company_id as "companyId",t.pay_period as "payPeriod" from payroll_individual_txn t where t.id=any(${uuidArray(ids)}::uuid[])
    union select b.company_id,b.pay_period from payroll_individual_txn t join payroll_batch b on b.id=t.batch_id where t.id=any(${uuidArray(ids)}::uuid[])`):[];
   const fromSnapshots=slice.flatMap(row=>typeof row.snapshot?.companyId==='string'&&typeof row.snapshot?.payPeriod==='string'?[{companyId:row.snapshot.companyId,payPeriod:row.snapshot.payPeriod}]:[]);
   return {r,selections:[...[...periods].flatMap(x=>x.companyId&&x.payPeriod?[{companyId:x.companyId,payPeriod:x.payPeriod}]:[]),...fromSnapshots],count:slice.length};
  });
  if(nominee.r.state!=='reverting')return progressOf(nominee.r);
  const started=Date.now();
  let progress:IndividualImportProgress,moved=false;
  try{
   progress=await withTenant(ctx,async tx=>{
    if(nominee.selections.length)await lockNativePayrollPeriodsTx(tx,ctx,nominee.selections);
    const r=await readRevert(tx,ctx,p.id,p.scopeIds,true);
    if(r.state!=='reverting'||r.revertCursor!==nominee.r.revertCursor){moved=true;return progressOf(r);}
    const slice=await importedAfter(tx,r,r.revertCursor,nominee.count||size);
    if(!slice.length&&r.revertedCount<r.written)throw new IndividualImportError('importRowsChanged');
    const rows=await verifyRevertable(tx,ctx,p.scopeIds,slice,r.confirmProcessed,true);
    await deleteImportedIndividualTxnsTx(tx,ctx,rows);
    if(Date.now()-started>INDIVIDUAL_IMPORT_STEP_CEILING_MS&&slice.length>1)throw new StepOverrun();
    const revertedCount=r.revertedCount+rows.length,revertCursor=slice.at(-1)?.rowNum??r.revertCursor;
    if(revertedCount>=r.written){
     await tx.update(attempt).set({state:'reverted',revertedCount,revertCursor,revertedAt:new Date(),revertedBy:ctx.userId!}).where(eq(attempt.id,r.id));
     await stamp(tx,ctx,r.id,'reverted',{count:r.written});
     return progressOf({...r,state:'reverted',revertedCount});
    }
    await tx.update(attempt).set({revertedCount,revertCursor}).where(eq(attempt.id,r.id));
    return progressOf({...r,revertedCount});
   });
  }catch(e){
   if(e instanceof StepOverrun&&size>1){size=Math.max(1,Math.floor(nominee.count/2));continue;}
   throw e;
  }
  const elapsed=Date.now()-started;
  options.timings?.push(elapsed);
  if(moved||progress.state!=='reverting'||Date.now()>tickEnds)return progress;
  size=Math.max(1,Math.min(INDIVIDUAL_IMPORT_STEP_ROWS,Math.floor(nominee.count*INDIVIDUAL_IMPORT_STEP_TARGET_MS/Math.max(elapsed,1))));
 }
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
 try{await withTenant(ctx,tx=>beginRevertTx(tx,ctx,p,null));}catch(e){await recordRefusal(ctx,p,e);throw e;}
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
   const begun=await beginRevertTx(tx,ctx,p,job?.state??null);
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
