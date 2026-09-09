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
 *
 * ONE THING THE PROOF CANNOT COVER, stated here because it is the real cost of the item rather than a
 * defect in the conversion. "Applies to every leave type" also meant every leave type created LATER. Once
 * a wildcard row is expanded into explicit per-type assignments and archived, a leave type added
 * afterwards matches none of them and resolves through the tenant-default template, then the built-in
 * chain. That is inherent in the Assignment Template screen's model (its assign form requires at least one
 * leave type), not in this rewrite — but it means a NEW leave type now needs an assignment, where before
 * it inherited the company's base chain. `conversionCaveats` reports it for the companies it applies to so
 * the operator sees it before, not after.
 *
 * ── a6fe37fc ROUND 1: THIS MODULE IS ALSO THE APPROVAL REPLAY HARNESS ──────────────────────────────────
 *
 * The Leave Configuration replacement has to prove the same thing this conversion proves — that no
 * employee's approver moved — but across a whole rebuild rather than one rewrite, and against the
 * customer's real configuration. It is the SAME proof, so it is the same code: `snapshotApprovalRouting`
 * and `diffSnapshots` were promoted, unchanged, to `approvalRoutingSnapshot` and `diffApprovalRouting`,
 * and three functions were added around them — `approvalRoutingCoverage` (which rules ever WIN),
 * `replayApprovalRouting` (one read-only transaction that always rolls back: the shape that makes running
 * against production safe) and `verifyApprovalRouting` (which findings are FAILURES).
 * `scripts/replay-approval-routing.ts` is a CLI over those, and nothing it has to be right about lives
 * only in the script — a script runs by hand on the server, where no gate can see it.
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
  resolveApprovalDecision,
  sanitizeLevels,
  type ApprovalDecisionSource,
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
  /**
   * Consequences the before/after proof cannot see, because they concern configuration that does not
   * exist yet. One entry per company whose "applies to every leave type" rule was expanded: a leave type
   * added AFTER the conversion no longer inherits that rule and needs an assignment of its own.
   */
  caveats: { companyId: string; note: string }[];
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

/**
 * Resolve every (subject × leave type × day probe) chain, keyed so before/after line up exactly.
 *
 * a6fe37fc Round 1 — EXPORTED, unchanged. It was private to this module's conversion proof; the approval
 * replay harness (`scripts/replay-approval-routing.ts`) compares a tenant's routing across a whole
 * migration with the SAME function, so the cutover gate and the conversion proof cannot drift apart. Not
 * one line of its logic was rewritten to promote it, deliberately: a re-implementation would be a second
 * answer to "what does this tenant's configuration resolve to", which is the thing being guarded against.
 */
export async function approvalRoutingSnapshot(
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

/**
 * Every key whose resolved chain moved between two snapshots, named rather than counted so the operator
 * can look the employee up. a6fe37fc Round 1 — EXPORTED, unchanged, for the same reason as
 * `approvalRoutingSnapshot`.
 *
 * Keys present in `after` but absent from `before` are NOT differences: a leave type or an employment
 * that did not exist when the baseline was taken has no "before" chain to have moved from.
 */
export function diffApprovalRouting(
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

// ──────────────────────────── coverage ────────────────────────────

/** One active rule, and how many resolutions it actually won. */
export type ApprovalRuleCoverage = {
  ruleId: string;
  companyId: string;
  ruleName: string | null;
  leaveTypeId: string | null;
  /** Cases (subject × leave type × day probe) this rule won. **0 means the rule is unreachable TODAY** —
   *  scoped to something no active employment has, or shadowed by a more specific rule. */
  wins: number;
};

export type ApprovalRoutingCoverage = {
  /** How many (subject × leave type × day probe) resolutions were performed. */
  decisions: number;
  /** Where those resolutions ended: a rule, the tenant-default template, or the built-in chain. */
  bySource: Record<ApprovalDecisionSource, number>;
  /** Every ACTIVE rule in the tenant, most-winning first. Rules with `wins: 0` are the honest limit of the
   *  replay's promise: it proves nothing changed for any real employee, and a rule that reaches no real
   *  employee is proven unchanged only in the sense that it reached nobody before and reaches nobody now. */
  rules: ApprovalRuleCoverage[];
};

/**
 * WHICH RULES EVER WIN, over the same grid the snapshot compares.
 *
 * a6fe37fc migration order §2.3. A replay over rules that never match proves nothing about them, so the
 * harness reports the rules that never won rather than letting a clean diff imply they were checked. It
 * calls `resolveApprovalDecision` — the SAME matcher `resolveApprovalChain` wraps — so a rule credited
 * with a win here is a rule that would route a real request, not one a second ranking thinks would.
 *
 * Read-only. Kept separate from `approvalRoutingSnapshot` (rather than folded into it) because that
 * function is the before/after proof and is promoted unchanged on purpose.
 */
export async function approvalRoutingCoverage(
  tx: Tx,
  subjects: RoutingSubject[],
  leaveTypeIds: string[],
  dayProbes: number[],
): Promise<ApprovalRoutingCoverage> {
  const rows = await tx
    .select({
      id: leaveApprovalPolicy.id,
      companyId: leaveApprovalPolicy.companyId,
      ruleName: leaveApprovalPolicy.ruleName,
      leaveTypeId: leaveApprovalPolicy.leaveTypeId,
    })
    .from(leaveApprovalPolicy)
    .where(eq(leaveApprovalPolicy.active, true))
    .orderBy(leaveApprovalPolicy.companyId, leaveApprovalPolicy.createdAt);

  const wins = new Map<string, number>();
  const bySource: Record<ApprovalDecisionSource, number> = { rule: 0, 'tenant-default': 0, fallback: 0 };
  let decisions = 0;
  for (const s of subjects) {
    for (const leaveTypeId of leaveTypeIds) {
      for (const days of dayProbes) {
        const d = await resolveApprovalDecision(tx, s.companyId, leaveTypeId, { ...s.attrs, days });
        decisions += 1;
        bySource[d.source] += 1;
        if (d.ruleId) wins.set(d.ruleId, (wins.get(d.ruleId) ?? 0) + 1);
      }
    }
  }
  const rules = rows.map((r) => ({
    ruleId: r.id,
    companyId: r.companyId,
    ruleName: r.ruleName,
    leaveTypeId: r.leaveTypeId,
    wins: wins.get(r.id) ?? 0,
  }));
  rules.sort((a, b) => b.wins - a.wins || a.companyId.localeCompare(b.companyId) || a.ruleId.localeCompare(b.ruleId));
  return { decisions, bySource, rules };
}

// ──────────────────────────── the replay ────────────────────────────

/** One tenant's resolved routing, as read inside a single read-only transaction that was rolled back. */
export type RoutingReplay = {
  tenantId: string;
  /** One representative employment per distinct routing tuple. */
  subjects: RoutingSubject[];
  /** The real headcount those representatives stand for — the promise is about employees, not tuples. */
  employmentsCovered: number;
  leaveTypeIds: string[];
  dayProbes: number[];
  /** `employmentId|leaveTypeId|days` → the resolved chain, joined with ' → '. */
  chains: Map<string, string>;
  coverage: ApprovalRoutingCoverage | null;
  /** What POSTGRES says about the transaction the replay ran in — not what this module believes. */
  readOnlyEnforced: boolean;
};

/** Internal signal that the replay finished; throwing it rolls the transaction back. The replay NEVER
 *  commits, so there is no success path out of the transaction and no flag that could add one. */
class ReplayComplete extends Error {
  readonly replay: RoutingReplay;
  constructor(replay: RoutingReplay) {
    super('replay complete');
    this.name = 'ReplayComplete';
    this.replay = replay;
  }
}

/**
 * a6fe37fc Round 1 — READ ONE TENANT'S APPROVAL ROUTING, PROVE NOTHING WAS WRITTEN.
 *
 * The engine behind `scripts/replay-approval-routing.ts`, and it lives HERE rather than in the script so
 * that the thing which runs against the customer's production database is the thing the gate exercises on
 * every run (`test/leave-approval-replay.test.ts`). A safety shape that only the script has is a safety
 * shape nothing tests.
 *
 * THE SHAPE IS THE SAFETY, and all three parts of it are load-bearing:
 *   · READS ONLY — enforced by Postgres (`SET TRANSACTION READ ONLY`), not by this module's good
 *     intentions, and the enforcement is read back and returned so a caller can assert it.
 *   · ONE TRANSACTION THAT ALWAYS ROLLS BACK — the only way out is `ReplayComplete`, thrown after the
 *     reads. There is no commit path to add a write to later.
 *   · NO APPLY MODE. `convertLegacyApprovalRules` has one because it converts; this replays. Nothing here
 *     takes a write option, and nothing may be given one.
 *
 * `extraLeaveTypeIds` / `extraDayProbes` exist for `--verify`: a baseline's grid is unioned in so the two
 * snapshots line up key-for-key even when a leave type or a day-range bound was added since. They only
 * ever ADD keys to resolve; they cannot remove one, so a verify can never quietly stop checking a case.
 */
export async function replayApprovalRouting(
  ctx: SessionContext,
  opts: { extraLeaveTypeIds?: string[]; extraDayProbes?: number[]; coverage?: boolean } = {},
): Promise<RoutingReplay> {
  try {
    return await withTenant(ctx, async (tx) => {
      // Belt and braces, in that order: the transaction is made read-only by the DATABASE before a single
      // row is read, so even a future edit that tried to write would fail rather than succeed quietly.
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const ro = await tx.execute(sql`select current_setting('transaction_read_only') as ro`);
      const readOnlyEnforced = (ro as unknown as { ro: string }[])[0]?.ro === 'on';

      const { subjects, employmentsCovered } = await listRoutingSubjects(tx);
      // EVERY leave type, archived included: a rule scoped to an archived type still matches if the type is
      // ever used, and excluding it would leave a blind spot exactly where a migration is most careless.
      const types = await tx.select({ id: leaveType.id }).from(leaveType);
      const leaveTypeIds = [...new Set([...types.map((t) => t.id), ...(opts.extraLeaveTypeIds ?? [])])].sort();
      const dayProbes = [...new Set([...(await approvalDayProbes(tx)), ...(opts.extraDayProbes ?? [])])].sort(
        (a, b) => a - b,
      );

      const chains = await approvalRoutingSnapshot(tx, subjects, leaveTypeIds, dayProbes);
      const coverage = opts.coverage
        ? await approvalRoutingCoverage(tx, subjects, leaveTypeIds, dayProbes)
        : null;

      throw new ReplayComplete({
        tenantId: ctx.tenantId,
        subjects,
        employmentsCovered,
        leaveTypeIds,
        dayProbes,
        chains,
        coverage,
        readOnlyEnforced,
      });
    });
  } catch (e) {
    if (e instanceof ReplayComplete) return e.replay;
    throw e;
  }
}

/** What a `--verify` run found, split by what each finding MEANS. */
export type ReplayVerdict = {
  /** Cases whose chain moved for an employment that is STILL an active routing subject. THIS IS THE
   *  FAILURE — it is the promise ("the same approver, for the same real employee") not being kept. */
  changed: RoutingDifference[];
  /** Cases from the baseline whose employment is no longer an active routing subject — terminated, or with
   *  no open assignment. NOT a failure: migration order §2.5 excludes terminated employments because a
   *  terminated employee submits no leave. Reported by name anyway, so a suspicious number of them is
   *  visible instead of silently swallowed. */
  gone: RoutingDifference[];
  /** Cases that exist now and did not at baseline (a new employment, or a new leave type). Not a
   *  difference — there is no "before" chain for them to have moved from. */
  added: number;
};

/** The baseline stores only what a difference needs to NAME a company for an employment that has since
 *  left. Attributes are deliberately not stored: a verify must resolve against today's org data. */
export type BaselineSubject = { employmentId: string; companyId: string };

/**
 * Compare a replay against a committed baseline and say which findings are FAILURES.
 *
 * a6fe37fc Round 1. This judgement — "a moved chain for a live employee fails the cutover; a chain that
 * belonged to someone who has since left does not" — is the acceptance test's whole opinion, so it lives
 * here where the gate runs it, not inside a CLI that only ever runs by hand on the server. A branch that
 * decides whether a release may proceed and is exercised nowhere is exactly the kind of thing that is
 * discovered to be wrong during the release it was written for.
 */
export function verifyApprovalRouting(
  before: Map<string, string>,
  replay: RoutingReplay,
  baselineSubjects: BaselineSubject[],
): ReplayVerdict {
  const live = new Set(replay.subjects.map((s) => s.employmentId));
  // Employments that have since left are carried as stubs purely so a `gone` line can name its company
  // rather than an empty string. They resolve nothing — they are not subjects any more.
  const stubs: RoutingSubject[] = baselineSubjects
    .filter((s) => !live.has(s.employmentId))
    .map((s) => ({ companyId: s.companyId, employmentId: s.employmentId, employmentCount: 0, attrs: {} }));
  const differences = diffApprovalRouting(before, replay.chains, [...replay.subjects, ...stubs]);
  let added = 0;
  for (const key of replay.chains.keys()) if (!before.has(key)) added += 1;
  return {
    changed: differences.filter((d) => live.has(d.employmentId)),
    gone: differences.filter((d) => !live.has(d.employmentId)),
    added,
  };
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

      const before = await approvalRoutingSnapshot(tx, subjects, leaveTypeIds, dayProbes);
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
        if (leaveTypeIds.length === 0) {
          // A tenant with no leave types has nothing to expand INTO, and archiving the source anyway
          // would drop the chain with the proof seeing nothing (it iterates leave types, of which there
          // are none). Refuse rather than silently un-configure the company.
          actions.push({
            kind: 'skipped',
            ruleId: rule.id,
            companyId: rule.companyId,
            leaveTypeId: null,
            reason: 'the tenant has no leave types to expand this rule into',
          });
          continue;
        }
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
      const after = await approvalRoutingSnapshot(tx, subjects, leaveTypeIds, dayProbes);
      const differences = diffApprovalRouting(before, after, subjects);
      if (differences.length) throw new ApprovalRoutingChangedError(differences);

      const expandedCompanies = [
        ...new Set(actions.filter((a) => a.kind === 'expanded').map((a) => a.companyId)),
      ];
      const report: ConversionReport = {
        applied: apply,
        legacy,
        actions,
        routingChecks: before.size,
        employmentsCovered,
        caveats: expandedCompanies.map((companyId) => ({
          companyId,
          note:
            'its any-leave-type rule is now explicit per-type assignments — a leave type added later ' +
            'will need its own assignment instead of inheriting this chain',
        })),
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
