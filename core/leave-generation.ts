/**
 * 93249794 — GENERATE ENTITLEMENT. The module that AIMS the existing engine; it computes nothing itself.
 *
 * ── WHAT THIS FILE IS, IN ONE SENTENCE ────────────────────────────────────────────────────────────────
 * It joins the ONE "who does this apply to" resolver (`core/org-criteria.ts`) to the ONE granting engine
 * (`openLeaveYear`, core/leave.ts), and writes down what happened. There is no entitlement arithmetic
 * anywhere below this line, and there must never be any.
 *
 * ── THE INVARIANT THAT GOVERNS EVERYTHING HERE ────────────────────────────────────────────────────────
 * ONE COMPOSITION. The item's build notes: "openLeaveYear, the hire grant, accrueEarnedLeave and the
 * recalc kernel must stay byte-identical in how they compose entitlement. A new generation path MUST call
 * the existing engine, not re-derive days. A second definition of entitlement is the single worst outcome
 * available here."
 *
 * So: `previewLeaveGeneration` and `runLeaveGeneration` call THE SAME FUNCTION with the same arguments and
 * differ in exactly one boolean — `dryRun`. Not "the same rules", not "the same formula": the same call.
 * The validation step cannot drift from the run because there is nothing for it to drift from. That is
 * also why there is no `validateLeaveGeneration` in this codebase: a second function answering "would this
 * employee get days?" would be the second definition the notes name as the worst outcome, and it would
 * pass every test on the day it was written and be wrong six months later.
 *
 *     previewLeaveGeneration  →  openLeaveYear({ …, dryRun: true  })   nothing is written
 *     runLeaveGeneration      →  openLeaveYear({ …, dryRun: false })   the ledger rows are written
 *
 * The verdicts the screen shows (`LeaveYearGrantOutcome`) are read off that one pass. Every value of it is
 * a LABEL on a branch openLeaveYear already had — see its declaration in core/leave.ts for the mapping
 * from the reporter's requested validation list, including the three items on that list that are NOT
 * reachable failures and are named as such rather than faked.
 *
 * ── AND THE SECOND ONE: NO SECOND CRITERIA ENGINE ─────────────────────────────────────────────────────
 * "Who does this apply to" is answered by `resolveOrgCriteriaTargets` — the same predicate, the same SQL
 * and the same as-at-a-date semantics that bulk Leave Adjustments (491c499f), the Notice Board (6e122302)
 * and the entitlement eligibility layer (6e9a126e) use. Nothing here re-implements, wraps or "extends" it.
 * The picker in front of it is `buildOrgCriteriaSections` (core/org-criteria-form.ts), also shared, because
 * a forked PICKER fails silently in a way a forked resolver does not: a control whose name is not a
 * criteria field renders, posts, and narrows nobody.
 *
 * If an axis is missing, it is added THERE, once, for all four consumers. That is exactly what 18103ba4
 * did, and the reason this item did not have to add anything at all.
 *
 * ── WHY THREE TRANSACTIONS AND NOT ONE ────────────────────────────────────────────────────────────────
 * `openLeaveYear` opens its own `withTenant`, and this repo's convention (core/benefit-scheme.ts's
 * reproject call, documented in place) is to SEQUENCE such services rather than nest them — a nested
 * `db.transaction()` takes a second pooled connection and cannot see the outer transaction's uncommitted
 * writes. So a run is: resolve the target set · run the engine · write the log.
 *
 * r301 (e5018593) MADE IT FOUR: resolve · year-open · EARNED ACCRUAL · log. The accrual is a second engine
 * (`accrueEarnedLeave`) aimed at the earned Annual Leave pairs the year-open skipped, in its own transaction
 * after the year-open has committed, and a failure there is returned on the result rather than thrown — the
 * same "the ledger is the truth" ordering stated below, one step further along. See the block in `generate`.
 *
 * ⚠️ THE ORDERING IS DELIBERATE AND ITS FAILURE MODE IS STATED. The grant commits BEFORE the log is
 * written, so a crash between them leaves entitlement granted and unlogged. That is the right way round:
 * the LEDGER is the truth about what an employee has, the log is a record about what an operator did, and
 * a bookkeeping failure must never roll back days people have been told they have. The inverse ordering
 * would make the log a gate on the grant — which is precisely the confusion 4b0e76ae had to clear up about
 * `leave_year_config`.
 *
 * ── WHAT IS DELIBERATELY NOT IN THIS RELEASE ──────────────────────────────────────────────────────────
 * RECALCULATE PREVIOUS YEAR. The approved plan calls it "the most sensitive thing in this request" and
 * puts it in release two, behind an explicit per-employee delta preview, its own separate confirmation,
 * compensating ADJUSTMENT rows (never an UPDATE of a ledger row) and a `sys:` reason prefix. Nothing in
 * this file rewrites a closed year, and `runLeaveGeneration` has no parameter that could be made to.
 *
 * GENERATE LEAVE UNTIL <MONTH>. Also release two, and for a sharper reason than sequencing: it CHANGES
 * WHAT THE CALCULATION DOES. `openLeaveYear` posts a whole year's entitlement at 1 January; capping it at
 * a month is a new proration rule that the hire grant, `accrueEarnedLeave` and `projectExpectedEntitlement`
 * would all have to learn in the same breath, or the next profile save would re-project against the full
 * year and post a compensating adjustment clawing the difference back. That is the one-composition
 * invariant, and it is why this release adds a scope and a preview but not a single new formula.
 *
 * PRORATE FOR NEW EMPLOYEES is not a toggle here because it is not a decision this sweep makes.
 * r193 CORRECTED THE REASON WITHOUT CHANGING THE ANSWER: `openLeaveYear` used to skip everyone hired
 * during the year outright (`hiredOn < yearStart`), which is the fault that round fixed. It now reaches
 * them and grants from their JOIN DATE, shaped by the same `hireYearGrantDays` the hire grant uses — so
 * proration is still automatic, still one definition, and still not something a checkbox here decides.
 *
 * A PROGRESS BAR. Production carries 26 employments (measured 2026-08-05). A run is one transaction and
 * finishes before the response does, so a progress bar would be an animation of an already-completed
 * operation — and the honest version of it requires background-job infrastructure this repo does not have
 * and should not grow for 26 rows. The completion summary and the downloadable log ship instead, which is
 * what the plan's build notes ask for in as many words.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';

import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  employment,
  leaveGenerationRun,
  leaveGenerationRunItem,
  leaveType,
  person,
} from '../db/schema';
import {
  countTemplatesForLeaveType,
  resolveEntitlementForEmployment,
} from './entitlement-template';
import {
  accrueEarnedLeave,
  asOfForLeaveYear,
  openLeaveYear,
  type EarnedAccrualResult,
  type LeaveYearGrantOutcome,
  type LeaveYearGrantRow,
} from './leave';
import { resolveOrgCriteriaTargets, type OrgCriteria } from './org-criteria';
import { todayInKualaLumpur } from '../lib/hr-date';

/** What the screen posts. `criteria` and `employmentIds` are alternatives, chosen by `targetMode`. */
export type LeaveGenerationRequest = {
  year: number;
  /** Empty ⇒ every leave type this sweep grants (the unscoped behaviour that has always existed). */
  leaveTypeIds?: string[];
  targetMode: 'criteria' | 'individual';
  /** `{}` is legal and means EVERYONE — core/org-criteria.ts's own semantics. The screen must show the count. */
  criteria?: OrgCriteria;
  employmentIds?: string[];
};

/** One line of the preview / the stored log, with the names a human needs to act on it. */
export type LeaveGenerationLine = {
  employmentId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  outcome: LeaveYearGrantOutcome;
  days: number;
  carry: number;
  forfeit: number;
  belowStatutoryFloor: boolean;
  /** r299 (3de1453a) — the engine's own `LeaveYearGrantRow.earnedMethodNotAnnualLeave`, passed through: an
   *  `earned_method` line on a type that is not Annual Leave. The screen labels it; it is NOT stored (the
   *  run item keeps the engine's `outcome` verbatim, and has no column for this). */
  earnedMethodNotAnnualLeave: boolean;
  /**
   * r301 (e5018593) — did the earned accrual this generation triggered REACH this line, and with what?
   *   'topped_up'   the accrual posted (or, on a preview, would post) days for this pair.
   *   'up_to_date'  the accrual reached the pair and nothing was outstanding.
   *   null          not reached: not an earned Annual Leave line, a future year, a failed accrual, or an
   *                 employee the accrual resolved no earned entitlement for at its as-at date.
   * A reached line COUNTS AS PASSED and leaves the issues table. ⚠️ Like `earnedMethodNotAnnualLeave`, a
   * DISPLAY flag and NOT stored: the run item keeps the engine's `earned_method` verbatim (test E pins the
   * outcome set; the processing log and its CSV read the same before and after this change).
   */
  earnedAccrual: 'topped_up' | 'up_to_date' | null;
};

/**
 * r301 (e5018593) — THE EARNED ANNUAL LEAVE HALF OF A GENERATION, present whenever the engine logged at least
 * one `earned_method` line (null when it logged none, which is every tenant with no earned type selected).
 *
 * Three figures, each read off the accrual engine's own counters and never re-derived:
 *   posted    = `granted` — pairs topped up. Pairs ARE employees here: r299 allows ONE active Annual Leave.
 *   upToDate  = Σ breakdown.employeeCount − posted — pairs reached with nothing outstanding.
 *   days      = Σ breakdown.entitlementGenerated.
 */
export type LeaveGenerationAccrual = {
  /** `earned_method` lines on Annual Leave — the pairs handed to (or, for a future year, held back from) accrual. */
  annualLeaveLines: number;
  /** r299 stranded lines: an earned method on a type that is NOT Annual Leave. Never accrued, only counted. */
  notAnnualLeaveLines: number;
  /** The year has not started. Nothing is accrued in advance: earned days are earned as the year goes by. */
  skippedFutureYear: boolean;
  /** The as-at date the accrual ran at (the generation's late edge); null when it did not run. */
  asOf: string | null;
  posted: number;
  upToDate: number;
  days: number;
  /** One row per Annual Leave type the accrual reached — the preview's "Earned Annual Leave to add" table. */
  byLeaveType: { leaveTypeId: string; leaveTypeName: string; posted: number; upToDate: number; days: number }[];
  /** The accrual threw. The generation before it is ALREADY COMMITTED and stays so; this is the reason. */
  error: string | null;
};

export type LeaveGenerationResult = {
  year: number;
  /** Employments the SELECTION resolved to, before the sweep's own year-boundary eligibility. */
  employeesSelected: number;
  /** Employments the sweep actually reached — selected AND active across the year boundary. */
  employeesReached: number;
  /** Employments with at least one granted line, and employments the run granted nothing for. */
  employeesPassed: number;
  employeesFailed: number;
  granted: number;
  skipped: number;
  forfeits: number;
  lines: LeaveGenerationLine[];
  /**
   * 6e9a126e — WHICH ELIGIBILITY RULE DECIDED THIS EMPLOYEE, per employment, for the FIRST selected leave
   * type. Empty whenever no entitlement template exists for that type, which is every tenant today: the
   * template layer shipped in 6e9a126e release one and NO granting engine reads it until release two.
   *
   * It is surfaced anyway, and labelled on screen as what it is, because the plan promises "the screen
   * tells you which rule won so it is never a guess" — and the moment release two re-points the engines,
   * this column becomes the explanation of the days beside it with no further change here.
   */
  decidedBy: { employmentId: string; ruleName: string | null; templateName: string; alsoMatched: number }[];
  /** r301 (e5018593) — the earned Annual Leave this generation added, or would add. See the type. */
  accrual: LeaveGenerationAccrual | null;
  /** Set only by `runLeaveGeneration` — the processing-log row this run wrote. */
  runId?: string;
};

/**
 * ④ VALIDATION & PREVIEW — a DRY RUN of the real thing, not a checklist beside it.
 *
 * Writes nothing: no ledger row, no domain event, no processing-log row. The counters and lines it returns
 * are what `runLeaveGeneration` will produce from the same inputs, because they come from the same call.
 */
export async function previewLeaveGeneration(
  ctx: SessionContext,
  p: LeaveGenerationRequest,
): Promise<LeaveGenerationResult> {
  return generate(ctx, p, true);
}

/**
 * ⑤ PROCESS — the real run, then the log.
 *
 * `openLeaveYear` is idempotent on its own `openedSet`, which is read from the LEDGER and never from a
 * configuration table. r193 re-keyed it from "an accrual row dated 1 January" to "an accrual row anywhere
 * in the leave year", because the grant is no longer always dated 1 January — see `yearOpenMarkerCond` in
 * core/leave.ts, which is the single most dangerous line in that change. Pressing Process twice still
 * reports the second pass as `already_open` and posts nothing, which is the guarantee this screen sells.
 */
export async function runLeaveGeneration(
  ctx: SessionContext,
  p: LeaveGenerationRequest,
): Promise<LeaveGenerationResult> {
  return generate(ctx, p, false);
}

async function generate(
  ctx: SessionContext,
  p: LeaveGenerationRequest,
  dryRun: boolean,
): Promise<LeaveGenerationResult> {
  const year = Number(p.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    // The same window openLeaveYearAction has always enforced, said once here so both the preview and the
    // run refuse it identically rather than the preview quietly returning an empty, encouraging result.
    throw new Error('Choose an entitlement year between 2020 and 2100.');
  }
  const leaveTypeIds = dedupe(p.leaveTypeIds);
  const targetMode = p.targetMode === 'individual' ? 'individual' : 'criteria';
  const criteria = targetMode === 'criteria' ? (p.criteria ?? {}) : {};
  const givenIds = targetMode === 'individual' ? dedupe(p.employmentIds) : [];

  // ── ③ EMPLOYEE SELECTION ────────────────────────────────────────────────────────────────────────────
  // AS AT 1 JANUARY of the entitlement year, which is the date the sweep itself grants on. Resolving the
  // criteria "as of today" while the engine grants as of the year start would select the people who are in
  // Finance NOW for a year they spent somewhere else — and a target set nobody can reproduce is exactly
  // what core/org-criteria.ts's header warns about.
  const asOf = `${year}-01-01`;
  // ⚠️ r193 — A FOURTH GATE, AND IT IS IN THIS FILE, NOT THE ENGINE.
  //
  // `resolveOrgCriteriaTargets` excludes any employment with `hired_on > asOf`. Selecting at 1 January
  // therefore drops every mid-year joiner BEFORE `openLeaveYear` is even called — 18 of the reporting
  // account's 40 active employments. Fixing the engine's own `hiredOn` filter without fixing this one
  // would have left the Generate Entitlement screen, which is the reporter's only way in, behaving exactly
  // as it does today. The round's plan named three faults; this was not one of them.
  //
  // ONE asOf CANNOT EXPRESS THE ANSWER, because the sweep now grants each employment from the LATER of
  // 1 January and their join date — a different date per person. So the selection is the UNION of two
  // dated resolutions of the SAME criteria through the SAME resolver, which is still no second criteria
  // engine:
  //   • 1 JANUARY — everyone employed at the year boundary, INCLUDING people who left during the year.
  //     This is the pass that already existed and it is kept whole, so nobody who is selected today stops
  //     being selected.
  //   • THE YEAR'S LATE EDGE — `asOfForLeaveYear` (core/leave.ts), the one existing definition of "an
  //     asOf inside this leave year": today for the current year, 31 December for a past or future one.
  //     This is the pass that sees the joiners, and it reads their department / position as at then.
  //
  // The union only ever ADDS people, and every one it adds is re-tested by `openLeaveYear`'s own
  // year-boundary conditions, so this widens WHO IS CONSIDERED and never what is granted. It is honest
  // about one gap rather than hiding it: someone who joined AND left inside the year, both before the late
  // edge, is in neither pass. Their entitlement was granted at hire and is theirs already.
  //
  // r301: `today` is read ONCE and shared with the earned-accrual step below, so the late edge the
  // selection used and the as-at date the accrual runs at cannot straddle a midnight.
  const today = todayInKualaLumpur();
  const asOfLate = asOfForLeaveYear(year, today);
  const targets = await withTenant(ctx, async (tx) => {
    const at = (on: string) =>
      targetMode === 'individual'
        ? // Even a typed list goes through the SHARED resolver, with an empty criteria object, so the
          // individual path inherits the identical active-on-`asOf` rule (hired by then, not already gone)
          // instead of a second hand-written one. `employmentIds` is a RESTRICTION on that predicate.
          resolveOrgCriteriaTargets(tx, { criteria: {}, asOf: on, employmentIds: givenIds })
        : resolveOrgCriteriaTargets(tx, { criteria, asOf: on });
    const early = await at(asOf);
    if (asOfLate === asOf) return early;
    const late = await at(asOfLate);
    return [...new Set([...early, ...late])];
  });

  // ⚠️⚠️ AN EMPTY TARGET SET MUST NOT MEAN "EVERYONE" — AND THE GUARD MUST SIT *BEFORE* THE ENGINE CALL.
  //
  // `openLeaveYear` reads an empty `employmentIds` as NO RESTRICTION. That is correct for the unscoped
  // year-open and catastrophic here, where an empty set means the operator's criteria matched NOBODY.
  //
  // THE FIRST CUT OF THIS FUNCTION GOT IT WRONG IN THE WORST POSSIBLE WAY, and the test caught it: it
  // called the engine anyway and then zeroed the RETURNED counters, so `granted: 0` and `lines: []` were
  // reported to the screen while the sweep had already written an accrual row for every employment in
  // the tenant. A preview that under-reports what it just did is worse than no preview, and the
  // corresponding real run would have silently granted the whole company off a criteria set that matched
  // nobody. `test/leave-generation.test.ts` asserts on the LEDGER, not on the return value, which is the
  // only reason this was visible at all.
  //
  // So: return before the engine is ever asked. Nothing to compute, nothing to write, and — stated as a
  // decision rather than left as an oversight — NO processing-log row either. A run that reached nobody
  // changed nothing, so there is nothing for a log to explain; and the screen never offers Process in
  // that state anyway (`canProcess` gates on `employeesReached`), so this path is a mis-aimed form rather
  // than an operation somebody performed.
  //
  // NOTE THE ASYMMETRY, WHICH IS DELIBERATE: an empty `leaveTypeIds` is the OPPOSITE — it legitimately
  // means "every type this sweep grants", because that is exactly what the plain Generate button this
  // screen replaces has always done. Empty PEOPLE is a mistake; empty TYPES is a choice.
  if (targets.length === 0) {
    return {
      year,
      employeesSelected: 0,
      employeesReached: 0,
      employeesPassed: 0,
      employeesFailed: 0,
      granted: 0,
      skipped: 0,
      forfeits: 0,
      lines: [],
      decidedBy: [],
      accrual: null,
    };
  }

  // ── ④/⑤ THE ENGINE. One call. `dryRun` is the ONLY difference between preview and commit. ───────────
  const res = await openLeaveYear(ctx, { year, leaveTypeIds, employmentIds: targets, dryRun });
  const engineRows = res.rows;
  const counts = { granted: res.granted, skipped: res.skipped, forfeits: res.forfeits };

  // ── r301 (e5018593) · EARNED ANNUAL LEAVE, IN THE SAME GENERATION ─────────────────────────────────────
  //
  // The year-open above logs an earned Annual Leave pair as `earned_method` and writes nothing for it, by
  // design (ADR-0040): those days are `accrueEarnedLeave`'s. Until this round nothing called that engine from
  // here, so every such pair read as Failed and the days appeared only when someone remembered Run Earned
  // Accrual or the monthly cron came round. Now the SAME generation hands exactly those pairs to it.
  //
  // • ANOTHER ENGINE, NOT A SECOND DEFINITION. This module still composes no day: it aims `accrueEarnedLeave`
  //   the way it aims `openLeaveYear`, and passes it the SAME `dryRun` variable, so the preview's earned
  //   figures are the commit's (2c7c6385, preview-must-not-lie) and there is still one path, not two.
  // • WHO: the employees and Annual Leave types of the `earned_method` lines whose r299 flag is false, and
  //   nobody else. The employee list is passed as `employmentIds`, where EMPTY MEANS NOBODY — and it is
  //   never empty here anyway, because the call is skipped when there is no such line.
  // • ⚠️ WHO IT DOES NOT REACH, STATED SO NOBODY READS IT AS COVERED: a pair that already has ANY accrual row
  //   inside this leave year (a prior Run Earned Accrual, the monthly cron, a hire grant) is `already_open` to
  //   the year-open, not `earned_method`, so it is not handed over here and whatever it has earned since is
  //   left to the cron and the manual screen. It counts as passed, exactly as before this round.
  // • WHEN: at `asOfLate`, the late edge the selection already used — today for the current year, 31
  //   December for a past one (`asOfForLeaveYear`).
  // • ⚠️ NEVER A FUTURE YEAR. `asOfForLeaveYear` maps a future year to its 31 December, which was a decision
  //   for the MANUAL button. Here it would post a whole unearned year: the balance readers carry no date
  //   bound, so days dated next 31 December are spendable today, and the once-per-cycle carry forfeit would
  //   lock on a mid-year balance. The result says the days are added as the year goes by instead.
  // • ⚠️ ITS OWN TRANSACTION, AFTER THE YEAR-OPEN HAS COMMITTED, AND A FAILURE IS RETURNED, NOT THROWN. The
  //   header's rule: the ledger is the truth, and a failure after a grant must never read as "nothing
  //   happened" — the entitlement above is written and stays written. The operator is told the earned part
  //   did not run and where to run it. On a preview the same failure is shown before anything is written.
  // • ⚠️ A FORMER NEIGHBOUR, BY ADDRESS ONLY. r281 split the two screens so "create a year" and "top up what
  //   was earned" are never confused; this does not reopen that: Run Earned Accrual keeps its own page, and
  //   nothing earned is ever created ahead of time.
  const earnedLines = engineRows.filter((r) => r.outcome === 'earned_method');
  const annualLeaveLines = earnedLines.filter((r) => !r.earnedMethodNotAnnualLeave);
  let accrual: LeaveGenerationAccrual | null = null;
  let accrued: EarnedAccrualResult['pairs'] = [];
  if (earnedLines.length > 0) {
    const skippedFutureYear = today < `${year}-01-01`;
    accrual = {
      annualLeaveLines: annualLeaveLines.length,
      notAnnualLeaveLines: earnedLines.length - annualLeaveLines.length,
      skippedFutureYear,
      asOf: null,
      posted: 0,
      upToDate: 0,
      days: 0,
      byLeaveType: [],
      error: null,
    };
    if (annualLeaveLines.length > 0 && !skippedFutureYear) {
      accrual.asOf = asOfLate;
      try {
        const acc = await accrueEarnedLeave(ctx, {
          asOf: asOfLate,
          leaveTypeIds: [...new Set(annualLeaveLines.map((r) => r.leaveTypeId))],
          employmentIds: [...new Set(annualLeaveLines.map((r) => r.employmentId))],
          dryRun,
        });
        accrued = acc.pairs;
        const reachedPairs = acc.breakdown.reduce((n, g) => n + g.employeeCount, 0);
        accrual.posted = acc.granted;
        accrual.upToDate = reachedPairs - acc.granted;
        accrual.days = round2(acc.breakdown.reduce((n, g) => n + g.entitlementGenerated, 0));
        accrual.byLeaveType = summariseByLeaveType(acc);
      } catch (e) {
        accrual.error = (e as Error).message || 'Earned accrual failed.';
      }
    }
  }
  // Which engine lines the accrual reached. Only an Annual Leave `earned_method` line can be — the accrual was
  // scoped to exactly those pairs — and the guard says so rather than trusting the scope to have held.
  const accruedBy = new Map(accrued.map((a) => [`${a.employmentId}|${a.leaveTypeId}`, a.days]));
  const earnedAccrualOf = (r: LeaveYearGrantRow): LeaveGenerationLine['earnedAccrual'] => {
    if (r.outcome !== 'earned_method' || r.earnedMethodNotAnnualLeave) return null;
    const days = accruedBy.get(`${r.employmentId}|${r.leaveTypeId}`);
    if (days === undefined) return null;
    return days > 0 ? 'topped_up' : 'up_to_date';
  };

  const lines = await withTenant(ctx, (tx) => nameLines(tx, engineRows, earnedAccrualOf));
  const reached = new Set(engineRows.map((r) => r.employmentId));
  // ⚠️ `already_open` COUNTS AS PASSED, and getting this wrong makes the summary actively misleading.
  // The reporter's figures are "235 Successful / 3 Failed", per EMPLOYEE. On a re-run — which is the
  // normal way this screen is used, because the sweep is idempotent — every pair comes back
  // `already_open`, and counting those as failures would report the entire company as failed while their
  // entitlement sits correctly in the ledger. "Failed" here means the employee ended the run with no
  // entitlement for any selected type, which is the only reading an operator can act on.
  //
  // r301 — …and so does an earned Annual Leave line the accrual REACHED, topped up or already up to date:
  // that employee's entitlement for the type is on the ledger. A line it did not reach stays exactly as it
  // was, including a future year's, whose days have not been earned yet.
  const passed = new Set(
    engineRows
      .filter((r) => r.outcome === 'granted' || r.outcome === 'already_open' || earnedAccrualOf(r) !== null)
      .map((r) => r.employmentId),
  );
  const employeesPassed = passed.size;
  const employeesFailed = reached.size - employeesPassed;

  const decidedBy = await withTenant(ctx, (tx) =>
    resolveDecidedBy(tx, { employmentIds: [...reached].sort(), leaveTypeId: leaveTypeIds[0], asOf }),
  );

  const result: LeaveGenerationResult = {
    year,
    employeesSelected: targets.length,
    employeesReached: reached.size,
    employeesPassed,
    employeesFailed,
    ...counts,
    lines,
    decidedBy,
    accrual,
  };
  if (dryRun) return result;

  // ── THE PROCESSING LOG, after the grant has committed. See the header for why that way round. ───────
  const runId = await withTenant(ctx, async (tx) => {
    const [run] = await tx
      .insert(leaveGenerationRun)
      .values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId ?? null,
        leaveYear: year,
        leaveTypeIds,
        targetMode,
        criteria,
        employmentIds: givenIds,
        employeesSelected: targets.length,
        granted: counts.granted,
        skipped: counts.skipped,
        forfeits: counts.forfeits,
        employeesPassed,
        employeesFailed,
      })
      .returning({ id: leaveGenerationRun.id });
    if (engineRows.length) {
      await tx.insert(leaveGenerationRunItem).values(
        engineRows.map((r) => ({
          tenantId: ctx.tenantId,
          runId: run.id,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          outcome: r.outcome,
          days: r.days.toFixed(2),
          carry: r.carry.toFixed(2),
          forfeit: r.forfeit.toFixed(2),
          belowStatutoryFloor: r.belowStatutoryFloor,
        })),
      );
    }
    // ⚠️ THE CRITERIA GO IN THE TABLE, NOT IN THE EVENT. `domain_event` is append-only and immutable
    // (REVOKE UPDATE/DELETE), and a criteria object can carry `religions` / `races` / `nationalities` —
    // PDPA s.40 sensitive demographics that ADR-0030 Layer 0 forbids inlining into a payload that can
    // never be erased. The axis NAMES are logged instead, which is what b4682879 established: log the
    // field, never the value.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-generation-run',
      aggregateId: run.id,
      eventType: 'leave-generation.run',
      actor: actorOf(ctx),
      // r301 — the earned half rides the same event as COUNTS and a failed flag: the accrual engine appends
      // its own `leave.earned-accrual.run` with the scope, and an error message is free text that has no
      // business in an immutable log.
      payload: { year, leaveTypeIds, targetMode, criteriaAxes: Object.keys(criteria), employeesSelected: targets.length, granted: counts.granted, skipped: counts.skipped, forfeits: counts.forfeits, employeesPassed, employeesFailed, earnedAccrual: accrual ? { posted: accrual.posted, upToDate: accrual.upToDate, days: accrual.days, skippedFutureYear: accrual.skippedFutureYear, failed: accrual.error !== null } : null },
    });
    return run.id;
  });
  return { ...result, runId };
}

/**
 * 6e9a126e's resolver, asked per employment for ONE leave type.
 *
 * Short-circuits to [] when the type carries no entitlement template — which is every tenant today, so
 * this costs one COUNT and nothing else until the layer is populated. Without that guard it would be one
 * membership query per employment per run, for an answer that is uniformly "nothing configured".
 */
async function resolveDecidedBy(
  tx: Tx,
  p: { employmentIds: string[]; leaveTypeId: string | undefined; asOf: string },
): Promise<LeaveGenerationResult['decidedBy']> {
  if (!p.leaveTypeId || p.employmentIds.length === 0) return [];
  if ((await countTemplatesForLeaveType(tx, p.leaveTypeId)) === 0) return [];
  const out: LeaveGenerationResult['decidedBy'] = [];
  for (const employmentId of p.employmentIds) {
    const resolved = await resolveEntitlementForEmployment(tx, {
      employmentId,
      leaveTypeId: p.leaveTypeId,
      asOf: p.asOf,
    });
    if (!resolved) continue;
    out.push({
      employmentId,
      ruleName: resolved.ruleName,
      templateName: resolved.templateName,
      // The COUNT of other rules that matched, not their names: the screen's job here is to say "this was
      // not the only candidate, go and look", and a list of names in a table cell is unreadable at width.
      alsoMatched: resolved.alsoMatched.length,
    });
  }
  return out;
}

/**
 * r301 — the "Earned Annual Leave to add" rows, one per leave type, read off the accrual's own pairs (which
 * are its breakdown unrolled — see `EarnedAccrualResult.pairs`). The name comes from the breakdown the same
 * engine returned, so this reads no table of its own.
 */
function summariseByLeaveType(acc: EarnedAccrualResult): LeaveGenerationAccrual['byLeaveType'] {
  const nameOf = new Map(acc.breakdown.map((g) => [g.leaveTypeId, g.leaveTypeName]));
  const byType = new Map<string, LeaveGenerationAccrual['byLeaveType'][number]>();
  for (const p of acc.pairs) {
    let row = byType.get(p.leaveTypeId);
    if (!row) {
      row = { leaveTypeId: p.leaveTypeId, leaveTypeName: nameOf.get(p.leaveTypeId) ?? p.leaveTypeId, posted: 0, upToDate: 0, days: 0 };
      byType.set(p.leaveTypeId, row);
    }
    if (p.days > 0) {
      row.posted += 1;
      row.days = round2(row.days + p.days);
    } else {
      row.upToDate += 1;
    }
  }
  return [...byType.values()].sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Attach the employee and leave-type names the error table and the CSV need. IDs stay, names are added. */
async function nameLines(
  tx: Tx,
  rows: LeaveYearGrantRow[],
  earnedAccrualOf: (r: LeaveYearGrantRow) => LeaveGenerationLine['earnedAccrual'],
): Promise<LeaveGenerationLine[]> {
  if (rows.length === 0) return [];
  const empIds = [...new Set(rows.map((r) => r.employmentId))];
  const typeIds = [...new Set(rows.map((r) => r.leaveTypeId))];
  const [emps, types] = await Promise.all([
    tx
      .select({ id: employment.id, name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(inArray(employment.id, empIds)),
    tx.select({ id: leaveType.id, name: leaveType.name }).from(leaveType).where(inArray(leaveType.id, typeIds)),
  ]);
  const empName = new Map(emps.map((e) => [e.id, e.name]));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  return rows.map((r) => ({
    ...r,
    // An id rather than a blank when a name is unreadable: RLS can legitimately hide a row from an admin
    // scoped to one company, and a nameless line in an error table is a line nobody can act on.
    employeeName: empName.get(r.employmentId) ?? r.employmentId,
    leaveTypeName: typeName.get(r.leaveTypeId) ?? r.leaveTypeId,
    earnedAccrual: earnedAccrualOf(r),
  }));
}

// ── Reading the log back ─────────────────────────────────────────────────────────────────────────────

export type LeaveGenerationRunSummary = {
  id: string;
  leaveYear: number;
  targetMode: string;
  employeesSelected: number;
  employeesPassed: number;
  employeesFailed: number;
  granted: number;
  skipped: number;
  forfeits: number;
  createdAt: Date;
};

/** The most recent runs, newest first — the "download the processing log" list on the screen. */
export async function listLeaveGenerationRuns(
  ctx: SessionContext,
  p?: { limit?: number },
): Promise<LeaveGenerationRunSummary[]> {
  const limit = Math.min(Math.max(p?.limit ?? 10, 1), 100);
  return withTenant(ctx, async (tx) =>
    tx
      .select({
        id: leaveGenerationRun.id,
        leaveYear: leaveGenerationRun.leaveYear,
        targetMode: leaveGenerationRun.targetMode,
        employeesSelected: leaveGenerationRun.employeesSelected,
        employeesPassed: leaveGenerationRun.employeesPassed,
        employeesFailed: leaveGenerationRun.employeesFailed,
        granted: leaveGenerationRun.granted,
        skipped: leaveGenerationRun.skipped,
        forfeits: leaveGenerationRun.forfeits,
        createdAt: leaveGenerationRun.createdAt,
      })
      .from(leaveGenerationRun)
      .orderBy(desc(leaveGenerationRun.createdAt))
      .limit(limit),
  );
}

/** RFC 4180 enough for a spreadsheet: quote everything, double the quotes inside. */
const csvCell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * THE DOWNLOADABLE PROCESSING LOG.
 *
 * Read-only, and it appends no event — downloading is not a domain fact (the same documented skip the
 * Leave Audit and entitlement-archive exports take). The header row is in English on purpose: this file is
 * opened in a spreadsheet and mailed around, and a localised header makes two people's copies of "the same
 * log" un-mergeable. The `outcome` column carries the engine's own value verbatim rather than a
 * translation, for exactly the same reason — it is the value stored in the row, and a support question
 * about it has to be answerable by grepping.
 */
export async function leaveGenerationRunCsv(
  ctx: SessionContext,
  p: { runId: string },
): Promise<{ filename: string; content: string }> {
  return withTenant(ctx, async (tx) => {
    const [run] = await tx
      .select()
      .from(leaveGenerationRun)
      .where(eq(leaveGenerationRun.id, p.runId))
      .limit(1);
    if (!run) throw new Error('That generation run could not be found.');
    const items = await tx
      .select({
        employmentId: leaveGenerationRunItem.employmentId,
        leaveTypeId: leaveGenerationRunItem.leaveTypeId,
        outcome: leaveGenerationRunItem.outcome,
        days: leaveGenerationRunItem.days,
        carry: leaveGenerationRunItem.carry,
        forfeit: leaveGenerationRunItem.forfeit,
        belowStatutoryFloor: leaveGenerationRunItem.belowStatutoryFloor,
        employeeName: person.fullName,
        leaveTypeName: leaveType.name,
      })
      .from(leaveGenerationRunItem)
      .innerJoin(employment, eq(employment.id, leaveGenerationRunItem.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveGenerationRunItem.leaveTypeId))
      .where(and(eq(leaveGenerationRunItem.runId, p.runId)))
      .orderBy(person.fullName, leaveType.name);
    const header = [
      'Employee',
      'Employment ID',
      'Leave Type',
      'Outcome',
      'Days Granted',
      'Carried Forward',
      'Forfeited',
      'Below Statutory Floor',
    ];
    const body = items.map((i) =>
      [
        i.employeeName,
        i.employmentId,
        i.leaveTypeName,
        i.outcome,
        i.days,
        i.carry,
        i.forfeit,
        i.belowStatutoryFloor ? 'yes' : 'no',
      ]
        .map(csvCell)
        .join(','),
    );
    const stamp = run.createdAt.toISOString().slice(0, 10);
    return {
      filename: `leave-generation-${run.leaveYear}-${stamp}.csv`,
      content: [header.map(csvCell).join(','), ...body].join('\n') + '\n',
    };
  });
}

const dedupe = (v: string[] | undefined): string[] => [...new Set((v ?? []).filter(Boolean))];
