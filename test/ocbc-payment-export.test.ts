import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentPaymentMethod} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips} from '../packs/payroll/service';
import {upsertCompanyBankProfile} from '../core/bank-profile';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {ocbcBankPaymentFiles} from '../localization/my/ocbc-payment';
import {bankPaymentExport,companyBankProfile,payrollBatch} from '../db/schema';
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
  const profile=await upsertCompanyBankProfile(ctx,{companyId:b.companyId,bank:'ocbc_bank',corporateId:'A999999',debitAccountNo:'1234567890',orgName:'FICTIONAL COMPANY',branch:'701',fileContactName:'FICTIONAL CONTACT',fileContactPhone:'0312345678',fileStateCode:'014'});
  const request:BankPaymentRequest={companyId:b.companyId,bankProfileId:profile.id,formatId:'my.ocbc.salary',periodKey:period,paymentDate:day,runSeq:1,testFile:false,reference:'PAYROLL'};
  return {ctx,request,batchId};
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
 it('exposes no guessed mandatory hash',async()=>{const {ctx,request}=await fixture();for(const formatId of ['my.ocbc.lhdn','my.ocbc.zakat'])await expect(ocbcBankPaymentFiles.preview(ctx,{...request,formatId})).rejects.toThrow(/Hash Total/);});
});
