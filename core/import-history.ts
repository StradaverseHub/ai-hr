/**
 * Shared personnel import history and revert framework (ADR-0155, migration 0675).
 *
 * One append-only attempt per uploaded file (source bytes up to 10 MB + sha256), one item per unit the kind
 * writes (an employee's allocation, a created employment, a movement), and append-only events. Visibility,
 * per-item company scoping and the once-only confirm/revert rules are enforced by RLS and unique indexes;
 * this module adds the preview hash, locking, reason and audit discipline that every kind shares.
 *
 * A kind supplies an ImportRevertHandler: `inspect` lists per-item blockers and what will be restored, and
 * `apply` writes the compensation through that kind's own owner. The framework refuses the whole revert
 * when any item is blocked (all or nothing), checks the caller's preview hash, requires a reason, and
 * records exactly one `reverted` event.
 */
import {BANK_IMPORT_MAX_BYTES} from '../lib/bank-import-job';
import {createHash,randomUUID} from 'node:crypto';
import {and,asc,desc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,importAttempt as attempt,importAttemptItem as item,importAttemptEvent as historyEvent,employeeImportRun as run,person} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {isImportKind,isImportRunKind,isImportHistoryKind,importAttemptStatus,importAttemptTotals,IMPORT_RUN_KINDS,normalizeImportRevertReason,type ImportAttemptStatus,type ImportEventKind,type ImportHistoryKind,type ImportKind,type ImportPlanBase,type ImportRunKind} from '../lib/import-history';
import {importRunOutcome,type ImportRunError} from '../lib/import-schema';
import {actorOn,creatorOf,resolveImportActors,type ImportRowActors} from './import-actor-label';
import type {ImportActor} from '../lib/import-reference';

export class ImportHistoryError extends Error{
 constructor(message:string,readonly blockers:ImportRevertBlocker[]=[]){super(message);this.name='ImportHistoryError';}
}
function fail(message:string,blockers?:ImportRevertBlocker[]):never{throw new ImportHistoryError(message,blockers);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IMPORT_SOURCE_MAX_BYTES=10485760;
export const importSourceHash=(content:Buffer)=>createHash('sha256').update(content).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
export const importCanonicalHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export function importSourceName(raw:string,fallback:string){return((raw.split(/[\\/]/).pop()??'').trim().slice(0,255))||fallback;}
export function importMimeType(name:string){const n=name.toLowerCase();return n.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':n.endsWith('.xls')?'application/vnd.ms-excel':'text/csv';}
/** The preview hash covers everything in the plan except itself. */
export function sealImportPlan<T extends ImportPlanBase>(plan:T):T{const sealed={...plan,previewHash:''};sealed.previewHash=importCanonicalHash(sealed);return sealed;}

async function principalTx(tx:Tx,ctx:SessionContext){
 if(!ctx.userId)fail('Sign in again before importing.');
 const[row]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);
 if(!row?.ok)fail('Access changed. Sign in again before continuing.');
}
async function coversTx(tx:Tx,attemptId:string,operation:'view'|'maintain'){
 const[row]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${attemptId}::uuid,${operation},true) as ok`);return row?.ok===true;
}

export type CreateImportAttemptInput<P extends ImportPlanBase>={kind:ImportKind;sourceName:string;content:Buffer;companyIds:string[];plan:P;operationKey?:string};
/** Records the validated upload. Every listed company must be maintainable (RLS insert policy). */
export async function createImportAttemptTx<P extends ImportPlanBase>(tx:Tx,ctx:SessionContext,input:CreateImportAttemptInput<P>):Promise<{attemptId:string;plan:P;existing:boolean}>{
 if(!isImportKind(input.kind))fail('Unknown import kind.');
 if(input.content.length>(input.kind==='bank_statutory'?BANK_IMPORT_MAX_BYTES:IMPORT_SOURCE_MAX_BYTES))fail(input.kind==='bank_statutory'?'Choose a file no larger than 128 MiB.':'Choose a file no larger than 10 MB.');
 await principalTx(tx,ctx);
 const sourceHash=importSourceHash(input.content),operationKey=input.operationKey&&uuid.test(input.operationKey)?input.operationKey:randomUUID();
 const[prior]=await tx.select({id:attempt.id,sourceHash:attempt.sourceHash,kind:attempt.kind,plan:attempt.plan}).from(attempt).where(and(eq(attempt.createdBy,ctx.userId!),eq(attempt.operationKey,operationKey)));
 if(prior){if(prior.sourceHash!==sourceHash||prior.kind!==input.kind)fail('This upload operation already identifies a different file.');return{attemptId:prior.id,plan:prior.plan as P,existing:true};}
 const companyIds=[...new Set(input.companyIds)].sort();
 const[created]=await tx.insert(attempt).values({tenantId:ctx.tenantId,kind:input.kind,createdBy:ctx.userId!,operationKey,sourceName:importSourceName(input.sourceName,'import'),mimeType:importMimeType(input.sourceName),sourceHash,sourceContent:input.content,companyIds,plan:input.plan as unknown as Record<string,unknown>}).returning({id:attempt.id});
 // An attempt naming no company (an unreadable file) is its creator's own; the event policy admits that.
 await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:created.id,kind:'previewed',actorId:ctx.userId!,detail:{counts:input.plan.counts}});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'import-attempt',aggregateId:created.id,eventType:'import-attempt.previewed',actor:actorOf(ctx),payload:{kind:input.kind,sourceHash,counts:input.plan.counts,companyIds}});
 return{attemptId:created.id,plan:input.plan,existing:false};
}

export type ImportAttemptRow=typeof attempt.$inferSelect;
/** Locks the attempt for confirm/revert. The row is immutable; FOR UPDATE only serializes writers. */
export async function lockImportAttemptTx(tx:Tx,ctx:SessionContext,attemptId:string,kind:ImportKind):Promise<ImportAttemptRow>{
 if(!uuid.test(attemptId))fail('Import attempt unavailable.');
 await principalTx(tx,ctx);
 const[row]=await tx.select().from(attempt).where(eq(attempt.id,attemptId)).for('update');
 if(!row||row.kind!==kind)fail('Import attempt unavailable.');return row;
}
/** Same principal/RLS checks and writer lock, without reloading the upload for every Bank row. */
export async function lockImportAttemptHeaderTx(tx:Tx,ctx:SessionContext,attemptId:string,kind:ImportKind):Promise<Pick<ImportAttemptRow,'id'|'kind'>>{
 if(!uuid.test(attemptId))fail('Import attempt unavailable.');
 await principalTx(tx,ctx);
 const[row]=await tx.select({id:attempt.id,kind:attempt.kind}).from(attempt).where(eq(attempt.id,attemptId)).for('update');
 if(!row||row.kind!==kind)fail('Import attempt unavailable.');return row;
}
export function importAttemptEventsTx(tx:Tx,attemptId:string){return tx.select().from(historyEvent).where(eq(historyEvent.attemptId,attemptId)).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id));}
export function importAttemptItemsTx(tx:Tx,attemptId:string){return tx.select().from(item).where(eq(item.attemptId,attemptId)).orderBy(asc(item.ordinal),asc(item.itemKey));}
export type ImportAttemptItemRow=typeof item.$inferSelect;

export type RecordImportItemInput={attemptId:string;companyId:string;employmentId?:string|null;itemKey:string;label:string;ordinal:number;status:'applied'|'failed';before?:unknown;after?:unknown;errors?:string[]};
/** Write an applied item in the SAME transaction as the change it describes. */
export async function recordImportItemTx(tx:Tx,ctx:SessionContext,input:RecordImportItemInput){
 const[row]=await tx.insert(item).values({tenantId:ctx.tenantId,attemptId:input.attemptId,companyId:input.companyId,employmentId:input.employmentId??null,itemKey:input.itemKey.slice(0,500),label:input.label.slice(0,500),ordinal:input.ordinal,status:input.status,before:input.before??null,after:input.after??null,errors:(input.errors??[]).map(e=>String(e).slice(0,1000)).slice(0,50)}).returning({id:item.id});
 return row.id;
}
/** Returns the Import History event's id (assigned here: a RETURNING would also apply the event's read policy). */
export async function recordImportEventTx(tx:Tx,ctx:SessionContext,input:{attemptId:string;kind:Exclude<ImportEventKind,'previewed'>;importKind:ImportKind;reason?:string|null;detail?:Record<string,unknown>}){
 const id=randomUUID();
 await tx.insert(historyEvent).values({id,tenantId:ctx.tenantId,attemptId:input.attemptId,kind:input.kind,actorId:ctx.userId!,reason:input.reason??null,detail:input.detail??{}});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'import-attempt',aggregateId:input.attemptId,eventType:'import-attempt.'+input.kind.replace('_','-'),actor:actorOf(ctx),payload:{kind:input.importKind,...(input.reason?{reason:input.reason}:{}),...(input.detail??{})}});
 return id;
}
/** Best effort, in its own transaction: the failed operation's transaction has already rolled back. */
/** `extra` adds kind-specific detail (for example the employee import's save report rows, item 1859cce0). */
export async function recordImportFailure(ctx:SessionContext,attemptId:string,importKind:ImportKind,kind:'failed'|'revert_failed',error:unknown,extra?:Record<string,unknown>){
 if(!uuid.test(attemptId)||!ctx.userId)return;
 const reason=error instanceof ImportHistoryError?error.message:'The operation failed; no changes were committed.';
 try{await withTenant(ctx,async tx=>{
  const[found]=await tx.select({id:attempt.id}).from(attempt).where(and(eq(attempt.id,attemptId),eq(attempt.kind,importKind)));if(!found)return;
  await recordImportEventTx(tx,ctx,{attemptId,kind,importKind,detail:{...(extra??{}),message:reason,...(error instanceof ImportHistoryError&&error.blockers.length?{blockers:error.blockers.slice(0,200)}:{})}});
 });}catch(recordError){console.error('[import history failure audit]',recordError);}
}

const listColumns={id:attempt.id,kind:attempt.kind,sourceName:attempt.sourceName,sourceHash:attempt.sourceHash,companyIds:attempt.companyIds,plan:attempt.plan,createdBy:attempt.createdBy,createdAt:attempt.createdAt};
async function companyNamesTx(tx:Tx,ids:string[]){
 if(!ids.length)return new Map<string,string>();
 const rows=await tx.select({id:company.id,name:company.legalName,label:company.companyLabel}).from(company).where(inArray(company.id,ids));
 return new Map(rows.map(r=>[r.id,r.label?.trim()?`${r.label.trim()} · ${r.name}`:r.name]));
}
/** Board 8d02748a: every recorded actor of these attempts in ONE set-wise read (no per-row label function). */
const personName=(actor:ImportActor)=>actor.kind==='person'?actor.name:null;
async function eventsWithNamesTx(tx:Tx,ids:string[],actors:Map<string,ImportRowActors>){
 if(!ids.length)return[];
 const rows=await tx.select(getTableColumns(historyEvent)).from(historyEvent).where(inArray(historyEvent.attemptId,ids)).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id));
 return rows.map(row=>{const actor=actorOn(actors,row.attemptId,row.actorId);return{...row,actor,actorName:personName(actor)};});
}
function creatorLabels(actors:Map<string,ImportRowActors>,id:string){const createdByActor=creatorOf(actors,id);return{createdByActor,createdByName:personName(createdByActor)};}
function withCreator<R extends {id:string}>(actors:Map<string,ImportRowActors>,row:R){return{...row,...creatorLabels(actors,row.id)};}
/** Company-scoped by RLS: an attempt is listed when the actor holds view for at least one listed company. */
export async function listImportAttempts(ctx:SessionContext,options:{kind?:ImportKind;before?:string;limit?:number}={}){
 if(options.kind!==undefined&&!isImportKind(options.kind))fail('Unknown import kind.');
 if(options.before&&!uuid.test(options.before))fail('Import cursor unavailable.');
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);const limit=Math.min(100,Math.max(1,options.limit??25));
  const rows=await tx.select(listColumns).from(attempt).where(and(options.kind?eq(attempt.kind,options.kind):undefined,options.before?sql`(${attempt.createdAt},${attempt.id}) < (select created_at,id from import_attempt where id=${options.before}::uuid)`:undefined))
   .orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(limit+1);
  const chosen=rows.slice(0,limit),actors=await resolveImportActors(tx,'import_attempt',chosen.map(r=>r.id)),events=await eventsWithNamesTx(tx,chosen.map(r=>r.id),actors),names=await companyNamesTx(tx,[...new Set(chosen.flatMap(r=>r.companyIds))]);
  return{items:chosen.map(r=>({...withCreator(actors,r),plan:r.plan as unknown as ImportPlanBase,companies:r.companyIds.map(id=>names.get(id)).filter((n):n is string=>!!n),events:events.filter(e=>e.attemptId===r.id)})),nextCursor:rows.length>limit?chosen.at(-1)!.id:null};
 });
}
export type ImportAttemptListItem=Awaited<ReturnType<typeof listImportAttempts>>['items'][number];

/**
 * ccd3a65c — section runs (employee_import_run) are listed by the company access of the viewer, read-side.
 * Their RLS (0341) is tenant + is_admin only, so this predicate is what keeps another company's failed rows
 * (employee names and reasons) off the list. A run with no company (register sections) is shown to its
 * creator, or to a viewer who administers and can view every active company of the tenant.
 */
function runVisibleSql(ctx:SessionContext){
 return sql`((${run.companyId} is not null and app.is_admin_for(${run.companyId}) and app.access_workforce_company(${run.companyId},'workforce.view'))
  or (${run.companyId} is null and (${run.createdByUserId}=${ctx.userId??''}::text or not exists(select 1 from company c where c.tenant_id=app.current_tenant_id() and c.archived_at is null
   and not (app.is_admin_for(c.id) and app.access_workforce_company(c.id,'workforce.view'))))))`;
}
/** Listed run types: section runs plus runs recorded before migration 4500 (type not recorded). */
function listedRunSql(kind?:ImportRunKind){
 return kind?sql`${run.importSection}=${kind}`:sql`(${run.importSection} is null or ${run.importSection} in (${sql.join(IMPORT_RUN_KINDS.map(k=>sql`${k}`),sql`,`)}))`;
}
const HISTORY_CURSOR=/^([ar])\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export type ImportHistoryRow={source:'attempt'|'run';id:string;cursor:string;kind:ImportHistoryKind|null;sourceName:string;createdAt:Date;createdBy:string|null;createdByName:string|null;createdByActor:ImportActor;companies:string[];total:number;successful:number;failed:number;status:ImportAttemptStatus};
/**
 * ccd3a65c — Import History: every shared import attempt (ADR-0155) and every section run that keeps only
 * a summary, newest first, with one stable cursor across both sources ((created_at, id) descending).
 */
export async function listImportHistory(ctx:SessionContext,options:{kind?:ImportHistoryKind;before?:string;limit?:number}={}):Promise<{items:ImportHistoryRow[];nextCursor:string|null}>{
 if(options.kind!==undefined&&!isImportHistoryKind(options.kind))fail('Unknown import kind.');
 const cursor=options.before?HISTORY_CURSOR.exec(options.before):null;
 if(options.before&&!cursor)fail('Import cursor unavailable.');
 const limit=Math.min(100,Math.max(1,options.limit??25));
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);
  const bound=cursor?(cursor[1]==='a'?sql`(select created_at,id from import_attempt where id=${cursor[2]}::uuid)`:sql`(select created_at,id from employee_import_run where id=${cursor[2]}::uuid)`):null;
  const sortKey=(column:typeof attempt.createdAt|typeof run.createdAt)=>sql<string>`lpad(((extract(epoch from ${column})*1000000)::bigint)::text,20,'0')`;
  const attemptKind=options.kind&&isImportKind(options.kind)?options.kind:undefined,runKind=options.kind&&isImportRunKind(options.kind)?options.kind:undefined;
  // A filter of the other source still runs the query, with nothing admitted, so both lists keep one type.
  const attempts=await tx.select({...listColumns,sortKey:sortKey(attempt.createdAt)}).from(attempt)
   .where(and(options.kind&&!attemptKind?sql`false`:undefined,attemptKind?eq(attempt.kind,attemptKind):undefined,bound?sql`(${attempt.createdAt},${attempt.id}) < ${bound}`:undefined))
   .orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(limit+1);
  const runs=await tx.select({id:run.id,section:run.importSection,fileName:run.fileName,companyId:run.companyId,companyName:company.legalName,companyLabel:company.companyLabel,createdBy:run.createdByUserId,createdByName:person.fullName,createdAt:run.createdAt,totalRows:run.totalRows,importedRows:run.importedRows,failedRows:run.failedRows,sortKey:sortKey(run.createdAt)})
   .from(run).leftJoin(company,eq(company.id,run.companyId)).leftJoin(person,eq(person.id,run.createdByPersonId))
   .where(and(options.kind&&!runKind?sql`false`:undefined,listedRunSql(runKind),runVisibleSql(ctx),bound?sql`(${run.createdAt},${run.id}) < ${bound}`:undefined))
   .orderBy(desc(run.createdAt),desc(run.id)).limit(limit+1);
  const attemptActors=await resolveImportActors(tx,'import_attempt',attempts.map(r=>r.id)),runActors=await resolveImportActors(tx,'employee_import_run',runs.map(r=>r.id));
  const events=await eventsWithNamesTx(tx,attempts.map(r=>r.id),attemptActors),names=await companyNamesTx(tx,[...new Set(attempts.flatMap(r=>r.companyIds))]);
  const merged:(ImportHistoryRow&{sortKey:string})[]=[
   ...attempts.map(r=>{const own=events.filter(e=>e.attemptId===r.id),plan=r.plan as unknown as ImportPlanBase;return{source:'attempt' as const,id:r.id,cursor:'a.'+r.id,kind:isImportKind(r.kind)?r.kind:null,sourceName:r.sourceName,createdAt:r.createdAt,createdBy:r.createdBy,...creatorLabels(attemptActors,r.id),companies:r.companyIds.map(id=>names.get(id)).filter((n):n is string=>!!n),...importAttemptTotals(plan,own),status:importAttemptStatus(plan,own),sortKey:r.sortKey};}),
   ...runs.map(r=>{const outcome=importRunOutcome(r);return{source:'run' as const,id:r.id,cursor:'r.'+r.id,kind:isImportRunKind(r.section)?r.section:null,sourceName:r.fileName,createdAt:r.createdAt,createdBy:r.createdBy,...creatorLabels(runActors,r.id),companies:r.companyName?[r.companyLabel?.trim()?`${r.companyLabel.trim()} · ${r.companyName}`:r.companyName]:[],total:r.totalRows,successful:r.importedRows,failed:r.failedRows,status:outcome,sortKey:r.sortKey};}),
  ].sort((a,b)=>a.sortKey<b.sortKey?1:a.sortKey>b.sortKey?-1:a.id<b.id?1:a.id>b.id?-1:0);
  const chosen=merged.slice(0,limit).map(({sortKey:_sortKey,...row})=>row);
  return{items:chosen,nextCursor:merged.length>limit?chosen.at(-1)!.cursor:null};
 });
}
/** ccd3a65c — one section run's log: its summary and the rows that were not saved, with their reasons. */
export async function getImportRun(ctx:SessionContext,id:string){
 if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);
  const[row]=await tx.select({id:run.id,section:run.importSection,fileName:run.fileName,companyName:company.legalName,companyLabel:company.companyLabel,createdBy:run.createdByUserId,createdByName:person.fullName,createdAt:run.createdAt,totalRows:run.totalRows,importedRows:run.importedRows,failedRows:run.failedRows,errors:run.errors,errorsTruncated:run.errorsTruncated})
   .from(run).leftJoin(company,eq(company.id,run.companyId)).leftJoin(person,eq(person.id,run.createdByPersonId)).where(and(eq(run.id,id),runVisibleSql(ctx)));
  if(!row)return null;
  const outcome=importRunOutcome(row),actors=await resolveImportActors(tx,'employee_import_run',[row.id]);
  return{...withCreator(actors,row),kind:isImportRunKind(row.section)?row.section:null,companies:row.companyName?[row.companyLabel?.trim()?`${row.companyLabel.trim()} · ${row.companyName}`:row.companyName]:[],errors:Array.isArray(row.errors)?row.errors as ImportRunError[]:[],status:outcome};
 });
}
export type ImportRunDetail=NonNullable<Awaited<ReturnType<typeof getImportRun>>>;
/** Detail with only the items of companies the actor can view (item RLS), plus what the actor may do. */
export async function getImportAttempt(ctx:SessionContext,id:string){
 if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);
  const[row]=await tx.select(listColumns).from(attempt).where(eq(attempt.id,id));if(!row)return null;
  const actors=await resolveImportActors(tx,'import_attempt',[id]);
  const items=await importAttemptItemsTx(tx,id),events=await eventsWithNamesTx(tx,[id],actors),names=await companyNamesTx(tx,row.companyIds);
  const canDownloadSource=await coversTx(tx,id,'view'),canRevert=await coversTx(tx,id,'maintain');
  return{...withCreator(actors,row),plan:row.plan as unknown as ImportPlanBase,companies:row.companyIds.map(c=>names.get(c)).filter((n):n is string=>!!n),items:items.map(i=>({...i,companyName:names.get(i.companyId)??null})),events,canDownloadSource,canRevert};
 });
}
export type ImportAttemptDetail=NonNullable<Awaited<ReturnType<typeof getImportAttempt>>>;
/** The kind of an attempt visible to the actor, or null. Used to dispatch to the kind's revert handler. */
export async function importAttemptKind(ctx:SessionContext,id:string):Promise<ImportKind|null>{
 if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{const[row]=await tx.select({kind:attempt.kind}).from(attempt).where(eq(attempt.id,id));return row&&isImportKind(row.kind)?row.kind:null;});
}
/** The file holds every listed company's rows, so it is released only to an actor who can view all of them. */
export async function importAttemptSource(ctx:SessionContext,id:string){
 if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);if(!await coversTx(tx,id,'view'))return null;
  const[row]=await tx.select({name:attempt.sourceName,mimeType:attempt.mimeType,content:attempt.sourceContent,sourceHash:attempt.sourceHash}).from(attempt).where(eq(attempt.id,id));return row??null;
 });
}

export type ImportRevertBlocker={itemId:string;label:string;reason:string};
export type ImportRevertInspection={items:{itemId:string;blockers:string[];restore:unknown}[];fingerprint:unknown};
/** Kind-specific part of a revert. Items are the attempt's APPLIED items in commit order. */
export interface ImportRevertHandler{
 kind:ImportKind;
 /** Optional locks taken first in the revert transaction (before the attempt row) to keep a stable order. */
 lock?(tx:Tx,ctx:SessionContext):Promise<void>;
 /** Per-item eligibility and the values that will be restored. `fingerprint` must change whenever the
  * current state an item would restore over changes; it is part of the preview hash. */
 inspect(tx:Tx,ctx:SessionContext,items:ImportAttemptItemRow[],options:{lock:boolean}):Promise<ImportRevertInspection>;
 /** Writes the compensation through the kind's owner. Called only when no item is blocked. `reason` is the
  * revert's validated reason, for owners whose own compensation records one (a movement rollback). */
 apply(tx:Tx,ctx:SessionContext,items:ImportAttemptItemRow[],options:{reason:string}):Promise<Record<string,unknown>>;
}
async function revertPlanTx(tx:Tx,ctx:SessionContext,source:ImportAttemptRow,handler:ImportRevertHandler,lock:boolean){
 if(!await coversTx(tx,source.id,'maintain'))fail('Reverting this import needs maintain permission for every company in it.');
 const events=await importAttemptEventsTx(tx,source.id);
 if(events.some(e=>e.kind==='reverted'))fail('This import has already been reverted.');
 const confirmed=events.find(e=>e.kind==='confirmed');if(!confirmed)fail('This import was not saved, so there is nothing to revert.');
 const items=(await importAttemptItemsTx(tx,source.id)).filter(i=>i.status==='applied');
 if(!items.length)fail('This import saved no changes, so there is nothing to revert.');
 const inspection=await handler.inspect(tx,ctx,items,{lock});
 const byId=new Map(inspection.items.map(i=>[i.itemId,i]));
 if(items.some(i=>!byId.has(i.id)))fail('The revert check is incomplete. Try again.');
 const blockers:ImportRevertBlocker[]=items.flatMap(i=>byId.get(i.id)!.blockers.map(reason=>({itemId:i.id,label:i.label,reason})));
 const previewHash=importCanonicalHash({attemptId:source.id,kind:source.kind,actorId:ctx.userId,confirmedEventId:confirmed.id,items:items.map(i=>i.id),fingerprint:inspection.fingerprint,blockers});
 return{items,inspection:items.map(i=>({itemId:i.id,label:i.label,employmentId:i.employmentId,companyId:i.companyId,before:i.before,after:i.after,restore:byId.get(i.id)!.restore,blockers:byId.get(i.id)!.blockers})),blockers,previewHash,confirmedEventId:confirmed.id};
}
/** Read-only eligibility review: what will be restored, and every blocker. No change is written. */
export async function previewImportRevert(ctx:SessionContext,attemptId:string,handler:ImportRevertHandler){
 if(!uuid.test(attemptId))fail('Import attempt unavailable.');
 return withTenant(ctx,async tx=>{
  await handler.lock?.(tx,ctx);await principalTx(tx,ctx);
  const[source]=await tx.select().from(attempt).where(eq(attempt.id,attemptId));if(!source||source.kind!==handler.kind)fail('Import attempt unavailable.');
  const plan=await revertPlanTx(tx,ctx,source,handler,false);
  return{attemptId,kind:source.kind,eligible:plan.blockers.length===0,items:plan.inspection,blockers:plan.blockers,previewHash:plan.previewHash};
 });
}
export type ImportRevertPreview=Awaited<ReturnType<typeof previewImportRevert>>;
/** The same review for a background revert (core/employee-import-revert-job.ts): one read-only snapshot and no tenant
 * lock, because nothing is written; the revert itself re-checks everything under its locks. */
export async function planImportRevert(ctx:SessionContext,attemptId:string,handler:ImportRevertHandler){
 if(!uuid.test(attemptId))fail('Import attempt unavailable.');
 return withTenant(ctx,async tx=>{
  await principalTx(tx,ctx);
  const[source]=await tx.select().from(attempt).where(eq(attempt.id,attemptId));if(!source||source.kind!==handler.kind)fail('Import attempt unavailable.');
  const plan=await revertPlanTx(tx,ctx,source,handler,false);
  return{attempt:source,items:plan.items,inspection:plan.inspection,blockers:plan.blockers,previewHash:plan.previewHash,confirmedEventId:plan.confirmedEventId};
 },{readOnlySnapshot:true});
}
/** A caller that must survive losing track of its own revert (a background job whose lease can lapse while the revert
 * commits) records the completion in the revert's transaction and recognises it on a retry. */
export type ImportRevertCompletion={
 /** Under the attempt's row lock, before the revert's own checks: a completion this caller already recorded (a
  *  concurrent revert still committing has been waited for). Returning it ends the call without writing anything. */
 completedTx?(tx:Tx):Promise<{restored:number}|null>;
 /** In the revert's transaction, after its Import History event: commits or rolls back with the revert. */
 recordTx?(tx:Tx,completion:{eventId:string;restored:number}):Promise<void>;
};
/** All or nothing, once only, with a reason; the reviewed preview hash must still hold under lock. */
export async function revertImport(ctx:SessionContext,attemptId:string,handler:ImportRevertHandler,input:{previewHash:string;reason:string},completion:ImportRevertCompletion={}){
 if(!uuid.test(attemptId))fail('Import attempt unavailable.');
 const reason=normalizeImportRevertReason(input.reason);if(!reason)fail('Enter a reason for the revert (3 to 1,000 characters).');
 if(typeof input.previewHash!=='string'||!/^[0-9a-f]{64}$/.test(input.previewHash))fail('Review what will be restored before confirming.');
 try{return await withTenant(ctx,async tx=>{
  await handler.lock?.(tx,ctx);
  const source=await lockImportAttemptTx(tx,ctx,attemptId,handler.kind);
  const prior=await completion.completedTx?.(tx);
  if(prior)return{attemptId,restored:prior.restored};
  const plan=await revertPlanTx(tx,ctx,source,handler,true);
  if(plan.blockers.length)fail('This import cannot be reverted because some records changed after it.',plan.blockers);
  if(plan.previewHash!==input.previewHash)fail('What this revert would restore has changed. Review it again before confirming.');
  const detail=await handler.apply(tx,ctx,plan.items,{reason});
  const eventId=await recordImportEventTx(tx,ctx,{attemptId,kind:'reverted',importKind:source.kind,reason,detail:{restored:plan.items.length,...detail}});
  await completion.recordTx?.(tx,{eventId,restored:plan.items.length});
  return{attemptId,restored:plan.items.length};
 });}catch(error){
  // A concurrent second revert loses on the once-only index; report it as such.
  const message=String((error as {message?:string})?.message??'');
  const wrapped=message.includes('import_attempt_revert_once_uq')?new ImportHistoryError('This import has already been reverted.'):error;
  await recordImportFailure(ctx,attemptId,handler.kind,'revert_failed',wrapped);throw wrapped;
 }
}
