/** Independent canonical-field allowlists, authored UNRUN. No model text is accepted as a fact input. */
import {describe,expect,it} from 'vitest';
import {GROUNDED_TOOL_MODULES,presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
const poison='MODEL_INVENTED_PRIVATE_POISON_987654';
describe('typed presentation for existing Assistant tools',()=>{
 it('copies selected current work profile fields without accepting extra model/salary/bank fields',()=>{
  const result=presentGroundedToolOutcome('employee_profile',{ok:true,employee:{name:'Canonical name',employeeCode:'EMP-5',company:'Canonical company',gross:poison,bank:poison},answer:poison});
  expect(JSON.stringify(result)).toContain('EMP-5');expect(JSON.stringify(result)).not.toContain(poison);
 });
 it('preserves Mine field withholding instead of presenting hidden balances or raw decomposition',()=>{
  const result=presentGroundedToolOutcome('leave_entitlement_explain',{ok:true,asOf:'2026-10-01',employments:[{company:'Canonical company',leaveType:'Annual',withheld:true,
   displayEntitlementDays:12,currentYearEntitlement:null,broughtForward:null,adjustments:null,totalEntitlement:null,takenThisCycle:2,pendingApproval:null,forfeitedThisCycle:null,totalAvailable:null,
   transactions:poison,balance:poison}]});
  expect(result?.cards[0].facts.filter(row=>row.format==='number').map(row=>[row.field,row.value])).toEqual([['displayEntitlementDays',12],['taken',2]]);
  expect(result?.cards[0].withheld).toBe(true);expect(JSON.stringify(result)).not.toContain(poison);
 });
 it('uses actual current date matches without turning best-effort holiday labels into asserted calendar facts',()=>{
  const result=presentGroundedToolOutcome('upcoming_holidays',{ok:true,holidays:[{date:'2026-10-01',name:poison}]});
  expect(result?.cards[0].facts).toEqual([{field:'date',value:'2026-10-01',format:'date'}]);expect(JSON.stringify(result)).not.toContain(poison);
 });
 it('presents the canonical large-group count branch without inventing employee identities or recalculating totals',()=>{
  const result=presentGroundedToolOutcome('who_is_away',{ok:true,mode:'count',from:'2026-10-01',to:'2026-10-10',personCount:37,approvedOnFromDate:4,hiddenRows:poison});
  expect(result?.cards[0].facts.find(row=>row.field==='personCount')?.value).toBe(37);
  expect(result?.cards[0].facts.find(row=>row.field==='approvedOnFromDate')?.value).toBe(4);expect(JSON.stringify(result)).not.toContain(poison);
 });
 it('keeps stored numeric zero distinct from missing values and does no pay arithmetic or currency substitution',()=>{
  const result=presentGroundedToolOutcome('my_payslip_summary',{ok:true,rows:[{payPeriod:'2026-10',company:'Canonical company',gross:0,deductions:null,net:7.25}],truncated:false});
  expect(result?.cards[0].facts.find(row=>row.field==='gross')?.value).toBe(0);expect(result?.cards[0].facts.find(row=>row.field==='deductions')?.value).toBeNull();
  expect(result?.cards[0].facts.find(row=>row.field==='net')?.value).toBe(7.25);expect(result?.cards[0].facts.find(row=>row.field==='currency')?.value).toBeNull();
 });
 it('does not certify old money comparisons or unbound team summaries as safe typed facts',()=>{
  expect(presentGroundedToolOutcome('my_pay_change',{ok:true,delta:poison})).toBeNull();expect(presentGroundedToolOutcome('team_leave_summary',{ok:true,summary:poison})).toBeNull();
  expect(Object.keys(GROUNDED_TOOL_MODULES)).toHaveLength(12);
 });
});
