/**
 * 4da751c6 — "Benefit Scheme" and "Effective From" on the employee's Leave tab, DERIVED AND NEVER STORED.
 *
 * ## Why there is no table here, and why that is the whole design
 *
 * The reporter asked for a Benefit Scheme field: a named rule set ("Grade 12-15 (Permanent)") that decides
 * an employee's leave entitlements, changeable by HR, with history preserved. That layer USED TO EXIST and
 * was deleted on purpose — `benefit_scheme`, `scheme_leave_entitlement`, `leave_policy` and
 * `employment.benefit_scheme_id` all went in 6e9a126e release three, replaced by `entitlement_template` +
 * `entitlement_eligibility_rule`. Re-adding a stored scheme name would recreate the exact failure that
 * removal was for: a name saved on the employee can silently disagree with the rules that actually compute
 * the days, so the profile says one thing and the balance says another with nothing to reconcile them.
 *
 * So this module STORES NOTHING and DECIDES NOTHING. It asks the entitlement engine what it already
 * decided and names the answer. No migration, no column, no write.
 *
 * ## It must not become a second matcher
 *
 * `core/entitlement-template.ts`'s header is explicit that a private "who does this apply to" matcher is
 * "the defect wearing the fix's clothes", and `explainEntitlementEligibilityFor` was written to that rule.
 * This module follows it:
 *   • WHO WINS per leave type comes from `buildTemplateEntitlementResolver` — the ONE batched matcher the
 *     engines use — asked once for every leave type at a time.
 *   • WHICH BAND APPLIES comes from `bandFor`, the engine's own band selection, not a re-implementation of
 *     "contiguous from 0, open-ended last".
 *   • HOW LONG THEY HAVE SERVED comes from `serviceYearsAt`, the same helper the accrual engine reads.
 * If this file ever computes an eligibility decision itself, it has become the thing it exists to avoid.
 *
 * ## The scheme name is derived, so it can legitimately fail to exist
 *
 * A "scheme" in the reporter's sense is one named rule set covering the employee's whole leave package.
 * The system does not model that: eligibility is per leave type, so an employee CAN be picked up by
 * different rules for different types. Grade groups make this sharper rather than softer — the eligibility
 * picker EXPANDS a group into its member `gradeIds` and stores those, so there is no stored link from a
 * rule back to a group and the reverse lookup is genuinely ambiguous.
 *
 * Therefore `schemeName` is null whenever the winning rules disagree, and `ambiguous` says which kind of
 * null it is. The approved plan promised the reporter this explicitly: "the line says so plainly and lists
 * what applies per leave type, rather than inventing a name". A tidy label that is not true would be worse
 * than the gap it fills.
 *
 * `viaSoleTemplate` is the OTHER honest null (r193 fault 3): the leave type had exactly one table in force
 * and no rule was consulted, so there is no rule NAME to report. That is not ambiguity and must not read
 * as a conflict.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { employment, jobGrade, leaveType } from '../db/schema';
// ADR-0080 D9: core/leave-compute and core/entitlement-template are leave-pack BOUNDARY modules, and
// this file is an outside consumer (its caller is the personnel screen, not a leave screen). So it takes
// them through the facade, which re-exports both in place. Adding this file to the pack instead would
// have pushed the violation onto app/admin/personnel and GROWN the audited debt allowlist, which
// test/leave-pack-drift.test.ts documents as only ever shrinking.
import { bandFor, type ServiceBand, buildTemplateEntitlementResolver, leaveTypeIdsWithTemplatesAt } from '../packs/leave/service';
import { movementHistory } from './movement';
import { serviceYearsAt } from '../lib/completed-years';

/**
 * The movement kinds that can move an employee BETWEEN schemes, chosen to match the eligibility axes a
 * scheme is actually derived from rather than by listing everything that looks like a change:
 *   grade      → `gradeIds`            (promotion / demotion / orgAssignmentChange / gradeChange)
 *   confirmed  → `confirmationStatuses` (confirmation)
 *   type       → `employmentTypes`      (employmentTypeChange)
 *   company    → `companyIds`           (transfer / entityTransfer)
 * A salary increment does NOT appear here: it changes pay, not who the rules pick up, so dating the scheme
 * from it would be wrong in the ordinary case of a raise inside the same grade.
 */
const SCHEME_AFFECTING_KINDS = new Set([
  'promotion',
  'demotion',
  'orgAssignmentChange',
  'gradeChange',
  'confirmation',
  'employmentTypeChange',
  'transfer',
  'entityTransfer',
]);

export type SchemeLeaveTypeRow = {
  leaveTypeId: string;
  leaveTypeName: string;
  /** The eligibility rule that won. NULL when the type had one table and no rule was consulted. */
  ruleName: string | null;
  templateName: string;
  viaSoleTemplate: boolean;
  /** 76ffdcf2 — no benefit scheme reached this employee for this type, so the leave type's DEFAULT
   *  entitlement table answered. The screen names the TABLE and says it is the default; it must never
   *  print a scheme name here, because no scheme was consulted. */
  viaDefaultTemplate: boolean;
  bands: ServiceBand[];
  /** Days this employee gets at their current service length — `bandFor`, not a local re-derivation.
   *  NULL when the bands do not resolve, which is shown as an em dash rather than as 0. */
  daysAtService: number | null;
};

export type BenefitSchemeView = {
  /** The one rule name covering every resolved leave type, or NULL — see `ambiguous`. */
  schemeName: string | null;
  /** TRUE only when the winning rules DISAGREE across leave types. False when there simply is no rule
   *  (every type resolved via its sole table), which is a different and non-alarming state. */
  ambiguous: boolean;
  /**
   * 76ffdcf2 — NOT COVERED BY A SCHEME, AND THAT IS NOT THE SAME AS HAVING NOTHING.
   *
   * True when no rule decided ANY of this employee's leave types and at least one of them resolved
   * through the leave type's DEFAULT entitlement table. The card then says which table each type falls
   * back to and how many days that gives them, instead of the sentence r266 shipped, which told 34
   * production employees they had no entitlement while they were holding days.
   *
   * False when a rule decided anything (there is a scheme to name), and false when nothing resolved at
   * all (`perType` is empty and the card takes its empty state).
   */
  coveredByDefaultOnly: boolean;
  /**
   * 9e2a89e9 — THE LEAVE TYPES THAT HAVE ENTITLEMENT TABLES AND STILL REACH THIS EMPLOYEE WITH NONE.
   *
   * "If no entitlement table matches the new grade, do not assign an incorrect entitlement" is already the
   * rule — `noEntitlementOpinion` skips the type rather than clawing it to 0 — but the skip was SILENT.
   * The reporter asked to be told. These are the types where the skip happened: tables exist, no scheme
   * names this employee, and no default table was set for the type either.
   *
   * Types with NO table at all are deliberately absent: nobody was ever meant to get days there, so
   * flagging them would bury the ones that are genuinely half-configured.
   */
  unmatched: { leaveTypeId: string; leaveTypeName: string }[];
  /**
   * 9e2a89e9 — this employment has NO JOB GRADE RECORDED. On production that is 47 of 74 active
   * employments, and it is the reason a grade-matched scheme reaches six people: no engine change can fix
   * it, so the screen says it rather than leaving the empty rows to be puzzled over.
   */
  noJobGrade: boolean;
  /** Effective date of the most recent applied movement that could have changed the scheme. NULL when the
   *  record shows no such movement — rendered as an em dash. A wrong date here would be worse than none. */
  effectiveFrom: string | null;
  effectiveFromKind: string | null;
  serviceYears: number | null;
  perType: SchemeLeaveTypeRow[];
};

export async function benefitSchemeView(
  ctx: SessionContext,
  employmentId: string,
  asOf: string,
): Promise<BenefitSchemeView> {
  // Read-only — no events (CLAUDE.md skip rule).
  const perTypeAndService = await withTenant(ctx, async (tx: Tx) => {
    const [emp] = await tx
      .select({ hiredOn: employment.hiredOn, gradeId: employment.gradeId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    // RLS hides an employment a peer may not read; an empty view is the defined answer, never an error.
    if (!emp) return null;
    const noJobGrade = emp.gradeId == null;

    const typeIds = await leaveTypeIdsWithTemplatesAt(tx, asOf);
    if (typeIds.size === 0) return { rows: [], serviceYears: null, unmatched: [], noJobGrade };

    const names = await tx
      .select({ id: leaveType.id, name: leaveType.name })
      .from(leaveType)
      .where(and(eq(leaveType.tenantId, ctx.tenantId)));
    const nameById = new Map(names.map((n) => [n.id, n.name]));

    const ids = [...typeIds];
    // ONE resolver for every leave type — the batched matcher the engines use, asked once.
    const resolver = await buildTemplateEntitlementResolver(tx, {
      employmentIds: [employmentId],
      leaveTypeIds: ids,
      asOf,
    });

    const serviceYears = emp.hiredOn ? serviceYearsAt(emp.hiredOn, asOf) : null;

    const rows: SchemeLeaveTypeRow[] = [];
    // 9e2a89e9 — the OTHER half of the same loop. Every type in `ids` has a table in force for somebody;
    // the ones `winnerFor` answers null for are exactly the silent skips the reporter asked to be told
    // about, and they are collected here rather than re-derived by a second pass over the same resolver.
    const unmatched: { leaveTypeId: string; leaveTypeName: string }[] = [];
    for (const leaveTypeId of ids) {
      const won = resolver.winnerFor(employmentId, leaveTypeId);
      if (!won) {
        unmatched.push({ leaveTypeId, leaveTypeName: nameById.get(leaveTypeId) ?? '' });
        continue; // no table reaches this employee for this type — not part of their scheme
      }
      const bands = won.serviceBands ?? [];
      rows.push({
        leaveTypeId,
        leaveTypeName: nameById.get(leaveTypeId) ?? '',
        ruleName: won.ruleName,
        templateName: won.templateName,
        viaSoleTemplate: won.viaSoleTemplate,
        viaDefaultTemplate: won.viaDefaultTemplate,
        bands,
        daysAtService:
          serviceYears == null ? null : (bandFor({ serviceBands: bands }, serviceYears)?.days ?? null),
      });
    }
    rows.sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
    unmatched.sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
    return { rows, serviceYears, unmatched, noJobGrade };
  });

  if (!perTypeAndService) {
    return {
      schemeName: null,
      ambiguous: false,
      coveredByDefaultOnly: false,
      unmatched: [],
      noJobGrade: false,
      effectiveFrom: null,
      effectiveFromKind: null,
      serviceYears: null,
      perType: [],
    };
  }
  const { rows, serviceYears, unmatched, noJobGrade } = perTypeAndService;

  // THE NAME. Only rule-decided rows can carry one; a sole-table row was decided without consulting any
  // rule, so counting it as a disagreement would report a conflict that does not exist. 76ffdcf2 — a
  // DEFAULT-table row is the same kind of null for the same reason: no scheme was consulted, so it is
  // neither a name nor a disagreement.
  const ruleNames = new Set(
    rows.filter((r) => !r.viaSoleTemplate && !r.viaDefaultTemplate && r.ruleName).map((r) => r.ruleName!),
  );
  const ambiguous = ruleNames.size > 1;
  const schemeName = ruleNames.size === 1 ? [...ruleNames][0] : null;
  // 76ffdcf2 — "no scheme names this employee, and here is what they get instead". Requires BOTH halves:
  // nothing rule-decided anywhere, and at least one type actually answered by a default.
  const coveredByDefaultOnly = ruleNames.size === 0 && rows.some((r) => r.viaDefaultTemplate);

  const effective = await schemeEffectiveFrom(ctx, employmentId, asOf);

  return {
    schemeName,
    ambiguous,
    coveredByDefaultOnly,
    unmatched,
    noJobGrade,
    effectiveFrom: effective?.effectiveDate ?? null,
    effectiveFromKind: effective?.kind ?? null,
    serviceYears,
    perType: rows,
  };
}


/**
 * r270 (65e4073a build 2) — THE FOUR FACTS THE EXPLAIN SENTENCE QUOTES, AND NOTHING ELSE.
 *
 * The explain panel could say which table and which scheme won and no more: "Resolves to GP1215, through
 * the scheme GP1215." The reporter asked for the sentence that names the employee's grade, their length of
 * service, the band that applied and the days it gives. Every one of those is already computed — this
 * reader only fetches the two stored columns (`employment.grade_id` → its name, `employment.hired_on`) and
 * puts the rest through the engine's own helpers.
 *
 * ⚠️ IT DECIDES NOTHING, for the reason this module's header gives. `serviceYearsAt` is the counter the
 * accrual engine reads and `bandFor` is the engine's own band selection; the BANDS are handed in by the
 * caller straight off `ResolvedEntitlement.serviceBands`, so the band named on screen is selected from the
 * very array the winner resolved. Re-resolving the winner here would be a second matcher.
 *
 * ⚠️ AND EVERY FIELD IS NULLABLE ON PURPOSE. 47 of the reporter's 74 live employments have no job grade
 * recorded, so `gradeName` is null for most of them and the sentence must simply not mention a grade —
 * "is Grade null" is the failure mode this nullability exists to make impossible. An employment with no
 * hire date has no service length, and a band array that does not resolve has no days: each absence drops
 * its own clause and no other.
 *
 * ONE QUERY, read-only, no event. RLS hides an employment the caller may not read; the defined answer for
 * that is four nulls, never an error.
 */
export type EntitlementExplainFacts = {
  /** The employee's job grade by NAME, never its id. Null when no grade is recorded on the employment. */
  gradeName: string | null;
  /** Completed whole years of service at `asOf`, through `serviceYearsAt`. Null with no hire date. */
  serviceYears: number | null;
  /** The band of the WINNING table that applies at that service length — the engine's own `bandFor`. Null
   *  when there is no winner, no service length to look up, or the band array does not resolve. */
  band: ServiceBand | null;
  /** That band's days. Null rather than 0: "no band resolved" and "this band gives nothing" are different
   *  statements and only one of them is a figure. */
  daysAtService: number | null;
};

export async function entitlementExplainFactsFor(
  ctx: SessionContext,
  p: { employmentId: string; asOf: string; serviceBands: ServiceBand[] | null },
): Promise<EntitlementExplainFacts> {
  // Read-only — no events (CLAUDE.md skip rule).
  return withTenant(ctx, async (tx: Tx) => {
    const [row] = await tx
      .select({ hiredOn: employment.hiredOn, gradeName: jobGrade.name })
      .from(employment)
      .leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const serviceYears = row?.hiredOn ? serviceYearsAt(row.hiredOn, p.asOf) : null;
    const band =
      p.serviceBands && serviceYears != null ? bandFor({ serviceBands: p.serviceBands }, serviceYears) : null;
    return {
      gradeName: row?.gradeName ?? null,
      serviceYears,
      band,
      daysAtService: band?.days ?? null,
    };
  });
}

/**
 * The most recent APPLIED movement, on or before `asOf`, that could have moved this employee between
 * schemes. Reuses `movementHistory` rather than querying `domain_event` again — a second reader of that
 * history is a second thing to keep in step with corrections and reversals.
 *
 * Pending and reversed rows are excluded deliberately: a future-dated promotion has not moved anyone yet,
 * and a reversed one never did.
 */
async function schemeEffectiveFrom(
  ctx: SessionContext,
  employmentId: string,
  asOf: string,
): Promise<{ effectiveDate: string; kind: string } | null> {
  const history = await movementHistory(ctx, employmentId);
  const candidates = history
    .filter((r) => r.status === 'applied' && !r.reversed)
    .filter((r) => SCHEME_AFFECTING_KINDS.has(r.kind))
    .filter((r) => r.effectiveDate <= asOf);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return { effectiveDate: candidates[0].effectiveDate, kind: candidates[0].kind };
}
