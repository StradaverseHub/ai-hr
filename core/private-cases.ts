/** AI v2 Phase 1 W11 — the protected case route (owner, 3 November 2026: "Minimal route in Phase 1"; migration 0959,
 * ADR-0173).
 *
 * A private case is a person's own written report to named HR case handlers: grievance, harassment, safety or other.
 * The person writes it in a form (app/me/cases), never through the AI. The AI's fixed sensitive replies only link to
 * that form (core/private-case-route.ts); no model, tool, transcript, stored chat or task memory reads anything here.
 *
 * Text at rest: the case text and every handler note are AES-256-GCM encrypted (lib/ai/crypto.ts) with additional data
 * binding tenant, case and author (and, for a note, the note and its writer), so a ciphertext moved to another tenant,
 * case or author fails. Without the encryption secret nothing is stored; plaintext is never written.
 *
 * Who reads, decided by forced row-level security (0959) and repeated here only to choose the right query:
 *  - the author: their own cases, text and status history, never handler notes or who read it;
 *  - the case's handlers: the company's eligible handlers when it was filed (a current grant held by a current login,
 *    not archived or blocked), except the author and anyone the author excluded, frozen on the case as the set the
 *    intake showed the author; a handler designated later never reads it. With none of them still eligible, or on the
 *    author's request, the group administrators, again except the excluded. The author
 *    may exclude any possible reader, so the person a case is about never reads it; a case nobody may read is kept,
 *    and the author is told no eligible reader is configured. No general HR administrator, manager or agent.
 * Readers are notified of a new case and the author of a status change by the database (0959 §4b), with no content.
 * Every creation, read, status change and note is audited (private_case_event); a read is recorded in the same
 * transaction before any text is decrypted, and a refused read records nothing. Designating or revoking a handler is a
 * group or company HR administrator's act, audited as a domain event. */
import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {isAdmin} from '../lib/authz-model';
import {decryptSecret,encryptSecret,isSecretStorable} from '../lib/ai/crypto';

export const PRIVATE_CASE_CATEGORIES=Object.freeze(['grievance','harassment','safety','other'] as const);
export type PrivateCaseCategory=typeof PRIVATE_CASE_CATEGORIES[number];
export const PRIVATE_CASE_STATUSES=Object.freeze(['received','in_review','closed'] as const);
export type PrivateCaseStatus=typeof PRIVATE_CASE_STATUSES[number];
/** The status changes a handler may make (the 0959 guard enforces the same). */
export const PRIVATE_CASE_NEXT:Readonly<Record<PrivateCaseStatus,readonly PrivateCaseStatus[]>>=Object.freeze({received:['in_review','closed'],in_review:['closed'],closed:[]});
export const PRIVATE_CASE_LIMITS=Object.freeze({textChars:8000,noteChars:4000,cases:100,excluded:50,handlers:500});

export type PrivateCaseErrorCode='invalid'|'not_set_up'|'not_found'|'not_allowed'|'unavailable'|'conflict';
export class PrivateCaseError extends Error{constructor(readonly code:PrivateCaseErrorCode){super('Private case: '+code);this.name='PrivateCaseError';}}
const fail=(code:PrivateCaseErrorCode):never=>{throw new PrivateCaseError(code);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
const captured=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const own=(ctx:SessionContext):ctx is SessionContext&{userId:string}=>Boolean(ctx.userId)&&!ctx.agent;
const at=(value:unknown):Date=>{const parsed=new Date(String(value));return Number.isFinite(parsed.getTime())?parsed:fail('unavailable');};
const AT=(column:SQL)=>sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Whether anyone may read the case now (0959 app.private_case_has_reader), from the row's own routing facts. */
const HAS_READER=sql`app.private_case_has_reader(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)`;
const category=(value:unknown):PrivateCaseCategory|null=>PRIVATE_CASE_CATEGORIES.find(item=>item===value)??null;
const status=(value:unknown):PrivateCaseStatus=>PRIVATE_CASE_STATUSES.find(item=>item===value)??fail('unavailable');

/** The additional data of a case's text and of one note. Exported for the tests' wrong-binding cases. */
export const privateCaseAad=(tenantId:string,caseId:string,authorUserId:string)=>JSON.stringify(['ai-hr.private-case.v1',tenantId,caseId,authorUserId,'text']);
export const privateCaseNoteAad=(tenantId:string,caseId:string,caseAuthorUserId:string,noteId:string,noteAuthorUserId:string)=>
 JSON.stringify(['ai-hr.private-case-note.v1',tenantId,caseId,caseAuthorUserId,noteId,noteAuthorUserId]);
const words=(value:unknown,max:number):string|null=>{
 if(typeof value!=='string')return null;
 const text=value.replace(/\r\n?/g,'\n').trim();
 return text&&text.length<=max?text:null;
};

/** A database refusal, by kind: a policy or privilege refusal is not_allowed; the 0959 guard's own messages name theirs. */
function refusal(error:unknown):PrivateCaseErrorCode{
 if(error instanceof PrivateCaseError)return error.code;
 const cause=(error as {cause?:{code?:unknown;message?:unknown}}|null)?.cause??(error as {code?:unknown;message?:unknown}|null);
 const code=cause?.code,message=typeof cause?.message==='string'?cause.message:'';
 if(code==='23514'&&/not set up/.test(message))return 'not_set_up';
 if(code==='23514')return 'invalid';
 if(code==='42501')return 'not_allowed';
 return 'unavailable';
}
async function guarded<T>(ctx:SessionContext,run:(tx:Tx)=>Promise<T>):Promise<T>{
 try{return await withTenant(ctx,run);}catch(error){throw new PrivateCaseError(refusal(error));}
}

// ── Intake: the author ──

export type IntakeCompany=Readonly<{id:string;name:string}>;
/** Someone who could read a case of the company: a designated handler, or a group administrator. */
export type IntakeReader=Readonly<{userId:string;name:string|null;kind:'handler'|'group_admin'}>;
export type PrivateCaseIntake=Readonly<{companies:readonly IntakeCompany[];companyId:string|null;readers:readonly IntakeReader[];storable:boolean}>;

/** The companies the caller may open a case in (a current employment there, and an eligible handler: a current grant
 * held by a current login), and everyone who could read a case of the chosen company, by name, so the person a case is
 * about, or anyone who must not see it, can be left out. The handlers listed are the set a case filed now freezes. */
export async function privateCaseIntake(supplied:SessionContext,companyId?:unknown):Promise<PrivateCaseIntake>{
 const ctx=captured(supplied);
 if(!own(ctx))return fail('not_allowed');
 return guarded(ctx,async tx=>{
  const companies=await tx.execute<{id:string;name:string}>(sql`select c.id,c.legal_name as name from public.company c
   where c.tenant_id=${ctx.tenantId}::uuid and app.private_case_author_company(c.id) and app.private_case_route_configured(c.tenant_id,c.id) is true
   order by c.legal_name,c.id`);
  const chosen=companies.find(row=>row.id===companyId)?.id??companies[0]?.id??null;
  const readers=chosen?await tx.execute<{app_user_id:string;display_name:string|null;reader_kind:string}>(sql`select app_user_id,display_name,reader_kind
   from app.private_case_intake_readers(${chosen}::uuid)`):[];
  return Object.freeze({companies:Object.freeze(companies.map(row=>Object.freeze({id:row.id,name:row.name}))),companyId:chosen,
   readers:Object.freeze(readers.map(row=>Object.freeze({userId:row.app_user_id,name:row.display_name,kind:row.reader_kind==='group_admin'?'group_admin' as const:'handler' as const}))),
   storable:isSecretStorable()});
 });
}

export type OpenPrivateCaseInput=Readonly<{companyId:unknown;category:unknown;text:unknown;excludedUserIds?:unknown;sendTo?:unknown;
 /** The handlers the intake showed the author. When given, the case's frozen handlers are narrowed to them, so a
  * handler designated after the form was opened (whom the author could neither see nor exclude) never reads it. */
 shownHandlerIds?:unknown}>;
/** Opens a case as the caller. The database sets its status, times and route (falling back to the group administrators
 * when every handler is excluded), freezes its handlers (the company's eligible handlers now, other than the author and
 * the excluded, narrowed to those shown) and refuses a company without an eligible handler. A case nobody may read is
 * still kept: `reachable` is false and the author is told so. */
export async function openPrivateCase(supplied:SessionContext,input:OpenPrivateCaseInput):Promise<Readonly<{caseId:string;reachable:boolean}>>{
 const ctx=captured(supplied);
 if(!own(ctx))return fail('not_allowed');
 const kind=category(input.category),text=words(input.text,PRIVATE_CASE_LIMITS.textChars);
 const excluded=input.excludedUserIds===undefined?[]:Array.isArray(input.excludedUserIds)?input.excludedUserIds:[input.excludedUserIds];
 const sendTo=input.sendTo===undefined||input.sendTo==='handlers'?'handlers':input.sendTo==='group_admin'?'group_admin':null;
 const shown=input.shownHandlerIds===undefined?null:Array.isArray(input.shownHandlerIds)?input.shownHandlerIds:[input.shownHandlerIds];
 if(!uuid(input.companyId)||!kind||!text||!sendTo||excluded.length>PRIVATE_CASE_LIMITS.excluded||!excluded.every(uuid)
  ||(shown!==null&&(shown.length>PRIVATE_CASE_LIMITS.handlers||!shown.every(uuid))))return fail('invalid');
 // Fail closed: no secret, no case. Never a plaintext fallback.
 if(!isSecretStorable())return fail('unavailable');
 const caseId=randomUUID(),userId=ctx.userId,companyId=input.companyId,exclusions=[...new Set(excluded as string[])].filter(id=>id!==userId);
 const ciphertext=encryptSecret(text,privateCaseAad(ctx.tenantId,caseId,userId));
 const reachable=await guarded(ctx,async tx=>{
  const handlers=shown===null?sql`null::uuid[]`:sql`array[${sql.join([...new Set(shown as string[])].map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[]`;
  await tx.execute(sql`insert into public.private_case(id,tenant_id,company_id,author_user_id,author_person_id,category,route,excluded_user_ids,handler_user_ids,body_ciphertext)
   values(${caseId}::uuid,${ctx.tenantId}::uuid,${companyId}::uuid,${userId}::uuid,
    (select u.person_id from public.app_user u where u.id=${userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid),
    ${kind},${sendTo},${sql`array[${sql.join(exclusions.map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[]`},${handlers},${ciphertext})`);
  const [row]=await tx.execute<{reachable:boolean}>(sql`select ${HAS_READER} as reachable from public.private_case c where c.id=${caseId}::uuid`);
  return row?.reachable===true;
 });
 return Object.freeze({caseId,reachable});
}

export type OwnPrivateCase=Readonly<{id:string;category:PrivateCaseCategory;status:PrivateCaseStatus;companyName:string|null;openedAt:Date;statusChangedAt:Date;
 /** False while nobody may read it (every possible reader excluded, or none configured). */
 reachable:boolean}>;
/** The caller's own cases, newest first: no text (opening one is a read and is audited). */
export async function listOwnPrivateCases(supplied:SessionContext):Promise<readonly OwnPrivateCase[]>{
 const ctx=captured(supplied);
 if(!own(ctx))return fail('not_allowed');
 return guarded(ctx,async tx=>{
  const rows=await tx.execute<{id:string;category:string;status:string;company:string|null;opened:string;changed:string;reachable:boolean}>(sql`
   select c.id,c.category,c.status,co.legal_name as company,${AT(sql`c.created_at`)} as opened,${AT(sql`c.status_changed_at`)} as changed,${HAS_READER} as reachable
   from public.private_case c left join public.company co on co.id=c.company_id and co.tenant_id=c.tenant_id
   where c.tenant_id=${ctx.tenantId}::uuid and c.author_user_id=${ctx.userId}::uuid order by c.created_at desc,c.id limit ${PRIVATE_CASE_LIMITS.cases}`);
  return Object.freeze(rows.map(row=>Object.freeze({id:row.id,category:category(row.category)??fail('unavailable'),status:status(row.status),companyName:row.company,openedAt:at(row.opened),statusChangedAt:at(row.changed),reachable:row.reachable===true})));
 });
}

export type CaseStatusStep=Readonly<{status:PrivateCaseStatus;at:Date}>;
export type OwnPrivateCaseDetail=Readonly<{id:string;category:PrivateCaseCategory;status:PrivateCaseStatus;companyName:string|null;openedAt:Date;text:string;reachable:boolean;
 /** Received when opened, then each status change, oldest first. Who changed it and who read it are not shown. */
 history:readonly CaseStatusStep[]}>;
/** Opens one of the caller's own cases: audited as a read, then decrypted. */
export async function readOwnPrivateCase(supplied:SessionContext,caseId:unknown):Promise<OwnPrivateCaseDetail>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(caseId))return fail('not_found');
 if(!isSecretStorable())return fail('unavailable');
 const userId=ctx.userId;
 return guarded(ctx,async tx=>{
  const [row]=await tx.execute<{category:string;status:string;company:string|null;opened:string;body:string;reachable:boolean}>(sql`
   select c.category,c.status,co.legal_name as company,${AT(sql`c.created_at`)} as opened,c.body_ciphertext as body,${HAS_READER} as reachable
   from public.private_case c left join public.company co on co.id=c.company_id and co.tenant_id=c.tenant_id
   where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid and c.author_user_id=${userId}::uuid`);
  if(!row)return fail('not_found');
  await audit(tx,ctx.tenantId,caseId,userId);
  const text=decryptSecret(row.body,privateCaseAad(ctx.tenantId,caseId,userId));
  const steps=await tx.execute<{kind:string;to_status:string|null;at:string}>(sql`select kind,to_status,${AT(sql`at`)} as at from public.private_case_event
   where tenant_id=${ctx.tenantId}::uuid and case_id=${caseId}::uuid and kind in ('created','status_changed') order by at,id`);
  return Object.freeze({id:caseId,category:category(row.category)??fail('unavailable'),status:status(row.status),companyName:row.company,openedAt:at(row.opened),text,reachable:row.reachable===true,
   history:Object.freeze(steps.map(step=>Object.freeze({status:step.kind==='created'?'received' as const:status(step.to_status),at:at(step.at)})))});
 });
}

/** One read audit row, as the reader; the 0959 policy refuses a reader without access to the case. */
async function audit(tx:Tx,tenantId:string,caseId:string,userId:string){
 await tx.execute(sql`insert into public.private_case_event(tenant_id,case_id,actor_user_id,kind) values(${tenantId}::uuid,${caseId}::uuid,${userId}::uuid,'read')`);
}

// ── Handling: the case's handlers ──

/** True while the caller holds a current handler grant in any company, or may handle at least one case (a group
 * administrator receiving the cases no eligible handler can). Decides whether the queue and its navigation row are
 * offered; the queue itself shows only what RLS returns. */
export async function handlesPrivateCases(supplied:SessionContext):Promise<boolean>{
 const ctx=captured(supplied);
 if(!own(ctx))return false;
 try{return await withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{handles:boolean}>(sql`select (exists(select 1 from public.private_case_handler h where h.tenant_id=${ctx.tenantId}::uuid
   and h.app_user_id=${ctx.userId}::uuid and h.revoked_at is null)
   or exists(select 1 from public.private_case c where c.tenant_id=${ctx.tenantId}::uuid
    and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)))
   and app.principal_snapshot_current() is true as handles`);
  return row?.handles===true;
 });}catch{return false;}
}

export type HandledPrivateCase=Readonly<{id:string;category:PrivateCaseCategory;status:PrivateCaseStatus;companyName:string|null;route:'handlers'|'group_admin';
 openedAt:Date;statusChangedAt:Date;erasureRequested:boolean}>;
/** The cases the caller handles, open first then newest: no text and no author (opening one is a read and is audited). */
export async function listHandledPrivateCases(supplied:SessionContext):Promise<readonly HandledPrivateCase[]>{
 const ctx=captured(supplied);
 if(!own(ctx))return fail('not_allowed');
 return guarded(ctx,async tx=>{
  const rows=await tx.execute<{id:string;category:string;status:string;company:string|null;route:string;opened:string;changed:string;erasure:boolean}>(sql`
   select c.id,c.category,c.status,co.legal_name as company,c.route,${AT(sql`c.created_at`)} as opened,${AT(sql`c.status_changed_at`)} as changed,
    c.erasure_requested_at is not null as erasure
   from public.private_case c left join public.company co on co.id=c.company_id and co.tenant_id=c.tenant_id
   where c.tenant_id=${ctx.tenantId}::uuid and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)
   order by (c.status='closed'),c.created_at desc,c.id limit ${PRIVATE_CASE_LIMITS.cases}`);
  return Object.freeze(rows.map(row=>Object.freeze({id:row.id,category:category(row.category)??fail('unavailable'),status:status(row.status),companyName:row.company,
   route:row.route==='group_admin'?'group_admin' as const:'handlers' as const,openedAt:at(row.opened),statusChangedAt:at(row.changed),erasureRequested:row.erasure===true})));
 });
}

export type CaseNote=Readonly<{id:string;author:string|null;own:boolean;at:Date;text:string}>;
export type CaseAuditRow=Readonly<{kind:'created'|'read'|'status_changed'|'note_added';actor:string|null;own:boolean;at:Date;from:PrivateCaseStatus|null;to:PrivateCaseStatus|null}>;
export type HandledPrivateCaseDetail=HandledPrivateCase&Readonly<{author:string|null;version:number;text:string;notes:readonly CaseNote[];audit:readonly CaseAuditRow[];
 next:readonly PrivateCaseStatus[]}>;
/** Opens a case the caller handles: audited as a read, then its text and notes decrypted. */
export async function readHandledPrivateCase(supplied:SessionContext,caseId:unknown):Promise<HandledPrivateCaseDetail>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(caseId))return fail('not_found');
 if(!isSecretStorable())return fail('unavailable');
 const userId=ctx.userId;
 return guarded(ctx,async tx=>{
  const [row]=await tx.execute<{category:string;status:string;company:string|null;route:string;opened:string;changed:string;erasure:boolean;author:string;version:number;body:string}>(sql`
   select c.category,c.status,co.legal_name as company,c.route,${AT(sql`c.created_at`)} as opened,${AT(sql`c.status_changed_at`)} as changed,
    c.erasure_requested_at is not null as erasure,c.author_user_id as author,c.version,c.body_ciphertext as body
   from public.private_case c left join public.company co on co.id=c.company_id and co.tenant_id=c.tenant_id
   where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid
    and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)`);
  if(!row)return fail('not_found');
  await audit(tx,ctx.tenantId,caseId,userId);
  const text=decryptSecret(row.body,privateCaseAad(ctx.tenantId,caseId,row.author));
  const names=new Map((await tx.execute<{app_user_id:string;display_name:string|null}>(sql`select app_user_id,display_name from app.private_case_names(${caseId}::uuid)`))
   .map(name=>[name.app_user_id,name.display_name] as const));
  const notes=await tx.execute<{id:string;author:string;at:string;body:string}>(sql`select id,author_user_id as author,${AT(sql`created_at`)} as at,body_ciphertext as body
   from public.private_case_note where tenant_id=${ctx.tenantId}::uuid and case_id=${caseId}::uuid order by created_at,id`);
  const events=await tx.execute<{kind:string;actor:string;at:string;from_status:string|null;to_status:string|null}>(sql`select kind,actor_user_id as actor,${AT(sql`at`)} as at,from_status,to_status
   from public.private_case_event where tenant_id=${ctx.tenantId}::uuid and case_id=${caseId}::uuid order by at,id`);
  const current=status(row.status);
  return Object.freeze({id:caseId,category:category(row.category)??fail('unavailable'),status:current,companyName:row.company,
   route:row.route==='group_admin'?'group_admin' as const:'handlers' as const,openedAt:at(row.opened),statusChangedAt:at(row.changed),erasureRequested:row.erasure===true,
   author:names.get(row.author)??null,version:row.version,text,next:PRIVATE_CASE_NEXT[current],
   notes:Object.freeze(notes.map(note=>Object.freeze({id:note.id,author:names.get(note.author)??null,own:note.author===userId,at:at(note.at),
    text:decryptSecret(note.body,privateCaseNoteAad(ctx.tenantId,caseId,row.author,note.id,note.author))}))),
   audit:Object.freeze(events.map(event=>Object.freeze({kind:(['created','read','status_changed','note_added'] as const).find(kind=>kind===event.kind)??fail('unavailable'),
    actor:names.get(event.actor)??null,own:event.actor===userId,at:at(event.at),from:event.from_status?status(event.from_status):null,to:event.to_status?status(event.to_status):null})))});
 });
}

/** A handler adds an encrypted note to an open case. Notes are never shown to the author. */
export async function addPrivateCaseNote(supplied:SessionContext,input:Readonly<{caseId:unknown;text:unknown}>):Promise<Readonly<{noteId:string}>>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(input.caseId))return fail('not_found');
 const text=words(input.text,PRIVATE_CASE_LIMITS.noteChars);
 if(!text)return fail('invalid');
 if(!isSecretStorable())return fail('unavailable');
 const caseId=input.caseId,userId=ctx.userId,noteId=randomUUID();
 await guarded(ctx,async tx=>{
  const [row]=await tx.execute<{author:string;status:string}>(sql`select author_user_id as author,status from public.private_case c
   where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)`);
  if(!row)return fail('not_found');
  if(row.status==='closed')return fail('conflict');
  const ciphertext=encryptSecret(text,privateCaseNoteAad(ctx.tenantId,caseId,row.author,noteId,userId));
  await tx.execute(sql`insert into public.private_case_note(id,tenant_id,case_id,author_user_id,body_ciphertext)
   values(${noteId}::uuid,${ctx.tenantId}::uuid,${caseId}::uuid,${userId}::uuid,${ciphertext})`);
 });
 return Object.freeze({noteId});
}

/** A handler moves a case on (received -> in review -> closed). `expected` is the status the handler saw, so a stale
 * page cannot repeat or skip a step. A case person erasure met open is deleted as it closes. */
export async function setPrivateCaseStatus(supplied:SessionContext,input:Readonly<{caseId:unknown;expected:unknown;status:unknown}>):Promise<Readonly<{status:PrivateCaseStatus;erased:boolean}>>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(input.caseId))return fail('not_found');
 const expected=PRIVATE_CASE_STATUSES.find(item=>item===input.expected),wanted=PRIVATE_CASE_STATUSES.find(item=>item===input.status);
 if(!expected||!wanted||!PRIVATE_CASE_NEXT[expected].includes(wanted))return fail('invalid');
 const caseId=input.caseId;
 return guarded(ctx,async tx=>{
  const [row]=await tx.execute<{status:string;erasure:boolean}>(sql`update public.private_case c set status=${wanted}
   where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid and c.status=${expected}
    and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)
   returning c.status,c.erasure_requested_at is not null as erasure`);
  if(!row){
   const [seen]=await tx.execute<{id:string}>(sql`select c.id from public.private_case c where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid
    and app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids)`);
   return fail(seen?'conflict':'not_found');
  }
  let erased=false;
  if(row.status==='closed'&&row.erasure){
   erased=(await tx.execute<{id:string}>(sql`delete from public.private_case where tenant_id=${ctx.tenantId}::uuid and id=${caseId}::uuid returning id`)).length===1;
   if(!erased)return fail('unavailable');
  }
  return Object.freeze({status:status(row.status),erased});
 });
}

// ── Designation: group and company HR administrators ──

export type CaseHandlerGrant=Readonly<{id:string;userId:string;name:string|null;grantedAt:Date;revokedAt:Date|null}>;
export type CaseHandlerCandidate=Readonly<{userId:string;name:string|null}>;
export type CaseHandlerAdmin=Readonly<{companies:readonly IntakeCompany[];companyId:string|null;grants:readonly CaseHandlerGrant[];
 /** Logins that could be designated: never the administrator themself (coordinator decision, 3 November 2026). */
 candidates:readonly CaseHandlerCandidate[]}>;
/** The handlers of one company the caller administers, current and revoked, and the logins that could be designated. */
export async function caseHandlerAdmin(supplied:SessionContext,companyId?:unknown):Promise<CaseHandlerAdmin>{
 const ctx=captured(supplied);
 if(!own(ctx)||!isAdmin(ctx))return fail('not_allowed');
 return guarded(ctx,async tx=>{
  const companies=await tx.execute<{id:string;name:string}>(sql`select c.id,c.legal_name as name from public.company c
   where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) order by c.legal_name,c.id`);
  const chosen=companies.find(row=>row.id===companyId)?.id??companies[0]?.id??null;
  if(!chosen)return Object.freeze({companies:Object.freeze([]),companyId:null,grants:Object.freeze([]),candidates:Object.freeze([])});
  const grants=await tx.execute<{id:string;user_id:string;name:string|null;granted:string;revoked:string|null}>(sql`
   select h.id,h.app_user_id as user_id,coalesce(nullif(btrim(p.preferred_name),''),p.full_name) as name,${AT(sql`h.granted_at`)} as granted,
    case when h.revoked_at is null then null else ${AT(sql`h.revoked_at`)} end as revoked
   from public.private_case_handler h left join public.app_user u on u.id=h.app_user_id and u.tenant_id=h.tenant_id
   left join public.person p on p.id=u.person_id and p.tenant_id=u.tenant_id
   where h.tenant_id=${ctx.tenantId}::uuid and h.company_id=${chosen}::uuid order by h.revoked_at is not null,h.granted_at desc,h.id`);
  const active=new Set(grants.filter(grant=>!grant.revoked).map(grant=>grant.user_id));
  const candidates=await tx.execute<{id:string;name:string|null}>(sql`select u.id,coalesce(nullif(btrim(p.preferred_name),''),p.full_name) as name
   from public.app_user u left join public.person p on p.id=u.person_id and p.tenant_id=u.tenant_id
   where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) order by 2 nulls last,1`);
  return Object.freeze({companies:Object.freeze(companies.map(row=>Object.freeze({id:row.id,name:row.name}))),companyId:chosen,
   grants:Object.freeze(grants.map(grant=>Object.freeze({id:grant.id,userId:grant.user_id,name:grant.name,grantedAt:at(grant.granted),revokedAt:grant.revoked?at(grant.revoked):null}))),
   candidates:Object.freeze(candidates.filter(row=>!active.has(row.id)&&row.id!==ctx.userId).map(row=>Object.freeze({userId:row.id,name:row.name})))});
 });
}

/** Designates a login as a case handler for a company. The database admits only a current administrator of that
 * company, and never for themself, even in a company with one administrator (a group administrator designates them);
 * audited as a domain event. */
export async function designateCaseHandler(supplied:SessionContext,input:Readonly<{companyId:unknown;appUserId:unknown}>):Promise<Readonly<{handlerId:string}>>{
 const ctx=captured(supplied);
 if(!own(ctx)||!isAdmin(ctx))return fail('not_allowed');
 if(!uuid(input.companyId)||!uuid(input.appUserId))return fail('invalid');
 const companyId=input.companyId,appUserId=input.appUserId;
 return guarded(ctx,async tx=>{
  const [row]=await tx.execute<{id:string}>(sql`insert into public.private_case_handler(tenant_id,company_id,app_user_id,granted_by_user_id)
   values(${ctx.tenantId}::uuid,${companyId}::uuid,${appUserId}::uuid,${ctx.userId}::uuid) on conflict do nothing returning id`);
  if(!row)return fail('conflict');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'private-case-handler',aggregateId:row.id,eventType:'private-case-handler.designated',actor:actorOf(ctx),payload:{companyId,appUserId}});
  return Object.freeze({handlerId:row.id});
 });
}

/** Revokes a current handler grant; the row stays as history. Audited as a domain event. */
export async function revokeCaseHandler(supplied:SessionContext,input:Readonly<{handlerId:unknown}>):Promise<void>{
 const ctx=captured(supplied);
 if(!own(ctx)||!isAdmin(ctx))return fail('not_allowed');
 if(!uuid(input.handlerId))return fail('invalid');
 const handlerId=input.handlerId;
 await guarded(ctx,async tx=>{
  const [row]=await tx.execute<{company_id:string;app_user_id:string}>(sql`update public.private_case_handler set revoked_by_user_id=${ctx.userId}::uuid,revoked_at=now()
   where tenant_id=${ctx.tenantId}::uuid and id=${handlerId}::uuid and revoked_at is null returning company_id,app_user_id`);
  if(!row)return fail('not_found');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'private-case-handler',aggregateId:handlerId,eventType:'private-case-handler.revoked',actor:actorOf(ctx),
   payload:{companyId:row.company_id,appUserId:row.app_user_id}});
 });
}
