import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentPaymentMethod} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips} from '../packs/payroll/service';
import {upsertCompanyBankProfile} from '../core/bank-profile';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {ocbcBankPaymentFiles} from '../localization/my/ocbc-payment';
import {appUser,bankPaymentExport,companyBankProfile,companyStatutoryAuthority,companyStatutoryMy,employeeStatutoryMy,payrollBatch,payslip} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {BankPaymentRequest} from '../localization/country-pack';
describe('OCBC immutable generated bank artifacts',()=>{
 let b:Base;const day=todayInKualaLumpur(),period=day.slice(0,7),start=day.slice(0,4)+'-01-01';
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
 async function fixture(){const ctx=adminCtx(b);
  const employee=await hireEmployee(ctx,{person:{fullName:'FICTIONAL PERSON',primaryEmail:'ocbc-fixture@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:1000,monthlyAllowance:0,effectiveFrom:start});
  await setStatutoryProfileMY(ctx,{personId:employee.personId,icNumber:'900101011234',epfNumber:'123456',bankName:'Maybank',bankAccountNo:'123456789012'});
  await setEmploymentPaymentMethod(ctx,{employmentId:employee.employmentId,paymentMethod:'bank_transfer'});
  const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:period});await generatePayslips(ctx,{batchId});
  const profile=await upsertCompanyBankProfile(ctx,{companyId:b.companyId,bank:'ocbc_bank',corporateId:'A999999',debitAccountNo:'1234567890',orgName:'FICTIONAL COMPANY',branch:'00701',fileContactName:'FICTIONAL CONTACT',fileContactPhone:'0312345678',fileStateCode:'014'});
  const request:BankPaymentRequest={companyId:b.companyId,bankProfileId:profile.id,formatId:'my.ocbc.salary',periodKey:period,paymentDate:day,runSeq:1,testFile:false,reference:'PAYROLL'};
  return {ctx,request,batchId,employee};
 }
 it('preview writes nothing; repeated download is the same artifact and sequence',async()=>{
  const {ctx,request}=await fixture(),preview=await ocbcBankPaymentFiles.preview(ctx,request);
  expect(preview.recordCount).toBe(1);expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(0);
  const input={...request,expectedDigest:preview.digest,requestKey:randomUUID()},one=await ocbcBankPaymentFiles.download(ctx,input),two=await ocbcBankPaymentFiles.download(ctx,input);
  expect(two).toEqual(one);const rows=await owner.db.select().from(bankPaymentExport).orderBy(bankPaymentExport.tapeId);expect(rows).toHaveLength(1);expect(rows[0].tapeId).toBe(1);expect(rows[0].content).toBe(one.content);expect(rows[0].totalCents).toBe(preview.totalCents);
 });
 it('separate requests atomically reserve distinct value-date tapes',async()=>{
  const {ctx,request}=await fixture(),preview=await ocbcBankPaymentFiles.preview(ctx,request);
  const files=await Promise.all([1,2].map(()=>ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()})));
  expect(new Set(files.map(f=>f.filename)).size).toBe(2);const rows=await owner.db.select().from(bankPaymentExport).orderBy(bankPaymentExport.tapeId);expect(rows.map(r=>r.tapeId)).toEqual([1,2]);
 });
 it('refuses stale bank details with no artifact or money state change',async()=>{
  const {ctx,request,batchId}=await fixture(),preview=await ocbcBankPaymentFiles.preview(ctx,request);
  await owner.db.update(companyBankProfile).set({orgName:'CHANGED BANK NAME'}).where(eq(companyBankProfile.id,request.bankProfileId));
  await expect(ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()})).rejects.toMatchObject({status:409});expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(0);
  const [batch]=await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batchId));expect(batch.status).toBe('processed');
 });
 it('refuses missing or wrong run, stale payroll and cross-tenant callers',async()=>{
  const {ctx,request,batchId}=await fixture();await expect(ocbcBankPaymentFiles.preview(ctx,{...request,runSeq:undefined})).rejects.toThrow(/exactly one/);await expect(ocbcBankPaymentFiles.preview(ctx,{...request,runSeq:99})).rejects.toThrow(/ready payroll/);
  await expect(ocbcBankPaymentFiles.preview({...ctx,tenantId:randomUUID()},request)).rejects.toThrow();
  await owner.db.update(payrollBatch).set({needsRecalcAt:new Date()}).where(eq(payrollBatch.id,batchId));await expect(ocbcBankPaymentFiles.preview(ctx,request)).rejects.toThrow(/Recalculate/);
 });
 it('rejects an unapproved Tax Number suffix rather than guessing the Wife Code',async()=>{const {ctx,request,batchId,employee}=await fixture();await owner.db.update(payslip).set({statutory:{pcb:10,cp38:5}}).where(eq(payslip.batchId,batchId));await owner.db.update(employeeStatutoryMy).set({taxNumber:'IG10234567092'}).where(eq(employeeStatutoryMy.personId,employee.personId));const {runSeq:_run,...monthly}=request;await expect(ocbcBankPaymentFiles.preview(ctx,{...monthly,formatId:'my.ocbc.lhdn'})).rejects.toThrow(/Tax Number must end in 0 or 1/);});
 it('reserves unique tenant/date tapes for concurrent different administrators',async()=>{
  const {ctx,request}=await fixture();const [other]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:appUser.id});
  const second={...ctx,userId:other.id},preview=await ocbcBankPaymentFiles.preview(ctx,request),requestKey=randomUUID();
  const files=await Promise.all([ctx,second].map(c=>ocbcBankPaymentFiles.download(c,{...request,expectedDigest:preview.digest,requestKey})));
  expect(new Set(files.map(f=>f.filename)).size).toBe(2);const rows=await owner.db.select().from(bankPaymentExport).orderBy(bankPaymentExport.tapeId);expect(rows.map(r=>r.tapeId)).toEqual([1,2]);expect(new Set(rows.map(r=>r.actorUserId)).size).toBe(2);
  const own=await withTenant(ctx,tx=>tx.select().from(bankPaymentExport));expect(own).toHaveLength(1);expect(own[0].actorUserId).toBe(ctx.userId);
 });
 it('denies direct counter mutation, nonadmin allocation and foreign-company allocation',async()=>{
  const {ctx,request}=await fixture();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from bank_payment_sequence`))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`insert into bank_payment_sequence(tenant_id,value_date,tape_id) values(${b.tenantId}::uuid,${day}::date,1)`))).rejects.toThrow();
  await expect(withTenant({...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]},tx=>tx.execute(sql`select app.next_bank_payment_tape(${request.companyId}::uuid,${day}::date)`))).rejects.toThrow();
  const preview=await ocbcBankPaymentFiles.preview(ctx,request);await ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()});const [saved]=await owner.db.select().from(bankPaymentExport);
  await expect(withTenant(ctx,tx=>tx.update(bankPaymentExport).set({content:'altered'}).where(eq(bankPaymentExport.id,saved.id)))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.delete(bankPaymentExport).where(eq(bankPaymentExport.id,saved.id)))).rejects.toThrow();
  const foreign=await seedBase();
  await expect(withTenant(ctx,tx=>tx.insert(bankPaymentExport).values({...saved,id:randomUUID(),companyId:foreign.companyId,tapeId:2,requestKey:randomUUID()}))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.next_bank_payment_tape(${foreign.companyId}::uuid,${day}::date)`))).rejects.toThrow();
  await expect(withTenant({...ctx,tenantId:foreign.tenantId},tx=>tx.execute(sql`select app.next_bank_payment_tape(${request.companyId}::uuid,${day}::date)`))).rejects.toThrow();
  await expect(withTenant({...ctx,tenantId:foreign.tenantId},tx=>tx.execute(sql`select app.next_bank_payment_tape(${foreign.companyId}::uuid,${day}::date)`))).rejects.toThrow();
 });
 it('exhausts at999 without an artifact or counter change, and rolls reservations back',async()=>{
  const {ctx,request}=await fixture(),preview=await ocbcBankPaymentFiles.preview(ctx,request);
  await owner.db.execute(sql`insert into bank_payment_sequence(tenant_id,value_date,tape_id) values(${b.tenantId}::uuid,${day}::date,999)`);
  await expect(ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()})).rejects.toThrow(/999/);
  const sequence=await owner.db.execute<{tape_id:number}>(sql`select tape_id from bank_payment_sequence where tenant_id=${b.tenantId}::uuid`);expect(sequence[0].tape_id).toBe(999);expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(0);
  const nextDay=day.slice(0,8)+'01';if(nextDay===day)return;
  await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select app.next_bank_payment_tape(${b.companyId}::uuid,${nextDay}::date)`);throw Error('rollback reservation');})).rejects.toThrow('rollback reservation');
  expect(await owner.db.execute(sql`select * from bank_payment_sequence where tenant_id=${b.tenantId}::uuid and value_date=${nextDay}::date`)).toHaveLength(0);
 });
 it('aggregates saved monthly KWSP and SOCSO deltas, without EIS or duplicated monthly wages',async()=>{
  const {ctx,request,batchId,employee}=await fixture();const [batch]=await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batchId));
  const [slip]=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId));
  const secondId=randomUUID();await owner.db.insert(payrollBatch).values({...batch,id:secondId,runSeq:2,runType:'bonus'});
  const first={epfEmployee:110,epfEmployer:130,socsoEmployee:4.95,socsoEmployer:17.35,eisEmployee:2,eisEmployer:2,bases:{epf:1000,epfAdditional:0,socsoEis:1000}};
  await owner.db.update(payslip).set({statutory:first}).where(eq(payslip.id,slip.id));
  await owner.db.insert(payslip).values({...slip,id:randomUUID(),batchId:secondId,statutory:{...first,epfEmployee:22,epfEmployer:26,socsoEmployee:1,socsoEmployer:3,eisEmployee:999,eisEmployer:999,bases:{epf:1000,epfAdditional:200,socsoEis:1000}}});
  await owner.db.insert(companyStatutoryMy).values({tenantId:b.tenantId,companyId:b.companyId,epfEmployerNo:'1234567',socsoEmployerCode:'SOCSO123'}).onConflictDoUpdate({target:companyStatutoryMy.companyId,set:{epfEmployerNo:'1234567',socsoEmployerCode:'SOCSO123'}});
  const {runSeq:_run,...monthly}=request;
  const kwspRequest={...monthly,formatId:'my.ocbc.kwsp'},kwsp=await ocbcBankPaymentFiles.preview(ctx,kwspRequest);expect(kwsp.recordCount).toBe(1);expect(kwsp.totalCents).toBe(28800);
  const file=await ocbcBankPaymentFiles.download(ctx,{...kwspRequest,expectedDigest:kwsp.digest,requestKey:randomUUID()});const detail=file.content.split('\r\n')[1];expect(detail.slice(136,153)).toBe('00000000000015600');expect(detail.slice(153,170)).toBe('00000000000013200');expect(detail.slice(170,187)).toBe('00000000000120000');
  const socso=await ocbcBankPaymentFiles.preview(ctx,{...monthly,formatId:'my.ocbc.socso'});expect(socso.recordCount).toBe(1);expect(socso.totalCents).toBe(2630);
  expect(employee.employmentId).toBe(slip.employmentId);
 });
 it('exports saved salary Zakat deductions with the approved blank hash field',async()=>{
  const {ctx,request,batchId}=await fixture();await owner.db.update(payslip).set({statutory:{zakat:12.34,zakatRebateTp1:999}}).where(eq(payslip.batchId,batchId));
  await owner.db.insert(companyStatutoryAuthority).values({tenantId:b.tenantId,companyId:b.companyId,authority:'zakat',accountNo:'Z1234'});
  const {runSeq:_run,...monthly}=request,p={...monthly,formatId:'my.ocbc.zakat'},preview=await ocbcBankPaymentFiles.preview(ctx,p);expect(preview.totalCents).toBe(1234);
  const file=await ocbcBankPaymentFiles.download(ctx,{...p,expectedDigest:preview.digest,requestKey:randomUUID()}),lines=file.content.split('\r\n');expect(lines[1].slice(93,103)).toBe('PENDAPATAN');expect(lines[2].slice(26,46)).toBe(' '.repeat(20));
 });

 it('does not reuse an idempotency key for changed inputs, but preserves immutable retries after bank edits',async()=>{
  const {ctx,request}=await fixture(),preview=await ocbcBankPaymentFiles.preview(ctx,request),p={...request,expectedDigest:preview.digest,requestKey:randomUUID()},file=await ocbcBankPaymentFiles.download(ctx,p);
  for(const changed of [{reference:'CHANGED'},{formatId:'my.ocbc.socso'},{periodKey:'2026-01'},{runSeq:2}])await expect(ocbcBankPaymentFiles.download(ctx,{...p,...changed})).rejects.toMatchObject({status:409});
  await owner.db.update(companyBankProfile).set({debitAccountNo:'9999999999'}).where(eq(companyBankProfile.id,request.bankProfileId));expect(await ocbcBankPaymentFiles.download(ctx,p)).toEqual(file);expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(1);
 });

 it('exports approved saved TIN suffix as Wife Code and preserves the full Tax Number',async()=>{
  const {ctx,request,batchId,employee}=await fixture();await owner.db.update(employeeStatutoryMy).set({taxNumber:'IG10234567091'}).where(eq(employeeStatutoryMy.personId,employee.personId));await owner.db.update(payslip).set({statutory:{pcb:10,cp38:5,zakat:999}}).where(eq(payslip.batchId,batchId));await owner.db.insert(companyStatutoryMy).values({tenantId:b.tenantId,companyId:b.companyId,lhdnEmployerNo:'E 908915-10'}).onConflictDoUpdate({target:companyStatutoryMy.companyId,set:{lhdnEmployerNo:'E 908915-10'}});
  const {runSeq:_run,...monthly}=request,p={...monthly,formatId:'my.ocbc.lhdn'},preview=await ocbcBankPaymentFiles.preview(ctx,p);expect(preview.totalCents).toBe(1500);const file=await ocbcBankPaymentFiles.download(ctx,{...p,expectedDigest:preview.digest,requestKey:randomUUID()}),lines=file.content.split('\r\n');expect(lines[1].slice(2,13)).toBe('10234567091');expect(lines[1].slice(119,135)).toBe('0000100000000500');expect(lines[2].slice(32,52)).toBe(' '.repeat(20));const [saved]=await owner.db.select({taxNumber:employeeStatutoryMy.taxNumber}).from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,employee.personId));expect(saved.taxNumber).toBe('IG10234567091');
 });

});
