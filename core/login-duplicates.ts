/** Board 0735d1b7 — Security Center > Users > Duplicate IC / Passport and Duplicate Work Email Address.
 *
 * What is compared is LOGINS (app_user), never people: a group is two or more sign-in accounts of this tenant whose
 * linked Personnel Profiles carry the same exact key. Matching is exact on purpose (a near match may be someone else;
 * People > Personnel > Duplicates reviews near matches between profiles):
 *   IC        employee_statutory_my.ic_number with every non-digit removed, never blank;
 *   passport  employee_statutory_my.passport_number upper-cased with all spaces removed, never blank (the issuing
 *             country is shown as evidence only);
 *   email     person.primary_email trimmed and lower-cased, never blank.
 * IC and passport are pack-owned (Malaysia statutory record); they are read here as stored columns the way
 * core/duplicate-person.ts reads them, never through a localization/my import (ADR-0080 D7).
 *
 * Both tabs read ONE result shape. A login that is merged away (migration 7600, core/login-merge.ts) counts as its
 * master, so its keys bring the master into a group and the merged login itself never appears: once an account is
 * merged both tabs show it under its master straight away. A group needs two or more distinct effective logins.
 * A passport group whose logins are exactly an IC group's logins is shown once, under IC.
 *
 * Group administrators only (the application assert and `app.is_group_admin()` in the statement). One set-based
 * statement per page read and one for the page's accounts; keyset pages of groups ordered by an id derived from the
 * group digest, with a capped count ("1,000+"). The URL never carries a raw IC, passport or email: a group is named by
 * its digest, sha256 of tenant, basis and normalised key. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {uuidArrayParam} from '../db/sql-arrays';
import {cappedTotal,keysetSlice,LIST_COUNT_CAP,type KeysetPageQuery,type KeysetRead} from '../lib/pagination';
import {currentEmployeeCode} from '../lib/current-employee-code';
import {todayInKualaLumpur} from '../lib/hr-date';
import {readLastSignIns} from './last-sign-in';
import {readManagedAccountDirectory} from './account-management';

export type DuplicateTab='identity'|'email';
export type DuplicateBasis='ic'|'passport'|'email';
export const DUPLICATE_BASES:readonly DuplicateBasis[]=['ic','passport','email'];
/** The largest page of groups a read serves ("All" included): each group's accounts are hydrated for the page. */
export const DUPLICATE_GROUP_PAGE_MAX=100;
/** Most accounts one merge may combine (a larger group is shown but cannot be merged in one step). */
export const MERGE_MAX_ACCOUNTS=20;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGroupDigest=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);

export type DuplicateAccount={
 appUserId:string;personId:string|null;name:string|null;employeeCode:string|null;email:string|null;
 icNumber:string|null;passportNumber:string|null;passportCountry:string|null;
 /** Active, or Inactive because the login was switched off (archived) or the person has left. */
 status:'active'|'inactive';inactiveCause:'archived'|'left'|null;
 userType:'internal'|'external';username:string|null;lastLogin:string|null;
 /** Logins currently merged away under this one: it is a master and must stay the master. */
 mergedCount:number;
};
export type DuplicateGroup={
 id:string;digest:string;basis:DuplicateBasis;accounts:DuplicateAccount[];
 /** The one account of the group that is already a master (preselected and locked), or null. */
 lockedMasterId:string|null;
 /** Two or more accounts are already masters: one person must never end with two competing masters. */
 conflictingMasters:boolean;
 /** The accounts point to two or more different Personnel Profiles (for example someone hired twice). */
 differentProfiles:boolean;
};

export class LoginDuplicatesError extends Error{constructor(message:string,readonly code:'forbidden'|'invalid'='forbidden'){super(message);this.name='LoginDuplicatesError';}}
/** Group administrators only, as for inviting users (core/auth.ts). A roles-only context is group-wide. */
export function assertLoginDuplicatesAdmin(ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null as string|null}));
 if(!ctx.userId||!grants.some(g=>g.role==='super_admin'||(g.role==='hr_admin'&&g.companyId==null)))
  throw new LoginDuplicatesError('Only a group administrator can review duplicate logins.');
}

const basesOf=(tab:DuplicateTab|'all'):DuplicateBasis[]=>tab==='identity'?['ic','passport']:tab==='email'?['email']:['ic','passport','email'];
/** The groups of the chosen bases as a CTE named `ided` (basis, members uuid[], digest, gid uuid). */
function groupsCte(tenantId:string,bases:readonly DuplicateBasis[]):SQL{
 const parts:SQL[]=[];
 if(bases.includes('ic'))parts.push(sql`select 'ic'::text as basis,regexp_replace(s.ic_number,'\\D','','g') as k,l.effective_id
  from logins l join employee_statutory_my s on s.person_id=l.person_id and s.tenant_id=${tenantId}::uuid
  where regexp_replace(coalesce(s.ic_number,''),'\\D','','g')<>''`);
 if(bases.includes('passport'))parts.push(sql`select 'passport'::text as basis,upper(regexp_replace(s.passport_number,'\\s','','g')) as k,l.effective_id
  from logins l join employee_statutory_my s on s.person_id=l.person_id and s.tenant_id=${tenantId}::uuid
  where regexp_replace(coalesce(s.passport_number,''),'\\s','','g')<>''`);
 if(bases.includes('email'))parts.push(sql`select 'email'::text as basis,lower(btrim(p.primary_email)) as k,l.effective_id
  from logins l join person p on p.id=l.person_id and p.tenant_id=${tenantId}::uuid
  where btrim(coalesce(p.primary_email,''))<>''`);
 return sql`with active_merge as (select merged_app_user_id,master_app_user_id from app.login_merge_active()),
 logins as (select u.id,coalesce(am.master_app_user_id,u.id) as effective_id,u.person_id from app_user u
  left join active_merge am on am.merged_app_user_id=u.id
  where u.tenant_id=${tenantId}::uuid and u.person_id is not null and app.is_group_admin()),
 keyed as (${sql.join(parts,sql` union all `)}),
 grouped as (select basis,k,array_agg(distinct effective_id order by effective_id) as members from keyed group by basis,k
  having count(distinct effective_id)>=2),
 deduped as (select g.basis,g.k,g.members from grouped g where g.basis<>'passport'
  or not exists(select 1 from grouped i where i.basis='ic' and i.members=g.members)),
 digested as (select basis,members,encode(sha256(convert_to(${tenantId}::text||':'||basis||':'||k,'UTF8')),'hex') as digest from deduped),
 ided as (select basis,members,digest,(substr(digest,1,8)||'-'||substr(digest,9,4)||'-'||substr(digest,13,4)||'-'||substr(digest,17,4)||'-'||substr(digest,21,12))::uuid as gid from digested)`;
}
type GroupRow={id:string;digest:string;basis:DuplicateBasis;members:string[]};

/** The accounts of the listed logins with the master/merge facts, one statement. Usernames and last sign-ins come from
 * their owners' batched reads. */
async function hydrateAccountsTx(tx:Tx,tenantId:string,ids:readonly string[]){
 if(!ids.length)return new Map<string,Omit<DuplicateAccount,'username'|'lastLogin'>>();
 const rows=await tx.execute<{id:string;person_id:string|null;full_name:string|null;primary_email:string|null;ic_number:string|null;
  passport_number:string|null;passport_country:string|null;archived:boolean;left_group:boolean;has_employment:boolean;
  employments:{employeeCode:string|null;hiredOn:string;terminatedOn:string|null;lastWorkingDate:string|null}[]|null;merged_count:number}>(sql`
  with merged as (select master_app_user_id,count(*)::int as n from app.login_merge_active() group by master_app_user_id)
  select u.id::text,u.person_id::text,p.full_name,p.primary_email,s.ic_number,s.passport_number,
   coalesce(s.passport_issuing_country_code,s.passport_issuing_country) as passport_country,
   u.archived_at is not null as archived,
   (exists(select 1 from employment e where e.person_id=u.person_id and e.tenant_id=u.tenant_id)
    and not exists(select 1 from employment e where e.person_id=u.person_id and e.tenant_id=u.tenant_id and e.blacklisted_at is null
     and (least(e.resignation_date,e.last_working_date,e.terminated_on) is null or current_date<=least(e.resignation_date,e.last_working_date,e.terminated_on)))) as left_group,
   exists(select 1 from employment e where e.person_id=u.person_id and e.tenant_id=u.tenant_id) as has_employment,
   (select json_agg(json_build_object('employeeCode',e.employee_code,'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'lastWorkingDate',e.last_working_date) order by e.hired_on desc,e.id)
    from employment e where e.person_id=u.person_id and e.tenant_id=u.tenant_id) as employments,
   coalesce(m.n,0) as merged_count
  from app_user u
  left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id
  left join lateral (select x.ic_number,x.passport_number,x.passport_issuing_country_code,x.passport_issuing_country from employee_statutory_my x
   where x.person_id=u.person_id and x.tenant_id=u.tenant_id order by x.id limit 1) s on true
  left join merged m on m.master_app_user_id=u.id
  where u.tenant_id=${tenantId}::uuid and u.id=any(${uuidArrayParam(ids)})
  order by u.id`);
 const today=todayInKualaLumpur(),out=new Map<string,Omit<DuplicateAccount,'username'|'lastLogin'>>();
 for(const r of rows)out.set(r.id,{appUserId:r.id,personId:r.person_id,name:r.full_name,email:r.primary_email,
  employeeCode:currentEmployeeCode((r.employments??[]).map(e=>({employeeCode:e.employeeCode,hiredOn:String(e.hiredOn),terminatedOn:e.terminatedOn,lastWorkingDate:e.lastWorkingDate})),today),
  icNumber:r.ic_number,passportNumber:r.passport_number,passportCountry:r.passport_country,
  status:r.archived||r.left_group?'inactive':'active',inactiveCause:r.archived?'archived':r.left_group?'left':null,
  userType:r.has_employment?'internal':'external',mergedCount:Number(r.merged_count)});
 return out;
}
async function decorate(ctx:SessionContext,ids:string[],base:Map<string,Omit<DuplicateAccount,'username'|'lastLogin'>>){
 const [usernames,lastSignIns]=await Promise.all([readManagedAccountDirectory(ctx,ids),readLastSignIns(ctx,ids)]);
 const out=new Map<string,DuplicateAccount>();
 for(const [id,a] of base)out.set(id,{...a,username:usernames[id]?.username??null,lastLogin:lastSignIns[id]??null});
 return out;
}
function toGroup(row:GroupRow,accounts:Map<string,DuplicateAccount>):DuplicateGroup{
 const list=row.members.flatMap(id=>accounts.get(id)?[accounts.get(id)!]:[]);
 const masters=list.filter(a=>a.mergedCount>0);
 const profiles=new Set(list.map(a=>a.personId).filter(Boolean));
 return{id:row.id,digest:row.digest,basis:row.basis,accounts:list,lockedMasterId:masters.length===1?masters[0].appUserId:null,
  conflictingMasters:masters.length>1,differentProfiles:profiles.size>1};
}

export type LoginDuplicatePage=KeysetRead&{groups:DuplicateGroup[]};
/** One keyset page of a tab's groups, with their accounts. `q.size==='all'` and sizes above 100 read 100 groups. */
export async function readLoginDuplicates(ctx:SessionContext,tab:DuplicateTab,q:KeysetPageQuery):Promise<LoginDuplicatePage>{
 assertLoginDuplicatesAdmin(ctx);
 const limit=Math.min(DUPLICATE_GROUP_PAGE_MAX,q.size==='all'?DUPLICATE_GROUP_PAGE_MAX:q.limit);
 const anchor=q.after??q.before??null;
 const backwards=Boolean(q.before)||q.last;
 const cap=q.exactCount?2147483647:LIST_COUNT_CAP+1;
 const {page,base}=await withTenant(ctx,async tx=>{
  const [r]=await tx.execute<{seen:number;anchor_found:boolean;rows:GroupRow[]}>(sql`${groupsCte(ctx.tenantId,basesOf(tab))}
   select (select count(*)::int from (select 1 from ided limit ${cap}) c) as seen,
    ${anchor?sql`exists(select 1 from ided where gid=${anchor}::uuid)`:sql`true`} as anchor_found,
    coalesce((select json_agg(json_build_object('id',x.gid::text,'digest',x.digest,'basis',x.basis,'members',x.members) order by x.gid ${backwards?sql`desc`:sql`asc`})
     from (select gid,digest,basis,members from ided
      ${q.after?sql`where gid>${q.after}::uuid`:q.before?sql`where gid<${q.before}::uuid`:sql``}
      order by gid ${backwards?sql`desc`:sql`asc`} limit ${limit+1}) x),'[]'::json) as rows`);
  const anchorFound=Boolean(r?.anchor_found);
  const slice=keysetSlice(r?.rows??[],{limit,after:q.after,before:q.before,last:q.last},anchorFound);
  const ids=[...new Set(slice.rows.flatMap(g=>g.members))].sort();
  return {page:{...slice,seen:Number(r?.seen??0),anchorFound},base:await hydrateAccountsTx(tx,ctx.tenantId,ids)};
 });
 const accounts=await decorate(ctx,[...base.keys()],base);
 return{groups:page.rows.map(row=>toGroup(row,accounts)),total:cappedTotal(page.seen,LIST_COUNT_CAP,q.exactCount),
  hasPrev:page.hasPrev,hasNext:page.hasNext,anchorFound:page.anchorFound};
}

/** Tab counts for the Users tab bar: groups per tab, each capped at 1,001 (shown as "1,000+"). One statement. */
export async function countLoginDuplicateGroups(ctx:SessionContext):Promise<{identity:number;email:number}>{
 assertLoginDuplicatesAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const [r]=await tx.execute<{identity:number;email:number}>(sql`${groupsCte(ctx.tenantId,basesOf('all'))}
   select (select count(*)::int from (select 1 from ided where basis in ('ic','passport') limit ${LIST_COUNT_CAP+1}) a) as identity,
    (select count(*)::int from (select 1 from ided where basis='email' limit ${LIST_COUNT_CAP+1}) b) as email`);
  return{identity:Number(r?.identity??0),email:Number(r?.email??0)};
 });
}

/** One group by its digest inside the caller's transaction (the merge re-reads it under the exclusive Access lock), or
 * null when no such group exists any more. Members are effective logins (merged logins appear as their master). */
export async function loginDuplicateGroupTx(tx:Tx,tenantId:string,digest:string):Promise<GroupRow|null>{
 if(!isGroupDigest(digest))return null;
 const [r]=await tx.execute<GroupRow>(sql`${groupsCte(tenantId,basesOf('all'))}
  select gid::text as id,digest,basis,members::text[] as members from ided where digest=${digest} limit 1`);
 return r?{...r,members:[...r.members].map(String).sort()}:null;
}

/** One group with its accounts for the merge confirmation (bounded by MERGE_MAX_ACCOUNTS + the group's own size). */
export async function readLoginDuplicateGroup(ctx:SessionContext,digest:string):Promise<DuplicateGroup|null>{
 assertLoginDuplicatesAdmin(ctx);
 if(!isGroupDigest(digest))throw new LoginDuplicatesError('This duplicate group is no longer available.','invalid');
 const found=await withTenant(ctx,async tx=>{
  const row=await loginDuplicateGroupTx(tx,ctx.tenantId,digest);
  return row?{row,base:await hydrateAccountsTx(tx,ctx.tenantId,row.members)}:null;
 });
 if(!found)return null;
 return toGroup(found.row,await decorate(ctx,found.row.members,found.base));
}
export const isLoginId=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
