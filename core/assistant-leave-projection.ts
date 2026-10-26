/** Mine disclosure projection, before model/provider/source fingerprints. Pure; no read or effect API.
 * Each summary field uses its existing ESS key. Unmapped legacy decomposition is withheld whenever a
 * summary row is hidden: ledger/split aliases must not bypass the actual Mine display boundary.
 */
import { ESS_VIEW_COMPONENT_KEYS,type ResolvedEssView } from './ess-view';
import type { LeaveEntitlementBreakdown } from './read';
type Balance={leaveTypeId:string;leaveType:string;accrued:number;taken:number;pending:number;balance:number;available:number;
 essView:ResolvedEssView;sharedBalance?:{sourceLeaveTypeName?:string|null}|null};
const shown=(view:ResolvedEssView,key:keyof ResolvedEssView)=>view[key]!==false;
const allShown=(view:ResolvedEssView)=>ESS_VIEW_COMPONENT_KEYS.every(key=>shown(view,key));
export function projectMineLeaveBalance(row:Balance){
 const direct={leaveTypeId:row.leaveTypeId,leaveType:row.leaveType,
  taken:shown(row.essView,'taken')?row.taken:null,pending:shown(row.essView,'pendingApproval')?row.pending:null,
  available:shown(row.essView,'available')?row.available:null,
  sharedPoolName:shown(row.essView,'available')?row.sharedBalance?.sourceLeaveTypeName??null:null};
 return allShown(row.essView)?{...direct,accrued:row.accrued,balance:row.balance,withheld:false}:
  {...direct,withheld:true};
}
export function projectMineLeaveEntitlement(b:LeaveEntitlementBreakdown){
 const direct={leaveType:b.leaveType,cycleStart:b.cycleStart,
  entitlementStatus:b.entitlementStatus,entitlementTemplateName:b.entitlementTemplateName,eligibility:b.eligibility??null,
  displayEntitlementDays:shown(b.essView,'eligible')?b.entitlement.displayEntitlementDays:null,
  currentYearEntitlement:shown(b.essView,'ytdEntitled')?b.currentYearEntitlement:null,
  currentYearEntitlementRounded:shown(b.essView,'ytdEntitled')?b.currentYearEntitlementRounded:null,
  broughtForward:shown(b.essView,'broughtForward')?b.broughtForward:null,
  adjustments:shown(b.essView,'adjustment')?b.adjustments:null,
  totalEntitlement:shown(b.essView,'total')?b.totalEntitlement:null,
  takenThisCycle:shown(b.essView,'taken')?b.takenThisCycle:null,
  pendingApproval:shown(b.essView,'pendingApproval')?b.pendingApproval:null,
  forfeitedThisCycle:shown(b.essView,'forfeited')?b.forfeitedThisCycle:null,
  carryForwardExpiryDate:shown(b.essView,'forfeited')?b.carryForwardExpiryDate:null,
  totalAvailable:shown(b.essView,'available')?b.totalAvailable:null};
 if(!allShown(b.essView))return {...direct,withheld:true};
 return {...direct,withheld:false,eligibleDays:b.eligibleDays,entitlementStatus:b.entitlementStatus,
  entitlementTemplateName:b.entitlementTemplateName,eligibility:b.eligibility??null,
  monthlyAccruedToDate:b.monthlyAccruedToDate,carriedForward:b.carriedForward,carryForwardRemaining:b.carryForwardRemaining,
  configAdjustments:b.configAdjustments,systemAdjustments:b.systemAdjustments,balance:b.balance,
  transactions:{rows:b.transactions.slice(0,20).map(row=>({effectiveOn:row.effectiveOn,entryType:row.entryType,days:row.days,
   sourceRequestId:row.sourceRequestId,reason:row.reason})),truncated:b.transactions.length>20,totalRows:b.transactions.length}};
}
