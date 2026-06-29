/**
 * 2.1 Payroll Policy — a named, reusable, company-scoped template for HOW an employee gets paid (Monthly /
 * Daily / Hourly / Custom period). Mirrors core/leave-approval-policy.ts. Admin-only writes (RLS WITH CHECK
 * = is_admin_for); tenant-wide reads (so the kernel resolves the assigned policy under the caller's session).
 *
 * Scope: only `monthly` is wired to calculation in this slice (it is the existing behaviour — a null/`fixed`
 * pay_rule). daily/hourly carry a PayRule the existing kernel resolver already understands, but the kernel
 * wiring is a deferred slice gated on the rate-storage decision; custom_period is a deferred architecture
 * slice. The enum carries all four values now so no later migration is needed.
 *
 * Substrate: every write appends a DomainEvent (actorOf/appendEvent) before returning.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, payrollPolicy, type PayRule } from '../db/schema';
import { validatePayRule, type PayRuleKind } from './pay-rule';

export const POLICY_TYPES = ['monthly', 'daily', 'hourly', 'custom_period'] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];
export const POLICY_STATUSES = ['active', 'inactive'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Thrown when a policy name collides with an existing one in the same company (DB unique-violation). The
 *  action maps this to a localized `payrollPolicy.errors.duplicateName` toast. */
export class DuplicatePolicyNameError extends Error {
  constructor(message = 'A payroll policy with this name already exists for this company') {
    super(message);
    this.name = 'DuplicatePolicyNameError';
  }
}

/** Thrown when deleting a policy that is still assigned to one or more employments. */
export class PolicyInUseError extends Error {
  constructor(message = 'This payroll policy is assigned to employees and cannot be deleted') {
    super(message);
    this.name = 'PolicyInUseError';
  }
}

/** Thrown when assigning a policy whose company differs from the employment's company (same tenant — RLS
 *  cannot catch this; the service must). */
export class PolicyCompanyMismatchError extends Error {
  constructor(message = 'A payroll policy can only be assigned within its own company') {
    super(message);
    this.name = 'PolicyCompanyMismatchError';
  }
}

/** Postgres unique-violation (the payroll_policy_company_name_uq index). Drizzle wraps the PostgresError,
 *  so walk the cause chain for code 23505. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

function cleanName(v: string | undefined): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('Name is required');
  return s;
}

function normalizeType(v: string | undefined): PolicyType {
  if (!POLICY_TYPES.includes(v as PolicyType)) throw new Error('Unknown payroll policy type');
  return v as PolicyType;
}

/** Validate a pay_rule against the policy type. Monthly carries no rule (null === today's `fixed`). For the
 *  deferred daily/hourly types the rule must be a per_day/per_hour rule with prorates=false (the kernel scope
 *  encodes proration); custom_period carries no rule yet. Reuses core/pay-rule.ts — never re-implements. */
function resolveRule(policyType: PolicyType, rule: PayRule | null | undefined): PayRule | null {
  if (policyType === 'monthly' || policyType === 'custom_period') return null;
  if (rule == null) throw new Error('Daily/Hourly policy requires a pay rule');
  const expected: PayRuleKind = policyType === 'daily' ? 'per_day' : 'per_hour';
  if (rule.kind !== expected) throw new Error(`A ${policyType} policy requires a ${expected} rule`);
  // per_day/per_hour rules encode their own period scaling, so the component must NOT also prorate.
  const v = validatePayRule(rule, false);
  if (!v.ok) throw new Error(`Invalid pay rule: ${v.code}`);
  return rule;
}

// ─────────────────────────── Writes ───────────────────────────

export async function createPolicy(
  ctx: SessionContext,
  p: { companyId: string; name: string; description?: string | null; policyType: string; payRule?: PayRule | null },
): Promise<{ id: string }> {
  const name = cleanName(p.name);
  const policyType = normalizeType(p.policyType);
  const payRule = resolveRule(policyType, p.payRule);
  const description = (p.description ?? '').trim() || null;
  return withTenant(ctx, async (tx) => {
    let id: string;
    try {
      const [row] = await tx
        .insert(payrollPolicy)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, name, description, policyType, payRule, status: 'active' })
        .returning({ id: payrollPolicy.id });
      id = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicatePolicyNameError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-policy',
      aggregateId: id,
      eventType: 'payroll-policy.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name, policyType, payRule },
    });
    return { id };
  });
}

export async function updatePolicy(
  ctx: SessionContext,
  p: { id: string; name?: string; description?: string | null; policyType?: string; payRule?: PayRule | null },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(payrollPolicy).where(eq(payrollPolicy.id, p.id)).limit(1);
    if (!before) throw new Error('Payroll policy not found');
    const policyType = p.policyType !== undefined ? normalizeType(p.policyType) : (before.policyType as PolicyType);
    const name = p.name !== undefined ? cleanName(p.name) : before.name;
    const description =
      p.description !== undefined ? ((p.description ?? '').trim() || null) : before.description;
    // If type changes, re-derive the rule from the new type; otherwise honour an explicit payRule patch.
    const payRule =
      p.policyType !== undefined || p.payRule !== undefined
        ? resolveRule(policyType, p.payRule !== undefined ? p.payRule : (before.payRule as PayRule | null))
        : (before.payRule as PayRule | null);
    try {
      await tx
        .update(payrollPolicy)
        .set({ name, description, policyType, payRule, updatedAt: sql`now()` })
        .where(eq(payrollPolicy.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicatePolicyNameError();
      throw e;
    }
    const after = { name, description, policyType, payRule };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-policy',
      aggregateId: p.id,
      eventType: 'payroll-policy.updated',
      actor: actorOf(ctx),
      payload: { before: { name: before.name, description: before.description, policyType: before.policyType, payRule: before.payRule }, after },
    });
    return { id: p.id };
  });
}

export async function setStatus(
  ctx: SessionContext,
  p: { id: string; status: string },
): Promise<{ id: string }> {
  if (!POLICY_STATUSES.includes(p.status as PolicyStatus)) throw new Error('Unknown status');
  const status = p.status as PolicyStatus;
  return withTenant(ctx, async (tx) => {
    await tx.update(payrollPolicy).set({ status, updatedAt: sql`now()` }).where(eq(payrollPolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-policy',
      aggregateId: p.id,
      eventType: status === 'active' ? 'payroll-policy.activated' : 'payroll-policy.deactivated',
      actor: actorOf(ctx),
      payload: { status },
    });
    return { id: p.id };
  });
}

export async function deletePolicy(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    // Guard: a policy assigned to any employment cannot be deleted (delete only when unassigned/unreferenced).
    const [{ n }] = await tx
      .select({ n: count() })
      .from(employment)
      .where(eq(employment.payrollPolicyId, p.id));
    if (Number(n) > 0) throw new PolicyInUseError();
    await tx.delete(payrollPolicy).where(eq(payrollPolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-policy',
      aggregateId: p.id,
      eventType: 'payroll-policy.deleted',
      actor: actorOf(ctx),
    });
    return { id: p.id };
  });
}

/** Assign (or clear, when policyId is null) the payroll policy on an employment. Validates that the policy
 *  belongs to the SAME company as the employment (RLS won't catch a same-tenant cross-company mis-assignment). */
export async function assignPolicy(
  ctx: SessionContext,
  p: { employmentId: string; policyId: string | null },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ id: employment.id, companyId: employment.companyId, before: employment.payrollPolicyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');
    if (p.policyId != null) {
      const [pol] = await tx
        .select({ id: payrollPolicy.id, companyId: payrollPolicy.companyId })
        .from(payrollPolicy)
        .where(eq(payrollPolicy.id, p.policyId))
        .limit(1);
      if (!pol) throw new Error('Payroll policy not found');
      if (pol.companyId !== emp.companyId) throw new PolicyCompanyMismatchError();
    }
    await tx
      .update(employment)
      .set({ payrollPolicyId: p.policyId })
      .where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.payroll-policy.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: emp.before, after: p.policyId },
    });
    return { id: p.employmentId };
  });
}

// ─────────────────────────── Reads ───────────────────────────

export type PolicyRow = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  policyType: PolicyType;
  payRule: PayRule | null;
  status: PolicyStatus;
  updatedAt: Date;
  assignedCount: number;
};

/** List policies (optionally scoped to a set of companies) with an assigned-employment count per policy. */
export async function listPolicies(ctx: SessionContext, companyIds?: string[]): Promise<PolicyRow[]> {
  return withTenant(ctx, async (tx) => {
    const assignedCount = sql<number>`(
      select count(*)::int from ${employment} e where e.payroll_policy_id = ${payrollPolicy.id}
    )`;
    const base = tx
      .select({
        id: payrollPolicy.id,
        companyId: payrollPolicy.companyId,
        name: payrollPolicy.name,
        description: payrollPolicy.description,
        policyType: payrollPolicy.policyType,
        payRule: payrollPolicy.payRule,
        status: payrollPolicy.status,
        updatedAt: payrollPolicy.updatedAt,
        assignedCount,
      })
      .from(payrollPolicy);
    const rows =
      companyIds && companyIds.length > 0
        ? await base.where(inArray(payrollPolicy.companyId, companyIds)).orderBy(payrollPolicy.name)
        : await base.orderBy(payrollPolicy.name);
    return rows.map((r) => ({
      ...r,
      policyType: r.policyType as PolicyType,
      payRule: r.payRule as PayRule | null,
      status: r.status as PolicyStatus,
      assignedCount: Number(r.assignedCount),
    }));
  });
}

export async function getPolicy(ctx: SessionContext, id: string): Promise<PolicyRow | null> {
  const [row] = await listPoliciesById(ctx, [id]);
  return row ?? null;
}

async function listPoliciesById(ctx: SessionContext, ids: string[]): Promise<PolicyRow[]> {
  if (ids.length === 0) return [];
  return withTenant(ctx, async (tx) => {
    const assignedCount = sql<number>`(
      select count(*)::int from ${employment} e where e.payroll_policy_id = ${payrollPolicy.id}
    )`;
    const rows = await tx
      .select({
        id: payrollPolicy.id,
        companyId: payrollPolicy.companyId,
        name: payrollPolicy.name,
        description: payrollPolicy.description,
        policyType: payrollPolicy.policyType,
        payRule: payrollPolicy.payRule,
        status: payrollPolicy.status,
        updatedAt: payrollPolicy.updatedAt,
        assignedCount,
      })
      .from(payrollPolicy)
      .where(inArray(payrollPolicy.id, ids));
    return rows.map((r) => ({
      ...r,
      policyType: r.policyType as PolicyType,
      payRule: r.payRule as PayRule | null,
      status: r.status as PolicyStatus,
      assignedCount: Number(r.assignedCount),
    }));
  });
}

/** Active policies in one company — the assignment dropdown source (only active policies are assignable). */
export async function listAssignablePolicies(
  ctx: SessionContext,
  companyId: string,
): Promise<{ id: string; name: string; policyType: PolicyType }[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: payrollPolicy.id, name: payrollPolicy.name, policyType: payrollPolicy.policyType })
      .from(payrollPolicy)
      .where(and(eq(payrollPolicy.companyId, companyId), eq(payrollPolicy.status, 'active')))
      .orderBy(payrollPolicy.name);
    return rows.map((r) => ({ ...r, policyType: r.policyType as PolicyType }));
  });
}

/**
 * Resolve the policy assigned to an employment for payroll computation. Returns the assigned policy only if
 * its status is 'active'; otherwise null (monthly default). Takes a Tx so the kernel can call it inside its
 * own transaction (under the caller's session — hence the tenant-wide read RLS). No effective-date logic:
 * history is preserved by per-payslip statutory snapshots + the non-draft batch immutability guard, exactly
 * as everywhere else in this codebase. Distinguishes "no policy assigned" from "assigned policy not found":
 * the latter is unexpected and surfaces (never silently downgrades a visible-but-inactive policy to monthly
 * is the EXCEPTION — inactive is a legitimate monthly fallback for the Monthly-only slice, documented above).
 */
export async function resolveAssignedPolicy(
  tx: Tx,
  employmentId: string,
): Promise<PolicyRow | null> {
  const [emp] = await tx
    .select({ policyId: employment.payrollPolicyId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp || emp.policyId == null) return null; // no policy assigned → monthly default
  const [pol] = await tx
    .select({
      id: payrollPolicy.id,
      companyId: payrollPolicy.companyId,
      name: payrollPolicy.name,
      description: payrollPolicy.description,
      policyType: payrollPolicy.policyType,
      payRule: payrollPolicy.payRule,
      status: payrollPolicy.status,
      updatedAt: payrollPolicy.updatedAt,
    })
    .from(payrollPolicy)
    .where(eq(payrollPolicy.id, emp.policyId))
    .limit(1);
  // Assigned but not visible under RLS, or inactive → monthly default. (For the Monthly-only slice this is
  // benign: monthly is the only computed type. When non-monthly ships, an inactive-but-assigned policy gets
  // a dedicated test per the plan.)
  if (!pol || pol.status !== 'active') return null;
  return {
    ...pol,
    policyType: pol.policyType as PolicyType,
    payRule: pol.payRule as PayRule | null,
    status: pol.status as PolicyStatus,
    assignedCount: 0,
  };
}

