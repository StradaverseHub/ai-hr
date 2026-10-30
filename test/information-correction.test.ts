import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import * as XLSX from 'xlsx';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentGrade} from '../core/org';
import {upsertCompanyStatutoryAuthority} from '../core/statutory-authority';
import {assignLabelToCompanies} from '../core/system-labels';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {previewInformationCorrection,correctInformation,informationCorrectionHistory,informationCorrectionOptions} from '../core/information-correction';
import {previewInformationUpload,confirmInformationUpload} from '../core/information-correction-import';
import {openLeaveYear,accrueEarnedLeave,reprojectEntitlementForEmployment} from '../core/leave';
import {reconcileInformationSnapshots} from '../scripts/reconcile-information-snapshots';
import {PDFDocument} from 'pdf-lib';
import {buildPayslipPdfData,renderPayslipPdf} from '../lib/payslip-pdf';
import {labels as pdfLabels} from './fixtures/payslip-pdf-fixture';
import {getImportAttempt,importAttemptSource} from '../core/import-history';
import {reportPreview} from '../core/reporting';
import {pcb2iiStatement} from '../localization/my/pcb2ii';
import {eaStatement,eaCompaniesInYear} from '../localization/my/reports';
import {payslipForReview,listPayrollRegisterAcross,listPayslipRunsFor,listProcessedPayslipsAcross} from '../core/payroll-view';
import {INFORMATION_HEADERS,type InformationChanges} from '../lib/information-correction';
import {parseInformationWorkbook,informationWorkbook} from '../lib/information-correction-workbook';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
beforeAll(()=>migrateTestDb());beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.update(schema.company).set({companyLabel:'DEMO'}).where(eq(schema.company.id,b.companyId));});afterAll(()=>closeAll());
const ctx=()=>adminCtx(b);
async function fixture(code='EMP-001'){
 const hired=await hireEmployee(ctx(),{person:{fullName:'Aisha Fixture',primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2025-01-15'});
 await owner.db.update(schema.employment).set({employeeCode:code}).where(eq(schema.employment.id,hired.employmentId));return hired.employmentId;
}
async function closedSlip(employmentId:string,statutory:Record<string,unknown>={epfEmployee:330,epfEmployer:390,pcb:10}){
 const [period]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2025-01',status:'closed'}).returning();
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2025-01',batchDate:'2025-01-25',status:'closed',releasedAt:new Date('2025-01-25T00:00:00Z')}).returning();
 const [slip]=await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'3000.00',grossPay:'3000.00',statutory,totalDeductions:'340.00',netPay:'2660.00',employerCost:'3390.00'}).returning();return {batch,slip};
}
async function apply(id:string,changes:InformationChanges,reason='Correct signed employment record'){
 const p=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason});return correctInformation(ctx(),{employmentId:id,changes,reason,fingerprint:p.fingerprint,method:'manual'});
}
function workbook(rows:unknown[][]){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[...INFORMATION_HEADERS],...rows]),'Corrections');return XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;}
describe('8550b282 information-only corrections',()=>{
 it('corrects dates, grade and type after closure while preserving payroll and report rendering',async()=>{
  const id=await fixture();
  await owner.db.insert(schema.leaveLedger).values([{tenantId:b.tenantId,employmentId:id,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'9.00',effectiveOn:'2025-01-15'},{tenantId:b.tenantId,employmentId:id,leaveTypeId:b.annualLeaveTypeId,entryType:'debit',days:'-1.00',effectiveOn:'2025-01-20'}]);
  await owner.db.insert(schema.attendance).values({tenantId:b.tenantId,employmentId:id,attendanceDate:'2025-01-20',checkInAt:'09:00',checkOutAt:'19:00',status:'present',dayType:'workday',workedMinutes:600,otMinutes:120,ot15Minutes:120});
  const attendanceBefore=await owner.db.select().from(schema.attendance);expect(attendanceBefore).toHaveLength(1);
  const {slip,batch}=await closedSlip(id);
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'G03',name:'Senior'}).returning();
  const eaBefore=await eaStatement(ctx(),{employmentId:id,companyId:b.companyId,year:'2025'});
  expect(eaBefore).toBeTruthy();
  const before=await payslipForReview(ctx(),{companyIds:[b.companyId],payslipId:slip.id});
  expect(before).toBeTruthy();expect(before!.employmentType).toBe('full_time');
  async function document(row:NonNullable<typeof before>){
   const data=buildPayslipPdfData({...row,employee:row.employeeName},{epf:'EPF',socso:'SOCSO',skbbk:'SKBBK',eis:'EIS',tax:'PCB'},{currency:row.currency,jobGrade:row.jobGrade,employmentType:row.employmentType});
   const bytes=await renderPayslipPdf(data,pdfLabels);const pdf=await PDFDocument.load(bytes,{updateMetadata:false});pdf.setCreationDate(new Date(0));pdf.setModificationDate(new Date(0));return Buffer.from(await pdf.save({useObjectStreams:false}));
  }
  const pdfBefore=await document(before!);expect(pdfBefore.length).toBeGreaterThan(1000);
  const ledgersBefore=await owner.db.select().from(schema.leaveLedger);expect(ledgersBefore).toHaveLength(2);
  await apply(id,{hiredOn:'2025-01-01',joinDate:'2025-01-03',gradeId:grade.id,employmentType:'part_time'});
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0]).toMatchObject({hiredOn:'2025-01-01',joinDate:'2025-01-03',gradeId:grade.id});
  expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,slip.id)))[0]).toEqual(slip);
  expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batch.id)))[0]).toEqual(batch);
  expect(await owner.db.select().from(schema.leaveLedger)).toEqual(ledgersBefore);
  expect(await owner.db.select().from(schema.attendance)).toEqual(attendanceBefore);
  const after=await payslipForReview(ctx(),{companyIds:[b.companyId],payslipId:slip.id});expect(after).toEqual(before);
  expect(await document(after!)).toEqual(pdfBefore);
  expect(await eaStatement(ctx(),{employmentId:id,companyId:b.companyId,year:'2025'})).toEqual(eaBefore);
  const register=await listPayrollRegisterAcross(ctx(),{companyIds:[b.companyId],year:2025});expect(register.length).toBe(1);expect(register[0]).toMatchObject({jobGrade:null,employmentType:'full_time',net:'2660.00'});
  const versions=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,id));expect(versions).toHaveLength(2);expect(versions.find(a=>a.validTo===null)).toMatchObject({validFrom:todayInKualaLumpur(),employmentType:'part_time'});
  const history=await informationCorrectionHistory(ctx(),id);expect(history).toHaveLength(1);expect(history[0].actorId).toBe(ctx().userId);expect(history[0].payload).toMatchObject({method:'manual',reason:'Correct signed employment record',before:{hiredOn:'2025-01-15'},after:{hiredOn:'2025-01-01'}});
 });
 it('preserves the first snapshot through repeated corrections and refuses stale reviews',async()=>{
  const id=await fixture(),{slip}=await closedSlip(id);const review=await previewInformationCorrection(ctx(),{employmentId:id,changes:{hiredOn:'2025-01-01'},reason:'Correct offer date'});
  await apply(id,{hiredOn:'2025-01-02'});
  await expect(correctInformation(ctx(),{employmentId:id,changes:{hiredOn:'2025-01-01'},reason:'Correct offer date',fingerprint:review.fingerprint,method:'manual'})).rejects.toThrow('changed after your review');
  await apply(id,{hiredOn:'2025-01-03'});expect((await owner.db.select().from(schema.informationPayslipSnapshot).where(eq(schema.informationPayslipSnapshot.payslipId,slip.id)))[0].hiredOn).toBe('2025-01-15');
 });
 it('validates reasons, calendar dates and contract prerequisites without partial writes',async()=>{
  const id=await fixture();
  await expect(apply(id,{hiredOn:'2025-02-30'})).rejects.toThrow('valid date');
  await expect(apply(id,{hiredOn:'2025-01-01'},' ')).rejects.toThrow('correction reason');
  await expect(apply(id,{employmentType:'contract',hiredOn:'2025-01-01'})).rejects.toThrow('contract start and end');
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0].hiredOn).toBe('2025-01-15');expect(await informationCorrectionHistory(ctx(),id)).toHaveLength(0);
 });
 it('stops when historical original metadata cannot be verified after a later change',async()=>{
  const id=await fixture();await closedSlip(id);
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'G02',name:'Changed later'}).returning();
  await setEmploymentGrade(ctx(),{employmentId:id,gradeId:grade.id});
  await expect(apply(id,{hiredOn:'2025-01-01'})).rejects.toThrow('Original historical information cannot be verified');
  expect(await owner.db.select().from(schema.informationPayslipSnapshot)).toHaveLength(0);
 });
 it('corrects a compatible company without moving prior payroll or its dated assignment',async()=>{
  const id=await fixture(),{slip,batch}=await closedSlip(id,{epfEmployee:315,epfEmployer:369,pcb:10,socsoEmployee:12,socsoEmployer:18,eisEmployee:3,eisEmployer:3,bases:{epf:3000,socso:3000,eis:3000}});
  const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Destination',companyLabel:'DEST'}).returning();
  await assignLabelToCompanies(ctx(),{kind:'department',labelId:b.deptA,companyIds:[b.companyId,destination.id]});
  await assignLabelToCompanies(ctx(),{kind:'position',labelId:b.positionId,companyIds:[b.companyId,destination.id]});
  const officerId=await fixture('OFFICER');
  const [officer]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,officerId));
  await upsertCompanyStatutoryAuthority(ctx(),{companyId:b.companyId,authority:'lhdn',signatoryPersonId:officer.personId});
  const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id));
  await owner.db.insert(schema.tp1Relief).values({tenantId:b.tenantId,personId:subject.personId,assessmentYear:2025,status:'approved',tp1Amount:'120.00',deductionMonth:1,approvedMonth:1});
  await owner.db.insert(schema.eaOverride).values({tenantId:b.tenantId,employmentId:id,year:'2025',field:'gross',amount:'3100.00',reason:'Verified declared amendment'});
  const eaBefore=await eaStatement(ctx(),{employmentId:id,companyId:b.companyId,year:'2025'});expect(eaBefore).toBeTruthy();
  const pcbBefore=await pcb2iiStatement(ctx(),{employmentId:id,companyId:b.companyId,year:'2025',selectedDate:'2025-02-01'});expect(pcbBefore).toBeTruthy();
  const reportRequests=['my.cp39','my.borang-a','my.borang-8a','my.socso-eis','my.hrd-levy','my.cp8d'].map(reportId=>({companyId:b.companyId,reportId,periodKey:reportId==='my.cp8d'?'2025':'2025-01'}));
  const reportsBefore=await Promise.all(reportRequests.map(p=>reportPreview(ctx(),p)));for(const report of reportsBefore)expect(report.rows.length).toBeGreaterThan(0);
  await apply(id,{companyId:destination.id});
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0].companyId).toBe(destination.id);
  const versions=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,id));
  expect(versions.find(v=>v.validTo!==null)?.companyId).toBe(b.companyId);expect(versions.find(v=>v.validTo===null)?.companyId).toBe(destination.id);
  expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batch.id)))[0]).toEqual(batch);expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,slip.id)))[0]).toEqual(slip);
  const [hrPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Source company HR',primaryEmail:randomUUID()+'@example.test'}).returning();
  const sourceUser=await createAppUser(b.tenantId,hrPerson.id,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,sourceUser));
  const sourceCtx={...ctx(),userId:sourceUser,personId:hrPerson.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
  expect(await payslipForReview(sourceCtx,{companyIds:[b.companyId],payslipId:slip.id})).toMatchObject({companyId:b.companyId,employmentType:'full_time',net:'2660.00'});
  expect(await eaStatement(sourceCtx,{employmentId:id,companyId:b.companyId,year:'2025'})).toEqual(eaBefore);
  expect(await pcb2iiStatement(sourceCtx,{employmentId:id,companyId:b.companyId,year:'2025',selectedDate:'2025-02-01'})).toEqual(pcbBefore);
  expect(await eaCompaniesInYear(sourceCtx,{employmentId:id,year:'2025'})).toEqual([{companyId:b.companyId,name:(await owner.db.select().from(schema.company).where(eq(schema.company.id,b.companyId)))[0].legalName,isCurrent:false}]);
  for(const [index,p] of reportRequests.entries())expect(await reportPreview(sourceCtx,p),p.reportId).toEqual(reportsBefore[index]);
  const forbiddenProjection=await withTenant(sourceCtx,tx=>tx.execute<{data:Record<string,unknown>}>(sql`select data from app.information_report_records('employment',${b.companyId}::uuid,'2025') data`));expect(forbiddenProjection).toHaveLength(1);expect(forbiddenProjection[0].data).not.toHaveProperty('work_state');expect(forbiddenProjection[0].data).not.toHaveProperty('grade_id');
  expect(await withTenant(sourceCtx,tx=>tx.execute(sql`select * from app.information_report_records('employment',${destination.id}::uuid,'2025')`))).toEqual([]);
  expect(await listPayslipRunsFor(sourceCtx,{companyIds:[b.companyId],employmentId:id})).toMatchObject([{payslipId:slip.id,companyId:b.companyId}]);
  expect(await listProcessedPayslipsAcross(sourceCtx,{companyIds:[b.companyId],year:2025,limit:1})).toMatchObject([{id:slip.id,net:'2660.00'}]);
  expect(await listProcessedPayslipsAcross(sourceCtx,{companyIds:[...Array.from({length:100},()=>randomUUID()),b.companyId],year:2025,limit:1})).toMatchObject([{id:slip.id,net:'2660.00'}]);
  const filter=await withTenant(sourceCtx,tx=>tx.execute<{type:string}>(sql`select app.payroll_filter_run_type(${randomUUID()}::uuid,'regular','bonus') as type`));expect(filter[0].type).toBe('bonus');
  expect(await listPayrollRegisterAcross(sourceCtx,{companyIds:[b.companyId],year:2025})).toMatchObject([{employmentType:'full_time',net:'2660.00'}]);
  expect(await withTenant(sourceCtx,tx=>tx.select().from(schema.employment).where(eq(schema.employment.id,id)))).toEqual([]);
  expect(await payslipForReview(sourceCtx,{companyIds:[destination.id],payslipId:slip.id})).toBeNull();
  const employeeCtx={...sourceCtx,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  expect(await payslipForReview(employeeCtx,{companyIds:[b.companyId],payslipId:slip.id})).toBeNull();
  expect(await withTenant(employeeCtx,tx=>tx.execute(sql`select * from app.information_report_records('employment',${b.companyId}::uuid,'2025')`))).toEqual([]);

 });
 it('requires a fresh review when the selected reference code changes',async()=>{
  const id=await fixture();const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'G03',name:'Proposed grade'}).returning();
  const changes={gradeId:grade.id},reason='Correct signed record';const reviewed=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason});
  await owner.db.update(schema.jobGrade).set({code:'G04'}).where(eq(schema.jobGrade.id,grade.id));
  await expect(correctInformation(ctx(),{employmentId:id,changes,reason,fingerprint:reviewed.fingerprint,method:'manual'})).rejects.toThrow('changed after your review');
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0].gradeId).toBeNull();
 });
 it('does not write an audit correction for unchanged information',async()=>{const id=await fixture();expect((await apply(id,{})).changed).toBe(false);expect(await informationCorrectionHistory(ctx(),id)).toHaveLength(0);});
 it('refuses a normal employee and another tenant',async()=>{
  const id=await fixture();await expect(previewInformationCorrection({...ctx(),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{employmentId:id,changes:{},reason:'Inspect information'})).rejects.toThrow();
  await expect(previewInformationCorrection({...ctx(),tenantId:randomUUID()},{employmentId:id,changes:{},reason:'Inspect information'})).rejects.toThrow();
 });
 it('requires compatible destination organisation dimensions for Company',async()=>{
  const id=await fixture();const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Destination',companyLabel:'DEST'}).returning();
  await expect(apply(id,{companyId:co.id})).rejects.toThrow();expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0].companyId).toBe(b.companyId);
 });
 it('saves valid Excel rows, retains errors and unchanged rows, and retries only once',async()=>{
  const id=await fixture();await fixture('EMP-002');
  const file=workbook([['DEMO','EMP-001','','','2025-01-01','','','','Correct signed record'],['DEMO','EMP-002','','','','','UNKNOWN','','Correct grade'],['DEMO','MISSING','','','','','','','Unknown employee']]);
  const preview=await previewInformationUpload(ctx(),{name:'corrections.xlsx',content:file,operationKey:randomUUID()});expect(preview.plan.counts).toEqual({total:3,valid:1,invalid:2});
  const result=await confirmInformationUpload(ctx(),{attemptId:preview.attemptId,previewHash:preview.plan.previewHash});expect(result).toMatchObject({succeeded:1,failed:2,unchanged:0});
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0]).toMatchObject({hiredOn:'2025-01-01',gradeId:null});
  const again=await confirmInformationUpload(ctx(),{attemptId:preview.attemptId,previewHash:preview.plan.previewHash});expect(again).toEqual(result);expect(await informationCorrectionHistory(ctx(),id)).toHaveLength(1);
  const [history]=await informationCorrectionHistory(ctx(),id);expect(history.payload).toMatchObject({method:'excel',batchId:preview.attemptId,filename:'corrections.xlsx'});
 });
 it('refuses duplicate target rows, invalid reasons and formula cells at preview',async()=>{
  await fixture();const content=workbook([['DEMO','EMP-001','','','2025-01-01','','','','Correct record'],['DEMO','EMP-001','','','2025-01-02','','','','']]);
  const p=await previewInformationUpload(ctx(),{name:'duplicates.xlsx',content,operationKey:randomUUID()});expect(p.plan.counts.valid).toBe(0);expect(p.plan.rows.every(r=>r.errors.length>0)).toBe(true);
  const book=XLSX.read(content,{type:'buffer'});book.Sheets.Corrections.E2={t:'n',f:'1+1',v:2};const rows=parseInformationWorkbook(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));expect(rows[0].errors.join(' ')).toContain('formulas');
 });
 it('produces a usable blank template with live reference sheets',async()=>{
  const file=informationWorkbook(await informationCorrectionOptions(ctx()));const book=XLSX.read(file,{type:'array'});expect(book.SheetNames).toEqual(['Corrections','Instructions','Companies','Job Grades','Employment Types']);expect(book.Sheets.Companies.A2.v).toBe('DEMO');expect(book.Sheets.Corrections.I1.v).toBe('Correction Reason');
 });
 it('preserves leading zeros and accepts actual Excel dates; blank cells stay absent',()=>{
  const rows=parseInformationWorkbook(workbook([['DEMO','00001','','',45658,'','','','Correct record']]));expect(rows[0].employeeCode).toBe('00001');expect(rows[0].values['Group Join Date']).toBe('2025-01-01');expect(rows[0].values['Job Grade']).toBeUndefined();
 });
 it('serializes competing manual confirmations and records only the winning correction',async()=>{
  const id=await fixture(),reason='Correct verified record';const first={hiredOn:'2025-01-01'},second={hiredOn:'2025-01-02'};
  const a=await previewInformationCorrection(ctx(),{employmentId:id,changes:first,reason}),c=await previewInformationCorrection(ctx(),{employmentId:id,changes:second,reason});
  const outcomes=await Promise.allSettled([correctInformation(ctx(),{employmentId:id,changes:first,reason,fingerprint:a.fingerprint,method:'manual'}),correctInformation(ctx(),{employmentId:id,changes:second,reason,fingerprint:c.fingerprint,method:'manual'})]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);expect(await informationCorrectionHistory(ctx(),id)).toHaveLength(1);
 });
 it('rolls back every field of a failed Excel employee while retaining earlier successful rows',async()=>{
  const first=await fixture(),second=await fixture('EMP-002');const file=workbook([['DEMO','EMP-001','','','2025-01-01','','','','Correct first record'],['DEMO','EMP-002','','','2025-01-02','','','','Correct second record']]);
  const preview=await previewInformationUpload(ctx(),{name:'partial.xlsx',content:file,operationKey:randomUUID()});expect(preview.plan.counts.valid).toBe(2);
  await owner.db.update(schema.employment).set({orgBranch:'Changed after preview'}).where(eq(schema.employment.id,second));
  const result=await confirmInformationUpload(ctx(),{attemptId:preview.attemptId,previewHash:preview.plan.previewHash});expect(result).toMatchObject({succeeded:1,failed:1});
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,second)))[0].hiredOn).toBe('2025-01-15');expect(await informationCorrectionHistory(ctx(),second)).toHaveLength(0);expect(await informationCorrectionHistory(ctx(),first)).toHaveLength(1);
 });
 it('does not disclose a source/destination import plan to an administrator of only the source company',async()=>{
  const id=await fixture();const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Private destination',companyLabel:'DEST'}).returning();
  await assignLabelToCompanies(ctx(),{kind:'department',labelId:b.deptA,companyIds:[b.companyId,destination.id]});await assignLabelToCompanies(ctx(),{kind:'position',labelId:b.positionId,companyIds:[b.companyId,destination.id]});
  const preview=await previewInformationUpload(ctx(),{name:'companies.xlsx',content:workbook([['DEMO','EMP-001','','DEST','','','','','Correct source company']]),operationKey:randomUUID()});expect(preview.plan.counts.valid).toBe(1);
  const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id));const userId=await createAppUser(b.tenantId,emp.personId,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  const restricted={...ctx(),userId,personId:emp.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  expect(await getImportAttempt(restricted,preview.attemptId)).toBeNull();expect(await importAttemptSource(restricted,preview.attemptId)).toBeNull();
 });
 it('protects a later information decision from rollback of an earlier grade movement',async()=>{
  const id=await fixture();const [gradeA]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'G02',name:'Operational grade'}).returning();const [gradeB]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'G03',name:'Corrected grade'}).returning();
  await createMovementEvent(ctx(),{employmentId:id,kind:'promotion',effectiveDate:'2025-06-01',gradeId:gradeA.id});
  const movement=(await movementHistory(ctx(),id)).find(row=>row.kind==='promotion');expect(movement).toBeTruthy();
  await apply(id,{gradeId:gradeB.id});
  await expect(reverseMovementEvent(ctx(),{employmentId:id,movementId:movement!.id,reason:'Attempt an older rollback'})).rejects.toThrow('later information-only correction');
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0].gradeId).toBe(gradeB.id);
 });
 it('does not grant ordinary roles update or delete on retained snapshots',async()=>{
  const id=await fixture();await closedSlip(id);await apply(id,{hiredOn:'2025-01-01'});
  await expect(withTenant(ctx(),tx=>tx.execute(sql`delete from information_payslip_snapshot`))).rejects.toThrow();
 });
 it('reconciles verified legacy metadata atomically, dry-run first, without changing payroll',async()=>{
  const id=await fixture(),{slip}=await closedSlip(id);
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'LEGACY',name:'Later grade'}).returning();
  await setEmploymentGrade(ctx(),{employmentId:id,gradeId:grade.id});
  await expect(apply(id,{hiredOn:'2025-01-01'})).rejects.toThrow('reconcile the historical');
  const manifest={version:1 as const,tenantId:b.tenantId,actorUserId:ctx().userId!,verifiedOriginals:true as const,items:[{payslipId:slip.id,employmentId:id,companyId:b.companyId,original:{grade:null,employmentType:'full_time' as const,hiredOn:'2025-01-15',joinDate:null},evidence:[{path:'private-original.pdf',sha256:'a'.repeat(64),reference:'Reviewed original statement'}]}]};
  expect(await reconcileInformationSnapshots(owner,manifest)).toMatchObject({mode:'dry-run',missing:1});
  expect(await owner.db.select().from(schema.informationPayslipSnapshot)).toHaveLength(0);
  expect(await reconcileInformationSnapshots(owner,manifest,true)).toMatchObject({mode:'applied',missing:1});
  expect(await reconcileInformationSnapshots(owner,manifest,true)).toMatchObject({missing:0,alreadyPreserved:1});
  await expect(reconcileInformationSnapshots(owner,{...manifest,items:[{...manifest.items[0],original:{...manifest.items[0].original,grade:'Wrong'}}]},true)).rejects.toThrow('cannot be overwritten');
  await apply(id,{hiredOn:'2025-01-01'});
  expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,slip.id)))[0]).toEqual(slip);
  expect(await payslipForReview(ctx(),{companyIds:[b.companyId],payslipId:slip.id})).toMatchObject({jobGrade:null,employmentType:'full_time'});
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'employment.information.snapshot-reconciled'));
  expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('private-original.pdf');
 });

 it('blocks later historical leave sweeps and reprojections while allowing future processing',async()=>{
  const id=await fixture();await closedSlip(id);
  await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:id,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'9.00',effectiveOn:'2025-01-15'});
  await apply(id,{hiredOn:'2025-01-01'});
  const before=await owner.db.select().from(schema.leaveLedger);expect(before).toHaveLength(1);
  await expect(openLeaveYear(ctx(),{year:2025,employmentIds:[id]})).rejects.toThrow('Historical leave processing');
  await expect(accrueEarnedLeave(ctx(),{asOf:'2025-02-01',employmentIds:[id]})).rejects.toThrow('Historical leave processing');
  await expect(accrueEarnedLeave({tenantId:b.tenantId,roles:['hr_admin'],entitlementsExempt:'sweeps'},{asOf:'2025-02-01',employmentIds:[id]})).rejects.toThrow('Historical leave processing');
  await expect(reprojectEntitlementForEmployment(ctx(),{employmentId:id,asOf:'2025-02-01',trigger:'fixture'})).rejects.toThrow('Historical leave processing');
  expect(await owner.db.select().from(schema.leaveLedger)).toEqual(before);
  await expect(accrueEarnedLeave(ctx(),{asOf:todayInKualaLumpur(),employmentIds:[id],dryRun:true})).resolves.toBeTruthy();
 });

});
