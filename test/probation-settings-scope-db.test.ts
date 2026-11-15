/** Migration 5742 and core/probation-settings-scope.ts: group standard, company overrides, overlap refusal, pinning and authority. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {PROBATION_SETTINGS_FIELD_DEFAULTS} from '../lib/probation-model';
import {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,installProbationDrafts,probationSetup,probationSettingsScope,refreshProbationCompanySettings,retireProbationCompanySetting,saveProbationConfiguration,saveProbationSettingsScope,type ProbationSettings} from '../packs/probation/service';

let b:Base,admin:SessionContext,second:string,third:string;
const standardData=(patch:Partial<ProbationSettings>={}):ProbationSettings=>({...structuredClone(DEFAULT_PROBATION_CONFIG),...PROBATION_SETTINGS_FIELD_DEFAULTS,overrides:[],...patch});
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 second=(await createCompany(admin,{legalName:'Fictional Retail Sdn Bhd',country:'MY',currency:'MYR'})).id;
 third=(await createCompany(admin,{legalName:'Fictional Projects Sdn Bhd',country:'MY',currency:'MYR'})).id;
});
async function member(){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional employee without module',${randomUUID()+'@scope.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
}
const resolved=async(companyId:string)=>(await probationSetup(admin,companyId)).settings;

describe('group standard and company settings',()=>{
 it('keeps per-company versions until a standard is published, then resolves standard ⊕ override for every company',async()=>{
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:{...DEFAULT_PROBATION_CONFIG,issueLeadDays:28},publish:true,expectedVersion:0});
  const before=await probationSettingsScope(admin);
  expect(before).toMatchObject({canConfigure:true,standard:null,companySettings:[]});
  expect(before.companies.map(c=>c.id)).toEqual(expect.arrayContaining([b.companyId,second,third]));
  expect(before.companies.find(c=>c.id===b.companyId)).toMatchObject({settingsVersion:1,provenance:null,current:true});

  const retail=await saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Retail',companyIds:[second],data:{issueLeadDays:21,kpiGate:'warn'},publish:true,expectedVersion:0});
  expect(retail.resolvedVersions).toBe(0);
  expect(await resolved(second)).toBeNull();
  expect((await resolved(b.companyId))?.data.issueLeadDays).toBe(28);

  const standard=await saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standardData(),publish:true,expectedVersion:0,reason:'Consolidate company settings'});
  expect(standard.resolvedVersions).toBeGreaterThanOrEqual(3);
  const first=await resolved(b.companyId),retailVersion=await resolved(second),projects=await resolved(third);
  expect(first?.version).toBe(2);
  expect(first?.data).toMatchObject({issueLeadDays:30,kpiGate:'block',scope:{standardId:standard.id,standardVersion:1,overrideId:null,fields:[]}});
  expect(retailVersion?.data).toMatchObject({issueLeadDays:21,kpiGate:'warn',defaultMonths:6,scope:{standardVersion:1,overrideId:retail.id,overrideName:'Retail',fields:['issueLeadDays','kpiGate']}});
  expect(projects?.data).toMatchObject({issueLeadDays:30,scope:{overrideId:null}});

  const view=await probationSettingsScope(admin);
  expect(view.standard).toMatchObject({settingKey:standard.settingKey,latestVersion:1,latestState:'published'});
  expect(view.members).toEqual([{companyId:second,settingKey:retail.settingKey,settingName:'Retail',fields:['issueLeadDays','kpiGate']}]);
  expect(view.companies.every(c=>c.current)).toBe(true);

  const events=await owner.db.execute<{type:string;resolved:string}>(sql`select event_type as type,payload->>'resolvedVersions' as resolved from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='probation_settings' order by sequence`);
  expect(events.map(e=>e.type)).toEqual(['probation.settings_scope.published','probation.settings_scope.published']);
 });

 it('refuses a company in two company settings, direct company settings versions and incomplete standards',async()=>{
  await saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standardData(),publish:true,expectedVersion:0});
  const retail=await saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Retail',companyIds:[second],data:{lowBand:3},publish:true,expectedVersion:0});
  await expect(saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Projects',companyIds:[second,third],data:{issueLeadDays:14},publish:true,expectedVersion:0})).rejects.toThrow(/only one company setting/);
  const draft=await saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Projects',companyIds:[second,third],data:{issueLeadDays:14},publish:false,expectedVersion:0});
  expect(draft.resolvedVersions).toBe(0);
  const[members]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_settings_scope_member where tenant_id=${b.tenantId}::uuid`);expect(members.n).toBe(1);
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:true,expectedVersion:(await probationSetup(admin,b.companyId)).latestVersion.settings})).rejects.toThrow();
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'form',data:DEFAULT_PROBATION_FORM,publish:false,expectedVersion:0});
  await expect(saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Second standard',companyIds:[],data:standardData(),publish:true,expectedVersion:0})).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_settings_scope_save(${randomUUID()}::uuid,'company','Bad',array[${third}::uuid],'{"extensionMonths":[1]}'::jsonb,true,0,null)`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_settings_scope_save(${randomUUID()}::uuid,'company','Bad',array[${third}::uuid],'{"issueLeadDays":"30"}'::jsonb,true,0,null)`))).rejects.toThrow();
  await expect(saveProbationSettingsScope(admin,{settingKey:retail.settingKey,scope:'company',name:'Retail',companyIds:[second],data:{lowBand:4},publish:true,expectedVersion:0})).rejects.toThrow(/changed/);
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into probation_settings_scope_member(tenant_id,company_id,setting_key,version_id) values(${b.tenantId}::uuid,${third}::uuid,${randomUUID()}::uuid,${retail.id}::uuid)`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_settings_materialize(array[${third}::uuid])`))).rejects.toThrow();
 });

 it('pins the resolved values on a case so later standard changes never move it, while shielded companies keep their override',async()=>{
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'form',data:DEFAULT_PROBATION_FORM,publish:true,expectedVersion:0});
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'route',data:defaultProbationRoutes(),publish:true,expectedVersion:0});
  const standard=await saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standardData(),publish:true,expectedVersion:0});
  const retail=await saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Retail',companyIds:[second],data:{issueLeadDays:21},publish:true,expectedVersion:0});
  const setup=await probationSetup(admin,b.companyId);
  const hire=await hireEmployee(admin,{person:{fullName:'Fictional pinned starter',primaryEmail:randomUUID()+'@scope.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  const caseId=randomUUID(),config=setup.settings!.data;
  const data={id:caseId,employmentId:hire.employmentId,companyId:b.companyId,sourceKey:'employment:'+hire.employmentId,startOn:'2026-01-01',originalEndOn:'2026-06-30',endOn:'2026-06-30',gradeAtStart:'12',revision:1,config,planMonths:6,planFlag:false,extensionCount:0,kpiAcknowledged:false,state:'kpi_setting',pendingOutcome:null,facts:{employeeName:'Fictional pinned starter',holders:{employee:null,lm:null,hod:null,pbp:null}}};
  await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${hire.employmentId}::uuid,${data.sourceKey},${setup.settings!.id}::uuid,${setup.form!.id}::uuid,${setup.route!.id}::uuid,${JSON.stringify(data)}::jsonb)`);

  const v2=await saveProbationSettingsScope(admin,{settingKey:standard.settingKey,scope:'standard',name:'Group standard',companyIds:[],data:standardData({issueLeadDays:45,kpiGate:'warn'}),publish:true,expectedVersion:1});
  const[pinned]=await owner.db.execute<{settingsId:string;lead:number;pinnedLead:number;standardVersion:number}>(sql`select c.settings_id as "settingsId",(c.data->'config'->>'issueLeadDays')::int as lead,(s.data->>'issueLeadDays')::int as "pinnedLead",(c.data->'config'->'scope'->>'standardVersion')::int as "standardVersion" from probation_case c join probation_configuration s on s.id=c.settings_id where c.id=${caseId}::uuid`);
  expect(pinned).toEqual({settingsId:setup.settings!.id,lead:30,pinnedLead:30,standardVersion:1});
  expect((await resolved(b.companyId))?.data).toMatchObject({issueLeadDays:45,kpiGate:'warn',scope:{standardId:v2.id,standardVersion:2}});
  expect((await resolved(second))?.data).toMatchObject({issueLeadDays:21,kpiGate:'warn',scope:{standardVersion:2,overrideId:retail.id}});

  // Maximum extensions is a setting (migration 5746): a company may allow fewer; the running case keeps the 2 it pinned.
  const projects=await saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Projects',companyIds:[b.companyId],data:{maxExtensions:0},publish:true,expectedVersion:0});
  expect((await resolved(b.companyId))?.data).toMatchObject({maxExtensions:0,scope:{overrideId:projects.id}});
  const[pinnedMax]=await owner.db.execute<{max:number}>(sql`select app.probation_max_extensions(data) as max from probation_case where id=${caseId}::uuid`);expect(pinnedMax.max).toBe(2);
  const[zero]=await owner.db.execute<{max:number}>(sql`select app.probation_max_extensions(jsonb_build_object('config',jsonb_build_object('maxExtensions',0))) as max`);expect(zero.max).toBe(0);
  await expect(saveProbationSettingsScope(admin,{settingKey:projects.settingKey,scope:'company',name:'Projects',companyIds:[b.companyId],data:{maxExtensions:3},publish:true,expectedVersion:1})).rejects.toThrow();
  await retireProbationCompanySetting(admin,{settingKey:retail.settingKey,expectedVersion:1,reason:'Retail follows the group standard again'});
  expect((await resolved(second))?.data).toMatchObject({issueLeadDays:45,scope:{overrideId:null,fields:[]}});
  // The Projects setting added above for the pinned case's company stays; only the retired Retail setting's member is gone.
  expect((await probationSettingsScope(admin)).members).toEqual([{companyId:b.companyId,settingKey:projects.settingKey,settingName:'Projects',fields:['maxExtensions']}]);
  expect(await refreshProbationCompanySettings(admin,second)).toBe(0);
 });

 it('answers nothing to people without the Probation module permission and isolates tenants',async()=>{
  await saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standardData(),publish:true,expectedVersion:0});
  const ctx=await member();
  expect(await probationSettingsScope(ctx)).toMatchObject({canConfigure:false,standard:null,companies:[]});
  await expect(saveProbationSettingsScope(ctx,{settingKey:null,scope:'company',name:'Sneaky',companyIds:[second],data:{lowBand:5},publish:true,expectedVersion:0})).rejects.toThrow();
  const rows=await withTenant(ctx,tx=>tx.execute(sql`select id from probation_settings_scope_version`));expect(rows).toHaveLength(0);
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
  expect((await probationSettingsScope(adminCtx(foreign))).standard).toBeNull();
  await expect(saveProbationSettingsScope(admin,{settingKey:null,scope:'company',name:'Foreign',companyIds:[foreign.companyId],data:{lowBand:3},publish:true,expectedVersion:0})).rejects.toThrow();
 });
});

describe('existing company versions on a populated installation',()=>{
 it('keeps the company version and its running cases untouched when the migration runs and nothing is published',async()=>{
  await installProbationDrafts(admin,b.companyId);
  const setup=await probationSetup(admin,b.companyId);
  expect(setup.settingsScoped).toBe(false);
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:true,expectedVersion:setup.latestVersion.settings});
  const after=await probationSetup(admin,b.companyId);
  expect(after.settings?.data.scope).toBeUndefined();
  const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_settings_scope_version`);expect(count.n).toBe(0);
 });
});
