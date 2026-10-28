/**
 * 524303d9 — "Everything — new employees": every Bank & Statutory setting and the single-value hire-time
 * settings in the create template, whole-row validation before any write, the duplicate email policy applied in
 * full, Import History (kind `employee_full`) and Revert as a VOID (ADR-0157) that frees the Employee IDs, emails
 * and NRICs. Real database, real RLS, fictional fixtures.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {commitEmployeeImport,validateEmployeeImport} from '../core/import';
import {getPeopleGeneral,savePeopleGeneral} from '../core/people-general';
import {getImportAttempt,importAttemptSource,importSourceHash,listImportAttempts} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {readBankStatutoryStateTx,bankStatutorySubjectTx} from '../core/bank-statutory-import';
import {commitBankStatutoryUpload} from '../core/bank-statutory-upload';
import {listEmployeesPage,listEmployeesForPayrollRun,dashboardStats,listEmployees} from '../core/read';
import {headcountSummary} from '../core/analytics';
import {getTaxSelectionMY} from '../localization/my/tax-selection';
import {importAttemptStatus} from '../lib/import-history';
import {IMPORT_COLUMNS} from '../lib/import-schema';
import {personnelColumnLabel} from '../lib/personnel-import-contract';
import {buildPersonnelCsv} from '../lib/personnel-csv';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,a:SessionContext;
const BASE=['full_name','email','department','hired_on','ic_number','basic_salary','employee_code'];
const recs=(header:string[],rows:string[][])=>parseCsvRecords([header.join(','),...rows.map(r=>r.join(','))].join('\n')).records;
const ic=(n:number)=>`88${String(n).padStart(2,'0')}0101${String(n).padStart(4,'0')}`.slice(0,12);
const person=(n:number,code=`EV${String(n).padStart(3,'0')}`)=>[`Everything Subject ${n}`,`ev${n}@example.test`,'Finance','2026-02-02',ic(n),'4800',code];
const employmentOf=async(code:string)=>(await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,b.tenantId),eq(s.employment.employeeCode,code))))[0];
const stateOf=(employmentId:string)=>withTenant(a,async tx=>(await readBankStatutoryStateTx(tx,a,(await bankStatutorySubjectTx(tx,employmentId))!)).state);
const fileOf=(rows:string[][])=>Buffer.from([BASE.join(','),...rows.map(r=>r.join(','))].join('\n'));
async function importFile(ctx:SessionContext,rows:string[][],name='new-hires.csv'){
 const content=fileOf(rows);
 return{content,result:await commitEmployeeImport(ctx,{companyId:b.companyId,records:recs(BASE,rows),fileName:name,source:{name,content}})};
}
async function payrollInputFor(employmentId:string){
 const[period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-03'}).returning();
 const[batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:period.period,batchDate:'2026-03-31'}).returning();
 await owner.db.insert(s.payrollInput).values({tenantId:b.tenantId,batchId:batch.id,employmentId});
}
async function otherCompanyAdmin(){
 const[co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Other Fictional Sdn Bhd'}).returning();
 const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Scoped Other Admin',primaryEmail:'scoped.other@example.test'}).returning();
 const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:co.id}).where(eq(s.roleAssignment.appUserId,userId));
 return{...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId:co.id}]} as SessionContext;
}

beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();a=adminCtx(b);});
afterAll(closeAll);

describe('524303d9 · the Everything template carries every Bank & Statutory setting and the hire-time settings',()=>{
 it('offers the formerly update-only statutory columns and the three hire-time settings',()=>{
  const all=[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional];
  for(const c of ['epf_category','epf_employee_rate','employer_bears_epf','socso_category','eis_category','subject_to_skbbk','subject_to_hrdf','tax_circumstance','tax_residency','disabled_individual','child_relief_mode','child_relief_under_18_full','employer_bears_tax','payroll_policy','schedule_group','correspondence_same_as_permanent'])expect(all).toContain(c);
 });

 it('new columns create the values the Bank & Statutory tab shows, inside the hire',async()=>{
  const columns=[...BASE,'epf_citizenship','epf_category','epf_employee_rate','epf_employer_rate','employer_bears_epf','socso_category','eis_category','subject_to_skbbk','subject_to_hrdf','tax_circumstance','tax_residency','disabled_individual','child_relief_mode','child_relief_under_18_full','employer_bears_tax'];
  const values=[...person(1),'pr','manual_percentage','15','16','Yes','second','none','Yes','No','spouse_working','knowledge_worker','Yes','auto_table','2','Yes'];
  const result=await commitEmployeeImport(a,{companyId:b.companyId,records:recs(columns,[values])});
  expect(result,JSON.stringify(result)).toMatchObject({imported:1,failed:[],fileErrors:[]});
  const e=await employmentOf('EV001');
  const state=await stateOf(e.id);
  expect(state).toMatchObject({epf_citizenship:'pr',epf_category:'manual_percentage',epf_employee_rate:'15',epf_employer_rate:'16',employer_bears_epf:'yes',socso_category:'second',eis_category:'none',subject_to_skbbk:'yes',subject_to_hrdf:'no',tax_circumstance:'spouse_working',tax_residency:'knowledge_worker',disabled_individual:'yes',child_relief_mode:'auto_table',child_relief_under_18_full:'2',employer_bears_tax:'yes'});
  expect(await getTaxSelectionMY(a,e.id)).toMatchObject({scheme:'knowledge_worker',transitionState:'resolved'});
 });

 it('hire-time settings: same as permanent address, schedule group and payroll policy',async()=>{
  const[policy]=await owner.db.insert(s.payrollPolicy).values({tenantId:b.tenantId,companyId:b.companyId,name:'Monthly Staff',code:'MS1',policyType:'monthly'}).returning();
  const[rule]=await withTenant(a,tx=>tx.insert(s.attendanceRule).values({tenantId:b.tenantId,name:'Office Hours'}).returning());
  const columns=[...BASE,'address_line_1','postcode','city','correspondence_same_as_permanent','payroll_policy','schedule_group'];
  const result=await commitEmployeeImport(a,{companyId:b.companyId,records:recs(columns,[[...person(2),'1 Fictional Road','50000','Kuala Lumpur','Yes','ms1','office hours']])});
  expect(result,JSON.stringify(result)).toMatchObject({imported:1,fileErrors:[]});
  const e=await employmentOf('EV002');
  expect(e).toMatchObject({payrollPolicyId:policy.id,attendanceRuleId:rule.id});
  const[p]=await owner.db.select().from(s.person).where(eq(s.person.id,e.personId));
  expect(p).toMatchObject({permanentAddressLine1:'1 Fictional Road',correspondenceAddressLine1:'1 Fictional Road',correspondencePostcode:'50000',correspondenceCity:'Kuala Lumpur'});
  const bad=await validateEmployeeImport(a,{companyId:b.companyId,records:recs(columns,[[...person(3),'1 Road','50000','KL','Yes','No Such Policy','Night']])});
  expect(bad.rows[0].errors).toEqual(expect.arrayContaining([expect.stringContaining('Unknown payroll_policy'),expect.stringContaining('Unknown schedule_group')]));
 });

 it('a row with a statutory error creates nothing, and is reported before any write',async()=>{
  const columns=[...BASE,'epf_category','epf_employee_amount','tax_residency','epf_citizenship'];
  const rows=[[...person(4),'manual_both_amount','','',''],[...person(5),'','','c_suite','citizen']];
  const preview=await validateEmployeeImport(a,{companyId:b.companyId,records:recs(columns,rows)});
  expect(preview.validCount).toBe(0);
  expect(preview.rows[0].errors.join(' ')).toMatch(/EPF Category: /);
  expect(preview.rows[1].errors.join(' ')).toContain('C-Suite needs EPF citizenship PR or non-citizen');
  const result=await commitEmployeeImport(a,{companyId:b.companyId,records:recs(columns,rows)});
  expect(result.imported).toBe(0);
  expect(await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId))).toHaveLength(0);
 });
});

describe('524303d9 · duplicate email follows the People General setting in full',()=>{
 it('is refused with the setting OFF and a warning with it ON',async()=>{
  expect((await importFile(a,[person(6)])).result.imported).toBe(1);
  const again=[[`Second Holder`,`ev6@example.test`,'Finance','2026-02-02',ic(7),'4800','EV007']];
  const off=await validateEmployeeImport(a,{companyId:b.companyId,records:recs(BASE,again)});
  expect(off.rows[0]).toMatchObject({ok:false});expect(off.rows[0].errors.join(' ')).toContain('already used by another employee');
  await savePeopleGeneral(a,{...(await getPeopleGeneral(a)),allowDuplicatedEmail:true});
  const on=await validateEmployeeImport(a,{companyId:b.companyId,records:recs(BASE,again)});
  expect(on.rows[0]).toMatchObject({ok:true});expect(on.rows[0].warnings).toContain('A person with this email already exists');
 });
});

describe('524303d9 · Import History and Revert (void)',()=>{
 it('lists the created Employee IDs, keeps the file, voids on revert, frees the identifiers and re-imports',async()=>{
  const rows=[person(10),person(11)];
  const{content,result}=await importFile(a,rows);
  expect(result,JSON.stringify(result)).toMatchObject({imported:2,fileErrors:[]});
  const attemptId=result.attemptId!;
  const detail=(await getImportAttempt(a,attemptId))!;
  expect(detail.kind).toBe('employee_full');
  expect(importAttemptStatus(detail.plan,detail.events)).toBe('succeeded');
  expect(detail.items.map(i=>i.label)).toEqual(['EV010 · Everything Subject 10','EV011 · Everything Subject 11']);
  const source=(await importAttemptSource(a,attemptId))!;
  expect(Buffer.from(source.content).equals(content)).toBe(true);expect(source.sourceHash).toBe(importSourceHash(content));
  // The old run list keeps being written.
  expect((await owner.db.select().from(s.employeeImportRun).where(eq(s.employeeImportRun.tenantId,b.tenantId)))).toHaveLength(1);

  const e10=await employmentOf('EV010');
  const listedBefore=await listEmployeesPage(a,{limit:50,offset:0},'workforce');
  expect(listedBefore.rows.map(r=>r.employeeCode).sort()).toEqual(['EV010','EV011']);
  expect((await dashboardStats(a)).headcount).toBe(2);
  expect((await listEmployeesForPayrollRun(a,b.companyId,'2026-03')).map(r=>r.employeeCode).sort()).toEqual(['EV010','EV011']);

  const preview=await previewImportRevertForAttempt(a,attemptId);
  expect(preview,JSON.stringify(preview.blockers)).toMatchObject({eligible:true,blockers:[]});
  await expect(revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'no'})).rejects.toThrow('Enter a reason');
  await revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'Wrong company in this file'});

  const[voided]=await owner.db.select().from(s.employment).where(eq(s.employment.id,e10.id));
  expect(voided).toMatchObject({employeeCode:null,voidedEmployeeCode:'EV010',voidReason:'Wrong company in this file',voidedImportAttemptId:attemptId,voidedBy:a.userId});
  expect(voided.voidedAt).toBeInstanceOf(Date);
  const[voidedPerson]=await owner.db.select().from(s.person).where(eq(s.person.id,e10.personId));
  expect(voidedPerson).toMatchObject({voidedIcNumber:ic(10),primaryEmail:'ev10@example.test'});
  const[statutory]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,e10.personId));
  expect(statutory.icNumber).toBeNull();
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'employment.voided')));
  expect(events.map(e=>e.aggregateId).sort()).toEqual([e10.id,(await owner.db.select().from(s.employment).where(eq(s.employment.voidedEmployeeCode,'EV011')))[0].id].sort());
  const reverted=(await getImportAttempt(a,attemptId))!;expect(importAttemptStatus(reverted.plan,reverted.events)).toBe('reverted');

  // Gone from the people list, the pickers, headcount (dashboard and analytics) and payroll selection.
  expect((await listEmployeesPage(a,{limit:50,offset:0},'workforce')).rows).toEqual([]);
  expect(await listEmployees(a)).toEqual([]);
  expect((await dashboardStats(a)).headcount).toBe(0);
  expect((await headcountSummary(a,undefined,{asOf:'2026-03-01'})).total).toBe(0);
  expect(await listEmployeesForPayrollRun(a,b.companyId,'2026-03')).toEqual([]);

  // Once only.
  await expect(previewImportRevertForAttempt(a,attemptId)).rejects.toThrow('already been reverted');
  await expect(revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'Again please'})).rejects.toThrow('already been reverted');

  // The same file imports again: the Employee IDs, emails and NRICs were released.
  const again=await importFile(a,rows);
  expect(again.result,JSON.stringify(again.result)).toMatchObject({imported:2,fileErrors:[]});
  expect((await employmentOf('EV010')).id).not.toBe(e10.id);
 });

 it('is blocked, as a whole, when one employee has payroll input or leave since the import',async()=>{
  const{result}=await importFile(a,[person(20),person(21)]);
  const e20=await employmentOf('EV020'),e21=await employmentOf('EV021');
  await payrollInputFor(e20.id);
  await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:e21.id,leaveTypeId:b.annualLeaveTypeId,entryType:'debit',days:'-1.00',effectiveOn:'2026-03-02'});
  const preview=await previewImportRevertForAttempt(a,result.attemptId!);
  expect(preview.eligible).toBe(false);
  expect(preview.blockers).toEqual(expect.arrayContaining([
   expect.objectContaining({label:'EV020 · Everything Subject 20',reason:expect.stringContaining('payroll inputs or results')}),
   expect.objectContaining({label:'EV021 · Everything Subject 21',reason:expect.stringContaining('leave')}),
  ]));
  await expect(revertImportForAttempt(a,result.attemptId!,{previewHash:preview.previewHash,reason:'Undo the file'})).rejects.toThrow('cannot be reverted');
  expect((await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,b.tenantId),isNull(s.employment.voidedAt))))).toHaveLength(2);
  const failed=(await getImportAttempt(a,result.attemptId!))!;expect(failed.events.map(e=>e.kind)).toContain('revert_failed');
 });

 it('an administrator of another company can neither see nor revert the import',async()=>{
  const{result}=await importFile(a,[person(30)]);
  const other=await otherCompanyAdmin();
  expect(await getImportAttempt(other,result.attemptId!)).toBeNull();
  expect((await listImportAttempts(other,{kind:'employee_full'})).items).toEqual([]);
  await expect(previewImportRevertForAttempt(other,result.attemptId!)).rejects.toThrow();
  expect(await importAttemptSource(other,result.attemptId!)).toBeNull();
 });

 it('a void cannot be written outside an import revert, and a voided row leaves every ordinary write',async()=>{
  const{result}=await importFile(a,[person(40)]);
  const e=await employmentOf('EV040');
  const direct=withTenant(a,tx=>tx.execute(sql`update employment set voided_at=now(),voided_by=${a.userId}::uuid,void_reason='manual',voided_import_attempt_id=gen_random_uuid(),voided_employee_code=employee_code,employee_code=null where id=${e.id}::uuid`));
  await expect(direct).rejects.toThrow();
  const preview=await previewImportRevertForAttempt(a,result.attemptId!);
  await revertImportForAttempt(a,result.attemptId!,{previewHash:preview.previewHash,reason:'Duplicate file'});
  // Final: the voided row has left every ordinary read and write.
  const after=await withTenant(a,tx=>tx.execute(sql`update employment set void_reason='changed' where id=${e.id}::uuid returning id`));
  expect([...after]).toEqual([]);
 });
});

describe('524303d9 · Bank & Statutory revert restores an empty value the tab can hold',()=>{
 it('puts payment method back to "Not set"',async()=>{
  expect((await importFile(a,[[...person(50)]])).result.imported).toBe(1);
  const e=await employmentOf('EV050');
  expect(e.paymentMethod).toBeNull();
  await owner.db.update(s.employeeStatutoryMy).set({bankName:'Maybank',bankAccountNo:'514000111250'}).where(eq(s.employeeStatutoryMy.personId,e.personId));
  const columns=['employee_code','payment_method'];
  const file=Buffer.from(buildPersonnelCsv('employee',[columns.map(c=>personnelColumnLabel(c,'employee')),['EV050','bank_transfer']]));
  const upload=await commitBankStatutoryUpload(a,{name:'payment.csv',content:file});
  expect(upload,JSON.stringify(upload)).toMatchObject({updated:1});
  expect((await employmentOf('EV050')).paymentMethod).toBe('bank_transfer');
  const preview=await previewImportRevertForAttempt(a,upload.attemptId);
  expect(preview,JSON.stringify(preview.blockers)).toMatchObject({eligible:true});
  await revertImportForAttempt(a,upload.attemptId,{previewHash:preview.previewHash,reason:'Wrong payment file'});
  expect((await employmentOf('EV050')).paymentMethod).toBeNull();
 });
});
