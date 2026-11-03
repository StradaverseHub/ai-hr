/** AI v2 W8 loop 2 — payroll inputs readiness.
 *
 * Detect: for each company in scope that uses payroll, the next salary inputs cut-off (the company's cut_off_day,
 * resolved by the payroll owner's cutOffWindowFor; no cut-off day means month-end) falls within
 * PAYROLL_INPUTS_LEAD_DAYS, and the payroll readiness owner's existing checks (packs/payroll/service payrollReadiness)
 * find something that blocks the run for that pay period (the owner's own verdict: not `ready`).
 * Diagnose: every check that is not ready, blockers first, and how many of them block the run.
 * Prepare: a Today card for the company's payroll administrators listing what is missing, opening the full readiness
 * report where each gap is fixed. Nothing is changed by the loop.
 * Verify: done when the owner reports the pay period ready (nothing blocks the run) before the cut-off; expired when
 * the cut-off passed first (never credited). A new blocker before the cut-off reopens the case. Warnings alone are
 * listed on an open card but neither open nor hold one: the owner says payroll can run with them.
 * The policy-level custom cut-off (a payroll policy's own anchor day) is not read here: the company's own cut-off day
 * is the payroll cut-off this loop prepares for. */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {companyPayrollConfig} from '../../db/schema';
import {isModuleEnabled} from '../entitlements';
import {cutOffWindowFor,payrollReadiness} from '../../packs/payroll/service';
import {read,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';

export const PAYROLL_INPUTS_LEAD_DAYS=7;
export const PAYROLL_INPUTS_LOOP_VERSION='loop_payroll_inputs@v1';
const OWNER='core/payroll-readiness.ts#payrollReadiness';
export const payrollKey=(companyId:string,payPeriod:string)=>`payroll:${companyId}:${payPeriod}`;
const DAY_MS=86_400_000;
const daysBetween=(from:string,to:string)=>Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY_MS);
const nextPeriod=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;};

export async function detectPayrollInputs(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const companies=input.companyIds.filter(companyId=>isModuleEnabled(sponsor,'payroll',companyId));
 const reads=[read('payroll_config.cut_off_day','core/payroll-policy-config.ts#cutOffWindowFor')];
 if(!companies.length)return {observations:[],reads};
 const configs=await withTenant(sponsor,tx=>tx.select({companyId:companyPayrollConfig.companyId,cutOffDay:companyPayrollConfig.cutOffDay})
  .from(companyPayrollConfig).where(and(eq(companyPayrollConfig.tenantId,sponsor.tenantId),inArray(companyPayrollConfig.companyId,companies))));
 const cutOffDay=new Map(configs.map(row=>[row.companyId,row.cutOffDay]));
 const cutOffOf=(companyId:string,period:string)=>cutOffWindowFor('salary',null,{cutOffDay:cutOffDay.get(companyId)??null},period).end;
 // The subjects to check: each company's next cut-off within the lead, and every tracked pay period still before its cut-off.
 const subjects=new Map<string,{companyId:string;payPeriod:string;cutOff:string}>();
 const observations:LoopObservation[]=[];
 for(const companyId of companies){
  let period=input.today.slice(0,7),cutOff=cutOffOf(companyId,period);
  if(cutOff<input.today){period=nextPeriod(period);cutOff=cutOffOf(companyId,period);}
  if(daysBetween(input.today,cutOff)<=PAYROLL_INPUTS_LEAD_DAYS)subjects.set(payrollKey(companyId,period),{companyId,payPeriod:period,cutOff});
 }
 for(const item of input.tracked){
  const payPeriod=typeof item.facts.payPeriod==='string'?item.facts.payPeriod:null;
  if(!payPeriod||!/^\d{4}-\d{2}$/.test(payPeriod))continue;
  const cutOff=companies.includes(item.companyId)?cutOffOf(item.companyId,payPeriod):typeof item.facts.cutOff==='string'?item.facts.cutOff:null;
  if(!cutOff)continue;
  if(cutOff<input.today){
   observations.push({subjectKey:item.subjectKey,companyId:item.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'expired',facts:item.facts});
   continue;
  }
  if(companies.includes(item.companyId))subjects.set(item.subjectKey,{companyId:item.companyId,payPeriod,cutOff});
 }
 for(const [subjectKey,subject] of subjects){
  const readiness=await payrollReadiness(sponsor,{companyId:subject.companyId,payPeriod:subject.payPeriod});
  const missing=[...readiness.checks.filter(check=>check.status==='blocker'),...readiness.checks.filter(check=>check.status==='warning')];
  const facts={payPeriod:subject.payPeriod,cutOff:subject.cutOff,missing:missing.map(check=>check.key),
   blockers:readiness.blockers,warnings:readiness.warnings};
  observations.push(!readiness.ready
   ?{subjectKey,companyId:subject.companyId,employmentId:null,recipient:'payroll',state:'open',facts}
   :{subjectKey,companyId:subject.companyId,employmentId:null,recipient:'payroll',state:'closed',closeReason:'done',resolution:'completed',facts});
 }
 if(subjects.size)reads.push(read('payroll.readiness',OWNER));
 return {observations,reads};
}
