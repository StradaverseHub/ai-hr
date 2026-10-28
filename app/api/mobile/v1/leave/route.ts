/**
 * GET /api/mobile/v1/leave — the card fronts of My Leave for the current leave year (ADR-0088 §2).
 * Read-only. The figures are `myLeaveDashboard`'s, the function the web's /leave renders, so the phone
 * and the browser cannot disagree about a balance. The breakdown side-sheet is not in v1.
 *
 * `?employmentId=` picks one of the caller's own active employments (lib/mobile-api/request.ts).
 */
import { myLeaveDashboard } from '@/core/my-leave';
import { ENTITLEMENT_STATUS_LABEL_KEY, ENTITLEMENT_STATUS_TIP_KEY, entitlementStatusNeedsNotice } from '@/lib/entitlement-status';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { LeaveResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment, mobileLocale } from '@/lib/mobile-api/request';
import { mobileTranslator } from '@/lib/mobile-api/server-text';

export const GET = mobileRoute(LeaveResponse, async (s, req) => {
  const today = todayInKualaLumpur();
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) return { today, employmentId: null, cards: [] };
  const dash = await myLeaveDashboard(s, employmentId, { today, locale: mobileLocale(req) });
  // M07: the notice as the web words it (me.leaveBalanceTable), translated here; null when the label is missing.
  const tNotice = await mobileTranslator(mobileLocale(req), 'me.leaveBalanceTable');
  const noticeText = (status: (typeof dash.cards)[number]['entitlementStatus']) => {
    if (!entitlementStatusNeedsNotice(status)) return null;
    const label = tNotice(ENTITLEMENT_STATUS_LABEL_KEY[status]);
    const tip = ENTITLEMENT_STATUS_TIP_KEY[status];
    return label ? { label, detail: tip ? tNotice(tip) : null } : null;
  };
  return {
    today,
    employmentId,
    cards: dash.cards.map((c) => ({
      leaveTypeId: c.leaveTypeId,
      leaveType: c.leaveType,
      code: c.code,
      color: c.color,
      placement: c.placement,
      annualLeave: c.annualLeave,
      cycleStart: c.cycleStart,
      cycleEnd: c.cycleEnd,
      isCurrentCycle: c.isCurrentCycle,
      hasEntitlement: c.hasEntitlement,
      takenOnly: c.takenOnly,
      entitlement: c.entitlement,
      earnedSoFar: c.earnedSoFar,
      taken: c.taken,
      pending: c.pending,
      balance: c.balance,
      canApplyFor: c.canApplyFor,
      expiringSoon: c.expiringSoon,
      sharedPool: c.sharedBalance != null,
      entitlementNotice: entitlementStatusNeedsNotice(c.entitlementStatus) ? c.entitlementStatus : null,
      entitlementNoticeText: noticeText(c.entitlementStatus),
    })),
  };
});
