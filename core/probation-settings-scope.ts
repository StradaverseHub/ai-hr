/**
 * Probation settings scope service (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 3; migration 5742).
 *
 * Reads run under row security (only holders of the tenant-level Probation module permission see scoped settings) and
 * are bounded and set-based: one statement each for versions, members, companies and their current resolved versions.
 * Saves go through app.probation_settings_scope_save / _retire / _refresh, which own authority, the write barrier,
 * overlap refusal, the expected version, resolution into company settings versions and the audit event. Meaning is
 * checked here first with the same rules as a company version (validateProbationConfig) so the editor names the field.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {pgErrorChain} from '../lib/db-error';
import {ProbationError,type ProbationSettingsProvenance} from '../lib/probation-model';
import {probationScopeIssues,probationOverrideFields,type ProbationSettingsOverride,type ProbationSettingsScopeKind,type ProbationSettingsScopeState,type ProbationScopeMember} from '../lib/probation-settings-scope';
import {withScopedLifecycleTenant} from './module-gate';
import {isModuleEnabled} from './entitlements';
import type {ProbationSettings} from './probation';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROBATION_SETTING_KEYS=200;
export type ProbationSettingsScopeVersion={id:string;settingKey:string;scope:ProbationSettingsScopeKind;version:number;state:ProbationSettingsScopeState;name:string;companyIds:string[];data:ProbationSettings|ProbationSettingsOverride;publishedAt:string|null;createdAt:string;reason:string|null};
export type ProbationScopedSetting={settingKey:string;scope:ProbationSettingsScopeKind;name:string;latestVersion:number;latestState:ProbationSettingsScopeState;published:ProbationSettingsScopeVersion|null;draft:ProbationSettingsScopeVersion|null};
export type ProbationScopeCompany={id:string;name:string;settingsVersion:number|null;provenance:ProbationSettingsProvenance|null;memberKey:string|null;current:boolean;data:ProbationSettings|null};
export type ProbationSettingsScopeView={canConfigure:boolean;standard:ProbationScopedSetting|null;companySettings:ProbationScopedSetting[];members:ProbationScopeMember[];companies:ProbationScopeCompany[];groups:{id:string;name:string}[];truncated:boolean};

function refusal(error:unknown):never{
 const chain=pgErrorChain(error),database=chain.find(link=>link.code&&/^[0-9A-Z]{5}$/.test(link.code));
 if(database?.code==='42501')throw new ProbationError('forbidden','Probation module permission is required.');
 if(database?.code==='40001')throw new ProbationError('conflict','These probation settings changed. Reload before saving.');
 if(database?.code==='22023'||database?.code==='23505')throw new ProbationError(database.code==='23505'?'conflict':'invalid',database.message??'The probation settings were refused.');
 throw error;
}
const companyAllowed=(ctx:SessionContext,companyId:string)=>ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle',companyId);

/** Everything the settings page shows: settings in use, Applies to, versions, members and each company's resolved version. */
export function probationSettingsScope(ctx:SessionContext):Promise<ProbationSettingsScopeView>{
 return withScopedLifecycleTenant(ctx,async tx=>{
  const[access]=await tx.execute<{ok:boolean}>(sql`select app.probation_settings_scope_admin() as ok`);
  if(!access?.ok)return{canConfigure:false,standard:null,companySettings:[],members:[],companies:[],groups:[],truncated:false};
  const columns=sql`id,setting_key as "settingKey",scope,version,state,name,company_ids::text[] as "companyIds",data,published_at::text as "publishedAt",created_at::text as "createdAt",reason`;
  const latest=await tx.execute<ProbationSettingsScopeVersion>(sql`select * from (select distinct on(setting_key) ${columns} from probation_settings_scope_version where tenant_id=app.current_tenant_id() order by setting_key,version desc) v order by scope desc,name,"settingKey" limit ${MAX_PROBATION_SETTING_KEYS+1}`);
  const truncated=latest.length>MAX_PROBATION_SETTING_KEYS,shown=latest.slice(0,MAX_PROBATION_SETTING_KEYS);
  const published=shown.length?await tx.execute<ProbationSettingsScopeVersion>(sql`select distinct on(setting_key) ${columns} from probation_settings_scope_version where tenant_id=app.current_tenant_id() and state='published' and setting_key=any(array[${sql.join(shown.map(v=>sql`${v.settingKey}::uuid`),sql`, `)}]::uuid[]) order by setting_key,version desc`):[];
  const settings=shown.map(row=>({settingKey:row.settingKey,scope:row.scope,name:row.name,latestVersion:row.version,latestState:row.state,published:published.find(p=>p.settingKey===row.settingKey)??null,draft:row.state==='draft'?row:null}) satisfies ProbationScopedSetting);
  const members=await tx.execute<ProbationScopeMember>(sql`select m.company_id as "companyId",m.setting_key as "settingKey",v.name as "settingName",coalesce((select array_agg(k order by k) from jsonb_object_keys(v.data) k),'{}')::text[] as fields from probation_settings_scope_member m join probation_settings_scope_version v on v.tenant_id=m.tenant_id and v.id=m.version_id where m.tenant_id=app.current_tenant_id() order by m.company_id limit 2000`);
  const companies=(await tx.execute<{id:string;name:string}>(sql`select c.id,c.legal_name as name from company c where c.tenant_id=app.current_tenant_id() and c.archived_at is null and app.probation_config_admin(c.id) order by c.legal_name,c.id limit 2000`)).filter(c=>companyAllowed(ctx,c.id));
  const resolved=companies.length?await tx.execute<{companyId:string;version:number;data:ProbationSettings}>(sql`select distinct on(company_id) company_id as "companyId",version,data from probation_configuration where tenant_id=app.current_tenant_id() and kind='settings' and state='published' and company_id=any(array[${sql.join(companies.map(c=>sql`${c.id}::uuid`),sql`, `)}]::uuid[]) order by company_id,version desc`):[];
  const standard=settings.find(s=>s.scope==='standard')??null,memberOf=new Map(members.map(m=>[m.companyId,m]));
  const memberVersion=new Map(settings.filter(s=>s.scope==='company'&&s.published).map(s=>[s.settingKey,s.published!.id]));
  return{canConfigure:true,truncated,standard,companySettings:settings.filter(s=>s.scope==='company'),members:[...members],groups:await assignmentGroups(ctx),companies:companies.map(company=>{
   const row=resolved.find(r=>r.companyId===company.id),provenance=row?.data.scope??null,member=memberOf.get(company.id)??null;
   const current=!standard?.published||!!provenance&&provenance.standardId===standard.published.id&&(provenance.overrideId??null)===(member?memberVersion.get(member.settingKey)??null:null);
   return{id:company.id,name:company.name,settingsVersion:row?.version??null,provenance,memberKey:member?.settingKey??null,current,data:row?.data??null};
  })};
 });
}

/** Shared assignment groups for the fallback and posting-approver fields; an empty list when the reader is unavailable. */
async function assignmentGroups(ctx:SessionContext):Promise<{id:string;name:string}[]>{
 try{return await withScopedLifecycleTenant(ctx,tx=>tx.execute<{id:string;name:string}>(sql`select group_id as id,group_name as name from app.automation_assignment_groups()`)).then(rows=>[...rows]);}
 catch{return [];}
}

/** Save (draft) or publish the group standard or a company setting. Publishing resolves the affected companies. */
export function saveProbationSettingsScope(ctx:SessionContext,input:{settingKey:string|null;scope:ProbationSettingsScopeKind;name:string;companyIds:string[];data:ProbationSettings|ProbationSettingsOverride;publish:boolean;expectedVersion:number;reason?:string}):Promise<{id:string;settingKey:string;version:number;resolvedVersions:number}>{
 const key=input.settingKey??randomUUID();
 if(!UUID.test(key)||!['standard','company'].includes(input.scope)||!Array.isArray(input.companyIds)||input.companyIds.some(id=>typeof id!=='string'||!UUID.test(id))||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw new ProbationError('invalid','Choose a valid probation setting.');
 for(const id of input.companyIds)if(!companyAllowed(ctx,id))throw new ProbationError('forbidden','Probation module permission is required.');
 const data:Record<string,unknown>=input.scope==='company'?Object.fromEntries(probationOverrideFields(input.data as ProbationSettingsOverride).map(field=>[field,(input.data as Record<string,unknown>)[field]])):{...input.data};
 return withScopedLifecycleTenant(ctx,async tx=>{
  if(input.publish){
   const standard=input.scope==='company'?(await tx.execute<{data:ProbationSettings}>(sql`select data from probation_settings_scope_version where tenant_id=app.current_tenant_id() and scope='standard' and state='published' order by version desc limit 1`))[0]?.data??null:null;
   const issues=probationScopeIssues({scope:input.scope,name:input.name,companyIds:input.companyIds,data:data as ProbationSettings,standard});
   if(input.scope==='company'&&Object.keys(input.data).some(key=>!probationOverrideFields(input.data as ProbationSettingsOverride).includes(key as never)))issues.push('fields');
   if(issues.length)throw new ProbationError('invalid','Check the probation settings before publishing: '+issues.join('; '));
  }
  try{
   const[row]=await tx.execute<{data:{id:string;settingKey:string;version:number;resolvedVersions:number}}>(sql`select app.probation_settings_scope_save(${key}::uuid,${input.scope},${input.name},array[${sql.join(input.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(data)}::jsonb,${input.publish},${input.expectedVersion},${input.reason??null}) as data`);
   return row.data;
  }catch(error){refusal(error);}
 });
}

export function retireProbationCompanySetting(ctx:SessionContext,input:{settingKey:string;expectedVersion:number;reason:string}):Promise<{id:string;version:number;resolvedVersions:number}>{
 if(!UUID.test(input.settingKey))throw new ProbationError('invalid','Choose a valid probation setting.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{data:{id:string;version:number;resolvedVersions:number}}>(sql`select app.probation_settings_scope_retire(${input.settingKey}::uuid,${input.expectedVersion},${input.reason}) as data`);return row.data;}
  catch(error){refusal(error);}
 });
}

/** A company entitled after the standard was published picks up standard ⊕ its override. */
export function refreshProbationCompanySettings(ctx:SessionContext,companyId:string):Promise<number>{
 if(!UUID.test(companyId))throw new ProbationError('invalid','Choose a valid company.');
 if(!companyAllowed(ctx,companyId))throw new ProbationError('forbidden','Probation module permission is required.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{const[row]=await tx.execute<{count:number}>(sql`select app.probation_settings_scope_refresh(${companyId}::uuid) as count`);return row.count;}
  catch(error){refusal(error);}
 });
}
