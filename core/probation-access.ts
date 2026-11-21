/**
 * Probation access (handoff B7; migration 5763): named roles with permissions in two families, members scoped by
 * business group and company with validity dates, and the Direct Superiors rule.
 *
 * Every read and write goes through the database owners (app.probation_access_*), which decide authority (a System
 * Administrator or the existing "manage access" capability), take the write lock and record the domain event. Reads are
 * one bounded statement. Nothing here grants anything by itself; enforcement lives in the Probation authority owners.
 */
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {pgErrorChain} from '../lib/db-error';
import {ProbationError} from '../lib/probation-model';
import {withScopedLifecycleTenant} from './module-gate';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
export const PROBATION_CASE_PERMISSIONS=['cases.view','cases.letters','cases.low_result','cases.route'] as const;
export const PROBATION_SETTINGS_PERMISSIONS=['settings.configure','settings.intake','settings.postings'] as const;
export type ProbationAccessPermission=(typeof PROBATION_CASE_PERMISSIONS)[number]|(typeof PROBATION_SETTINGS_PERMISSIONS)[number];
const PERMISSIONS:readonly string[]=[...PROBATION_CASE_PERMISSIONS,...PROBATION_SETTINGS_PERMISSIONS];

export type ProbationAccessMember={id:string;userId:string;name:string;businessGroupId:string|null;companyId:string|null;validFrom:string;validTo:string|null};
export type ProbationAccessRole={id:string;name:string;permissions:ProbationAccessPermission[];revision:number;members:ProbationAccessMember[]};
export type ProbationSuperiorRule={enabled:boolean;view:boolean;recordDeclined:boolean;revision:number};
export type ProbationAccessView={
 rule:ProbationSuperiorRule;roles:ProbationAccessRole[];
 /** PBP and GBS assignments made before roles existed; still in force, shown read-only. */
 earlier:{role:'pbp'|'gbs';name:string;companyId:string;validFrom:string;validTo:string|null}[];
 companies:{id:string;name:string;businessGroupId:string}[];businessGroups:{id:string;name:string}[];
};
export type ProbationAccessNavigation={configure:boolean;intake:boolean;access:boolean};

function refusal(error:unknown):never{
 const database=pgErrorChain(error).find(link=>link.code&&/^[0-9A-Z]{5}$/.test(link.code));
 if(database?.code==='42501')throw new ProbationError('forbidden',database.message??'You cannot change Probation access.');
 if(database?.code==='40001')throw new ProbationError('conflict',database.message??'This changed since you opened it. Reload and try again.');
 if(database?.code==='22023'||database?.code==='23505')throw new ProbationError(database.code==='23505'?'conflict':'invalid',database.message??'The change was refused.');
 throw error;
}
const id=(value:string|null|undefined,what:string)=>{if(value==null||value==='')return null;if(!UUID.test(value))throw new ProbationError('invalid',`Choose a valid ${what}.`);return value;};
const day=(value:string|null|undefined,what:string)=>{if(value==null||value==='')return null;if(!DAY.test(value))throw new ProbationError('invalid',`Choose a valid ${what} date.`);return value;};

/** Whether the caller may open /lifecycle/probation/access (System Administrator or manage access). */
export function probationAccessAllowed(ctx:SessionContext):Promise<boolean>{
 return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{ok:boolean}>(sql`select app.probation_access_admin() as ok`);return !!row?.ok;});
}
/** What role membership adds to Probation navigation; app.probation_navigation_access answers the rest. */
export function probationAccessNavigation(ctx:SessionContext):Promise<ProbationAccessNavigation>{
 return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{data:ProbationAccessNavigation}>(sql`select app.probation_access_navigation() as data`);return row.data;});
}
/** The Access page: null when the caller may not open it. */
export function probationAccessView(ctx:SessionContext):Promise<ProbationAccessView|null>{
 return withScopedLifecycleTenant(ctx,async tx=>{
  const[allowed]=await tx.execute<{ok:boolean}>(sql`select app.probation_access_admin() as ok`);
  if(!allowed?.ok)return null;
  const[row]=await tx.execute<{data:ProbationAccessView}>(sql`select app.probation_access_view() as data`);
  return row.data;
 });
}
export function searchProbationAccessPeople(ctx:SessionContext,query:string):Promise<{id:string;name:string}[]>{
 const search=query.trim().slice(0,100);
 if(search.length<2)return Promise.resolve([]);
 return withScopedLifecycleTenant(ctx,async tx=>{try{return [...await tx.execute<{id:string;name:string}>(sql`select id,name from app.probation_access_people(${search})`)];}catch(error){return refusal(error);}});
}
export function saveProbationAccessRole(ctx:SessionContext,input:{roleId:string|null;name:string;permissions:string[];expectedRevision:number}):Promise<{id:string;revision:number}>{
 const roleId=id(input.roleId,'role');
 if(!Array.isArray(input.permissions)||input.permissions.some(p=>!PERMISSIONS.includes(p)))throw new ProbationError('invalid','Choose permissions from the list.');
 if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new ProbationError('invalid','Reload the role and try again.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{data:{id:string;revision:number}}>(sql`select app.probation_access_role_save(${roleId}::uuid,${input.name},${`{${[...new Set(input.permissions)].join(',')}}`}::text[],${input.expectedRevision}) as data`);return row.data;}
  catch(error){return refusal(error);}
 });
}
export function retireProbationAccessRole(ctx:SessionContext,input:{roleId:string;expectedRevision:number;reason?:string}):Promise<void>{
 const roleId=id(input.roleId,'role');
 return withScopedLifecycleTenant(ctx,async tx=>{try{await tx.execute(sql`select app.probation_access_role_retire(${roleId}::uuid,${input.expectedRevision},${input.reason??null})`);}catch(error){refusal(error);}});
}
export type ProbationMemberScope={businessGroupId:string|null;companyId:string|null;validFrom:string;validTo:string|null};
export function addProbationAccessMember(ctx:SessionContext,input:{roleId:string;userId:string}&ProbationMemberScope):Promise<string>{
 const roleId=id(input.roleId,'role'),userId=id(input.userId,'person'),group=id(input.businessGroupId,'business group'),company=id(input.companyId,'company');
 const from=day(input.validFrom,'Valid from'),to=day(input.validTo,'Valid to');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{id:string}>(sql`select app.probation_access_member_add(${roleId}::uuid,${userId}::uuid,${group}::uuid,${company}::uuid,${from}::date,${to}::date) as id`);return row.id;}
  catch(error){return refusal(error);}
 });
}
export function changeProbationAccessMember(ctx:SessionContext,input:{memberId:string}&ProbationMemberScope):Promise<string>{
 const memberId=id(input.memberId,'member'),group=id(input.businessGroupId,'business group'),company=id(input.companyId,'company');
 const from=day(input.validFrom,'Valid from'),to=day(input.validTo,'Valid to');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{id:string}>(sql`select app.probation_access_member_change(${memberId}::uuid,${group}::uuid,${company}::uuid,${from}::date,${to}::date) as id`);return row.id;}
  catch(error){return refusal(error);}
 });
}
export function revokeProbationAccessMember(ctx:SessionContext,input:{memberId:string;reason?:string}):Promise<void>{
 const memberId=id(input.memberId,'member');
 return withScopedLifecycleTenant(ctx,async tx=>{try{await tx.execute(sql`select app.probation_access_member_revoke(${memberId}::uuid,${input.reason??null})`);}catch(error){refusal(error);}});
}
export function saveProbationSuperiorRule(ctx:SessionContext,input:{enabled:boolean;view:boolean;recordDeclined:boolean;expectedRevision:number}):Promise<number>{
 if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new ProbationError('invalid','Reload the rule and try again.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{revision:number}>(sql`select app.probation_access_rule_save(${!!input.enabled},${!!input.view},${!!input.recordDeclined},${input.expectedRevision}) as revision`);return row.revision;}
  catch(error){return refusal(error);}
 });
}
