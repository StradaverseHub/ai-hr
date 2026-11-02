/** Unstructured legacy summaries have no exhaustive company or employee identity receipt. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {listEmployeeImportRuns} from '../core/import';
import {hireEmployee} from '../core/org';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,limited:SessionContext,runId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=await entitledCtx(b);
 await withTenant(admin,tx=>accessConfigurationStore.loadCurrent(tx,admin));
 await hireEmployee(admin,{person:{fullName:'Visible archive fixture',primaryEmail:'visible-archive@fixture.invalid'},employeeCode:'VISIBLE-ONLY',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
 const user=await createAppUser(b.tenantId,null,'employee');
 await owner.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${user}::uuid,'hr_admin',${b.companyId}::uuid)`;
 limited={...admin,userId:user,personId:null,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 const [row]=await owner.db.insert(s.employeeImportRun).values({tenantId:b.tenantId,companyId:b.companyId,totalRows:2,importedRows:1,failedRows:1,errors:[{rowNum:3,fullName:'PRIVATE historical hidden person',email:'private-history@fixture.invalid',errors:['Fictional invalid value']}] }).returning({id:s.employeeImportRun.id});runId=row.id;
});
async function change(command:DataPermissionCommand){const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,command);await saveDataPermission(admin,state.revision,command,preview.fingerprint);}
async function assign(rules:{legacyCompany:boolean;predicates:{field:'employeeId';values:string[]}[]}){
 const profileId=randomUUID();await change({kind:'create',profileId,name:'Archive scope '+profileId,enabled:true,rules});await change({kind:'assign',userId:limited.userId!,profileId});return profileId;
}
it('preserves native no-assignment history but refuses hidden raw errors and counts after a narrow profile is saved',async()=>{
 expect((await listEmployeeImportRuns(limited)).map(row=>row.id)).toContain(runId);
 const profileId=await assign({legacyCompany:false,predicates:[{field:'employeeId',values:['VISIBLE-ONLY']}]});
 expect(await listEmployeeImportRuns(limited)).toEqual([]);
 expect(await withTenant(limited,tx=>tx.execute(sql`select id,total_rows,errors from employee_import_run where id=${runId}::uuid`))).toHaveLength(0);
 await change({kind:'edit',profileId,name:'Disabled archive scope',enabled:false,rules:{legacyCompany:false,predicates:[{field:'employeeId',values:['VISIBLE-ONLY']}]}});
 expect(await listEmployeeImportRuns(limited)).toEqual([]);
 await change({kind:'assign',userId:limited.userId!,profileId:null});
 expect((await listEmployeeImportRuns(limited)).map(row=>row.id)).toContain(runId);
});
it('does not treat a scoped HR legacy-company preset as proof of a multi-company archive population',async()=>{
 await assign({legacyCompany:true,predicates:[]});expect(await listEmployeeImportRuns(limited)).toEqual([]);
 expect((await listEmployeeImportRuns(admin)).map(row=>row.id)).toContain(runId);
});
