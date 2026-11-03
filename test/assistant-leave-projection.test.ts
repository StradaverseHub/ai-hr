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
  if(!('eligibleDays' in result)||!('transactions' in result))throw Error('Visible Mine projection must retain its documented decomposition.');
  expect(result.displayEntitlementDays).toBe(1102);expect(result.eligibleDays).toBe(1101);expect(result.totalAvailable).toBe(9901);
  expect(result.transactions?.rows[0].days).toBe(2201);expect(result.withheld).toBe(false);
 });
 it('does not map accrued or ledger balance to unrelated ESS rows',()=>{
  const row={leaveTypeId:'fictional',leaveType:'Fictional annual',accrued:111,taken:222,pending:333,balance:444,available:555,essView:resolveEssView({available:false})};
  const result=projectMineLeaveBalance(row);expect(result).toMatchObject({taken:222,pending:333,available:null,notShown:['available','sharedPoolName','accrued','balance']});
  expect(result).not.toHaveProperty('accrued');expect(result).not.toHaveProperty('balance');
 });
});
// Eval 41665308001, emp-balance-1: beside a shown Medical Leave figure the model read the row-wide withheld:true as "the available
// amount isn't shown". A balance row now names, field by field, what it does not show; the expected lists are written out here.
const DECOMPOSITION=['accrued','balance'];
const NOT_SHOWN:Record<string,string[]>={eligible:DECOMPOSITION,ytdEntitled:DECOMPOSITION,broughtForward:DECOMPOSITION,adjustment:DECOMPOSITION,total:DECOMPOSITION,
 taken:['taken',...DECOMPOSITION],pendingApproval:['pending',...DECOMPOSITION],forfeited:DECOMPOSITION,available:['available','sharedPoolName',...DECOMPOSITION]};
const balanceRow=(essView=resolveEssView(null))=>({leaveTypeId:'fictional',leaveType:'Fictional annual',accrued:111,taken:222,pending:333,balance:444,available:555,
 essView,sharedBalance:{sourceLeaveTypeName:'Fictional pool'}});
describe('a Mine leave balance row names exactly what it does not show',()=>{
 it('names nothing on a fully shown row, keeps every figure and carries no row-wide flag',()=>{
  expect(projectMineLeaveBalance(balanceRow())).toEqual({leaveTypeId:'fictional',leaveType:'Fictional annual',taken:222,pending:333,available:555,
   sharedPoolName:'Fictional pool',accrued:111,balance:444,notShown:[]});
 });
 it.each(ESS_VIEW_COMPONENT_KEYS)('with %s hidden, notShown lists exactly the nulled or left-out fields and every other figure is kept',key=>{
  const full=projectMineLeaveBalance(balanceRow()) as Record<string,unknown>,result=projectMineLeaveBalance(balanceRow(resolveEssView({[key]:false}))) as Record<string,unknown>;
  expect(result.notShown).toEqual(NOT_SHOWN[key]);expect(result).not.toHaveProperty('withheld');
  for(const field of Object.keys(full).filter(name=>name!=='notShown')){
   if(NOT_SHOWN[key].includes(field))expect(result[field]??null,field).toBeNull();else expect(result[field],field).toEqual(full[field]);
  }
  for(const field of DECOMPOSITION)expect(result).not.toHaveProperty(field);
 });
 it('Medical Leave hiding only its brought-forward and forfeited lines keeps its available figure and names accrued and balance',()=>{
  const result=projectMineLeaveBalance({...balanceRow(resolveEssView({broughtForward:false,forfeited:false})),leaveType:'Medical Leave',available:11.5,sharedBalance:null});
  expect(result).toEqual({leaveTypeId:'fictional',leaveType:'Medical Leave',taken:222,pending:333,available:11.5,sharedPoolName:null,notShown:['accrued','balance']});
 });
 it('leaves the entitlement breakdown projection as it was: its own withheld flag, no notShown',()=>{
  const row=breakdown();row.essView=resolveEssView({broughtForward:false});const result=projectMineLeaveEntitlement(row);
  expect(result.withheld).toBe(true);expect(result).not.toHaveProperty('notShown');
 });
});
