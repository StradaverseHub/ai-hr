/**
 * Lifecycle "needs attention" worklist (ADR-0095) — the live replacement for the handover's reminder emails.
 *
 * This repository has NO email transport (core/notifications.ts: delivery is in-app only), so the handover's
 * daily reminder mail cannot be built truthfully. A worklist computed on read gives the same prompts without
 * a mail job: it is always current, it stops the moment the item is done (the handover's "fire once per case
 * per day and stop when the items are done"), and it cannot claim a message was sent that was not. If a mail
 * transport is ever added, these same four queries are the digest content (ADR-0095, DECISION REQUIRED).
 *
 * Windows are the handover's (brief 9.2). The pure helpers are exported so they can be tested without a
 * database.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { itAsset, itAssetRequest, itRequisition, itRequisitionItem, lcCase, lcCaseStep } from '../db/schema';
import { daysBetween } from './lifecycle-rules';
import { LEVEL, levelOf, todayMy, withTenant } from './lifecycle-base';

/** Offboarding: last working day within this many days ahead (or already past). */
export const LWD_REMINDER_DAYS = 3;
/** Onboarding: join date from this many days ahead to this many days back. */
export const ONBOARDING_START_AHEAD = 3;
export const ONBOARDING_START_BEHIND = 7;
/** Approvals waiting at least this long are chased. */
export const APPROVAL_CHASE_DAYS = 2;
/** Warranty / lease ending within this many days ahead, or ended within this many days back. */
export const EXPIRY_AHEAD = 60;
export const EXPIRY_BEHIND = 30;

export const isLastWorkingDayDue = (lwd: string | null, today: string): boolean =>
  lwd != null && daysBetween(today, lwd) <= LWD_REMINDER_DAYS;
export const isOnboardingStartDue = (joinDate: string | null, today: string): boolean => {
  if (!joinDate) return false;
  const d = daysBetween(today, joinDate);
  return d <= ONBOARDING_START_AHEAD && d >= -ONBOARDING_START_BEHIND;
};
export const isExpiryDue = (date: string | null, today: string): boolean => {
  if (!date) return false;
  const d = daysBetween(today, date);
  return d <= EXPIRY_AHEAD && d >= -EXPIRY_BEHIND;
};
/** Human wording key for a day offset: today / tomorrow / in N days / N days ago. */
export const whenOf = (days: number): { key: 'today' | 'tomorrow' | 'inDays' | 'daysAgo'; n: number } =>
  days === 0 ? { key: 'today', n: 0 } : days === 1 ? { key: 'tomorrow', n: 1 } : days > 1 ? { key: 'inDays', n: days } : { key: 'daysAgo', n: -days };

export type WorklistItem = { kind: 'lastWorkingDay' | 'onboardingStart' | 'approval' | 'expiry'; ref: string; label: string; detail: string; days: number; href: string };

export async function lifecycleWorklist(ctx: SessionContext): Promise<WorklistItem[]> {
  return withTenant(ctx, async (tx) => {
    if ((await levelOf(tx, null)) < LEVEL.agent) return [];
    const mgr = (await levelOf(tx, null)) >= LEVEL.manager;
    const today = todayMy();
    const out: WorklistItem[] = [];

    // 1. Offboarding: accepted, in progress, last working day near or past, while IT return / access revoke is open.
    const ofb = await tx.select().from(lcCase).where(and(eq(lcCase.kind, 'offboarding'), eq(lcCase.status, 'in_progress'), eq(lcCase.outcome, 'accepted'), isNotNull(lcCase.lastWorkingDay)));
    if (ofb.length) {
      const open = await tx.select({ caseId: lcCaseStep.caseId, key: lcCaseStep.stepKey, done: lcCaseStep.done }).from(lcCaseStep)
        .where(and(inArray(lcCaseStep.caseId, ofb.map((c) => c.id)), inArray(lcCaseStep.stepKey, ['it_asset_return', 'sys_access_revoke'])));
      for (const c of ofb) {
        if (!isLastWorkingDayDue(c.lastWorkingDay, today)) continue;
        const done = new Set(open.filter((o) => o.caseId === c.id && o.done).map((o) => o.key));
        const outstanding = ['it_asset_return', 'sys_access_revoke'].filter((k) => !done.has(k));
        if (outstanding.length === 0) continue;
        out.push({ kind: 'lastWorkingDay', ref: c.number, label: c.fullName, detail: String(outstanding.length), days: daysBetween(today, c.lastWorkingDay!), href: `/lifecycle/offboarding/${c.number}` });
      }
    }

    // 2. Onboarding start: in progress, with an open (not completed/cancelled) requisition.
    const onb = await tx.select().from(lcCase).where(and(eq(lcCase.kind, 'onboarding'), eq(lcCase.status, 'in_progress'), isNotNull(lcCase.joinDate)));
    if (onb.length) {
      const reqs = await tx.select().from(itRequisition).where(and(inArray(itRequisition.caseId, onb.map((c) => c.id)), eq(itRequisition.kind, 'requisition'), inArray(itRequisition.status, ['open', 'in_progress'])));
      const items = reqs.length ? await tx.select({ rid: itRequisitionItem.requisitionId, s: itRequisitionItem.status }).from(itRequisitionItem).where(inArray(itRequisitionItem.requisitionId, reqs.map((r) => r.id))) : [];
      for (const c of onb) {
        if (!isOnboardingStartDue(c.joinDate, today)) continue;
        const r = reqs.find((x) => x.caseId === c.id);
        if (!r) continue;
        const mine = items.filter((i) => i.rid === r.id);
        out.push({ kind: 'onboardingStart', ref: c.number, label: c.fullName, detail: `${r.number}|${mine.filter((i) => i.s !== 'pending').length}|${mine.length}`, days: daysBetween(today, c.joinDate!), href: `/lifecycle/requisitions/${r.number}` });
      }
    }

    // 3. Approvals waiting too long (managers and admins only).
    if (mgr) {
      const rq = await tx.select().from(itRequisition).where(and(inArray(itRequisition.approvalStatus, ['pending', 'pending_l2']), sql`${itRequisition.status} <> 'cancelled'`)).orderBy(asc(itRequisition.number));
      for (const r of rq) {
        const age = daysBetween(r.createdAt.toISOString().slice(0, 10), today);
        if (age >= APPROVAL_CHASE_DAYS) out.push({ kind: 'approval', ref: r.number, label: r.fullName, detail: 'requisition', days: -age, href: `/lifecycle/requisitions/${r.number}` });
      }
      const ar = await tx.select().from(itAssetRequest).where(inArray(itAssetRequest.status, ['requested', 'pending_approval'])).orderBy(asc(itAssetRequest.number));
      for (const r of ar) {
        const age = daysBetween(r.createdAt.toISOString().slice(0, 10), today);
        if (age >= APPROVAL_CHASE_DAYS) out.push({ kind: 'approval', ref: r.number, label: r.fullName, detail: 'assetRequest', days: -age, href: `/lifecycle/asset-requests/${r.number}` });
      }
    }

    // 4. Warranty / lease ending (or just ended) on assets still in use.
    const assets = await tx.select().from(itAsset).where(inArray(itAsset.status, ['in_stock', 'issued', 'returned', 'under_repair']));
    for (const a of assets) {
      for (const [field, date] of [['warranty', a.warrantyEnd], ['lease', a.leaseEnd]] as const) {
        if (!isExpiryDue(date, today)) continue;
        out.push({ kind: 'expiry', ref: a.code, label: [a.assetType, a.model].filter(Boolean).join(' '), detail: field, days: daysBetween(today, date!), href: `/lifecycle/assets/${a.code}` });
      }
    }
    return out.sort((x, y) => x.days - y.days || x.ref.localeCompare(y.ref));
  });
}
