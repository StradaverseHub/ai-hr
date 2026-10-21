/** Prepared Workforce consumer/RLS regressions; requires verified Board1 principal owner and all leases. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {person,employment,employeeDraft,roleAssignment,appUser,jobGrade,domainEvent} from '../db/schema';
import {hireEmployee,setEmployeeCode,updatePerson,setEmploymentGrade} from '../core/org';
import {hireEmployee as hireWorkforceEmployee,setEmploymentInfo as maintainInfo} from '../core/workforce-commands';
import {createMovementEvent} from '../core/movement';
import {setEmploymentTestRecord} from '../core/employment-test-record';
import {setPersonPhoto} from '../core/person-photo';
import {listEmployees,listEmployeesPage,countEmployeesByStatus,employeeDetail} from '../core/read';
import {workforceCompanies,WorkforceAccessError} from '../core/workforce-access';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);});
afterAll(async()=>{try{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);}finally{await closeAll();}});
async function activate(){await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);}
async function override(userId:string,capabilityId:'workforce.view'|'workforce.maintain',companyId:string|null,effect:'allow'|'deny'|null){
 const before=await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId,capabilityId,companyId,effect}};
 const preview=await previewAccessConfiguration(admin(),edit,accessConfigurationStore);return saveAccessConfiguration(admin(),{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
const hire=(label:string)=>hireEmployee(admin(),{person:{fullName:label,primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
const page=(ctx:SessionContext,companyIds=[b.companyId])=>listEmployeesPage(ctx,{companyIds,limit:25,offset:0},'workforce');
describe('fresh Workforce-purpose record consumers',()=>{
 it('keeps dormant/default HR list, count and detail identical to the existing projection',async()=>{
  const subject=await hire('Fictional default record');
  expect(await page(admin())).toEqual(await listEmployeesPage(admin(),{companyIds:[b.companyId],limit:25,offset:0}));
  expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toEqual(await employeeDetail(admin(),subject.employmentId));
  expect(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]},'workforce')).toEqual(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]}));
 });
 it('applies a new read denial to the row, count, switcher and detail in the same signed-in context',async()=>{
  const subject=await hire('Fictional denied record');await activate();expect((await page(admin())).total).toBe(1);
  await override(b.adminUserId,'workforce.view',b.companyId,'deny');
  expect(await page(admin())).toEqual({rows:[],total:0});
  expect(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]},'workforce')).toEqual({total:0,byStatus:{}});
  expect(await listEmployees(admin(),[b.companyId],'workforce')).toEqual([]);expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toBeNull();
  expect(await workforceCompanies(admin())).not.toContain(b.companyId);
  // Staff-directory relationship access remains independent; no financial grant or role is added.
  expect((await listEmployees(admin(),[b.companyId])).map(row=>row.employmentId)).toContain(subject.employmentId);
  await override(b.adminUserId,'workforce.view',b.companyId,null);expect((await page(admin())).total).toBe(1);
 });
 it('does not widen an explicitly empty selected Workforce company scope',async()=>{
  await hire('Fictional retained record');await activate();
  expect(await page(admin(),[])).toEqual({rows:[],total:0});expect(await listEmployees(admin(),[],'workforce')).toEqual([]);
  expect(await countEmployeesByStatus(admin(),{companyIds:[]},'workforce')).toEqual({total:0,byStatus:{}});
 });
 it('refuses profile and code changes without modifying the master or emitting their events',async()=>{
  const subject=await hire('Fictional immutable denied record');await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(person).where(eq(person.id,subject.personId));
  const codes=await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,subject.employmentId));
  const events=await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id);
  await expect(updatePerson(admin(),{personId:subject.personId,fullName:'Not applied',primaryEmail:'not-applied@example.invalid',via:'employee-profile'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'NOT-APPLIED'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(setEmploymentTestRecord(admin(),{employmentId:subject.employmentId,isTestRecord:true})).rejects.toBeInstanceOf(WorkforceAccessError);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1]);
  await expect(setPersonPhoto(admin(),{personId:subject.personId,content:bytes,fileName:'not-applied.png',mimeType:'image/png',sizeBytes:bytes.length})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await owner.db.select().from(person).where(eq(person.id,subject.personId))).toEqual(before);
  expect(await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,subject.employmentId))).toEqual(codes);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)).toEqual(events);
 });
 it('blocks Workforce hire, employment-info and direct Movement entry without disabling a separate grade owner',async()=>{
  const subject=await hire('Fictional guarded master');await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(employment).where(eq(employment.tenantId,b.tenantId)).orderBy(employment.id);
  await expect(hireWorkforceEmployee(admin(),{person:{fullName:'Never hired',primaryEmail:'not-hired@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(maintainInfo(admin(),{employmentId:subject.employmentId,orgDivision:'Not applied'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(createMovementEvent(admin(),{employmentId:subject.employmentId,kind:'increment',effectiveDate:todayInKualaLumpur(),basicSalary:3025.13,remarks:'Fictional guarded movement'})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await owner.db.select().from(employment).where(eq(employment.tenantId,b.tenantId)).orderBy(employment.id)).toEqual(before);
  // A verified Rewards posting consumes the unchanged canonical grade owner, not a fabricated
  // Workforce permission. Its own role/stage/revision checks remain required at that consumer.
  const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'WF-INDEPENDENT',name:'Fictional independently approved grade'}).returning({id:jobGrade.id});
  await expect(setEmploymentGrade(admin(),{employmentId:subject.employmentId,gradeId:grade.id})).resolves.toMatchObject({changed:true});
  expect((await owner.db.select({gradeId:employment.gradeId}).from(employment).where(eq(employment.id,subject.employmentId)))[0]?.gradeId).toBe(grade.id);
 });
 it('rejects stale real role assignments and forged role/scope claims without treating a capability grant as HR',async()=>{
  const subject=await hire('Fictional scope subject');await activate();
  const userId=await createAppUser(b.tenantId,subject.personId,'employee');
  const forged={...admin(),userId,personId:subject.personId};
  await override(userId,'workforce.view',b.companyId,'allow');
  expect((await page(forged)).total).toBe(0);expect(await employeeDetail(forged,subject.employmentId,'workforce')).toBeNull();
  const [scopedUser]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`scoped_${randomUUID()}`}).returning({id:appUser.id});
  const [grant]=await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:scopedUser.id,role:'hr_admin',companyId:b.companyId}).returning({id:roleAssignment.id});
  const scoped={...admin(),userId:scopedUser.id,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]} satisfies SessionContext;
  expect((await page(scoped)).total).toBe(1);
  await owner.db.delete(roleAssignment).where(eq(roleAssignment.id,grant.id));expect((await page(scoped)).total).toBe(0);
 });
 it('does not expose a real foreign tenant through subject or company helper calls',async()=>{
  const foreign=await seedBase();await activate();
  const subject=await hireEmployee({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{person:{fullName:'Foreign real record',primaryEmail:`${randomUUID()}@example.invalid`},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toBeNull();
  const [row]=await withTenant(admin(),tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${subject.employmentId}::uuid,'workforce.view') as allowed`));expect(row.allowed).toBe(false);
  expect(await workforceCompanies(admin())).not.toContain(foreign.companyId);
 });
 it('retains an author’s independent draft read/discard source but lets an explicit denial override it',async()=>{
  const author=await hire('Fictional draft author'),userId=await createAppUser(b.tenantId,author.personId,'employee');
  const ctx={...adminCtx(b),userId,personId:author.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const [draft]=await owner.db.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:author.personId,label:'Own retained draft',data:{}}).returning({id:employeeDraft.id});
  const read=()=>withTenant(ctx,tx=>tx.select({id:employeeDraft.id}).from(employeeDraft).where(eq(employeeDraft.id,draft.id)));
  expect(await read()).toEqual([{id:draft.id}]);await activate();expect(await read()).toEqual([{id:draft.id}]);
  await override(userId,'workforce.view',b.companyId,'deny');expect(await read()).toEqual([]);
  await override(userId,'workforce.view',b.companyId,null);await override(userId,'workforce.maintain',b.companyId,'deny');
  expect(await withTenant(ctx,tx=>tx.delete(employeeDraft).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([]);
  await override(userId,'workforce.maintain',b.companyId,null);
  expect(await withTenant(ctx,tx=>tx.delete(employeeDraft).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([{id:draft.id}]);
 });
});
