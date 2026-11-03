/** ADR-0170 step 4 — "Why do I have 14 days?" for one of the caller's own leave types.
 *
 * The answer is core/read.ts leaveEntitlementBreakdown, the one owner the employee's leave summary reads,
 * projected through core/assistant-leave-projection.ts projectMineLeaveEntitlement so the company's Employee
 * Leave View settings withhold here exactly what they withhold on the employee's own page. Beside it, the
 * owner's own proration working (`entitlement`: table allowance, part-year days, divisor, rounding), shown only
 * where the entitlement figure itself is shown. The leave type is named, not handed over as an id: it is
 * resolved against the caller's own balances, so a type the caller does not hold is never read. Every
 * employment that holds the type answers separately, as leave_entitlement_explain does. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {withAssistantRead} from '../assistant-read-session';
import {projectMineLeaveEntitlement} from '../assistant-leave-projection';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const normal=(value:string)=>value.trim().toLowerCase().replace(/\s+/g,' ');
/** Exact name first; otherwise the one own type whose name contains the words asked for. */
export function matchLeaveType(asked:string,types:ReadonlyMap<string,string>):string|null{
 const wanted=normal(asked);if(!wanted)return null;
 const exact=[...types].filter(([,name])=>normal(name)===wanted);if(exact.length)return exact[0][0];
 const partial=[...types].filter(([,name])=>normal(name).includes(wanted)||wanted.includes(normal(name)));
 return partial.length===1?partial[0][0]:null;
}

export async function explainOwnLeaveEntitlement(ctx:SessionContext,input:Readonly<{leave_type?:string;as_of?:string}>):Promise<ExplainerOutcome>{
 if(typeof input.leave_type!=='string'||!input.leave_type.trim())return refuse('invalid_input','`leave_type` must name one of the asking person\'s leave types.');
 const asOf=input.as_of??todayInKualaLumpur();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||new Date(asOf+'T00:00:00Z').toISOString().slice(0,10)!==asOf)return refuse('invalid_input','`as_of` must be a real calendar date in YYYY-MM-DD form.');
 return withAssistantRead(ctx,'leave',async(read):Promise<ExplainerOutcome>=>{
  const employments=await read.myEmployments();
  if(!employments.length)return refuse('no_employment','The asking user has no employee record, so they hold no entitlement.');
  const types=new Map<string,string>();
  for(const employment of employments)for(const row of await read.leaveBalances(employment.employmentId,undefined,{includeArchived:false}))types.set(row.leaveTypeId,row.leaveType);
  const typeId=matchLeaveType(input.leave_type!,types);
  if(!typeId)return{...refuse('no_data','The asking person holds no leave type by that name, or the name matches more than one. Ask which one they mean.'),leaveTypes:[...new Set(types.values())].sort()};
  const explained=[];
  for(const employment of employments){
   const breakdown=await read.leaveEntitlementBreakdown(employment.employmentId,typeId,asOf);if(!breakdown)continue;
   const mine=projectMineLeaveEntitlement(breakdown);
   // The proration working is the entitlement figure's own working: hidden whenever that figure is, and then named in notShown.
   const hidden=mine.notShown.includes('displayEntitlementDays');
   explained.push({company:employment.company,...mine,notShown:hidden?[...mine.notShown,'proration']:mine.notShown,proration:hidden?null:{...breakdown.entitlement}});
  }
  if(!explained.length)return refuse('no_data','That leave type carries no entitlement on the asking person\'s own record.');
  return{ok:true,leaveType:types.get(typeId),asOf,employments:explained,
   provenance:provenance('core/read.ts#leaveEntitlementBreakdown','Not published: the entitlement table version is not returned by the breakdown yet.','/leave',
    'Figures are the leave summary\'s own; notShown names the parts the company hides from employees, and every figure present is real. The full-year allowance comes from the entitlement table that applied; a part year is prorated by days of service.')};
 });
}
