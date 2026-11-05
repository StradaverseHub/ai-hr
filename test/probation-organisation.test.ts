import {pgErrorChain} from '../lib/db-error';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {DEFAULT_PROBATION_CONFIG,saveProbationConfiguration,probationSetup,probationAdministrationOptions} from '../core/probation';
import {probationOrganisationFacts,probationOrganisationCatalog} from '../lib/probation-organisation';
import {effectiveProbationSettings} from '../lib/probation-configuration';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');});
async function refusesRule(work:Promise<unknown>,message:string){
 const error=await work.then(()=>null,error=>error);
 expect(pgErrorChain(error)).toEqual(expect.arrayContaining([expect.objectContaining({code:'P0001',message:expect.stringContaining(message)})]));
}
const legacy={companyId:'company-employer',companyName:'Fictional Employer',businessGroupId:'company-parent',businessGroup:'Fictional Parent',businessUnitId:'pm-business-unit',businessUnit:'Fictional Personnel Unit',grade:'12'};
describe('versioned Probation organisation vocabulary',()=>{
 it('projects identity types explicitly, round-trips legacy snapshots, and never mutates the original',()=>{
  const original=structuredClone(legacy),next=probationOrganisationFacts(legacy,'personnel-v2');
  expect(next).toMatchObject({businessGroupId:'pm-business-unit',businessGroup:'Fictional Personnel Unit',businessUnitId:'company-employer',businessUnit:'Fictional Employer'});
  expect(probationOrganisationFacts(next,'legacy-v1')).toMatchObject(legacy);expect(legacy).toEqual(original);
  expect(probationOrganisationFacts({...legacy,businessUnitId:null,businessUnit:null},'personnel-v2')).toMatchObject({businessGroupId:null,businessUnitId:'company-employer'});
 });
 it('matches old settings against the legacy identities even when current source uses the reviewed vocabulary',()=>{
  const facts=probationOrganisationFacts(legacy,'personnel-v2');
  const settings={...DEFAULT_PROBATION_CONFIG,overrides:[{businessGroupId:'company-parent',businessUnitId:'pm-business-unit',kpiGate:'warn' as const}]};
  expect(effectiveProbationSettings(settings,facts,12).kpiGate).toBe('warn');
  expect(effectiveProbationSettings({...settings,organisationMapping:'personnel-v2'},facts,12).kpiGate).toBe(DEFAULT_PROBATION_CONFIG.kpiGate);
 });
 it('selects each saved definition catalog independently of the current tenant default',()=>{
  const old={businessGroups:[{id:'company-parent',name:'Old parent'}],businessUnits:[{id:'pm-business-unit',name:'PM Unit',companyId:'company-employer'}]},next={businessGroups:[{id:'pm-business-unit',name:'PM Unit'}],businessUnits:[{id:'company-employer',name:'Employer',companyId:'company-employer'}]};
  const options={...next,organisationCatalogs:{'legacy-v1':old,'personnel-v2':next}};
  expect(probationOrganisationCatalog(options).businessGroups).toEqual(old.businessGroups);expect(probationOrganisationCatalog(options,'personnel-v2').businessUnits).toEqual(next.businessUnits);
 });
 it('leaves the switch off, gates replacement publication, and never lets an app caller change the register',async()=>{
  const ctx=adminCtx(b),[mapping]=await withTenant(ctx,tx=>tx.execute<{mapping:string}>(sql`select app.probation_organisation_mapping() as mapping`));expect(mapping.mapping).toBe('legacy-v1');
  await refusesRule(saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:{...DEFAULT_PROBATION_CONFIG,organisationMapping:'personnel-v2'},publish:true,expectedVersion:0}),'Review the organisation mapping inventory');
  await expect(withTenant(ctx,tx=>tx.execute(sql`insert into probation_organisation_mapping(tenant_id,mapping,reviewed_inventory_digest,approved_by,approved_at) values(${b.tenantId}::uuid,'personnel-v2',${'a'.repeat(64)},${ctx.userId}::uuid,now())`))).rejects.toThrow();
 });
 it('projects new Personnel facts after fictional owner review while retaining old versions and canonical PBP scope identities',async()=>{
  const ctx=adminCtx(b),unitId=randomUUID();
  await owner.db.execute(sql`insert into business_unit(id,tenant_id,company_id,code,name) values(${unitId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'FICTIONAL-MAP','Fictional PM Unit')`);
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional Mapped Employee',primaryEmail:'mapped-'+randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:unitId,employmentType:'full_time',hiredOn:'2026-01-01'});
  const oldSettings={...DEFAULT_PROBATION_CONFIG,overrides:[{businessGroupId:b.companyId,businessUnitId:unitId,kpiGate:'warn' as const}]};
  await saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:oldSettings,publish:true,expectedVersion:0});
  const read=()=>withTenant(ctx,async tx=>(await tx.execute<{facts:Record<string,unknown>}>(sql`select app.probation_personnel_source(${employee.employmentId}::uuid) as facts`))[0].facts);
  expect(await read()).toMatchObject({businessGroupId:b.companyId,businessUnitId:unitId});
  await owner.db.execute(sql`insert into probation_organisation_mapping(tenant_id,mapping,reviewed_inventory_digest,approved_by,approved_at) values(${b.tenantId}::uuid,'personnel-v2',${'b'.repeat(64)},${ctx.userId}::uuid,now())`);
  const facts=await read();expect(facts).toMatchObject({organisationMapping:'personnel-v2',businessGroupId:unitId,businessUnitId:b.companyId,businessGroup:'Fictional PM Unit'});
  await saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:oldSettings,publish:true,expectedVersion:1});
  expect((await probationSetup(ctx,b.companyId)).settings?.data.organisationMapping).toBe('legacy-v1');
  const replacement={...DEFAULT_PROBATION_CONFIG,organisationMapping:'personnel-v2' as const,overrides:[{businessGroupId:unitId,businessUnitId:b.companyId,kpiGate:'off' as const}]};
  // Isolate each invalid identity kind: jsonb object iteration does not promise which of two
  // invalid fields is checked first, and both distinct guards must refuse without saving a version.
  await refusesRule(saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:{...replacement,overrides:[{...replacement.overrides[0],businessGroupId:b.companyId}]},publish:true,expectedVersion:2}),'Invalid Personnel Business Unit identity');
  await refusesRule(saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:{...replacement,overrides:[{...replacement.overrides[0],businessUnitId:unitId}]},publish:true,expectedVersion:2}),'Invalid company identity');
  await saveProbationConfiguration(ctx,{companyId:b.companyId,kind:'settings',data:replacement,publish:true,expectedVersion:2});
  const [history]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_configuration where tenant_id=${b.tenantId}::uuid and data->>'organisationMapping'='legacy-v1'`);expect(history.n).toBe(2);
  const options=await probationAdministrationOptions(ctx);expect(options.businessGroups).toContainEqual(expect.objectContaining({id:unitId,name:'Fictional PM Unit'}));expect(options.businessUnits).toContainEqual(expect.objectContaining({id:b.companyId,companyId:b.companyId}));expect(options.personnelBusinessUnits).toContainEqual(expect.objectContaining({id:unitId}));
  const [sqlScope]=await withTenant(ctx,tx=>tx.execute<{facts:Record<string,unknown>}>(sql`select app.probation_organisation_facts(${JSON.stringify(facts)}::jsonb,'{}'::jsonb) facts`));expect(sqlScope.facts).toMatchObject({businessGroupId:b.companyId,businessUnitId:unitId});
 });
});
