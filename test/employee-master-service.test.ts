import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setPayrollPermissionGrant } from '../core/payroll-permissions-admin';
import { masterReportCatalogue } from '../core/employee-master-access';
import { authorizeEmployeeMasterRun, deleteEmployeeMasterReport, duplicateEmployeeMasterReport, getEmployeeMasterReport, listEmployeeMasterReports, recordEmployeeMasterRun, runEmployeeMasterReport, saveEmployeeMasterReport } from '../core/employee-master-reports';
import { employeeMasterStarter } from '../lib/employee-master-starters';
import { defaultMasterColumn, type EmployeeMasterSpec } from '../lib/employee-master-report';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { runReportSpec, getDataset } from '../core/report-registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { requirePackFor } from '../localization/registry';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let receivingUserId:string;
let b:Base,ctx:SessionContext,peer:SessionContext,employee:Awaited<ReturnType<typeof hireEmployee>>;
const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!,salary=PERSONNEL_FIELDS.find(field=>field.owner==='compensation'&&field.ownerField==='basicSalary')!;
function basic():EmployeeMasterSpec{return {v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx={...adminCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'peer-'+randomUUID()}).returning({id:schema.appUser.id});await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin'});peer={...ctx,userId:user.id};const hired=new Date(todayInKualaLumpur()+'T00:00:00Z');hired.setUTCDate(hired.getUTCDate()-90);employee=await hireEmployee(ctx,{person:{fullName:'Synthetic report employee',primaryEmail:'report-'+randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hired.toISOString().slice(0,10)});const [receiver]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'receiver-'+randomUUID(),personId:employee.personId}).returning({id:schema.appUser.id});receivingUserId=receiver.id;});
const save=(spec=basic(),sharedRoleIds:string[]=[])=>saveEmployeeMasterReport(ctx,[b.companyId],{name:'Synthetic report',description:'Fixture',spec,sharedRoleIds});
describe('Employee Master authorization and persistence',()=>{
 it('keeps a private definition inaccessible to another HR administrator on direct read, duplicate, list, raw SQL and delete',async()=>{
  const saved=await save();await expect(getEmployeeMasterReport(peer,[b.companyId],saved.id)).rejects.toThrow();await expect(duplicateEmployeeMasterReport(peer,[b.companyId],saved.id)).rejects.toThrow();expect(await listEmployeeMasterReports(peer,[b.companyId])).toEqual([]);
  expect(await withTenant(peer,tx=>tx.select().from(schema.customReport).where(eq(schema.customReport.id,saved.id)))).toEqual([]);await expect(deleteEmployeeMasterReport(peer,saved.id)).rejects.toThrow();expect((await getEmployeeMasterReport(ctx,[b.companyId],saved.id)).ownerUserId).toBe(ctx.userId);
 });
 it('saves/reopens, permits visible-admin edits, increments versions, disables reviewed schedules, and duplicates privately without a schedule',async()=>{
  const saved=await save(basic(),['hr_admin']);const before=await getEmployeeMasterReport(peer,[b.companyId],saved.id);expect(before.canEdit).toBe(true);
  await withTenant(ctx,tx=>tx.insert(schema.customReportSchedule).values({tenantId:b.tenantId,reportId:saved.id,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:receivingUserId,employmentId:employee.employmentId}],reportVersion:saved.version,reviewedDigest:'a'.repeat(64),nextRunAt:new Date(Date.now()+86_400_000)}));
  const changed=await saveEmployeeMasterReport(peer,[b.companyId],{id:saved.id,version:before.version,name:'Changed report',description:'Updated',spec:before.spec,sharedRoleIds:['hr_admin']});expect(changed.version).toBeGreaterThan(before.version);
  expect((await withTenant(ctx,tx=>tx.select().from(schema.customReportSchedule)))[0].enabled).toBe(false);await expect(saveEmployeeMasterReport(ctx,[b.companyId],{id:saved.id,version:before.version,name:'Stale',description:'',spec:before.spec,sharedRoleIds:[]})).rejects.toThrow(/changed/i);
  const copy=await duplicateEmployeeMasterReport(peer,[b.companyId],saved.id);expect(await getEmployeeMasterReport(peer,[b.companyId],copy.id)).toMatchObject({shared:false,sharedRoleIds:[],ownerUserId:peer.userId});expect(await withTenant(peer,tx=>tx.select().from(schema.customReportSchedule).where(eq(schema.customReportSchedule.reportId,copy.id)))).toEqual([]);
 });
 it('hides compensation and history money from a denied administrator, and refuses forged columns, filters, sorts, groups and the legacy route',async()=>{
  await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});const fields=await masterReportCatalogue(ctx,[b.companyId]);expect(fields.some(field=>field.owner==='compensation'||field.owner==='movement'&&field.ownerField==='basicSalary')).toBe(false);
  const base=basic();for(const forged of [{...base,columns:[defaultMasterColumn(salary)]},{...base,expression:{id:'root',type:'group',logic:'and',children:[{id:'salary',type:'condition',field:salary.id,operator:'after',value:0}]}},{...base,sorts:[{field:salary.id,dir:'asc'}]},{...base,groups:[salary.id]}])await expect(runEmployeeMasterReport(ctx,[b.companyId],{spec:forged})).rejects.toThrow(/unavailable|permitted/i);
  await expect(runReportSpec(ctx,[b.companyId],{datasetId:'master',columns:['basicSalary']})).rejects.toThrow(/unavailable|permitted/i);await expect(getDataset('master')!.run(ctx,[b.companyId],{})).rejects.toThrow(/authorised/i);
 });
 it('refuses a selected company outside server scope and a stale principal after its grant is revoked',async()=>{
  const other=await seedBase();await expect(runEmployeeMasterReport(ctx,[b.companyId],{spec:{...basic(),companyIds:[other.companyId]}})).rejects.toThrow();const run=await runEmployeeMasterReport(ctx,[b.companyId],{spec:basic()});await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));await expect(authorizeEmployeeMasterRun(ctx,[b.companyId],run)).rejects.toThrow();
 });
 it('keeps ended employments in the Resigned starter under their last employer',async()=>{
  const end=new Date(todayInKualaLumpur()+'T00:00:00Z');end.setUTCDate(end.getUTCDate()-1);await owner.db.update(schema.employment).set({terminatedOn:end.toISOString().slice(0,10)}).where(eq(schema.employment.id,employee.employmentId));const fields=await masterReportCatalogue(ctx,[b.companyId]),spec=employeeMasterStarter(fields,[b.companyId],todayInKualaLumpur(),'resigned');const run=await runEmployeeMasterReport(ctx,[b.companyId],{spec});expect(run.result.employeeCount).toBe(1);expect(run.result.sections[0].rows[0].subjectId).toBe(employee.employmentId);
 });
 it('records structural run metadata and last-success time without row payloads',async()=>{
  const saved=await save(),run=await runEmployeeMasterReport(ctx,[b.companyId],{id:saved.id});await recordEmployeeMasterRun(ctx,run,'export','xlsx');const rows=await withTenant(ctx,tx=>tx.select().from(schema.customReportRun));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({reportId:saved.id,rowCount:1,outcome:'success',actorUserId:ctx.userId});expect(JSON.stringify(rows)).not.toContain('Synthetic report employee');expect((await getEmployeeMasterReport(ctx,[b.companyId],saved.id)).lastRunAt).not.toBeNull();
 });
 it('retains sent/uncertain occurrence identity after deleting its report and schedule',async()=>{
  const saved=await save();const [schedule]=await withTenant(ctx,tx=>tx.insert(schema.customReportSchedule).values({tenantId:b.tenantId,reportId:saved.id,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:receivingUserId,employmentId:employee.employmentId}],reportVersion:saved.version,reviewedDigest:'b'.repeat(64)}).returning({id:schema.customReportSchedule.id}));
  await owner.db.insert(schema.customReportOccurrence).values({tenantId:b.tenantId,scheduleId:schedule.id,reportId:saved.id,ownerUserId:ctx.userId!,recipientUserId:receivingUserId,recipientEmploymentId:employee.employmentId,scheduledFor:new Date(),reportVersion:saved.version,scheduleRevision:randomUUID(),reviewedDigest:'b'.repeat(64),consentAfterSequence:0,policyAfterSequence:0,consentUpdatedAt:new Date(),policyUpdatedAt:new Date(),consentVerifiedAt:new Date(),status:'uncertain'});await deleteEmployeeMasterReport(ctx,saved.id);expect(await withTenant(ctx,tx=>tx.select().from(schema.customReportOccurrence))).toHaveLength(1);expect(await withTenant(peer,tx=>tx.select().from(schema.customReportOccurrence))).toEqual([]);
 });
 it('reads a missing legacy tax selection without locks/initialization in the report snapshot and preserves tenant/subject scope',async()=>{
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,employee.employmentId));const pack=requirePackFor('MY');const read=await withTenant(ctx,tx=>pack.statutory.getTaxSelection!(ctx,employee.employmentId,undefined,{tx,readOnly:true}),{readOnlySnapshot:true});expect(read).toMatchObject({version:0,transitionState:'confirmation_required'});expect(await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,employee.employmentId))).toEqual([]);
  const other=await seedBase();await expect(withTenant({...adminCtx(other),grants:[{role:'hr_admin',companyId:null}]},tx=>pack.statutory.getTaxSelection!({...adminCtx(other),grants:[{role:'hr_admin',companyId:null}]},employee.employmentId,undefined,{tx,readOnly:true}),{readOnlySnapshot:true})).rejects.toMatchObject({code:'not_found'});
 });
});
