import {describe,expect,it} from 'vitest';
import {projectMineLeaveBalance,projectMineLeaveEntitlement} from '../core/assistant-leave-projection';
import {resolveEssView,ESS_VIEW_COMPONENT_KEYS} from '../core/ess-view';
import type {LeaveEntitlementBreakdown} from '../core/read';
const breakdown=()=>({leaveType:'Fictional annual',cycleStart:'2026-01-01',eligibleDays:1101,entitlement:{displayEntitlementDays:1102},
 entitlementStatus:'generated',entitlementTemplateName:'Fictional template',currentYearEntitlement:2201,currentYearEntitlementRounded:2202,
 broughtForward:3301,adjustments:4401,totalEntitlement:5501,takenThisCycle:6601,pendingApproval:7701,forfeitedThisCycle:8801,
 carryForwardExpiryDate:'2026-03-31',totalAvailable:9901,monthlyAccruedToDate:2203,carriedForward:3302,carryForwardRemaining:3303,
 configAdjustments:4402,systemAdjustments:4403,balance:5502,transactions:[{effectiveOn:'2026-01-01',entryType:'accrual',days:2201,sourceRequestId:null,reason:'fictional'}],
 essView:resolveEssView(null)}) as unknown as LeaveEntitlementBreakdown;
const mapping={eligible:'displayEntitlementDays',ytdEntitled:'currentYearEntitlement',broughtForward:'broughtForward',adjustment:'adjustments',total:'totalEntitlement',
 taken:'takenThisCycle',pendingApproval:'pendingApproval',forfeited:'forfeitedThisCycle',available:'totalAvailable'} as const;
describe('Mine leave disclosure respects actual canonical ESS keys',()=>{
 it.each(ESS_VIEW_COMPONENT_KEYS)('withholds %s before any model/source fingerprint and removes raw bypass decompositions',key=>{
  const row=breakdown();row.essView=resolveEssView({[key]:false});const result=projectMineLeaveEntitlement(row);
  expect(result[mapping[key]]).toBeNull();expect(result.withheld).toBe(true);
  for(const field of ['transactions','balance','eligibleDays','monthlyAccruedToDate','configAdjustments','systemAdjustments','carriedForward','carryForwardRemaining'])expect(result).not.toHaveProperty(field);
  for(const allowed of ESS_VIEW_COMPONENT_KEYS.filter(value=>value!==key))expect(result[mapping[allowed]]).not.toBeNull();
 });
 it('keeps exact visible values, including the canonical prorated displayed entitlement, without arithmetic',()=>{
  const row=breakdown(),result=projectMineLeaveEntitlement(row);
  expect(result.displayEntitlementDays).toBe(1102);expect(result.eligibleDays).toBe(1101);expect(result.totalAvailable).toBe(9901);
  expect(result.transactions?.rows[0].days).toBe(2201);expect(result.withheld).toBe(false);
 });
 it('does not map accrued or ledger balance to unrelated ESS rows',()=>{
  const row={leaveTypeId:'fictional',leaveType:'Fictional annual',accrued:111,taken:222,pending:333,balance:444,available:555,essView:resolveEssView({available:false})};
  const result=projectMineLeaveBalance(row);expect(result).toMatchObject({taken:222,pending:333,available:null,withheld:true});
  expect(result).not.toHaveProperty('accrued');expect(result).not.toHaveProperty('balance');
 });
});
