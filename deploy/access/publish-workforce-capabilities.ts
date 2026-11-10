/** Restricted storage-owner installation step, never an application permission editor. */
import {createHash} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';

export const WORKFORCE_CAPABILITY_PUBLICATION_VERSION=1;
export const WORKFORCE_CAPABILITY_BINDINGS=[
 {id:'workforce.view',scope:'company',bindings:[
  {owner:'app.access_workforce_projection_company',operation:'bounded-company-scope'},
  {owner:'app.access_workforce_list_rows',operation:'bounded-list-search-filter-export'},
  {owner:'app.access_workforce_record',operation:'bounded-profile-register-projection'},
  {owner:'app.access_workforce_related_read',operation:'independent-own-approved-consumers'},
  {owner:'core/workforce-access.ts',operation:'fresh-principal-and-scope'},
  {owner:'app/admin/personnel/page.tsx',operation:'page'},
  {owner:'app/admin/personnel/export/route.ts',operation:'filtered-export'},
  {owner:'core/person-photo.ts',operation:'current-photo-own-directory-workforce-visibility'},
 ]},
 {id:'workforce.maintain',scope:'company',bindings:[
  {owner:'app.access_workforce_command_allowed',operation:'current-company-and-view-floor'},
  {owner:'app.access_workforce_maintain_record',operation:'finite-profile-qualification-emergency-family-values'},
  {owner:'app.access_workforce_set_employee_code',operation:'revision-checked-employee-code'},
  {owner:'app.access_workforce_lifecycle_update',operation:'independent-direct-and-approved-resignation-intents'},
  {owner:'app.access_workforce_structure_write',operation:'assignment-reporting-range-enforcement'},
  {owner:'app.access_workforce_service_info_update',operation:'finite-service-date-and-period-writes'},
  {owner:'app.access_profile_value_guard',operation:'exact-value-witness-and-independent-owner-exceptions'},
  {owner:'core/workforce-commands.ts',operation:'fresh-admission-and-specialist-owner-dispatch'},
  {owner:'app/admin/personnel/[employmentId]/workforce-record-actions.ts',operation:'normal-profile-register-maintenance'},
  {owner:'core/dependents.ts',operation:'canonical-family-eligibility-and-storage-owner-derived-values'},
 ]},
 {id:'profile.review',scope:'company',bindings:[
  {owner:'app.access_profile_review_for_user',operation:'actual-assignee-company-and-deny-ceiling'},
  {owner:'app.access_profile_review_permitted',operation:'request-read-decision-and-proposal-rls'},
  {owner:'app.profile_task_request_type',operation:'bounded-pending-task-metadata'},
  {owner:'app.access_profile_value_begin',operation:'fresh-exact-approved-value-witness'},
  {owner:'app.access_profile_value_audit',operation:'atomic-immutable-result-audit'},
  {owner:'app.access_withdraw_profile_requests',operation:'reasoned-policy-withdrawal-and-proposal-cleanup'},
  {owner:'core/profile-edit.ts',operation:'stored-routing-current-decision-and-reassignment'},
  {owner:'core/person-photo.ts',operation:'pending-byte-privacy-and-own-canonical-photo'},
 ]},
] as const;
export const WORKFORCE_CAPABILITY_BINDINGS_SHA256=createHash('sha256').update(JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,capabilities:WORKFORCE_CAPABILITY_BINDINGS})).digest('hex');
const REQUIRED_FUNCTIONS=[
 'app.access_workforce_projection_company(uuid)','app.access_workforce_list_rows()',
 'app.access_workforce_record(uuid)','app.access_workforce_related_read(uuid)',
 'app.access_workforce_command_allowed(uuid)','app.access_workforce_maintain_record(uuid,text,uuid,text,jsonb,text)',
 'app.access_workforce_set_employee_code(uuid,text,jsonb)','app.access_workforce_lifecycle_update()',
 'app.access_workforce_structure_write()','app.access_workforce_service_info_update()',
 'app.access_profile_value_guard()','app.access_profile_review_for_user(uuid,uuid)',
 'app.access_profile_review_permitted(uuid)','app.profile_task_request_type(uuid)',
 'app.access_profile_value_begin(uuid)','app.access_profile_value_audit()',
 'app.access_withdraw_profile_requests(jsonb,text)',
] as const;
function requireInstallation(value:unknown):asserts value{
 if(!value)throw new Error('Workforce capability installation refused; review exact owner, catalogue, bindings and tenant readiness.');
}
type CapabilityRow={id:string;scope:string;supported:boolean;bindings:unknown};
function exactBindings(actual:unknown,expected:readonly {owner:string;operation:string}[]){
 return Array.isArray(actual)&&actual.length===expected.length&&actual.every((row,index)=>row&&typeof row==='object'&&Object.keys(row).sort().join(',')==='operation,owner'&&row.owner===expected[index].owner&&row.operation===expected[index].operation);
}
/** Caller must supply the actual storage-owner connection. The production CLI additionally refuses
 * superuser/BYPASSRLS/role inheritance. There is no ai_hr_app definer, new grant or runtime route.
 *
 * Per tenant and resumable (migration 9962). One short transaction opens the version: it checks the exact owner,
 * catalogue, functions and every tenant's readiness, records the rows it replaces and flips the catalogue, holding
 * no tenant's lock; every tenant keeps seeing its previous catalogue (app.access_capability_effective). Each tenant
 * is then published in its own short transaction, exactly as the single transaction published it: its
 * access-configuration and profile-edit-policy locks, the new catalogue for that tenant, its preview revision and
 * physical writer generation (fencing pre-pinned writers) and its audit event commit together. A last transaction
 * closes the version once no tenant is left. A run stopped part way (or refused for one tenant) is completed by
 * running it again; the end state equals the single-transaction publication's.
 */
export type WorkforceCapabilityPublication={version:number;bindingsSha256:string;changed:boolean;capabilities:number;tenantsFenced:number};
/**
 * Fencing a tenant needs its exclusive Access lock while employees keep the lock shared all day (reader/writer
 * Access lock). An unbounded wait in the queue would hold every later clock-in of that tenant behind it for as
 * long as its oldest shared holder runs. Each tenant's transaction queues for a short moment instead; a long
 * holder costs that attempt, the tenant's transaction rolls back with nothing published or held, and the same
 * tenant is tried again after a back-off. Tenants already published stay published.
 */
export const PUBLICATION_TENANT_LOCK_WAIT_MS=250;
export async function publishWorkforceCapabilities(owner:Sql,options:{onTenant?:(tenantId:string,ms:number)=>void;attempts?:number;backoffMs?:number}={}):Promise<WorkforceCapabilityPublication>{
 const attempts=options.attempts??8,firstBackoff=options.backoffMs??500;
 const publishTenantBounded=async(tenantId:string)=>{
  for(let attempt=1;;attempt++){
   try{return await publishTenant(owner,tenantId);}
   catch(error){
    if((error as {code?:unknown})?.code!=='55P03'||attempt>=attempts)throw error;
    const ceiling=Math.min(15_000,firstBackoff*2**(attempt-1));
    await new Promise(resolve=>setTimeout(resolve,Math.round(ceiling/2+Math.random()*ceiling/2)));
   }
  }
 };
 const done=(changed:boolean,tenantsFenced:number)=>({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,changed,capabilities:3,tenantsFenced});
 const opened=await openPublication(owner);
 if(opened==='published')return done(false,0);
 let fenced=0;
 for(;;){
  const pending=await owner<{id:string}[]>`select t.id from public.tenant t where not exists(select 1 from app.access_capability_tenant_publication p
   where p.version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION} and p.tenant_id=t.id) order by t.id`;
  for(const tenant of pending){
   const started=performance.now();
   if(await publishTenantBounded(tenant.id))fenced++;
   options.onTenant?.(tenant.id,performance.now()-started);
  }
  if(await closePublication(owner))return done(true,fenced);
 }
}
async function assertAuthority(tx:TransactionSql){
 await tx`set local lock_timeout='10s'`;await tx`set local statement_timeout='60s'`;
 const [authority]=await tx<{actual:boolean}[]>`select current_user=session_user
  and current_user=pg_get_userbyid(c.relowner)
  and app.acting_as_owner() and c.relrowsecurity and c.relforcerowsecurity as actual
  from pg_class c where c.oid='public.access_capability'::regclass`;
 requireInstallation(authority?.actual);
}
/** Opens the version (or finds it open, to resume). 'published': nothing to do, the exact version is installed. */
async function openPublication(owner:Sql):Promise<'published'|'publishing'>{
 return owner.begin(async tx=>{
  await assertAuthority(tx);
  // Tenant insertion precedes its default-install trigger. The share lock makes the readiness check complete; it is
  // released at this commit, and a tenant created later is published by the same run before the version closes.
  await tx`lock table public.tenant in share mode`;
  await tx`lock table public.access_capability in share row exclusive mode`;
  const rows=await tx<CapabilityRow[]>`select id,scope,supported,bindings from public.access_capability
   where id in ('workforce.view','workforce.maintain','profile.review') order by id for update`;
  requireInstallation(rows.length===3);
  const expected=[...WORKFORCE_CAPABILITY_BINDINGS].sort((a,b)=>a.id.localeCompare(b.id));
  requireInstallation(rows.every((row,index)=>row.id===expected[index].id&&row.scope===expected[index].scope));
  const already=rows.every((row,index)=>row.supported&&exactBindings(row.bindings,expected[index].bindings));
  const uninstalled=rows.every(row=>!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0);
  requireInstallation(already||uninstalled); // Refuse partial/unknown versions without overwriting them.
  const functions=await tx<{count:number;owners:boolean}[]>`select count(*)::integer as count,
   coalesce(bool_and(p.proowner=c.relowner),false) as owners
   from unnest(${[...REQUIRED_FUNCTIONS]}::text[]) f(signature)
   join pg_proc p on p.oid=to_regprocedure(f.signature)
   cross join pg_class c where c.oid='public.access_capability'::regclass`;
  requireInstallation(functions[0]?.count===REQUIRED_FUNCTIONS.length&&functions[0].owners);
  const [open]=await tx<{version:number;bindings_sha256:string}[]>`select version,bindings_sha256 from app.access_capability_publication where state='publishing' for update`;
  if(open){
   // Resume only the exact version this code publishes, over the catalogue it already flipped.
   requireInstallation(open.version===WORKFORCE_CAPABILITY_PUBLICATION_VERSION&&open.bindings_sha256===WORKFORCE_CAPABILITY_BINDINGS_SHA256&&already);
   return 'publishing';
  }
  if(already)return 'published';
  const [readiness]=await tx<{ready:boolean}[]>`select not exists(
   select 1 from public.app_user u where u.archived_at is null and not app.login_blocked(u.id) and not exists(select 1 from public.access_configuration s
    where s.tenant_id=u.tenant_id and s.initialized)
   ) and not exists(select 1 from public.tenant t where not exists(
    select 1 from app.access_profile_write_generation g where g.tenant_id=t.id)) as ready`;
  requireInstallation(readiness?.ready); // Never mint a recovery administrator or default grant here.
  const previous=Object.fromEntries(rows.map(row=>[row.id,{supported:row.supported,bindings:row.bindings}]));
  // A catalogue uninstalled again after an earlier publication of this version publishes afresh, as before.
  await tx`delete from app.access_capability_tenant_publication where version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION}`;
  await tx`insert into app.access_capability_publication(version,bindings_sha256,state,previous)
   values(${WORKFORCE_CAPABILITY_PUBLICATION_VERSION},${WORKFORCE_CAPABILITY_BINDINGS_SHA256},'publishing',${JSON.stringify(previous)}::text::jsonb)
   on conflict(version) do update set bindings_sha256=excluded.bindings_sha256,state='publishing',previous=excluded.previous,started_at=now(),completed_at=null`;
  // Bind serialized JSON as text before converting it. Drizzle replaces the client's JSON
  // serializer, whereas the standalone installer retains postgres.js's JSON.stringify serializer.
  // A JSONB-typed parameter would therefore encode these strings twice in the real installer.
  for(const capability of WORKFORCE_CAPABILITY_BINDINGS){
   const changed=await tx`update public.access_capability set supported=true,bindings=${JSON.stringify(capability.bindings)}::text::jsonb where id=${capability.id} returning id`;
   requireInstallation(changed.length===1);
  }
  return 'publishing';
 });
}
/** One tenant: the same locks, readiness, fence and audit event as the single transaction applied to it. */
async function publishTenant(owner:Sql,tenantId:string):Promise<boolean>{
 return owner.begin(async tx=>{
  await assertAuthority(tx);
  const [open]=await tx`select 1 from app.access_capability_publication where state='publishing' and version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION} for share`;
  requireInstallation(open);
  // A short queued wait only for the two fencing locks; a timeout (55P03) retries this tenant.
  await tx`select set_config('lock_timeout',${PUBLICATION_TENANT_LOCK_WAIT_MS+'ms'},true)`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:' + tenantId},0))`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${'profile-edit-policy:' + tenantId},0))`;
  await tx`set local lock_timeout='10s'`;
  const [published]=await tx`select 1 from app.access_capability_tenant_publication where version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION} and tenant_id=${tenantId}::uuid`;
  if(published)return false;
  const [readiness]=await tx<{ready:boolean}[]>`select not exists(
   select 1 from public.app_user u where u.tenant_id=${tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) and not exists(select 1 from public.access_configuration s
    where s.tenant_id=u.tenant_id and s.initialized)
   ) and exists(select 1 from app.access_profile_write_generation g where g.tenant_id=${tenantId}::uuid) as ready`;
  requireInstallation(readiness?.ready);
  await tx`insert into app.access_capability_tenant_publication(version,tenant_id) values(${WORKFORCE_CAPABILITY_PUBLICATION_VERSION},${tenantId}::uuid)`;
  const revision=await tx`update public.access_configuration set revision=gen_random_uuid(),updated_at=now()
   where tenant_id=${tenantId}::uuid returning tenant_id`;
  // Existing configuration's real trigger advances the physical writer generation exactly once.
  // A tenant with no configuration still has a pre-existing generation anchor.
  if(!revision.length){const bumped=await tx`update app.access_profile_write_generation set generation=generation+1 where tenant_id=${tenantId}::uuid returning tenant_id`;requireInstallation(bumped.length===1);}
  await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
   values(${tenantId}::uuid,'access-configuration',${tenantId}::uuid,'access-configuration.capabilities-published','system',null,
    ${JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,capabilities:WORKFORCE_CAPABILITY_BINDINGS.map(c=>c.id),legacyRolesChanged:false})}::text::jsonb)`;
  return true;
 });
}
/** Closes the version once every tenant, including one created during the run, is published. */
async function closePublication(owner:Sql):Promise<boolean>{
 return owner.begin(async tx=>{
  await assertAuthority(tx);
  await tx`lock table public.tenant in share mode`;
  const [open]=await tx`select 1 from app.access_capability_publication where state='publishing' and version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION} for update`;
  if(!open)return true;
  const [left]=await tx<{n:number}[]>`select count(*)::int as n from public.tenant t where not exists(select 1 from app.access_capability_tenant_publication p
   where p.version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION} and p.tenant_id=t.id)`;
  if(left.n>0)return false;
  await tx`update app.access_capability_publication set state='published',completed_at=now() where version=${WORKFORCE_CAPABILITY_PUBLICATION_VERSION}`;
  return true;
 });
}
