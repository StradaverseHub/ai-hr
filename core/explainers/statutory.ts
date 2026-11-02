/** ADR-0170 step 4 — "Why is my EPF / PCB this much?" over the caller's own released payslips.
 *
 * The answer is core/statutory-explain.ts explainStatutory (and statutoryProvenance through it) applied to the
 * payslip's OWN stored `statutory` blob: the amounts and wage bases the run wrote, never today's tables. The
 * read is the Assistant read facade (core/assistant-read-session.ts) as the caller, with the same release
 * filter my_payslip_summary applies, so an unreleased payslip is never explained. Effective rates are turned
 * into percentages for wording (the owner's fraction × 100, two decimals); no other arithmetic happens here.
 * Operator reasons for hand-set figures are typed free text and are never returned. */
import type {SessionContext} from '../../db/client';
import {withAssistantRead} from '../assistant-read-session';
import {explainStatutory,type StatutoryItemExplanation} from '../statutory-explain';
import {STATUTORY_ITEMS} from '../semantic-model/entities-explain';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const NAMES:Readonly<Record<(typeof STATUTORY_ITEMS)[number],string>>={epf:'EPF',socso:'SOCSO',skbbk:'SKBBK',eis:'EIS',hrdf:'HRDF',pcb:'PCB'};
const PER_PERIOD_RUNS=4;
const percent=(rate:number|null)=>rate===null?null:Math.round(rate*10_000)/100;
const item=(row:StatutoryItemExplanation)=>({key:row.key,name:NAMES[row.key],ruleKind:row.ruleKind,totalBase:row.totalBase,additionalBase:row.additionalBase,
 employeeReported:row.employeeReported,employeeTakeHome:row.employeeTakeHome,employerBorne:row.employerBorne,employer:row.employer,
 effectiveEmployeeRatePercent:percent(row.effectiveEmployeeRate),effectiveEmployerRatePercent:percent(row.effectiveEmployerRate),
 workingNotRecorded:row.workingNotRecorded,setBy:row.provenance.source,systemEmployee:row.provenance.employee?.system??null,systemEmployer:row.provenance.employer?.system??null});

export async function explainOwnPayslipStatutory(ctx:SessionContext,input:Readonly<{period?:string;item?:string}>):Promise<ExplainerOutcome>{
 if(input.period!==undefined&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period))return refuse('invalid_input','`period` must be a month as YYYY-MM.');
 if(input.item!==undefined&&!(STATUTORY_ITEMS as readonly string[]).includes(input.item))return refuse('invalid_input','`item` must be one of '+STATUTORY_ITEMS.join(', ')+'.');
 return withAssistantRead(ctx,'payroll',async(read):Promise<ExplainerOutcome>=>{
  const ids=(await read.myEmploymentIdsAll()).map(row=>row.employmentId);
  if(!ids.length)return refuse('no_employment','The asking user has no employee record, so they have no payslips.');
  // Released only: the employee's own payslip page shows nothing else.
  const released=(await read.myPayslips(ids)).filter(row=>row.released);
  const periods=[...new Set(released.map(row=>row.payPeriod))].sort().reverse();
  if(!periods.length)return refuse('no_data','The asking user has no released payslips.');
  const period=input.period??periods[0];
  const runs=released.filter(row=>row.payPeriod===period).sort((a,b)=>a.runSeq-b.runSeq);
  if(!runs.length)return{...refuse('no_data',`The asking user has no released payslip for ${period}.`),availablePeriods:periods.slice(0,12)};
  return{ok:true,period,availablePeriods:periods.slice(0,12),
   payslips:runs.slice(0,PER_PERIOD_RUNS).map(row=>{const explanation=explainStatutory(row.statutory,row.runType);
    return{company:row.company,payPeriod:row.payPeriod,runType:row.runType,ruleVersion:explanation.rulesetVersion,basesNotRecorded:explanation.basesNotRecorded,
     basesCoverWholeMonth:explanation.basesCoverWholeMonth,items:explanation.items.filter(entry=>!input.item||entry.key===input.item).map(item),totals:explanation.totals};}),
   ...(runs.length>PER_PERIOD_RUNS?{truncated:true,totalRows:runs.length}:{}),
   provenance:provenance('core/statutory-explain.ts#explainStatutory','The statutory ruleset version the run stamped on the payslip (core/payslip-recompute.ts payslipProvenance).','/me/payslip',
    'Read from the payslip\'s own recorded working, never recomputed. Schedule items (EPF, SOCSO, SKBBK, EIS) are looked up by wage band, so the effective rate is a check figure, not the rule. PCB follows LHDN\'s MTD calculation.')};
 });
}
