/**
 * ADR-0039 2B-2 + ADR-0071 — the configurable leave approval chain, now a SCOPED RULE MATRIX. A
 * leave_approval_policy row is a RULE whose `levels` is an ordered list of approver level kinds, scoped by
 * (optionally) leave-type, business-unit, department, position, grade, employment-type and a min/max
 * leave-day range — all nullable/wildcard. Resolved at request time by core/leave.ts ("most-specific
 * matching rule wins"); edited by admins via the rule builder.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, employmentTypeEnum, leaveApprovalPolicy, leaveApprovalTemplate } from '../db/schema';

// 6fadb036 (R17 gap-close) — the reporter's full approver-step vocabulary (list C). Ordered as the
// request lists them; `hr_admin` is the internal id for the "HR" label. Each kind has a concrete
// decision-time resolver in core/leave.ts (assertCanDecideLeaveStep) and a generation-time drop rule:
//   direct_manager      → the subject's active administrative manager         (dropped when none)
//   department_head     → department.head_employment_id of the subject's dept (dropped when unset)
//   business_unit_head  → business_unit.head_employment_id of the subject's BU (dropped when unset)
//   hr_admin ("HR")     → hr_admin / super_admin role                          (never dropped)
//   hr_manager          → HR-tier authority (hr_admin / super_admin) — a distinct gate; a ranked
//                         hr_manager sub-role is a documented follow-up (ADR-0071 §i)                (never dropped)
//   payroll             → payroll_partner (subject's company) / super_admin    (never dropped)
//   custom_role         → an admin gate (hr_admin / super_admin); binding a specific named role per
//                         step is a documented follow-up (ADR-0071 §i custom_position guard)         (never dropped)
export const LEVEL_KINDS = [
  'direct_manager',
  'department_head',
  'business_unit_head',
  'hr_admin',
  'hr_manager',
  'payroll',
  'custom_role',
] as const;
export type LeaveLevelKind = (typeof LEVEL_KINDS)[number];

/** Kinds that route to an org-chart HEAD (department / business unit). A step of these kinds is generated
 *  only when the subject's dept/BU actually has a head set — otherwise dropped (no dead step). */
export const HEAD_LEVEL_KINDS: readonly LeaveLevelKind[] = ['department_head', 'business_unit_head'];

/** The chain an opted-in company gets when no rule matches — identical to 2B-1. */
const FALLBACK_CHAIN: LeaveLevelKind[] = ['direct_manager', 'hr_admin'];

export function sanitizeLevels(raw: unknown): LeaveLevelKind[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is LeaveLevelKind => (LEVEL_KINDS as readonly string[]).includes(x as string));
}

type EmploymentType = (typeof employmentTypeEnum.enumValues)[number];

/** The attributes of the requesting employment's CURRENT assignment that a rule can scope on (ADR-0071).
 *  All optional/nullable — a null on the employee side never matches a non-null rule dimension. */
export type ApprovalMatchAttrs = {
  businessUnitId?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  gradeId?: string | null;
  employmentType?: EmploymentType | null;
  /** The request's leave-day count (fractional day-equivalent for hourly/partial requests — ADR-0071 1(h)). */
  days?: number | null;
};

/** A resolvable rule row (only the fields resolution needs). */
type RuleRow = {
  id: string;
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  employmentType: EmploymentType | null;
  minDays: number | null;
  maxDays: number | null;
  levels: unknown;
  // 6fadb036: when set (and the template is active), the template's levels are the effective chain.
  templateId: string | null;
  createdAt: Date;
};

/** True when a rule matches the request. A null rule dimension is a wildcard (matches anything); a non-null
 *  rule dimension must equal the request's value, and a null on the REQUEST side is a non-match (ADR-0071
 *  1(d) — an ungraded employee never matches a grade-scoped rule). Day-range boundaries are inclusive;
 *  a null min/max is unbounded on that side. When the request carries no day count (days == null), a
 *  day-range-scoped rule simply does not match. */
function ruleMatches(rule: RuleRow, leaveTypeId: string | null, a: ApprovalMatchAttrs): boolean {
  if (rule.leaveTypeId !== null && rule.leaveTypeId !== leaveTypeId) return false;
  if (rule.businessUnitId !== null && rule.businessUnitId !== (a.businessUnitId ?? null)) return false;
  if (rule.departmentId !== null && rule.departmentId !== (a.departmentId ?? null)) return false;
  if (rule.positionId !== null && rule.positionId !== (a.positionId ?? null)) return false;
  if (rule.gradeId !== null && rule.gradeId !== (a.gradeId ?? null)) return false;
  if (rule.employmentType !== null && rule.employmentType !== (a.employmentType ?? null)) return false;
  const days = a.days ?? null;
  if (rule.minDays !== null) {
    if (days === null || days < rule.minDays) return false;
  }
  if (rule.maxDays !== null) {
    if (days === null || days > rule.maxDays) return false;
  }
  return true;
}

/** Specificity = count of non-null scoping dimensions the rule constrains (leave-type + the 6 attr dims +
 *  a day-range, where any non-null bound counts once). Higher = more specific. */
function specificity(rule: RuleRow): number {
  let n = 0;
  if (rule.leaveTypeId !== null) n++;
  if (rule.businessUnitId !== null) n++;
  if (rule.departmentId !== null) n++;
  if (rule.positionId !== null) n++;
  if (rule.gradeId !== null) n++;
  if (rule.employmentType !== null) n++;
  if (rule.minDays !== null || rule.maxDays !== null) n++;
  return n;
}

/** Width of a rule's day range, used only for tie-breaking (narrower wins). Unbounded sides use ±Infinity,
 *  so a fully-unbounded rule is the widest and loses to any bounded competitor of equal specificity. */
function dayRangeWidth(rule: RuleRow): number {
  const lo = rule.minDays ?? Number.NEGATIVE_INFINITY;
  const hi = rule.maxDays ?? Number.POSITIVE_INFINITY;
  return hi - lo;
}

/** Deterministic tie-break for two equally-specific matching rules (ADR-0071 1(c)): narrower day-range
 *  wins; if still tied, the MOST-RECENTLY-CREATED wins (created_at, never updated_at — an unrelated edit
 *  must not change which rule wins). Returns true if `a` beats `b`. */
function beats(a: RuleRow, b: RuleRow): boolean {
  const wa = dayRangeWidth(a);
  const wb = dayRangeWidth(b);
  if (wa !== wb) return wa < wb;
  return a.createdAt.getTime() > b.createdAt.getTime();
}

/** Resolve the ordered approver levels for a request: the most-specific matching active rule wins, then the
 *  company default, then the built-in fallback. Runs inside the request transaction (so under the
 *  requester's RLS, which is why the policy is readable tenant-wide). Resolution is scoped to the passed
 *  attributes, which come from the requesting employment's OWN current assignment only (ADR-0071 1(f)). */
export async function resolveApprovalChain(
  tx: Tx,
  companyId: string,
  leaveTypeId: string | null,
  attrs: ApprovalMatchAttrs = {},
): Promise<LeaveLevelKind[]> {
  const rules = (await tx
    .select({
      id: leaveApprovalPolicy.id,
      leaveTypeId: leaveApprovalPolicy.leaveTypeId,
      businessUnitId: leaveApprovalPolicy.businessUnitId,
      departmentId: leaveApprovalPolicy.departmentId,
      positionId: leaveApprovalPolicy.positionId,
      gradeId: leaveApprovalPolicy.gradeId,
      employmentType: leaveApprovalPolicy.employmentType,
      minDays: leaveApprovalPolicy.minDays,
      maxDays: leaveApprovalPolicy.maxDays,
      levels: leaveApprovalPolicy.levels,
      templateId: leaveApprovalPolicy.templateId,
      createdAt: leaveApprovalPolicy.createdAt,
    })
    .from(leaveApprovalPolicy)
    .where(
      and(eq(leaveApprovalPolicy.companyId, companyId), eq(leaveApprovalPolicy.active, true)),
    )) as RuleRow[];

  // 6fadb036: fetch the tenant's ACTIVE templates once (few rows). A rule with template_id draws its chain
  // from the template; the tenant-default template is the fallback just above the built-in chain. Runs under
  // the requester's tx (RLS scopes to the tenant), same reason the policy itself is readable tenant-wide.
  const templates = await tx
    .select({
      id: leaveApprovalTemplate.id,
      levels: leaveApprovalTemplate.levels,
      isTenantDefault: leaveApprovalTemplate.isTenantDefault,
    })
    .from(leaveApprovalTemplate)
    .where(eq(leaveApprovalTemplate.active, true));
  const templateLevels = new Map<string, LeaveLevelKind[]>();
  let tenantDefaultLevels: LeaveLevelKind[] = [];
  for (const t of templates) {
    const lv = sanitizeLevels(t.levels);
    templateLevels.set(t.id, lv);
    if (t.isTenantDefault) tenantDefaultLevels = lv;
  }
  // The effective ordered chain of a rule: the template's levels when template-driven (and the template is
  // active), else the row's own levels.
  const effectiveLevels = (r: RuleRow): LeaveLevelKind[] =>
    r.templateId ? (templateLevels.get(r.templateId) ?? []) : sanitizeLevels(r.levels);

  const matching = rules.filter((r) => ruleMatches(r, leaveTypeId, attrs));
  if (matching.length) {
    let best = matching[0];
    let bestScore = specificity(best);
    for (const r of matching.slice(1)) {
      const s = specificity(r);
      if (s > bestScore || (s === bestScore && beats(r, best))) {
        best = r;
        bestScore = s;
      }
    }
    const lv = effectiveLevels(best);
    if (lv.length) return lv;
  }
  // No matching rule (or its effective chain resolved empty): fall back to the org-wide default template,
  // then the built-in chain.
  if (tenantDefaultLevels.length) return tenantDefaultLevels;
  return FALLBACK_CHAIN;
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
      .where(and(eq(leaveApprovalPolicy.companyId, companyId), isNull(leaveApprovalPolicy.leaveTypeId), defaultRuleFilter()))
      .limit(1);
    const levels = sanitizeLevels(pol?.levels);
    return { enabled: co?.enabled ?? false, levels: levels.length ? levels : FALLBACK_CHAIN };
  });
}

/** SQL predicate isolating the "company default" rule: the fully-wildcard row (no scoping dimension set). */
function defaultRuleFilter() {
  return sql`business_unit_id is null and department_id is null and position_id is null and grade_id is null and employment_type is null and min_days is null and max_days is null`;
}

/** 4ec5a940 — normalise an OPTIONAL "why the change was made" note for the audit event payload. Kept local
 *  (not imported from ./admin) to avoid a module import cycle: admin → leave → leave-approval-policy. Blank
 *  ⇒ undefined so the payload key is omitted; capped at 500 chars. Tenant free-text, PDPA-safe (ADR-0030). */
const REASON_MAX_LEN = 500;
function normalizeReason(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > REASON_MAX_LEN ? s.slice(0, REASON_MAX_LEN) : s;
}

/** Set a company's default chain + on/off toggle. Admin-only (enforced by the policy + company RLS).
 *  Under ADR-0071 the "company default" is the fully-wildcard rule; this upserts that row and leaves any
 *  scoped rules untouched. */
export async function setLeaveApprovalPolicy(
  ctx: SessionContext,
  p: { companyId: string; enabled: boolean; levels: string[]; reason?: string | null },
) {
  const levels = sanitizeLevels(p.levels);
  const reason = normalizeReason(p.reason);
  if (p.enabled && levels.length === 0) throw new Error('An enabled approval chain needs at least one level');
  return withTenant(ctx, async (tx) => {
    // 4ec5a940 — capture the prior enabled flag + chain BEFORE the writes, so the audit event carries a
    // real before→after comparison (forward-only). The company row holds the toggle; the default rule row
    // holds the chain.
    const [priorCompany] = await tx
      .select({ enabled: company.leaveMultiApproval })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    await tx.update(company).set({ leaveMultiApproval: p.enabled }).where(eq(company.id, p.companyId));
    const [existing] = await tx
      .select({ id: leaveApprovalPolicy.id, levels: leaveApprovalPolicy.levels })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, p.companyId), isNull(leaveApprovalPolicy.leaveTypeId), defaultRuleFilter()))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(leaveApprovalPolicy)
        .set({ levels, active: true, updatedAt: sql`now()` })
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
      payload: {
        companyId: p.companyId,
        before: existing
          ? { enabled: priorCompany?.enabled ?? false, levels: sanitizeLevels(existing.levels) }
          : null,
        after: { enabled: p.enabled, levels },
        ...(reason ? { reason } : {}),
      },
    });
    return { id };
  });
}

// ──────────────────────────── ADR-0071 rule matrix CRUD ────────────────────────────

/** A rule row as returned by listLeaveApprovalRules — the full scoping tuple for the admin builder. */
export type LeaveApprovalRule = {
  id: string;
  companyId: string;
  ruleName: string | null;
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  employmentType: EmploymentType | null;
  minDays: number | null;
  maxDays: number | null;
  active: boolean;
  levels: LeaveLevelKind[];
  // 6fadb036: the template this rule draws its chain from (null = custom `levels`).
  templateId: string | null;
};

/** The scoping + chain inputs shared by create/update. Every scoping dimension is nullable/wildcard. */
export type LeaveApprovalRuleInput = {
  companyId: string;
  ruleName?: string | null;
  leaveTypeId?: string | null;
  businessUnitId?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  gradeId?: string | null;
  employmentType?: EmploymentType | null;
  minDays?: number | null;
  maxDays?: number | null;
  levels: string[];
};

function normDay(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) throw new Error('Day-range bounds must be non-negative whole numbers');
  return v;
}

/** Validate + normalize a rule's inputs, throwing on an unusable rule (empty chain, min>max). */
function cleanRuleInput(p: LeaveApprovalRuleInput) {
  const levels = sanitizeLevels(p.levels);
  if (levels.length === 0) throw new Error('A rule needs at least one approval level');
  const minDays = normDay(p.minDays);
  const maxDays = normDay(p.maxDays);
  if (minDays !== null && maxDays !== null && minDays > maxDays) {
    throw new Error('Minimum days cannot exceed maximum days');
  }
  const ruleName = p.ruleName?.trim() ? p.ruleName.trim() : null;
  return {
    ruleName,
    leaveTypeId: p.leaveTypeId ?? null,
    businessUnitId: p.businessUnitId ?? null,
    departmentId: p.departmentId ?? null,
    positionId: p.positionId ?? null,
    gradeId: p.gradeId ?? null,
    employmentType: p.employmentType ?? null,
    minDays,
    maxDays,
    levels,
  };
}

/** Reject a rule whose full scoping tuple duplicates another active rule for the same company (the
 *  CHECK(min<=max) constraint does not catch this — ADR-0071 2(ii)). `excludeId` skips the row being
 *  updated. Compares every scoping dimension (NULLs equal NULLs). */
async function assertNoDuplicateRule(
  tx: Tx,
  companyId: string,
  c: ReturnType<typeof cleanRuleInput>,
  excludeId: string | null,
) {
  const existing = await tx
    .select({ id: leaveApprovalPolicy.id })
    .from(leaveApprovalPolicy)
    .where(
      and(
        eq(leaveApprovalPolicy.companyId, companyId),
        eq(leaveApprovalPolicy.active, true),
        eqOrNull(leaveApprovalPolicy.leaveTypeId, c.leaveTypeId),
        eqOrNull(leaveApprovalPolicy.businessUnitId, c.businessUnitId),
        eqOrNull(leaveApprovalPolicy.departmentId, c.departmentId),
        eqOrNull(leaveApprovalPolicy.positionId, c.positionId),
        eqOrNull(leaveApprovalPolicy.gradeId, c.gradeId),
        c.employmentType == null
          ? isNull(leaveApprovalPolicy.employmentType)
          : eq(leaveApprovalPolicy.employmentType, c.employmentType),
        c.minDays == null ? isNull(leaveApprovalPolicy.minDays) : eq(leaveApprovalPolicy.minDays, c.minDays),
        c.maxDays == null ? isNull(leaveApprovalPolicy.maxDays) : eq(leaveApprovalPolicy.maxDays, c.maxDays),
      ),
    );
  const dup = existing.find((r) => r.id !== excludeId);
  if (dup) throw new Error('A rule with the same scope already exists');
}

/** eq() for a nullable uuid column that treats NULL == NULL (for duplicate-tuple comparison). */
function eqOrNull(col: Parameters<typeof eq>[0], v: string | null) {
  return v == null ? isNull(col as never) : eq(col, v);
}

/** Create a scoped approval rule. Admin-only (RLS). Guards against a functionally-identical active rule. */
export async function createLeaveApprovalRule(ctx: SessionContext, p: LeaveApprovalRuleInput) {
  const c = cleanRuleInput(p);
  return withTenant(ctx, async (tx) => {
    await assertNoDuplicateRule(tx, p.companyId, c, null);
    const [row] = await tx
      .insert(leaveApprovalPolicy)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        ruleName: c.ruleName,
        leaveTypeId: c.leaveTypeId,
        businessUnitId: c.businessUnitId,
        departmentId: c.departmentId,
        positionId: c.positionId,
        gradeId: c.gradeId,
        employmentType: c.employmentType,
        minDays: c.minDays,
        maxDays: c.maxDays,
        active: true,
        levels: c.levels,
      })
      .returning({ id: leaveApprovalPolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-policy',
      aggregateId: row.id,
      eventType: 'leave-approval-rule.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, ...c },
    });
    return { id: row.id };
  });
}

/** Update a scoped approval rule (scope + chain). Admin-only (RLS). Guards against duplicating another rule. */
export async function updateLeaveApprovalRule(
  ctx: SessionContext,
  ruleId: string,
  p: LeaveApprovalRuleInput,
  // 4ec5a940 — optional free-text justification for the audit event; passed as a separate arg so
  // cleanRuleInput (which validates the scoping tuple) is untouched.
  opts?: { reason?: string | null },
) {
  const c = cleanRuleInput(p);
  const reason = normalizeReason(opts?.reason);
  return withTenant(ctx, async (tx) => {
    await assertNoDuplicateRule(tx, p.companyId, c, ruleId);
    // 4ec5a940 — snapshot the prior rule scope + chain BEFORE the update, for a real before→after audit diff.
    const [prev] = await tx
      .select({
        ruleName: leaveApprovalPolicy.ruleName,
        leaveTypeId: leaveApprovalPolicy.leaveTypeId,
        businessUnitId: leaveApprovalPolicy.businessUnitId,
        departmentId: leaveApprovalPolicy.departmentId,
        positionId: leaveApprovalPolicy.positionId,
        gradeId: leaveApprovalPolicy.gradeId,
        employmentType: leaveApprovalPolicy.employmentType,
        minDays: leaveApprovalPolicy.minDays,
        maxDays: leaveApprovalPolicy.maxDays,
        levels: leaveApprovalPolicy.levels,
      })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.id, ruleId), eq(leaveApprovalPolicy.companyId, p.companyId)))
      .limit(1);
    await tx
      .update(leaveApprovalPolicy)
      .set({
        ruleName: c.ruleName,
        leaveTypeId: c.leaveTypeId,
        businessUnitId: c.businessUnitId,
        departmentId: c.departmentId,
        positionId: c.positionId,
        gradeId: c.gradeId,
        employmentType: c.employmentType,
        minDays: c.minDays,
        maxDays: c.maxDays,
        levels: c.levels,
        updatedAt: sql`now()`,
      })
      .where(and(eq(leaveApprovalPolicy.id, ruleId), eq(leaveApprovalPolicy.companyId, p.companyId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-policy',
      aggregateId: ruleId,
      eventType: 'leave-approval-rule.updated',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        before: prev
          ? {
              ruleName: prev.ruleName,
              leaveTypeId: prev.leaveTypeId,
              businessUnitId: prev.businessUnitId,
              departmentId: prev.departmentId,
              positionId: prev.positionId,
              gradeId: prev.gradeId,
              employmentType: prev.employmentType,
              minDays: prev.minDays,
              maxDays: prev.maxDays,
              levels: sanitizeLevels(prev.levels),
            }
          : null,
        after: { ...c },
        ...(reason ? { reason } : {}),
      },
    });
    return { id: ruleId };
  });
}

/** Soft-archive a rule (active=false — never hard delete; rules are referential/auditable). Admin-only. */
export async function archiveLeaveApprovalRule(ctx: SessionContext, ruleId: string, companyId: string) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(leaveApprovalPolicy)
      .set({ active: false, updatedAt: sql`now()` })
      .where(and(eq(leaveApprovalPolicy.id, ruleId), eq(leaveApprovalPolicy.companyId, companyId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-policy',
      aggregateId: ruleId,
      eventType: 'leave-approval-rule.archived',
      actor: actorOf(ctx),
      payload: { companyId },
    });
    return { id: ruleId };
  });
}

/** List a company's active approval rules (most-specific first, then newest), for the rule builder. */
export async function listLeaveApprovalRules(
  ctx: SessionContext,
  companyId: string,
): Promise<LeaveApprovalRule[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveApprovalPolicy.id,
        companyId: leaveApprovalPolicy.companyId,
        ruleName: leaveApprovalPolicy.ruleName,
        leaveTypeId: leaveApprovalPolicy.leaveTypeId,
        businessUnitId: leaveApprovalPolicy.businessUnitId,
        departmentId: leaveApprovalPolicy.departmentId,
        positionId: leaveApprovalPolicy.positionId,
        gradeId: leaveApprovalPolicy.gradeId,
        employmentType: leaveApprovalPolicy.employmentType,
        minDays: leaveApprovalPolicy.minDays,
        maxDays: leaveApprovalPolicy.maxDays,
        active: leaveApprovalPolicy.active,
        levels: leaveApprovalPolicy.levels,
        templateId: leaveApprovalPolicy.templateId,
        createdAt: leaveApprovalPolicy.createdAt,
      })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, companyId), eq(leaveApprovalPolicy.active, true)))
      .orderBy(leaveApprovalPolicy.createdAt);
    return rows
      .map((r) => ({
        id: r.id,
        companyId: r.companyId,
        ruleName: r.ruleName,
        leaveTypeId: r.leaveTypeId,
        businessUnitId: r.businessUnitId,
        departmentId: r.departmentId,
        positionId: r.positionId,
        gradeId: r.gradeId,
        employmentType: r.employmentType,
        minDays: r.minDays,
        maxDays: r.maxDays,
        active: r.active,
        levels: sanitizeLevels(r.levels),
        templateId: r.templateId,
      }))
      .sort((a, b) => {
        // Most-specific first, then newest-created — matches resolution intuition on the screen.
        const sa = specificity(a as unknown as RuleRow);
        const sb = specificity(b as unknown as RuleRow);
        return sb - sa;
      });
  });
}

/** 6fadb036 — flip a company's multi-step-approval opt-in WITHOUT touching its default chain. The
 *  assignment screen surfaces this: a template assignment only fires when the company has multi-step
 *  approval on (core/leave.ts), so HR must be able to enable it inline. Admin-only (company RLS). */
export async function setLeaveMultiApproval(ctx: SessionContext, companyId: string, enabled: boolean) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ enabled: company.leaveMultiApproval })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    await tx.update(company).set({ leaveMultiApproval: enabled }).where(eq(company.id, companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: companyId,
      eventType: 'company.leave-multi-approval.changed',
      actor: actorOf(ctx),
      payload: { companyId, enabled, before: before?.enabled ?? null },
    });
    return { id: companyId };
  });
}
