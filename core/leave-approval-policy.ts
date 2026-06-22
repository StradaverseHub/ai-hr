/**
 * ADR-0039 2B-2 — the configurable leave approval chain. A per-company policy whose `levels` is an
 * ordered list of approver level kinds. Resolved at request time by core/leave.ts; edited by admins.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, leaveApprovalPolicy } from '../db/schema';

export const LEVEL_KINDS = ['direct_manager', 'hr_admin'] as const;
export type LeaveLevelKind = (typeof LEVEL_KINDS)[number];

/** The chain an opted-in company gets when it has no saved policy — identical to 2B-1. */
const FALLBACK_CHAIN: LeaveLevelKind[] = ['direct_manager', 'hr_admin'];

function sanitizeLevels(raw: unknown): LeaveLevelKind[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is LeaveLevelKind => (LEVEL_KINDS as readonly string[]).includes(x as string));
}

/** Resolve the ordered approver levels for a request: a leave-type-specific policy → the company
 *  default → the built-in fallback. Runs inside the request transaction (so under the requester's RLS,
 *  which is why the policy is readable tenant-wide). */
export async function resolveApprovalChain(
  tx: Tx,
  companyId: string,
  leaveTypeId: string | null,
): Promise<LeaveLevelKind[]> {
  if (leaveTypeId) {
    const [typed] = await tx
      .select({ levels: leaveApprovalPolicy.levels })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, companyId), eq(leaveApprovalPolicy.leaveTypeId, leaveTypeId)))
      .limit(1);
    const lv = sanitizeLevels(typed?.levels);
    if (lv.length) return lv;
  }
  const [def] = await tx
    .select({ levels: leaveApprovalPolicy.levels })
    .from(leaveApprovalPolicy)
    .where(and(eq(leaveApprovalPolicy.companyId, companyId), isNull(leaveApprovalPolicy.leaveTypeId)))
    .limit(1);
  const lv = sanitizeLevels(def?.levels);
  return lv.length ? lv : FALLBACK_CHAIN;
}

/** The company-default chain + on/off state, for the admin editor. */
export async function getLeaveApprovalPolicy(
  ctx: SessionContext,
  companyId: string,
): Promise<{ enabled: boolean; levels: LeaveLevelKind[] }> {
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({ enabled: company.leaveMultiApproval })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    const [pol] = await tx
      .select({ levels: leaveApprovalPolicy.levels })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, companyId), isNull(leaveApprovalPolicy.leaveTypeId)))
      .limit(1);
    const levels = sanitizeLevels(pol?.levels);
    return { enabled: co?.enabled ?? false, levels: levels.length ? levels : FALLBACK_CHAIN };
  });
}

/** Set a company's default chain + on/off toggle. Admin-only (enforced by the policy + company RLS). */
export async function setLeaveApprovalPolicy(
  ctx: SessionContext,
  p: { companyId: string; enabled: boolean; levels: string[] },
) {
  const levels = sanitizeLevels(p.levels);
  if (p.enabled && levels.length === 0) throw new Error('An enabled approval chain needs at least one level');
  return withTenant(ctx, async (tx) => {
    await tx.update(company).set({ leaveMultiApproval: p.enabled }).where(eq(company.id, p.companyId));
    const [existing] = await tx
      .select({ id: leaveApprovalPolicy.id })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, p.companyId), isNull(leaveApprovalPolicy.leaveTypeId)))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(leaveApprovalPolicy)
        .set({ levels, updatedAt: sql`now()` })
        .where(eq(leaveApprovalPolicy.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(leaveApprovalPolicy)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, leaveTypeId: null, levels })
        .returning({ id: leaveApprovalPolicy.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-policy',
      aggregateId: id,
      eventType: existing ? 'leave-approval-policy.updated' : 'leave-approval-policy.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, enabled: p.enabled, levels },
    });
    return { id };
  });
}
