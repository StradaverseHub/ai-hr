import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentPaymentMethod} from '../core/org';
import {setCompensation} from '../core/comp';
import {closeBatch,createBatch,generatePayslips} from '../packs/payroll/service';
import {upsertCompanyBankProfile} from '../core/bank-profile';
import {upsertCompanyStatutoryAuthority} from '../core/statutory-authority';
import {setStatutoryProfileMY,setBankProfileMY} from '../localization/my/statutory';
import {ocbcBankPaymentFiles} from '../localization/my/ocbc-payment';
import {bankPaymentExport,companyBankProfile,companyStatutoryAuthority,payrollBatch,payslip} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {BankPaymentRequest} from '../localization/country-pack';
describe('Maybank configured category and immutable export owner',()=>{
 let b:Base;const day=todayInKualaLumpur(),period=day.slice(0,7),start=day.slice(0,4)+'-01-01';
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
 async function fixture(){const ctx=adminCtx(b);
  const employee=await hireEmployee(ctx,{person:{fullName:'FICTIONAL MAYBANK PAYEE',primaryEmail:'maybank-fixture@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:1000,monthlyAllowance:0,effectiveFrom:start});
  await setStatutoryProfileMY(ctx,{personId:employee.personId,icNumber:'900101011234',epfNumber:'12345678',taxNumber:'SG12345678900',bankName:'Maybank',bankAccountNo:'123456789012'});
  await setBankProfileMY(ctx,{personId:employee.personId,employmentId:employee.employmentId,bankName:'Maybank',bankAccountNo:'123456789012',bankPayeeResidency:'resident'});
  await setEmploymentPaymentMethod(ctx,{employmentId:employee.employmentId,paymentMethod:'bank_transfer'});
  const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:period});await generatePayslips(ctx,{batchId});
  const profile=await upsertCompanyBankProfile(ctx,{companyId:b.companyId,bank:'maybank',corporateId:'TESTCORP',debitAccountNo:'123456789012',orgName:'FICTIONAL COMPANY',isPrimary:true,fileContactName:'FICTIONAL CONTACT',fileContactPhone:'0312345678',fileStateCode:'14',maybankPaymentSettings:{version:'7.4',hashMode:'not-required',zakatClassification:'1'}});
  for(const[authority,accountNo]of [['epf','123456789'],['socso','123456789012'],['lhdn','E1234567890'],['zakat','ZAKAT-TEST']])await upsertCompanyStatutoryAuthority(ctx,{companyId:b.companyId,authority,accountNo,bankProfileId:profile.id});
  const request:BankPaymentRequest={companyId:b.companyId,bankProfileId:profile.id,formatId:'my.maybank74.salary',periodKey:period,paymentDate:day,runSeq:1,testFile:false,reference:'PAYROLL'};
  return{ctx,request,batchId,employee};
 }
 it('previews without writes and stores exact immutable bytes without paying or changing payroll',async()=>{
  const{ctx,request,batchId}=await fixture();const before=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId)),preview=await ocbcBankPaymentFiles.preview(ctx,request);
  expect(preview.recordCount).toBe(1);expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(0);
  const p={...request,expectedDigest:preview.digest,requestKey:randomUUID()},file=await ocbcBankPaymentFiles.download(ctx,p);
  expect(await ocbcBankPaymentFiles.download(ctx,p)).toEqual(file);expect(file.content.split('\r\n')[1].split('|')).toHaveLength(337);
  expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(1);expect(await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId))).toEqual(before);
  const[batch]=await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batchId));expect(batch.status).toBe('processed');
 });
 it('selects the assigned statutory account ahead of the primary and preserves Maybank file bytes', async () => {
  const {ctx,request,batchId}=await fixture();
  const primary=await upsertCompanyBankProfile(ctx,{companyId:b.companyId,bank:'ocbc_bank',corporateId:'A999999',debitAccountNo:'9876543210',isPrimary:true});
  await closeBatch(ctx,{batchId});
  const selection={companyId:b.companyId,category:'socso'} as const;
  expect(await ocbcBankPaymentFiles.submissionOptions(ctx,selection)).toMatchObject({
   accounts:[{id:request.bankProfileId,accountNumber:'123456789012',formatId:'my.maybank74.socso'}],
   configuredAccountId:request.bankProfileId,usesStatutoryAccount:true,periods:[{periodKey:period,runs:[]}],
  });
  const {runSeq:_,...month}=request;
  const input={...month,formatId:'my.maybank74.socso'};
  const preview=await ocbcBankPaymentFiles.preview(ctx,input);
  const selected={...input,closedPayrollOnly:true as const};
  expect(await ocbcBankPaymentFiles.preview(ctx,selected)).toEqual(preview);
  await expect(ocbcBankPaymentFiles.preview(ctx,{...selected,bankProfileId:primary.id,formatId:'my.ocbc.socso'})).rejects.toMatchObject({status:409});
  const file=await ocbcBankPaymentFiles.download(ctx,{...selected,expectedDigest:preview.digest,requestKey:randomUUID()});
  expect(file.content.trimEnd().split('\r\n').map(row=>row.split('|').length)).toEqual([42,136,28]);
 });
 it('uses the approved initial blank-hash default for an existing unconfigured Maybank account',async()=>{
  const {ctx,request,batchId}=await fixture(),before=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId));
  const configured=await ocbcBankPaymentFiles.preview(ctx,request);
  await owner.db.update(companyBankProfile).set({maybankPaymentSettings:null}).where(eq(companyBankProfile.id,request.bankProfileId));
  const preview=await ocbcBankPaymentFiles.preview(ctx,request);expect(preview.totalCents).toBe(configured.totalCents);
  const file=await ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()});
  const rows=file.content.trimEnd().split('\r\n').map(row=>row.split('|'));expect(rows.map(row=>row.length)).toEqual([29,337,29]);
  expect(rows[0].slice(3).every(field=>field==='')).toBe(true);expect(rows[2].slice(3).every(field=>field==='')).toBe(true);
  expect(await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId))).toEqual(before);
 });
 it('reconciles all four saved statutory categories including the distinct Lindung leg',async()=>{
  const{ctx,request,batchId}=await fixture();await owner.db.update(payslip).set({statutory:{epfEmployee:110,epfEmployer:130,socsoEmployee:4.95,socsoEmployer:17.35,socsoSkbbk:12,pcb:10.1,cp38:5.05,zakat:12.34,bases:{epf:1000,epfAdditional:0}}}).where(eq(payslip.batchId,batchId));
  const{runSeq:_run,...month}=request;
  for(const[format,expected]of [['kwsp',24000],['socso',3430],['lhdn',1515],['zakat',1234]] as const){
   const p={...month,formatId:'my.maybank74.'+format},preview=await ocbcBankPaymentFiles.preview(ctx,p);expect(preview.totalCents).toBe(expected);
   const file=await ocbcBankPaymentFiles.download(ctx,{...p,expectedDigest:preview.digest,requestKey:randomUUID()}),rows=file.content.trimEnd().split('\r\n').map(row=>row.split('|'));
   expect(rows.map(row=>row.length)).toEqual([42,136,28]);if(format==='socso')expect(rows[1][39]).toBe('12.00');
  }
 });
 it('refuses a missing category mapping, another company account and an unconfirmed hash',async()=>{
  const{ctx,request}=await fixture(),{runSeq:_run,...month}=request;
  await owner.db.update(companyStatutoryAuthority).set({bankProfileId:null}).where(eq(companyStatutoryAuthority.authority,'socso'));
  await expect(ocbcBankPaymentFiles.preview(ctx,{...month,formatId:'my.maybank74.socso'})).rejects.toThrow(/Configure.*category/);
  const foreign=await seedBase();await expect(ocbcBankPaymentFiles.preview(ctx,{...request,companyId:foreign.companyId})).rejects.toThrow();
  await owner.db.update(companyBankProfile).set({maybankPaymentSettings:{version:'7.4',hashMode:'unconfirmed',zakatClassification:'1'}}).where(eq(companyBankProfile.id,request.bankProfileId));
  await expect(ocbcBankPaymentFiles.preview(ctx,request)).rejects.toThrow(/hashing details/);expect(await owner.db.select().from(bankPaymentExport)).toHaveLength(0);
 });
 it('refuses missing payee residency and detects a changed arrangement after preview',async()=>{
  const{ctx,request,employee}=await fixture();const preview=await ocbcBankPaymentFiles.preview(ctx,request);
  await upsertCompanyBankProfile(ctx,{id:request.bankProfileId,companyId:b.companyId,bank:'maybank',corporateId:'CHANGEDCORP',debitAccountNo:'123456789012',isPrimary:true});
  await expect(ocbcBankPaymentFiles.download(ctx,{...request,expectedDigest:preview.digest,requestKey:randomUUID()})).rejects.toMatchObject({status:409});
  await setBankProfileMY(ctx,{personId:employee.personId,employmentId:employee.employmentId,bankName:'Maybank',bankAccountNo:'123456789012',bankPayeeResidency:null});
  await expect(ocbcBankPaymentFiles.preview(ctx,request)).rejects.toThrow(/banking residency/);
 });
});
