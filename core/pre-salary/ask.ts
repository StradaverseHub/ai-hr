/** AI v2 Phase 2, P2-3 — the Ask read my_payroll_readiness (core/semantic-model/entities-payroll-readiness.ts).
 *
 * The checklist as the model may read it: core/pre-salary/person-items.ts readMyPayrollReadiness, run as the caller,
 * projected to the declared fields. Each item keeps its page (the path only: a link carrying a record id stays in the
 * product), and approvals are counted by kind, so no other person is named. The harness discloses the result by the
 * entity's classes; nothing here decides what the person may see. */
import type {SessionContext} from '../../db/client';
import {provenance,refuse,type ExplainerOutcome} from '../explainers/outcome';
import {readMyPayrollReadiness} from './person-items';
import type {PayrollItem} from '../../lib/pre-salary/items';

/** What this checklist cannot check, because the product records none of it. Said plainly rather than implied done. */
export const NOT_COVERED=Object.freeze(['shift swaps and roster gaps','timesheet sign-off','overtime worked but not yet applied for','tax relief (TP1) and dependant details','pay changes to acknowledge']);
const path=(href:string)=>href.split(/[?#]/)[0]||'/';
/** The page an item is acted on, without any record in its address: a letter or notice opens from its list, and a
 * missed clock-out's Confirm card waits on Today. */
const pageOf=(row:PayrollItem)=>row.action.kind==='confirm'?'/':row.kind==='letter_acknowledge'?'/me/letters':row.kind==='notice_acknowledge'?'/notices':path(row.action.href);

export async function askMyPayrollReadiness(ctx:SessionContext,scope:Readonly<{companyId:string;locale?:string}>):Promise<ExplainerOutcome>{
 const result=await readMyPayrollReadiness(ctx,{locale:scope.locale});
 if(!result)return refuse('no_data','Payroll is not in use here, so there is no payroll checklist.');
 const items=result.items.map((row:PayrollItem)=>({group:row.group,kind:row.kind,state:row.state,date:row.date,...(row.endDate!==undefined?{endDate:row.endDate}:{}),due:row.due,
  ...(row.label!==undefined?{label:row.label}:{}),page:pageOf(row),confirmCard:row.action.kind==='confirm'}));
 const counted=new Map<string,{kind:string;count:number;due:string|null;page:string}>();
 for(const row of result.approvals){const hit=counted.get(row.kind);if(hit)hit.count++;else counted.set(row.kind,{kind:row.kind,count:1,due:row.due,page:path(row.action.href)});}
 return{ok:true,period:{...result.period},items,approvals:[...counted.values()],groups:result.groups.map(row=>({...row})),notCovered:[...NOT_COVERED],
  provenance:provenance('core/pre-salary/person-items.ts#readMyPayrollReadiness','Not applicable: pending records, not a versioned rule; the cut-off is the payroll service\'s own (cutOffWindowFor).','/',
   result.period.cutOff?'The person\'s own records only, as each service holds them; no pay figure is read.'
    :'The person\'s own records only; their role cannot read the company\'s payroll settings, so no cut-off date is known: say so, never guess one.')};
}
