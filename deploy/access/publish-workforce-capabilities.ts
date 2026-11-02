/** Restricted storage-owner installation step, never an application permission editor. */
import {createHash} from 'node:crypto';
import type {Sql} from 'postgres';

export const WORKFORCE_CAPABILITY_PUBLICATION_VERSION=2;
export const WORKFORCE_CAPABILITY_BINDINGS_V1=[
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
export const WORKFORCE_CAPABILITY_BINDINGS=[...WORKFORCE_CAPABILITY_BINDINGS_V1,
 ...(['add','edit','delete'] as const).map(action=>({id:`workforce.${action}`,scope:'company' as const,bindings:[
  {owner:'app.access_workforce_action_company',operation:action+'-with-view-and-deny-floor'},
  {owner:'app.access_workforce_action_employment',operation:action+'-current-data-scope'},
  {owner:'app.access_workforce_action_person',operation:action+'-all-retained-person-scope'},
  {owner:'app.access_workforce_maintain_record',operation:'typed-native-and-reviewed-register-'+action},
  {owner:'app.access_profile_value_guard',operation:'raw-sql-and-independent-witness-'+action},
  {owner:'core/workforce-commands.ts',operation:'typed-native-admission'},
 ]})),
] as const;
export const WORKFORCE_CAPABILITY_BINDINGS_SHA256=createHash('sha256').update(JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,capabilities:WORKFORCE_CAPABILITY_BINDINGS})).digest('hex');
const REQUIRED_FUNCTIONS=[
 'app.access_workforce_action_company(uuid,text)','app.access_workforce_action_employment(uuid,text)','app.access_workforce_action_person(uuid,text)',
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
 * One transaction publishes an exact version, invalidates previews and fences pre-pinned writers.
 */
export async function publishWorkforceCapabilities(owner:Sql){
 return owner.begin(async tx=>{
  await tx`set local lock_timeout='10s'`;await tx`set local statement_timeout='60s'`;
  const [authority]=await tx<{actual:boolean}[]>`select current_user=session_user
   and current_user=pg_get_userbyid(c.relowner)
   and app.acting_as_owner() and c.relrowsecurity and c.relforcerowsecurity as actual
   from pg_class c where c.oid='public.access_capability'::regclass`;
  requireInstallation(authority?.actual);
  // Tenant insertion precedes its default-install trigger. Take this lock before per-tenant locks
  // so no concurrently created tenant is missed or enters an inverted lock order.
  await tx`lock table public.tenant in share mode`;
  await tx`lock table public.access_capability in share row exclusive mode`;
  const rows=await tx<CapabilityRow[]>`select id,scope,supported,bindings from public.access_capability
   where id in ('workforce.view','workforce.maintain','profile.review','workforce.add','workforce.edit','workforce.delete') order by id for update`;
  requireInstallation(rows.length===6);
  const expected=[...WORKFORCE_CAPABILITY_BINDINGS].sort((a,b)=>a.id.localeCompare(b.id));
  requireInstallation(rows.every((row,index)=>row.id===expected[index].id&&row.scope===expected[index].scope));
  const already=rows.every((row,index)=>row.supported&&exactBindings(row.bindings,expected[index].bindings));
  const uninstalled=rows.every(row=>!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0);
  const knownV1=rows.every(row=>{const old=WORKFORCE_CAPABILITY_BINDINGS_V1.find(item=>item.id===row.id);return old?row.supported&&exactBindings(row.bindings,old.bindings):!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0;});
  requireInstallation(already||uninstalled||knownV1); // Refuse partial/unknown versions without overwriting them.
  const functions=await tx<{count:number;owners:boolean}[]>`select count(*)::integer as count,
   coalesce(bool_and(p.proowner=c.relowner),false) as owners
   from unnest(${[...REQUIRED_FUNCTIONS]}::text[]) f(signature)
   join pg_proc p on p.oid=to_regprocedure(f.signature)
   cross join pg_class c where c.oid='public.access_capability'::regclass`;
  requireInstallation(functions[0]?.count===REQUIRED_FUNCTIONS.length&&functions[0].owners);
  if(already)return {version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,changed:false,capabilities:6,tenantsFenced:0};
  const tenants=await tx<{id:string}[]>`select id from public.tenant order by id`;
  for(const tenant of tenants){
   await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:' + tenant.id},0))`;
   await tx`select pg_advisory_xact_lock(hashtextextended(${'profile-edit-policy:' + tenant.id},0))`;
  }
  const [readiness]=await tx<{ready:boolean}[]>`select not exists(
   select 1 from public.app_user u where u.archived_at is null and not app.login_blocked(u.id) and not exists(select 1 from public.access_configuration s
    where s.tenant_id=u.tenant_id and s.initialized)
   ) and not exists(select 1 from public.tenant t where not exists(
    select 1 from app.access_profile_write_generation g where g.tenant_id=t.id)) as ready`;
  requireInstallation(readiness?.ready); // Never mint a recovery administrator or default grant here.
  // One-time exact legacy parity: preserve every old fact and copy its active scope/effect.
  // Refuse unknown prepublication action facts rather than silently broadening/narrowing a holder.
  const [parity]=await tx<{ok:boolean}[]>`select not exists(select 1 from access_group_grant n where n.capability_id in ('workforce.add','workforce.edit','workforce.delete') and n.retired_at is null
   and not exists(select 1 from access_group_grant old where old.tenant_id=n.tenant_id and old.group_id=n.group_id and old.capability_id='workforce.maintain' and old.company_id is not distinct from n.company_id and old.retired_at is null))
   and not exists(select 1 from access_user_override n where n.capability_id in ('workforce.add','workforce.edit','workforce.delete') and n.retired_at is null
   and not exists(select 1 from access_user_override old where old.tenant_id=n.tenant_id and old.user_id=n.user_id and old.capability_id='workforce.maintain' and old.company_id is not distinct from n.company_id and old.effect=n.effect and old.retired_at is null)) as ok`;
  requireInstallation(parity?.ok);
  await tx`insert into access_group_grant(tenant_id,group_id,capability_id,company_id)
   select old.tenant_id,old.group_id,new.id,old.company_id from access_group_grant old
   cross join (values ('workforce.add'),('workforce.edit'),('workforce.delete'))new(id)
   where old.capability_id='workforce.maintain' and old.retired_at is null on conflict do nothing`;
  await tx`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   select old.tenant_id,old.user_id,new.id,old.company_id,old.effect from access_user_override old
   cross join (values ('workforce.add'),('workforce.edit'),('workforce.delete'))new(id)
   where old.capability_id='workforce.maintain' and old.retired_at is null on conflict do nothing`;
  // Bind serialized JSON as text before converting it. Drizzle replaces the client's JSON
  // serializer, whereas the standalone installer retains postgres.js's JSON.stringify serializer.
  // A JSONB-typed parameter would therefore encode these strings twice in the real installer.
  for(const capability of WORKFORCE_CAPABILITY_BINDINGS){
   const changed=await tx`update public.access_capability set supported=true,bindings=${JSON.stringify(capability.bindings)}::text::jsonb where id=${capability.id} returning id`;
   requireInstallation(changed.length===1);
  }
  for(const tenant of tenants){
   const revision=await tx`update public.access_configuration set revision=gen_random_uuid(),updated_at=now()
    where tenant_id=${tenant.id}::uuid returning tenant_id`;
   // Existing configuration's real trigger advances the physical writer generation exactly once.
   // A tenant with no configuration still has a pre-existing generation anchor.
   if(!revision.length){const bumped=await tx`update app.access_profile_write_generation set generation=generation+1 where tenant_id=${tenant.id}::uuid returning tenant_id`;requireInstallation(bumped.length===1);}
   await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
    values(${tenant.id}::uuid,'access-configuration',${tenant.id}::uuid,'access-configuration.capabilities-published','system',null,
     ${JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,capabilities:WORKFORCE_CAPABILITY_BINDINGS.map(c=>c.id),legacyRolesChanged:false})}::text::jsonb)`;
  }
  return {version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,changed:true,capabilities:6,tenantsFenced:tenants.length};
 });
}
