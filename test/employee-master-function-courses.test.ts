/** Actual report-category owner, pure target floors and a real sharing-revocation race.
 * No supported cells, private execution grants or fabricated result rows. */
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {decidePayrollPermission} from '../lib/payroll-permissions';
import {pgSqlState} from '../lib/db-error';
import {setPayrollPermissionGrant,deletePayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {masterReportCatalogue} from '../core/employee-master-access';
import {saveEmployeeMasterReport,runEmployeeMasterReport,getEmployeeMasterReport} from '../core/employee-master-reports';
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
