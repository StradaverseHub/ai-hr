/** Board 0735d1b7 — combine duplicate LOGINS under one Master Login Account, and undo it. Human-decided only: HR picks
 * the master on the duplicate tabs (core/login-duplicates.ts), ticks what the master should take over, types the
 * confirmation and a reason. Nothing is decided by a model and nothing is matched by email on its own.
 *
 * A merge combines app_user rows only. PERSON, EMPLOYEE, EMPLOYMENT, payroll, leave and every other HR record are not
 * read for writing and never change; no app_user, external identity, credential or grant is deleted and no id is
 * rewritten (the many references to app_user.id keep pointing at the login that made them). Each merged login is
 * switched off through its existing archived_at (app.principal_by_subject then refuses it at sign-in and on the next
 * page) and its internal sessions end (core/account-management.ts endManagedAccountSessionsTx). Its own grants stay on
 * it. The facts are kept in app_user_merge (migration 7600), written only through definers.
 *
 * One transaction per command under the exclusive Access lock (grants and logins are authority inputs): authorization,
 * the re-read of the group, the state change, the carried grants through their existing writers, the facts and the
 * audit events commit together. Undo merge restores the merged login's archived_at exactly as it was and removes only the
 * carried grants HR ticks (they are listed, never removed automatically). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf,subjectEmploymentForPerson} from '../db/events';
import {uuidArrayParam} from '../db/sql-arrays';
import {pgErrorChain} from '../lib/db-error';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {assignRoleTx,revokeRoleTx} from './admin';
import {grantAssistantTx,revokeAssistantTx} from './assistant-grant';
import {assertGroupAdminRemainsTx} from './auth';
import {endManagedAccountSessionsTx} from './account-management';
import {assertLoginDuplicatesAdmin,isGroupDigest,isLoginId,loginDuplicateGroupTx,MERGE_MAX_ACCOUNTS,type DuplicateBasis} from './login-duplicates';

export class LoginMergeError extends Error{
 constructor(readonly code:'forbidden'|'invalid'|'stale'|'master-merged'|'member-is-master'|'own-login'|'last-admin'|'confirmation'|'already-undone'|'carry',message:string){super(message);this.name='LoginMergeError';}
}
/** The word HR types to confirm a merge. */
export const MERGE_CONFIRMATION='MERGE';

export type MergeGrant={roleAssignmentId:string;appUserId:string;role:string;companyId:string|null;companyName:string|null};
/** What the other accounts hold and the master does not: the only grants the confirmation offers to carry. */
export type MergeOffer={roles:MergeGrant[];assistantFrom:string|null};
export type MergeInput={basis:DuplicateBasis;groupDigest:string;masterId:string;mergedIds:string[];
 carry:{roleAssignmentIds:string[];assistant:boolean};reason:string;confirmation:string};
export type UndoMergeInput={mergeId:string;reason:string;removeCarried:{roleAssignmentIds:string[];assistant:boolean}};
type Carried={roleAssignmentIds?:string[];assistantGrantId?:string|null};

const reasonOf=(value:unknown)=>{const text=typeof value==='string'?value.trim():'';if(text.length<5||text.length>500)throw new LoginMergeError('invalid','Enter a reason of 5 to 500 characters.');return text;};
const ids=(value:unknown,max:number)=>{
 if(!Array.isArray(value)||value.length>max||!value.every(isLoginId))throw new LoginMergeError('invalid','The request was not valid.');
 return [...new Set(value.map(v=>v.toLowerCase()))];
};

/** Grants of the listed logins with company names, one statement. */
async function grantsTx(tx:Tx,tenantId:string,userIds:readonly string[]){
 const roles=await tx.execute<{id:string;app_user_id:string;role:string;company_id:string|null;company_name:string|null}>(sql`
  select r.id::text,r.app_user_id::text,r.role::text,r.company_id::text,c.legal_name as company_name from role_assignment r
  left join company c on c.id=r.company_id and c.tenant_id=r.tenant_id
  where r.tenant_id=${tenantId}::uuid and r.app_user_id=any(${uuidArrayParam(userIds)}) order by r.app_user_id,r.role,r.company_id nulls first,r.id`);
 const assistant=await tx.execute<{id:string;app_user_id:string}>(sql`select g.id::text,g.app_user_id::text from assistant_grant g
  where g.tenant_id=${tenantId}::uuid and g.revoked_at is null and g.app_user_id=any(${uuidArrayParam(userIds)})`);
 return {roles:[...roles],assistant:new Map([...assistant].map(a=>[a.app_user_id,a.id]))};
}
/** The offer for one master: each (role, company) another account holds and the master lacks, once. */
export function mergeOffer(masterId:string,roles:readonly {id:string;app_user_id:string;role:string;company_id:string|null;company_name:string|null}[],assistant:ReadonlyMap<string,string>):MergeOffer{
 const key=(r:{role:string;company_id:string|null})=>`${r.role}|${r.company_id??''}`;
 const held=new Set(roles.filter(r=>r.app_user_id===masterId).map(key)),seen=new Set<string>(),offer:MergeGrant[]=[];
 for(const r of roles){if(r.app_user_id===masterId||held.has(key(r))||seen.has(key(r)))continue;seen.add(key(r));
  offer.push({roleAssignmentId:r.id,appUserId:r.app_user_id,role:r.role,companyId:r.company_id,companyName:r.company_name});}
 const from=assistant.has(masterId)?null:[...assistant.keys()].filter(id=>id!==masterId).sort()[0]??null;
 return{roles:offer,assistantFrom:from};
}
/** The carry offer for the confirmation screen (group admins only). */
export async function readMergeOffer(ctx:SessionContext,masterId:string,memberIds:readonly string[]):Promise<MergeOffer&{grants:MergeGrant[];assistantHolders:string[]}>{
 assertLoginDuplicatesAdmin(ctx);
 const all=[...new Set([masterId,...memberIds])];if(!all.every(isLoginId))throw new LoginMergeError('invalid','The request was not valid.');
 return withTenant(ctx,async tx=>{
  const {roles,assistant}=await grantsTx(tx,ctx.tenantId,all);
  return{...mergeOffer(masterId,roles,assistant),grants:roles.map(r=>({roleAssignmentId:r.id,appUserId:r.app_user_id,role:r.role,companyId:r.company_id,companyName:r.company_name})),
   assistantHolders:[...assistant.keys()]};
 });
}

/** Drizzle wraps a database refusal; the definer's own words are on the driver error beneath it. */
const refusalText=(error:unknown)=>pgErrorChain(error).map(link=>link.message??'').join(' | ');
const refusal=(error:unknown):never=>{
 const message=refusalText(error);
 if(/master merged/.test(message))throw new LoginMergeError('master-merged','The chosen master was itself merged into another login.');
 if(/member is master/.test(message))throw new LoginMergeError('member-is-master','An account in this group is already a master and must stay the master.');
 if(/own login/.test(message))throw new LoginMergeError('own-login','You cannot merge away your own login.');
 if(/app_user_merge_active_uq/.test(message))throw new LoginMergeError('stale','This group changed after the screen opened. Open it again.');
 throw error;
};

/** Merge every other account of one current duplicate group into the chosen master. Returns the merge ids. */
export async function mergeLogins(ctx:SessionContext,input:MergeInput):Promise<{mergeIds:string[]}>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 try{assertLoginDuplicatesAdmin(ctx);}catch{throw new LoginMergeError('forbidden','Only a group administrator can merge logins.');}
 if(!['ic','passport','email'].includes(input.basis)||!isGroupDigest(input.groupDigest)||!isLoginId(input.masterId))throw new LoginMergeError('invalid','The request was not valid.');
 const masterId=input.masterId.toLowerCase(),mergedIds=ids(input.mergedIds,MERGE_MAX_ACCOUNTS-1),reason=reasonOf(input.reason);
 const carryRoles=ids(input.carry?.roleAssignmentIds??[],200),carryAssistant=input.carry?.assistant===true;
 if(!mergedIds.length||mergedIds.includes(masterId))throw new LoginMergeError('invalid','Choose the master and at least one other account.');
 if(String(input.confirmation??'').trim().toUpperCase()!==MERGE_CONFIRMATION)throw new LoginMergeError('confirmation',`Type ${MERGE_CONFIRMATION} to confirm.`);
 if(ctx.userId&&mergedIds.includes(ctx.userId.toLowerCase()))throw new LoginMergeError('own-login','You cannot merge away your own login.');
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  // The screen may be stale: the group is read again here, under the lock, and must be exactly what HR confirmed.
  const group=await loginDuplicateGroupTx(tx,ctx.tenantId,input.groupDigest);
  const confirmed=[masterId,...mergedIds].sort();
  if(!group||group.basis!==input.basis||group.members.length!==confirmed.length||group.members.some((id,i)=>id!==confirmed[i]))
   throw new LoginMergeError('stale','This group changed after the screen opened. Open it again.');
  const masters=await tx.execute<{merged_app_user_id:string;master_app_user_id:string}>(sql`select merged_app_user_id::text,master_app_user_id::text from app.login_merge_active()`);
  if(masters.some(m=>m.merged_app_user_id===masterId))throw new LoginMergeError('master-merged','The chosen master was itself merged into another login.');
  if(masters.some(m=>mergedIds.includes(m.master_app_user_id)))throw new LoginMergeError('member-is-master','An account in this group is already a master and must stay the master.');
  try{await assertGroupAdminRemainsTx(tx,mergedIds);}catch{throw new LoginMergeError('last-admin','This merge would leave no group administrator able to sign in.');}
  // Carry only what HR ticked, and only what the confirmation offered (another account holds it, the master lacks it).
  const {roles,assistant}=await grantsTx(tx,ctx.tenantId,confirmed);
  const offer=mergeOffer(masterId,roles,assistant),offered=new Map(offer.roles.map(r=>[r.roleAssignmentId,r]));
  if(carryRoles.some(id=>!offered.has(id))||(carryAssistant&&!offer.assistantFrom))throw new LoginMergeError('carry','The access to carry over changed. Open the group again.');
  const before=await tx.execute<{id:string;person_id:string|null;archived_at:string|null}>(sql`select id::text,person_id::text,archived_at::text from app_user
   where tenant_id=${ctx.tenantId}::uuid and id=any(${uuidArrayParam(confirmed)}) order by id for update`);
  const byId=new Map([...before].map(r=>[r.id,r]));
  if(byId.size!==confirmed.length)throw new LoginMergeError('stale','This group changed after the screen opened. Open it again.');
  const carried=new Map<string,Carried>(mergedIds.map(id=>[id,{roleAssignmentIds:[] as string[],assistantGrantId:null}]));
  for(const id of carryRoles){
   const grant=offered.get(id)!;
   const created=await assignRoleTx(tx,ctx,{appUserId:masterId,role:grant.role as Parameters<typeof assignRoleTx>[2]['role'],companyId:grant.companyId});
   carried.get(grant.appUserId)!.roleAssignmentIds!.push(created.id);
  }
  if(carryAssistant&&offer.assistantFrom)carried.get(offer.assistantFrom)!.assistantGrantId=(await grantAssistantTx(tx,ctx,{appUserId:masterId})).id;
  const master=byId.get(masterId)!,masterSubject=await subjectEmploymentForPerson(tx,ctx.tenantId,master.person_id);
  const mergeIds:string[]=[];
  for(const mergedId of mergedIds){
   const row=byId.get(mergedId)!;
   await tx.execute(sql`update app_user set archived_at=coalesce(archived_at,now()) where id=${mergedId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
   const sessionsEnded=await endManagedAccountSessionsTx(tx,ctx,mergedId);
   const [record]=await tx.execute<{id:string}>(sql`select app.login_merge_record(${masterId}::uuid,${mergedId}::uuid,${input.basis},
    ${input.groupDigest},${row.archived_at}::timestamptz,${JSON.stringify(carried.get(mergedId))}::jsonb,${reason}) as id`).catch(refusal);
   mergeIds.push(record.id);
   const c=carried.get(mergedId)!;
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:mergedId,eventType:'app-user.merged',actor:actorOf(ctx),
    subjectEmploymentId:await subjectEmploymentForPerson(tx,ctx.tenantId,row.person_id),
    payload:{reason,mergeId:record.id,role:'merged',masterId,basis:input.basis,sessionsEnded}});
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:masterId,eventType:'app-user.merged',actor:actorOf(ctx),subjectEmploymentId:masterSubject,
    payload:{reason,mergeId:record.id,role:'master',mergedId,basis:input.basis,carriedRoles:c.roleAssignmentIds?.length??0,carriedAssistant:Boolean(c.assistantGrantId)}});
  }
  return{mergeIds};
 });
}

/** Undo one merge: the merged login gets back exactly the archived_at it had before; only the carried grants HR ticks
 * are removed from the master (through their existing revoke writers); everything else stays. */
export async function undoLoginMerge(ctx:SessionContext,input:UndoMergeInput):Promise<{mergedId:string;masterId:string}>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 try{assertLoginDuplicatesAdmin(ctx);}catch{throw new LoginMergeError('forbidden','Only a group administrator can undo a merge.');}
 if(!isLoginId(input.mergeId))throw new LoginMergeError('invalid','The request was not valid.');
 const reason=reasonOf(input.reason),removeRoles=ids(input.removeCarried?.roleAssignmentIds??[],200),removeAssistant=input.removeCarried?.assistant===true;
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  const [undone]=await tx.execute<{master_app_user_id:string;merged_app_user_id:string;prior_archived_at:string|null;carried:Carried}>(sql`
   select master_app_user_id::text,merged_app_user_id::text,prior_archived_at::text,carried from app.login_merge_undo_record(${input.mergeId}::uuid,${reason})`)
   .catch((error:unknown)=>{const m=refusalText(error);
    if(/already undone/.test(m))throw new LoginMergeError('already-undone','This merge was already undone.');
    if(/forbidden/.test(m))throw new LoginMergeError('forbidden','This merge is not available.');throw error;});
  if(!undone)throw new LoginMergeError('forbidden','This merge is not available.');
  const carriedRoles=new Set(undone.carried?.roleAssignmentIds??[]);
  if(removeRoles.some(id=>!carriedRoles.has(id))||(removeAssistant&&!undone.carried?.assistantGrantId))throw new LoginMergeError('carry','Only access this merge carried over can be removed here.');
  const existing=removeRoles.length?await tx.execute<{id:string}>(sql`select id::text from role_assignment where tenant_id=${ctx.tenantId}::uuid and app_user_id=${undone.master_app_user_id}::uuid and id=any(${uuidArrayParam(removeRoles)})`):[];
  for(const {id} of existing)await revokeRoleTx(tx,ctx,{roleAssignmentId:id});
  if(removeAssistant){
   const [live]=await tx.execute<{id:string}>(sql`select id::text from assistant_grant where tenant_id=${ctx.tenantId}::uuid and app_user_id=${undone.master_app_user_id}::uuid and revoked_at is null`);
   if(live?.id===undone.carried?.assistantGrantId)await revokeAssistantTx(tx,ctx,{appUserId:undone.master_app_user_id});
  }
  const [merged]=await tx.execute<{person_id:string|null}>(sql`update app_user set archived_at=${undone.prior_archived_at}::timestamptz
   where id=${undone.merged_app_user_id}::uuid and tenant_id=${ctx.tenantId}::uuid returning person_id::text`);
  const [master]=await tx.execute<{person_id:string|null}>(sql`select person_id::text from app_user where id=${undone.master_app_user_id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  for(const [id,personId,role] of [[undone.merged_app_user_id,merged?.person_id??null,'merged'],[undone.master_app_user_id,master?.person_id??null,'master']] as const)
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:id,eventType:'app-user.merge-undone',actor:actorOf(ctx),
    subjectEmploymentId:await subjectEmploymentForPerson(tx,ctx.tenantId,personId),
    payload:{reason,mergeId:input.mergeId,role,...(role==='merged'?{masterId:undone.master_app_user_id}:{mergedId:undone.merged_app_user_id}),
     removedRoles:existing.length,removedAssistant:removeAssistant}});
  return{mergedId:undone.merged_app_user_id,masterId:undone.master_app_user_id};
 });
}

/** The tenant's active merges, merged login -> master, one statement (the Users list leaves merged logins out). */
export async function listActiveMergedLogins(ctx:SessionContext):Promise<Map<string,string>>{
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{merged_app_user_id:string;master_app_user_id:string}>(sql`select merged_app_user_id::text,master_app_user_id::text from app.login_merge_active()`);
  return new Map([...rows].map(r=>[r.merged_app_user_id,r.master_app_user_id]));
 });
}

export type LoginMergeFact={id:string;masterId:string;mergedId:string;basis:DuplicateBasis;mergedByName:string|null;mergedAt:string;reason:string;
 undoneByName:string|null;undoneAt:string|null;undoReason:string|null;carried:{roles:MergeGrant[];assistant:boolean}};
export type LoginMergeState={
 /** This login is merged away now: the active fact, with what it carried that still exists on the master. */
 mergedInto:(LoginMergeFact&{masterName:string|null})|null;
 /** This login is a master: its active merged logins. */
 mergedLogins:{mergeId:string;appUserId:string;name:string|null;mergedAt:string}[];
 history:LoginMergeFact[];
};
/** The merge facts naming one login, for its account page (group administrators only). Three statements. */
export async function readLoginMergeState(ctx:SessionContext,userId:string):Promise<LoginMergeState>{
 assertLoginDuplicatesAdmin(ctx);
 if(!isLoginId(userId))throw new LoginMergeError('invalid','The request was not valid.');
 return withTenant(ctx,async tx=>{
  const facts=[...await tx.execute<{id:string;master_app_user_id:string;merged_app_user_id:string;match_basis:DuplicateBasis;carried:Carried;merged_by_name:string|null;
   merged_at:Date|string;reason:string;undone_by_name:string|null;undone_at:Date|string|null;undo_reason:string|null}>(sql`select id::text,master_app_user_id::text,merged_app_user_id::text,match_basis,carried,
   merged_by_name,merged_at,reason,undone_by_name,undone_at,undo_reason from app.login_merge_facts(${userId}::uuid)`)];
  const people=[...new Set(facts.flatMap(f=>[f.master_app_user_id,f.merged_app_user_id]))];
  const names=new Map<string,string|null>();
  if(people.length)for(const r of await tx.execute<{id:string;name:string|null}>(sql`select u.id::text,p.full_name as name from app_user u
   left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.id=any(${uuidArrayParam(people)})`))names.set(r.id,r.name);
  const carriedIds=[...new Set(facts.flatMap(f=>f.undone_at?[]:f.carried?.roleAssignmentIds??[]))];
  const live=carriedIds.length?[...await tx.execute<{id:string;app_user_id:string;role:string;company_id:string|null;company_name:string|null}>(sql`
   select r.id::text,r.app_user_id::text,r.role::text,r.company_id::text,c.legal_name as company_name from role_assignment r left join company c on c.id=r.company_id and c.tenant_id=r.tenant_id
   where r.tenant_id=${ctx.tenantId}::uuid and r.id=any(${uuidArrayParam(carriedIds)})`)]:[];
  const assistantIds=facts.flatMap(f=>!f.undone_at&&f.carried?.assistantGrantId?[f.carried.assistantGrantId]:[]);
  const liveAssistant=new Set(assistantIds.length?[...await tx.execute<{id:string}>(sql`select id::text from assistant_grant where tenant_id=${ctx.tenantId}::uuid and revoked_at is null and id=any(${uuidArrayParam(assistantIds)})`)].map(r=>r.id):[]);
  const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
  const toFact=(f:typeof facts[number]):LoginMergeFact=>({id:f.id,masterId:f.master_app_user_id,mergedId:f.merged_app_user_id,basis:f.match_basis,mergedByName:f.merged_by_name,
   mergedAt:iso(f.merged_at)!,reason:f.reason,undoneByName:f.undone_by_name,undoneAt:iso(f.undone_at),undoReason:f.undo_reason,
   carried:{roles:live.filter(r=>(f.carried?.roleAssignmentIds??[]).includes(r.id)).map(r=>({roleAssignmentId:r.id,appUserId:r.app_user_id,role:r.role,companyId:r.company_id,companyName:r.company_name})),
    assistant:Boolean(f.carried?.assistantGrantId&&liveAssistant.has(f.carried.assistantGrantId))}});
  const active=facts.find(f=>!f.undone_at&&f.merged_app_user_id===userId);
  return{
   mergedInto:active?{...toFact(active),masterName:names.get(active.master_app_user_id)??null}:null,
   mergedLogins:facts.filter(f=>!f.undone_at&&f.master_app_user_id===userId).map(f=>({mergeId:f.id,appUserId:f.merged_app_user_id,name:names.get(f.merged_app_user_id)??null,mergedAt:iso(f.merged_at)!})),
   history:facts.map(toFact),
  };
 });
}
