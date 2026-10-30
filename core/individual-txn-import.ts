import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,asc,desc,eq,inArray,lt,or,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {domainEvent,payComponent,payrollBatch,payrollIndividualTxn,payrollTxnImportAttempt as attempt,type PayrollTxnImportBinding} from '../db/schema';
import {adminCompaniesTx} from './read';
import {isAdmin} from '../lib/authz-model';
import {analyzeTxnImport,txnImportReason} from './payroll-txn-import';
import {createIndividualTxnsBulkTx,deleteIndividualTxnTx,loadWritableBatch,lockNativePayrollPeriodsTx,deriveIndividualTxnAmountTx,payRuleAllowsDayByDay,payRuleDerivesAmount,payRuleInputUnit,type PayRule} from '../packs/payroll/service';
import {parseIndividualImport} from '../lib/individual-txn-import-contract';
import type {IndividualImportMethod,TxnImportPreview} from '../lib/payroll-txn-import-schema';
import type {IndividualImportAttempt,IndividualImportOutcome} from '../lib/individual-txn-import-model';

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
type IndividualAnalysis=Extract<Awaited<ReturnType<typeof analyzeTxnImport>>,{kind:'individual'}>;
type ResolvedRow=IndividualAnalysis['resolved'] extends Map<number,infer Row>?Row:never;
function canonicalBinding(r:ResolvedRow):PayrollTxnImportBinding{return {
 employmentId:r.employmentId,companyId:r.companyId,departmentId:r.departmentId,componentId:r.componentId,
 intendedCycleId:r.intendedCycleId??null,targetBatchId:r.targetBatchId,targetCycle:r.targetCycle,payPeriod:r.payPeriod,
 txnDate:r.txnDate,kind:r.kind,quantity:r.quantity,unit:r.unit,sourceRef:r.sourceRef,notes:r.notes,
};}
async function eventIds(tx:Tx,id:string){return (await tx.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,id),eq(domainEvent.aggregateType,'payroll-individual-txn'))).orderBy(asc(domainEvent.id))).map(e=>e.id);}
function project(r:typeof attempt.$inferSelect):IndividualImportAttempt{return {id:r.id,sourceName:r.sourceName,method:r.method,createdBy:r.createdBy,createdAt:r.createdAt.toISOString(),state:r.state,records:r.records,preview:safePreview(r.preview),outcomes:r.outcomes,written:r.written,recalcBatchIds:r.recalcBatchIds,revertedAt:r.revertedAt?.toISOString()??null,revertedBy:r.revertedBy};}
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
export async function validateIndividualImport(ctx:SessionContext,p:{operationId:string;sourceName:string;csv:string;method:IndividualImportMethod;scopeIds:string[]}):Promise<IndividualImportAttempt>{
 uuid.parse(p.operationId);if(p.method!=='monthly'&&p.method!=='daily')throw new IndividualImportError('templateMismatch');
 if(typeof p.csv!=='string'||new TextEncoder().encode(p.csv).byteLength>900000)throw new IndividualImportError('fileTooLarge');
 const ids=await scope(ctx,p.scopeIds);
 const name=p.sourceName.trim();if(!name.toLowerCase().endsWith('.xlsx')||name.length>255)throw new IndividualImportError('invalidFormat');
 let records:Record<string,string>[]=[],fileError:string|undefined;
 try{records=parseIndividualImport(p.csv,p.method);}catch(e){fileError=e instanceof Error?e.message:'templateMismatch';}
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
  const [r]=await tx.insert(attempt).values({tenantId:ctx.tenantId,operationId:p.operationId,createdBy:ctx.userId!,companyIds:ids,sourceName:name,sourceHash,method:p.method,records,bindings,preview:sanitized}).returning();
  await stamp(tx,ctx,r.id,'validated',{total:preview.total,valid:preview.valid,invalid:preview.invalid});return project(r);
 });
}
/** Confirmation revalidates and commits each successful row and its ownership atomically. */
export async function confirmIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[]}):Promise<IndividualImportAttempt>{
 const initial=await withTenant(ctx,tx=>owned(tx,ctx,p.id,p.scopeIds));
 if(initial.state!=='validated')return project(initial);
 if(initial.preview.fileError)throw new IndividualImportError(initial.preview.fileError);
 const nominee=await analyzeTxnImport(ctx,{kind:'individual',scopeIds:p.scopeIds,records:initial.records});
 if(nominee.kind!=='individual')throw new IndividualImportError('templateMismatch');
 return withTenant(ctx,async tx=>{
  await lockNativePayrollPeriodsTx(tx,ctx,[...Object.values(initial.bindings),...nominee.resolved.values()].map(r=>({companyId:r.companyId,payPeriod:r.payPeriod})));
  const r=await owned(tx,ctx,p.id,p.scopeIds,true);if(r.state!=='validated')return project(r);
  // The bounded owner helper locks only this authorized attempt's immutable canonical identities.
  // Employment intentionally has no runtime UPDATE grant, so ordinary SELECT FOR SHARE is unavailable.
  try{await tx.execute(sql`select app.payroll_txn_import_lock_bindings(${r.id}::uuid)`);}catch{throw new IndividualImportError('previewChanged');}
  const analysis=await analyzeTxnImport(ctx,{kind:'individual',scopeIds:p.scopeIds,records:r.records});if(analysis.kind!=='individual')throw new IndividualImportError('templateMismatch');
  analysis.preview=safePreview(analysis.preview);
  const outcomes:IndividualImportOutcome[]=[],recalc=new Set<string>();
  for(const row of analysis.preview.rows){
   const resolved=analysis.resolved.get(row.rowNum);
   const originally=r.preview.rows.find(old=>old.rowNum===row.rowNum);
   const originalBinding=r.bindings[String(row.rowNum)];
   // An unbound legacy attempt or a changed lookup must never acquire a new payee/target on confirmation.
   if(originally?.ok&&(!resolved||!originalBinding||!isDeepStrictEqual(originalBinding,canonicalBinding(resolved))||originally.amount!==row.amount)){
    outcomes.push({row:{...row,ok:false,reason:'previewChanged'},state:'failed'});continue;
   }
   if(!row.ok||!resolved){outcomes.push({row,state:'invalid'});continue;}
   if(!originally?.ok){outcomes.push({row:{...row,ok:false,reason:'previewChanged'},state:'failed'});continue;}
   try{
    const result=await tx.transaction(async savepoint=>{
     if(resolved.targetBatchId)await savepoint.select({id:payrollBatch.id}).from(payrollBatch).where(eq(payrollBatch.id,resolved.targetBatchId)).for('update');
     const [item]=await savepoint.select({rule:payComponent.rule}).from(payComponent).where(eq(payComponent.id,resolved.componentId)).for('share');
     if(!item)throw new IndividualImportError('previewChanged');
     const rule=item.rule as PayRule|null;
     if(r.method==='daily'&&(!payRuleAllowsDayByDay(rule)||!payRuleDerivesAmount(rule)||payRuleInputUnit(rule)==null))throw new IndividualImportError('previewChanged');
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
    if(resolved.targetBatchId){const [batch]=await tx.select({status:payrollBatch.status}).from(payrollBatch).where(eq(payrollBatch.id,resolved.targetBatchId));if(batch?.status==='processed')recalc.add(resolved.targetBatchId);}
   }catch(e){const failure:{reason:string;detail?:Record<string,string|number>}=e instanceof IndividualImportError?{reason:e.message}:txnImportReason(e);if(failure.reason==='unexpected')delete failure.detail;outcomes.push({row:{...row,ok:false,...failure},state:'failed'});}
  }
  const written=outcomes.filter(o=>o.state==='imported').length;
  const [saved]=await tx.update(attempt).set({state:'completed',preview:analysis.preview,outcomes,written,recalcBatchIds:[...recalc]}).where(eq(attempt.id,r.id)).returning();
  await stamp(tx,ctx,r.id,'confirmed',{written,failed:outcomes.filter(o=>o.state==='failed').length});return project(saved);
 });
}
export async function listIndividualImports(ctx:SessionContext,scopeIds:string[],before?:{at:string;id:string}):Promise<IndividualImportAttempt[]>{
 await scope(ctx,scopeIds);if(before){z.iso.datetime().parse(before.at);uuid.parse(before.id);}
 return withTenant(ctx,async tx=>{
  const rows=await tx.select().from(attempt).where(and(eq(attempt.tenantId,ctx.tenantId),sql`${attempt.companyIds} <@ ${JSON.stringify(scopeIds)}::jsonb`,before?or(lt(attempt.createdAt,new Date(before.at)),and(eq(attempt.createdAt,new Date(before.at)),lt(attempt.id,before.id))):undefined)).orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(101);
  return rows.filter(r=>r.companyIds.every(c=>scopeIds.includes(c))).map(project);
 });
}
export async function readIndividualImport(ctx:SessionContext,id:string,scopeIds:string[]):Promise<IndividualImportAttempt>{return withTenant(ctx,async tx=>{
 const item=project(await owned(tx,ctx,id,scopeIds));const events=await tx.select({type:domainEvent.eventType,at:domainEvent.occurredAt,actorId:domainEvent.actorId,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.aggregateId,id),eq(domainEvent.aggregateType,'payroll-txn-import'))).orderBy(asc(domainEvent.occurredAt),asc(domainEvent.id));
 return {...item,events:events.map(event=>({type:event.type.slice('payroll.txn-import.'.length),at:event.at.toISOString(),actorId:event.actorId,...(typeof (event.payload as {reason?:unknown})?.reason==='string'?{reason:(event.payload as {reason:string}).reason}:{})}))};
 });}
/** Whole-batch reversal refuses any changed row; original outcomes remain immutable. */
export async function revertIndividualImport(ctx:SessionContext,p:{id:string;scopeIds:string[];confirmProcessed:boolean}):Promise<IndividualImportAttempt>{
 const initial=await withTenant(ctx,tx=>owned(tx,ctx,p.id,p.scopeIds));
 try{return await withTenant(ctx,async tx=>{
  const selections=initial.outcomes.flatMap(o=>o.state==='imported'&&typeof o.snapshot?.companyId==='string'&&typeof o.snapshot?.payPeriod==='string'?[{companyId:o.snapshot.companyId,payPeriod:o.snapshot.payPeriod}]:[]);
  await lockNativePayrollPeriodsTx(tx,ctx,selections);
  const r=await owned(tx,ctx,p.id,p.scopeIds,true);if(r.state==='reverted')return project(r);
  if(r.state!=='completed'||!r.written)throw new IndividualImportError('revertUnavailable');
  const imported=r.outcomes.filter(o=>o.state==='imported');
  const ids=imported.map(o=>o.transactionId!);
  const seen=await tx.select().from(payrollIndividualTxn).where(inArray(payrollIndividualTxn.id,ids));
  const batchIds=[...new Set(seen.map(row=>row.batchId).filter((v):v is string=>!!v))].sort();
  // Lock all batch statuses before inspecting/removing any row. Payroll processing uses these same locks.
  if(batchIds.length)await tx.select({id:payrollBatch.id}).from(payrollBatch).where(inArray(payrollBatch.id,batchIds)).orderBy(asc(payrollBatch.id)).for('update');
  const rows=await tx.select().from(payrollIndividualTxn).where(inArray(payrollIndividualTxn.id,ids)).orderBy(asc(payrollIndividualTxn.id)).for('update');
  if(rows.length!==ids.length||rows.some(row=>row.batchId&&!batchIds.includes(row.batchId)))throw new IndividualImportError('importRowsChanged');
  for(const row of rows){
   const original=imported.find(o=>o.transactionId===row.id)!;
   if(!row.companyId||!p.scopeIds.includes(row.companyId)||!isDeepStrictEqual(snapshot(row),original.snapshot)||!isDeepStrictEqual(await eventIds(tx,row.id),original.eventIds))throw new IndividualImportError('importRowsChanged');
   if(row.batchId){const b=await loadWritableBatch(tx,row.batchId);if(b.status==='processed'&&!p.confirmProcessed)throw new IndividualImportError('confirmProcessedRevert');}
  }
  for(const row of rows)await deleteIndividualTxnTx(tx,ctx,{id:row.id});
  const [saved]=await tx.update(attempt).set({state:'reverted',revertedAt:new Date(),revertedBy:ctx.userId!}).where(eq(attempt.id,r.id)).returning();
  await stamp(tx,ctx,r.id,'reverted',{count:rows.length});return project(saved);
 });}catch(e){
  // Log a refused reversal separately after rollback, without publishing protected row details.
  await withTenant(ctx,async tx=>{const r=await owned(tx,ctx,p.id,p.scopeIds);await stamp(tx,ctx,r.id,'revert-refused',{reason:e instanceof IndividualImportError?e.message:'payrollControls'});}).catch(()=>{});
  throw e;
 }
}
