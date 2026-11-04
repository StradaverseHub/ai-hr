/** AI v2 W5 — "Why is my leave balance this figure?" from the leave owner's own figures.
 *
 * The input is one card of the employee's own leave dashboard (core/my-leave.ts myLeaveDashboard), the read the
 * figure on Today's At a glance and on /leave both come from. Its breakdown is core/read.ts
 * leaveEntitlementBreakdown, and for the current leave year it already carries the card's own Pending and Available
 * (the Apply form's figures), so the explanation ends on the number the person clicked "Why?" beside. Everything
 * passes through core/assistant-leave-projection.ts projectMineLeaveEntitlement, the same Mine projection the
 * entitlement explainer uses, so a company's Employee Leave View settings withhold here exactly what they withhold
 * on the employee's own page. The proration working is shown only where the entitlement figure itself is. Nothing
 * is recomputed: a hidden figure stays null. Pure. */
import type {MyLeaveCard} from './my-leave';
import {projectMineLeaveEntitlement} from './assistant-leave-projection';

export type LeaveBalanceFigures=Readonly<{entitlement:number|null;earnedSoFar:number|null;broughtForward:number|null;adjustments:number|null;
 totalEntitlement:number|null;taken:number|null;pending:number|null;forfeited:number|null;available:number|null}>;
export type LeaveBalanceExplanation=Readonly<{leaveType:string;cycleStart:string;cycleEnd:string;isCurrentCycle:boolean;
 entitlementTemplateName:string|null;entitlementStatus:string;
 /** Whether the company's Employee Leave View hides part of this breakdown from employees. */
 withheld:boolean;figures:LeaveBalanceFigures;
 /** Current leave year only: the Apply form's figure, the one Today shows. */
 canApplyFor:number|null;carryForwardExpiryDate:string|null;
 proration:Readonly<{annualEntitlementDays:number;prorated:boolean;displayEntitlementDays:number;roundingApplied:boolean}>|null}>;

export function leaveBalanceExplanation(card:Pick<MyLeaveCard,'leaveType'|'cycleStart'|'cycleEnd'|'isCurrentCycle'|'canApplyFor'|'taken'|'entitlementStatus'|'breakdown'>):LeaveBalanceExplanation{
 const base={leaveType:card.leaveType,cycleStart:card.cycleStart,cycleEnd:card.cycleEnd,isCurrentCycle:card.isCurrentCycle,canApplyFor:card.isCurrentCycle?card.canApplyFor:null};
 if(!card.breakdown)return Object.freeze({...base,entitlementTemplateName:null,entitlementStatus:card.entitlementStatus,withheld:false,carryForwardExpiryDate:null,proration:null,
  figures:{entitlement:null,earnedSoFar:null,broughtForward:null,adjustments:null,totalEntitlement:null,taken:card.taken,pending:null,forfeited:null,available:null}});
 const mine=projectMineLeaveEntitlement(card.breakdown);
 const shownEntitlement=mine.displayEntitlementDays!==null;
 return Object.freeze({...base,entitlementTemplateName:mine.entitlementTemplateName,entitlementStatus:mine.entitlementStatus,withheld:mine.notShown.length>0,
  carryForwardExpiryDate:mine.carryForwardExpiryDate,
  proration:shownEntitlement?{annualEntitlementDays:card.breakdown.entitlement.annualEntitlementDays,prorated:card.breakdown.entitlement.prorated,
   displayEntitlementDays:card.breakdown.entitlement.displayEntitlementDays,roundingApplied:card.breakdown.entitlement.roundingApplied}:null,
  figures:{entitlement:mine.displayEntitlementDays,earnedSoFar:mine.currentYearEntitlementRounded,broughtForward:mine.broughtForward,adjustments:mine.adjustments,
   totalEntitlement:mine.totalEntitlement,taken:mine.takenThisCycle,pending:mine.pendingApproval,forfeited:mine.forfeitedThisCycle,available:mine.totalAvailable}});
}
