import {DEFAULT_MAYBANK_PAYMENT_SETTINGS} from '../../lib/maybank-payment-settings';
import {assertModuleEnabled} from '../../core/entitlements';
/** Authorised OCBC export snapshots; never payroll calculations or bank submission. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {type SessionContext,type Tx} from '../../db/client';
import {withPayrollHistoryTenant} from '../../packs/payroll/history';
import {myBankLabel} from '../../lib/my-banks';
import {appendEvent,actorOf} from '../../db/events';
import {company,companyBankProfile,companyStatutoryMy,companyStatutoryAuthority,employeeStatutoryMy,employment,payrollBatch,payslip,person,bankPaymentExport,payrollCycle,payPeriod} from '../../db/schema';
import {BankPaymentFileError,type BankPaymentCategory,type BankPaymentFiles,type BankPaymentOptions,type BankPaymentRequest} from '../country-pack';
import {buildOcbcFile,ocbcLhdnTaxIdentity,OcbcFileError,type OcbcInput,type OcbcRow} from './ocbc-file';
import {buildMaybankV74File,type MaybankInput,type MaybankRow} from './maybank-v74-file';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {monthWagesFrom,monthWageFor} from './statutory-month-wage';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestFingerprint=(p:BankPaymentRequest)=>hash({companyId:p.companyId,bankProfileId:p.bankProfileId,formatId:p.formatId,periodKey:p.periodKey,paymentDate:p.paymentDate,runSeq:p.runSeq??null,testFile:p.testFile,reference:p.reference});
const FORMATS={'my.ocbc.salary':'salary','my.ocbc.kwsp':'kwsp','my.ocbc.socso':'socso','my.ocbc.lhdn':'lhdn','my.ocbc.zakat':'zakat','my.maybank74.salary':'salary','my.maybank74.kwsp':'kwsp','my.maybank74.socso':'socso','my.maybank74.lhdn':'lhdn','my.maybank74.zakat':'zakat'} as const;
function cents(value:unknown,label:string){const raw=String(value??'');if(!/^\d+(\.\d{1,2})?$/.test(raw))throw new OcbcFileError(`${label}: saved payroll amount is missing, negative or invalid.`);const [whole,fraction='']=raw.split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(amount))throw new OcbcFileError(`${label}: amount exceeds supported precision.`);return amount;}
async function authorize(tx:Tx,ctx:SessionContext,companyId:string,submission=false){
 assertModuleEnabled(ctx,'payroll',companyId);
 if(!ctx.userId)throw new BankPaymentFileError('Not found',404);
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${companyId}::uuid) and (not ${submission} or app.can_admin_payroll_for(${companyId}::uuid)) as ok`);
 if(row?.ok!==true)throw new BankPaymentFileError('Not found',404);
}
/** The stored statutory payer wins over the company-wide primary account. Maybank
 * statutory files require that explicit mapping even when the primary is Maybank. */
async function submissionAccounts(
  tx: Tx, ctx: SessionContext, companyId: string, category: BankPaymentCategory, lock = false,
) {
  const scope = and(eq(companyBankProfile.tenantId, ctx.tenantId), eq(companyBankProfile.companyId, companyId));
  const query = tx.select().from(companyBankProfile).where(scope).orderBy(asc(companyBankProfile.id));
  const profiles = await (lock ? query.for('share') : query);
  const authority = category === 'kwsp' ? 'epf' : category;
  const mappingQuery = tx.select({
    bankProfileId: companyStatutoryAuthority.bankProfileId, accountNo: companyStatutoryAuthority.accountNo,
  }).from(companyStatutoryAuthority).where(and(
    eq(companyStatutoryAuthority.tenantId, ctx.tenantId),
    eq(companyStatutoryAuthority.companyId, companyId),
    eq(companyStatutoryAuthority.authority, authority),
  ));
  const [mapping] = category === 'salary' ? [] : await (lock ? mappingQuery.for('share') : mappingQuery);
  const mappedId = mapping?.bankProfileId ?? null;
  const primaries = profiles.filter(profile => profile.isPrimary);
  const configuredAccountId = mappedId ?? primaries[0]?.id ?? null;
  const candidates = configuredAccountId ? profiles.filter(profile => profile.id === configuredAccountId) : profiles;
  const accounts = candidates.flatMap(profile => {
    if (profile.currency !== 'MYR' || !profile.debitAccountNo.trim()) return [];
    if (profile.bank === 'ocbc_bank') return [{ profile, formatId: 'my.ocbc.' + category }];
    if (profile.bank !== 'maybank' || (profile.maybankPaymentSettings ?? DEFAULT_MAYBANK_PAYMENT_SETTINGS).version !== '7.4') return [];
    if (category === 'salary' ? profile.txnType !== 'IBG' : profile.id !== mappedId) return [];
    return [{ profile, formatId: 'my.maybank74.' + category }];
  });
  const accountIssue: BankPaymentOptions['accountIssue'] =
    !profiles.length ? 'missing' :
    primaries.length > 1 ? 'multiple-primary' :
    accounts.length ? null :
    mappedId || (category !== 'salary' && candidates.some(profile => profile.bank === 'maybank')) ? 'statutory-account' :
    'incompatible';
  return {
    accounts: accountIssue ? [] : accounts,
    configuredAccountId: accountIssue ? null : configuredAccountId,
    usesStatutoryAccount: mappedId !== null,
    accountIssue,
    employerReference: mapping?.accountNo?.trim() || undefined,
  };
}

/** One contributing-run definition for the picker, preview and locked generation. */
async function submissionRuns(
  tx: Tx, ctx: SessionContext, companyId: string, selection?: { periodKey: string; runSeq?: number },
) {
  const query = tx.select({
    id: payrollBatch.id,
    periodKey: payrollBatch.payPeriod,
    runSeq: payrollBatch.runSeq,
    runType: payrollBatch.runType,
    cycleName: payrollCycle.name,
    status: payrollBatch.status,
    monthStatus: payPeriod.status,
    stale: payrollBatch.needsRecalcAt,
    employeeCount: payrollBatch.employeeCount,
    payslipCount: sql<number>`(select count(*)::int from ${payslip} where ${payslip.batchId} = ${payrollBatch.id})`,
  }).from(payrollBatch).leftJoin(payrollCycle, and(
    eq(payrollCycle.id, payrollBatch.payrollCycleId), eq(payrollCycle.tenantId, payrollBatch.tenantId),
  )).innerJoin(payPeriod, and(
    eq(payPeriod.id, payrollBatch.payPeriodId), eq(payPeriod.tenantId, payrollBatch.tenantId),
    eq(payPeriod.companyId, payrollBatch.companyId), eq(payPeriod.period, payrollBatch.payPeriod),
  )).where(and(
    eq(payrollBatch.tenantId, ctx.tenantId), eq(payrollBatch.companyId, companyId),
    inArray(payrollBatch.status, ['processed', 'closed']), isNull(payrollBatch.historyImportAttemptId),
    selection ? eq(payrollBatch.payPeriod, selection.periodKey) : undefined,
    selection?.runSeq === undefined ? undefined : eq(payrollBatch.runSeq, selection.runSeq),
  )).orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq));
  return selection ? query.for('share', { of: payrollBatch }) : query;
}

type PaymentRun = Awaited<ReturnType<typeof submissionRuns>>[number];
function isClosedPaymentRun(run: PaymentRun) {
  return run.status === 'closed' && !run.stale && run.payslipCount > 0 && run.payslipCount === run.employeeCount;
}
function isClosedStatutoryMonth(runs: PaymentRun[]) {
  return runs.length > 0 && runs.every(run => run.monthStatus === 'closed' && isClosedPaymentRun(run));
}

async function source(tx:Tx,ctx:SessionContext,p:BankPaymentRequest){
 await authorize(tx,ctx,p.companyId,p.closedPayrollOnly);
 const format = Object.hasOwn(FORMATS, p.formatId) ? FORMATS[p.formatId as keyof typeof FORMATS] : undefined;
 if(!format)throw new OcbcFileError('Unknown bank payment format.');
 const maybank=p.formatId.startsWith('my.maybank74.');let maybankEmployerReference:string|undefined;
 if(format==='salary'&&(!Number.isInteger(p.runSeq)||p.runSeq!<1||p.runSeq!>9999))throw new OcbcFileError('Choose exactly one ready payroll run for salary payment.');
 if(format!=='salary'&&p.runSeq!==undefined)throw new OcbcFileError('Statutory bank files cover the whole month. Remove the payroll run selection.');
 if(format==='salary'&&p.testFile)throw new OcbcFileError('Salary files cannot use the statutory test indicator.');
 if(p.closedPayrollOnly){
  const { lockPayrollPeriodsTx } = await import('../../packs/payroll/service');
  await lockPayrollPeriodsTx(tx, ctx, [{ companyId: p.companyId, payPeriod: p.periodKey }]);
 }
 const [co]=await tx.select({name:company.legalName,country:company.country,registrationNo:company.registrationNo}).from(company).where(and(eq(company.id,p.companyId),eq(company.tenantId,ctx.tenantId),p.closedPayrollOnly?isNull(company.archivedAt):undefined));
 if(!co||co.country!=='MY')throw new BankPaymentFileError('Not found',404);
 let bank: typeof companyBankProfile.$inferSelect | undefined;
 if (p.closedPayrollOnly) {
  const options = await submissionAccounts(tx, ctx, p.companyId, format, true);
  bank = options.accounts.find(account => account.profile.id === p.bankProfileId && account.formatId === p.formatId)?.profile;
  if (!bank) throw new BankPaymentFileError('The bank account or payment setup changed. Choose an eligible account again.', 409);
  maybankEmployerReference = options.employerReference;
 } else {
  [bank]=await tx.select().from(companyBankProfile).where(and(eq(companyBankProfile.id,p.bankProfileId),eq(companyBankProfile.companyId,p.companyId),eq(companyBankProfile.tenantId,ctx.tenantId))).for('share');
  if(!bank||bank.bank!==(maybank?'maybank':'ocbc_bank')||bank.currency!=='MYR')throw new OcbcFileError('Choose a configured MYR bank account matching this file format and company.');
  if(maybank){
   const [mapping]=format==='salary'?[]:await tx.select({bankProfileId:companyStatutoryAuthority.bankProfileId,accountNo:companyStatutoryAuthority.accountNo}).from(companyStatutoryAuthority).where(and(eq(companyStatutoryAuthority.companyId,p.companyId),eq(companyStatutoryAuthority.tenantId,ctx.tenantId),eq(companyStatutoryAuthority.authority,format==='kwsp'?'epf':format)));
   maybankEmployerReference=mapping?.accountNo?.trim()||undefined;
   if(format==='salary'?!bank.isPrimary:mapping?.bankProfileId!==bank.id)throw new OcbcFileError('Configure this company payment category to use this bank account before generating a file.');
  }
 }
 if(maybank){
  if(format==='salary'&&bank.txnType!=='IBG')throw new OcbcFileError('This Maybank salary arrangement supports book transfers and IBG. A RENTAS arrangement requires its additional bank fields.');
  const today=todayInKualaLumpur(),days=(Date.parse(p.paymentDate+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000;if(days<0||days>90)throw new OcbcFileError('Maybank value date must be today or within the next 90 days.');
 }
 const batches = await submissionRuns(tx, ctx, p.companyId, { periodKey: p.periodKey, runSeq: p.runSeq });
 if(p.closedPayrollOnly && !(format === 'salary' ? batches.length === 1 && isClosedPaymentRun(batches[0]) : isClosedStatutoryMonth(batches))) {
  throw new BankPaymentFileError('Only complete, closed payroll runs are available. Refresh the payroll selection.', 409);
 }
 if(!batches.length)throw new OcbcFileError('No ready payroll runs exist for this selection. Imported history cannot initiate a bank payment.');
 if(batches.some(b=>b.stale))throw new OcbcFileError('Recalculate the selected payroll before generating its bank file.');
 const rows=await tx.select({employmentId:employment.id,personId:person.id,name:person.fullName,code:employment.employeeCode,method:employment.paymentMethod,net:payslip.netPay,statutory:payslip.statutory,runSeq:payrollBatch.runSeq,
  bank:employeeStatutoryMy.bankName,account:employeeStatutoryMy.bankAccountNo,ic:employeeStatutoryMy.icNumber,passport:employeeStatutoryMy.passportNumber,oldIc:employeeStatutoryMy.oldIcNumber,countryCode:employeeStatutoryMy.passportIssuingCountryCode,taxNumber:employeeStatutoryMy.taxNumber,socsoNumber:employeeStatutoryMy.socsoNumber,epfNumber:employeeStatutoryMy.epfNumber,
  resident:employeeStatutoryMy.bankPayeeResidency,citizenship:employeeStatutoryMy.epfCitizenship,
  customNameEnabled:employeeStatutoryMy.enableCustomHolderName,customName:employeeStatutoryMy.customHolderName,customIdEnabled:employeeStatutoryMy.enableCustomHolderId,customId:employeeStatutoryMy.customHolderId,
 }).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).innerJoin(employment,eq(employment.id,payslip.employmentId)).innerJoin(person,eq(person.id,employment.personId)).leftJoin(employeeStatutoryMy,eq(employeeStatutoryMy.personId,person.id))
 .where(inArray(payslip.batchId,batches.map(b=>b.id))).orderBy(asc(employment.employeeCode),asc(employment.id),asc(payrollBatch.runSeq));
 if(rows.length>100000)throw new OcbcFileError('Selection exceeds the bank file record limit.');
 const wages=monthWagesFrom(rows),grouped=new Map<string,MaybankRow>();
 for(const r of rows){
  const key=r.code||r.employmentId,st=r.statutory as Record<string,unknown>|null;
  if(format==='salary'){
   if(r.method==='cash'||r.method==='cheque')continue;
   if(r.method!=='bank_transfer')throw new OcbcFileError(`${key}: set the employee payment method before generating a bank file.`);
   const amount=cents(r.net,key);if(!amount)continue;
   if(r.customNameEnabled&&!r.customName?.trim()||r.customIdEnabled&&!r.customId?.trim())throw new OcbcFileError(`${key}: complete the enabled custom account-holder details.`);
   grouped.set(r.employmentId,{key,name:r.customNameEnabled?r.customName!:r.name,employeeCode:r.code??'',bank:r.bank??'',account:r.account??'',identity:r.customIdEnabled?r.customId!:r.ic?.trim().replace(/[-\s]/g,'')||r.passport?.trim()||'',amountCents:amount,...(maybank?{resident:r.resident}:{})});
  }else if(format==='kwsp'){
   const ee=cents(st?.epfEmployee,key+' employee EPF'),er=cents(st?.epfEmployer,key+' employer EPF');if(!ee&&!er)continue;
   const wage=monthWageFor(wages,r.employmentId);if(!wage.epfRecorded||wage.epfInconsistent)throw new OcbcFileError(`${key}: EPFable wages are missing or inconsistent across runs. Review the payroll before downloading.`);
   const prior=grouped.get(r.employmentId);grouped.set(r.employmentId,{key,name:r.name,employeeCode:r.code??'',identity:r.ic?.trim().replace(/[-\s]/g,'')||(maybank?'':r.passport?.trim()||''),epfNumber:r.epfNumber??'',amountCents:0,wageCents:cents(wage.epf,key+' EPFable wage'),employeeCents:(prior?.employeeCents??0)+ee,employerCents:(prior?.employerCents??0)+er,...(maybank?{citizen:r.citizenship==='citizen',passport:r.passport??'',countryCode:r.countryCode??'',oldIdentity:r.oldIc??''}:{})});
  }else if(format==='socso'){
   const ee=cents(st?.socsoEmployee,key+' employee SOCSO'),er=cents(st?.socsoEmployer,key+' employer SOCSO'),skbbk=maybank?cents(st?.socsoSkbbk??0,key+' Lindung 24 Jam'):0,amount=ee+er+skbbk;if(!amount)continue;
   const prior=grouped.get(r.employmentId);grouped.set(r.employmentId,{key,name:r.name,identity:r.ic?.trim().replace(/[-\s]/g,'')||(maybank?'':r.socsoNumber?.trim()||''),amountCents:(prior?.amountCents??0)+amount,...(maybank?{employeeCents:(prior?.employeeCents??0)+ee,employerCents:(prior?.employerCents??0)+er,skbbkCents:(prior?.skbbkCents??0)+skbbk,socialSecurityNumber:r.socsoNumber??''}:{})});
  }else if(format==='lhdn'){
   const pcb=cents(st?.pcb??0,key+' PCB'),cp38=cents(st?.cp38??0,key+' CP38');if(!pcb&&!cp38)continue;
   let taxIdentity;try{taxIdentity=maybank?{taxNumber:(r.taxNumber??'').replace(/[-\s()]/g,''),wifeCode:(r.taxNumber??'').replace(/[-\s()]/g,'').slice(-1)}:ocbcLhdnTaxIdentity(r.taxNumber);}catch(error){if(error instanceof OcbcFileError)throw new OcbcFileError(`${key}: ${error.message}`);throw error;}
   const prior=grouped.get(r.employmentId);grouped.set(r.employmentId,{key,name:r.name,employeeCode:r.code??'',...taxIdentity,identity:r.ic?.trim().replace(/[-\s]/g,'')||'',oldIdentity:r.oldIc??'',passport:r.passport??'',countryCode:r.countryCode??'',pcbCents:(prior?.pcbCents??0)+pcb,cp38Cents:(prior?.cp38Cents??0)+cp38,amountCents:0,...(maybank?{citizen:r.citizenship==='citizen'}:{})});
  }else if(format==='zakat'){
   const amount=cents(st?.zakat??0,key+' salary-deducted Zakat');if(!amount)continue;const prior=grouped.get(r.employmentId);
   grouped.set(r.employmentId,{key,name:r.name,identity:r.ic?.trim().replace(/[-\s]/g,'')||'',oldIdentity:r.oldIc??'',passport:r.passport??'',paymentType:'PENDAPATAN',amountCents:(prior?.amountCents??0)+amount});
  }
 }
 const [statutory]=await tx.select().from(companyStatutoryMy).where(eq(companyStatutoryMy.companyId,p.companyId));
 const [zakatAuthority]=format==='zakat'?await tx.select({accountNo:companyStatutoryAuthority.accountNo}).from(companyStatutoryAuthority).where(and(eq(companyStatutoryAuthority.companyId,p.companyId),eq(companyStatutoryAuthority.tenantId,ctx.tenantId),eq(companyStatutoryAuthority.authority,'zakat'))):[];
 const input:OcbcInput={format,payer:{name:bank.orgName?.trim()||bank.accountName?.trim()||co.name,corporateId:bank.corporateId,account:bank.debitAccountNo,branch:bank.branch??'',employerReference:format==='kwsp'?statutory?.epfEmployerNo??'':format==='lhdn'?(statutory?.lhdnEmployerNo??'').replace(/\D/g,''):format==='zakat'?zakatAuthority?.accountNo??'':statutory?.socsoEmployerCode??'',settings:{contactName:bank.fileContactName??'',contactPhone:bank.fileContactPhone??'',stateCode:bank.fileStateCode??'',requireIdCheck:bank.requirePayeeIdCheck}},paymentDate:p.paymentDate,periodKey:p.periodKey,tapeId:1,testFile:p.testFile,reference:p.reference,rows:[...grouped.values()]};
 const maybankInput:MaybankInput|null=maybank?{format,payer:{name:bank.orgName?.trim()||bank.accountName?.trim()||co.name,corporateId:bank.corporateId,account:bank.debitAccountNo,employerReference:maybankEmployerReference??'',registrationNo:co.registrationNo??'',settings:bank.maybankPaymentSettings??DEFAULT_MAYBANK_PAYMENT_SETTINGS,contactName:bank.fileContactName??'',contactPhone:bank.fileContactPhone??'',stateCode:bank.fileStateCode??''},paymentDate:p.paymentDate,periodKey:p.periodKey,tapeId:1,testFile:p.testFile,reference:p.reference,rows:[...grouped.values()]}:null;
 const built=maybankInput?buildMaybankV74File(maybankInput):buildOcbcFile(input);return {input,maybankInput,built,digest:hash({selection:{companyId:p.companyId,bankProfileId:p.bankProfileId,formatId:p.formatId,periodKey:p.periodKey,runSeq:p.runSeq??null},input,...(maybankInput?{maybankInput}:{})}),companyName:co.name};
}
const previewOf=(value:Awaited<ReturnType<typeof source>>,p:{paymentDate:string;periodKey:string})=>({digest:value.digest,recordCount:value.built.recordCount,totalCents:value.built.totalCents,companyName:value.companyName,paymentDate:p.paymentDate,periodKey:p.periodKey});
export const ocbcBankPaymentFiles:BankPaymentFiles={
 submissionOptions: (ctx, p) => withPayrollHistoryTenant(ctx, async tx => {
  await authorize(tx, ctx, p.companyId, true);
  const [owner] = await tx.select({ id: company.id }).from(company).where(and(
    eq(company.id, p.companyId), eq(company.tenantId, ctx.tenantId), eq(company.country, 'MY'), isNull(company.archivedAt),
  )).limit(1);
  if (!owner) throw new BankPaymentFileError('Not found', 404);
  const { accounts, configuredAccountId, accountIssue, usesStatutoryAccount } = await submissionAccounts(tx, ctx, p.companyId, p.category);
  const runs = await submissionRuns(tx, ctx, p.companyId);
  const byPeriod = new Map<string, typeof runs>();
  for (const run of runs) {
   const group = byPeriod.get(run.periodKey);
   if (group) group.push(run);
   else byPeriod.set(run.periodKey, [run]);
  }
  const periods = [...byPeriod].flatMap(([periodKey, group]) => {
   const closed = group.filter(isClosedPaymentRun);
   if (!closed.length || p.category !== 'salary' && !isClosedStatutoryMonth(group)) return [];
   return [{ periodKey, runs: p.category === 'salary' ? closed.map(({ runSeq, cycleName, runType }) => ({ runSeq, cycleName, runType })) : [] }];
  });
  return {
   accountIssue, configuredAccountId, usesStatutoryAccount, periods,
   accounts: accounts.map(({ profile, formatId }) => ({
    id: profile.id, bankName: myBankLabel(profile.bank), label: profile.accountLabel ?? '',
    accountNumber: profile.debitAccountNo, formatId,
   })),
  };
 }),
 preview:(ctx,p)=>withPayrollHistoryTenant(ctx,async tx=>previewOf(await source(tx,ctx,p),p)),
 // AI v2 P2-2a: the Salary payroll loop's bank check. The company's first OCBC MYR account (the bank file screen
 // offers the same accounts) and the salary format; a preview only, so no Tape ID is used and nothing is recorded.
 salaryRunPreview:(ctx,p)=>withPayrollHistoryTenant(ctx,async tx=>{
  await authorize(tx,ctx,p.companyId);
  const [account]=await tx.select({id:companyBankProfile.id}).from(companyBankProfile).where(and(eq(companyBankProfile.companyId,p.companyId),eq(companyBankProfile.tenantId,ctx.tenantId),
   eq(companyBankProfile.bank,'ocbc_bank'),eq(companyBankProfile.currency,'MYR'))).orderBy(asc(companyBankProfile.createdAt),asc(companyBankProfile.id)).limit(1);
  if(!account)return null;
  const request={companyId:p.companyId,bankProfileId:account.id,formatId:'my.ocbc.salary',periodKey:p.periodKey,paymentDate:p.paymentDate,runSeq:p.runSeq,testFile:false,reference:'PAYROLL CHECK'};
  return previewOf(await source(tx,ctx,request),request);
 }),
 download:(ctx,p)=>withPayrollHistoryTenant(ctx,async tx=>{
  await authorize(tx,ctx,p.companyId,p.closedPayrollOnly);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'bank-file-request:'+ctx.tenantId+':'+ctx.userId+':'+p.requestKey},0))`);
  const [existing]=await tx.select().from(bankPaymentExport).where(and(eq(bankPaymentExport.tenantId,ctx.tenantId),eq(bankPaymentExport.actorUserId,ctx.userId!),eq(bankPaymentExport.requestKey,p.requestKey)));
  if(existing){if(existing.companyId!==p.companyId||existing.bankProfileId!==p.bankProfileId||existing.sourceDigest!==p.expectedDigest||existing.requestFingerprint!==requestFingerprint(p))throw new BankPaymentFileError('This download request changed. Preview it again.',409);return{content:existing.content,filename:existing.filename};}
  // Drop transport-only confirmation fields before hashing the canonical request.
  const {expectedDigest,requestKey,...request}=p,value=await source(tx,ctx,request);
  if(value.digest!==expectedDigest)throw new BankPaymentFileError('Payroll or bank details changed after preview. Preview the file again.',409);
  const [sequence]=await tx.execute<{tape_id:number}>(sql`select app.next_bank_payment_tape(${p.companyId}::uuid,${p.paymentDate}::date) as tape_id`);
  const tapeId=Number(sequence.tape_id);
  if(!Number.isInteger(tapeId)||tapeId<1||tapeId>999)throw new OcbcFileError('All 999 bank Tape IDs for this value date have been used. Choose another payment date.');
  const built=value.maybankInput?buildMaybankV74File({...value.maybankInput,tapeId}):buildOcbcFile({...value.input,tapeId});
  const [saved]=await tx.insert(bankPaymentExport).values({tenantId:ctx.tenantId,companyId:p.companyId,bankProfileId:p.bankProfileId,actorUserId:ctx.userId!,requestKey,requestFingerprint:requestFingerprint(request),valueDate:p.paymentDate,tapeId,format:p.formatId,sourceDigest:value.digest,filename:built.filename,content:built.content,recordCount:built.recordCount,totalCents:built.totalCents}).returning({id:bankPaymentExport.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'bank-payment-export',aggregateId:saved.id,eventType:'bank-payment-file.generated',actor:actorOf(ctx),payload:{companyId:p.companyId,bankProfileId:p.bankProfileId,format:p.formatId,periodKey:p.periodKey,recordCount:built.recordCount,totalCents:built.totalCents,testFile:p.testFile}});
  return{content:built.content,filename:built.filename};
 }),
};
