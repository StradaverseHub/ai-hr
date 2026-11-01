/**
 * The ONE projection of a listed leave type into the health derivation's input (lib/leave-config-health.ts
 * `HealthLeaveType`). The Entitlement Tables loader (Leave types tab, Entitlement tables tab, Balance Health
 * page) and the Assistant's setup readiness both call it, so "this type is blocked" cannot come to mean two
 * things on a screen and in a reply. Pure; no read, no event.
 */
import type {HealthLeaveType} from '../lib/leave-config-health';
import type {listLeaveTypes} from './read';
import {isEarnedAccrualType,isEarnedMethod,leaveTypeIs} from '../packs/leave/service';

export type ListedLeaveType=Awaited<ReturnType<typeof listLeaveTypes>>[number];

/** `leaveCreditLive`: the paid `toil` module is on for this tenant (decided by the caller). */
export function healthLeaveType(x:ListedLeaveType,leaveCreditLive:boolean):HealthLeaveType{
 return {
  id:x.id,
  name:x.name,
  archived:!!x.archivedAt,
  accrualMethod:x.accrualMethod??null,
  accrualUnconfigured:x.accrualUnconfigured!=null,
  // 3fb1a611 (r299 fix pass) — REQUIRED on HealthLeaveType; `listLeaveTypes` projects `role`, which
  // `leaveTypeIs` asks first. False for every type on a tenant without Leave Credit.
  daysFromLeaveCreditOnly:leaveCreditLive&&leaveTypeIs(x,'replacement'),
  /**
   * 76ffdcf2 — ⚠️ THIS FIELD WAS ONCE PROJECTED BY `listLeaveTypes` AND DROPPED by the loader, and that one
   * omission made four promises inert behind a green suite: the Default badge never rendered, the Covers
   * cell called the default table "No benefit scheme names this table", `leaveConfigHealthAll` saw
   * `undefined` so the stale blocking findings kept firing, and a saved default read back as "No default"
   * on every reload. `HealthLeaveType.defaultEntitlementTemplateLineageId` is therefore REQUIRED, not
   * optional, so the compiler catches the next reshape rather than a rendered page.
   */
  defaultEntitlementTemplateLineageId:x.defaultEntitlementTemplateLineageId??null,
  // r299 (3de1453a) — REQUIRED for the reason above. `listLeaveTypes` projects `role`, which
  // `isEarnedAccrualType` asks first.
  earnedMethodNotAnnualLeave:isEarnedMethod(x.accrualMethod)&&!isEarnedAccrualType(x),
 };
}
