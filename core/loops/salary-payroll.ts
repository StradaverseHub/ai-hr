/** AI v2 P2-2a — the Salary payroll loop, from the salary cut-off to close (owner decisions, payroll-cycle loops, items
 * 1, 2, 3 and 5). PREPARE ONLY, IN EVERY COMPANY, ENFORCED: this module reads through the payroll owners and returns
 * observations; it never creates, processes, approves, closes or reopens a run, and it never generates or sends a bank
 * file (test/payroll-cycle-loops.test.ts pins both the behaviour and this file's imports). A person runs, approves and
 * closes payroll; there is no second approver.
 *
 * Detect, per company in scope that uses payroll:
 *  - the pay period whose salary cut-off has passed (the "active" period) and the current month, and every payroll run of
 *    them that exists (regular, bonus and off-cycle runs alike, owner decision 3), plus every run the loop is tracking;
 *  - start: after the cut-off, whether the period's regular run has been started. Prepared for HR to start, never run.
 * Diagnose, per run that has been processed (all read under the sponsor's authority):
 *  - the 11 payroll anomaly detectors' verdicts on it and how many exceptions are still open
 *    (core/payroll-anomaly.ts anomalyMetrics; the detectors run in the payroll owner, not here);
 *  - the change against last month per person, by cause, through the pay-difference service (core/loops/net-swing.ts),
 *    and the people whose net pay moved by more than the company's threshold (15% unless an administrator changed it);
 *  - the statutory rule versions the run stamped (EPF, SOCSO, EIS, PCB, HRD Corp levy) against those the country pack
 *    resolves for the period now: a body whose rule has changed since is flagged;
 *  - the bank check (owner decision 1): the salary bank file's total and record count, as the country pack's bank file
 *    generation previews them (nothing is generated, no Tape ID is used), against the run's own net pay to bank and its
 *    count of people paid by bank; and the run's employee count against its payslips.
 * Prepare: a case per run for its payroll administrators (its status and checks), a case for a period whose regular run
 * has not been started, and one net-swing flag per person for payroll HR's disposition (expected, or a real problem).
 * Verify: a run is done when a person has closed it and the bank check matches (or there is no bank file to check); a
 * run unlocked after close reopens its case. A start case is done when the regular run exists. A flag is done when payroll
 * HR records its disposition; it no longer applies when a reprocess or an approved exclusion takes it under the
 * threshold; it expires when its period is two months past. No model is called. */
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {company,employment,payrollBatch,payslip} from '../../db/schema';
import {terasPayrollSwingDisposition} from '../../db/teras-payroll-cycle-schema';
import {isModuleEnabled} from '../entitlements';
import {anomalyMetrics} from '../payroll-anomaly';
import {DETECTORS} from '../payroll-anomaly-detectors';
import {listCompanyBankProfiles} from '../bank-profile';
import type {StoredPayslipRow} from '../pay-difference';
import {packFor} from '../../localization/registry';
import {BankPaymentFileError} from '../../localization/country-pack';
import {read,unique,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';
import {companyCutOffs,nextPeriod,preSalaryWindows,previousPeriod} from './payroll-inputs';
import {payrollLoopSettingsTx} from './payroll-loop-settings';
import {netSwings,type SwingSummary} from './net-swing';
import type {LoopFacts} from './types';

export const SALARY_PAYROLL_LOOP_VERSION='loop_salary_payroll@v1';
/** The statutory bodies whose rule version the loop shows (the country pack's own body keys). */
export const SALARY_RULE_BODIES=Object.freeze(['epf','socso','eis','pcb','hrdf'] as const);
export type SalaryRuleBody=(typeof SALARY_RULE_BODIES)[number];
export type BankCheck='match'|'total_mismatch'|'count_mismatch'|'not_available'|'blocked'|'not_ready';
export const runKey=(batchId:string)=>`salaryrun:${batchId}`;
export const startKey=(companyId:string,payPeriod:string)=>`salarystart:${companyId}:${payPeriod}`;
export const swingKey=(employmentId:string,payPeriod:string)=>`swing:${employmentId}:${payPeriod}`;
const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
/** The salary file each supported bank account produces (the bank file screen offers the same accounts). */
const SALARY_FILES:readonly Readonly<{country:string;bank:string;currency:string;formatId:string}>[]=Object.freeze([
 {country:'MY',bank:'ocbc_bank',currency:'MYR',formatId:'my.ocbc.salary'}]);
const periodEnd=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const cents=(value:unknown)=>{const raw=String(value??'0');const n=Number(raw);return Number.isFinite(n)?Math.round(n*100):0;};

type Batch=Readonly<{id:string;companyId:string;payPeriod:string;runType:string;runSeq:number;status:'draft'|'processed'|'closed';employeeCount:number;
 stale:boolean;batchDate:string;
 /** The run's own recorded net pay total (payroll_batch.totals.net), as the payroll service stored it. */
 netTotal:unknown}>;

/** The period whose salary cut-off has passed for a company on `today`, and the current month. */
export function salaryPeriods(cutOffEnd:(period:string)=>string,today:string){
 const current=today.slice(0,7);
 const active=cutOffEnd(current)<today?current:previousPeriod(current);
 return {active,current};
}

async function bankCheckFor(sponsor:SessionContext,batch:Batch,country:string):Promise<BankCheck>{
 if(batch.status==='draft'||batch.stale)return 'not_ready';
 const files=packFor(country)?.bankPaymentFiles,format=SALARY_FILES.find(item=>item.country===country);
 if(!files||!format)return 'not_available';
 // The run's own recorded net pay and headcount, and what of it is paid by bank (cash and cheque are not in the file).
 const [own]=await withTenant(sponsor,tx=>tx.select({
  slips:sql<number>`count(*)::int`,
  bankRecords:sql<number>`(count(*) filter (where ${employment.paymentMethod}='bank_transfer' and ${payslip.netPay}>0))::int`,
  otherCents:sql<string>`coalesce(sum(round(${payslip.netPay}*100)) filter (where ${employment.paymentMethod} is distinct from 'bank_transfer'),0)::text`})
  .from(payslip).innerJoin(employment,eq(employment.id,payslip.employmentId)).where(eq(payslip.batchId,batch.id)));
 const bankRecords=Number(own?.bankRecords??0);
 if(!bankRecords)return 'not_available';
 const accounts=(await listCompanyBankProfiles(sponsor,batch.companyId)).filter(item=>item.bank===format.bank&&item.currency===format.currency);
 if(!accounts.length)return 'not_available';
 let preview;
 try{
  preview=await files.preview(sponsor,{companyId:batch.companyId,bankProfileId:accounts[0].id,formatId:format.formatId,periodKey:batch.payPeriod,
   paymentDate:batch.batchDate,runSeq:batch.runSeq,testFile:false,reference:'PAYROLL CHECK'});
 }catch(error){
  if(error instanceof BankPaymentFileError)return 'blocked';
  throw error;
 }
 // The bank file's total against the run's recorded net pay less what is paid outside the bank; both in sen.
 if(preview.totalCents!==cents(batch.netTotal)-Number(own?.otherCents??0))return 'total_mismatch';
 if(preview.recordCount!==bankRecords||batch.employeeCount!==Number(own?.slips??0))return 'count_mismatch';
 return 'match';
}

async function ruleVersionsFor(sponsor:SessionContext,batch:Batch,country:string):Promise<{version:string|null;newer:SalaryRuleBody[]}>{
 const pack=packFor(country);
 return withTenant(sponsor,async tx=>{
  const used=await tx.select({version:sql<string|null>`${payslip.statutory}->>'version'`,components:sql<Record<string,string>|null>`${payslip.statutory}->'componentVersions'`})
   .from(payslip).where(eq(payslip.batchId,batch.id)).groupBy(sql`1`,sql`2`).limit(20);
  const version=used.map(row=>row.version).find((value):value is string=>typeof value==='string'&&value.length>0)??null;
  if(!pack||!used.length)return {version,newer:[]};
  const now=await pack.payroll.loadRulesetResolved(tx,{asOf:periodEnd(batch.payPeriod)});
  const newer=SALARY_RULE_BODIES.filter(body=>{
   const current=(now.components as Readonly<Record<string,{version?:string}|undefined>>|undefined)?.[body]?.version??now.version;
   return used.some(row=>{const stamped=(row.components&&typeof row.components[body]==='string'?row.components[body]:null)??row.version;return !!stamped&&!!current&&stamped!==current;});
  });
  return {version,newer:[...newer]};
 });
}

async function swingsFor(sponsor:SessionContext,companyId:string,period:string,setting:{thresholdBp:number;exclusions:readonly string[]}):Promise<SwingSummary>{
 const periods=[period,previousPeriod(period),previousPeriod(previousPeriod(period)),previousPeriod(previousPeriod(previousPeriod(period)))];
 const rows=await withTenant(sponsor,tx=>tx.select({employmentId:payslip.employmentId,payPeriod:payrollBatch.payPeriod,runType:payrollBatch.runType,runSeq:payrollBatch.runSeq,
  basic:payslip.basicSalary,allowance:payslip.allowance,overtime:payslip.overtimePay,bonus:payslip.bonus,gross:payslip.grossPay,statutory:payslip.statutory,
  otherDeductions:payslip.otherDeductions,totalDeductions:payslip.totalDeductions,net:payslip.netPay,daysWorked:payslip.daysWorked})
  .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
  .where(and(eq(payrollBatch.companyId,companyId),inArray(payrollBatch.payPeriod,periods),inArray(payrollBatch.status,['processed','closed']))));
 const byEmployment=new Map<string,StoredPayslipRow[]>();
 for(const row of rows){
  const list=byEmployment.get(row.employmentId)??[];
  list.push({companyId,company:'',payPeriod:row.payPeriod,runType:row.runType,runSeq:row.runSeq,basic:row.basic,allowance:row.allowance,overtime:row.overtime,
   bonus:row.bonus,gross:row.gross,statutory:row.statutory,otherDeductions:row.otherDeductions,totalDeductions:row.totalDeductions,net:row.net,daysWorked:row.daysWorked});
  byEmployment.set(row.employmentId,list);
 }
 // Only people paid in the period itself are compared.
 for(const [employmentId,list] of byEmployment)if(!list.some(row=>row.payPeriod===period))byEmployment.delete(employmentId);
 return netSwings(byEmployment,{period,companyId,thresholdBp:setting.thresholdBp,exclusions:setting.exclusions});
}

export async function detectSalaryPayroll(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const companies=input.companyIds.filter(companyId=>isModuleEnabled(sponsor,'payroll',companyId));
 const reads=[read('payroll_config.cut_off_day','core/payroll-policy-config.ts#cutOffWindowFor')];
 if(!companies.length)return {observations:[],reads};
 const [config,countries,settings]=await Promise.all([companyCutOffs(sponsor,companies),
  withTenant(sponsor,tx=>tx.select({id:company.id,country:company.country}).from(company).where(inArray(company.id,companies))),
  withTenant(sponsor,tx=>payrollLoopSettingsTx(tx,sponsor.tenantId,companies))]);
 const countryOf=new Map(countries.map(row=>[row.id,row.country]));
 const cutOffOf=(companyId:string,period:string)=>preSalaryWindows(config.get(companyId)??null,period).salary.end;
 const periodsOf=new Map(companies.map(companyId=>[companyId,salaryPeriods(period=>cutOffOf(companyId,period),input.today)]));
 const tracked={runs:new Map<string,(typeof input.tracked)[number]>(),starts:[] as (typeof input.tracked)[number][],swings:[] as (typeof input.tracked)[number][]};
 for(const item of input.tracked){
  if(item.subjectKey.startsWith('salaryrun:'))tracked.runs.set(item.subjectKey.slice('salaryrun:'.length),item);
  else if(item.subjectKey.startsWith('salarystart:'))tracked.starts.push(item);
  else if(item.subjectKey.startsWith('swing:'))tracked.swings.push(item);
 }
 // The runs: every run of each company's active period and current month, and every run already tracked.
 const wanted=unique(companies.flatMap(companyId=>{const p=periodsOf.get(companyId)!;return [p.active,p.current];}));
 const batches:Batch[]=(await withTenant(sponsor,tx=>tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,runType:payrollBatch.runType,
  runSeq:payrollBatch.runSeq,status:payrollBatch.status,employeeCount:payrollBatch.employeeCount,needsRecalcAt:payrollBatch.needsRecalcAt,batchDate:payrollBatch.batchDate,
  netTotal:sql<unknown>`${payrollBatch.totals}->'net'`})
  .from(payrollBatch).where(and(inArray(payrollBatch.companyId,companies),isNull(payrollBatch.historyImportAttemptId),
   sql`(${inArray(payrollBatch.payPeriod,wanted)} or ${tracked.runs.size?inArray(payrollBatch.id,[...tracked.runs.keys()]):sql`false`})`))))
  .map(row=>({id:row.id,companyId:row.companyId,payPeriod:row.payPeriod,runType:row.runType,runSeq:row.runSeq,status:row.status,employeeCount:row.employeeCount,
   stale:row.needsRecalcAt!=null,batchDate:row.batchDate,netTotal:row.netTotal}))
  .filter(row=>{const p=periodsOf.get(row.companyId);return !!p&&(row.payPeriod===p.active||row.payPeriod===p.current||tracked.runs.has(row.id));});
 const observations:LoopObservation[]=[];
 // Net swings, once per company and month that has a processed or closed run.
 const swingMonths=new Map<string,SwingSummary>();
 for(const batch of batches){
  const key=`${batch.companyId}:${batch.payPeriod}`;
  if(batch.status==='draft'||swingMonths.has(key))continue;
  swingMonths.set(key,await swingsFor(sponsor,batch.companyId,batch.payPeriod,settings.get(batch.companyId)!));
 }
 // Each run's case.
 for(const batch of batches){
  const country=countryOf.get(batch.companyId)??'MY';
  const processed=batch.status!=='draft';
  const metrics=processed?await anomalyMetrics(sponsor,{batchId:batch.id}):null;
  const rules=processed?await ruleVersionsFor(sponsor,batch,country):{version:null,newer:[]};
  const bank=await bankCheckFor(sponsor,batch,country);
  const swings=swingMonths.get(`${batch.companyId}:${batch.payPeriod}`)??null;
  const facts:LoopFacts={payPeriod:batch.payPeriod,runType:batch.runType,runSeq:batch.runSeq,status:batch.status,stale:batch.stale,employees:batch.employeeCount,
   detectors:DETECTORS.length,evaluated:!!metrics&&metrics.total>0,exceptions:metrics?metrics.unresolvedFlagged:0,
   changed:swings?.changed??0,flagged:swings?.flagged??0,thresholdBp:settings.get(batch.companyId)!.thresholdBp,
   causes:swings?Object.entries(swings.causes).filter(([,count])=>count>0).map(([kind,count])=>`${kind}:${count}`):[],
   ruleVersion:rules.version?rules.version.slice(0,64):null,rulesNewer:rules.newer,bank};
  const done=batch.status==='closed'&&(bank==='match'||bank==='not_available');
  observations.push(done
   ?{subjectKey:runKey(batch.id),companyId:batch.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'done',resolution:'completed',facts}
   :{subjectKey:runKey(batch.id),companyId:batch.companyId,employmentId:null,recipient:'payroll',state:'open',facts});
 }
 // A tracked run that no longer exists (a draft removed) no longer applies.
 const present=new Set(batches.map(batch=>batch.id));
 for(const [batchId,item] of tracked.runs)if(!present.has(batchId))
  observations.push({subjectKey:item.subjectKey,companyId:item.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'superseded',facts:item.facts});
 // Start: after the cut-off, the active period's regular run, prepared for HR to start.
 for(const companyId of companies){
  const {active}=periodsOf.get(companyId)!;
  const started=batches.some(batch=>batch.companyId===companyId&&batch.payPeriod===active&&batch.runType==='regular');
  const facts={payPeriod:active,cutOff:cutOffOf(companyId,active)};
  observations.push(started
   ?{subjectKey:startKey(companyId,active),companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'done',resolution:'completed',facts}
   :{subjectKey:startKey(companyId,active),companyId,employmentId:null,recipient:'payroll',state:'open',facts});
 }
 for(const item of tracked.starts){
  const period=typeof item.facts.payPeriod==='string'&&PERIOD.test(item.facts.payPeriod)?item.facts.payPeriod:null;
  const p=periodsOf.get(item.companyId);
  if(period&&p&&period<p.active)observations.push({subjectKey:item.subjectKey,companyId:item.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'expired',facts:item.facts});
 }
 // Net-swing flags: one per flagged person and month, for payroll HR's disposition.
 const disposed=new Set<string>();
 const flagPeriods=unique([...swingMonths.keys()].map(key=>key.slice(37)));
 if(flagPeriods.length){
  const rows=await withTenant(sponsor,tx=>tx.select({employmentId:terasPayrollSwingDisposition.employmentId,payPeriod:terasPayrollSwingDisposition.payPeriod})
   .from(terasPayrollSwingDisposition).where(and(eq(terasPayrollSwingDisposition.tenantId,sponsor.tenantId),inArray(terasPayrollSwingDisposition.companyId,companies),
    inArray(terasPayrollSwingDisposition.payPeriod,[...flagPeriods,...unique(tracked.swings.map(item=>String(item.facts.payPeriod??'')).filter(value=>PERIOD.test(value)))]))));
  for(const row of rows)disposed.add(swingKey(row.employmentId,row.payPeriod));
 }
 const flaggedNow=new Set<string>();
 for(const [key,summary] of swingMonths){
  const companyId=key.slice(0,36),period=key.slice(37),setting=settings.get(companyId)!;
  for(const person of summary.people){
   if(!person.flagged||person.swingBp===null||!person.pattern)continue;
   const subjectKey=swingKey(person.employmentId,period);
   flaggedNow.add(subjectKey);
   const facts={payPeriod:period,swingBp:person.swingBp,direction:person.direction,pattern:person.pattern,thresholdBp:setting.thresholdBp,causes:[...person.causes]};
   observations.push(disposed.has(subjectKey)
    ?{subjectKey,companyId,employmentId:person.employmentId,recipient:'hr',state:'closed',closeReason:'done',resolution:'completed',facts}
    :{subjectKey,companyId,employmentId:person.employmentId,recipient:'hr',state:'open',facts});
  }
 }
 for(const item of tracked.swings){
  if(flaggedNow.has(item.subjectKey)||!item.employmentId)continue;
  const period=typeof item.facts.payPeriod==='string'&&PERIOD.test(item.facts.payPeriod)?item.facts.payPeriod:null;
  const base={subjectKey:item.subjectKey,companyId:item.companyId,employmentId:item.employmentId,recipient:'hr' as const,facts:item.facts};
  if(disposed.has(item.subjectKey)){observations.push({...base,state:'closed',closeReason:'done',resolution:'completed'});continue;}
  const p=periodsOf.get(item.companyId);
  if(period&&p&&nextPeriod(period)<p.active){observations.push({...base,state:'closed',closeReason:'expired'});continue;}
  // Recomputed this run and no longer over the threshold (a reprocess, or an approved exclusion).
  if(period&&swingMonths.has(`${item.companyId}:${period}`))observations.push({...base,state:'closed',closeReason:'superseded'});
 }
 reads.push(read('payroll.runs','db/schema.ts#payrollBatch'));
 if(batches.some(batch=>batch.status!=='draft'))reads.push(read('payroll.anomalies','core/payroll-anomaly.ts#anomalyMetrics'),
  read('payroll.pay_difference','core/pay-difference.ts#comparePayPeriods'),read('payroll.rule_versions','localization/country-pack.ts#loadRulesetResolved'),
  read('payroll.bank_file','localization/country-pack.ts#BankPaymentFiles.preview'));
 return {observations,reads};
}
