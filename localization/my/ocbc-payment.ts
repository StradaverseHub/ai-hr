/** Authorised OCBC export snapshots; never payroll calculations or bank submission. */
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {type SessionContext,type Tx} from '../../db/client';
import {withPayrollHistoryTenant} from '../../core/payroll-history-lock';
import {appendEvent,actorOf} from '../../db/events';
import {company,companyBankProfile,companyStatutoryMy,employeeStatutoryMy,employment,payrollBatch,payslip,person,bankPaymentExport} from '../../db/schema';
import type {BankPaymentFiles,BankPaymentRequest} from '../country-pack';
import {buildOcbcFile,OcbcFileError,type OcbcInput,type OcbcRow} from './ocbc-file';
import {monthWagesFrom,monthWageFor} from './statutory-month-wage';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FORMATS={'my.ocbc.salary':'salary','my.ocbc.kwsp':'kwsp','my.ocbc.socso':'socso','my.ocbc.lhdn':'lhdn','my.ocbc.zakat':'zakat'} as const;
function cents(value:unknown,label:string){const raw=String(value??'');if(!/^\d+(\.\d{1,2})?$/.test(raw))throw new OcbcFileError(`${label}: saved payroll amount is missing, negative or invalid.`);const [whole,fraction='']=raw.split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(amount))throw new OcbcFileError(`${label}: amount exceeds supported precision.`);return amount;}
async function authorize(tx:Tx,ctx:SessionContext,companyId:string){
 if(!ctx.userId)throw new OcbcFileError('Not found');
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${companyId}::uuid) as ok`);
 if(row?.ok!==true)throw new OcbcFileError('Not found');
}
async function source(tx:Tx,ctx:SessionContext,p:BankPaymentRequest){
 await authorize(tx,ctx,p.companyId);
 const format=FORMATS[p.formatId as keyof typeof FORMATS];if(!format)throw new OcbcFileError('Unknown OCBC format.');
 const [co]=await tx.select({name:company.legalName,country:company.country}).from(company).where(and(eq(company.id,p.companyId),eq(company.tenantId,ctx.tenantId)));
 if(!co||co.country!=='MY')throw new OcbcFileError('Not found');
 const [bank]=await tx.select().from(companyBankProfile).where(and(eq(companyBankProfile.id,p.bankProfileId),eq(companyBankProfile.companyId,p.companyId),eq(companyBankProfile.tenantId,ctx.tenantId))).for('share');
 if(!bank||bank.bank!=='ocbc_bank'||bank.currency!=='MYR')throw new OcbcFileError('Choose an OCBC MYR bank account for this company.');
 if(format==='salary'&&(!Number.isInteger(p.runSeq)||p.runSeq!<1))throw new OcbcFileError('Choose exactly one ready payroll run for salary payment.');
 const batches=await tx.select({id:payrollBatch.id,runSeq:payrollBatch.runSeq,stale:payrollBatch.needsRecalcAt}).from(payrollBatch).where(and(eq(payrollBatch.tenantId,ctx.tenantId),eq(payrollBatch.companyId,p.companyId),eq(payrollBatch.payPeriod,p.periodKey),inArray(payrollBatch.status,['processed','closed']),isNull(payrollBatch.historyImportAttemptId),format==='salary'?eq(payrollBatch.runSeq,p.runSeq!):undefined)).orderBy(asc(payrollBatch.runSeq)).for('share');
 if(!batches.length)throw new OcbcFileError('No ready payroll runs exist for this selection. Imported history cannot initiate a bank payment.');
 if(batches.some(b=>b.stale))throw new OcbcFileError('Recalculate the selected payroll before generating its bank file.');
 const rows=await tx.select({employmentId:employment.id,personId:person.id,name:person.fullName,code:employment.employeeCode,method:employment.paymentMethod,net:payslip.netPay,statutory:payslip.statutory,runSeq:payrollBatch.runSeq,
  bank:employeeStatutoryMy.bankName,account:employeeStatutoryMy.bankAccountNo,ic:employeeStatutoryMy.icNumber,passport:employeeStatutoryMy.passportNumber,socsoNumber:employeeStatutoryMy.socsoNumber,epfNumber:employeeStatutoryMy.epfNumber,
  customNameEnabled:employeeStatutoryMy.enableCustomHolderName,customName:employeeStatutoryMy.customHolderName,customIdEnabled:employeeStatutoryMy.enableCustomHolderId,customId:employeeStatutoryMy.customHolderId,
 }).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).innerJoin(employment,eq(employment.id,payslip.employmentId)).innerJoin(person,eq(person.id,employment.personId)).leftJoin(employeeStatutoryMy,eq(employeeStatutoryMy.personId,person.id))
 .where(inArray(payslip.batchId,batches.map(b=>b.id))).orderBy(asc(employment.employeeCode),asc(employment.id),asc(payrollBatch.runSeq));
 if(rows.length>100000)throw new OcbcFileError('Selection exceeds the bank file record limit.');
 const wages=monthWagesFrom(rows),grouped=new Map<string,OcbcRow>();
 for(const r of rows){
  const key=r.code||r.employmentId,st=r.statutory as Record<string,unknown>|null;
  if(format==='salary'){
   if(r.method==='cash'||r.method==='cheque')continue;
   if(r.method!=='bank_transfer')throw new OcbcFileError(`${key}: set the employee payment method before generating a bank file.`);
   const amount=cents(r.net,key);if(!amount)continue;
   if(r.customNameEnabled&&!r.customName?.trim()||r.customIdEnabled&&!r.customId?.trim())throw new OcbcFileError(`${key}: complete the enabled custom account-holder details.`);
   grouped.set(r.employmentId,{key,name:r.customNameEnabled?r.customName!:r.name,employeeCode:r.code??'',bank:r.bank??'',account:r.account??'',identity:r.customIdEnabled?r.customId!:r.ic??r.passport??'',amountCents:amount});
  }else if(format==='kwsp'){
   const ee=cents(st?.epfEmployee,key+' employee EPF'),er=cents(st?.epfEmployer,key+' employer EPF');if(!ee&&!er)continue;
   const wage=monthWageFor(wages,r.employmentId);if(!wage.epfRecorded||wage.epfInconsistent)throw new OcbcFileError(`${key}: EPFable wages are missing or inconsistent across runs. Review the payroll before downloading.`);
   const prior=grouped.get(r.employmentId);grouped.set(r.employmentId,{key,name:r.name,employeeCode:r.code??'',identity:r.ic??r.passport??'',epfNumber:r.epfNumber??'',amountCents:0,wageCents:cents(wage.epf,key+' EPFable wage'),employeeCents:(prior?.employeeCents??0)+ee,employerCents:(prior?.employerCents??0)+er});
  }else if(format==='socso'){
   const amount=cents(st?.socsoEmployee,key+' employee SOCSO')+cents(st?.socsoEmployer,key+' employer SOCSO');if(!amount)continue;
   const prior=grouped.get(r.employmentId);grouped.set(r.employmentId,{key,name:r.name,identity:r.ic??r.socsoNumber??'',amountCents:(prior?.amountCents??0)+amount});
  }
 }
 const [statutory]=await tx.select().from(companyStatutoryMy).where(eq(companyStatutoryMy.companyId,p.companyId));
 const input:OcbcInput={format,payer:{name:bank.orgName?.trim()||bank.accountName?.trim()||co.name,corporateId:bank.corporateId,account:bank.debitAccountNo,branch:bank.branch??'',employerReference:format==='kwsp'?statutory?.epfEmployerNo??'':statutory?.socsoEmployerCode??'',settings:{contactName:bank.fileContactName??'',contactPhone:bank.fileContactPhone??'',stateCode:bank.fileStateCode??'',requireIdCheck:bank.requirePayeeIdCheck}},paymentDate:p.paymentDate,periodKey:p.periodKey,tapeId:1,testFile:p.testFile,reference:p.reference,rows:[...grouped.values()]};
 const built=buildOcbcFile(input);return {input,built,digest:hash({p,input}),companyName:co.name};
}
export const ocbcBankPaymentFiles:BankPaymentFiles={
 preview:(ctx,p)=>withPayrollHistoryTenant(ctx,async tx=>{const value=await source(tx,ctx,p);return{digest:value.digest,recordCount:value.built.recordCount,totalCents:value.built.totalCents,companyName:value.companyName,paymentDate:p.paymentDate,periodKey:p.periodKey};}),
 download:(ctx,p)=>withPayrollHistoryTenant(ctx,async tx=>{
  await authorize(tx,ctx,p.companyId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'bank-file-request:'+ctx.tenantId+':'+ctx.userId+':'+p.requestKey},0))`);
  const [existing]=await tx.select().from(bankPaymentExport).where(and(eq(bankPaymentExport.tenantId,ctx.tenantId),eq(bankPaymentExport.actorUserId,ctx.userId!),eq(bankPaymentExport.requestKey,p.requestKey)));
  if(existing){if(existing.companyId!==p.companyId||existing.bankProfileId!==p.bankProfileId||existing.sourceDigest!==p.expectedDigest)throw new OcbcFileError('This download request changed. Preview it again.');return{content:existing.content,filename:existing.filename};}
  // Drop transport-only confirmation fields before hashing the canonical request.
  const {expectedDigest,requestKey,...request}=p,value=await source(tx,ctx,request);
  if(value.digest!==expectedDigest)throw new OcbcFileError('Payroll or bank details changed after preview. Preview the file again.');
  const [sequence]=await tx.execute<{tape_id:number}>(sql`select app.next_bank_payment_tape(${p.companyId}::uuid,${p.paymentDate}::date) as tape_id`);
  const tapeId=Number(sequence.tape_id),built=buildOcbcFile({...value.input,tapeId});
  const [saved]=await tx.insert(bankPaymentExport).values({tenantId:ctx.tenantId,companyId:p.companyId,bankProfileId:p.bankProfileId,actorUserId:ctx.userId!,requestKey,valueDate:p.paymentDate,tapeId,format:p.formatId,sourceDigest:value.digest,filename:built.filename,content:built.content,recordCount:built.recordCount,totalCents:built.totalCents}).returning({id:bankPaymentExport.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'bank-payment-export',aggregateId:saved.id,eventType:'bank-payment-file.generated',actor:actorOf(ctx),payload:{companyId:p.companyId,bankProfileId:p.bankProfileId,format:p.formatId,periodKey:p.periodKey,recordCount:built.recordCount,totalCents:built.totalCents,testFile:p.testFile}});
  return{content:built.content,filename:built.filename};
 }),
};
