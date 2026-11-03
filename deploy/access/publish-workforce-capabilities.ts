/** Restricted storage-owner installation step, never an application permission editor. */
import {createHash} from 'node:crypto';
import type {Sql} from 'postgres';
import {functionActionCapabilities,type FunctionActionDescriptor} from './function-action-contract';
import {FINANCIAL_LETTER_CAPABILITY_PUBLICATION} from './financial-letter-capability-bindings';
import {ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION} from './organisation-settings-capability-bindings';

export const WORKFORCE_CAPABILITY_PUBLICATION_VERSION=3;
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
export const WORKFORCE_CAPABILITY_BINDINGS_V2=[...WORKFORCE_CAPABILITY_BINDINGS_V1,
 ...(['add','edit','delete'] as const).map(action=>({id:`workforce.${action}`,scope:'company' as const,bindings:[
  {owner:'app.access_workforce_action_company',operation:action+'-with-view-and-deny-floor'},
  {owner:'app.access_workforce_action_employment',operation:action+'-current-data-scope'},
  {owner:'app.access_workforce_action_person',operation:action+'-all-retained-person-scope'},
  {owner:'app.access_workforce_maintain_record',operation:'typed-native-and-reviewed-register-'+action},
  {owner:'app.access_profile_value_guard',operation:'raw-sql-and-independent-witness-'+action},
  {owner:'core/workforce-commands.ts',operation:'typed-native-admission'},
 ]})),
] as const;
export type DomainPublication={capabilities:readonly {id:string;scope:'company'|'tenant';bindings:readonly {owner:string;operation:string}[]}[];requiredFunctions:readonly string[];legacyGroups:Record<string,readonly string[]>;legacyParityFunction?:string;delegationFloorFunction?:string;functions?:readonly FunctionActionDescriptor[];functionLegacyParityFunction?:string;currentLegacyParityFunction?:string;functionCurrentLegacyParityFunction?:string};
export const ACTION_DOMAIN_PUBLICATIONS:readonly DomainPublication[]=[FINANCIAL_LETTER_CAPABILITY_PUBLICATION,ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION];
export const WORKFORCE_CAPABILITY_BINDINGS=[...WORKFORCE_CAPABILITY_BINDINGS_V2,...ACTION_DOMAIN_PUBLICATIONS.flatMap(domain=>domain.capabilities)];
export const WORKFORCE_CAPABILITY_BINDINGS_SHA256=createHash('sha256').update(JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,capabilities:WORKFORCE_CAPABILITY_BINDINGS})).digest('hex');
const WORKFORCE_REQUIRED_FUNCTIONS=[
 'app.workforce_full_import_allowed(uuid,text)',
 'app.access_workforce_statutory_action_guard()','app.access_workforce_photo_action_guard()','app.access_workforce_hire_effects_match(jsonb,uuid)','app.access_configuration_delegation_preview(jsonb)',
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
function requireInstallation(value:unknown,detail='review exact owner, catalogue, bindings and tenant readiness'):asserts value{
 if(!value)throw new Error(`Workforce capability installation refused; ${detail}.`);
}
type CapabilityRow={id:string;scope:string;supported:boolean;bindings:unknown;prerequisites:unknown};
function exactBindings(actual:unknown,expected:readonly {owner:string;operation:string}[]){
 return Array.isArray(actual)&&actual.length===expected.length&&actual.every((row,index)=>row&&typeof row==='object'&&Object.keys(row).sort().join(',')==='operation,owner'&&row.owner===expected[index].owner&&row.operation===expected[index].operation);
}
/** Caller must supply the actual storage-owner connection. The production CLI additionally refuses
 * superuser/BYPASSRLS/role inheritance. There is no ai_hr_app definer, new grant or runtime route.
 * One transaction publishes an exact version, invalidates previews and fences pre-pinned writers.
 */
export const WORKFORCE_ACTION_PACKAGE_BINDINGS_SHA256=createHash('sha256').update(JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,package:'workforce',capabilities:WORKFORCE_CAPABILITY_BINDINGS_V2})).digest('hex');
export function publishWorkforceActionPackage(owner:Sql){return publishActionCapabilityPackage(owner,'workforce');}
export type ActionCapabilityPackage='workforce'|'financial_letters'|'organisation_settings';
/** Restricted component publication uses the same real transaction, owner checks and fences as
 * the full installer. Callers choose a fixed source package, never submit bindings or prerequisites. */
export function publishActionCapabilityPackage(owner:Sql,key:ActionCapabilityPackage){
 if(!['workforce','financial_letters','organisation_settings'].includes(key))throw new Error('Unknown code-owned action package');
 return installActionCapabilities(owner,key);
}
export function publishWorkforceCapabilities(owner:Sql){return installActionCapabilities(owner,'all');}
async function installActionCapabilities(owner:Sql,key:ActionCapabilityPackage|'all'){
 const ACTION_DOMAIN_PUBLICATIONS=key==='workforce'?[]:key==='financial_letters'?[FINANCIAL_LETTER_CAPABILITY_PUBLICATION]:key==='organisation_settings'?[ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION]:[FINANCIAL_LETTER_CAPABILITY_PUBLICATION,ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION];
 const domains=ACTION_DOMAIN_PUBLICATIONS as readonly DomainPublication[];
 for(const domain of domains){requireInstallation(!domain.legacyParityFunction||!!domain.currentLegacyParityFunction);requireInstallation(!domain.functions?.length||!!domain.functionLegacyParityFunction&&!!domain.functionCurrentLegacyParityFunction);}
 const includeWorkforce=key==='all'||key==='workforce';
 const WORKFORCE_CAPABILITY_BINDINGS:{id:string;scope:'company'|'tenant';bindings:readonly {owner:string;operation:string}[];prerequisites?:readonly string[]}[]=[...(includeWorkforce?WORKFORCE_CAPABILITY_BINDINGS_V2:[]),...ACTION_DOMAIN_PUBLICATIONS.flatMap(domain=>[...domain.capabilities,...functionActionCapabilities((domain as DomainPublication).functions??[])])];
 const REQUIRED_FUNCTIONS=[...new Set([...(includeWorkforce?WORKFORCE_REQUIRED_FUNCTIONS:[]),...ACTION_DOMAIN_PUBLICATIONS.flatMap(domain=>domain.requiredFunctions),...domains.flatMap(domain=>[domain.legacyParityFunction,domain.currentLegacyParityFunction,domain.functionLegacyParityFunction,domain.functionCurrentLegacyParityFunction].filter((hook):hook is string=>!!hook).map(hook=>hook+'(uuid,uuid,text,uuid)')),...(ACTION_DOMAIN_PUBLICATIONS as readonly DomainPublication[]).flatMap(domain=>domain.functions?.length?[...(domain.functionLegacyParityFunction?[domain.functionLegacyParityFunction+'(uuid,uuid,text,uuid)']:[]),...domain.functions.flatMap(descriptor=>descriptor.actions.flatMap(action=>action.delegationFloorFunction?[action.delegationFloorFunction+'(uuid,uuid,text,uuid)']:[]))]:[]),...(key==='all'?['app.access_all_function_bindings_complete()']:[])])];
 const WORKFORCE_CAPABILITY_BINDINGS_SHA256=createHash('sha256').update(JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,...(key==='all'?{}:{package:key}),capabilities:WORKFORCE_CAPABILITY_BINDINGS})).digest('hex');
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
  const rows=await tx<CapabilityRow[]>`select id,scope,supported,bindings,prerequisites from public.access_capability
   where id=any(${WORKFORCE_CAPABILITY_BINDINGS.map(item=>item.id)}::text[]) order by id for update`;
  requireInstallation(rows.length===WORKFORCE_CAPABILITY_BINDINGS.length);
  const expected=[...WORKFORCE_CAPABILITY_BINDINGS].sort((a,b)=>a.id.localeCompare(b.id));
  requireInstallation(rows.every((row,index)=>row.id===expected[index].id&&row.scope===expected[index].scope&&JSON.stringify(row.prerequisites)===JSON.stringify(expected[index].prerequisites??[])));
  for(const domain of ACTION_DOMAIN_PUBLICATIONS as readonly DomainPublication[]){
   for(const descriptor of domain.functions??[]){
    const {key:definitionKey,scope:definitionScope,actions,...metadata}=descriptor;
    for(const action of actions){
     const [registered]=await tx<{correct:boolean}[]>`select d.scope=${definitionScope} and d.metadata=${JSON.stringify(metadata)}::text::jsonb and a.parent_capability is not distinct from ${action.parentCapability??null} and a.delegation_floor_function is not distinct from ${action.delegationFloorFunction??null} as correct from app.access_function_definition d join app.access_function_action a using(function_key) where d.function_key=${definitionKey} and a.operation=${action.operation}`;
     requireInstallation(registered?.correct,`missing or mismatched registry entry ${definitionKey}.${action.operation}`);
    }
   }
  }
  const already=rows.every((row,index)=>row.supported&&exactBindings(row.bindings,expected[index].bindings));
  const uninstalled=rows.every(row=>!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0);
  const knownV1=rows.every(row=>{const old=WORKFORCE_CAPABILITY_BINDINGS_V1.find(item=>item.id===row.id);return old?row.supported&&exactBindings(row.bindings,old.bindings):!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0;});
  const knownV2=rows.every(row=>{const old=WORKFORCE_CAPABILITY_BINDINGS_V2.find(item=>item.id===row.id);return old?row.supported&&exactBindings(row.bindings,old.bindings):!row.supported&&Array.isArray(row.bindings)&&row.bindings.length===0;});
  const knownComponents=rows.every((row,index)=>row.supported?exactBindings(row.bindings,expected[index].bindings):Array.isArray(row.bindings)&&row.bindings.length===0)
   &&(!includeWorkforce||rows.filter(row=>WORKFORCE_CAPABILITY_BINDINGS_V2.some(capability=>capability.id===row.id)).every(row=>row.supported)||rows.filter(row=>WORKFORCE_CAPABILITY_BINDINGS_V2.some(capability=>capability.id===row.id)).every(row=>!row.supported))
   &&domains.every(domain=>{const family=rows.filter(row=>domain.capabilities.some(capability=>capability.id===row.id));const children=rows.filter(row=>functionActionCapabilities(domain.functions??[]).some(capability=>capability.id===row.id));return family.every(row=>row.supported)&&children.every(row=>row.supported)||family.every(row=>!row.supported)&&children.every(row=>!row.supported)||family.every(row=>row.supported)&&children.every(row=>!row.supported);});
  requireInstallation(already||uninstalled||knownV1||knownV2||knownComponents); // Refuse partial/unknown versions without overwriting them.
  const invalidFunctions=await tx<{signature:string;missing:boolean}[]>`select f.signature,p.oid is null as missing
   from unnest(${[...REQUIRED_FUNCTIONS]}::text[]) f(signature)
   left join pg_proc p on p.oid=to_regprocedure(f.signature)
   cross join pg_class c where c.oid='public.access_capability'::regclass
   and p.proowner is distinct from c.relowner order by f.signature`;
  requireInstallation(invalidFunctions.length===0,invalidFunctions.map(row=>
   `${row.missing?'missing function':'unexpected function owner'} ${row.signature}`).join(', '));
  if(key==='all'||key==='organisation_settings'){
   const [prerequisite]=await tx<{trusted:boolean}[]>`select p.prosecdef and p.prorettype='boolean'::regtype
    and not has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as trusted
    from pg_proc p where p.oid='app.organisation_settings_bindings_complete()'::regprocedure`;
   requireInstallation(prerequisite?.trusted,'untrusted Organisation Settings binding predicate');
   const [coverage]=await tx<{complete:boolean}[]>`select app.organisation_settings_bindings_complete() as complete`;
   requireInstallation(coverage?.complete===true,'Organisation Settings physical enforcement is incomplete');
  }
  if(key==='all'){
   // The full installation must cover the closed SQL registry in the same
   // transaction. A package or completion function alone cannot omit an action.
   const registered=await tx<{id:string}[]>`select capability_id as id from app.access_function_action order by capability_id collate "C"`;
   const described=WORKFORCE_CAPABILITY_BINDINGS.filter(capability=>capability.id.startsWith('function.')).map(capability=>capability.id).sort();
   const registeredIds=new Set(registered.map(row=>row.id));
   const describedIds=new Set(described);
   const missing=described.filter(id=>!registeredIds.has(id));
   const unexpected=registered.filter(row=>!describedIds.has(row.id)).map(row=>row.id);
   requireInstallation(missing.length===0&&unexpected.length===0,
    `registry coverage differs (missing: ${missing.join(', ')||'none'}; unexpected: ${unexpected.join(', ')||'none'})`);
   const [prerequisite]=await tx<{trusted:boolean}[]>`select p.prosecdef and p.prorettype='boolean'::regtype
    and not has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as trusted
    from pg_proc p where p.oid='app.access_all_function_bindings_complete()'::regprocedure`;
   requireInstallation(prerequisite?.trusted,'untrusted completeness predicate app.access_all_function_bindings_complete()');
   const [coverage]=await tx<{complete:boolean}[]>`select app.access_all_function_bindings_complete() as complete`;
   requireInstallation(coverage?.complete===true,'app.access_all_function_bindings_complete() reported incomplete enforcement');
  }
  const nativeHooks=[...new Set(domains.flatMap(domain=>[domain.legacyParityFunction,domain.currentLegacyParityFunction,domain.functionLegacyParityFunction,domain.functionCurrentLegacyParityFunction,...(domain.functions??[]).flatMap(descriptor=>descriptor.actions.map(action=>action.delegationFloorFunction))].filter((hook):hook is string=>!!hook)))];
  for(const hook of nativeHooks){
   requireInstallation(/^app\.[a-z][a-z0-9_]*$/.test(hook));
   const [trusted]=await tx<{ok:boolean}[]>`select p.prosecdef and p.proowner=c.relowner and not has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as ok from pg_proc p cross join pg_class c where p.oid=to_regprocedure(${hook+'(uuid,uuid,text,uuid)'}) and c.oid='public.access_capability'::regclass`;
   requireInstallation(trusted?.ok);
  }
  const defaultDefinitions=domains.flatMap(domain=>[...(domain.legacyParityFunction?domain.capabilities.map(capability=>({id:capability.id,hook:domain.legacyParityFunction!,currentHook:domain.currentLegacyParityFunction!})):[]),...(domain.functionLegacyParityFunction?functionActionCapabilities(domain.functions??[]).map(capability=>({id:capability.id,hook:domain.functionLegacyParityFunction!,currentHook:domain.functionCurrentLegacyParityFunction!})):[])]);
  let defaultsReady=true;
  for(const definition of defaultDefinitions){const [row]=await tx<{parity_function:string;current_parity_function:string}[]>`select parity_function,current_parity_function from app.access_native_capability_default where capability_id=${definition.id}`;requireInstallation(!row||row.parity_function===definition.hook&&row.current_parity_function===definition.currentHook);if(!row)defaultsReady=false;}
  if(already&&defaultsReady)return {version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,changed:false,capabilities:WORKFORCE_CAPABILITY_BINDINGS.length,tenantsFenced:0};
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
  if(includeWorkforce&&!rows.find(row=>row.id==='workforce.add')?.supported){
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
  }
  // Only source-defined legacy groups receive defaults. Live native sources separately preserve
  // roles with no legacy group, without changing a human override or inventing a global role.
  // Each physical operation continues to enforce its original native floor after publication.
  for(const domain of ACTION_DOMAIN_PUBLICATIONS){
   for(const capability of domain.capabilities){
    if(rows.find(row=>row.id===capability.id)?.supported)continue;
    const groups=domain.legacyGroups[capability.id]??[];
    await tx`insert into public.access_group_grant(tenant_id,group_id,capability_id)
     select g.tenant_id,g.id,${capability.id} from public.access_group g
     where g.retired_at is null and g.legacy_key=any(${[...groups]}::text[]) on conflict do nothing`;

   }
  }
  for(const domain of ACTION_DOMAIN_PUBLICATIONS as readonly DomainPublication[]){
   const defaults=[...(domain.legacyParityFunction?domain.capabilities.map(capability=>({id:capability.id,hook:domain.legacyParityFunction!,currentHook:domain.currentLegacyParityFunction!})):[]),...(domain.functionLegacyParityFunction?functionActionCapabilities(domain.functions??[]).map(capability=>({id:capability.id,hook:domain.functionLegacyParityFunction!,currentHook:domain.functionCurrentLegacyParityFunction!})):[])];
   for(const definition of defaults){
    const installed=await tx<{parity_function:string;current_parity_function:string}[]>`select parity_function,current_parity_function from app.access_native_capability_default where capability_id=${definition.id}`;
    requireInstallation(!installed.length||installed[0].parity_function===definition.hook&&installed[0].current_parity_function===definition.currentHook);
    await tx`insert into app.access_native_capability_default(capability_id,parity_function,current_parity_function) values(${definition.id},${definition.hook},${definition.currentHook}) on conflict do nothing`;
   }
  }
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
     ${JSON.stringify({version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,package:key,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,capabilities:WORKFORCE_CAPABILITY_BINDINGS.map(c=>c.id),legacyRolesChanged:false})}::text::jsonb)`;
  }
  return {version:WORKFORCE_CAPABILITY_PUBLICATION_VERSION,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256,changed:true,capabilities:WORKFORCE_CAPABILITY_BINDINGS.length,tenantsFenced:tenants.length};
 });
}
