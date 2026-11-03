/** Mine disclosure projection, before model/provider/source fingerprints. Pure; no read or effect API.
 * Each summary field uses its existing ESS key. Unmapped legacy decomposition is withheld whenever a
 * summary row is hidden: ledger/split aliases must not bypass the actual Mine display boundary.
 * A balance row names, field by field, what it does not show (notShown) instead of carrying a row-wide withheld flag:
 * in eval 41665308001 (emp-balance-1) the model read withheld:true beside Medical Leave's shown available figure as
 * "the available amount isn't shown". The card's "partly hidden" note reads notShown (lib/ai/module-job-presentation.ts).
 * Spec v23 (AI v2 Phase 2 hardening): an entitlement breakdown names what it does not show the same way, so
 * leave_entitlement_explain and the entitlement explainer carry notShown and no withheld flag either.
 */
import { ESS_VIEW_COMPONENT_KEYS,type EssViewComponentKey,type ResolvedEssView } from './ess-view';
import type { LeaveEntitlementBreakdown } from './read';
type Balance={leaveTypeId:string;leaveType:string;accrued:number;taken:number;pending:number;balance:number;available:number;
 essView:ResolvedEssView;sharedBalance?:{sourceLeaveTypeName?:string|null}|null};
const shown=(view:ResolvedEssView,key:keyof ResolvedEssView)=>view[key]!==false;
const allShown=(view:ResolvedEssView)=>ESS_VIEW_COMPONENT_KEYS.every(key=>shown(view,key));
/** Each balance summary field and the ESS line that shows it on the person's own leave page. */
const BALANCE_LINES={taken:'taken',pending:'pendingApproval',available:'available',sharedPoolName:'available'} as const satisfies Record<string,EssViewComponentKey>;
/** Left out whenever any line of the row is hidden: together they could rebuild a hidden line. */
const BALANCE_DECOMPOSITION=['accrued','balance'] as const;
export function projectMineLeaveBalance(row:Balance){
 const view=row.essView,L=BALANCE_LINES,direct={leaveTypeId:row.leaveTypeId,leaveType:row.leaveType,
  taken:shown(view,L.taken)?row.taken:null,pending:shown(view,L.pending)?row.pending:null,
  available:shown(view,L.available)?row.available:null,
  sharedPoolName:shown(view,L.sharedPoolName)?row.sharedBalance?.sourceLeaveTypeName??null:null};
 if(allShown(view))return {...direct,accrued:row.accrued,balance:row.balance,notShown:[] as string[]};
 return {...direct,notShown:[...Object.entries(L).filter(([,key])=>!shown(view,key)).map(([field])=>field),...BALANCE_DECOMPOSITION]};
}
/** Each entitlement summary field and the ESS line that shows it on the person's own leave page. */
const ENTITLEMENT_LINES={displayEntitlementDays:'eligible',currentYearEntitlement:'ytdEntitled',currentYearEntitlementRounded:'ytdEntitled',
 broughtForward:'broughtForward',adjustments:'adjustment',totalEntitlement:'total',takenThisCycle:'taken',pendingApproval:'pendingApproval',
 forfeitedThisCycle:'forfeited',carryForwardExpiryDate:'forfeited',totalAvailable:'available'} as const satisfies Record<string,EssViewComponentKey>;
/** Left out whenever any line of the breakdown is hidden: together they could rebuild a hidden line. */
const ENTITLEMENT_DECOMPOSITION=['eligibleDays','monthlyAccruedToDate','carriedForward','carryForwardRemaining','configAdjustments','systemAdjustments','balance','transactions'] as const;
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
 if(!allShown(b.essView))return {...direct,notShown:[...Object.entries(ENTITLEMENT_LINES).filter(([,key])=>!shown(b.essView,key)).map(([field])=>field),...ENTITLEMENT_DECOMPOSITION]};
 return {...direct,notShown:[] as string[],eligibleDays:b.eligibleDays,entitlementStatus:b.entitlementStatus,
  entitlementTemplateName:b.entitlementTemplateName,eligibility:b.eligibility??null,
  monthlyAccruedToDate:b.monthlyAccruedToDate,carriedForward:b.carriedForward,carryForwardRemaining:b.carryForwardRemaining,
  configAdjustments:b.configAdjustments,systemAdjustments:b.systemAdjustments,balance:b.balance,
  transactions:{rows:b.transactions.slice(0,20).map(row=>({effectiveOn:row.effectiveOn,entryType:row.entryType,days:row.days,
   sourceRequestId:row.sourceRequestId,reason:row.reason})),truncated:b.transactions.length>20,totalRows:b.transactions.length}};
}
