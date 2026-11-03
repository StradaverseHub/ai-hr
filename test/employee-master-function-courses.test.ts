/** Actual report-category owner, pure target floors and a real sharing-revocation race.
 * Publication uses the restricted installer and actual report rows. */
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import {hireEmployee} from '../core/org';
import {decidePayrollPermission} from '../lib/payroll-permissions';
import {pgSqlState} from '../lib/db-error';
import {setPayrollPermissionGrant,deletePayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {masterReportCatalogue,masterReportActionAccess} from '../core/employee-master-access';
import {saveEmployeeMasterReport,runEmployeeMasterReport,getEmployeeMasterReport,authorizeEmployeeMasterRun} from '../core/employee-master-reports';
import * as projection from '../core/employee-master-projection';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {defaultMasterColumn,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{await resetDb();b=await seedBase();ctx={...adminCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};});
it('matches the unchanged whole-set native category algebra with real customer overrides',async()=>{
 type Override={role:string;allowed:boolean;companyScoped:boolean};
 const cases:Override[][]=[[],[{role:'hr_admin',allowed:false,companyScoped:false}],
  [{role:'hr_admin',allowed:false,companyScoped:false},{role:'hr_admin',allowed:true,companyScoped:true}],
  [{role:'hr_admin',allowed:true,companyScoped:false},{role:'employee',allowed:false,companyScoped:true}],
  [{role:'hr_admin',allowed:false,companyScoped:true},{role:'employee',allowed:true,companyScoped:true}],
  [{role:'hr_admin',allowed:true,companyScoped:true},{role:'employee',allowed:false,companyScoped:false},{role:'hr_admin',allowed:false,companyScoped:false}]];
 for(const overrides of cases){
  const ids:string[]=[];
  for(const item of overrides)ids.push((await setPayrollPermissionGrant(ctx,{companyId:item.companyScoped?b.companyId:null,permissionKey:'report.read.personnel',role:item.role,allowed:item.allowed})).id);
  for(const roles of [['hr_admin'],['super_admin'],['employee'],['employee','hr_admin']]){
   const [actual]=await owner.client`select app.employee_master_personnel_permission(${b.tenantId}::uuid,${b.companyId}::uuid,${roles}::text[]) as allowed`;
   expect({overrides,roles,allowed:actual.allowed}).toEqual({overrides,roles,allowed:decidePayrollPermission({key:'report.read.personnel',callerRoles:roles,overrides})});
  }
  for(const id of ids)await deletePayrollPermissionGrant(ctx,{id});
 }
 expect((await masterReportCatalogue(ctx,[b.companyId])).length).toBeGreaterThan(0);
 let denial:unknown;try{await withTenant(ctx,tx=>tx.execute(sql`select app.employee_master_personnel_permission(${b.tenantId}::uuid,${b.companyId}::uuid,array['hr_admin'])`));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');
});
it('keeps pure target scope independent of NULL or foreign caller context and fails a stale carrier',async()=>{
 const foreign=await seedBase();
 for(const ambient of [null,foreign.tenantId])await owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${ambient??''},true),set_config('app.user_id','',true),set_config('app.roles','',true),set_config('app.grants','[]',true)`;
  const [row]=await tx`select app.employee_master_function_legacy_allowed(${b.tenantId}::uuid,${ctx.userId!}::uuid,'function.employeeMasterReports.view',${b.companyId}::uuid) as own_company,
   app.employee_master_function_legacy_allowed(${b.tenantId}::uuid,${ctx.userId!}::uuid,'function.employeeMasterReports.view',null) as all_future,
   app.employee_master_function_legacy_allowed(${foreign.tenantId}::uuid,${ctx.userId!}::uuid,'function.employeeMasterReports.view',${foreign.companyId}::uuid) as wrong_tenant`;
  expect(row).toEqual({own_company:true,all_future:true,wrong_tenant:false});
 });
 await expect(masterReportCatalogue({...ctx,roles:[],grants:[]},[b.companyId])).rejects.toThrow('unavailable');
});
it('discards a real report result when native sharing is revoked after its source was read',async()=>{
 await hireEmployee(ctx,{person:{fullName:'Fictional report snapshot person',primaryEmail:'report-snapshot@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'REPORT-SNAPSHOT',employmentType:'full_time',hiredOn:'2025-01-01'});
 const peerId=await createAppUser(b.tenantId,null,'hr_admin'),peer={...ctx,userId:peerId};
 const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 const spec:EmployeeMasterSpec={v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const saved=await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional scoped report',description:'Fixture',spec,sharedRoleIds:['hr_admin']});
 expect((await getEmployeeMasterReport(peer,[b.companyId],saved.id)).shared).toBe(true);
 // Synchronization only: call the unchanged real source, retain all real rows, then
 // perform the actual creator's native revocation before result publication.
 const original=projection.employeeMasterSubjectsTx;let revoked=false;
 vi.spyOn(projection,'employeeMasterSubjectsTx').mockImplementation(async(...args)=>{
  const subjects=await original(...args);expect(subjects.length).toBeGreaterThan(0);
  await saveEmployeeMasterReport(ctx,[b.companyId],{id:saved.id,version:saved.version,name:'Fictional scoped report',description:'Fixture',spec,sharedRoleIds:[]});revoked=true;
  return subjects;
 });
 await expect(runEmployeeMasterReport(peer,[b.companyId],{id:saved.id})).rejects.toThrow('Data access changed. Reload and try again.');
 expect(revoked).toBe(true);expect(projection.employeeMasterSubjectsTx).toHaveBeenCalledOnce();
 await expect(getEmployeeMasterReport(peer,[b.companyId],saved.id)).rejects.toThrow('unavailable');
 const [stored]=await owner.db.select({shared:s.customReport.shared,roles:s.customReport.sharedRoleIds}).from(s.customReport).where(eq(s.customReport.id,saved.id));
 expect(stored).toEqual({shared:false,roles:[]});
});

it('keeps all native definition actions scoped to every actual before and proposed company',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional separate report company'}).returning({id:s.company.id});
 const userId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:b.companyId});
 const scoped:SessionContext={...ctx,userId,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 expect(await masterReportActionAccess(scoped,[b.companyId])).toEqual({canAdd:true,canEdit:true,canDelete:true});
 expect(await masterReportActionAccess(scoped,[b.companyId,other.id])).toEqual({canAdd:false,canEdit:false,canDelete:false});
 const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 const spec:EmployeeMasterSpec={v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const saved=await saveEmployeeMasterReport(scoped,[b.companyId],{name:'Actual scoped definition',description:'Fixture',spec,sharedRoleIds:[]});
 expect(await getEmployeeMasterReport(scoped,[b.companyId],saved.id)).toMatchObject({canEdit:true,canDelete:true,canDuplicate:true});
 const before=await owner.db.select().from(s.customReport).where(eq(s.customReport.id,saved.id));
 let denial:unknown;try{await withTenant(scoped,tx=>tx.execute(sql`update custom_report set spec=jsonb_set(spec,'{employeeMaster,companyIds}',${JSON.stringify([other.id])}::jsonb) where id=${saved.id}::uuid`));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');expect(await owner.db.select().from(s.customReport).where(eq(s.customReport.id,saved.id))).toEqual(before);
});
it('refuses raw Master definition creation by a real non-HR owner without a native report-category grant',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee'),employee:SessionContext={...ctx,userId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 expect(await masterReportActionAccess(employee,[b.companyId])).toEqual({canAdd:false,canEdit:false,canDelete:false});
 let denial:unknown;try{await withTenant(employee,tx=>tx.insert(s.customReport).values({tenantId:b.tenantId,createdByUserId:userId,name:'Fictional refused raw definition',category:'master',datasetId:'master',spec:{datasetId:'master',columns:['name']}}));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');expect(await owner.db.select().from(s.customReport).where(eq(s.customReport.createdByUserId,userId))).toEqual([]);
});

it('publishes View and refuses definitions, fresh runs and generated exports after a scoped denial',async()=>{
 await hireEmployee(ctx,{person:{fullName:'Fictional report subject',primaryEmail:'report-view@fixture.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employeeCode:'REPORT-VIEW',employmentType:'full_time',hiredOn:'2025-01-01'});
 const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 const spec:EmployeeMasterSpec={v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],
  expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const report=await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional view binding report',description:'Fixture',spec,sharedRoleIds:[]});
 const cap='function.employeeMasterReports.view';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'employee_master_view')).toMatchObject({changed:true,capabilities:1});
  expect(await publishActionCapabilityPackage(owner.client,'employee_master_view')).toMatchObject({changed:false});
  const run=await runEmployeeMasterReport(ctx,[b.companyId],{id:report.id});
  expect(run.result.totalRows).toBe(1);
  await expect(authorizeEmployeeMasterRun(ctx,[b.companyId],run)).resolves.toBeUndefined();
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect(await withTenant(ctx,tx=>tx.select({id:s.customReport.id}).from(s.customReport).where(eq(s.customReport.id,report.id)))).toEqual([]);
  await expect(runEmployeeMasterReport(ctx,[b.companyId],{id:report.id})).rejects.toThrow('unavailable');
  await expect(authorizeEmployeeMasterRun(ctx,[b.companyId],run)).rejects.toThrow('unavailable');
  const [[category],stamp]=await Promise.all([
   withTenant(ctx,tx=>tx.execute(sql`select app.pay_formula_category(${b.companyId}::uuid,'personnel') as allowed`)),
   withTenant(ctx,tx=>tx.execute(sql`select app.employee_master_access_stamp(null,array[${b.companyId}::uuid])`)).then(()=>null,error=>error),
  ]);
  expect(category.allowed).toBe(true);
  expect(pgSqlState(stamp)).toBe('42501');
 }finally{
  await owner.client`delete from app.access_native_capability_default where capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=${cap}`;
 }
});
