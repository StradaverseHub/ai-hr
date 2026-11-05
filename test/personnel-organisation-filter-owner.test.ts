import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setEmploymentAssignment} from '../core/org';
import {listEmployeesPage,countEmployeesByStatus,personnelFilterChoices,readPersonnelOverview} from '../core/read';
import {createPersonnelPrivateSearch,personnelPrivateSearchAvailable,privateSearchHash} from '../core/personnel-private-search';
import {lockAccessConfigurationReadTx,lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {PersonnelReadBusyError} from '../core/personnel-read-bounds';
import {workforceCompanies,workforceViewScope} from '../core/workforce-access';
import {personnelGroupingReadinessTx} from '../core/personnel-quality';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});
const hire=(name:string,extra:Partial<Parameters<typeof hireEmployee>[1]>={})=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01',...extra});
const list=(filters:Partial<Parameters<typeof listEmployeesPage>[1]>={})=>listEmployeesPage(ctx,{companyIds:[b.companyId],limit:100,offset:0,...filters},'workforce');
async function identity(personId:string,icNumber:string){await owner.db.insert(s.employeeStatutoryMy).values({tenantId:b.tenantId,personId,icNumber}).onConflictDoUpdate({target:s.employeeStatutoryMy.personId,set:{icNumber}});}
it('searches permitted identity only through private results; page/count/export-size read agree and no identity enters row JSON',async()=>{
 const employee=await hire('Fictional Identity Owner',{employeeCode:'FILTER-1'});await identity(employee.personId,'900101-01-4321');
 const token=await createPersonnelPrivateSearch(ctx,{text:'900101-01-4321',companyIds:[b.companyId]});expect(token).not.toContain('900101');
 const filters={companyIds:[b.companyId],privateSearch:token};
 const page=await listEmployeesPage(ctx,{...filters,limit:1,offset:0},'workforce'),exportRows=await listEmployeesPage(ctx,{...filters,limit:10000,offset:0},'workforce'),count=await countEmployeesByStatus(ctx,filters,'workforce');
 expect(page.rows.map(row=>row.employmentId)).toEqual([employee.employmentId]);expect(exportRows.rows).toEqual(page.rows);expect(page.total).toBe(1);expect(count.total).toBe(1);
 expect(JSON.stringify(page)).not.toContain('900101');expect(JSON.stringify(page)).not.toContain('icNumber');
 await expect(withTenant(ctx,tx=>tx.execute(sql`select matches from personnel_private_search`))).rejects.toThrow();
 await expect(withTenant(ctx,tx=>tx.execute(sql`update personnel_private_search set matches='[]'::jsonb`))).rejects.toThrow();
 await expect(withTenant(ctx,tx=>tx.execute(sql`update personnel_private_search set expires_at=now()+interval '1 hour'`))).rejects.toThrow();
 expect(await personnelPrivateSearchAvailable(ctx,token,[b.companyId])).toBe(true);
 expect((await list({q:'900101-01-4321'})).total).toBe(0);
 const stored=await owner.withTenant(ctx,tx=>tx.execute<{matches:unknown}>(sql`select matches from personnel_private_search where token_hash=${privateSearchHash(token)}`));expect(JSON.stringify(stored)).not.toContain('900101');
});
it('matches canonical or conventionally formatted NRIC without converting alphanumeric identifiers or literal passport text',async()=>{
 const employee=await hire('Fictional formatted identity');await identity(employee.personId,'900101-01-4321');
 await owner.db.update(s.employeeStatutoryMy).set({passportNumber:'PX-AB123456Z'}).where(eq(s.employeeStatutoryMy.personId,employee.personId));
 for(const text of ['900101014321','900101-01-4321','900101 01 4321','PX-AB123456Z','AB123456']){
  const token=await createPersonnelPrivateSearch(ctx,{text,companyIds:[b.companyId]});const filters={companyIds:[b.companyId],privateSearch:token};
  expect((await list({...filters,limit:1})).rows.map(row=>row.employmentId)).toEqual([employee.employmentId]);
  expect((await countEmployeesByStatus(ctx,filters,'workforce')).total).toBe(1);
 }
 for(const text of ['A900101014321','900101/01/4321','900101.01.4321','PXAB123456Z']){
  const token=await createPersonnelPrivateSearch(ctx,{text,companyIds:[b.companyId]});
  expect((await list({privateSearch:token})).total).toBe(0);
  expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId],privateSearch:token},'workforce')).total).toBe(0);
 }
});
it('rechecks current identity permission for existing private results and does not widen denied search counts',async()=>{
 const employee=await hire('Identity denied later');await identity(employee.personId,'800202-02-3456');const token=await createPersonnelPrivateSearch(ctx,{text:'800202-02-3456',companyIds:[b.companyId]});expect((await list({privateSearch:token})).total).toBe(1);
 await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,role:'hr_admin',permissionKey:'report.read.identity',allowed:false});
 expect((await list({privateSearch:token})).total).toBe(0);expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId],privateSearch:token},'workforce')).total).toBe(0);
 const deniedToken=await createPersonnelPrivateSearch(ctx,{text:'800202-02-3456',companyIds:[b.companyId]});expect((await list({privateSearch:deniedToken})).total).toBe(0);
});
it('rejects borrowed/expired tokens and drops a cached match whose source row changed',async()=>{
 const employee=await hire('Private Needle');const token=await createPersonnelPrivateSearch(ctx,{text:'Private Needle',companyIds:[b.companyId]});
 const other={...ctx,userId:await createAppUser(b.tenantId,null,'hr_admin')};expect((await listEmployeesPage(other,{companyIds:[b.companyId],privateSearch:token,limit:100,offset:0},'workforce')).total).toBe(0);
 await owner.db.update(s.person).set({fullName:'Changed source name'}).where(eq(s.person.id,employee.personId));expect((await list({privateSearch:token})).total).toBe(0);
 const fresh=await createPersonnelPrivateSearch(ctx,{text:'Changed source name',companyIds:[b.companyId]});expect(await personnelPrivateSearchAvailable(ctx,fresh,[b.companyId])).toBe(true);
 const [extraCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Expanded top scope'}).returning();expect(await personnelPrivateSearchAvailable(ctx,fresh,[b.companyId,extraCompany.id])).toBe(false);expect((await list({companyIds:[b.companyId,extraCompany.id],privateSearch:fresh})).total).toBe(0);expect((await list({privateSearch:fresh})).total).toBe(1);
 await owner.withTenant(ctx,tx=>tx.execute(sql`update personnel_private_search set created_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' where token_hash=${privateSearchHash(fresh)}`));
 expect(await personnelPrivateSearchAvailable(ctx,fresh,[b.companyId])).toBe(false);expect((await list({privateSearch:fresh})).total).toBe(0);
});
it('combines stable grade codes, position and dates before pagination and displays the full Business Unit name',async()=>{
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade Twelve label'}).returning();
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'SHORT',label:'Short label',name:'Fictional full Business Unit name retained in Personnel and exports'}).returning();
 const employee=await hire('Full named unit',{gradeId:grade.id,businessUnitId:unit.id,positionId:b.positionId,hiredOn:'2024-03-01'});await hire('Other grade');
 const filters={companyIds:[b.companyId],jobGrades:['12'],positionIds:[b.positionId],businessUnitIds:[unit.id],joinedFrom:'2024-01-01',joinedTo:'2024-12-31'};
 const page=await listEmployeesPage(ctx,{...filters,limit:1,offset:0},'workforce');expect(page.rows.map(row=>row.employmentId)).toEqual([employee.employmentId]);expect(page.rows[0].businessUnit).toBe(unit.name);expect(page.total).toBe(1);expect((await countEmployeesByStatus(ctx,filters,'workforce')).total).toBe(1);
 expect((await list({jobGrades:['23']})).total).toBe(0);
});
it('does not let future assignment facts replace current department and position',async()=>{
 const employee=await hire('Dated placement',{positionId:b.positionId});await setEmploymentAssignment(ctx,{employmentId:employee.employmentId,effectiveDate:'2099-01-01',departmentId:b.deptB});
 const page=await list({departmentId:b.deptA});expect(page.rows.map(row=>row.employmentId)).toContain(employee.employmentId);expect((await list({departmentId:b.deptB})).rows.map(row=>row.employmentId)).not.toContain(employee.employmentId);
});
it('quality duplicates require distinct visible Persons and matching hire dates; legacy grouping is not blocked',async()=>{
 const a=await hire('Fictional  Same Name'),b2=await hire('fictional same name'),other=await hire('Fictional same name',{hiredOn:'2025-01-01'});
 const duplicates=await list({qualityFlags:['suspected_duplicate']});expect(duplicates.rows.map(row=>row.employmentId).sort()).toEqual([a.employmentId,b2.employmentId].sort());expect(duplicates.rows.map(row=>row.employmentId)).not.toContain(other.employmentId);
 const readiness=await withTenant(ctx,tx=>personnelGroupingReadinessTx(tx,ctx,{employmentIds:[a.employmentId],asOf:'2026-06-01'}));expect(readiness).toMatchObject([{ready:true,reason:null}]);
 const missing=await list({qualityFlags:['missing_business_unit']});expect(missing.rows.map(row=>row.employmentId)).toContain(a.employmentId);
 const unicodeA=await hire('Straße Example'),unicodeB=await hire('STRASSE EXAMPLE');const unicode=await list({qualityFlags:['suspected_duplicate']});expect(unicode.rows.map(row=>row.employmentId)).toEqual(expect.arrayContaining([unicodeA.employmentId,unicodeB.employmentId]));expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId],qualityFlags:['suspected_duplicate']},'workforce')).total).toBe(unicode.total);
});
it('scoped company options and duplicate evidence cannot expose another company or tenant',async()=>{
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Private other company'}).returning();const [dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Other dept'}).returning();
 const mine=await hire('Potential duplicate'),theirs=await hire('Potential duplicate',{companyId:company.id,departmentId:dept.id});
 const user=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user,role:'hr_admin',companyId:b.companyId});
 const scoped={...ctx,userId:user,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 // Direct native rows and private search must fence the same requested-but-denied company
 // before invoking the raising dated organisation resolver (not just filter option metadata).
 const native=await withTenant(scoped,tx=>tx.execute<{row:{employmentId:string}}>(sql`select value as row from app.personnel_filter_rows('2026-11-04'::date,ARRAY[${b.companyId}::uuid,${company.id}::uuid]) as source(value)`));
 expect(native.map(({row})=>row.employmentId)).toEqual([mine.employmentId]);
 const nativeSearch=await withTenant(scoped,tx=>tx.execute<{employmentId:string}>(sql`select value->>'employmentId' as "employmentId" from app.personnel_search_rows(ARRAY[${b.companyId}::uuid,${company.id}::uuid]) as source(value)`));
 expect(nativeSearch.map(row=>row.employmentId)).toEqual([mine.employmentId]);
 const token=await createPersonnelPrivateSearch(scoped,{text:'Potential duplicate',companyIds:[b.companyId]});
 expect((await listEmployeesPage(scoped,{companyIds:[b.companyId],privateSearch:token,limit:100,offset:0},'workforce')).rows.map(row=>row.employmentId)).toEqual([mine.employmentId]);
 const choices=await personnelFilterChoices(scoped,[b.companyId,company.id]);expect(choices.companies.map(c=>c.id)).toEqual([b.companyId]);expect(JSON.stringify(choices)).not.toContain('Private other company');
 const rows=await listEmployeesPage(scoped,{companyIds:[b.companyId,company.id],qualityFlags:['suspected_duplicate'],limit:100,offset:0},'workforce');expect(rows.total).toBe(0);
 expect((await listEmployeesPage(scoped,{companyIds:[b.companyId,company.id],limit:100,offset:0},'workforce')).rows.map(row=>row.employmentId)).toEqual([mine.employmentId]);expect(rows.rows.map(row=>row.employmentId)).not.toContain(theirs.employmentId);
});

it('refuses queued Personnel scope, list and export reads while the tenant access lock is held', async () => {
  const input = { companyIds: [b.companyId], limit: 1, offset: 0 };
  await owner.withTenant(ctx, async tx => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    await expect(workforceCompanies(ctx, 'maintain', { personnelList: true })).rejects.toBeInstanceOf(PersonnelReadBusyError);
    await expect(workforceViewScope(ctx, { personnelList: true })).rejects.toBeInstanceOf(PersonnelReadBusyError);
    await expect(readPersonnelOverview(ctx, input, {})).rejects.toBeInstanceOf(PersonnelReadBusyError);
    await expect(listEmployeesPage(ctx, input, 'workforce')).rejects.toBeInstanceOf(PersonnelReadBusyError);
  });
  await owner.withTenant(ctx, async tx => {
    await lockAccessConfigurationReadTx(tx, ctx.tenantId);
    await expect(workforceCompanies(ctx, 'maintain', { personnelList: true })).resolves.toContain(b.companyId);
    await expect(workforceViewScope(ctx, { personnelList: true })).resolves.toHaveProperty('companyIds');
    await expect(readPersonnelOverview(ctx, input, {})).resolves.toHaveProperty('employees.rows');
    await expect(listEmployeesPage(ctx, input, 'workforce')).resolves.toHaveProperty('rows');
  });
  expect((await workforceViewScope(ctx, { personnelList: true })).companyIds).toContain(b.companyId);
  await expect(readPersonnelOverview(ctx, input, {})).resolves.toHaveProperty('employees.rows');
});

it('recovers a standalone Personnel read when a brief Access writer releases its lock', async () => {
  let read: ReturnType<typeof workforceViewScope> | undefined;
  await owner.withTenant(ctx, async tx => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    read = workforceViewScope(ctx, { personnelList: true });
    // The first attempts encounter the writer, then the successful attempt opens a fresh transaction.
    await new Promise(resolve => setTimeout(resolve, 80));
  });
  await expect(read).resolves.toMatchObject({ companyIds: [b.companyId] });
});

it('retains unpaginated totals, status counts and company choices past the last Personnel row', async () => {
  const employee = await hire('Fictional Overview Employee');
  const companyIds = [b.companyId];
  const filter = { q: 'Fictional Overview Employee' };
  const first = await readPersonnelOverview(ctx, { companyIds, ...filter, limit: 1, offset: 0 }, filter);
  const pastEnd = await readPersonnelOverview(ctx, { companyIds, ...filter, limit: 1, offset: 10 }, filter);
  expect(first.employees.rows.map(row => row.employmentId)).toEqual([employee.employmentId]);
  expect(pastEnd.employees).toEqual({ rows: [], total: 1 });
  expect(pastEnd.headcount).toEqual(await countEmployeesByStatus(ctx, { companyIds, ...filter }, 'workforce'));
  expect(pastEnd.headcount.total).toBe(1);
  expect(pastEnd.organisationChoices.companies.map(company => company.id)).toContain(b.companyId);
});
