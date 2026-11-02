/** Actual restricted runtime and native writers. New action authority is never inferred from UI cells. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {hireEmployee,setEmploymentGrade} from '../core/org';
import {saveEmployeeDraft,completeEmployeeDraft,getEmployeeDraft,discardEmployeeDraft} from '../core/employee-draft';
import {publishWorkforceActionPackage as publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS_V2 as WORKFORCE_CAPABILITY_BINDINGS} from '../deploy/access/publish-workforce-capabilities';
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
  const [outside]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional outside action company'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:outside.id,name:'Fictional outside department'}).returning();
  const other=await hireEmployee(context,{person:{fullName:'Fictional outside person',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:outside.id,departmentId:department.id,employmentType:'full_time',hiredOn:'2026-01-01'});
  await expect(maintainWorkforceRecord(bounded,{employmentId:other.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Denied outside company',isHighest:false},expectedVersion:null})).rejects.toThrow();
  await expect(hireEmployee(bounded,{person:{fullName:'No fake HR',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).rejects.toThrow();
 });
 it('a full Employee-A carrier keeps an explicit bounded function grant in company B',async()=>{
  const context=await ctx(),target=await hire();
  const [a]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional legacy role company A'}).returning();
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:a.id});
  const groupId=randomUUID();for(const command of [{kind:'createGroup' as const,groupId,name:'Fictional explicit B role'},{kind:'replaceGroupGrants' as const,groupId,grants:[{capabilityId:'workforce.view',companyId:b.companyId},{capabilityId:'workforce.add',companyId:b.companyId}]},{kind:'setMembership' as const,groupId,userId:user.id,companyId:b.companyId,enabled:true}]){
   const state=await withTenant(context,tx=>accessConfigurationStore.loadCurrent(tx,context));const edit={expectedRevision:state.snapshot.revision,command};const preview=await previewAccessConfiguration(context,edit,accessConfigurationStore);await saveAccessConfiguration(context,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  }
  const bounded={...context,userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:a.id}]};
  expect((await maintainWorkforceRecord(bounded,{employmentId:target.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Explicit company B qualification',isHighest:false},expectedVersion:null})).changed).toBe(true);
  await expect(hireEmployee(bounded,{person:{fullName:'No borrowed HR',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).rejects.toThrow();
 });
 it('narrowed HR-A claims cannot borrow stored global HR function sources through a global Employee claim',async()=>{
  const context=await ctx(),aTarget=await hire();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:b.adminUserId,role:'employee',companyId:null});
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional narrowed carrier company B'}).returning();const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:other.id,name:'Fictional B department'}).returning();
  const bTarget=await hireEmployee(context,{person:{fullName:'Fictional B staff',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:other.id,departmentId:department.id,employmentType:'full_time',hiredOn:'2026-01-01'});
  const narrowed={...context,roles:['hr_admin','employee'],grants:[{role:'hr_admin',companyId:b.companyId},{role:'employee',companyId:null}]};
  expect((await maintainWorkforceRecord(narrowed,{employmentId:aTarget.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Permitted A qualification',isHighest:false},expectedVersion:null})).changed).toBe(true);
  expect(await workforceEditor(narrowed,bTarget.employmentId)).toBeNull();
  await expect(maintainWorkforceRecord(narrowed,{employmentId:bTarget.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Denied B qualification',isHighest:false},expectedVersion:null})).rejects.toThrow();
  await expect(withTenant(narrowed,tx=>tx.execute(sql`select app.access_configuration_delegation_preview(${JSON.stringify([{capabilityId:'workforce.add',companyId:other.id}])}::jsonb)`))).rejects.toThrow();
 });
 it('Add cannot update another author saved draft or forge its author while Edit is denied',async()=>{
  const [author]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional other draft author',primaryEmail:randomUUID()+'@fixture.invalid'}).returning();
  const data={profile:{fullName:'Fictional retained draft'},employment:{companyId:b.companyId}};
  const [draft]=await owner.db.insert(s.employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:author.id,label:'Fictional retained draft',data,currentStep:1}).returning();
  await deny('edit');
  await expect(saveEmployeeDraft(await ctx(),{id:draft.id,data:{...data,profile:{fullName:'Denied edit'}},currentStep:2})).rejects.toThrow();
  await expect(withTenant(await ctx(),tx=>tx.update(s.employeeDraft).set({data:{...data,profile:{fullName:'Denied SQL edit'}}}).where(eq(s.employeeDraft.id,draft.id)))).rejects.toThrow();
  await expect(withTenant(await ctx(),tx=>tx.update(s.employeeDraft).set({createdByPersonId:null}).where(eq(s.employeeDraft.id,draft.id)))).rejects.toThrow();
  expect((await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.id,draft.id)))[0].data).toEqual(data);
 });
 it('Add initializes only its actual same-transaction draft before the first save completes',async()=>{
  const context=await ctx();await deny('edit');
  const created=await withTenant(await ctx(),async tx=>{
   const first=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional initial draft'},employment:{companyId:b.companyId}},currentStep:1},tx);
   await saveEmployeeDraft(context,{id:first.id,data:{profile:{fullName:'Fictional completed initial draft'},employment:{companyId:b.companyId}},currentStep:2},tx);return first;
  });
  await expect(saveEmployeeDraft(await ctx(),{id:created.id,data:{profile:{fullName:'Denied later draft edit'},employment:{companyId:b.companyId}},currentStep:3})).rejects.toThrow();
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
  const added=await maintainWorkforceRecord(await ctx(),{employmentId:employee.employmentId,kind:'qualification',rowId:null,operation:'add',patch:{qualification:'Fictional retained qualification',isHighest:false},expectedVersion:null});
  const editor=await workforceEditor(await ctx(),employee.employmentId),qualification=editor!.registers.find(row=>row.id===added.id)!;
  await expect(maintainWorkforceRecord(await ctx(),{employmentId:employee.employmentId,kind:'qualification',rowId:added.id,operation:'archive',patch:{},expectedVersion:qualification.version})).rejects.toThrow();
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
 it('complex draft source reaches canonical profile, bank, period, compensation and family before Add consumes it',async()=>{
  const context=await ctx();
  const draft=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional full source',primaryEmail:randomUUID()+'@fixture.invalid',employeeIdMode:'manual',employeeCode:'ACT-COMPLEX',phone:'0123456789',firstName:'Fictional',lastName:'Source',permanentAddressLine1:'Fictional source address',sameAsPermanent:'yes'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',probationValue:'3',probationUnit:'month'},statutory:{bankName:'Fictional Bank',bankAccountNo:'12345678',enableCustomHolderName:'yes',customHolderName:'Fictional Source',epfMode:'manual_percentage',epfEmployeeRate:'11',epfEmployerRate:'13'},payroll:{basicSalary:'3,000',monthlyAllowance:'250',remarks:'Fictional source compensation'},family:[{fullName:'Fictional source child',relationship:'child',isBeneficiary:true,dateOfBirth:'2020-01-01'}]},currentStep:6});
  await deny('edit','delete');const completed=await completeEmployeeDraft(await ctx(),draft.id);expect(await getEmployeeDraft(await ctx(),draft.id)).toBeNull();
  const [employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,completed.employmentId));expect(employment.probationValue).toBe(3);
  const [person]=await owner.db.select().from(s.person).where(eq(s.person.id,employment.personId));expect(person.correspondenceAddressLine1).toBe('Fictional source address');
  const [statutory]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employment.personId));expect(statutory.bankAccountNo).toBe('12345678');expect(statutory.epfEmployeeRate).toBe('0.1100');
  expect(await owner.db.select().from(s.employeeDependent).where(eq(s.employeeDependent.personId,employment.personId))).toHaveLength(1);
 });
 it('a prepared source cannot commit a partial hire while its family and draft remain unconsumed',async()=>{
  const context=await ctx(),email=randomUUID()+'@fixture.invalid';
  const draft=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional incomplete source',primaryEmail:email,employeeIdMode:'manual',employeeCode:'ACT-PARTIAL'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'},family:[{fullName:'Fictional retained child',relationship:'child'}]},currentStep:6});
  await deny('edit','delete');await expect(hireEmployee(await ctx(),{fromEmployeeDraftId:draft.id,person:{fullName:'Fictional incomplete source',primaryEmail:email},employeeCode:'ACT-PARTIAL',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).rejects.toThrow();
  expect(await getEmployeeDraft(await ctx(),draft.id)).not.toBeNull();expect(await owner.db.select().from(s.person).where(eq(s.person.primaryEmail,email))).toHaveLength(0);
 });
 it('Add does not authorize discarding an unrelated saved draft',async()=>{
  const context=await ctx();const draft=await saveEmployeeDraft(context,{data:{profile:{fullName:'Fictional retained source',primaryEmail:randomUUID()+'@fixture.invalid'},employment:{companyId:b.companyId}},currentStep:0});
  await deny('delete');await expect(discardEmployeeDraft(await ctx(),draft.id)).rejects.toThrow();expect(await getEmployeeDraft(await ctx(),draft.id)).not.toBeNull();
 });
});


it('checks newly administrative recipients in previews and direct SQL without persisting a failed proposal',async()=>{
 const root=await ctx();
 const [limited,target]=await owner.db.insert(s.appUser).values([{tenantId:b.tenantId,workosUserId:'limited_config_'+randomUUID()},{tenantId:b.tenantId,workosUserId:'future_admin_'+randomUUID()}]).returning();
 await owner.db.insert(s.roleAssignment).values([{tenantId:b.tenantId,appUserId:limited.id,role:'hr_admin',companyId:b.companyId},{tenantId:b.tenantId,appUserId:target.id,role:'employee',companyId:null}]);
 // A globally derived System Administrator is intentionally protected from predicate narrowing.
 // Use a real company HR configurator and grant only the separate configuration capability.
 const current=await withTenant(root,tx=>accessConfigurationStore.loadCurrent(tx,root));
 const configureEdit={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId:limited.id,capabilityId:'access.configure',companyId:null,effect:'allow' as const}};
 const configurePreview=await previewAccessConfiguration(root,configureEdit,accessConfigurationStore);
 await saveAccessConfiguration(root,{...configureEdit,previewFingerprint:configurePreview.fingerprint},accessConfigurationStore);
 const profileId=randomUUID();
 const dataChange=async(command:DataPermissionCommand)=>{const state=await readDataPermissions(root),preview=await previewDataPermission(root,state.revision,command);await saveDataPermission(root,state.revision,command,preview.fingerprint);};
 await dataChange({kind:'create',profileId,name:'Fictional configurator department',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptA]}]}});
 await dataChange({kind:'assign',userId:limited.id,profileId});
 const groupId=randomUUID();
 for(const command of [{kind:'createGroup' as const,groupId,name:'Fictional employee function role'},{kind:'replaceGroupGrants' as const,groupId,grants:[{capabilityId:'workforce.view',companyId:b.companyId},{capabilityId:'workforce.add',companyId:b.companyId}]}]){
  const state=await withTenant(root,tx=>accessConfigurationStore.loadCurrent(tx,root)),edit={expectedRevision:state.snapshot.revision,command};const preview=await previewAccessConfiguration(root,edit,accessConfigurationStore);await saveAccessConfiguration(root,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
 }
 const actor={...root,userId:limited.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const command={kind:'setMembership' as const,groupId,userId:target.id,companyId:b.companyId,enabled:true};
 const state=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
 const before=await owner.client`select * from access_membership where tenant_id=${b.tenantId}::uuid order by id`;
 await expect(previewAccessConfiguration(actor,{expectedRevision:state.snapshot.revision,command},accessConfigurationStore)).rejects.toThrow('ceiling');
 await expect(withTenant(actor,tx=>tx.execute(sql`select app.access_configuration_commit(${state.snapshot.revision}::uuid,${state.scopeFingerprint},${JSON.stringify(command)}::jsonb,${randomUUID()}::uuid)`))).rejects.toThrow();
 expect(await owner.client`select * from access_membership where tenant_id=${b.tenantId}::uuid order by id`).toEqual(before);
 await dataChange({kind:'assign',userId:target.id,profileId});
 const next=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor)),edit={expectedRevision:next.snapshot.revision,command};const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
 expect(await owner.client`select * from access_membership where tenant_id=${b.tenantId}::uuid order by id`).toEqual(before);
 await saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
 expect(await owner.client`select user_id from access_membership where tenant_id=${b.tenantId}::uuid and group_id=${groupId}::uuid and retired_at is null`).toMatchObject([{user_id:target.id}]);
});

it('matches prospective draft current and proposed data scope instead of accepting an unassigned employment sentinel',async()=>{
 const root=await ctx();
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'draft_scope_'+randomUUID()}).returning();
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
 const profileId=randomUUID(),change=async(command:DataPermissionCommand)=>{const state=await readDataPermissions(root),preview=await previewDataPermission(root,state.revision,command);await saveDataPermission(root,state.revision,command,preview.fingerprint);};
 await change({kind:'create',profileId,name:'Fictional draft department',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptA]}]}});
 await change({kind:'assign',userId:user.id,profileId});
 const actor={...root,userId:user.id,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const data={profile:{fullName:'Fictional scoped draft'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time'}};
 const draft=await saveEmployeeDraft(actor,{data,currentStep:1});expect(await getEmployeeDraft(actor,draft.id)).not.toBeNull();
 await expect(saveEmployeeDraft(actor,{id:draft.id,data:{...data,employment:{...data.employment,departmentId:b.deptB}},currentStep:2})).rejects.toThrow();
 await expect(saveEmployeeDraft(actor,{data:{...data,employment:{companyId:b.companyId,employmentType:'full_time'}},currentStep:1})).rejects.toThrow();
 const [retained]=await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.id,draft.id));expect(retained.data).toMatchObject({employment:{departmentId:b.deptA}});
 // Old/current row scope is checked too: a later native source placement outside D cannot be edited
 // back into D as a way to launder an otherwise inaccessible employee admission source.
 await owner.db.update(s.employeeDraft).set({data:{...data,employment:{...data.employment,departmentId:b.deptB}}}).where(eq(s.employeeDraft.id,draft.id));
 expect(await getEmployeeDraft(actor,draft.id)).toBeNull();
 await expect(saveEmployeeDraft(actor,{id:draft.id,data,currentStep:2})).rejects.toThrow();
});
