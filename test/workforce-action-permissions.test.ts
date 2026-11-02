/** Actual restricted runtime and native writers. New action authority is never inferred from UI cells. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setEmploymentGrade} from '../core/org';
import {saveEmployeeDraft,completeEmployeeDraft,getEmployeeDraft,discardEmployeeDraft} from '../core/employee-draft';
import {publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS} from '../deploy/access/publish-workforce-capabilities';
import {maintainWorkforceRecord,workforceEditor} from '../core/workforce-maintenance';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${WORKFORCE_CAPABILITY_BINDINGS.map(row=>row.id)}::text[])`;await publishWorkforceCapabilities(owner.client);});
const ctx=async()=>({...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]});
async function deny(...actions:string[]){for(const action of actions)await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${b.adminUserId}::uuid,${'workforce.'+action},${b.companyId}::uuid,'deny')`);}
const hire=async(name='Fictional action employee')=>hireEmployee(await ctx(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
describe('genuine Workforce operations',()=>{
 it('Add can hire and initialize the assignment while Edit/Delete are denied',async()=>{
  await deny('edit','delete');const employee=await hire();
  const [row]=await owner.db.select({department:s.assignment.departmentId}).from(s.assignment).where(eq(s.assignment.employmentId,employee.employmentId));expect(row.department).toBe(b.deptA);
  const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'ACT',name:'Action grade'}).returning();
  await expect(setEmploymentGrade(await ctx(),{employmentId:employee.employmentId,gradeId:grade.id})).rejects.toThrow();
 });
 it('a custom View+Add role has bounded positive command authority without an administrative Employee role',async()=>{
  const employee=await hire(),context=await ctx();
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:null});
  const groupId=randomUUID();
  for(const command of [{kind:'createGroup' as const,groupId,name:'Fictional Add-only role'},{kind:'replaceGroupGrants' as const,groupId,grants:[{capabilityId:'workforce.view',companyId:b.companyId},{capabilityId:'workforce.add',companyId:b.companyId}]},{kind:'setMembership' as const,groupId,userId:user.id,companyId:b.companyId,enabled:true}]){
   const current=await withTenant(context,tx=>accessConfigurationStore.loadCurrent(tx,context));const edit={expectedRevision:current.snapshot.revision,command};const preview=await previewAccessConfiguration(context,edit,accessConfigurationStore);await saveAccessConfiguration(context,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  }
  const bounded={...context,userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const added=await maintainWorkforceRecord(bounded,{employmentId:employee.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Fictional qualification',isHighest:false},expectedVersion:null});expect(added.changed).toBe(true);
  const editor=await workforceEditor(bounded,employee.employmentId);const row=editor!.registers.find(item=>item.id===added.id)!;expect(editor!.actionCapabilities?.employment).toEqual({add:true,edit:false,delete:false});
  await expect(maintainWorkforceRecord(bounded,{employmentId:employee.employmentId,kind:'qualification',rowId:added.id,operation:'update',patch:{description:'Denied edit'},expectedVersion:row.version})).rejects.toThrow();
  await expect(maintainWorkforceRecord(bounded,{employmentId:employee.employmentId,kind:'qualification',rowId:added.id,operation:'archive',patch:{},expectedVersion:row.version})).rejects.toThrow();
  await expect(hireEmployee(bounded,{person:{fullName:'No fake HR',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).rejects.toThrow();
 });
 it('an Edit holder cannot add via native or direct employment INSERT despite legacy maintain',async()=>{
  const existing=await hire();await deny('add');await expect(hire()).rejects.toThrow();
  await expect(withTenant(await ctx(),tx=>tx.insert(s.employment).values({tenantId:b.tenantId,personId:existing.personId,companyId:b.companyId,hiredOn:'2026-02-01',employeeCode:'ACT-NEW'}))).rejects.toThrow();
 });
 it('an Add holder cannot raw-update an existing employment or profile',async()=>{
  const employee=await hire();await deny('edit');
  await expect(withTenant(await ctx(),tx=>tx.update(s.employment).set({orgBranch:'Denied branch'}).where(eq(s.employment.id,employee.employmentId)))).rejects.toThrow();
  await expect(withTenant(await ctx(),tx=>tx.update(s.person).set({fullName:'Denied name'}).where(eq(s.person.id,employee.personId)))).rejects.toThrow();
 });
 it('Delete denial also prevents soft archiving a register and direct hard removal',async()=>{
  const employee=await hire();await deny('delete');
  const [document]=await owner.db.insert(s.employeeDocument).values({tenantId:b.tenantId,employmentId:employee.employmentId,title:'Fictional retained document',fileName:'fictional.txt',mimeType:'text/plain',content:Buffer.from('fictional'),sizeBytes:9,uploadedByUserId:null}).returning();
  await expect(withTenant(await ctx(),tx=>tx.delete(s.employeeDocument).where(eq(s.employeeDocument.id,document.id)))).rejects.toThrow();
 });
 it('View denial wins over a separate positive Add and a second legacy role',async()=>{
  await deny('view');await expect(hire()).rejects.toThrow();
  expect((await owner.db.select().from(s.employment)).filter(row=>row.tenantId===b.tenantId)).toHaveLength(0);
 });
 it('native simple draft activation consumes only its bound new-employment source under Add',async()=>{
  const context=await ctx(),email=randomUUID()+'@fixture.invalid';
  const draft=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional consumed source',primaryEmail:email,employeeIdMode:'manual',employeeCode:'ACT-DRAFT'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'},payroll:{basicSalary:'3000'}},currentStep:4});
  await deny('edit','delete');const completed=await completeEmployeeDraft(await ctx(),draft.id);expect(completed.employmentId).toBeTruthy();expect(await getEmployeeDraft(await ctx(),draft.id)).toBeNull();
 });
 it('Add does not authorize discarding an unrelated saved draft',async()=>{
  const context=await ctx();const draft=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional retained source',primaryEmail:randomUUID()+'@fixture.invalid'},employment:{companyId:b.companyId}},currentStep:0});
  await deny('delete');await expect(discardEmployeeDraft(await ctx(),draft.id)).rejects.toThrow();expect(await getEmployeeDraft(await ctx(),draft.id)).not.toBeNull();
 });
});
