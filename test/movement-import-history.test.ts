/**
 * ac6645ec — single-sheet Movement import on the shared import history (ADR-0152, ADR-0153): Company ID per
 * row, rows grouped into movements, Before checked, created movement ids recorded as items, and a whole
 * import reverted all or nothing through the Movement rollback. Real database and RLS, fictional fixtures.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createJobGrade,createPosition} from '../core/admin';
import {createMovementEvent,movementCurrentState,movementHistory} from '../core/movement';
import {previewMovementUpload,confirmMovementUpload} from '../core/movement-import-history';
import {getImportAttempt,listImportAttempts} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After'];
// The English catalogue, as the route's next-intl resolver supplies it.
const resolve=personnelImportLabelResolvers[0];
const file=(rows:string[][])=>Buffer.from(toCsv([HEADER,...rows]));
describe('single-sheet Movement import, history and revert (ac6645ec)',()=>{
 let b:Base,a:SessionContext,betaId:string,ac1:string,ac2:string,be1:string,junior:string,senior:string,seniorExec:string,acmeOnly:SessionContext,betaOnly:SessionContext;
 async function scopedAdmin(companyId:string,email:string):Promise<SessionContext>{
  const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:`Scoped ${email}`,primaryEmail:email}).returning();const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
  return{...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId}]};
 }
 const upload=(ctx:SessionContext,rows:string[][],name='movements.csv')=>previewMovementUpload(ctx,{name,content:file(rows),resolve});
 async function importRows(ctx:SessionContext,rows:string[][]){
  const checked=await upload(ctx,rows);
  const keys=checked.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
  const result=await confirmMovementUpload(ctx,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:keys,acknowledgeExcluded:true,resolve});
  return{checked,result};
 }
 const state=(id:string)=>movementCurrentState(a,id);
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();a=adminCtx(b);
  await owner.db.update(s.company).set({companyLabel:'ACME'}).where(eq(s.company.id,b.companyId));
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',companyLabel:'BETA',registrationNo:'202001000002'}).returning();betaId=beta.id;
  const[betaDept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:betaId,name:'Beta Finance'}).returning();
  junior=(await createJobGrade(a,{code:'JUNIOR',name:'Junior',rank:2})).id;senior=(await createJobGrade(a,{code:'SENIOR',name:'Senior',rank:1})).id;
  seniorExec=(await createPosition(a,{companyId:b.companyId,title:'Senior Executive'})).id;
  const hire=async(code:string,companyId:string,departmentId:string)=>{
   const id=(await hireEmployee(a,{person:{fullName:'Fictional '+code,primaryEmail:`${code.toLowerCase()}@example.test`},companyId,departmentId,positionId:companyId===b.companyId?b.positionId:undefined,employmentType:'full_time',hiredOn:day(-400),employeeCode:code})).employmentId;
   await owner.db.update(s.employment).set({gradeId:junior}).where(eq(s.employment.id,id));
   await setCompensation(a,{employmentId:id,basicSalary:3000,effectiveFrom:day(-400)});return id;
  };
  ac1=await hire('AC001',b.companyId,b.deptA);ac2=await hire('AC002',b.companyId,b.deptA);be1=await hire('BE001',betaId,betaDept.id);
  acmeOnly=await scopedAdmin(b.companyId,'acme-movement@example.test');betaOnly=await scopedAdmin(betaId,'beta-movement@example.test');
 });
 afterAll(closeAll);

 it('imports three field rows as ONE promotion, records its movement id, and a revert restores the prior values',async()=>{
  const date=day(-1);
  const{checked,result}=await importRows(a,[
   ['ACME','AC001','Fictional AC001',date,'promotion','gradeId','JUNIOR','SENIOR'],
   ['acme','AC001','',date,'promotion','positionId','Executive','Senior Executive'],
   ['ACME','AC001','',date,'promotion','basicSalary','3000.00','3500'],
  ]);
  expect(checked.preview.fileErrors).toEqual([]);
  expect(checked.preview.employees).toHaveLength(1);
  expect(checked.preview.employees[0].rows).toHaveLength(1);
  expect(checked.preview.employees[0].rows[0]).toMatchObject({status:'valid',sourceRows:[2,3,4]});
  expect(result).toMatchObject({imported:1,failed:0,alreadyCommitted:false});
  const after=await state(ac1);expect(after).toMatchObject({gradeId:senior,positionId:seniorExec,basicSalary:'3500.00'});
  const history=(await movementHistory(a,ac1)).filter(row=>row.kind==='promotion');expect(history).toHaveLength(1);
  const detail=(await getImportAttempt(a,checked.attemptId))!;
  expect(detail.items).toHaveLength(1);expect(detail.items[0]).toMatchObject({status:'applied',employmentId:ac1,companyId:b.companyId});
  expect((detail.items[0].after as {movementId:string}).movementId).toBe(history[0].id);
  expect(Object.keys((detail.items[0].after as {raw:Record<string,unknown>}).raw).sort()).toEqual(expect.arrayContaining(['basicSalary','gradeId','positionId']));
  const review=await previewImportRevertForAttempt(a,checked.attemptId);expect(review.eligible).toBe(true);expect(review.blockers).toEqual([]);
  await revertImportForAttempt(a,checked.attemptId,{previewHash:review.previewHash,reason:'Fictional wrong promotion batch'});
  expect(await state(ac1)).toMatchObject({gradeId:junior,positionId:b.positionId,basicSalary:'3000.00'});
  const reverted=(await movementHistory(a,ac1)).find(row=>row.id===history[0].id)!;
  expect(reverted.reversed).toMatchObject({reason:'Fictional wrong promotion batch'});
  await expect(previewImportRevertForAttempt(a,checked.attemptId)).rejects.toThrow(/already been reverted/);
  await expect(revertImportForAttempt(a,checked.attemptId,{previewHash:review.previewHash,reason:'Fictional second try'})).rejects.toThrow(/already been reverted/);
 });

 it('resolves Company ID per row: mixed rights, unknown and ambiguous companies are row errors while permitted rows proceed',async()=>{
  await owner.db.insert(s.company).values([{tenantId:b.tenantId,legalName:'Dup One Fictional',companyLabel:'DUP'},{tenantId:b.tenantId,legalName:'Dup Two Fictional',registrationNo:'DUP'}]);
  const date=day(-1);
  const checked=await upload(acmeOnly,[
   ['ACME','AC001','',date,'transfer','departmentId','Finance','Operations'],
   ['BETA','BE001','',date,'transfer','departmentId','',' Beta Finance'],
   ['NOPE','AC002','',date,'transfer','departmentId','','Operations'],
  ]);
  const byCode=Object.fromEntries(checked.preview.employees.map(e=>[e.employeeCode,e]));
  expect(byCode.AC001.rows[0].status).toBe('valid');expect(byCode.AC001.companyId).toBe(b.companyId);
  expect(byCode.BE001.rows[0]).toMatchObject({status:'invalid',errors:['company_unknown']});
  expect(byCode.AC002.rows[0]).toMatchObject({status:'invalid',errors:['company_unknown']});
  const ambiguous=await upload(a,[['DUP','AC001','',date,'transfer','departmentId','','Operations']]);
  expect(ambiguous.preview.employees[0].rows[0].errors).toEqual(['company_ambiguous']);
  // The same Employee ID in another company is another employee: matched only within the row's company.
  const wrongCompany=await upload(a,[['BETA','AC001','',date,'transfer','departmentId','','Beta Finance']]);
  expect(wrongCompany.preview.employees[0].rows[0].status).toBe('invalid');
  const result=await confirmMovementUpload(acmeOnly,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:[byCode.AC001.key!],acknowledgeExcluded:true,resolve});
  expect(result).toMatchObject({imported:1});expect((await state(ac1)).departmentId).toBe(b.deptB);
  const detail=(await getImportAttempt(acmeOnly,checked.attemptId))!;
  expect(detail.companyIds).toEqual([b.companyId]);
  expect(detail.events.find(e=>e.kind==='confirmed')?.detail).toMatchObject({succeeded:1,failed:2});
 });

 it('stops an employee whose Before no longer matches, and imports the other employees',async()=>{
  const date=day(-1);
  const checked=await upload(a,[
   ['ACME','AC001','',date,'transfer','departmentId','Operations','Operations'],
   ['ACME','AC001','',day(0),'reportingLineChange','managerEmploymentId','','AC002'],
   ['ACME','AC002','',date,'transfer','departmentId','Finance','Operations'],
  ]);
  const byCode=Object.fromEntries(checked.preview.employees.map(e=>[e.employeeCode,e]));
  expect(byCode.AC001.fingerprint).toBeNull();
  expect(byCode.AC001.rows.flatMap(r=>r.errors)).toEqual(expect.arrayContaining(['before_mismatch:departmentId','employee_sequence_invalid']));
  expect(byCode.AC002.rows[0].status).toBe('valid');
  const result=await confirmMovementUpload(a,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:[byCode.AC002.key!],acknowledgeExcluded:true,resolve});
  expect(result.imported).toBe(1);expect((await state(ac1)).departmentId).toBe(b.deptA);expect((await state(ac2)).departmentId).toBe(b.deptB);
  await expect(confirmMovementUpload(a,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:[byCode.AC001.key!],acknowledgeExcluded:true,resolve})).resolves.toMatchObject({alreadyCommitted:true});
 });

 it('refuses the whole revert when a later movement changed a field, and changes nothing',async()=>{
  const date=day(-3);
  const{checked}=await importRows(a,[['ACME','AC001','',date,'transfer','departmentId','Finance','Operations'],['ACME','AC002','',date,'transfer','departmentId','Finance','Operations']]);
  await createMovementEvent(a,{employmentId:ac1,kind:'transfer',effectiveDate:day(-1),departmentId:b.deptA});
  const review=await previewImportRevertForAttempt(a,checked.attemptId);
  expect(review.eligible).toBe(false);expect(review.blockers).toHaveLength(1);expect(review.blockers[0].reason).toMatch(/changed since this import/);
  await expect(revertImportForAttempt(a,checked.attemptId,{previewHash:review.previewHash,reason:'Fictional revert attempt'})).rejects.toThrow(/cannot be reverted/);
  expect((await state(ac2)).departmentId).toBe(b.deptB);
  const detail=(await getImportAttempt(a,checked.attemptId))!;expect(detail.events.at(-1)?.kind).toBe('revert_failed');
 });

 it('refuses the revert when a closed payroll relied on a movement, or the movement type cannot be rolled back',async()=>{
  const effective=day(-2),period=effective.slice(0,7);
  const{checked}=await importRows(a,[['ACME','AC001','',effective,'transfer','departmentId','Finance','Operations']]);
  const[pp]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning({id:s.payPeriod.id});
  const[batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:pp.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning({id:s.payrollBatch.id});
  await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:ac1,basicSalary:'3000.00',grossPay:'3000.00',statutory:{},totalDeductions:'0.00',netPay:'3000.00',employerCost:'3000.00'});
  const closed=await previewImportRevertForAttempt(a,checked.attemptId);
  expect(closed.eligible).toBe(false);expect(closed.blockers[0].reason).toMatch(/closed payroll/);
  const joinDate=day(-30);
  const{checked:join,result}=await importRows(a,[['ACME','AC002','',joinDate,'joinDateChange','remarks','','Fictional join date correction']]);
  expect(result.imported).toBe(1);
  const review=await previewImportRevertForAttempt(a,join.attemptId);
  expect(review.eligible).toBe(false);expect(review.blockers[0].reason).toMatch(/cannot be rolled back/);
 });

 it('keeps another company\'s import out of sight and out of reach of a company-scoped administrator',async()=>{
  const{checked}=await importRows(a,[['ACME','AC001','',day(-1),'transfer','departmentId','Finance','Operations']]);
  expect((await listImportAttempts(betaOnly,{kind:'movement'})).items.map(i=>i.id)).not.toContain(checked.attemptId);
  expect(await getImportAttempt(betaOnly,checked.attemptId)).toBeNull();
  await expect(previewImportRevertForAttempt(betaOnly,checked.attemptId)).rejects.toThrow();
  expect((await listImportAttempts(acmeOnly,{kind:'movement'})).items.map(i=>i.id)).toContain(checked.attemptId);
  expect((await state(ac1)).departmentId).toBe(b.deptB);
  const items=await owner.db.select().from(s.importAttemptItem).where(and(eq(s.importAttemptItem.attemptId,checked.attemptId),eq(s.importAttemptItem.status,'applied')));expect(items).toHaveLength(1);
 });

 it('refuses the retired per-type layout with a message to download the new template',async()=>{
  const old=Buffer.from(toCsv([['Employee ID','Increment Amount','Effective Date'],['AC001','100',day(-1)]]));
  const checked=await previewMovementUpload(a,{name:'old.csv',content:old,resolve});
  expect(checked.preview.fileErrors).toEqual(['workbook_old_layout']);
  const detail=(await getImportAttempt(a,checked.attemptId))!;expect(detail.plan.issues[0].reason).toMatch(/Download the new template/);
 });
});
