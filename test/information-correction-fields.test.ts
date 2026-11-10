/** ccd3a65c — further Information-Only Correction fields through their owners, and Import History / Import Log.
 * Fictional fixtures only. */
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import * as XLSX from 'xlsx';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setReportingLine} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import * as schema from '../db/schema';
import {previewInformationCorrection,informationCorrectionHistory} from '../core/information-correction';
import {previewInformationUpload,confirmInformationUpload,informationImportLog} from '../core/information-correction-import';
import {getImportAttempt,getImportRun,listImportHistory} from '../core/import-history';
import {accrueEarnedLeave} from '../core/leave';
import {payslipForReview} from '../core/payroll-view';
import {INFORMATION_HEADERS_V2,type InformationHeader} from '../lib/information-correction';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base;
beforeAll(()=>migrateTestDb());
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.update(schema.company).set({companyLabel:'DEMO'}).where(eq(schema.company.id,b.companyId));});
afterAll(()=>closeAll());
const ctx=()=>adminCtx(b);
async function fixture(code:string,companyId=b.companyId){
 const hired=await hireEmployee(ctx(),{person:{fullName:'Fixture '+code,primaryEmail:randomUUID()+'@example.test'},companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2025-01-15'});
 await owner.db.update(schema.employment).set({employeeCode:code}).where(eq(schema.employment.id,hired.employmentId));return hired.employmentId;
}
const row=(cells:Partial<Record<InformationHeader,unknown>>)=>INFORMATION_HEADERS_V2.map(header=>cells[header]??'');
function workbook(rows:Partial<Record<InformationHeader,unknown>>[]){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[...INFORMATION_HEADERS_V2],...rows.map(row)]),'Corrections');return XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;}
const upload=(rows:Partial<Record<InformationHeader,unknown>>[],c=ctx())=>previewInformationUpload(c,{name:'corrections-v2.xlsx',content:workbook(rows),operationKey:randomUUID()});
const employment=async(id:string)=>(await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0];
const currentAssignment=async(id:string)=>(await owner.db.select().from(schema.assignment).where(and(eq(schema.assignment.employmentId,id)))).find(a=>a.validTo===null&&!a.supersededAt)!;
const openLine=async(id:string)=>(await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.subordinateEmploymentId,id))).filter(l=>l.lineType==='administrative'&&l.validTo===null&&!l.supersededAt);
async function closedSlip(employmentId:string){
 const [period]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2025-01',status:'closed'}).returning();
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2025-01',batchDate:'2025-01-25',status:'closed',releasedAt:new Date('2025-01-25T00:00:00Z')}).returning();
 const [slip]=await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'3000.00',grossPay:'3000.00',statutory:{epfEmployee:330,epfEmployer:390,pcb:10},totalDeductions:'340.00',netPay:'2660.00',employerCost:'3390.00'}).returning();return slip;
}
const reason='Keyed in wrong at hire';

describe('ccd3a65c further Information-Only Correction fields',()=>{
 it('corrects department, labels, periods, confirmation and superior through their owners without a movement row',async()=>{
  const id=await fixture('E0012'),manager=await fixture('E0047');
  await owner.db.insert(schema.profileOption).values({tenantId:b.tenantId,category:'branch',value:'KL',label:'Kuala Lumpur'});
  const slip=await closedSlip(id);
  const reviewBefore=await payslipForReview(ctx(),{companyIds:[b.companyId],payslipId:slip.id});expect(reviewBefore).toBeTruthy();
  const historyBefore=await movementHistory(ctx(),id);expect(historyBefore.length).toBeGreaterThan(0);
  const before=await employment(id),assignmentBefore=await currentAssignment(id);
  const preview=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Department':'Operations','Branch':'KL','Notice Before Confirmation':2,'Notice Before Confirmation Unit':'Week','Direct Superior':'E0047','Correction Reason':reason}]);
  expect(preview.plan.rows[0].errors).toEqual([]);
  expect(preview.plan.counts).toEqual({total:1,valid:1,invalid:0});
  expect(preview.plan.rows[0].preview?.changed.sort()).toEqual(['departmentId','managerEmploymentId','noticeBeforeConfirmationUnit','noticeBeforeConfirmationValue','orgBranch'].sort());
  expect(preview.plan.rows[0].preview?.afterLabels).toMatchObject({departmentId:'Operations',orgBranch:'KL',noticeBeforeConfirmationUnit:'Week',managerEmploymentId:'E0047 · Fixture E0047'});
  // The preview rehearsal rolled back: nothing changed yet.
  expect(await employment(id)).toEqual(before);expect(await openLine(id)).toHaveLength(0);
  const result=await confirmInformationUpload(ctx(),{attemptId:preview.attemptId,previewHash:preview.plan.previewHash});
  expect(result).toMatchObject({succeeded:1,failed:0});
  const after=await employment(id);
  expect(after).toMatchObject({orgBranch:'KL',noticeBeforeConfirmationValue:2,noticeBeforeConfirmationUnit:'week',confirmationDate:before.confirmationDate,hiredOn:before.hiredOn});
  const assignmentAfter=await currentAssignment(id);
  expect(assignmentAfter).toMatchObject({departmentId:b.deptB,positionId:assignmentBefore.positionId,validFrom:todayInKualaLumpur()});
  expect((await openLine(id)).map(line=>({manager:line.managerEmploymentId,from:line.validFrom}))).toEqual([{manager,from:todayInKualaLumpur()}]);
  // No Employment History row is projected and the existing order is unchanged.
  expect((await movementHistory(ctx(),id)).map(r=>r.id)).toEqual(historyBefore.map(r=>r.id));
  const [event]=await informationCorrectionHistory(ctx(),id);
  expect(event.actorId).toBe(ctx().userId);
  expect(event.payload).toMatchObject({method:'excel',batchId:preview.attemptId,filename:'corrections-v2.xlsx',reason,before:{departmentId:b.deptA,orgBranch:null,managerEmploymentId:null},after:{departmentId:b.deptB,orgBranch:'KL',managerEmploymentId:manager}});
  // The owners recorded their own untagged events in the same transaction.
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId,id));
  const info=events.filter(e=>e.eventType==='employment.info.updated').at(-1)!;expect((info.payload as {fields:string[]}).fields).toEqual(expect.arrayContaining(['orgBranch','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit']));expect(info.payload).not.toHaveProperty('movement');
  const line=events.filter(e=>e.eventType==='reporting-line.set').at(-1)!;expect(line.payload).not.toHaveProperty('movement');
  // Finalized payroll keeps its document baseline.
  expect(await payslipForReview(ctx(),{companyIds:[b.companyId],payslipId:slip.id})).toEqual(reviewBefore);
 });
 it('keeps values for blank cells and refuses each invalid field naming its column',async()=>{
  const id=await fixture('E0012'),other=await fixture('E0051');
  await owner.db.insert(schema.profileOption).values({tenantId:b.tenantId,category:'branch',value:'KL',label:'Kuala Lumpur'});
  const [elsewhere]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other Sdn Bhd',companyLabel:'OTHER'}).returning();
  await fixture('E0900',elsewhere.id);
  const testManager=await fixture('E0063');await owner.db.update(schema.employment).set({isTestRecord:true}).where(eq(schema.employment.id,testManager));
  await setReportingLine(ctx(),{subordinateEmploymentId:other,managerEmploymentId:id,lineType:'administrative',validFrom:'2025-01-15'});
  const before=await employment(id);
  const preview=await upload([
   {'Company Code':'DEMO','Employee ID':'E0012','Department':'Marketing','Correction Reason':reason},
   {'Company Code':'DEMO','Employee ID':'E0051','Branch':'Penang 2','Correction Reason':reason},
   {'Company Code':'DEMO','Employee ID':'E0063','Direct Superior':'E0063','Correction Reason':reason},
  ]);
  expect(preview.plan.rows[0].errors.join(' ')).toContain('Department: "Marketing" is not an option for this company');
  expect(preview.plan.rows[1].errors).toEqual([expect.stringMatching(/^Branch: "Penang 2" is not an active Branch option/)]);
  expect(preview.plan.rows[2].errors).toEqual(['Direct Superior: an employee cannot report to themselves.']);
  const cycle=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Direct Superior':'E0051','Correction Reason':reason}]);
  expect(cycle.plan.rows[0].errors).toEqual(['Direct Superior: this would create a reporting loop.']);
  const scoped=await upload([{'Company Code':'DEMO','Employee ID':'E0051','Direct Superior':'E0900','Correction Reason':reason}]);
  expect(scoped.plan.rows[0].errors).toEqual(['Direct Superior: the Employee ID is unknown in this company or not visible to you.']);
  const marked=await upload([{'Company Code':'DEMO','Employee ID':'E0051','Direct Superior':'E0063','Correction Reason':reason}]);
  expect(marked.plan.rows[0].errors).toEqual([expect.stringMatching(/^Direct Superior: (a test record cannot be a Direct Superior|the Employee ID is unknown in this company or not visible to you)\.$/)]);
  expect((await openLine(other)).map(line=>line.managerEmploymentId)).toEqual([id]);
  const unit=await upload([{'Company Code':'DEMO','Employee ID':'E0051','Probation Period':3,'Probation Period Unit':'Year','Correction Reason':reason}]);
  expect(unit.plan.rows[0].errors).toEqual(['Probation Period Unit: use Month, Week or Day.']);
  // A blank cell keeps what is there: an Excel row correcting only the branch leaves everything else alone.
  const ok=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Branch':'KL','Correction Reason':reason}]);
  expect(ok.plan.rows[0].preview?.changed).toEqual(['orgBranch']);
  await confirmInformationUpload(ctx(),{attemptId:ok.attemptId,previewHash:ok.plan.previewHash});
  expect(await employment(id)).toEqual({...before,orgBranch:'KL'});
 });
 it('writes Confirmation Date through the employment owner, which derives the final confirmation date',async()=>{
  const id=await fixture('E0012');
  const preview=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Confirmation Date':'2025-04-15','Correction Reason':reason}]);
  expect(preview.plan.rows[0].errors).toEqual([]);
  await confirmInformationUpload(ctx(),{attemptId:preview.attemptId,previewHash:preview.plan.previewHash});
  expect(await employment(id)).toMatchObject({confirmationDate:'2025-04-15',finalConfirmationDate:'2025-04-15'});
  const early=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Confirmation Date':'2025-01-01','Correction Reason':reason}]);
  expect(early.plan.rows[0].errors).toEqual(['Confirmation Date: cannot be earlier than the Group Join Date.']);
 });
 it('refuses a Confirmation Date that would change who was on probation in a closed payroll month',async()=>{
  const id=await fixture('E0012');await closedSlip(id);
  const preview=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Confirmation Date':'2025-03-01','Correction Reason':reason}]);
  expect(preview.plan.rows[0].errors).toEqual([expect.stringMatching(/^Confirmation Date: A closed payroll run relied on this date/)]);
  expect((await employment(id)).confirmationDate).toBeNull();
 });
 it('keeps Basic Salary, the resignation dates and Payment Method outside the template',()=>{
  for(const excluded of ['Basic Salary','Tender Resignation Date','Resignation Date','Last Working Date','Payment Method'])expect(INFORMATION_HEADERS_V2 as readonly string[]).not.toContain(excluded);
 });
 it('keeps the single-employee correction to its five facts',async()=>{
  const id=await fixture('E0012');
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{orgBranch:'KL'},reason})).rejects.toThrow('Use the Information-Only Correction template');
 });
 it('lets leave processing continue after a notice-only correction but not after a department correction',async()=>{
  const id=await fixture('E0012');
  const notice=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Notice After Confirmation':1,'Notice After Confirmation Unit':'Month','Correction Reason':reason}]);
  await confirmInformationUpload(ctx(),{attemptId:notice.attemptId,previewHash:notice.plan.previewHash});
  const allowed=await accrueEarnedLeave(ctx(),{asOf:'2025-02-01',employmentIds:[id]}).then(()=>null,(error:Error)=>error.message);
  expect(allowed??'').not.toContain('Historical leave processing');
  const dept=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Department':'Operations','Correction Reason':reason}]);
  await confirmInformationUpload(ctx(),{attemptId:dept.attemptId,previewHash:dept.plan.previewHash});
  await expect(accrueEarnedLeave(ctx(),{asOf:'2025-02-01',employmentIds:[id]})).rejects.toThrow('Historical leave processing');
 });
 it('protects a department correction from rollback of an earlier transfer',async()=>{
  const id=await fixture('E0012');
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2025-06-01',departmentId:b.deptB});
  const transfer=(await movementHistory(ctx(),id)).find(r=>r.kind==='transfer');expect(transfer).toBeTruthy();
  const fix=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Department':'Finance','Correction Reason':reason}]);
  expect(fix.plan.rows[0].errors).toEqual([]);
  await confirmInformationUpload(ctx(),{attemptId:fix.attemptId,previewHash:fix.plan.previewHash});
  await expect(reverseMovementEvent(ctx(),{employmentId:id,movementId:transfer!.id,reason:'Attempt an older rollback'})).rejects.toThrow('later information-only correction');
  expect((await currentAssignment(id)).departmentId).toBe(b.deptA);
 });
 it('keeps another company and another tenant out',async()=>{
  const id=await fixture('E0012');
  const [elsewhere]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other Sdn Bhd',companyLabel:'OTHER'}).returning();
  await fixture('E0900',elsewhere.id);
  const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id));
  const userId=await createAppUser(b.tenantId,emp.personId,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  const restricted={...ctx(),userId,personId:emp.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const refused=await upload([{'Company Code':'OTHER','Employee ID':'E0900','Branch':'KL','Correction Reason':reason}],restricted);
  expect(refused.plan.rows[0].errors).toEqual(['Company Code is unknown, ambiguous or outside your permission.']);
  await expect(upload([{'Company Code':'DEMO','Employee ID':'E0012','Branch':'KL','Correction Reason':reason}],{...ctx(),tenantId:randomUUID()})).rejects.toThrow();
 });
});

describe('ccd3a65c Import History and Import Log',()=>{
 async function run(values:Partial<typeof schema.employeeImportRun.$inferInsert>){
  const [row]=await owner.db.insert(schema.employeeImportRun).values({tenantId:b.tenantId,companyId:b.companyId,createdByUserId:ctx().userId,fileName:'run.xlsx',totalRows:5,importedRows:4,failedRows:1,errors:[{rowNum:3,fullName:'Fixture E0051',email:'',errors:['Unknown state']}],...values}).returning();return row;
 }
 it('lists section runs with their type beside attempts, without duplicating full imports',async()=>{
  const profile=await run({importSection:'profile',fileName:'profile-update.xlsx',createdAt:new Date(Date.now()-3000)});
  await run({importSection:'full',fileName:'new-hires.xlsx'});
  await run({importSection:'bank_statutory',fileName:'bank.xlsx'});
  const legacy=await run({importSection:null,fileName:'old.xlsx',createdAt:new Date(Date.now()-6000)});
  await fixture('E0012');
  const attempt=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Department':'Operations','Correction Reason':reason},{'Company Code':'DEMO','Employee ID':'E9999','Correction Reason':reason}]);
  const all=await listImportHistory(ctx());
  expect(all.items.map(item=>[item.source,item.kind,item.sourceName])).toEqual([['attempt','information_correction','corrections-v2.xlsx'],['run','profile','profile-update.xlsx'],['run',null,'old.xlsx']]);
  expect(all.items[0]).toMatchObject({id:attempt.attemptId,total:2,successful:0,failed:1,status:'validated'});
  expect(all.items[1]).toMatchObject({id:profile.id,total:5,successful:4,failed:1,status:'partial',companies:['DEMO · Acme Sdn Bhd']});
  expect(all.items[2].id).toBe(legacy.id);
  expect((await listImportHistory(ctx(),{kind:'profile'})).items.map(item=>item.id)).toEqual([profile.id]);
  expect((await listImportHistory(ctx(),{kind:'information_correction'})).items.map(item=>item.id)).toEqual([attempt.attemptId]);
  // One stable cursor across both sources.
  const first=await listImportHistory(ctx(),{limit:1});expect(first.nextCursor).toBe('a.'+attempt.attemptId);
  const second=await listImportHistory(ctx(),{limit:1,before:first.nextCursor!});expect(second.items.map(item=>item.id)).toEqual([profile.id]);
  const third=await listImportHistory(ctx(),{limit:5,before:second.nextCursor!});expect(third.items.map(item=>item.id)).toEqual([legacy.id]);expect(third.nextCursor).toBeNull();
  const detail=await getImportRun(ctx(),profile.id);expect(detail).toMatchObject({kind:'profile',status:'partial',errors:[{rowNum:3,errors:['Unknown state']}]});
 });
 it('filters section runs by the viewer\'s company access and refuses employees and other tenants',async()=>{
  const id=await fixture('E0012');
  const [elsewhere]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other Sdn Bhd',companyLabel:'OTHER'}).returning();
  const mine=await run({importSection:'family'}),theirs=await run({importSection:'family',companyId:elsewhere.id}),registry=await run({importSection:'emergency',companyId:null});
  const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id));
  const userId=await createAppUser(b.tenantId,emp.personId,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  const restricted={...ctx(),userId,personId:emp.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  expect((await listImportHistory(restricted)).items.map(item=>item.id)).toEqual([mine.id]);
  expect(await getImportRun(restricted,theirs.id)).toBeNull();expect(await getImportRun(restricted,registry.id)).toBeNull();
  expect((await listImportHistory(ctx())).items.map(item=>item.id).sort()).toEqual([mine.id,theirs.id,registry.id].sort());
  const employeeCtx={...restricted,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  expect(await listImportHistory(employeeCtx).then(r=>r.items,()=>[])).toEqual([]);
  expect(await listImportHistory({...ctx(),tenantId:randomUUID()}).then(r=>r.items,()=>[])).toEqual([]);
 });
 it('logs every row of an Information-Only Correction file, including rows refused at the check',async()=>{
  await fixture('E0012');
  const attempt=await upload([{'Company Code':'DEMO','Employee ID':'E0012','Department':'Operations','Correction Reason':reason},{'Company Code':'DEMO','Employee ID':'E0230','Correction Reason':'Verify branch'}]);
  await confirmInformationUpload(ctx(),{attemptId:attempt.attemptId,previewHash:attempt.plan.previewHash});
  const item=(await getImportAttempt(ctx(),attempt.attemptId))!;
  const log=await informationImportLog(ctx(),item);
  expect(log).toEqual([
   {row:2,employeeCode:'E0012',name:'Fixture E0012',result:'saved',changes:[{field:'departmentId',before:'Finance',after:'Operations'}],reason,errors:[]},
   {row:3,employeeCode:'E0230',name:null,result:'not_saved',changes:[],reason:'Verify branch',errors:['Employee ID is unknown or ambiguous within the existing company.']},
  ]);
 });
});
