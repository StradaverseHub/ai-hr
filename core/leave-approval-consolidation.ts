/**
 * 241817ef — CONVERT FIRST, REMOVE SECOND.
 *
 * The Approval tab still carries two editors that the Assignment Template screen cannot express, and the
 * item that wants those editors gone can only be built once nothing DEPENDS on them:
 *
 *   1. the per-company BASE CHAIN — the fully-wildcard rule (leave_type_id null AND every scoping
 *      dimension null), and
 *   2. any other rule whose leave_type_id is null ("applies to every leave type"), which the Leave Type
 *      workspace deliberately renders READ-ONLY ("edited on the Approval tab"), and
 *   3. rules that carry their own `levels` instead of a template_id, which never appear in the
 *      assignments table (listTemplateAssignments filters `template_id is not null`).
 *
 * Deleting those surfaces without moving the rows first does NOT make requests unroutable — resolution
 * falls through to the tenant-default template and then the built-in [direct_manager, hr_admin] chain, so
 * the requests keep flowing and quietly reach a DIFFERENT approver. That silent re-route is the whole risk
 * of this item, and this module is how it is removed: it rewrites every such row as an ordinary
 * template-driven, leave-type-scoped assignment — the shape the Assignment Template screen owns — and
 * PROVES, inside the same transaction, that not one employee's resolved approver chain moved.
 *
 * The proof is not advisory. `convertLegacyApprovalRules` snapshots the resolved chain for every routing
 * subject × leave type × day-range probe BEFORE the rewrite, re-resolves them AFTER it, and throws
 * (rolling the transaction back) on the first difference. A dry run performs exactly the same writes and
 * the same proof, then rolls back on purpose — so "it would be routing-neutral" is a measured result, not
 * a prediction.
 *
 * Resolution itself is untouched: this module calls the real `resolveApprovalChain`, never a local copy,
 * so the proof cannot drift away from what production actually does.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  department,
  employment,
  employmentTypeEnum,
  gradeGroupMember,
  leaveApprovalPolicy,
  leaveApprovalTemplate,
  leaveType,
} from '../db/schema';
import {
  resolveApprovalChain,
  sanitizeLevels,
  type ApprovalMatchAttrs,
  type LeaveLevelKind,
} from './leave-approval-policy';

type EmploymentType = (typeof employmentTypeEnum.enumValues)[number];

/** Why a row cannot live on the Assignment Template screen as it stands. A row may carry both. */
export type LegacyApprovalReason =
  /** `template_id` null — carries its own `levels`, so listTemplateAssignments never returns it. */
  | 'no-template'
  /** `leave_type_id` null — "any leave type", which the assign form cannot express (it requires ≥1 type). */
  | 'any-leave-type';

export type LegacyApprovalRule = {
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
  levels: LeaveLevelKind[];
  templateId: string | null;
  reasons: LegacyApprovalReason[];
};

/** One thing the conversion did (or, on a dry run, would do). The script prints these — the approved plan
 *  promises the reporter "the list of what got converted" BEFORE the old sections disappear. */
export type ConversionAction =
  | { kind: 'template-created'; templateId: string; name: string; levels: LeaveLevelKind[] }
  | { kind: 'template-reused'; templateId: string; name: string; levels: LeaveLevelKind[] }
  | { kind: 'rule-templated'; ruleId: string; companyId: string; leaveTypeId: string | null; templateId: string }
  | {
      kind: 'expanded';
      sourceRuleId: string;
      companyId: string;
      leaveTypeId: string;
      targetRuleId: string;
      created: boolean;
      templateId: string;
    }
  | { kind: 'source-archived'; ruleId: string; companyId: string }
  | { kind: 'skipped'; ruleId: string; companyId: string; leaveTypeId: string | null; reason: string };

export type ConversionReport = {
  applied: boolean;
  /** The rows that needed converting, as they stood before any write. */
  legacy: LegacyApprovalRule[];
  actions: ConversionAction[];
  /** How many (routing subject × leave type × day probe) chains the proof compared. */
  routingChecks: number;
  /** Active employments the routing subjects stand for. */
  employmentsCovered: number;
};

/** Thrown when the rewrite would move ANY employee's resolved approver chain. Carries the first few
 *  differences so the operator can see exactly what would have changed. Throwing rolls the transaction
 *  back, so a failed proof leaves the database untouched — the conversion is all-or-nothing. */
export class ApprovalRoutingChangedError extends Error {
  readonly differences: RoutingDifference[];
  constructor(differences: RoutingDifference[]) {
    super(
      `Conversion would change the resolved approval chain for ${differences.length} routing case(s) — ` +
        `nothing was written. First: ${describeDifference(differences[0])}`,
    );
    this.name = 'ApprovalRoutingChangedError';
    this.differences = differences;
  }
}

export type RoutingDifference = {
  companyId: string;
  employmentId: string;
  leaveTypeId: string;
  days: number;
  before: string;
  after: string;
};

function describeDifference(d: RoutingDifference | undefined): string {
  if (!d) return '(none)';
  return `employment ${d.employmentId}, leave type ${d.leaveTypeId}, ${d.days} day(s): ${d.before} → ${d.after}`;
}

// ──────────────────────────── enumeration ────────────────────────────

/** Every ACTIVE rule that the Assignment Template screen cannot own yet. Ordered so the report reads
 *  company-by-company. Read-only — safe to call for a listing. */
export async function listLegacyApprovalRules(tx: Tx): Promise<LegacyApprovalRule[]> {
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
      levels: leaveApprovalPolicy.levels,
      templateId: leaveApprovalPolicy.templateId,
    })
    .from(leaveApprovalPolicy)
    .where(
      and(
        eq(leaveApprovalPolicy.active, true),
        sql`(${leaveApprovalPolicy.templateId} is null or ${leaveApprovalPolicy.leaveTypeId} is null)`,
      ),
    )
    .orderBy(leaveApprovalPolicy.companyId, leaveApprovalPolicy.createdAt);
  return rows.map((r) => {
    const reasons: LegacyApprovalReason[] = [];
    if (r.templateId === null) reasons.push('no-template');
    if (r.leaveTypeId === null) reasons.push('any-leave-type');
    return { ...r, levels: sanitizeLevels(r.levels), reasons };
  });
}

/**
 * A distinct set of scoping attributes some active employment actually has, with one representative
 * employment id and how many employments share it.
 *
 * Resolution is a PURE function of (companyId, attrs, leaveTypeId, days) — `resolveApprovalChain` reads
 * nothing else about the requester — so comparing one representative per distinct tuple compares every
 * employment that shares it. That is what makes "prove it for every active employment" affordable: a
 * production tenant has hundreds of employments but only dozens of distinct routing tuples.
 *
 * The attribute query mirrors `resolveRequestApprovalChain` in core/leave.ts exactly: the employment's own
 * grade, its CURRENT open assignment (validTo/supersededAt null), that assignment's department's business
 * unit, and the grade's group via grade_group_member.
 */
export async function listRoutingSubjects(
  tx: Tx,
): Promise<{ subjects: RoutingSubject[]; employmentsCovered: number }> {
  const rows = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      gradeId: employment.gradeId,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      employmentType: assignment.employmentType,
      businessUnitId: department.businessUnitId,
      gradeGroupId: gradeGroupMember.gradeGroupId,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .leftJoin(gradeGroupMember, eq(gradeGroupMember.gradeId, employment.gradeId))
    .where(isNull(employment.terminatedOn));

  const byTuple = new Map<string, RoutingSubject>();
  for (const r of rows) {
    const attrs: ApprovalMatchAttrs = {
      businessUnitId: r.businessUnitId ?? null,
      departmentId: r.departmentId ?? null,
      positionId: r.positionId ?? null,
      gradeId: r.gradeId ?? null,
      gradeGroupId: r.gradeGroupId ?? null,
      employmentType: r.employmentType ?? null,
    };
    const key = [
      r.companyId,
      attrs.businessUnitId,
      attrs.departmentId,
      attrs.positionId,
      attrs.gradeId,
      attrs.gradeGroupId,
      attrs.employmentType,
    ].join('|');
    const hit = byTuple.get(key);
    if (hit) hit.employmentCount += 1;
    else byTuple.set(key, { companyId: r.companyId, employmentId: r.employmentId, employmentCount: 1, attrs });
  }
  return { subjects: [...byTuple.values()], employmentsCovered: rows.length };
}

export type RoutingSubject = {
  companyId: string;
  /** One employment that has this exact tuple — named in a difference so the operator can look it up. */
  employmentId: string;
  employmentCount: number;
  attrs: ApprovalMatchAttrs;
};

/**
 * Day counts that exercise every day-range boundary configured anywhere in the tenant.
 *
 * A rule's day range only changes the answer AT its bounds, so probing each bound and the value either
 * side of it (plus 0, and one value above the largest bound) covers every interval the matrix can express.
 * Probing "1, 2, 3…" instead would be both slower and less complete.
 */
export async function approvalDayProbes(tx: Tx): Promise<number[]> {
  const rows = await tx
    .select({ minDays: leaveApprovalPolicy.minDays, maxDays: leaveApprovalPolicy.maxDays })
    .from(leaveApprovalPolicy)
    .where(eq(leaveApprovalPolicy.active, true));
  const probes = new Set<number>([0, 1]);
  let largest = 1;
  for (const r of rows) {
    for (const b of [r.minDays, r.maxDays]) {
      if (b == null) continue;
      largest = Math.max(largest, b);
      for (const d of [b - 1, b, b + 1]) if (d >= 0) probes.add(d);
    }
  }
  probes.add(largest + 1);
  return [...probes].sort((a, b) => a - b);
}

/** Resolve every (subject × leave type × day probe) chain, keyed so before/after line up exactly. */
async function snapshotApprovalRouting(
  tx: Tx,
  subjects: RoutingSubject[],
  leaveTypeIds: string[],
  dayProbes: number[],
): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const s of subjects) {
    for (const leaveTypeId of leaveTypeIds) {
      for (const days of dayProbes) {
        const chain = await resolveApprovalChain(tx, s.companyId, leaveTypeId, { ...s.attrs, days });
        snap.set(`${s.employmentId}|${leaveTypeId}|${days}`, chain.join(' → '));
      }
    }
  }
  return snap;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
  subjects: RoutingSubject[],
): RoutingDifference[] {
  const companyOf = new Map(subjects.map((s) => [s.employmentId, s.companyId]));
  const out: RoutingDifference[] = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (now === was) continue;
    const [employmentId, leaveTypeId, days] = key.split('|');
    out.push({
      companyId: companyOf.get(employmentId) ?? '',
      employmentId,
      leaveTypeId,
      days: Number(days),
      before: was,
      after: now ?? '(unresolved)',
    });
  }
  return out;
}

// ──────────────────────────── conversion ────────────────────────────

/** A readable, deterministic name for a template minted from an existing chain. Deterministic so a
 *  re-run finds the template it created last time instead of minting a near-duplicate. */
export function conversionTemplateName(levels: LeaveLevelKind[]): string {
  return levels.map((l) => l.replace(/_/g, ' ')).join(' → ');
}

/** The bucket a converted row must land in: same company + leave type, and every other scoping dimension
 *  IDENTICAL to the source row (`is not distinct from`, so null matches null). Matching on ALL of them is
 *  what keeps the expansion routing-neutral — a row that differs on any dimension is a different rule and
 *  must not be overwritten. Deliberately NOT filtered on `active`: leave_approval_policy_wildcard_uq has
 *  no active predicate, so an ARCHIVED fully-wildcard row still occupies the bucket and an insert beside
 *  it would violate the index. */
function sourceScopeBucket(r: LegacyApprovalRule, leaveTypeId: string) {
  return and(
    eq(leaveApprovalPolicy.companyId, r.companyId),
    eq(leaveApprovalPolicy.leaveTypeId, leaveTypeId),
    sql`business_unit_id is not distinct from ${r.businessUnitId}::uuid
      and department_id is not distinct from ${r.departmentId}::uuid
      and position_id is not distinct from ${r.positionId}::uuid
      and grade_id is not distinct from ${r.gradeId}::uuid
      and grade_group_id is not distinct from ${r.gradeGroupId}::uuid
      and employment_type is not distinct from ${r.employmentType}::employment_type
      and min_days is not distinct from ${r.minDays}::int
      and max_days is not distinct from ${r.maxDays}::int`,
  );
}

/** Internal signal used to roll a dry run back once its writes and its proof have both succeeded. */
class DryRunComplete extends Error {
  readonly report: ConversionReport;
  constructor(report: ConversionReport) {
    super('dry run complete');
    this.name = 'DryRunComplete';
    this.report = report;
  }
}

/**
 * Rewrite every legacy approval rule as an ordinary template-driven, leave-type-scoped assignment, and
 * prove the rewrite changed nobody's approver.
 *
 * Two independent rewrites, in this order (a row can need both):
 *   1. NO TEMPLATE → find the active template whose chain is already identical, else mint one, then point
 *      the row at it and clear its own `levels` (the shape assignApprovalTemplate writes).
 *   2. ANY LEAVE TYPE → write one row per leave type the tenant has, carrying the SAME scoping dimensions
 *      and the SAME template, then archive the wildcard source. A leave type that already has a row in the
 *      identical bucket is left alone and reported as skipped: it already wins over the wildcard today, so
 *      touching it is the one thing that WOULD move an approver.
 *
 * `apply: false` (the default) does all of it and rolls back, so the report is measured rather than
 * predicted. Nothing is written unless the proof passes.
 */
export async function convertLegacyApprovalRules(
  ctx: SessionContext,
  opts: { apply?: boolean } = {},
): Promise<ConversionReport> {
  const apply = opts.apply === true;
  try {
    return await withTenant(ctx, async (tx) => {
      const legacy = await listLegacyApprovalRules(tx);
      const { subjects, employmentsCovered } = await listRoutingSubjects(tx);
      const types = await tx.select({ id: leaveType.id }).from(leaveType);
      const leaveTypeIds = types.map((t) => t.id);
      const dayProbes = await approvalDayProbes(tx);

      const before = await snapshotApprovalRouting(tx, subjects, leaveTypeIds, dayProbes);
      const actions: ConversionAction[] = [];

      for (const rule of legacy) {
        // ── 1. give the row a template ────────────────────────────────────────────────────────────
        let templateId = rule.templateId;
        if (templateId === null) {
          if (rule.levels.length === 0) {
            // An active rule with neither a template nor a usable chain resolves to nothing and is
            // already skipped by resolution (`if (lv.length) return lv`). Converting it would INVENT a
            // chain, which is a routing change; report it for a human instead.
            actions.push({
              kind: 'skipped',
              ruleId: rule.id,
              companyId: rule.companyId,
              leaveTypeId: rule.leaveTypeId,
              reason: 'no template and no usable chain — resolution already ignores this row',
            });
            continue;
          }
          templateId = await ensureTemplateFor(tx, ctx, rule.levels, actions);
          await tx
            .update(leaveApprovalPolicy)
            .set({ templateId, levels: [], updatedAt: sql`now()` })
            .where(eq(leaveApprovalPolicy.id, rule.id));
          await appendEvent(tx, {
            tenantId: ctx.tenantId,
            aggregateType: 'leave-approval-policy',
            aggregateId: rule.id,
            eventType: 'leave-approval-rule.updated',
            actor: actorOf(ctx),
            payload: {
              companyId: rule.companyId,
              before: { levels: rule.levels, templateId: null },
              after: { levels: [], templateId },
              reason: '241817ef — converted to a template assignment before the Approval Workflows section is removed',
            },
          });
          actions.push({
            kind: 'rule-templated',
            ruleId: rule.id,
            companyId: rule.companyId,
            leaveTypeId: rule.leaveTypeId,
            templateId,
          });
        }

        // ── 2. expand an "any leave type" row into one row per leave type ─────────────────────────
        if (rule.leaveTypeId !== null) continue;
        for (const leaveTypeId of leaveTypeIds) {
          const [existing] = await tx
            .select({ id: leaveApprovalPolicy.id, active: leaveApprovalPolicy.active })
            .from(leaveApprovalPolicy)
            .where(sourceScopeBucket(rule, leaveTypeId))
            .limit(1);
          if (existing?.active) {
            actions.push({
              kind: 'skipped',
              ruleId: rule.id,
              companyId: rule.companyId,
              leaveTypeId,
              reason: 'an identically-scoped rule already covers this leave type and wins today',
            });
            continue;
          }
          let targetRuleId: string;
          let created: boolean;
          if (existing) {
            // Archived row sitting in the bucket. The wildcard unique index counts it, so it must be
            // REUSED rather than inserted beside. It takes the source's chain, so resolution is unchanged.
            await tx
              .update(leaveApprovalPolicy)
              .set({ templateId, levels: [], active: true, ruleName: rule.ruleName, updatedAt: sql`now()` })
              .where(eq(leaveApprovalPolicy.id, existing.id));
            targetRuleId = existing.id;
            created = false;
          } else {
            const [row] = await tx
              .insert(leaveApprovalPolicy)
              .values({
                tenantId: ctx.tenantId,
                companyId: rule.companyId,
                ruleName: rule.ruleName,
                leaveTypeId,
                businessUnitId: rule.businessUnitId,
                departmentId: rule.departmentId,
                positionId: rule.positionId,
                gradeId: rule.gradeId,
                gradeGroupId: rule.gradeGroupId,
                employmentType: rule.employmentType,
                minDays: rule.minDays,
                maxDays: rule.maxDays,
                active: true,
                levels: [],
                templateId,
              })
              .returning({ id: leaveApprovalPolicy.id });
            targetRuleId = row.id;
            created = true;
          }
          await appendEvent(tx, {
            tenantId: ctx.tenantId,
            aggregateType: 'leave-approval-policy',
            aggregateId: targetRuleId,
            eventType: created ? 'leave-approval-rule.created' : 'leave-approval-rule.updated',
            actor: actorOf(ctx),
            payload: {
              companyId: rule.companyId,
              leaveTypeId,
              templateId,
              convertedFromRuleId: rule.id,
              reason: '241817ef — the any-leave-type rule rewritten as an explicit per-type assignment',
            },
          });
          actions.push({
            kind: 'expanded',
            sourceRuleId: rule.id,
            companyId: rule.companyId,
            leaveTypeId,
            targetRuleId,
            created,
            templateId,
          });
        }
        await tx
          .update(leaveApprovalPolicy)
          .set({ active: false, updatedAt: sql`now()` })
          .where(eq(leaveApprovalPolicy.id, rule.id));
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-approval-policy',
          aggregateId: rule.id,
          eventType: 'leave-approval-rule.archived',
          actor: actorOf(ctx),
          payload: {
            companyId: rule.companyId,
            reason: '241817ef — replaced by explicit per-leave-type assignments',
          },
        });
        actions.push({ kind: 'source-archived', ruleId: rule.id, companyId: rule.companyId });
      }

      // ── the proof ────────────────────────────────────────────────────────────────────────────────
      const after = await snapshotApprovalRouting(tx, subjects, leaveTypeIds, dayProbes);
      const differences = diffSnapshots(before, after, subjects);
      if (differences.length) throw new ApprovalRoutingChangedError(differences);

      const report: ConversionReport = {
        applied: apply,
        legacy,
        actions,
        routingChecks: before.size,
        employmentsCovered,
      };
      if (!apply) throw new DryRunComplete(report);
      return report;
    });
  } catch (e) {
    if (e instanceof DryRunComplete) return e.report;
    throw e;
  }
}

/** Find the ACTIVE template whose chain already equals `levels`, else mint one. Compared in JS on the
 *  sanitized array so an unknown level kind stored on an old row cannot make two chains look different. */
async function ensureTemplateFor(
  tx: Tx,
  ctx: SessionContext,
  levels: LeaveLevelKind[],
  actions: ConversionAction[],
): Promise<string> {
  const existing = await tx
    .select({ id: leaveApprovalTemplate.id, name: leaveApprovalTemplate.name, levels: leaveApprovalTemplate.levels })
    .from(leaveApprovalTemplate)
    .where(eq(leaveApprovalTemplate.active, true))
    .orderBy(leaveApprovalTemplate.createdAt);
  const want = levels.join('|');
  const hit = existing.find((t) => sanitizeLevels(t.levels).join('|') === want);
  if (hit) {
    if (!actions.some((a) => a.kind === 'template-reused' && a.templateId === hit.id)) {
      actions.push({ kind: 'template-reused', templateId: hit.id, name: hit.name, levels });
    }
    return hit.id;
  }
  const taken = new Set(existing.map((t) => t.name.toLowerCase()));
  const base = conversionTemplateName(levels);
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  const [row] = await tx
    .insert(leaveApprovalTemplate)
    .values({ tenantId: ctx.tenantId, name, description: null, levels })
    .returning({ id: leaveApprovalTemplate.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-approval-template',
    aggregateId: row.id,
    eventType: 'leave-approval-template.created',
    actor: actorOf(ctx),
    payload: { name, levels, reason: '241817ef — minted for a rule that carried its own chain' },
  });
  actions.push({ kind: 'template-created', templateId: row.id, name, levels });
  return row.id;
}
