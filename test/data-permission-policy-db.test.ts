/** Independent behavioral checks of the restricted SQL data-scope owner and real employment RLS. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {listEmployees} from '../core/read';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {canonicalDataPermissionRules,type DataPermissionRules} from '../lib/data-permission-model';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,limited:SessionContext,otherCompany:string;
let grades:string[],people:{id:string;personId:string;companyId:string;grade:string|null;nationality:string}[];
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Independent Company B'}).returning();otherCompany=company.id;
 const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:otherCompany,name:'Independent Department B'}).returning();
 grades=[];for(const code of ['INDEP_A','INDEP_B','INDEP_C','INDEP_D']){const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code,name:code}).returning();grades.push(grade.id);}
 people=[];for(const [index,companyId,gradeIndex,nationality] of [[0,b.companyId,0,'Malaysia'],[1,b.companyId,1,'Malaysia'],[2,b.companyId,2,'Singapore'],[3,b.companyId,3,'Malaysia'],[4,otherCompany,0,'Malaysia'],[5,otherCompany,3,'Singapore'],[6,b.companyId,-1,'Malaysia']] as const){
  const hired=await hireEmployee(admin,{person:{fullName:'Independent employee '+index,primaryEmail:`independent-${index}@fixture.invalid`},employeeCode:'DPTEST'+index,companyId,departmentId:companyId===b.companyId?b.deptA:department.id,employmentType:'full_time',hiredOn:'2026-01-01'});
  const grade=gradeIndex<0?null:grades[gradeIndex];await owner.db.update(s.employment).set({gradeId:grade}).where(eq(s.employment.id,hired.employmentId));await owner.db.update(s.person).set({nationality}).where(eq(s.person.id,hired.personId));
  people.push({id:hired.employmentId,personId:hired.personId,companyId,grade,nationality});
 }
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'independent_'+randomUUID()}).returning();
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
 limited={...admin,userId:user.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
});
async function change(command:DataPermissionCommand,ctx=admin){const state=await readDataPermissions(ctx),preview=await previewDataPermission(ctx,state.revision,command);await saveDataPermission(ctx,state.revision,command,preview.fingerprint);return preview;}
async function profile(rules:DataPermissionRules){const profileId=randomUUID();await change({kind:'create',profileId,name:'Independent '+profileId,enabled:true,rules});return profileId;}
const visible=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.select({id:s.employment.id}).from(s.employment).orderBy(s.employment.id)).map(row=>row.id));
const expectVisible=async(ctx:SessionContext,indexes:number[])=>expect(await visible(ctx)).toEqual(indexes.map(index=>people[index].id).sort());
const rule=(predicates:DataPermissionRules['predicates']):DataPermissionRules=>({legacyCompany:false,predicates});
const assign=(profileId:string|null)=>change({kind:'assign',userId:limited.userId!,profileId});

describe('assigned data rules intersect actual native company scope',()=>{
 it('preserves no-assignment legacy scope and combines Company A AND grades A/B/C',async()=>{
  await expectVisible(limited,[0,1,2,3,6]);
  const id=await profile(rule([{field:'company',values:[b.companyId]},{field:'grade',values:grades.slice(0,3)}]));await assign(id);await expectVisible(limited,[0,1,2]);
  await assign(null);await expectVisible(limited,[0,1,2,3,6]);
 });
 it('ORs values within each field, ANDs fields, and excludes missing values',async()=>{
  const id=await profile(rule([{field:'grade',values:grades.slice(0,3)},{field:'nationality',values:['Malaysia','Indonesia']}]));await assign(id);await expectVisible(limited,[0,1]);
 });
 it('omitting Company never reaches matching employees outside the original company ceiling',async()=>{
  const id=await profile(rule([{field:'grade',values:[grades[0]]}]));await assign(id);await expectVisible(limited,[0]);expect(await visible(limited)).not.toContain(people[4].id);
 });
 it('cannot bypass an assigned administrative scope through a second manager role',async()=>{
  await owner.db.update(s.appUser).set({personId:people[0].personId}).where(eq(s.appUser.id,limited.userId!));
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:limited.userId!,role:'manager',companyId:b.companyId});
  limited={...limited,personId:people[0].personId,roles:['hr_admin','manager'],grants:[{role:'hr_admin',companyId:b.companyId},{role:'manager',companyId:b.companyId}]};
  await assign(await profile(rule([{field:'grade',values:[grades[0]]}])));
  await expect(withTenant(limited,tx=>tx.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:people[0].id,subordinateEmploymentId:people[1].id,lineType:'administrative',validFrom:'2026-01-01'}))).rejects.toThrow();
  await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:people[0].id,subordinateEmploymentId:people[1].id,lineType:'administrative',validFrom:'2026-01-01'});await expectVisible(limited,[0]);
  expect((await listEmployees(limited,undefined,'workforce')).map(row=>row.employmentId)).toEqual([people[0].id]);
  const [proof]=await withTenant(limited,tx=>tx.execute<{allowed:boolean}>(sql`select app.can_see_employment(${people[1].id}::uuid) as allowed`));expect(proof.allowed).toBe(false);
 });
 it('an explicit legacy-company preset remains bounded by the existing company ceiling',async()=>{
  await assign(await profile({legacyCompany:true,predicates:[]}));await expectVisible(limited,[0,1,2,3,6]);
 });
 it('fails closed for an assigned disabled or missing active revision',async()=>{
  const rules=rule([{field:'grade',values:[grades[0]]}]),id=await profile(rules);await assign(id);await expectVisible(limited,[0]);
  await change({kind:'edit',profileId:id,name:'Disabled independent profile',enabled:false,rules});await expectVisible(limited,[]);
  await change({kind:'edit',profileId:id,name:'Restored independent profile',enabled:true,rules});await expectVisible(limited,[0]);
  await owner.db.execute(sql`update data_permission_profile set active_revision_id=null where id=${id}::uuid`);await expectVisible(limited,[]);
 });
 it('refuses empty, duplicate, injected and foreign rules without mutating the existing assignment',async()=>{
  const id=await profile(rule([{field:'grade',values:[grades[0]]}]));await assign(id);
  for(const rules of [{legacyCompany:false,predicates:[]},{legacyCompany:true,predicates:[{field:'grade',values:[grades[0]]}]},{legacyCompany:false,predicates:[{field:'sql; DROP TABLE person',values:['x']}]},{legacyCompany:false,predicates:[{field:'grade',values:[grades[0]]},{field:'grade',values:[grades[1]]}]}]){
   expect(()=>canonicalDataPermissionRules(rules)).toThrow();const state=await readDataPermissions(admin);await expect(withTenant(admin,tx=>tx.execute(sql`select app.data_permission_transition(${JSON.stringify({kind:'edit',profileId:id,name:'Invalid rule',enabled:true,rules})}::jsonb,${state.revision},false,NULL)`))).rejects.toThrow();
  }
  const foreign=await seedBase();await expect(change({kind:'create',profileId:randomUUID(),name:'Foreign company rule',enabled:true,rules:rule([{field:'company',values:[foreign.companyId]}])})).rejects.toThrow();await expectVisible(limited,[0]);
 });
 it('invalidates a preview when the subject values change before commit',async()=>{
  const rules=rule([{field:'grade',values:[grades[0]]}]),id=await profile(rules),state=await readDataPermissions(admin);
  const command:DataPermissionCommand={kind:'edit',profileId:id,name:'Changed independent scope',enabled:true,rules:rule([{field:'grade',values:[grades[1]]}])};
  const preview=await previewDataPermission(admin,state.revision,command);await owner.db.update(s.employment).set({gradeId:grades[1]}).where(eq(s.employment.id,people[0].id));
  await expect(saveDataPermission(admin,state.revision,command,preview.fingerprint)).rejects.toThrow();expect((await readDataPermissions(admin)).profiles.find(row=>row.id===id)?.rules).toEqual(rules);
 });
 it('refuses retirement of assigned profiles and serializes racing assignment/retirement',async()=>{
  const id=await profile(rule([{field:'company',values:[b.companyId]}]));await assign(id);await expect(change({kind:'retire',profileId:id})).rejects.toThrow();await assign(null);
  const state=await readDataPermissions(admin),assignCommand:DataPermissionCommand={kind:'assign',userId:limited.userId!,profileId:id},retireCommand:DataPermissionCommand={kind:'retire',profileId:id};
  const [a,r]=await Promise.all([previewDataPermission(admin,state.revision,assignCommand),previewDataPermission(admin,state.revision,retireCommand)]);
  const outcomes=await Promise.allSettled([saveDataPermission(admin,state.revision,assignCommand,a.fingerprint),saveDataPermission(admin,state.revision,retireCommand,r.fingerprint)]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);const after=await readDataPermissions(admin),assigned=after.assignments.some(row=>row.profileId===id);
  if(assigned)expect(after.profiles.some(row=>row.id===id&&row.enabled)).toBe(true);else expect(after.profiles.some(row=>row.id===id)).toBe(false);
 });
 it('a delegated configurator cannot grant beyond company or assigned predicate ceilings',async()=>{
  const current=await withTenant(admin,tx=>accessConfigurationStore.loadCurrent(tx,admin));
  const edit={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId:limited.userId!,capabilityId:'access.configure',companyId:null,effect:'allow' as const}};
  const accessPreview=await previewAccessConfiguration(admin,edit,accessConfigurationStore);await saveAccessConfiguration(admin,{...edit,previewFingerprint:accessPreview.fingerprint},accessConfigurationStore);
  const create=(rules:DataPermissionRules)=>change({kind:'create',profileId:randomUUID(),name:'Delegated '+randomUUID(),enabled:true,rules},limited);
  await expect(create(rule([{field:'company',values:[otherCompany]}]))).rejects.toThrow();
  await expect(create({legacyCompany:true,predicates:[]})).rejects.toThrow();
  await assign(await profile(rule([{field:'company',values:[b.companyId]},{field:'grade',values:[grades[0]]}])));
  await expect(create(rule([{field:'company',values:[b.companyId]},{field:'grade',values:[grades[1]]}]))).rejects.toThrow();
  await expect(create(rule([{field:'company',values:[b.companyId]}]))).rejects.toThrow();
  await create(rule([{field:'company',values:[b.companyId]},{field:'grade',values:[grades[0]]}]));
  await expectVisible(limited,[0]);
  const [hidden]=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,people[4].id));
  await profile(rule([{field:'company',values:[otherCompany]},{field:'employeeId',values:[hidden.code!]}]));
  expect(JSON.stringify(await readDataPermissions(limited))).not.toContain(hidden.code!);
 });
 it('rejects a cross-tenant principal even when its posted role claims administrator',async()=>{
  const foreign=await seedBase();await expect(readDataPermissions({...admin,tenantId:foreign.tenantId})).rejects.toThrow();
 });
 it('never lets the runtime write profile tables or invoke private evaluators directly',async()=>{
  await expect(withTenant(limited,tx=>tx.execute(sql`delete from user_data_permission_assignment where user_id=${limited.userId!}::uuid`))).rejects.toThrow();
  await expect(withTenant(limited,tx=>tx.execute(sql`select app.data_permission_matches_for(${limited.userId!}::uuid,${b.tenantId}::uuid,${people[0].id}::uuid,current_date)`))).rejects.toThrow();
 });
});
