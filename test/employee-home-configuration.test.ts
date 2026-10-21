import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {validateEmployeeHomeConfiguration,HOME_TEMPLATE_FIELDS,HOME_QUICK_ACTIONS} from '../lib/employee-home';
import {employeeHomeConfigurationCompanies,readEmployeeHomeConfigurationEditor,readOwnEmployeeHomeConfiguration,
 saveEmployeeHomeConfiguration,employeeHomeConfigurationHistory,readEmployeeHomeConfigurationVersion} from '../core/employee-home-configuration';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home config '+randomUUID(),primaryEmail:randomUUID()+'@example.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,role),personId:hired.personId,roles:[role]};
 if(role==='hr_admin'){
  await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,ctx.userId!));
  ctx.grants=[{role:'hr_admin',companyId:b.companyId}];
 }
 return {...hired,ctx};
}
const save=(ctx:SessionContext,configuration=defaultEmployeeHomeConfiguration(),expectedOrdinal=0)=>saveEmployeeHomeConfiguration(ctx,{companyId:b.companyId,audienceRole:'employee',configuration,expectedOrdinal,reason:'Fictional scoped Home configuration review'});
describe('validated deterministic Home configuration',()=>{
 it('provides every template in six languages, four real action identifiers, and privacy-off defaults',()=>{
  const config=defaultEmployeeHomeConfiguration();
  expect(config.templates.map(row=>row.key)).toEqual(Object.keys(HOME_TEMPLATE_FIELDS));
  for(const row of config.templates)expect(Object.keys(row.text).sort()).toEqual(['en','ms','ta','th','vi','zh']);
  expect(config.quickActions).toEqual(['leave','claim','payslip','profile']);
  expect(config.teamVisibility).toBe('off');expect(config.celebrations.enabled).toBe(false);expect(config.effortMinutes).toEqual({});
  config.templates[0].text.en='Changed locally';expect(defaultEmployeeHomeConfiguration().templates[0].text.en).not.toBe('Changed locally');
 });
 it('refuses executable/sensitive placeholders, unsafe links, duplicate/missing templates and invented effort types',()=>{
  for(const bad of ['{salary}','{medicalReason}','{name.__proto__}','<img src=x>']){
   const config=defaultEmployeeHomeConfiguration();config.templates[0].text.en=bad;
   expect(()=>validateEmployeeHomeConfiguration(config)).toThrow();
  }
  const config=defaultEmployeeHomeConfiguration();
  for(const quickActions of [['https://evil.invalid'],[...HOME_QUICK_ACTIONS,'leave'],['leave','leave']])expect(()=>validateEmployeeHomeConfiguration({...config,quickActions})).toThrow();
  for(const templates of [config.templates.slice(1),config.templates.map(()=>config.templates[0])])expect(()=>validateEmployeeHomeConfiguration({...config,templates})).toThrow();
  for(const effortMinutes of [{invented:5},{leave:-1},{leave:1.5},{leave:Infinity}])expect(()=>validateEmployeeHomeConfiguration({...config,effortMinutes})).toThrow();
  expect(validateEmployeeHomeConfiguration({...config,effortMinutes:{leave:0,feedback:5},quickActions:[...HOME_QUICK_ACTIONS]}).effortMinutes).toEqual({leave:0,feedback:5});
 });
});
describe('scoped immutable company/role Home versions',()=>{
 it('saves/reopens a version and resolves own company/role without accepting a caller-picked company',async()=>{
  const hr=await worker('hr_admin'),employee=await worker(),configuration=defaultEmployeeHomeConfiguration();
  configuration.quickActions=['leave','profile'];configuration.templates.find(row=>row.key==='calm')!.text.en='Fictional scoped wording.';
  const initial=await readOwnEmployeeHomeConfiguration(employee.ctx,employee.employmentId);expect(initial.ordinal).toBe(0);expect(initial.revisionId).toBeNull();
  const saved=await save(hr.ctx,configuration);
  expect(saved.ordinal).toBe(1);
  expect(await readEmployeeHomeConfigurationEditor(hr.ctx,{companyId:b.companyId,audienceRole:'employee'})).toMatchObject({revisionId:saved.id,ordinal:1,configuration});
  expect(await readOwnEmployeeHomeConfiguration(employee.ctx,employee.employmentId)).toMatchObject({employmentId:employee.employmentId,companyId:b.companyId,audienceRole:'employee',ordinal:1,configuration});
  const history=await employeeHomeConfigurationHistory(hr.ctx,{companyId:b.companyId,audienceRole:'employee'});expect(history.items).toHaveLength(1);expect(history.nextBeforeOrdinal).toBeNull();
  expect(history.items[0]).toMatchObject({id:saved.id,createdByUserId:hr.ctx.userId,reason:'Fictional scoped Home configuration review'});
  await expect(employeeHomeConfigurationHistory(employee.ctx,{companyId:b.companyId,audienceRole:'employee'})).rejects.toThrow(/scope/);
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,b.companyId)).orderBy(s.domainEvent.sequence);
  const event=events.find(row=>row.eventType==='employee-home.configuration.updated')!;
  expect(event.actorId).toBe(hr.ctx.userId);expect(JSON.stringify(event.payload)).not.toContain('Fictional scoped wording.');
 });
 it('denies foreign companies, forged grants/roles, current revocation, and archived own logins',async()=>{
  const hr=await worker('hr_admin'),employee=await worker();
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated company'}).returning();
  await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:other.id,audienceRole:'employee',expectedOrdinal:0,configuration:defaultEmployeeHomeConfiguration(),reason:'Fictional foreign fixture'});
  expect((await employeeHomeConfigurationCompanies(hr.ctx)).map(row=>row.id)).toEqual([b.companyId]);
  for(const ctx of [hr.ctx,{...hr.ctx,grants:[{role:'hr_admin' as const,companyId:other.id}]},{...employee.ctx,roles:['super_admin'],grants:[{role:'super_admin' as const,companyId:null}]}]){
   await expect(readEmployeeHomeConfigurationEditor(ctx,{companyId:other.id,audienceRole:'employee'})).rejects.toThrow(/scope/);
   await expect(saveEmployeeHomeConfiguration(ctx,{companyId:other.id,audienceRole:'employee',expectedOrdinal:1,configuration:defaultEmployeeHomeConfiguration(),reason:'Forbidden change'})).rejects.toThrow(/scope/);
  }
  await save(hr.ctx);
  await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,hr.ctx.userId!));
  await expect(readEmployeeHomeConfigurationEditor(hr.ctx,{companyId:b.companyId,audienceRole:'employee'})).rejects.toThrow(/scope/);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,employee.ctx.userId!));
  await expect(readOwnEmployeeHomeConfiguration(employee.ctx,employee.employmentId)).rejects.toThrow();
 });
 it('serializes concurrent updates, preserves prior versions and denies mutation through the app role',async()=>{
  const hr=await worker('hr_admin'),configuration=defaultEmployeeHomeConfiguration(),first=await save(hr.ctx,configuration);
  const changed=defaultEmployeeHomeConfiguration();changed.teamVisibility='direct';
  const attempts=await Promise.allSettled([save(hr.ctx,changed,1),save(hr.ctx,{...changed,teamVisibility:'department'},1)]);
  expect(attempts.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(row=>row.status==='rejected')).toHaveLength(1);
  const history=await employeeHomeConfigurationHistory(hr.ctx,{companyId:b.companyId,audienceRole:'employee'});
  expect(history.items.map(row=>row.ordinal)).toEqual([2,1]);
  expect(history.items[0]).not.toHaveProperty('configuration');
  expect((await readEmployeeHomeConfigurationVersion(hr.ctx,{companyId:b.companyId,audienceRole:'employee',ordinal:1}))?.configuration).toEqual(configuration);
  await expect(withTenant(hr.ctx,tx=>tx.update(s.employeeHomeConfigurationRevision).set({reason:'Mutated'}).where(eq(s.employeeHomeConfigurationRevision.id,first.id)))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(owner.db.update(s.employeeHomeConfigurationRevision).set({reason:'Mutated by owner'}).where(eq(s.employeeHomeConfigurationRevision.id,first.id))).rejects.toMatchObject({cause:{code:'23514',message:expect.stringContaining('immutable')}});
  expect((await owner.db.select().from(s.employeeHomeConfigurationRevision).where(eq(s.employeeHomeConfigurationRevision.id,first.id)))[0].reason).toBe('Fictional scoped Home configuration review');
  const [proof]=await withTenant(hr.ctx,tx=>tx.execute(sql`SELECT app.principal_snapshot_current() AS shared,app.attendance_policy_principal_current() AS attendance`)) as unknown as {shared:boolean;attendance:boolean}[];
  expect(proof).toEqual({shared:true,attendance:true});
 });
});
