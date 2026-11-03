/** AI v2 P2-2a — the Pre-salary loop (the Phase 1 W8 "payroll inputs readiness" loop, absorbed: same id, switch, sponsor
 * and cases; owner decisions, payroll-cycle loops, items 3, 4 and 6).
 *
 * Runs continuously from the start of the payroll period to its cut-off, at the interval each company chose (hourly,
 * twice daily or daily; default daily: core/loops/payroll-loop-settings.ts, applied by the runner's due check).
 * Detect: for each company in scope that uses payroll, the pay period whose salary cut-off is next (the company's
 * cut_off_day, resolved by the payroll owner's cutOffWindowFor; no cut-off day means month-end), and every input check
 * (core/loops/pre-salary-checks.ts): timesheets, overtime, leave, claims, joiners and leavers, statutory and bank details,
 * pay changes, and the payroll readiness owner's set-up blockers and warnings. Each input type is read over its own
 * cut-off window (attendance, overtime, claim and unpaid-leave cut-off days where the company set them).
 * Diagnose: each check's status and counts, and the readiness checks that are not ready, blockers first.
 * Prepare: one case per company and pay period for its payroll administrators, kept from the start of the period, which
 * the Payroll cycle page shows and which becomes a Today card in the last PAYROLL_INPUTS_LEAD_DAYS before the cut-off.
 * Each check links to its owner page; the Phase 1 loops' own cards (missed clock-outs, missing employee data) are counted
 * where they belong. Nothing is changed by the loop.
 * Verify: done when no check is open or waiting (no blocker left) before the cut-off; expired when the cut-off passed
 * first (never credited). A new blocker before the cut-off reopens the case. Warnings alone neither open nor hold it.
 * Bonus and off-cycle runs share the month's inputs, so the same case covers them (owner decision 3). */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {companyPayrollConfig} from '../../db/schema';
import {isModuleEnabled} from '../entitlements';
import {cutOffWindowFor} from '../../packs/payroll/service';
import {read,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';
import {encodeCheck,isBlocking,preSalaryChecks,type PreSalaryWindows} from './pre-salary-checks';
import {nextPeriod} from './period';

export {PAYROLL_INPUTS_LEAD_DAYS,daysBetween,nextPeriod,previousPeriod} from './period';
export const PAYROLL_INPUTS_LOOP_VERSION='loop_payroll_inputs@v2';
const OWNER='core/loops/pre-salary-checks.ts#preSalaryChecks';
export const payrollKey=(companyId:string,payPeriod:string)=>`payroll:${companyId}:${payPeriod}`;

export type CompanyCutOffs=Readonly<{cutOffDay:number|null;overtimeCutOffDay:number|null;claimCutOffDay:number|null;unpaidLeaveCutOffDay:number|null;
 attendanceCutOffDay:number|null;payDay:number|null}>;
/** Each input type's window for a pay period, from the company's own cut-off days. */
export function preSalaryWindows(config:CompanyCutOffs|null,payPeriod:string):PreSalaryWindows{
 const cfg=config??{cutOffDay:null,overtimeCutOffDay:null,claimCutOffDay:null,unpaidLeaveCutOffDay:null,attendanceCutOffDay:null,payDay:null};
 return Object.freeze({salary:cutOffWindowFor('salary',null,cfg,payPeriod),attendance:cutOffWindowFor('attendance',null,cfg,payPeriod),
  overtime:cutOffWindowFor('overtime',null,cfg,payPeriod),claim:cutOffWindowFor('claim',null,cfg,payPeriod),leave:cutOffWindowFor('leave',null,cfg,payPeriod)});
}
/** The pay period whose salary cut-off is today or next. */
export function upcomingPeriod(config:CompanyCutOffs|null,today:string){
 let period=today.slice(0,7),windows=preSalaryWindows(config,period);
 if(windows.salary.end<today){period=nextPeriod(period);windows=preSalaryWindows(config,period);}
 return {period,windows};
}

export async function companyCutOffs(sponsor:SessionContext,companyIds:readonly string[]):Promise<Map<string,CompanyCutOffs>>{
 if(!companyIds.length)return new Map();
 const rows=await withTenant(sponsor,tx=>tx.select({companyId:companyPayrollConfig.companyId,cutOffDay:companyPayrollConfig.cutOffDay,
  overtimeCutOffDay:companyPayrollConfig.overtimeCutOffDay,claimCutOffDay:companyPayrollConfig.claimCutOffDay,unpaidLeaveCutOffDay:companyPayrollConfig.unpaidLeaveCutOffDay,
  attendanceCutOffDay:companyPayrollConfig.attendanceCutOffDay,payDay:companyPayrollConfig.payDay}).from(companyPayrollConfig)
  .where(and(eq(companyPayrollConfig.tenantId,sponsor.tenantId),inArray(companyPayrollConfig.companyId,[...companyIds]))));
 return new Map(rows.map(row=>[row.companyId,row]));
}

export async function detectPayrollInputs(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const companies=input.companyIds.filter(companyId=>isModuleEnabled(sponsor,'payroll',companyId));
 const reads=[read('payroll_config.cut_off_day','core/payroll-policy-config.ts#cutOffWindowFor')];
 if(!companies.length)return {observations:[],reads};
 const config=await companyCutOffs(sponsor,companies);
 // The subjects: each company's upcoming pay period, and every tracked pay period still before its cut-off.
 const subjects=new Map<string,{companyId:string;payPeriod:string;windows:PreSalaryWindows}>();
 const observations:LoopObservation[]=[];
 for(const companyId of companies){
  const {period,windows}=upcomingPeriod(config.get(companyId)??null,input.today);
  subjects.set(payrollKey(companyId,period),{companyId,payPeriod:period,windows});
 }
 for(const item of input.tracked){
  const payPeriod=typeof item.facts.payPeriod==='string'?item.facts.payPeriod:null;
  if(!payPeriod||!/^\d{4}-\d{2}$/.test(payPeriod))continue;
  const windows=companies.includes(item.companyId)?preSalaryWindows(config.get(item.companyId)??null,payPeriod):null;
  const cutOff=windows?.salary.end??(typeof item.facts.cutOff==='string'?item.facts.cutOff:null);
  if(!cutOff)continue;
  if(cutOff<input.today){
   observations.push({subjectKey:item.subjectKey,companyId:item.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'expired',facts:item.facts});
   continue;
  }
  if(windows)subjects.set(item.subjectKey,{companyId:item.companyId,payPeriod,windows});
 }
 for(const [subjectKey,subject] of subjects){
  const result=await preSalaryChecks(sponsor,{companyId:subject.companyId,payPeriod:subject.payPeriod,today:input.today,windows:subject.windows});
  const blocking=result.checks.filter(isBlocking);
  const facts={payPeriod:subject.payPeriod,cutOff:subject.windows.salary.end,from:subject.windows.salary.start,
   missing:[...result.readiness.missing],blockers:result.readiness.blockers,warnings:result.readiness.warnings,
   checks:result.checks.map(encodeCheck),blocking:blocking.map(item=>item.key)};
  observations.push(blocking.length
   ?{subjectKey,companyId:subject.companyId,employmentId:null,recipient:'payroll',state:'open',facts}
   :{subjectKey,companyId:subject.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'done',resolution:'completed',facts});
 }
 if(subjects.size)reads.push(read('payroll.pre_salary_checks',OWNER),read('payroll.readiness','core/payroll-readiness.ts#payrollReadiness'),
  read('attendance.days','packs/attendance/service.ts#attendanceForEmploymentsRange'),read('record.readiness','core/record-readiness.ts#readinessSnapshot'));
 return {observations,reads};
}
