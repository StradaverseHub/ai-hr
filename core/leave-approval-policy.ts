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
import { LEVEL_KINDS, sanitizeLevels, type LeaveLevelKind } from '../lib/leave-approval-kinds';

/**
 * r293 — THE APPROVER VOCABULARY NOW LIVES IN `lib/leave-approval-kinds.ts`, a client-safe leaf, and is
 * re-exported here so this module stays its public server-side door and no existing import changed.
 *
 * It moved because the Approval Workflow builder is a 'use client' component that must offer exactly the
 * kinds the engine routes on, and this module imports `db/client`, `db/events` and `db/schema` — importing
 * it from the browser would drag the database kernel into the bundle. The editor's own hand-kept copy of
 * the list is deleted with the move: nothing failed when the two disagreed.
 *
 * `sanitizeLevels` moved with them: it is the same membership test over the same const, and splitting the
 * test from the list is how the two drift.
 */
export {
  LEVEL_KINDS,
  HEAD_LEVEL_KINDS,
  FIXED_LEVEL_KINDS,
  DROPPABLE_LEVEL_KINDS,
  isFixedLevelKind,
  isDroppableLevelKind,
  sanitizeLevels,
  type LeaveLevelKind,
} from '../lib/leave-approval-kinds';

/** The chain an opted-in company gets when no rule matches — identical to 2B-1. */
const FALLBACK_CHAIN: LeaveLevelKind[] = ['direct_manager', 'hr_admin'];

type EmploymentType = (typeof employmentTypeEnum.enumValues)[number];

/** The attributes of the requesting employment's CURRENT assignment that a rule can scope on (ADR-0071).
 *  All optional/nullable — a null on the employee side never matches a non-null rule dimension. */
export type ApprovalMatchAttrs = {
  businessUnitId?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  gradeId?: string | null;
  // R41 72800eda — the grade GROUP the requester's grade belongs to (grade_group_member), resolved at submit
  // time. A grade-group-scoped rule matches on this; individual gradeId scoping is independent and unchanged.
  gradeGroupId?: string | null;
  employmentType?: EmploymentType | null;
  /** The request's leave-day count (fractional day-equivalent for hourly/partial requests — ADR-0071 1(h)). */
  days?: number | null;
};

/** A resolvable rule row (only the fields resolution needs). */
type RuleRow = {
  id: string;
  companyId: string;
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
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
  if (rule.gradeGroupId !== null && rule.gradeGroupId !== (a.gradeGroupId ?? null)) return false;
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
  if (rule.gradeGroupId !== null) n++;
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
 *  must not change which rule wins); and if the creation instants are equal too, the LOWER `id` wins.
 *  That last term is what makes this a TOTAL order (r281 53e914fe): without it the comparison returned
 *  false in both directions and `decideApproval` fell back to row order, so who approved a person's leave
 *  depended on the query plan. Returns true if `a` beats `b`. */
function beats(a: RuleRow, b: RuleRow): boolean {
  const wa = dayRangeWidth(a);
  const wb = dayRangeWidth(b);
  if (wa !== wb) return wa < wb;
  // r281 53e914fe — `createdAt` is NOT a total order here, for two independent reasons: Postgres `now()`
  // is transaction-start time, so rules written by one statement or one script share a byte-identical
  // instant; and the driver hands this column back as a JS `Date`, whose `getTime()` is MILLISECONDS,
  // so two rows written microseconds apart also compare equal. Falling through to `false` in both
  // directions left the winner to be `matching[0]` — i.e. to row order. `id` is the total-order key, and
  // it is ASCENDING to agree with `loadApprovalRuleSet`'s `ORDER BY created_at, id`: the first row of a
  // tied group wins, by both mechanisms, permanently. Arbitrary but fixed is the whole point — see
  // r270's `winReasonFor`, which names exactly this state 'arbitrary' rather than dressing it up.
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() > b.createdAt.getTime();
  return a.id < b.id;
}

/** Where a resolved chain came from. `'rule'` is the only source that names a rule — the other two mean
 *  no rule won, so there is nothing to name. */
export type ApprovalDecisionSource = 'rule' | 'tenant-default' | 'fallback';

/** The whole answer to "who approves this request", not only the chain: WHICH rule won, and WHERE the
 *  chain came from when none did. The extra two fields are what lets the approval replay report coverage —
 *  which of a tenant's rules ever actually win — without a second ranking of the same rows. */
export type ApprovalDecision = {
  levels: LeaveLevelKind[];
  /** The winning rule's id when `source === 'rule'`; null for the tenant default and the built-in chain. */
  ruleId: string | null;
  source: ApprovalDecisionSource;
};

/**
 * Every active rule and template a decision can draw on, READ ONCE.
 *
 * a6fe37fc Round 1 fix pass — the replay resolves a whole GRID of (routing tuple x leave type x day probe)
 * cases, and `resolveApprovalDecision` re-read every active rule and every active template on EVERY call.
 * Against the tenant this harness exists for (261 rules, and a day-probe set that grows with the number of
 * distinct min/max bounds) that is two fresh queries per cell, doubled again when `--coverage` walks the
 * same grid — an unbounded number of round-trips inside one transaction held open against the customer's
 * production database. Reading the rules once and ranking in memory makes the round-trip count CONSTANT in
 * the grid size. It is the same rows and the same ranking either way: `decideApproval` below is the only
 * ranking there is, and `resolveApprovalDecision` is it plus the two reads.
 */
export type ApprovalRuleSet = {
  /** Active rules grouped by company — a decision only ever considers the requester's own company. */
  rulesByCompany: Map<string, RuleRow[]>;
  /** Active template id -> its sanitised ordered levels. */
  templateLevels: Map<string, LeaveLevelKind[]>;
  /** The tenant-default template's levels; empty when the tenant has none. */
  tenantDefaultLevels: LeaveLevelKind[];
};

/**
 * Read the active rules and templates a decision needs. `companyId` narrows the rule read exactly as the
 * per-request path always did; omitting it reads the whole tenant's active rules in one go, which is what
 * the replay wants (it resolves for every company in the tenant).
 *
 * Runs inside the caller's transaction, so under the caller's RLS — the same reads, in the same place, as
 * before this was hoisted out of `resolveApprovalDecision`.
 */
export async function loadApprovalRuleSet(tx: Tx, companyId?: string): Promise<ApprovalRuleSet> {
  const rules = (await tx
    .select({
      id: leaveApprovalPolicy.id,
      companyId: leaveApprovalPolicy.companyId,
      leaveTypeId: leaveApprovalPolicy.leaveTypeId,
      businessUnitId: leaveApprovalPolicy.businessUnitId,
      departmentId: leaveApprovalPolicy.departmentId,
      positionId: leaveApprovalPolicy.positionId,
      gradeId: leaveApprovalPolicy.gradeId,
      gradeGroupId: leaveApprovalPolicy.gradeGroupId,
      employmentType: leaveApprovalPolicy.employmentType,
      minDays: leaveApprovalPolicy.minDays,
      maxDays: leaveApprovalPolicy.maxDays,
      levels: leaveApprovalPolicy.levels,
      templateId: leaveApprovalPolicy.templateId,
      createdAt: leaveApprovalPolicy.createdAt,
    })
    .from(leaveApprovalPolicy)
    .where(
      companyId === undefined
        ? eq(leaveApprovalPolicy.active, true)
        : and(eq(leaveApprovalPolicy.companyId, companyId), eq(leaveApprovalPolicy.active, true)),
    )
    // r281 53e914fe — TOTAL ORDER ON THE ROUTING READ. This read had no ORDER BY at all, and
    // `decideApproval` keeps `matching[0]` when `beats` separates nothing, so the winner of a tie was
    // whatever row the planner happened to hand back first. Same shape as r270's fix on
    // `entitlement_eligibility_rule` (core/entitlement-template.ts): `created_at` then `id`, ascending,
    // so the first row of a tied group is fixed forever.
    .orderBy(leaveApprovalPolicy.createdAt, leaveApprovalPolicy.id)) as RuleRow[];

  // 6fadb036: the tenant's ACTIVE templates (few rows). A rule with template_id draws its chain from the
  // template; the tenant-default template is the fallback just above the built-in chain.
  const templates = await tx
    .select({
      id: leaveApprovalTemplate.id,
      levels: leaveApprovalTemplate.levels,
      isTenantDefault: leaveApprovalTemplate.isTenantDefault,
    })
    .from(leaveApprovalTemplate)
    .where(eq(leaveApprovalTemplate.active, true));

  const rulesByCompany = new Map<string, RuleRow[]>();
  for (const r of rules) {
    const bucket = rulesByCompany.get(r.companyId);
    if (bucket) bucket.push(r);
    else rulesByCompany.set(r.companyId, [r]);
  }
  const templateLevels = new Map<string, LeaveLevelKind[]>();
  let tenantDefaultLevels: LeaveLevelKind[] = [];
  for (const t of templates) {
    const lv = sanitizeLevels(t.levels);
    templateLevels.set(t.id, lv);
    if (t.isTenantDefault) tenantDefaultLevels = lv;
  }
  return { rulesByCompany, templateLevels, tenantDefaultLevels };
}

/**
 * THE RANKING — match -> specificity -> tie-break -> effective levels -> tenant default -> fallback.
 *
 * a6fe37fc Round 1 — THIS IS THE ONE MATCHER. `resolveApprovalDecision` is this function plus its two
 * reads, `resolveApprovalChain` is a one-line wrapper over that, and the approval replay calls this
 * directly over a rule set it read ONCE. The ranking below must never be copied anywhere else: a second
 * ranking of the same rules that drifts from this one is exactly the defect the Leave Configuration
 * replacement exists to remove, and a replay run against a copy of the matcher would prove nothing about
 * how production routes a request.
 *
 * Pure: it performs no I/O, which is what lets the replay resolve a whole grid outside the transaction it
 * read the rules in.
 */
export function decideApproval(
  set: ApprovalRuleSet,
  companyId: string,
  leaveTypeId: string | null,
  attrs: ApprovalMatchAttrs = {},
): ApprovalDecision {
  // The effective ordered chain of a rule: the template's levels when template-driven (and the template is
  // active), else the row's own levels.
  const effectiveLevels = (r: RuleRow): LeaveLevelKind[] =>
    r.templateId ? (set.templateLevels.get(r.templateId) ?? []) : sanitizeLevels(r.levels);

  const matching = (set.rulesByCompany.get(companyId) ?? []).filter((r) => ruleMatches(r, leaveTypeId, attrs));
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
    if (lv.length) return { levels: lv, ruleId: best.id, source: 'rule' };
  }
  // No matching rule (or its effective chain resolved empty): fall back to the org-wide default template,
  // then the built-in chain. Neither names a rule, so `ruleId` is null — a coverage report must not credit
  // a win to a rule that did not win.
  if (set.tenantDefaultLevels.length) {
    return { levels: set.tenantDefaultLevels, ruleId: null, source: 'tenant-default' };
  }
  return { levels: FALLBACK_CHAIN, ruleId: null, source: 'fallback' };
}

/** Resolve the approver decision for a request: the most-specific matching active rule wins, then the
 *  tenant-default template, then the built-in fallback. Runs inside the request transaction (so under the
 *  requester's RLS, which is why the policy is readable tenant-wide). Resolution is scoped to the passed
 *  attributes, which come from the requesting employment's OWN current assignment only (ADR-0071 1(f)).
 *
 *  The two reads plus `decideApproval` — deliberately no ranking of its own. */
export async function resolveApprovalDecision(
  tx: Tx,
  companyId: string,
  leaveTypeId: string | null,
  attrs: ApprovalMatchAttrs = {},
): Promise<ApprovalDecision> {
  return decideApproval(await loadApprovalRuleSet(tx, companyId), companyId, leaveTypeId, attrs);
}

/** The ordered approver levels for a request — every existing caller's entry point, and deliberately a
 *  one-line wrapper: it must have no ranking of its own to drift from `resolveApprovalDecision`'s. */
export async function resolveApprovalChain(
  tx: Tx,
  companyId: string,
  leaveTypeId: string | null,
  attrs: ApprovalMatchAttrs = {},
): Promise<LeaveLevelKind[]> {
  return (await resolveApprovalDecision(tx, companyId, leaveTypeId, attrs)).levels;
}

/** The company-default chain, for the admin editor.
 *
 *  r79 0322 — no longer reports an on/off state. `company.leave_multi_approval` used to gate whether ANY
 *  chain ran; core/leave.ts now branches on the RESOLVED chain's own step count, so there is nothing left
 *  for a per-company switch to say. The column survives unread (no migration). */
export async function getLeaveApprovalPolicy(
  ctx: SessionContext,
  companyId: string,
): Promise<{ levels: LeaveLevelKind[] }> {
  return withTenant(ctx, async (tx) => {
    const [pol] = await tx
      .select({ levels: leaveApprovalPolicy.levels })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.companyId, companyId), isNull(leaveApprovalPolicy.leaveTypeId), defaultRuleFilter()))
      .limit(1);
    const levels = sanitizeLevels(pol?.levels);
    return { levels: levels.length ? levels : FALLBACK_CHAIN };
  });
}

/** SQL predicate isolating the "company default" rule: the fully-wildcard row (no scoping dimension set). */
function defaultRuleFilter() {
  return sql`business_unit_id is null and department_id is null and position_id is null and grade_id is null and grade_group_id is null and employment_type is null and min_days is null and max_days is null`;
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

/** Set a company's default chain. Admin-only (enforced by the policy + company RLS).
 *  Under ADR-0071 the "company default" is the fully-wildcard rule; this upserts that row and leaves any
 *  scoped rules untouched.
 *
 *  r79 0322 — the `enabled` toggle is gone with `company.leave_multi_approval`. A chain of ONE level is
 *  now how a company says "single approver", so the chain may never be empty: an empty default would
 *  silently hand the company back to the built-in direct_manager → hr_admin fallback, which is precisely
 *  the kind of quiet re-route this change exists to remove. */
export async function setLeaveApprovalPolicy(
  ctx: SessionContext,
  p: { companyId: string; levels: string[]; reason?: string | null },
) {
  const levels = sanitizeLevels(p.levels);
  const reason = normalizeReason(p.reason);
  if (levels.length === 0) throw new Error('An approval chain needs at least one level');
  return withTenant(ctx, async (tx) => {
    // 4ec5a940 — capture the prior chain BEFORE the write, so the audit event carries a real before→after
    // comparison (forward-only). The default rule row holds the chain.
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
        before: existing ? { levels: sanitizeLevels(existing.levels) } : null,
        after: { levels },
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
  gradeGroupId: string | null;
  employmentType: EmploymentType | null;
  minDays: number | null;
  maxDays: number | null;
  active: boolean;
  levels: LeaveLevelKind[];
  // 6fadb036: the template this rule draws its chain from (null = custom `levels`).
  templateId: string | null;
};

/** A rule with EVERY scoping dimension null IS the company default (edited by LeaveApprovalEditor), so
 *  rule-matrix surfaces hide it to avoid double-editing. Shared by the Approval tab and the per-type
 *  Approval Workflow sub-step (e1a51aea) so the two filters can never drift. */
export function isCompanyDefaultApprovalRule(r: {
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
}): boolean {
  return (
    r.leaveTypeId == null &&
    r.businessUnitId == null &&
    r.departmentId == null &&
    r.positionId == null &&
    r.gradeId == null &&
    r.gradeGroupId == null &&
    r.employmentType == null &&
    r.minDays == null &&
    r.maxDays == null
  );
}

/** The scoping + chain inputs shared by create/update. Every scoping dimension is nullable/wildcard. */
export type LeaveApprovalRuleInput = {
  companyId: string;
  ruleName?: string | null;
  leaveTypeId?: string | null;
  businessUnitId?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  gradeId?: string | null;
  gradeGroupId?: string | null;
  employmentType?: EmploymentType | null;
  minDays?: number | null;
  maxDays?: number | null;
  levels: string[];
  // R41 72800eda — "Default Workflow": when set, the rule draws its ordered chain from a reusable template
  // (its own `levels` is cleared to []); when null it is a "Custom Workflow" carrying its own `levels`.
  templateId?: string | null;
};

function normDay(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) throw new Error('Day-range bounds must be non-negative whole numbers');
  return v;
}

/** Validate + normalize a rule's inputs, throwing on an unusable rule (empty chain, min>max). A rule is
 *  either "Default Workflow" (templateId set → the template is the chain, its own `levels` cleared to []) or
 *  "Custom Workflow" (templateId null → its own non-empty `levels`); one of the two must be present. */
function cleanRuleInput(p: LeaveApprovalRuleInput) {
  const templateId = p.templateId?.trim() ? p.templateId.trim() : null;
  // R41 72800eda — a template-driven ("Default") rule clears its own levels; a custom rule keeps them.
  const levels = templateId ? [] : sanitizeLevels(p.levels);
  if (!templateId && levels.length === 0) {
    throw new Error('A rule needs at least one approval level, or a template to draw its chain from');
  }
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
    gradeGroupId: p.gradeGroupId ?? null,
    employmentType: p.employmentType ?? null,
    minDays,
    maxDays,
    levels,
    templateId,
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
        eqOrNull(leaveApprovalPolicy.gradeGroupId, c.gradeGroupId),
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
        gradeGroupId: c.gradeGroupId,
        employmentType: c.employmentType,
        minDays: c.minDays,
        maxDays: c.maxDays,
        active: true,
        levels: c.levels,
        templateId: c.templateId,
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
        gradeGroupId: leaveApprovalPolicy.gradeGroupId,
        employmentType: leaveApprovalPolicy.employmentType,
        minDays: leaveApprovalPolicy.minDays,
        maxDays: leaveApprovalPolicy.maxDays,
        levels: leaveApprovalPolicy.levels,
        templateId: leaveApprovalPolicy.templateId,
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
        gradeGroupId: c.gradeGroupId,
        employmentType: c.employmentType,
        minDays: c.minDays,
        maxDays: c.maxDays,
        levels: c.levels,
        templateId: c.templateId,
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
              gradeGroupId: prev.gradeGroupId,
              employmentType: prev.employmentType,
              minDays: prev.minDays,
              maxDays: prev.maxDays,
              levels: sanitizeLevels(prev.levels),
              templateId: prev.templateId,
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
        gradeGroupId: leaveApprovalPolicy.gradeGroupId,
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
      .orderBy(leaveApprovalPolicy.createdAt, leaveApprovalPolicy.id);
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
        gradeGroupId: r.gradeGroupId,
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

// ──────────────────────────── R51 722904dc — approval escalation settings ────────────────────────────

export const ESCALATION_TARGETS = ['next_level', 'specific_role'] as const;
export type LeaveEscalationTarget = (typeof ESCALATION_TARGETS)[number];

export type LeaveEscalationPolicy = {
  enabled: boolean;
  /** Working days a step may sit pending before escalation. Null while disabled. */
  escalateAfterDays: number | null;
  /** 'next_level' (default) = the next approver in the chain; 'specific_role' = a named LEVEL_KINDS role. */
  target: LeaveEscalationTarget;
  targetRole: LeaveLevelKind | null;
};

/** A company's approval-escalation settings, for the admin editor and the nightly sweep. */
export async function getLeaveEscalationPolicy(
  ctx: SessionContext,
  companyId: string,
): Promise<LeaveEscalationPolicy> {
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({
        enabled: company.escalationEnabled,
        escalateAfterDays: company.escalateAfterDays,
        target: company.escalationTarget,
        targetRole: company.escalationTargetRole,
      })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    const target: LeaveEscalationTarget =
      co?.target === 'specific_role' ? 'specific_role' : 'next_level';
    const targetRole = (LEVEL_KINDS as readonly string[]).includes(co?.targetRole ?? '')
      ? (co?.targetRole as LeaveLevelKind)
      : null;
    return {
      enabled: co?.enabled ?? false,
      escalateAfterDays: co?.escalateAfterDays ?? null,
      target,
      targetRole,
    };
  });
}

/** Save a company's approval-escalation settings. NOT part of the rule matrix — escalation is one number
 *  + one target per company, and ADR-0071's matrix is deliberately not its home. r79 0322 relocated the
 *  FORM into the Assign Template card; this function, its columns and the nightly sweep are unchanged.
 *  Sets escalation_updated_at = now() on EVERY save: the sweep grandfathers any request whose waiting clock
 *  started before that stamp, so turning escalation on (or shortening the days) never fires a day-one burst
 *  for requests that were already old. Admin-only (company RLS). */
export async function setLeaveEscalationPolicy(
  ctx: SessionContext,
  p: {
    companyId: string;
    enabled: boolean;
    escalateAfterDays?: number | null;
    target?: string | null;
    targetRole?: string | null;
    reason?: string | null;
  },
) {
  const target: LeaveEscalationTarget = p.target === 'specific_role' ? 'specific_role' : 'next_level';
  const days = p.escalateAfterDays ?? null;
  if (p.enabled) {
    if (days == null || !Number.isInteger(days) || days < 1 || days > 90) {
      throw new Error('Escalation needs a working-day threshold between 1 and 90');
    }
  }
  let targetRole: LeaveLevelKind | null = null;
  if (target === 'specific_role') {
    if (!(LEVEL_KINDS as readonly string[]).includes(p.targetRole ?? '')) {
      throw new Error('Escalating to a specific role needs a valid approval level');
    }
    targetRole = p.targetRole as LeaveLevelKind;
  }
  const reason = normalizeReason(p.reason);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        enabled: company.escalationEnabled,
        escalateAfterDays: company.escalateAfterDays,
        target: company.escalationTarget,
        targetRole: company.escalationTargetRole,
      })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    await tx
      .update(company)
      .set({
        escalationEnabled: p.enabled,
        escalateAfterDays: p.enabled ? days : null,
        escalationTarget: target,
        escalationTargetRole: targetRole,
        escalationUpdatedAt: sql`now()`,
      })
      .where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'leave-escalation-policy.updated',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        before: before
          ? {
              enabled: before.enabled,
              escalateAfterDays: before.escalateAfterDays,
              target: before.target,
              targetRole: before.targetRole,
            }
          : null,
        after: { enabled: p.enabled, escalateAfterDays: p.enabled ? days : null, target, targetRole },
        ...(reason ? { reason } : {}),
      },
    });
    return { id: p.companyId };
  });
}

// r79 0322 — setLeaveMultiApproval (6fadb036) is GONE, with the per-company Multi-Step Approval switch it
// flipped. A template assignment no longer needs a company opt-in to fire: core/leave.ts branches on the
// resolved chain's own step count, so the switch had nothing left to say and could only disagree with the
// template. `company.leave_multi_approval` remains in the schema, unread — removing a column would be a
// migration, and an unread column changes nothing.
