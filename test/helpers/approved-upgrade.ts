/** Exact approved forward tail and its ONE intended populated permission transition.
 * Historical receipts remain pinned by each owning fixture. No migration or old audit row is skipped. */
import {expect} from 'vitest';
import {PERFORMANCE_MIGRATION_IDENTITIES} from '../performance-migration-identities';
import {createHash} from 'node:crypto';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {createDb} from '../../db/client';
type Database=ReturnType<typeof createDb>;
type Row=Record<string,unknown>;
export const APPROVED_UPGRADE_TAIL=[
 {idx:1353,when:1793330001506,tag:'2106_account_management_subject'},
 {idx:1354,when:1793330001507,tag:'2107_probation_module_permission'},
 {idx:1355,when:1793330001508,tag:'2108_rewards_entity_classification'},
 {idx:1356,when:1793330001509,tag:'2109_org_chart_roots'},
 {idx:1357,when:1793330001510,tag:'2110_pay_formula_personnel_registry'},
 {idx:1358,when:1793330001511,tag:'2111_probation_personnel_mapping'},
 {idx:1380,when:1793330001526,tag:'2126_company_organisation_tagging'},
 {idx:1381,when:1793330001527,tag:'2127_personnel_filter_search'},
 {idx:1382,when:1793330001528,tag:'2128_organisation_account_admission'},
 {idx:1383,when:1793330001530,tag:'2130_approved_company_retention'},
 {idx:1410,when:1793330001610,tag:'2210_personnel_projection_reuse'},
 // Pending main payroll learning, then the combined Architecture, Rewards and Registration successors.
 {idx:1411,when:1793330001611,tag:'2013_payroll_learned_baseline'},
 {idx:1412,when:1793330001612,tag:'2200_job_architecture'},
 {idx:1413,when:1793330001613,tag:'2201_job_architecture_documents'},
 {idx:1414,when:1793330001614,tag:'2202_job_architecture_profile'},
 {idx:1415,when:1793330001615,tag:'2203_rewards_libraries_pat'},
 {idx:1416,when:1793330001616,tag:'2204_rewards_plan_setup'},
 {idx:1417,when:1793330001617,tag:'2205_rewards_review_creation'},
 {idx:1418,when:1793330001618,tag:'2206_rewards_role_permissions'},
 {idx:1419,when:1793330001619,tag:'2207_reward_advisor'},
 {idx:1420,when:1793330001620,tag:'2208_rewards_uploaded_awards'},
 {idx:1421,when:1793330001621,tag:'2209_company_registration_classification'},
 {idx:1422,when:1793330001622,tag:'2211_company_retention_approved_expansion'},
 {idx:1450,when:1793330001650,tag:'2250_rewards_whole_group_grants'},
 {idx:1451,when:1793330001651,tag:'2251_company_display_group'},
 {idx:1500,when:1793330001700,tag:'2300_retire_job_architecture_workflows'},
 {idx:1550,when:1793330001850,tag:'2450_personnel_search_projection'},
 {idx:1551,when:1793330001851,tag:'2451_personnel_company_filter_choices'},
 ...PERFORMANCE_MIGRATION_IDENTITIES.map(({idx,when,tag})=>({idx,when,tag})),
] as const;
// Final pending 2109/2126 bytes reviewed from engine 128bc2539; no applied-prefix hashes change.
const APPROVED_UPGRADE_HASHES:Record<string,string>={
 '2106_account_management_subject':'d4bbd5d20d9b40294b31d022a3ec0cf29e9a290f10749493c4934db31c5cdd67',
 '2107_probation_module_permission':'da94777be8e2b3f4365851eb785a64baaf9c54e9fb64808f7c72379ee94732f8',
 '2108_rewards_entity_classification':'8f485227fba437d5a24bc8b762630c670c38364d98d10e85802ce6e05bddd1c6',
 '2109_org_chart_roots':'71354dedee1e268a87846e5e983c267f4e1ade19704f5116e476dbc0f784ce2d',
 '2110_pay_formula_personnel_registry':'049f95c71a155eb95846e2d44d837624f5ee07c44c8911aae8e68188f66b9dc8',
 '2111_probation_personnel_mapping':'f280a7cf60fc1f3be24dee090fd8526454c6e65200ff10eba0728cbce82e5e24',
 '2126_company_organisation_tagging':'54e259de501c50db5c5cf930ea4e0d23c85a60e603d6ae7569b572365c83effd',
 '2127_personnel_filter_search':'ce56780cd696e805c4a217316b9d36bc411cfa0f8a5015c53a46e7ff9b606283',
 '2128_organisation_account_admission':'c239e97d982c0e5e2075e30c5b431ef03f8f61ff367f6660602234a6c74dd62d',
 '2130_approved_company_retention':'6d549d157a0c21f1da680daa1546cd45bd2f19187b8d7a9d9a4dc56482d68d2c',
 '2210_personnel_projection_reuse':'84665a381ed31061437c601197d9a9f8da5f8a5573abef5c09c0603b4546d613',
 '2013_payroll_learned_baseline':'bd490fda5f21c713262ecc6c8a29e8ed5dc88e0c963e201be7745bdc5a351da3',
 '2200_job_architecture':'85a609473361238e5aa44aaaea0b788cd0b8d354b6fd67c70be3c3506dd52a64',
 '2201_job_architecture_documents':'54bdaf9bf1a810fc5b7304813fb396a1a3640d323c2e9e2cf236cdf184cb12f7',
 '2202_job_architecture_profile':'2d49add7961177b8032cdf891446e6d4758c4e94e53ed957406bb7fcbdf3224d',
 '2203_rewards_libraries_pat':'f03d8d83b009054cce059cb9b87b35d3ea97bb54a6d63d96e311cfdffc3504ad',
 '2204_rewards_plan_setup':'311201ad2e3e745ea142e6ec8ea275887bfd02097e009f81c6a08ea7ad06e56c',
 '2205_rewards_review_creation':'37ffb2122b551cb7e01c5df2b4765d0ceaf1af030da2fb8c8c7a2977c3dbcd53',
 '2206_rewards_role_permissions':'30788b82fa2a31be1168596e88bd59f73f42db79040f341463e907443aa7edaf',
 '2207_reward_advisor':'be660e08105928d50c81775a9f01eab3a5c1a572dbec9e1a8929f682fc68ef6b',
 '2208_rewards_uploaded_awards':'97012d64969a58fe52f611aee883d61822e3021d5ed49bccac276f217119eefb',
 '2209_company_registration_classification':'9685fcef72990612baedf333b4af3fe8c4d3e0a6ebe9611bcc7eabea466ad0e0',
 '2211_company_retention_approved_expansion':'5e336a948b9490d9355eba65d6f341618334a031c7bdc66562ed9139b7c5f0c4',
 '2250_rewards_whole_group_grants':'dc3437a768104a0be69f38adc395d7d814efb01f0feb66d7fc1af84c971f9e27',
 '2251_company_display_group':'3015af6a8183b9e01fbb42c165fe2ce83eb6d167d0b7cd61210144cd6d292a8a',
 '2300_retire_job_architecture_workflows':'0baf5adae50036cb20634ec362c1302b8c6c45f38ec8610f68e5c1bdc9ebedda',
 '2450_personnel_search_projection':'4e349dd20f6d55562ada2709b092543abab69390a5903a89b49407ed29357fe8',
 '2451_personnel_company_filter_choices':'06e8f11ebe34c106bffba5985db366258a72accfb31ad931bb0825fbd0fe23b6',
 ...Object.fromEntries(PERFORMANCE_MIGRATION_IDENTITIES.map(({tag,hash})=>[tag,hash])),
};
export function assertApprovedUpgradeTail(entries:{idx:number;when:number;tag:string}[]){
 expect(entries).toHaveLength(671+APPROVED_UPGRADE_TAIL.length);
 expect(entries.slice(671)).toEqual(APPROVED_UPGRADE_TAIL.map(entry=>({...entry,version:'7',breakpoints:true})));
 for(const entry of APPROVED_UPGRADE_TAIL)expect(createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),entry.tag+' reviewed pending SQL identity').toBe(APPROVED_UPGRADE_HASHES[entry.tag]);
}
const payload={capabilityId:'probation.module',scope:'tenant',initialHolders:'current-named-admins-and-system-administrators',legacyAssignmentsRetained:true};
export type ApprovedUpgradeWitness={events:Row[];eventsRaw:Row[];grants:Row[];overrides:Row[];configurations:{before:Row;after:Row}[];generations:{before:Row;after:Row}[]};
const canonical=(row:unknown)=>JSON.stringify(row,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const ordered=(rows:Row[])=>rows.map(canonical).sort();
async function table(db:Database,name:string):Promise<Row[]>{return (await db.client.unsafe('select to_jsonb(t) value from '+name+' t order by to_jsonb(t)::text')).map(row=>row.value as Row);}
/** Stage the complete ordinary prefix immediately before 2107, inspect exactly that transition,
 * then migrate every remaining journal entry. No SQL is installed outside the ordinary migrator. */
export async function migrateApprovedUpgrade(db:Database, migrationsFolder = 'db/migrations'):Promise<ApprovedUpgradeWitness>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 assertApprovedUpgradeTail(journal.entries);
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='2107_probation_module_permission');
 const folder=mkdtempSync(join(tmpdir(),'aihr-approved-permission-upgrade-'));
 try{
  mkdirSync(join(folder,'meta'));
  for(const entry of journal.entries.slice(0,boundary+1))copyFileSync('db/migrations/'+entry.tag+'.sql',join(folder,entry.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(db.db,{migrationsFolder:folder});
  const configs=await table(db,'public.access_configuration'),generations=await table(db,'app.access_profile_write_generation');
  const groups=await table(db,'public.access_group'),users=await table(db,'public.app_user'),legacyAccess=await table(db,'public.probation_access'),memberships=await table(db,'public.access_membership'),capabilities=await table(db,'public.access_capability');
  const groupsBefore=await table(db,'public.access_group_grant'),overridesBefore=await table(db,'public.access_user_override'),eventsBefore=await table(db,'public.domain_event');
  const eligible=(await db.client`select tenant_id from access_configuration union select tenant_id from probation_access order by tenant_id`).map(row=>String(row.tenant_id));
  const namedAdmins=await db.client`select distinct a.tenant_id,a.user_id from probation_access a join app_user u on u.id=a.user_id and u.tenant_id=a.tenant_id where a.role='admin' and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date) and u.archived_at is null and not app.login_blocked(u.id) order by a.tenant_id,a.user_id`;
  const [clock]=await db.client`select clock_timestamp()::text at`;
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary+1)}));
  await migrate(db.db,{migrationsFolder:folder});
  const groupAfter=await table(db,'public.access_group_grant'),overrideAfter=await table(db,'public.access_user_override'),eventsAfter=await table(db,'public.domain_event');
  const eventsRaw=[...await db.client`select * from domain_event order by id`] as Row[];
  const newRows=(before:Row[],after:Row[])=>after.filter(row=>!before.some(old=>old.id===row.id));
  const grants=newRows(groupsBefore,groupAfter),overrides=newRows(overridesBefore,overrideAfter),events=newRows(eventsBefore,eventsAfter);
  for(const [before,after] of [[groupsBefore,groupAfter],[overridesBefore,overrideAfter],[eventsBefore,eventsAfter]])expect(ordered(after.filter(row=>before.some(old=>old.id===row.id)))).toEqual(ordered(before));
  const expectedGroups=groups.filter(row=>eligible.includes(String(row.tenant_id))&&row.system_administrator===true&&row.retired_at===null).map(row=>({tenant_id:row.tenant_id,group_id:row.id,capability_id:'probation.module',company_id:null,retired_at:null}));
  expect(ordered(grants.map(({tenant_id,group_id,capability_id,company_id,retired_at})=>({tenant_id,group_id,capability_id,company_id,retired_at})))).toEqual(ordered(expectedGroups));
  expect(ordered(overrides.map(({tenant_id,user_id,capability_id,effect,company_id,retired_at})=>({tenant_id,user_id,capability_id,effect,company_id,retired_at})))).toEqual(ordered(namedAdmins.map(({tenant_id,user_id})=>({tenant_id,user_id,capability_id:'probation.module',effect:'allow',company_id:null,retired_at:null}))));
  for(const row of [...grants,...overrides]){expect(String(row.id)).toMatch(/^[0-9a-f-]{36}$/);expect(Date.parse(String(row.created_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));}
  expect(events).toHaveLength(eligible.length);
  expect(events.map(row=>String(row.tenant_id)).sort()).toEqual(eligible.slice().sort());
  for(const event of events){
   expect(event).toMatchObject({aggregate_type:'access-configuration',aggregate_id:event.tenant_id,event_type:'probation.module-permission.registered',actor_type:'system',actor_id:null,subject_employment_id:null,payload});
   expect(event.payload).toEqual(payload);expect(String(event.id)).toMatch(/^[0-9a-f-]{36}$/);
   expect(Date.parse(String(event.occurred_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));
  }
  const capabilityAfter=await table(db,'public.access_capability');
  expect(ordered(capabilityAfter.filter(row=>row.id!=='probation.module'))).toEqual(ordered(capabilities));
  expect(capabilityAfter.filter(row=>row.id==='probation.module')).toEqual([{id:'probation.module',scope:'tenant',supported:true,bindings:[{owner:'app.probation_config_admin',operation:'configure-all-entitled-companies'},{owner:'app.probation_request_activation',operation:'activate-reviewed-cutover'},{owner:'app.probation_navigation_access',operation:'page'}]}]);
  expect(await table(db,'public.probation_access')).toEqual(legacyAccess);expect(await table(db,'public.access_membership')).toEqual(memberships);
  const configsAfter=await table(db,'public.access_configuration'),generationsAfter=await table(db,'app.access_profile_write_generation');
  expect(configsAfter).toHaveLength(configs.length);expect(generationsAfter).toHaveLength(generations.length);
  const configurations=configs.map(before=>{
   const after=configsAfter.find(row=>row.tenant_id===before.tenant_id)!;
   expect(after).toEqual({...before,revision:after.revision,updated_at:after.updated_at});
   expect(after.revision).not.toBe(before.revision);expect(Date.parse(String(after.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));
   return {before,after};
  });
  const generationPairs=generations.map(before=>{
   const after=generationsAfter.find(row=>row.tenant_id===before.tenant_id)!;
   expect(after).toEqual({...before,generation:Number(before.generation)+(configs.some(row=>row.tenant_id===before.tenant_id)?1:0)});return {before,after};
  });
  expect(await table(db,'public.access_group')).toEqual(groups);expect(await table(db,'public.app_user')).toEqual(users);
  await migrate(db.db,{migrationsFolder});
  expect(await db.client`select id from public.company where display_group_field is not null or display_group_option_id is not null`).toEqual([]);
  expect(await db.client`select user_id from public.reward_group_role_grant`).toEqual([]);
  expect(await table(db,'public.domain_event')).toEqual(eventsAfter);
  expect(await table(db,'public.access_group_grant')).toEqual(groupAfter);expect(await table(db,'public.access_user_override')).toEqual(overrideAfter);
  expect(await table(db,'public.access_configuration')).toEqual(configsAfter);expect(await table(db,'app.access_profile_write_generation')).toEqual(generationsAfter);
  return {events,eventsRaw:eventsRaw.filter(row=>events.some(event=>event.id===row.id)),grants,overrides,configurations,generations:generationPairs};
 }finally{rmSync(folder,{recursive:true,force:true});}
}
/** Remove ONLY exact independently validated new rows, or restore ONLY exact independently
 * validated permission revisions. Unexpected audit mutations or extra rows remain visible. */
export function retainedUpgradeRows(name:string,rows:unknown[],witness?:ApprovedUpgradeWitness):unknown[]{
 const tableName=name.replace(/^public\./,'');
 const result=rows.flatMap(item=>{
  const parsed=typeof item==='string'?JSON.parse(item):item;
  const wrapper=parsed as Row;
  const field=wrapper&&typeof wrapper==='object'&&Object.keys(wrapper).length===1&&('row' in wrapper||'value' in wrapper)?('row' in wrapper?'row':'value'):null;
  const row=(field?wrapper[field]:parsed) as Row;
  let normalized=row;
  if(tableName==='company'&&row.display_group_field===null&&row.display_group_option_id===null){
   const {display_group_field:_field,display_group_option_id:_option,...original}=row;
   normalized=original;
  }
  if(witness){
   const additions=tableName==='domain_event'||tableName==='audit'?witness.events:tableName==='access_group_grant'?witness.grants:tableName==='access_user_override'?witness.overrides:[];
   const added=additions.find(value=>value.id===row.id);
   if(added){const raw=witness.eventsRaw.find(value=>value.id===row.id);expect([canonical(added),...(raw?[canonical(raw)]:[])]).toContain(canonical(row));return [];}
   const pairs=name==='app.access_profile_write_generation'?witness.generations:tableName==='access_configuration'?witness.configurations:[];
   const pair=pairs.find(value=>value.after.tenant_id===row.tenant_id);
   if(pair){
    // Fixtures may compare only their original columns. Each present changed field must match
    // the fully validated transition before its original value is restored for comparison.
    normalized={...row};
    for(const key of Object.keys(pair.before))if(key in row&&canonical(pair.before[key])!==canonical(pair.after[key])){expect(row[key]).toEqual(pair.after[key]);normalized[key]=pair.before[key];}
   }
  }
  return [typeof item==='string'?canonical(normalized):field?{...wrapper,[field]:normalized}:normalized];
 });
 return rows.every(item=>typeof item==='string')?(result as string[]).sort():result;
}
export function retainedUpgradeSnapshot(snapshot:Record<string,unknown>,witness?:ApprovedUpgradeWitness){return Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,Array.isArray(value)?retainedUpgradeRows(key,value,witness):value]));}
/** Preserve every original column of the explicitly owned synthetic business rows across a
 * second, full-source phase. Later nullable schema additions are not mistaken for rewritten facts. */
export async function captureTenantUpgradeRows(db:Database,tenantIds:string[],names:string[]){
 const definitions=await Promise.all(names.map(async name=>{
  const [schema,tableName]=name.includes('.')?name.split('.'):['public',name];
  const columns=(await db.client`select column_name from information_schema.columns where table_schema=${schema} and table_name=${tableName} order by ordinal_position`).map(row=>String(row.column_name));
  expect(columns.length,name+' original columns').toBeGreaterThan(0);
  return {name,schema,tableName,columns};
 }));
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 const read=async()=>{
  const snapshot:Record<string,unknown>={};
  for(const definition of definitions){
   const scoped=definition.columns.includes('tenant_id')?' where t.tenant_id=any($1::uuid[])':definition.tableName==='tenant'?' where t.id=any($1::uuid[])':'';
   const params=scoped?[tenantIds,definition.columns]:[definition.columns];
   const index=scoped?2:1;
   snapshot[definition.name]=await db.client.unsafe('select value from (select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any($'+index+'::text[])) value from '+quote(definition.schema)+'.'+quote(definition.tableName)+' t'+scoped+') retained order by retained.value::text',params);
  }
  return snapshot;
 };
 return {before:await read(),read};
}
