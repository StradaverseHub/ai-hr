/** AI v2 Phase 1, slice 3 — employee letter requests (migration 0961), the owner service.
 *
 * An employee asks HR for a letter from the templates their company has opened for employee requests ("employees may
 * request", set by HR holding the letters `settings` capability in letter settings). HR holding `generate` for the
 * company sees the requests on Today and on the generate page, prepares the letter through the existing generate flow
 * (core/letters.ts createLetterDraftBatch, which links the draft here) or declines with a reason. When the prepared letter
 * is issued, the database moves the request to issued (app.letter_request_issued).
 *
 * Nothing here writes letter content or a figure: the request holds the template's published name, the person's own
 * optional purpose and its status. Every read and write runs as the caller under forced row-level security; the
 * database owns the lifecycle and refuses a template that is not open for requests. Every change appends a domain event
 * in the same transaction; none carries the purpose, the decline reason or the message to the employee. The employee is
 * notified of a decline with no content beyond the status (core/notifications.ts letter-request.declined); HR's optional
 * message to the employee is shown with the declined status on My Letters, and the reason never leaves HR. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {letterRequest,letterRequestOption} from '../db/schema';
import {assertModuleGate} from './module-gate';
import {todayInKualaLumpur} from '../lib/hr-date';

export const LETTER_REQUEST_STATUSES=['requested','in_progress','issued','declined'] as const;
export type LetterRequestStatus=typeof LETTER_REQUEST_STATUSES[number];
export const LETTER_REQUEST_OPEN:readonly LetterRequestStatus[]=Object.freeze(['requested','in_progress']);
export const LETTER_REQUEST_LIMITS=Object.freeze({purposeChars:300,reasonChars:500,messageChars:500,list:50,options:200});
export type LetterRequestErrorCode='invalid'|'not_requestable'|'duplicate'|'permission'|'state'|'stale'|'unavailable';
export class LetterRequestError extends Error{
 constructor(readonly code:LetterRequestErrorCode){super('Letter request: '+code);this.name='LetterRequestError';}
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid=(value:unknown):string=>{if(typeof value!=='string'||!UUID.test(value))throw new LetterRequestError('invalid');return value;};
/** Optional free text: trimmed, empty is none, too long is refused (never cut). */
function optionalText(value:unknown,max:number):string|null{
 if(value===undefined||value===null)return null;
 if(typeof value!=='string')throw new LetterRequestError('invalid');
 const trimmed=value.trim();if(!trimmed)return null;
 if(trimmed.length>max)throw new LetterRequestError('invalid');
 return trimmed;
}
type PgError={code?:string;constraint_name?:string;constraint?:string;cause?:unknown};
/** The Postgres error behind a Drizzle wrapper (the cause chain), if any. */
function pgError(error:unknown):PgError|null{
 for(let current:unknown=error,depth=0;current&&typeof current==='object'&&depth<5;current=(current as PgError).cause,depth++){
  if(typeof (current as PgError).code==='string'&&/^[0-9A-Z]{5}$/.test((current as PgError).code!))return current as PgError;
 }
 return null;
}
const constraintOf=(error:PgError)=>error.constraint_name??error.constraint??'';
/** Letters are part of the employees module, as in core/letters.ts. */
export function assertLetterRequestsAvailable(ctx:SessionContext):void{assertModuleGate(ctx,'employees');if(!ctx.userId)throw new LetterRequestError('permission');}
function requests<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>):Promise<T>{
 return Promise.resolve().then(()=>{assertLetterRequestsAvailable(ctx);return withTenant(ctx,work);});
}
async function event(tx:Tx,ctx:SessionContext,input:{requestId:string;type:string;employmentId:string;payload:Record<string,unknown>}){
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'letter-request',aggregateId:input.requestId,eventType:'letter-request.'+input.type,
  actor:actorOf(ctx),subjectEmploymentId:input.employmentId,payload:input.payload});
}
async function allowed(tx:Tx,companyId:string,capability:'generate'|'settings'):Promise<boolean>{
 const [row]=await tx.execute<{ok:boolean|null}>(sql`select app.letter_permission(${uuid(companyId)}::uuid,${capability}) as ok`);
 return row?.ok===true;
}

// ── The employee ───────────────────────────────────────────────────────────────────────────────────────────────
export type RequestableLetterType=Readonly<{employmentId:string;companyId:string;companyName:string;templateId:string;name:string}>;
export async function requestableLetterTypesTx(tx:Tx):Promise<RequestableLetterType[]>{
 const rows=await tx.execute<{employment_id:string;company_id:string;company_name:string;template_id:string;name:string}>(sql`select * from app.letter_requestable_templates()`);
 return rows.map(row=>Object.freeze({employmentId:row.employment_id,companyId:row.company_id,companyName:row.company_name,templateId:row.template_id,name:row.name}));
}
/** The letter types the caller may request now, for each of their own current employments. */
export function listRequestableLetterTypes(ctx:SessionContext):Promise<readonly RequestableLetterType[]>{
 return requests(ctx,async tx=>Object.freeze(await requestableLetterTypesTx(tx)));
}

/** What a chat card for this request binds: the caller's own employment, the template and its published name now. A
 * different name, a closed template or another employment gives a different digest (or none). */
export function letterRequestDigest(tenantId:string,type:RequestableLetterType):string{
 return createHash('sha256').update(JSON.stringify(['ai-hr.letter-request.v1',tenantId,type.employmentId,type.companyId,type.templateId,type.name])).digest('hex');
}

export type SubmitLetterRequestInput=Readonly<{templateId:unknown;employmentId?:unknown;purpose?:unknown;clientKey?:unknown}>;
/** The caller asks for a letter of one requestable type, for their own employment. `clientKey` (a chat card's own id)
 * makes a repeated Confirm the same request. Refuses a type that is not open for requests, a second open request for
 * the same type, and anything that is not the caller's own. */
export function submitLetterRequest(ctx:SessionContext,input:SubmitLetterRequestInput):Promise<Readonly<{requestId:string;alreadyRequested:boolean}>>{
 return requests(ctx,tx=>submitLetterRequestTx(tx,ctx,input));
}
/** The same, inside a caller's transaction (the chat card's Confirm holds its AI pause check through the write). The
 * caller has passed the employees module gate. */
export async function submitLetterRequestTx(tx:Tx,ctx:SessionContext,input:SubmitLetterRequestInput):Promise<Readonly<{requestId:string;alreadyRequested:boolean}>>{
  if(!ctx.userId)throw new LetterRequestError('permission');
  const templateId=uuid(input.templateId),employmentId=input.employmentId===undefined?null:uuid(input.employmentId);
  const purpose=optionalText(input.purpose,LETTER_REQUEST_LIMITS.purposeChars),clientKey=input.clientKey===undefined?null:uuid(input.clientKey);
  const offered=(await requestableLetterTypesTx(tx)).filter(row=>row.templateId===templateId&&(employmentId===null||row.employmentId===employmentId));
  if(clientKey){
   const [earlier]=await tx.select({id:letterRequest.id,templateId:letterRequest.templateId,employmentId:letterRequest.employmentId}).from(letterRequest)
    .where(and(eq(letterRequest.requestedBy,ctx.userId!),eq(letterRequest.clientKey,clientKey)));
   if(earlier){
    if(earlier.templateId!==templateId||(employmentId!==null&&earlier.employmentId!==employmentId))throw new LetterRequestError('invalid');
    return Object.freeze({requestId:earlier.id,alreadyRequested:true});
   }
  }
  if(offered.length===0)throw new LetterRequestError('not_requestable');
  if(offered.length>1)throw new LetterRequestError('invalid');
  const chosen=offered[0];
  let id:string;
  try{
   id=await tx.transaction(async savepoint=>{
    const [row]=await savepoint.insert(letterRequest).values({tenantId:ctx.tenantId,companyId:chosen.companyId,employmentId:chosen.employmentId,requestedBy:ctx.userId!,
     templateId,letterTypeName:chosen.name,purpose,clientKey}).returning({id:letterRequest.id});
    return row.id;
   });
  }catch(error){
   const pg=pgError(error);
   if(pg?.code==='23505'&&constraintOf(pg)==='letter_request_open_uq')throw new LetterRequestError('duplicate');
   if(pg?.code==='23514')throw new LetterRequestError('not_requestable');
   throw error;
  }
  await event(tx,ctx,{requestId:id,type:'submitted',employmentId:chosen.employmentId,payload:{templateId,companyId:chosen.companyId,status:'requested'}});
  return Object.freeze({requestId:id,alreadyRequested:false});
}

export type OwnLetterRequest=Readonly<{id:string;letterTypeName:string;purpose:string|null;status:LetterRequestStatus;createdAt:Date;statusChangedAt:Date;
 /** The issued letter, once issued: the person opens it under My Letters. */letterId:string|null;
 /** HR's optional message to the employee, written with a decline; null otherwise. */employeeMessage:string|null}>;
/** The caller's own requests, newest first. HR's message to the employee with a decline, never HR's decline reason or
 * who handled it. */
export function listMyLetterRequests(ctx:SessionContext,input:{limit?:number}={}):Promise<readonly OwnLetterRequest[]>{
 return requests(ctx,async tx=>{
  const limit=Math.min(Math.max(Math.trunc(input.limit??LETTER_REQUEST_LIMITS.list),1),LETTER_REQUEST_LIMITS.list);
  const rows=await tx.select({id:letterRequest.id,letterTypeName:letterRequest.letterTypeName,purpose:letterRequest.purpose,status:letterRequest.status,createdAt:letterRequest.createdAt,
   statusChangedAt:letterRequest.statusChangedAt,letterId:letterRequest.letterId,employeeMessage:letterRequest.employeeMessage}).from(letterRequest)
   // Only the caller's own: an HR caller also reads other people's requests under the staff policy.
   .where(sql`exists(select 1 from employment e where e.id=${letterRequest.employmentId} and e.tenant_id=${letterRequest.tenantId} and app.is_self_person(e.person_id))`)
   .orderBy(desc(letterRequest.createdAt),desc(letterRequest.id)).limit(limit);
  return Object.freeze(rows.map(row=>Object.freeze({...row,letterId:row.status==='issued'?row.letterId:null,employeeMessage:row.status==='declined'?row.employeeMessage:null})));
 });
}

// ── HR holding `generate` ───────────────────────────────────────────────────────────────────────────────────────
export type StaffLetterRequest=Readonly<{id:string;companyId:string;employmentId:string;templateId:string;letterTypeName:string;purpose:string|null;
 status:LetterRequestStatus;createdAt:Date;statusChangedAt:Date;letterId:string|null;declineReason:string|null;employeeMessage:string|null;version:number;
 employeeName:string|null;employeeCode:string|null;
 /** The template's published version now, as this caller reads templates: where "Prepare letter" starts. Null when the
  * template is no longer published or the caller cannot read templates. */publishedVersionId:string|null}>;
/** Columns for HR's reads. A function: "today" is the HR date owner's day at each read. */
const staffColumns=()=>({id:letterRequest.id,companyId:letterRequest.companyId,employmentId:letterRequest.employmentId,templateId:letterRequest.templateId,
 letterTypeName:letterRequest.letterTypeName,purpose:letterRequest.purpose,status:letterRequest.status,createdAt:letterRequest.createdAt,statusChangedAt:letterRequest.statusChangedAt,
 letterId:letterRequest.letterId,declineReason:letterRequest.declineReason,employeeMessage:letterRequest.employeeMessage,version:letterRequest.version,
 employeeName:sql<string|null>`(select s.employee_name from app.letter_request_subject(${letterRequest.id}) s)`,
 employeeCode:sql<string|null>`(select s.employee_code from app.letter_request_subject(${letterRequest.id}) s)`,
 publishedVersionId:sql<string|null>`(select v.id from letter_template_version v join letter_template t on t.id=v.template_id
  where v.template_id=${letterRequest.templateId} and not t.deactivated and v.status='approved' and v.effective_from<=${todayInKualaLumpur()}::date order by v.ordinal desc limit 1)`});

/** Open requests (or the given statuses) of one company for a caller holding `generate` there, oldest first. */
export function listLetterRequestsForStaff(ctx:SessionContext,input:{companyId:string;statuses?:readonly LetterRequestStatus[];limit?:number}):Promise<readonly StaffLetterRequest[]>{
 return requests(ctx,async tx=>{
  const companyId=uuid(input.companyId),statuses=input.statuses??LETTER_REQUEST_OPEN;
  if(!statuses.length||statuses.some(status=>!LETTER_REQUEST_STATUSES.includes(status)))throw new LetterRequestError('invalid');
  if(!await allowed(tx,companyId,'generate'))throw new LetterRequestError('permission');
  const limit=Math.min(Math.max(Math.trunc(input.limit??LETTER_REQUEST_LIMITS.list),1),LETTER_REQUEST_LIMITS.list);
  const rows=await tx.select(staffColumns()).from(letterRequest)
   .where(and(eq(letterRequest.companyId,companyId),inArray(letterRequest.status,[...statuses]),sql`app.letter_permission(${letterRequest.companyId},'generate')`))
   .orderBy(asc(letterRequest.createdAt),asc(letterRequest.id)).limit(limit);
  return Object.freeze(rows.map(row=>Object.freeze(row)));
 });
}
/** One request for a caller holding `generate` for its company; null when there is none they may handle. */
export function getLetterRequestForStaff(ctx:SessionContext,requestId:string):Promise<StaffLetterRequest|null>{
 return requests(ctx,async tx=>{
  const [row]=await tx.select(staffColumns()).from(letterRequest)
   .where(and(eq(letterRequest.id,uuid(requestId)),sql`app.letter_permission(${letterRequest.companyId},'generate')`));
  return row?Object.freeze(row):null;
 });
}
/** Requests waiting for HR (status requested) across these companies, for Today. Only companies where the caller holds
 * `generate` count; an employee's own requests never do. */
export function countWaitingLetterRequests(ctx:SessionContext,companyIds:readonly string[]):Promise<number>{
 return requests(ctx,async tx=>{
  const ids=[...new Set(companyIds.map(uuid))];if(!ids.length)return 0;
  const [row]=await tx.select({count:sql<number>`count(*)::int`}).from(letterRequest)
   .where(and(inArray(letterRequest.companyId,ids),eq(letterRequest.status,'requested'),sql`app.letter_permission(${letterRequest.companyId},'generate')`));
  return Number(row?.count??0);
 });
}

/** Inside core/letters.ts createLetterDraftBatch, in its transaction: the draft just created for the request's employee
 * from the request's template becomes the request's letter (in progress). The database checks the match again. */
export async function linkLetterRequestDraftTx(tx:Tx,ctx:SessionContext,input:{requestId:string;letterId:string;companyId:string;employmentId:string}):Promise<void>{
 const requestId=uuid(input.requestId),letterId=uuid(input.letterId);
 const [held]=await tx.select({id:letterRequest.id,status:letterRequest.status,companyId:letterRequest.companyId,employmentId:letterRequest.employmentId,letterId:letterRequest.letterId}).from(letterRequest)
  .where(and(eq(letterRequest.id,requestId),sql`app.letter_permission(${letterRequest.companyId},'generate')`)).for('update');
 if(!held||held.companyId!==input.companyId||held.employmentId!==input.employmentId)throw new LetterRequestError('permission');
 if(!LETTER_REQUEST_OPEN.includes(held.status))throw new LetterRequestError('state');
 try{await tx.transaction(savepoint=>savepoint.update(letterRequest).set({status:'in_progress',letterId}).where(eq(letterRequest.id,requestId)));}
 catch(error){if(pgError(error)?.code?.startsWith('23'))throw new LetterRequestError('state');throw error;}
 await event(tx,ctx,{requestId,type:'in-progress',employmentId:held.employmentId,payload:{letterId,from:held.status,to:'in_progress'}});
}

/** HR declines a request with a reason and, optionally, a message to the employee. The reason stays with HR; the
 * employee sees that it was declined and the message, if any (never in the notification or an event). */
export function declineLetterRequest(ctx:SessionContext,input:{requestId:unknown;reason:unknown;employeeMessage?:unknown;expectedVersion:unknown}):Promise<Readonly<{requestId:string}>>{
 return requests(ctx,async tx=>{
  const requestId=uuid(input.requestId),reason=optionalText(input.reason,LETTER_REQUEST_LIMITS.reasonChars);
  const employeeMessage=optionalText(input.employeeMessage,LETTER_REQUEST_LIMITS.messageChars);
  if(!reason||typeof input.expectedVersion!=='number'||!Number.isInteger(input.expectedVersion))throw new LetterRequestError('invalid');
  const [held]=await tx.select({id:letterRequest.id,status:letterRequest.status,version:letterRequest.version,employmentId:letterRequest.employmentId}).from(letterRequest)
   .where(and(eq(letterRequest.id,requestId),sql`app.letter_permission(${letterRequest.companyId},'generate')`)).for('update');
  if(!held)throw new LetterRequestError('permission');
  if(held.version!==input.expectedVersion)throw new LetterRequestError('stale');
  if(!LETTER_REQUEST_OPEN.includes(held.status))throw new LetterRequestError('state');
  await tx.update(letterRequest).set({status:'declined',declineReason:reason,employeeMessage}).where(eq(letterRequest.id,requestId));
  await event(tx,ctx,{requestId,type:'declined',employmentId:held.employmentId,payload:{from:held.status,to:'declined'}});
  return Object.freeze({requestId});
 });
}

// ── Letter settings (`settings`) ────────────────────────────────────────────────────────────────────────────────
export type LetterRequestOption=Readonly<{templateId:string;code:string;name:string;requestable:boolean}>;
/** Every published template of the company and whether employees may request it. */
export function listLetterRequestOptions(ctx:SessionContext,companyId:string):Promise<readonly LetterRequestOption[]>{
 return requests(ctx,async tx=>{
  const company=uuid(companyId);if(!await allowed(tx,company,'settings'))throw new LetterRequestError('permission');
  const rows=await tx.execute<{template_id:string;code:string;name:string;requestable:boolean}>(sql`select * from app.letter_request_option_choices(${company}::uuid)`);
  return Object.freeze(rows.map(row=>Object.freeze({templateId:row.template_id,code:row.code,name:row.name,requestable:row.requestable===true})));
 });
}
/** Turn "employees may request" on or off for templates of one company. Unchanged templates are left alone; each change
 * is audited with what it was. */
export function saveLetterRequestOptions(ctx:SessionContext,input:{companyId:unknown;changes:readonly Readonly<{templateId:unknown;requestable:unknown}>[]}):Promise<Readonly<{changed:number}>>{
 return requests(ctx,async tx=>{
  const companyId=uuid(input.companyId);
  if(!Array.isArray(input.changes)||input.changes.length>LETTER_REQUEST_LIMITS.options)throw new LetterRequestError('invalid');
  const changes=input.changes.map(change=>{if(typeof change.requestable!=='boolean')throw new LetterRequestError('invalid');return{templateId:uuid(change.templateId),requestable:change.requestable};});
  if(new Set(changes.map(change=>change.templateId)).size!==changes.length)throw new LetterRequestError('invalid');
  if(!await allowed(tx,companyId,'settings'))throw new LetterRequestError('permission');
  const current=changes.length?await tx.select({templateId:letterRequestOption.templateId,requestable:letterRequestOption.requestable}).from(letterRequestOption)
   .where(and(eq(letterRequestOption.companyId,companyId),inArray(letterRequestOption.templateId,changes.map(change=>change.templateId)))):[];
  const before=new Map(current.map(row=>[row.templateId,row.requestable]));let changed=0;
  for(const change of changes){
   const was=before.get(change.templateId)??false;if(was===change.requestable)continue;
   try{
    await tx.transaction(savepoint=>savepoint.insert(letterRequestOption).values({tenantId:ctx.tenantId,companyId,templateId:change.templateId,requestable:change.requestable,updatedBy:ctx.userId!})
     .onConflictDoUpdate({target:[letterRequestOption.tenantId,letterRequestOption.templateId],set:{requestable:change.requestable,updatedBy:ctx.userId!}}));
   }catch(error){const pg=pgError(error);if(pg?.code==='23514'||pg?.code==='23503'||pg?.code==='42501')throw new LetterRequestError('invalid');throw error;}
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'letter-request-option',aggregateId:change.templateId,eventType:'letter-request-option.changed',
    actor:actorOf(ctx),payload:{companyId,templateId:change.templateId,from:was,to:change.requestable}});
   changed++;
  }
  return Object.freeze({changed});
 });
}
