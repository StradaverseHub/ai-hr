/**
 * 6e9a126e — THE ENTITLEMENT REDESIGN, RELEASE ONE OF THREE: the new layer, alongside the old one.
 *
 *     leave_type  →  entitlement_template  →  entitlement_eligibility_rule
 *
 * A TEMPLATE is a named service-band day table for ONE leave type ("Grade 12-15 Permanent", "Contract",
 * "Executive"). An ELIGIBILITY RULE says WHO gets which template. Between them they replace
 * benefit_scheme × scheme_leave_entitlement (which copied the same band table inside every scheme it
 * applied to — 292 copies behind 41 schemes on production) and leave_policy (an older company/grade layer
 * that could quietly win instead).
 *
 * ── WHERE THIS SITS AFTER RELEASE TWO ─────────────────────────────────────────────────────────────────
 * RELEASE ONE shipped the storage, the versioning writer and the resolver, read by nothing.
 *
 * RELEASE TWO (this state) re-points every granting engine, the projection kernel and all three dated
 * readers through ONE composition — `composeEntitlement`, core/leave-compute.ts — so resolution is now
 * `template ?? scheme ?? policy`, and ships the editor screens the storage was waiting for. NOTHING OLD IS
 * REMOVED: benefit_scheme, scheme_leave_entitlement, employment.benefit_scheme_id and leave_policy all
 * still resolve, and a tenant with no entitlement_template rows takes the `isEmpty` short-circuit in
 * `buildTemplateEntitlementResolver` below, at which point every composition reduces to the expression it
 * was before this item existed.
 *
 * RELEASE THREE archives, clears and drops. It is the owner's decision and nothing here anticipates it
 * beyond making the readers survive it.
 *
 * The editors landed in release two rather than one on purpose: an editor that writes configuration no
 * engine reads is worse than no editor — HR would type a table, see nothing change, and reasonably
 * conclude the feature is broken. Same staging 9816a5ad step 1 and 7c834696 stage 1 both used.
 *
 * ── WHY THE CRITERIA ARE core/org-criteria.ts, NOT A NEW MATCHER ──────────────────────────────────────
 * This item exists because "who does this apply to" is answered in several places at once. Building a
 * THIRD engine for it would be the defect wearing the fix's clothes. `core/org-criteria.ts` already
 * resolves the exact question, for bulk Leave Adjustments (491c499f) and the Notice Board (6e122302),
 * widened by 18103ba4 — and every dimension the reporter asked for is already in its vocabulary:
 *
 *     Company → companyIds · Employment Type → employmentTypes · Grade → gradeIds ·
 *     Department → departmentIds · Position → positionIds · Division → orgDivision ·
 *     Gender → genders · Minimum Service → minYearsOfService · Probation Status → confirmationStatuses
 *
 * …plus business unit, cost centre, location, the other seven Organisation-Assignment axes, nationality /
 * religion / race, employment status and a hire-date band. Nothing had to be invented, and the reporter's
 * "Any future employee criteria" is answered by adding an axis THERE, once, for all three consumers.
 *
 * It is also the only one of the three candidate engines that resolves AS AT A DATE. The approval matcher
 * (`ruleMatches`, core/leave-approval-policy.ts) is handed its attributes by its caller as of NOW, so
 * dating the RULE rows alone would still have answered a closed year with today's department — the plan
 * flagged that as "specified but not designed". `resolveOrgCriteriaTargets` reads department, position,
 * business unit, cost centre, location and employment type from the `assignment` version in force on
 * `asOf`, and computes employment status, confirmation status and years of service against it.
 *
 * ── WHAT A PAST-DATE ANSWER CANNOT RECONSTRUCT, STATED PLAINLY ────────────────────────────────────────
 * `gender`, `nationality`, `religion` and `race` live on `person`; `gradeId` lives on `employment`. NONE
 * of those five is effective-dated anywhere in this schema, so a rule that narrows by them is resolved
 * against TODAY'S value however far back `asOf` reaches. That is a schema fact, not a choice made here,
 * and it is not fixable inside this item — it needs those columns to become dated facts. It is surfaced
 * by `UNDATED_ELIGIBILITY_AXES` below so a screen can say so instead of implying precision it lacks.
 *
 * ── r212 · AND THE SAME ARGUMENT APPLIES TO EXPLAINING A "NO" ────────────────────────────────────────
 * `explainEntitlementEligibility` below answers the reporter's original question — WHICH rules exist, which
 * are in force, and what about THIS employee did not match — and it is written under the rule this header
 * has carried since release one. It re-implements nothing: the winner comes from
 * `resolveEntitlementForEmployment`, `soleTableApplies` is the engine's own `viaSoleTemplate`, whether a
 * rule matched is the SAME `resolveOrgCriteriaTargets` call the resolver makes, and the failing AXIS is
 * found by asking that same resolver a ONE-AXIS SUBSET of the same criteria object. An explanation computed
 * by a second comparison would eventually disagree with the decision, which is worse than no explanation.
 *
 * ── r210 · WHAT THE LEDGER DOES NOT RECORD, AND WHAT THAT COSTS THE DELETE GUARD ──────────────────────
 * `leave_ledger` records employment, leave type, entry type, days and effective date. IT CARRIES NO
 * REFERENCE TO THE ENTITLEMENT TABLE OR THE ELIGIBILITY RULE THAT PRODUCED A ROW, and neither does
 * `leave_entitlement_recalc_audit`: the resolver's answer is computed and thrown away. So the question
 * "has this table ever granted anybody a day" HAS NO EXACT ANSWER in this schema, and no future round
 * should assume `deleteEntitlementTemplate`'s guard is one. What it uses instead is the conservative
 * approximation — any granting row of NON-ZERO days for the leave type, dated inside a window this
 * lineage was in force — which refuses more than it must and never less. The non-zero part is not an
 * optimisation: `openLeaveYear` writes a 0-day `accrual` row unconditionally as its own open-marker
 * (see `nonZeroDays` below), so entry type alone would read "granted" over a ledger holding zero days.
 * Making it exact needs the deciding lineage recorded ON the grant, which is a schema change and a
 * separate item.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, gt, sql } from 'drizzle-orm';

import { compareEntitlementTables } from '../lib/entitlement-table-order';
// r219 — the product's business-day clock. "Has this version started yet" is a comparison against
// the MYT calendar day, the same one SQL `current_date` names on this deployment; computing it any
// other way disagrees with the database for the eight hours between UTC and MYT midnight.
import { todayInKualaLumpur } from '../lib/hr-date';
// r212 — the client-safe shape the two explaining screens render. Declared beside `EntitlementStatus`
// (which is the thing being explained) so the employee's panel, a client island, can name it without
// importing anything that touches `db/client`. Type-only: nothing at runtime crosses back.
import type { EligibilityNotice, EligibilityRuleNotice, EligibilityVerdict } from '../lib/entitlement-status';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  assignment,
  employment,
  entitlementEligibilityRule,
  entitlementTemplate,
  jobGrade,
  leaveLedger,
  leaveType,
  person,
} from '../db/schema';
import { bandFor, validateServiceBands, type AccrualConfig, type ServiceBand } from './leave-compute';
import {
  narrowedOrgCriteriaAxes,
  orgCriteriaSpecificity,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from './org-criteria';
import { ORG_ASSIGNMENT_CRITERIA } from './leave-org-criteria';

/**
 * The eligibility axes that CANNOT be resolved as at a past date, because the columns behind them carry no
 * effective dating anywhere in this schema. A screen resolving entitlement "as at 1 Jan 2024" must say so
 * rather than imply a precision it does not have. Exported as data so the wording is derived from the list
 * and cannot drift from it.
 */
export const UNDATED_ELIGIBILITY_AXES = ['gradeIds', 'genders', 'nationalities', 'religions', 'races'] as const;

/** Does this criteria object narrow by an axis that is only ever resolved at today's value? */
export function usesUndatedEligibilityAxis(criteria: OrgCriteria | null | undefined): boolean {
  const c = (criteria ?? {}) as Record<string, unknown>;
  return UNDATED_ELIGIBILITY_AXES.some((k) => Array.isArray(c[k]) && (c[k] as unknown[]).length > 0);
}

export type EntitlementTemplateRow = {
  id: string;
  lineageId: string;
  leaveTypeId: string;
  name: string;
  serviceBands: ServiceBand[];
  validFrom: string;
  validTo: string | null;
  createdAt: Date;
};

export type EligibilityRuleRow = {
  id: string;
  lineageId: string;
  name: string;
  templateLineageId: string;
  criteria: OrgCriteria;
  validFrom: string;
  validTo: string | null;
  createdAt: Date;
};

/**
 * r270 (65e4073a build 3) — WHY THE WINNER BEAT THE RUNNER-UP, IN THE TIE-BREAK'S OWN VOCABULARY.
 *
 * `beatsEligibility` already ranks candidates by specificity, then `validFrom`, then `createdAt`, and its
 * header says "every step of it is explainable on screen". It was not: two rules each narrowing ONE axis
 * tie on specificity and are then separated by a date nothing printed, so an operator reading "Resolves to
 * GP1215, through the scheme GP1215" had no way to know a second scheme also reached that employee and
 * lost on a start date.
 *
 * ⚠️ THIS REPORTS THE COMPARISON; IT DOES NOT MAKE IT. `beatsEligibility` is untouched and is still the
 * only thing that decides, `winReasonFor` re-reads the SAME three terms in the SAME order over the pair
 * the sort already produced, and nothing here can move a rule up or down the ranking. A screen that
 * printed a reason derived some other way would eventually disagree with the decision beside it.
 */
export type EntitlementWinReason =
  /** Exactly one rule reached this employee, so nothing was ranked and there is nothing to explain. */
  | 'sole_candidate'
  /** It narrows by MORE criteria axes than the runner-up (`orgCriteriaSpecificity`). */
  | 'more_specific'
  /** Tied on narrowed axes; this one TAKES EFFECT LATER — the operator's own stated date. */
  | 'later_start'
  /** Tied on narrowed axes AND on start date; this row was created last. A genuine ambiguity in the
   *  configuration, reported as one rather than dressed up as a reason. */
  | 'later_created'
  /**
   * Tied on ALL THREE terms, so `beatsEligibility` separated nothing and the winner is whichever row the
   * query returned first. There is no reason, and saying "the one set up most recently" would be a lie —
   * they were set up at the same instant. Found by the r270 verify pass on a pair with byte-identical
   * `created_at`, which is what a seed, an import or a scripted restore produces.
   */
  | 'arbitrary';

/**
 * The reason the winner won, over the pair `beatsEligibility` has already ordered. Pure, and exported so
 * the guard can drive it directly rather than through a database.
 *
 * ⚠️ THE TERMS AND THEIR ORDER MIRROR `beatsEligibility` EXACTLY. If that function's order ever changes,
 * this one is wrong rather than merely stale — which is why `test/r270-entitlement-explain.test.ts` pins
 * the two against each other over the same pairs instead of asserting this one alone.
 */
export function winReasonFor(
  winner: EligibilityRuleRow,
  runnerUp: EligibilityRuleRow | null | undefined,
): EntitlementWinReason {
  if (!runnerUp) return 'sole_candidate';
  if (orgCriteriaSpecificity(winner.criteria) !== orgCriteriaSpecificity(runnerUp.criteria)) return 'more_specific';
  if (winner.validFrom !== runnerUp.validFrom) return 'later_start';
  // The THIRD term, checked rather than assumed. `beatsEligibility` returns false in both directions when
  // the creation instants are equal, so nothing separated the pair and the winner is query order. Falling
  // through to 'later_created' here told the operator a ranking had happened that had not.
  if (winner.createdAt.getTime() !== runnerUp.createdAt.getTime()) return 'later_created';
  return 'arbitrary';
}

/** What actually decided an employee's days, and why — the shape a screen needs to say "this rule won". */
export type ResolvedEntitlement = {
  /** The eligibility rule that won — NULL when the leave type had exactly one table in force and no rule
   *  in force, so there was nothing to choose between and no rule was consulted (r193 fault 3). */
  ruleName: string | null;
  ruleLineageId: string | null;
  templateName: string;
  templateLineageId: string;
  serviceBands: ServiceBand[];
  /** How many criteria axes the winning rule narrowed by. Shown so "most specific wins" is auditable. */
  specificity: number;
  /** Every rule that ALSO matched, most-specific first. A screen shows this so the win is never a guess.
   *  The FIRST entry is the runner-up `winReason` below is about. */
  alsoMatched: { ruleName: string; specificity: number }[];
  /** r270 — which term of `beatsEligibility` separated the winner from the runner-up. NULL where no rule
   *  was consulted at all (`viaSoleTemplate` / `viaDefaultTemplate`): there was no comparison to report,
   *  and a reason invented for one would be the screen asserting a ranking that never happened. */
  winReason: EntitlementWinReason | null;
  /** r193 FAULT 3 — this answer came from the leave type's ONLY table in force, with no rule consulted
   *  because none exists to consult. A screen must say "the only table for this leave type", not name a
   *  rule that does not exist. False for every rule-decided answer. */
  viaSoleTemplate: boolean;
  /** 76ffdcf2 — this answer came from the leave type's DEFAULT entitlement table
   *  (`leave_type.default_entitlement_template_lineage_id`), because no benefit scheme in force matched
   *  this employee. A screen must say "the default table for this leave type", never name a scheme.
   *  False for every rule-decided and every sole-table answer; the three are mutually exclusive. */
  viaDefaultTemplate: boolean;
};

// ── Templates ────────────────────────────────────────────────────────────────────────────────────────

const cleanName = (raw: string): string => {
  const name = (raw ?? '').trim();
  if (!name) throw new Error('Give the entitlement table a name.');
  return name;
};

/**
 * Create a NEW named entitlement table — i.e. a new LINEAGE, whose first version is this row.
 *
 * `lineageId` is set to the row's own id. That is what makes an eligibility rule's pointer survive every
 * future edit: rules reference the lineage, never a version (see the module header).
 */
export async function createEntitlementTemplate(
  ctx: SessionContext,
  p: { leaveTypeId: string; name: string; serviceBands: ServiceBand[]; validFrom: string },
): Promise<EntitlementTemplateRow> {
  const name = cleanName(p.name);
  // THE SHARED validator, moved out of core/admin.ts by this item so leave_policy and this table can never
  // disagree about what a legal band table is. It also enforces the 20-band ceiling, which must equal
  // `isWellFormedBands`' — a writer that accepts what the resolver rejects produces no band at all, i.e.
  // a wrong day count with nothing on screen to say so.
  validateServiceBands(p.serviceBands);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(entitlementTemplate)
      .values({
        tenantId: ctx.tenantId,
        // Placeholder — overwritten with the row's own id immediately below. Drizzle has no
        // `DEFAULT id` for a second column, and a lineage that is not the first version's id would make
        // "the original" unfindable.
        lineageId: sql`gen_random_uuid()`,
        leaveTypeId: p.leaveTypeId,
        name,
        serviceBands: p.serviceBands,
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning();
    await tx
      .update(entitlementTemplate)
      .set({ lineageId: row.id })
      .where(eq(entitlementTemplate.id, row.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_template',
      aggregateId: row.id,
      eventType: 'entitlement-template.created',
      payload: { lineageId: row.id, leaveTypeId: p.leaveTypeId, name, validFrom: p.validFrom },
      actor: actorOf(ctx),
    });
    return toTemplateRow({ ...row, lineageId: row.id });
  });
}

/**
 * ── r219 · WHICH WRITE AN EDIT IS — DEFINED IN lib/entitlement-edit-mode.ts, RE-EXPORTED HERE ──────────
 *
 * The decision `updateEntitlementTemplate` and `updateEligibilityRule` below both take (in-place ·
 * supersede · refuse) is a pure function of three dates, and its full reasoning lives with it in
 * `lib/entitlement-edit-mode.ts`. It MOVED there in r224 for one reason: the two editor forms now label
 * their own Save button with the write it is about to make, which depends on what is in the date box at
 * this instant, so the deciding function has to run in the CLIENT bundle — and this module cannot, because
 * it pulls `db/client`, drizzle and the schema in with it.
 *
 * Re-exported rather than re-pointed at every call site so no import path changed with the move.
 */
export {
  entitlementEditMode,
  entitlementInPlaceChangesThePast,
  type EntitlementEditMode,
} from '../lib/entitlement-edit-mode';
import { entitlementEditMode } from '../lib/entitlement-edit-mode';

/** One version of a lineage, reduced to the only three columns the window arithmetic below needs. */
type DatedVersion = { id: string; validFrom: string; validTo: string | null };

/**
 * The sibling version an IN-PLACE start-date change would collide with, or null.
 *
 * ⚠️ THE TWO PARTIAL-UNIQUE INDEXES ARE NOT WHAT THIS GUARDS. They police "one running version per
 * lineage" and "one running NAME per leave type"; an in-place UPDATE creates no second running row, so it
 * touches neither. What it CAN do is move the running version's start date into a window a SUPERSEDED
 * sibling already claims, and nothing in the database refuses that — the CHECK constraint only compares a
 * row against itself.
 *
 * The running version runs to infinity, so it overlaps every sibling that has not already ended by the
 * new date. That single comparison covers both shapes at once: the new date landing INSIDE a superseded
 * window, and the new date sitting BEFORE a superseded version even starts. Its practical effect on a
 * lineage with history is that the running version can only be moved FORWARD — backwards would always
 * land inside its own predecessor, which is exactly the closed year the supersede arm exists to protect.
 *
 * Every non-running version of a lineage is closed, because the open partial-unique index allows exactly
 * one row with a NULL `valid_to`, so `validTo` is a real date on all of them.
 */
function overlappingSibling(
  versions: readonly DatedVersion[],
  openId: string,
  newValidFrom: string,
): { id: string; validFrom: string; validTo: string } | null {
  const clashes = versions.filter(
    (v): v is DatedVersion & { validTo: string } =>
      v.id !== openId && v.validTo !== null && v.validTo > newValidFrom,
  );
  if (clashes.length === 0) return null;
  // The latest-ending one is the binding constraint, and its end date is the date the operator has to
  // clear — so it is the one the refusal names.
  return clashes.reduce((a, b) => (b.validTo > a.validTo ? b : a));
}

/**
 * Edit a named table. TWO WRITES, and `entitlementEditMode` above decides which.
 *
 *  · SUPERSEDE — the version has been in force: close the running version at `validFrom` and insert a
 *    successor. NOT an in-place UPDATE, and this is the whole reason both tables are dated; see
 *    `entitlementEditMode` for what the three past-date readers depend on. Identical shape to
 *    `createLeavePolicy`'s supersede loop.
 *  · IN PLACE — the version has not started yet, or its date is not moving: UPDATE the row, its own start
 *    date included, forwards or backwards.
 *
 * `today` is a parameter only so a test can pin the clock; every caller in the app omits it, and no form
 * posts it.
 *
 * The LEAVE TYPE is deliberately not editable: an eligibility rule that pointed at "the Executive ANNUAL
 * table" would silently start handing out SICK days. Retype it as a new table instead.
 */
export async function updateEntitlementTemplate(
  ctx: SessionContext,
  p: { lineageId: string; name?: string; serviceBands?: ServiceBand[]; validFrom: string; today?: string },
): Promise<EntitlementTemplateRow> {
  if (p.serviceBands !== undefined) validateServiceBands(p.serviceBands);
  const name = p.name !== undefined ? cleanName(p.name) : undefined;
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    // EVERY version of the lineage, not just the running one: an in-place start-date change has to be
    // checked against the superseded siblings' windows before anything is written.
    const versions = await tx
      .select()
      .from(entitlementTemplate)
      .where(eq(entitlementTemplate.lineageId, p.lineageId));
    const open = versions.find((v) => v.validTo === null);
    if (!open) throw new Error('That entitlement table has no running version to edit.');

    const mode = entitlementEditMode({ openValidFrom: open.validFrom, newValidFrom: p.validFrom, today });
    if (mode === 'refuse') {
      throw new Error(
        `This entitlement table has been in force since ${open.validFrom}, so a new version has to start after ${open.validFrom}.`,
      );
    }
    if (mode === 'in-place') {
      const prevContiguous = versions.find((v) => v.id !== open.id && v.validTo === open.validFrom);
      const clash = overlappingSibling(versions, open.id, p.validFrom);
      // The one overlap that is not a conflict: our own contiguous predecessor, with both its boundary and
      // the new date still ahead of us. See `overlappingSibling`.
      const reclaimable =
        clash !== null &&
        prevContiguous !== undefined &&
        clash.id === prevContiguous.id &&
        p.validFrom > today &&
        (prevContiguous.validTo ?? '') > today;
      if (clash && !reclaimable) {
        throw new Error(
          `An earlier version of this table runs from ${clash.validFrom} until ${clash.validTo}, so this version cannot start on ${p.validFrom}. Give it a date on or after ${clash.validTo}.`,
        );
      }
      // ⚠️ KEEP THE LINEAGE CONTIGUOUS. A supersede closes the predecessor at exactly this version's
      // `validFrom`, so moving the start date without moving that end date would leave a stretch with no
      // version of this table in force at all — a hole close-then-insert has never produced. The boundary
      // moves in BOTH directions and the guards above are what keep that safe: a date change here requires
      // `open.validFrom > today`, and a BACKWARDS move past the predecessor's end is only allowed when that
      // end and the new date are both still in the future. So the boundary being rewritten has never been
      // resolved against.
      const prev = prevContiguous;
      if (prev && p.validFrom !== open.validFrom) {
        await tx
          .update(entitlementTemplate)
          .set({ validTo: p.validFrom })
          .where(eq(entitlementTemplate.id, prev.id));
      }
      const [row] = await tx
        .update(entitlementTemplate)
        .set({
          name: name ?? open.name,
          serviceBands: (p.serviceBands ?? open.serviceBands) as ServiceBand[],
          validFrom: p.validFrom,
        })
        .where(eq(entitlementTemplate.id, open.id))
        .returning();
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'entitlement_template',
        aggregateId: open.id,
        eventType: 'entitlement-template.updated',
        payload: { lineageId: p.lineageId, validFrom: p.validFrom, previousValidFrom: open.validFrom },
        actor: actorOf(ctx),
      });
      return toTemplateRow(row);
    }
    // ⚠️ CLOSE FIRST, THEN INSERT — not the other way round. Two partial-unique indexes police this table
    // (one running version per lineage; one running NAME per leave type), and inserting the successor while
    // its predecessor is still open trips both. Doing it in this order is not a workaround for the
    // constraints, it is what they are FOR: at no instant inside the transaction do two versions claim to
    // be in force. Both statements are in one transaction, so nothing observes the closed-and-not-yet-
    // replaced state.
    await tx
      .update(entitlementTemplate)
      .set({ validTo: p.validFrom })
      .where(eq(entitlementTemplate.id, open.id));
    const [next] = await tx
      .insert(entitlementTemplate)
      .values({
        tenantId: ctx.tenantId,
        lineageId: p.lineageId,
        // Constant across the lineage, by construction.
        leaveTypeId: open.leaveTypeId,
        name: name ?? open.name,
        serviceBands: (p.serviceBands ?? open.serviceBands) as ServiceBand[],
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning();
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_template',
      aggregateId: next.id,
      eventType: 'entitlement-template.superseded',
      payload: { lineageId: p.lineageId, supersededId: open.id, validFrom: p.validFrom },
      actor: actorOf(ctx),
    });
    return toTemplateRow(next);
  });
}

/** Every template version in force on `asOf` (default: every version), in the order HR reads them —
 *  PERMANENT, then CONTRACT, then its SPECIAL and RETIREE variants, then PART TIMER, with GRADE H
 *  leading each block; `lib/entitlement-table-order.ts` owns the rule and explains it. */
export async function listEntitlementTemplates(
  ctx: SessionContext,
  p?: { asOf?: string; leaveTypeId?: string },
): Promise<EntitlementTemplateRow[]> {
  return withTenant(ctx, async (tx) => {
    const conds = [];
    if (p?.asOf) {
      conds.push(lte(entitlementTemplate.validFrom, p.asOf));
      conds.push(or(isNull(entitlementTemplate.validTo), gt(entitlementTemplate.validTo, p.asOf))!);
    }
    if (p?.leaveTypeId) conds.push(eq(entitlementTemplate.leaveTypeId, p.leaveTypeId));
    const rows = await tx
      .select()
      .from(entitlementTemplate)
      .where(conds.length ? and(...conds) : undefined)
      // A deterministic BASE order, not the order anyone sees: the sort below is stable, so identical
      // keys keep whatever this produced instead of varying between runs of the same query.
      .orderBy(asc(entitlementTemplate.name), asc(entitlementTemplate.validFrom));
    // 3214cb11 / 813fd22a — A-to-Z is not the order HR reads these in. Ordering HERE rather than in the
    // block means every reader inherits it (the standalone screen, each leave type's Entitlement step,
    // and the eligibility rule's template select all come off this one read) and there is no second
    // sort to drift. See lib/entitlement-table-order.ts for why the rule is derived from the name.
    return rows.map(toTemplateRow).sort(compareEntitlementTables);
  });
}

// ── Eligibility rules ────────────────────────────────────────────────────────────────────────────────

/**
 * Assign a population to a template.
 *
 * ⚠️ AN EMPTY CRITERIA OBJECT IS LEGAL AND MEANS EVERYONE. That is `core/org-criteria.ts`'s own semantics
 * (an unrestricted axis is no restriction), it is how a tenant expresses "one default table", and the
 * resolver deliberately does not second-guess it. It is also how somebody assigns the entire company to a
 * table by accident — so every screen that writes one is required to show `countOrgCriteriaTargets` and
 * make the operator confirm it, exactly as the Notice Board and Leave Adjustments do.
 */
export async function createEligibilityRule(
  ctx: SessionContext,
  p: { name: string; templateLineageId: string; criteria: OrgCriteria; validFrom: string },
): Promise<EligibilityRuleRow> {
  const name = cleanName(p.name);
  return withTenant(ctx, async (tx) => {
    await assertTemplateLineageExists(tx, p.templateLineageId);
    const [row] = await tx
      .insert(entitlementEligibilityRule)
      .values({
        tenantId: ctx.tenantId,
        lineageId: sql`gen_random_uuid()`,
        name,
        templateLineageId: p.templateLineageId,
        criteria: p.criteria ?? {},
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning();
    await tx
      .update(entitlementEligibilityRule)
      .set({ lineageId: row.id })
      .where(eq(entitlementEligibilityRule.id, row.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_eligibility_rule',
      aggregateId: row.id,
      eventType: 'entitlement-eligibility.created',
      payload: { lineageId: row.id, templateLineageId: p.templateLineageId, name, validFrom: p.validFrom },
      actor: actorOf(ctx),
    });
    return toRuleRow({ ...row, lineageId: row.id });
  });
}

/**
 * Edit a rule. The SAME two writes as `updateEntitlementTemplate`, decided by the same
 * `entitlementEditMode` — a rule that has not started yet is edited in place, start date included; one
 * that has been in force is superseded, exactly as before. Read that function's notes for both halves;
 * the restriction existed here for the same reason and was self-referential in the same way.
 */
export async function updateEligibilityRule(
  ctx: SessionContext,
  p: {
    lineageId: string;
    name?: string;
    templateLineageId?: string;
    criteria?: OrgCriteria;
    validFrom: string;
    today?: string;
  },
): Promise<EligibilityRuleRow> {
  const name = p.name !== undefined ? cleanName(p.name) : undefined;
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    if (p.templateLineageId !== undefined) await assertTemplateLineageExists(tx, p.templateLineageId);
    const versions = await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(eq(entitlementEligibilityRule.lineageId, p.lineageId));
    const open = versions.find((v) => v.validTo === null);
    if (!open) throw new Error('That eligibility rule has no running version to edit.');

    const mode = entitlementEditMode({ openValidFrom: open.validFrom, newValidFrom: p.validFrom, today });
    if (mode === 'refuse') {
      throw new Error(
        `This eligibility rule has been in force since ${open.validFrom}, so a new version has to start after ${open.validFrom}.`,
      );
    }
    if (mode === 'in-place') {
      const prevContiguous = versions.find((v) => v.id !== open.id && v.validTo === open.validFrom);
      const clash = overlappingSibling(versions, open.id, p.validFrom);
      // The same single exception the template half makes, for the same reason and by the same test:
      // our own contiguous predecessor, with its boundary and the new date both still in the future.
      const reclaimable =
        clash !== null &&
        prevContiguous !== undefined &&
        clash.id === prevContiguous.id &&
        p.validFrom > today &&
        (prevContiguous.validTo ?? '') > today;
      if (clash && !reclaimable) {
        throw new Error(
          `An earlier version of this rule runs from ${clash.validFrom} until ${clash.validTo}, so this version cannot start on ${p.validFrom}. Give it a date on or after ${clash.validTo}.`,
        );
      }
      // Keep the lineage contiguous — see the note in `updateEntitlementTemplate`.
      const prev = prevContiguous;
      if (prev && p.validFrom !== open.validFrom) {
        await tx
          .update(entitlementEligibilityRule)
          .set({ validTo: p.validFrom })
          .where(eq(entitlementEligibilityRule.id, prev.id));
      }
      const [row] = await tx
        .update(entitlementEligibilityRule)
        .set({
          name: name ?? open.name,
          templateLineageId: p.templateLineageId ?? open.templateLineageId,
          criteria: (p.criteria ?? open.criteria) as OrgCriteria,
          validFrom: p.validFrom,
        })
        .where(eq(entitlementEligibilityRule.id, open.id))
        .returning();
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'entitlement_eligibility_rule',
        aggregateId: open.id,
        eventType: 'entitlement-eligibility.updated',
        payload: { lineageId: p.lineageId, validFrom: p.validFrom, previousValidFrom: open.validFrom },
        actor: actorOf(ctx),
      });
      return toRuleRow(row);
    }
    // Close first, then insert — see the note in `updateEntitlementTemplate`.
    await tx
      .update(entitlementEligibilityRule)
      .set({ validTo: p.validFrom })
      .where(eq(entitlementEligibilityRule.id, open.id));
    const [next] = await tx
      .insert(entitlementEligibilityRule)
      .values({
        tenantId: ctx.tenantId,
        lineageId: p.lineageId,
        name: name ?? open.name,
        templateLineageId: p.templateLineageId ?? open.templateLineageId,
        criteria: (p.criteria ?? open.criteria) as OrgCriteria,
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning();
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_eligibility_rule',
      aggregateId: next.id,
      eventType: 'entitlement-eligibility.superseded',
      payload: { lineageId: p.lineageId, supersededId: open.id, validFrom: p.validFrom },
      actor: actorOf(ctx),
    });
    return toRuleRow(next);
  });
}

/**
 * RELEASE TWO — STOP a table or a rule from a date, without deleting anything.
 *
 * ⚠️ NOTHING A DATED READER CAN REACH IS EVER REMOVED. Three readers answer for a PAST date; a row removed
 * from history makes every closed year they can reach silently re-resolve against whatever is left. Closing
 * the running version at `validTo` says "this stopped applying on that date", which is the true statement
 * and the one the dated readers can act on. It is also reversible by writing a new version. STOP IS
 * THEREFORE THE ONLY WAY OUT OF A RECORD THAT WAS USED, and these two functions do not check usage
 * because they never need to: they take nothing away.
 *
 * ⚠️ r210 — DELETE EXISTS NOW, and only where that rule has nothing to protect: `deleteEntitlementTemplate`
 * / `deleteEligibilityRule` below remove a whole lineage outright when NOTHING WAS GRANTED while it was in
 * force and NOTHING POINTS AT IT — configuration typed during setup that no reader has ever resolved. They
 * refuse, by name, in every other case and send the operator here. (An older version of this header said
 * "there is no delete on either table, deliberately". That sentence stated the rule by its consequence,
 * and the consequence changed; the rule above did not.)
 *
 * Retiring a TEMPLATE deliberately does NOT touch the rules pointing at it: from `validTo` onward those
 * rules resolve no template in force and simply stop matching, which is the same outcome as deleting them
 * and keeps the record of what was configured. The screen shows the count so this is never a surprise.
 */
export async function retireEntitlementTemplate(
  ctx: SessionContext,
  p: { lineageId: string; validTo: string },
): Promise<void> {
  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select()
      .from(entitlementTemplate)
      .where(and(eq(entitlementTemplate.lineageId, p.lineageId), isNull(entitlementTemplate.validTo)))
      .limit(1);
    if (!open) throw new Error('That entitlement table has no running version to stop.');
    if (open.validFrom >= p.validTo) {
      throw new Error('An entitlement table cannot stop on or before the day it started.');
    }
    await tx
      .update(entitlementTemplate)
      .set({ validTo: p.validTo })
      .where(eq(entitlementTemplate.id, open.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_template',
      aggregateId: open.id,
      eventType: 'entitlement-template.retired',
      payload: { lineageId: p.lineageId, validTo: p.validTo },
      actor: actorOf(ctx),
    });
  });
}

/** Stop an eligibility rule from a date. Same reasoning as `retireEntitlementTemplate`. */
export async function retireEligibilityRule(
  ctx: SessionContext,
  p: { lineageId: string; validTo: string },
): Promise<void> {
  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(
        and(eq(entitlementEligibilityRule.lineageId, p.lineageId), isNull(entitlementEligibilityRule.validTo)),
      )
      .limit(1);
    if (!open) throw new Error('That eligibility rule has no running version to stop.');
    if (open.validFrom >= p.validTo) {
      throw new Error('An eligibility rule cannot stop on or before the day it started.');
    }
    await tx
      .update(entitlementEligibilityRule)
      .set({ validTo: p.validTo })
      .where(eq(entitlementEligibilityRule.id, open.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_eligibility_rule',
      aggregateId: open.id,
      eventType: 'entitlement-eligibility.retired',
      payload: { lineageId: p.lineageId, validTo: p.validTo },
      actor: actorOf(ctx),
    });
  });
}

/**
 * r210 0c367864 — DELETE, WHICH SITS BESIDE THE STOP RULE ABOVE AND DOES NOT REPLACE IT.
 *
 * ⚠️ THE RULE `retireEntitlementTemplate`'s header states STILL HOLDS. Configuration a dated reader can
 * reach is never removed, and the two delete entry points below refuse precisely so that it cannot be.
 * What that rule never covered is configuration that reached NOBODY — a table typed while the setup was
 * being built, superseded twice, and never once consulted by a grant. Measured on production 2026-08-20:
 * 47 entitlement tables in force, THREE eligibility rules, 152 accrual rows. Annual Leave's sixteen
 * tables have never had a rule, so they have never handed anybody a day; other leave types have granted.
 * Both branches of the guard are therefore reachable on the customer's own data, not hypothetical.
 *
 * A DELETE IS THE WHOLE LINEAGE — every version, in one transaction. Removing only the running version
 * would leave the superseded ones behind, and a report for a closed year would then resolve a table the
 * operator believes they deleted: the worst of both rules at once.
 *
 * ── ⚠️ THE GUARD IS CONSERVATIVE BECAUSE THE DATA CANNOT MAKE IT EXACT ────────────────────────────────
 * The ledger carries no reference to the table or rule that produced a row (module header, "WHAT THE
 * LEDGER DOES NOT RECORD"). So the second refusal below is NOT "this table granted these days" and must
 * never be reworded into that claim: it is "this leave type granted days while this lineage was in force,
 * and nothing recorded which lineage decided them". It refuses some lineages that granted nothing — a
 * sibling table of the same type may have been the one that granted — and it refuses nothing that did.
 * The refusal wording says so, and the screen repeats it, so no operator reads a precision out of it that
 * the database cannot support.
 */

/** The ledger entry types that GRANT entitlement. `adjustment` is a human act on a balance and `debit` is
 *  leave taken — neither is evidence that an entitlement table was ever resolved. */
const GRANTING_ENTRY_TYPES = ['accrual', 'in_lieu_accrual'] as const;

/**
 * ⚠️ AND THE ENTRY TYPE ALONE IS NOT ENOUGH: A 0-DAY `accrual` ROW IS A MARKER, NOT A GRANT.
 *
 * `openLeaveYear` (core/leave.ts, "the row is ALWAYS written — even at 0 days") writes one `accrual` row
 * per employee per leave type per year UNCONDITIONALLY, because that row is its own idempotency
 * open-marker AND the expiry sweep's "this year was opened" marker. bc36c768 forces the days to 0 for a
 * type carrying `accrual_unconfigured` — and migration 0376 stamped that marker on EVERY non-archived
 * leave type. So the customer's ledger is full of 0.00 `accrual` rows for types that have never handed
 * anybody a day, and a guard filtering on entry type alone would count every one of them as a grant:
 * the never-used table this item exists to let them clear would be undeletable, and the refusal would
 * assert something false ("granted entitlement to 1 employee" over a ledger holding zero days).
 *
 * `<> 0` rather than `> 0`: `reprojectEntitlementForLeaveTypeCohort` writes a NEGATIVE `accrual` row to
 * claw a grant back, and a clawback is evidence that a grant happened. Only exactly zero is silence.
 */
const nonZeroDays = () => sql`${leaveLedger.days} <> 0`;

/**
 * WHAT THE SCREEN CAN KNOW ABOUT A LINEAGE BEFORE ANYBODY PRESSES DELETE — which is the POINTERS, and
 * deliberately NOT the grants. See `entitlementDeleteBlocks` for the measurement that decided it.
 */
export type EntitlementUsageBlock = {
  /** Eligibility rules (one name per rule lineage) that point at this template. Deleting the rule first
   *  is what clears it, which is why this one is worth the round trip: it names the operator's next step
   *  rather than just refusing. An eligibility RULE has no such block — nothing points at a rule. */
  rules: string[];
};

/**
 * Nothing POINTS at it ⇒ the screen offers Delete.
 *
 * ⚠️ THIS IS NOT "THE DELETE WILL SUCCEED", and the name is the closest short one that does not claim it
 * is. The grant guard lives only in `deleteEntitlementTemplate` / `deleteEligibilityRule`, so a table
 * whose leave type granted while it was in force still shows Delete and is refused — in words, naming the
 * leave type, the window and the employee count, beside the Stop control on the same row. That is what
 * the approved plan asks for ("Delete does not just refuse. It says what is holding it… and offers to
 * stop it from a date instead, in one click from the same place"); only the RULES half is promised on the
 * row itself ("The screen will say so rather than making you guess").
 */
export function isDeletableLineage(b: EntitlementUsageBlock | undefined): boolean {
  return !b || b.rules.length === 0;
}

/** The half-open span a lineage was in force across ALL its versions: `to` null ⇒ still running. */
export type LineageWindow = { from: string; to: string | null };

/**
 * The outer bounds of every version of one lineage.
 *
 * The versions of a lineage are contiguous by construction — an edit CLOSES the running version at the
 * successor's `validFrom` and inserts it in the same transaction, so there is no gap between them to
 * exclude. Taking the outer bounds would be the conservative answer even if there were one, which is the
 * direction this guard is required to err in.
 */
export function lineageInForceWindow(
  versions: readonly { validFrom: string; validTo: string | null }[],
): LineageWindow | null {
  if (versions.length === 0) return null;
  let from = versions[0].validFrom;
  let to: string | null = null;
  let stillRunning = false;
  for (const v of versions) {
    if (v.validFrom < from) from = v.validFrom;
    if (v.validTo == null) stillRunning = true;
    else if (to == null || v.validTo > to) to = v.validTo;
  }
  return { from, to: stillRunning ? null : to };
}

/** The granting entries for one leave type inside one window. See the caveat: an upper bound, not an
 *  attribution. `count(distinct (employment, date))` — one entry per employee per grant date, so the
 *  number the refusal quotes is "24 employees", never "24 ledger rows". */
async function grantsInWindow(
  tx: Tx,
  leaveTypeId: string,
  w: LineageWindow,
): Promise<{ grants: number; employees: number }> {
  const conds = [
    eq(leaveLedger.leaveTypeId, leaveTypeId),
    inArray(leaveLedger.entryType, [...GRANTING_ENTRY_TYPES]),
    // openLeaveYear's always-written 0-day open-marker is not a grant — see `nonZeroDays`.
    nonZeroDays(),
    gte(leaveLedger.effectiveOn, w.from),
  ];
  if (w.to != null) conds.push(lt(leaveLedger.effectiveOn, w.to));
  const [row] = await tx
    .select({
      grants: sql<number>`count(distinct (${leaveLedger.employmentId}, ${leaveLedger.effectiveOn}))::int`,
      employees: sql<number>`count(distinct ${leaveLedger.employmentId})::int`,
    })
    .from(leaveLedger)
    .where(and(...conds));
  return { grants: Number(row?.grants ?? 0), employees: Number(row?.employees ?? 0) };
}

/**
 * Every rule LINEAGE that points at this template, named by its current version.
 *
 * EVERY VERSION of every rule is looked at, not only the ones in force: a rule that used to point here
 * and was later re-pointed still has a version that names this lineage, and the dated readers resolve
 * that version when they answer for a date inside its window. Deleting the table under it would make
 * exactly the closed-year re-resolution the retire rule exists to prevent.
 */
async function ruleLineagesPointingAt(tx: Tx, templateLineageId: string): Promise<string[]> {
  const rows = await tx
    .select({
      lineageId: entitlementEligibilityRule.lineageId,
      name: entitlementEligibilityRule.name,
    })
    .from(entitlementEligibilityRule)
    .where(eq(entitlementEligibilityRule.templateLineageId, templateLineageId))
    .orderBy(asc(entitlementEligibilityRule.validFrom));
  // Ascending by validFrom, so the LAST name written for a lineage wins — the one the screen shows.
  const byLineage = new Map<string, string>();
  for (const r of rows) byLineage.set(r.lineageId, r.name);
  return [...byLineage.values()].sort((a, b) => a.localeCompare(b));
}

/** The name a lineage carries today — its latest version's, which is the one the operator is looking at. */
function latestName(versions: readonly { name: string; validFrom: string }[]): string {
  let head = versions[0];
  for (const v of versions) if (v.validFrom >= head.validFrom) head = v;
  return head.name;
}

async function leaveTypeNameOf(tx: Tx, leaveTypeId: string): Promise<string> {
  const [row] = await tx
    .select({ name: leaveType.name })
    .from(leaveType)
    .where(eq(leaveType.id, leaveTypeId))
    .limit(1);
  return row?.name ?? 'This leave type';
}

/** The sentence a refusal-by-grants gives, in one place so the two entry points cannot describe the
 *  approximation differently. `what` is "table" or "rule". */
const grantedRefusal = (what: string, typeName: string, employees: number, w: LineageWindow): string =>
  `${typeName} granted entitlement to ${employees} ${employees === 1 ? 'employee' : 'employees'} while this ${what} was in force ` +
  `(${w.from}${w.to ? ` to ${w.to}` : ' onwards'}), so it cannot be deleted. A leave record does not say which ${what} ` +
  `decided a grant, so every grant inside that period is counted. Stop the ${what} from a date instead — that keeps ` +
  `what past years were reported against.`;

/**
 * ⚠️ THE COMPANY SCOPE THE DATABASE CANNOT APPLY TO A DELETE, ASKED HERE INSTEAD.
 *
 * Migration 0409 restored 0134's company-scoped write check on `entitlement_eligibility_rule` — as an RLS
 * WITH CHECK, and WITH CHECK is consulted for INSERT and UPDATE only. The policy's USING clause is
 * tenant-wide on purpose (the accrual kernel resolves entitlement under non-admin sessions), so a DELETE
 * would be fenced by tenant and by nothing else: a company-scoped admin could remove another company's
 * rule. RETIRING the same rule is an UPDATE and IS refused by that check. Delete must not be the weaker
 * door, so the same predicate is asked here, in the same transaction, before anything is removed.
 */
async function assertMayDeleteRuleLineage(tx: Tx, versions: readonly RuleSelect[]): Promise<void> {
  const companies = new Set<string>();
  let reachesWholeGroup = false;
  for (const v of versions) {
    const ids = (v.criteria as { companyIds?: unknown } | null)?.companyIds;
    if (Array.isArray(ids) && ids.length > 0) for (const c of ids) companies.add(String(c));
    else reachesWholeGroup = true;
  }
  const asks = async (predicate: ReturnType<typeof sql>): Promise<boolean> => {
    const res = await tx.execute(sql`select ${predicate} as ok`);
    return !!(res as unknown as { ok: boolean }[])[0]?.ok;
  };
  if (reachesWholeGroup && !(await asks(sql`app.is_group_admin()`))) {
    throw new Error('This eligibility rule reaches every company, so only a group administrator can delete it.');
  }
  for (const id of companies) {
    if (!(await asks(sql`app.is_admin_for(${id}::uuid)`))) {
      throw new Error('You can only delete an eligibility rule for a company you administer.');
    }
  }
}

/**
 * Remove an entitlement table OUTRIGHT — every version of the lineage, in one transaction.
 *
 * Refuses, by name, when an eligibility rule points at it (delete the rule first) or when the leave type
 * granted entitlement while it was in force (see the section header for what that can and cannot mean).
 * The caller is expected to offer STOP FROM A DATE where this refuses; both refusals say so.
 */
export async function deleteEntitlementTemplate(
  ctx: SessionContext,
  p: { lineageId: string },
): Promise<{ deletedVersions: number }> {
  return withTenant(ctx, async (tx) => {
    const versions = await tx
      .select()
      .from(entitlementTemplate)
      .where(eq(entitlementTemplate.lineageId, p.lineageId));
    if (versions.length === 0) throw new Error('That entitlement table no longer exists.');
    const name = latestName(versions);
    const rules = await ruleLineagesPointingAt(tx, p.lineageId);
    if (rules.length > 0) {
      throw new Error(
        `${rules.length === 1 ? 'The eligibility rule' : 'The eligibility rules'} ${rules.join(', ')} ` +
          `${rules.length === 1 ? 'points' : 'point'} at ${name}, so it cannot be deleted. Delete ` +
          `${rules.length === 1 ? 'that rule' : 'those rules'} first, or stop this table from a date instead.`,
      );
    }
    // The lineage's leave type is constant across its versions — `updateEntitlementTemplate` refuses to
    // change it — so any version answers, and `versions[0]` is not a guess about which.
    const leaveTypeId = versions[0].leaveTypeId;
    /**
     * 76ffdcf2 — …AND A LEAVE TYPE'S NAMED DEFAULT IS A POINTER TOO, so it belongs beside the rule check
     * above rather than being discovered afterwards. A default is the table everyone no scheme covers
     * receives: deleting it out from under them would silently return the whole unmatched population to
     * resolving nothing, which is the state this item exists to end. And
     * `default_entitlement_template_lineage_id` carries no FK (a lineage is not a row), so nothing in the
     * database would have stopped it.
     *
     * Refused rather than cleared: clearing somebody's fallback as a side effect of a delete is a bigger
     * decision than the one they pressed. The message names the way out, exactly as the rule refusal does.
     */
    const [defaultOf] = await tx
      .select({ id: leaveType.id, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.defaultEntitlementTemplateLineageId, p.lineageId))
      .limit(1);
    if (defaultOf) {
      throw new Error(
        `${name} is the default entitlement table for ${defaultOf.name}, so it cannot be deleted. ` +
          `Choose another default (or clear it) on that leave type first, or stop this table from a date instead.`,
      );
    }
    const window = lineageInForceWindow(versions)!;
    const used = await grantsInWindow(tx, leaveTypeId, window);
    if (used.grants > 0) {
      throw new Error(grantedRefusal('table', await leaveTypeNameOf(tx, leaveTypeId), used.employees, window));
    }
    await tx.delete(entitlementTemplate).where(eq(entitlementTemplate.lineageId, p.lineageId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      // The LINEAGE, not a row id: every row is gone by the time this is appended, and the lineage is the
      // identity the created / superseded / retired events on it already share.
      aggregateType: 'entitlement_template',
      aggregateId: p.lineageId,
      eventType: 'entitlement-template.deleted',
      payload: {
        lineageId: p.lineageId,
        leaveTypeId,
        name,
        versions: versions.length,
        validFrom: window.from,
        validTo: window.to,
      },
      actor: actorOf(ctx),
    });
    return { deletedVersions: versions.length };
  });
}

/**
 * Remove an eligibility rule OUTRIGHT — every version of the lineage, in one transaction.
 *
 * Nothing points at a rule, so the only refusal is the granted one: a rule that was in force while the
 * leave type handed out days is part of how a closed year resolves, whatever it decided for whom. Every
 * template lineage the rule EVER pointed at is checked — `updateEligibilityRule` may re-point a rule, and
 * a rule that spent last year pointing at another leave type's table was in force over that type too.
 */
export async function deleteEligibilityRule(
  ctx: SessionContext,
  p: { lineageId: string },
): Promise<{ deletedVersions: number }> {
  return withTenant(ctx, async (tx) => {
    const versions = await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(eq(entitlementEligibilityRule.lineageId, p.lineageId));
    if (versions.length === 0) throw new Error('That eligibility rule no longer exists.');
    await assertMayDeleteRuleLineage(tx, versions);
    const name = latestName(versions);
    const window = lineageInForceWindow(versions)!;
    const templateLineageIds = [...new Set(versions.map((v) => v.templateLineageId))];
    const typeRows = await tx
      .selectDistinct({ id: entitlementTemplate.leaveTypeId })
      .from(entitlementTemplate)
      .where(inArray(entitlementTemplate.lineageId, templateLineageIds));
    for (const { id: leaveTypeId } of typeRows) {
      const used = await grantsInWindow(tx, leaveTypeId, window);
      if (used.grants > 0) {
        throw new Error(grantedRefusal('rule', await leaveTypeNameOf(tx, leaveTypeId), used.employees, window));
      }
    }
    await tx.delete(entitlementEligibilityRule).where(eq(entitlementEligibilityRule.lineageId, p.lineageId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'entitlement_eligibility_rule',
      aggregateId: p.lineageId,
      eventType: 'entitlement-eligibility.deleted',
      payload: {
        lineageId: p.lineageId,
        templateLineageIds,
        name,
        versions: versions.length,
        validFrom: window.from,
        validTo: window.to,
      },
      actor: actorOf(ctx),
    });
    return { deletedVersions: versions.length };
  });
}

/**
 * WHICH TEMPLATE LINEAGES HAVE AN ELIGIBILITY RULE POINTING AT THEM — the one delete blocker the screen
 * names before anybody clicks, because it is the one with a NEXT STEP ("delete that rule first").
 *
 * ⚠️ IT DELIBERATELY DOES NOT READ THE LEDGER, AND THAT IS A MEASURED DECISION, NOT AN OVERSIGHT.
 *
 * The first cut of this reader also pre-computed the GRANT half — one DISTINCT read of `leave_ledger`
 * per page render, narrowed to the granting entry types and to dates at or after the earliest lineage
 * start. `leave_ledger`'s only index is (employment_id, leave_type_id) and neither column is available
 * here, so that read is a sequential scan — and the scan is not the expensive part. `leave_ledger`'s RLS
 * policy is `tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id)`, and
 * `can_see_employment` is a SECURITY DEFINER function running up to four EXISTS including two recursive
 * hierarchy walks. RLS quals are security-barrier quals: `EXPLAIN ANALYZE` confirms Postgres evaluates
 * it BEFORE `entry_type` and `days` (neither operator is leakproof), so it ran once per ledger ROW —
 * including every `debit` row for every leave day ever taken.
 *
 * MEASURED on this machine (24 leave types, 47 templates, 20 employments, one page render):
 *
 *     ledger rows        0        5,000       50,000      200,000
 *     render cost      4 ms       177 ms      1,723 ms    6,979 ms
 *
 * ~35µs per ledger row, linear, on a table that only ever grows — on EVERY render of both
 * /admin/leave/entitlements and /admin/leave/entitlements/templates, which read no ledger at all before
 * this item. No index fixes it: the per-row cost is the RLS function, not the scan.
 *
 * So the grant guard stays where it can be asked about ONE lineage at a time, inside the delete's own
 * transaction (`grantsInWindow`), where it is one bounded query on one leave type. The operator presses
 * Delete and gets the refusal in words — the leave type, the window, the employee count, the caveat —
 * next to the Stop control on the same row. That is precisely what the approved plan describes; only the
 * pointing-rules half was promised on the row itself.
 *
 * COST NOW: two queries over configuration-sized tables (tens of rows), no ledger read, no window
 * arithmetic. Deleting a template is still refused by `ruleLineagesPointingAt` inside the transaction,
 * so this reader is an affordance and never the fence.
 */
export async function entitlementDeleteBlocks(ctx: SessionContext): Promise<{
  templates: Map<string, EntitlementUsageBlock>;
}> {
  return withTenant(ctx, async (tx) => {
    const templateLineages = await tx
      .selectDistinct({ lineageId: entitlementTemplate.lineageId })
      .from(entitlementTemplate);
    const ruleVersions = await tx
      .select({
        lineageId: entitlementEligibilityRule.lineageId,
        name: entitlementEligibilityRule.name,
        templateLineageId: entitlementEligibilityRule.templateLineageId,
      })
      .from(entitlementEligibilityRule)
      .orderBy(asc(entitlementEligibilityRule.validFrom));

    /**
     * Rule LINEAGES pointing at each template lineage, named by their latest version — the
     * in-transaction guard's `ruleLineagesPointingAt`, computed once for every template instead of once
     * per template. EVERY version counts, not only the ones in force, for the reason that function's own
     * header gives: a rule that used to point here still has a version a past-date reader resolves.
     * Ascending by `validFrom` above, so the LAST name written for a lineage wins — the one on screen.
     */
    const pointedAt = new Map<string, Map<string, string>>();
    for (const v of ruleVersions) {
      const named = pointedAt.get(v.templateLineageId) ?? new Map<string, string>();
      named.set(v.lineageId, v.name);
      pointedAt.set(v.templateLineageId, named);
    }

    const templates = new Map<string, EntitlementUsageBlock>();
    for (const { lineageId } of templateLineages) {
      templates.set(lineageId, {
        rules: [...(pointedAt.get(lineageId)?.values() ?? [])].sort((a, b) => a.localeCompare(b)),
      });
    }
    return { templates };
  });
}

/**
 * r209 — WHICH LEAVE TYPE DOES THIS TABLE BELONG TO, and which does this rule ultimately configure?
 *
 * The reporter's request is that saving an entitlement table or an eligibility rule RECALCULATES the
 * affected employees there and then, instead of leaving it to somebody remembering to press Generate
 * Entitlement. The recalc's entry point (`reprojectEntitlementForLeaveTypeCohort`, core/leave.ts) is keyed
 * by leave type — and neither writer's form carries one. An entitlement table knows its type; an
 * ELIGIBILITY RULE DOES NOT KNOW ITS TYPE AT ALL (it names a template LINEAGE and nothing else, which is
 * the same fact `lib/entitlement-tables-scope.ts` exists for). So both are derived, here, once.
 *
 * ANY version of the lineage answers: `leave_type_id` is fixed for the life of a lineage — that is exactly
 * why `updateEntitlementTemplate` refuses to change it ("a rule pointing at the Executive ANNUAL table that
 * silently started handing out SICK days is not an edit anybody would spot"). `limit(1)` is therefore not a
 * guess about which row.
 */
export async function leaveTypeIdForTemplateLineage(
  ctx: SessionContext,
  templateLineageId: string,
): Promise<string | null> {
  if (!templateLineageId) return null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ leaveTypeId: entitlementTemplate.leaveTypeId })
      .from(entitlementTemplate)
      .where(eq(entitlementTemplate.lineageId, templateLineageId))
      .limit(1);
    return row?.leaveTypeId ?? null;
  });
}

/** The leave type an eligibility rule configures — via the template lineage it points at. See above. */
export async function leaveTypeIdForRuleLineage(
  ctx: SessionContext,
  ruleLineageId: string,
): Promise<string | null> {
  if (!ruleLineageId) return null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ leaveTypeId: entitlementTemplate.leaveTypeId })
      .from(entitlementEligibilityRule)
      .innerJoin(
        entitlementTemplate,
        eq(entitlementTemplate.lineageId, entitlementEligibilityRule.templateLineageId),
      )
      .where(eq(entitlementEligibilityRule.lineageId, ruleLineageId))
      .limit(1);
    return row?.leaveTypeId ?? null;
  });
}

/** How many eligibility rules point at each template lineage — what the retire confirmation must show. */
export async function eligibilityRuleCountsByTemplate(
  ctx: SessionContext,
  p?: { asOf?: string },
): Promise<Map<string, number>> {
  const rules = await listEligibilityRules(ctx, p);
  const out = new Map<string, number>();
  for (const r of rules) out.set(r.templateLineageId, (out.get(r.templateLineageId) ?? 0) + 1);
  return out;
}

/** Every eligibility rule version in force on `asOf` (default: every version). */
export async function listEligibilityRules(
  ctx: SessionContext,
  p?: { asOf?: string },
): Promise<EligibilityRuleRow[]> {
  return withTenant(ctx, async (tx) => {
    const conds = [];
    if (p?.asOf) {
      conds.push(lte(entitlementEligibilityRule.validFrom, p.asOf));
      conds.push(or(isNull(entitlementEligibilityRule.validTo), gt(entitlementEligibilityRule.validTo, p.asOf))!);
    }
    const rows = await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(entitlementEligibilityRule.name), asc(entitlementEligibilityRule.validFrom));
    return rows.map(toRuleRow);
  });
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────────

/**
 * MOST-SPECIFIC-WINS, with a tie-break the operator can read. `true` when `a` beats `b`.
 *
 * The order, and every step of it is explainable on screen:
 *   1. more narrowed axes wins (`orgCriteriaSpecificity`);
 *   2. still tied ⇒ the rule that STARTED LATER wins. A rule written to take effect this January is a
 *      more recent statement of intent than one from 2019, and `validFrom` is the date the operator
 *      actually chose — unlike `created_at`, which moves when somebody re-saves an unrelated field;
 *   3. still tied ⇒ the most recently CREATED row. Two rules of equal specificity starting on the same
 *      day is a genuine ambiguity in the configuration; this only exists so resolution is DETERMINISTIC
 *      rather than dependent on row order, and the screen names both rules so it can be fixed.
 *
 * The approval matcher's tie-break (`beats`, core/leave-approval-policy.ts) is narrower-day-range then
 * newest-created. Its first term has no counterpart here — an entitlement rule has no day range — so the
 * shape is mirrored rather than the terms copied.
 */
export function beatsEligibility(a: EligibilityRuleRow, b: EligibilityRuleRow): boolean {
  const sa = orgCriteriaSpecificity(a.criteria);
  const sb = orgCriteriaSpecificity(b.criteria);
  if (sa !== sb) return sa > sb;
  if (a.validFrom !== b.validFrom) return a.validFrom > b.validFrom;
  return a.createdAt.getTime() > b.createdAt.getTime();
}

/**
 * WHICH TABLE DOES THIS EMPLOYEE GET FOR THIS LEAVE TYPE, AS AT THIS DATE — and which rule decided it.
 *
 * Every rule in force on `asOf` whose template (also resolved at `asOf`) belongs to `leaveTypeId` is
 * tested against the employment through `resolveOrgCriteriaTargets`, scoped to that one employment id so
 * the predicate is the SAME SQL the bulk screens run rather than a re-implementation of it. Returns null
 * when no rule matches — which the caller must read as NO OPINION, never as zero days
 * (`noEntitlementOpinion`, core/leave-compute.ts).
 *
 * THE EXPLAIN PATH. Release two wires the ENGINES through `buildTemplateEntitlementResolver` below (a
 * sweep needs one ranking for a batch, not one per employee); this remains the single-employee entry the
 * screens and `93249794` (Generate Entitlement) use to show WHICH rule won, and it is now a thin delegate
 * so the two can never rank differently.
 */
export async function resolveEntitlementForEmployment(
  tx: Tx,
  p: { employmentId: string; leaveTypeId: string; asOf: string },
): Promise<ResolvedEntitlement | null> {
  // RELEASE TWO — delegated rather than duplicated. This was the whole matcher in release one; the engines
  // need the same answer for a SWEEP of employments, and two rankings of the same rules is precisely the
  // duplicate-resolution defect this item exists to remove. The batched builder is the one implementation
  // and this is its one-employee, one-type case.
  const resolver = await buildTemplateEntitlementResolver(tx, {
    employmentIds: [p.employmentId],
    leaveTypeIds: [p.leaveTypeId],
    asOf: p.asOf,
  });
  return resolver.winnerFor(p.employmentId, p.leaveTypeId);
}

/**
 * r212 — WHY THIS EMPLOYEE RESOLVES TO NOTHING, RULE BY RULE, WITHOUT A SECOND MATCHER.
 *
 * The reporter's original question was never "which rule won" — every screen could already say that. It was
 * the opposite one: **"No eligibility rule reaches you" — WHICH rules, and what about ME did not match?**
 * Until this function, that answer existed nowhere: `winnerFor` returns `null` and null carries no reasons.
 *
 * ⚠️ THIS IS NOT A THIRD ENGINE, AND IT MUST NEVER BECOME ONE. This file's header states the rule plainly —
 * a private matcher for "who does this apply to" would be the defect wearing the fix's clothes. So:
 *
 *   • WHO WON comes from `resolveEntitlementForEmployment` — the existing single-employee delegate, which is
 *     itself a one-row call into `buildTemplateEntitlementResolver`. Nothing here re-ranks anything, and
 *     `soleTableApplies` is read off the engine's OWN `viaSoleTemplate` rather than re-deriving the r193
 *     fault-3 gate a second time.
 *   • WHETHER A RULE MATCHED is the SAME `resolveOrgCriteriaTargets` call the resolver makes, with the same
 *     criteria, the same `asOf` and the same one-employment narrowing. It cannot disagree with the decision
 *     because it IS the decision, asked again.
 *   • WHICH AXIS FAILED is that same call run over SUBSETS of the same criteria object — one axis at a time,
 *     in the criteria vocabulary's own order (`narrowedOrgCriteriaAxes`). The comparison is never
 *     re-implemented in TypeScript; the axis is found by asking the resolver a narrower question.
 *
 * COST: bounded and paid only on an explain. One query for the winner's resolver, two for the configuration,
 * one for "is this employment active at all on this date", one per IN-FORCE rule to test the match, and — for
 * a rule that did NOT match — at most one per narrowed axis until the first failure. Rules are the number of
 * populations HR has described (three on production), not a data volume.
 *
 * ⚠️ AND WHERE THE AXES ARE ASYMMETRIC, SAY SO. `resolveOrgCriteriaTargets` folds department, employment
 * type, business unit, position, cost centre and location into ONE `exists()` over the assignment in force —
 * so they must all hold on the SAME assignment row. Testing them one at a time relaxes that, which means a
 * rule can fail while every one of its axes passes alone. That is reported as `failsOnCombination` rather
 * than blamed on an axis that is, individually, fine.
 */
export type EligibilityAxisFailure = {
  /** The criteria field name — always a member of `ORG_CRITERIA_FIELDS` / `ORG_CRITERIA_RANGE_FIELDS`, so a
   *  screen labels it from the SAME vocabulary the rule editor's pickers are built from. */
  axis: string;
  /** This employee's own value on that axis, or null where it is not one this reader can honestly name —
   *  see `employeeCriteriaFactsAt`. A screen must render the axis with or without it. */
  employeeValue: string | null;
};

/** One eligibility rule LINEAGE of a leave type, judged against one employee at one date. */
export type EligibilityRuleExplanation = {
  ruleName: string;
  ruleLineageId: string;
  templateLineageId: string;
  /** The table this rule points at, by the name its version in force at `asOf` carries — or, where none is
   *  in force, the name of the lineage's current version, so a stopped table is named rather than blank. */
  templateName: string | null;
  validFrom: string;
  validTo: string | null;
  /** In force at `asOf`, decided by the SAME dated SQL `listEligibilityRules` uses, never by a date compare
   *  written out here again. */
  inForce: boolean;
  /** Its table has a version in force at `asOf`. A rule over a STOPPED table matches nobody — the resolver
   *  drops it for exactly that reason — and that is a different fault from a rule that simply excludes you. */
  pointsAtTableInForce: boolean;
  /** Did this employee match? Only ever asked (and only ever true) for a rule that is in force over a table
   *  in force, which is precisely the set the resolver tests. */
  matched: boolean;
  /** WAS THE COMPARISON EVEN MADE? False for a rule that reaches nobody (not in force, or over a stopped
   *  table) AND for EVERY rule when `activeAtDate` is false — the employment is out of scope before any
   *  criterion is considered, so `matched: false` there says nothing about the rule's criteria. Carried
   *  rather than left to be re-derived: a screen that reads `matched === false` as "you are not in it"
   *  sends an administrator to edit criteria that were never consulted. */
  tested: boolean;
  /** The FIRST axis of this rule the employee fails. Null when the rule matched, when it was never tested,
   *  or when `failsOnCombination` — never a guess. */
  firstFailure: EligibilityAxisFailure | null;
  /** Every narrowed axis passes on its own and the rule still does not match: the axes that share one dated
   *  assignment row do not all hold on the SAME one. See this function's header. */
  failsOnCombination: boolean;
  /** This rule narrows by an axis with no effective dating in the schema (`UNDATED_ELIGIBILITY_AXES`), so
   *  its answer is TODAY'S value however far back `asOf` reaches. */
  usesUndatedAxis: boolean;
};

/** Everything a screen needs to answer "no eligibility rule reaches you" with something better than silence. */
export type EntitlementEligibilityExplanation = {
  employmentId: string;
  leaveTypeId: string;
  asOf: string;
  /** This employment exists, is hired by `asOf` and has not been terminated before it. FALSE leaves every
   *  rule below UNTESTED (`tested: false`) for one reason that has nothing to do with any rule, so no axis
   *  is ever blamed for it. ⚠️ It does NOT mean nothing resolved: the sole-table shortcut deliberately
   *  consults no employment window, so `winner` can be non-null with this false — which is exactly the
   *  combination `eligibilityNoticeFrom` had to be given a deliberate precedence for. */
  activeAtDate: boolean;
  /** r193 fault 3, read off the engine's own answer (`ResolvedEntitlement.viaSoleTemplate`): the leave type
   *  had exactly one table in force and no rule in force, so the table applied and NO RULE IS NEEDED. A
   *  screen must say "none is missing", not "none is configured". */
  soleTableApplies: boolean;
  /** What actually decided — null when nothing did, which is the state this whole type exists to explain. */
  winner: ResolvedEntitlement | null;
  /** 76ffdcf2, read off the engine's own answer (`ResolvedEntitlement.viaDefaultTemplate`): no scheme
   *  reached this employee and the leave type's DEFAULT entitlement table answered instead. Mutually
   *  exclusive with `soleTableApplies`, and derived the same way — never re-computed here. */
  defaultTableApplies: boolean;
  /** Every rule lineage of this leave type, current version, in force or not, ordered by name. */
  rules: EligibilityRuleExplanation[];
  /** Any rule above narrows by an undated axis ⇒ the whole explanation carries the caveat. */
  usesUndatedAxis: boolean;
};

/**
 * The employee facts an explanation may quote back — READ FOR DISPLAY ONLY, never to decide anything.
 *
 * ⚠️ NOTHING HERE PARTICIPATES IN A MATCH. The decision, and the axis, come from `resolveOrgCriteriaTargets`
 * (see `explainEntitlementEligibility`'s header). This exists so "does not match your Employment Type" can
 * add "— yours is Permanent", which is the difference between a message an operator can act on and one they
 * cannot. If it were ever wrong it would mislabel a value beside a correctly-named axis; it can never move
 * an entitlement.
 *
 * TWO GUARDS KEEP IT FROM CONTRADICTING THE DECISION:
 *   1. the dated assignment window is copied from `resolveOrgCriteriaTargets` exactly — started on or before
 *      `asOf`, not ended before it — and the latest such version is the one quoted (the matcher's `exists()`
 *      accepts ANY of them, so where superseded rows overlap the quoted one is the current statement);
 *   2. `employeeValueForAxis` REFUSES to return a value the rule's own list contains. If this reader and the
 *      matcher ever disagreed, the screen degrades to naming the axis alone rather than printing a value
 *      that argues with the decision beside it.
 *
 * The id-shaped axes (company, department, grade, position, cost centre, location, business unit) are
 * deliberately absent: their criteria values are UUIDs, so quoting the employee's own would put a UUID on
 * screen, and resolving names for seven catalogues inside the entitlement module is exactly the kind of
 * spreading this file's header argues against. Those axes are named without a value.
 */
type EligibilityEmployeeFacts = {
  /** From the `assignment` version in force at `asOf` — the same row the matcher's `exists()` reads. */
  employmentType: string | null;
  hiredOn: string | null;
  gender: string | null;
  nationality: string | null;
  religion: string | null;
  race: string | null;
  /** The eight Organisation-Assignment axes, whose criteria key IS the `employment` column name. */
  org: Record<string, string | null>;
};

async function employeeCriteriaFactsAt(
  tx: Tx,
  employmentId: string,
  asOf: string,
): Promise<EligibilityEmployeeFacts | null> {
  const [row] = await tx
    .select({
      hiredOn: employment.hiredOn,
      gender: person.gender,
      nationality: person.nationality,
      religion: person.religion,
      race: person.race,
      orgDivision: employment.orgDivision,
      orgBranch: employment.orgBranch,
      orgRegion: employment.orgRegion,
      orgLine: employment.orgLine,
      orgSection: employment.orgSection,
      orgTeam: employment.orgTeam,
      orgBase: employment.orgBase,
      employmentCategory: employment.employmentCategory,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!row) return null;

  // The SAME dated window `resolveOrgCriteriaTargets` puts on its assignment `exists()`: started on or
  // before `asOf`, and not ended before it. Latest start wins — see this type's note on overlapping rows.
  const assignments = await tx
    .select({ validFrom: assignment.validFrom, employmentType: assignment.employmentType })
    .from(assignment)
    .where(
      and(
        eq(assignment.employmentId, employmentId),
        lte(assignment.validFrom, asOf),
        or(isNull(assignment.validTo), gte(assignment.validTo, asOf)),
      ),
    );
  const current = assignments.sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0];

  const org: Record<string, string | null> = {};
  for (const c of ORG_ASSIGNMENT_CRITERIA) org[c.key] = (row as Record<string, string | null>)[c.key] ?? null;
  return {
    employmentType: current?.employmentType ?? null,
    hiredOn: row.hiredOn ?? null,
    gender: row.gender ?? null,
    nationality: row.nationality ?? null,
    religion: row.religion ?? null,
    race: row.race ?? null,
    org,
  };
}

/** The employee's own value on one axis, or null where this module will not claim to know it. See above. */
function employeeValueForAxis(
  facts: EligibilityEmployeeFacts | null,
  axis: string,
  criteria: OrgCriteria,
): string | null {
  if (!facts) return null;
  const direct: Record<string, string | null> = {
    employmentTypes: facts.employmentType,
    genders: facts.gender,
    nationalities: facts.nationality,
    religions: facts.religion,
    races: facts.race,
    hiredFrom: facts.hiredOn,
    hiredTo: facts.hiredOn,
  };
  const value = axis in direct ? direct[axis] : (facts.org[axis] ?? null);
  if (value == null || value === '') return null;
  // GUARD 2 (see `EligibilityEmployeeFacts`): a value the rule's own list contains would contradict the
  // matcher, which has just said this employee fails on this axis. Say nothing rather than argue.
  const listed = (criteria as Record<string, unknown>)[axis];
  if (Array.isArray(listed) && (listed as unknown[]).map(String).includes(value)) return null;
  return value;
}

export async function explainEntitlementEligibility(
  tx: Tx,
  p: {
    employmentId: string;
    leaveTypeId: string;
    asOf: string;
    /** THE ENGINE'S ANSWER, WHERE THE CALLER ALREADY HAS IT. `core/read.ts` builds the resolver for this
     *  very pair before it can decide the entitlement STATUS, so re-resolving here would run the same query
     *  twice on a screen that already runs one read per leave type. Passing it is not an override: it is
     *  the same `winnerFor` this function would call. `undefined` ⇒ resolve; `null` ⇒ the caller resolved
     *  and nothing won, which is exactly the state this explanation exists for. */
    winner?: ResolvedEntitlement | null;
  },
): Promise<EntitlementEligibilityExplanation> {
  // WHO WON — the existing delegate, not a second ranking. `viaSoleTemplate` is the r193 fault-3 gate's own
  // answer, so `soleTableApplies` below cannot drift from the engine that applied it.
  const winner = p.winner !== undefined ? p.winner : await resolveEntitlementForEmployment(tx, p);

  const allVersions = (
    await tx.select().from(entitlementTemplate).where(eq(entitlementTemplate.leaveTypeId, p.leaveTypeId))
  ).map(toTemplateRow);
  const lineageIds = [...new Set(allVersions.map((t) => t.lineageId))];
  // In force at `asOf` through the SAME SQL the resolver builds its answer from, rather than a date compare
  // restated here — `activeTemplatesAt` is the one definition of "which version applies".
  const templatesInForce = lineageIds.length
    ? await activeTemplatesAt(tx, p.asOf, [p.leaveTypeId])
    : new Map<string, EntitlementTemplateRow>();
  /** The lineage's CURRENT version — how a STOPPED table still gets a name. Latest `validFrom` wins. */
  const templateHead = new Map<string, EntitlementTemplateRow>();
  for (const t of allVersions) {
    const prev = templateHead.get(t.lineageId);
    if (!prev || t.validFrom >= prev.validFrom) templateHead.set(t.lineageId, t);
  }

  const ruleVersions = lineageIds.length
    ? (
        await tx
          .select()
          .from(entitlementEligibilityRule)
          .where(inArray(entitlementEligibilityRule.templateLineageId, lineageIds))
      ).map(toRuleRow)
    : [];
  // IN FORCE, asked in SQL with the resolver's own predicate rather than compared again in TypeScript.
  const inForceIds = new Set(
    lineageIds.length
      ? (
          await tx
            .select({ id: entitlementEligibilityRule.id })
            .from(entitlementEligibilityRule)
            .where(
              and(
                inArray(entitlementEligibilityRule.templateLineageId, lineageIds),
                lte(entitlementEligibilityRule.validFrom, p.asOf),
                or(isNull(entitlementEligibilityRule.validTo), gt(entitlementEligibilityRule.validTo, p.asOf)),
              ),
            )
        ).map((r) => r.id)
      : [],
  );
  /**
   * ONE ENTRY PER RULE LINEAGE — the version IN FORCE at `asOf` where there is one, and otherwise the
   * lineage's latest version.
   *
   * ⚠️ "LATEST" ALONE IS NOT GOOD ENOUGH, AND THE DIFFERENCE IS NOT THEORETICAL. An edit closes the running
   * version at its `validFrom` and inserts a successor from that date; an edit dated NEXT MONTH therefore
   * leaves the lineage with a future head sitting over a version that is in force today. Judged on the head,
   * a rule the engine is currently matching people with would be reported as "starts next month" — and, worse,
   * its criteria would never be tested, so the explanation could say a rule had not begun while `winner`
   * named that very rule. In-force first is what keeps this file's answers agreeing with the resolver's.
   *
   * A RETIRED lineage has no version in force at all, and then the latest version is exactly right: hiding
   * it would hide the expiry that is the commonest reason this explanation is being read.
   */
  const ruleHeads = new Map<string, EligibilityRuleRow>();
  for (const r of ruleVersions) {
    const prev = ruleHeads.get(r.lineageId);
    if (!prev) {
      ruleHeads.set(r.lineageId, r);
      continue;
    }
    const live = inForceIds.has(r.id);
    const prevLive = inForceIds.has(prev.id);
    if (live !== prevLive ? live : r.validFrom >= prev.validFrom) ruleHeads.set(r.lineageId, r);
  }

  // IS THIS EMPLOYMENT EVEN A CANDIDATE ON THIS DATE? `resolveOrgCriteriaTargets` excludes anybody not yet
  // hired or already terminated as of `asOf`, BEFORE any criterion is considered. An empty criteria object
  // asks exactly that and nothing else — and it is the same call, so the answer cannot drift.
  const activeAtDate =
    (await resolveOrgCriteriaTargets(tx, { criteria: {}, asOf: p.asOf, employmentIds: [p.employmentId] })).length > 0;

  const facts = activeAtDate ? await employeeCriteriaFactsAt(tx, p.employmentId, p.asOf) : null;

  const rules: EligibilityRuleExplanation[] = [];
  for (const rule of [...ruleHeads.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const inForce = inForceIds.has(rule.id);
    const pointsAtTableInForce = templatesInForce.has(rule.templateLineageId);
    const testable = inForce && pointsAtTableInForce && activeAtDate;
    const matched = testable
      ? (
          await resolveOrgCriteriaTargets(tx, {
            criteria: rule.criteria,
            asOf: p.asOf,
            employmentIds: [p.employmentId],
          })
        ).length > 0
      : false;

    let firstFailure: EligibilityAxisFailure | null = null;
    if (testable && !matched) {
      // ONE AXIS AT A TIME, THROUGH THE SAME RESOLVER. The first subset that excludes this employee names
      // the axis; nothing is compared here.
      for (const axis of narrowedOrgCriteriaAxes(rule.criteria)) {
        const only = { [axis]: (rule.criteria as Record<string, unknown>)[axis] } as OrgCriteria;
        const hits = await resolveOrgCriteriaTargets(tx, {
          criteria: only,
          asOf: p.asOf,
          employmentIds: [p.employmentId],
        });
        if (hits.length === 0) {
          firstFailure = { axis, employeeValue: employeeValueForAxis(facts, axis, rule.criteria) };
          break;
        }
      }
    }

    rules.push({
      ruleName: rule.name,
      ruleLineageId: rule.lineageId,
      templateLineageId: rule.templateLineageId,
      templateName:
        templatesInForce.get(rule.templateLineageId)?.name ?? templateHead.get(rule.templateLineageId)?.name ?? null,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
      inForce,
      pointsAtTableInForce,
      matched,
      tested: testable,
      firstFailure,
      failsOnCombination: testable && !matched && firstFailure === null,
      usesUndatedAxis: usesUndatedEligibilityAxis(rule.criteria),
    });
  }

  return {
    employmentId: p.employmentId,
    leaveTypeId: p.leaveTypeId,
    asOf: p.asOf,
    activeAtDate,
    soleTableApplies: winner?.viaSoleTemplate === true,
    defaultTableApplies: winner?.viaDefaultTemplate === true,
    winner,
    rules,
    usesUndatedAxis: rules.some((r) => r.usesUndatedAxis),
  };
}

/**
 * The same explanation from a `SessionContext` — what a screen calls. One transaction, so every query above
 * reads one consistent picture of the configuration.
 */
export async function explainEntitlementEligibilityFor(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string; asOf: string },
): Promise<EntitlementEligibilityExplanation> {
  return withTenant(ctx, (tx) => explainEntitlementEligibility(tx, p));
}

/**
 * r212 — THE EXPLANATION AS A SCREEN READS IT. Pure, and the ONE place the mapping lives.
 *
 * Both consumers (the admin explain panel and the employee's own Leave Details side-sheet) need the same
 * decisions made the same way — WHAT THE ANSWER IS, which of the five states each rule is in, whether this
 * employee was even compared against it — and making them twice is how the two screens start describing one
 * configuration two ways. The href is injected because it belongs to the caller's route, and the failing
 * axis stays in the criteria vocabulary's own words because the two callers label it from different places
 * (see `EligibilityRuleNotice` in lib/entitlement-status.ts).
 *
 * ⚠️ AND THE TOP-LEVEL VERDICT IS DECIDED HERE, NOT BY THE SCREENS. It was not, and the two screens duly
 * disagreed about the same object: for a leave type with one table and no rule (the reporter's
 * Hospitalization) read at a date before the employee was hired, the engine RESOLVES that table —
 * `activeAtDate: false`, `soleTableApplies: true`, `winner` non-null — and the admin panel printed "this
 * employee was not employed on that date, so no rule can reach them" while the employee's panel printed
 * "that table applies to everyone", each from its own `if` order.
 *
 * THE PRECEDENCE, AND WHY IT IS THIS WAY ROUND:
 *
 *   1. A WINNER OUTRANKS EVERYTHING. If the engine resolved a table, the verdict names it. "No rule can
 *      reach them" is not a harmless simplification there — it is FALSE about the outcome, and it would be
 *      printed beside a figure the same engine produced from the very table it claims nothing reached. Note
 *      that the sole-table shortcut deliberately does NOT consult the employment window (r193 fault 3: one
 *      table, no rule, the table applies), which is exactly why this combination exists at all.
 *   2. `activeAtDate` is NOT dropped when a winner exists — it rides along as its own flag, and both screens
 *      print it as an ADDITIONAL caveat. Both facts are true; only one of them is the answer.
 *   3. With NOTHING resolved, "this employment did not exist on that date" outranks the rule list, because
 *      it explains every rule at once and none of the per-rule reasons is about a criterion at all
 *      (`tested` is false for all of them).
 *   4. Then "there are no rules", then "no rule reaches you" — the state this whole type exists to explain.
 */
export function eligibilityNoticeFrom(
  explanation: EntitlementEligibilityExplanation,
  opts: {
    /** Where an administrator opens a rule lineage. Omit on a screen with nowhere to send anybody, and
     *  return null for a lineage this screen cannot actually open — a link that lands on a screen with
     *  nothing to show is worse than no link. */
    href?: (ruleLineageId: string) => string | null;
  } = {},
): EligibilityNotice {
  const winner = explanation.winner;
  const verdict: EligibilityVerdict = winner
    ? explanation.soleTableApplies
      ? 'sole_table'
      : explanation.defaultTableApplies
        ? 'default_table'
        : 'resolved'
    : !explanation.activeAtDate
      ? 'not_active'
      : explanation.rules.length === 0
        ? 'no_rules'
        : 'no_match';

  return {
    verdict,
    soleTableApplies: explanation.soleTableApplies,
    defaultTableApplies: explanation.defaultTableApplies,
    activeAtDate: explanation.activeAtDate,
    winningRuleName: winner?.ruleName ?? null,
    winningTableName: winner?.templateName ?? null,
    usesUndatedAxis: explanation.usesUndatedAxis,
    rules: explanation.rules.map((r) => {
      // ⚠️ THE STATE ORDER IS NOT ARBITRARY EITHER. `matched` first (it is an answer, not a fault); then
      // `not_yet` and `expired`, which are about the RULE's own dates; then `table_stopped`, which is about
      // the table it points at; and only then `in_force`, which is the one that is genuinely about this
      // employee. Reordering it would report an expired rule as "you are not in it", which sends an
      // administrator to edit criteria on a rule that matches nobody whatever they type.
      const state: EligibilityRuleNotice['state'] = r.matched
        ? 'matched'
        : r.validFrom > explanation.asOf
          ? 'not_yet'
          : !r.inForce
            ? 'expired'
            : !r.pointsAtTableInForce
              ? 'table_stopped'
              : 'in_force';
      return {
        id: r.ruleLineageId,
        name: r.ruleName,
        state,
        tested: r.tested,
        validFrom: r.validFrom,
        validTo: r.validTo,
        tableName: r.templateName,
        failingAxis: r.firstFailure?.axis ?? null,
        // A value with no axis to hang it on is noise, so both fall together.
        failingAxisValue: r.firstFailure ? r.firstFailure.employeeValue : null,
        failsOnCombination: r.failsOnCombination,
        href: opts.href ? opts.href(r.ruleLineageId) : null,
      };
    }),
  };
}

/**
 * 6e9a126e RELEASE TWO — THE BATCHED TEMPLATE RESOLVER THE ENGINES READ.
 *
 * Deliberately the SAME SHAPE as `buildSchemeEntitlementResolver` (core/leave.ts): pre-load everything the
 * decision needs in a bounded number of queries, then hand back a synchronous closure the grant loops call
 * per (employment, leave type, service years). The engines are `for` loops over employments × types inside
 * one transaction; a resolver that awaited per iteration would turn a sweep into thousands of round-trips.
 *
 * ⚠️ THE SHORT-CIRCUIT IS THE BACK-COMPAT GUARANTEE, and it is first. No entitlement_template row in force
 * on `asOf` for any of these leave types ⇒ `bandFor` is `() => null` and every caller's
 * `templateOverPolicy(base, null)` returns `base` UNCHANGED. That is ONE indexed query for a tenant that
 * has not migrated, and the same `if (schemes.length === 0) return () => null` argument the scheme resolver
 * has carried since ae5b84d5.
 *
 * COST: one query for the templates, one for the rules, then ONE membership query per candidate RULE —
 * each restricted to the employments in scope via `resolveOrgCriteriaTargets`' `employmentIds` narrowing.
 * The rule count is the number of populations HR describes (tens), not a data volume, and it does not grow
 * with the employee count. The alternative — asking per (employment, rule) — is the same answer at
 * employments × rules queries, which is what release one's single-employee path did and why it is now the
 * degenerate case of this one rather than a second implementation.
 *
 * ⚠️ `asOf` DATES EVERYTHING: which template VERSION is in force, which rule VERSION is in force, AND which
 * department / position / business unit / employment type the employee held. That last one is the
 * requirement the approved plan flagged as "specified but not designed" — `resolveOrgCriteriaTargets`
 * reads the `assignment` row in force on `asOf`, so a report for a closed year matches people on where
 * they sat THEN. Grade, gender, nationality, religion and race are undated columns in this schema and are
 * therefore matched at today's value however far back `asOf` reaches (`UNDATED_ELIGIBILITY_AXES`).
 */
export type TemplateEntitlementResolver = {
  /** The winning template's band for this employee/type at this service length, or null (no template). */
  bandFor: (employmentId: string, leaveTypeId: string, serviceYears: number) => ServiceBand | null;
  /** The full explain record — which rule won, how specific it was, and what else matched. */
  winnerFor: (employmentId: string, leaveTypeId: string) => ResolvedEntitlement | null;
  /**
   * r209 — DOES THIS LEAVE TYPE HAVE ANY ENTITLEMENT TABLE IN FORCE AT `asOf`, for anybody?
   *
   * ⚠️ THIS IS THE FACT THAT SEPARATES THE TWO ZEROES, and until r209 no caller could ask it. `winnerFor`
   * returning null collapses two completely different situations into one silence:
   *   - the leave type has NO table at all ⇒ nobody was ever meant to get days, and 0.00 is the truth;
   *   - the leave type has tables, and NO ELIGIBILITY RULE POINTS THIS EMPLOYEE AT ONE ⇒ the configuration
   *     is half-built, and 0.00 is a defect somebody has to go and fix.
   * The second is what a single expired rule did to a whole tenant from 13 August 2026 — every employee
   * silently resolving to nothing while six Medical tables sat there, correct and unreachable.
   *
   * FREE: it reads the SAME `activeTemplatesAt` map the resolution below is built from, captured before
   * the short-circuits so a resolver that returned `empty` still answers truthfully. No extra query.
   */
  hasTemplatesFor: (leaveTypeId: string) => boolean;
  /** True when nothing was configured at all: the caller may skip every template branch. */
  isEmpty: boolean;
};

export async function buildTemplateEntitlementResolver(
  tx: Tx,
  p: { employmentIds: string[]; leaveTypeIds: string[]; asOf: string },
): Promise<TemplateEntitlementResolver> {
  const emptyWith = (hasTemplatesFor: (leaveTypeId: string) => boolean): TemplateEntitlementResolver => ({
    bandFor: () => null,
    winnerFor: () => null,
    hasTemplatesFor,
    isEmpty: true,
  });
  const empty = emptyWith(() => false);
  const empIds = [...new Set(p.employmentIds.filter(Boolean))];
  const typeIds = [...new Set(p.leaveTypeIds.filter(Boolean))];
  if (empIds.length === 0 || typeIds.length === 0) return empty;

  const templates = await activeTemplatesAt(tx, p.asOf, typeIds);
  // r209 — captured HERE, before any short-circuit, because every `return empty` below is a case where the
  // question "does this type have a table at all" still has a real answer and the screens need it. A tenant
  // whose only eligibility rule expired takes the `matchedByEmp.size === 0` exit two blocks down with six
  // Medical tables sitting in this map; answering `false` there is exactly the silence r209 exists to end.
  const typesWithTemplates = new Set([...templates.values()].map((t) => t.leaveTypeId));
  const hasTemplatesFor = (leaveTypeId: string) => typesWithTemplates.has(leaveTypeId);
  if (templates.size === 0) return empty;

  // ── r193 FAULT 3 — A LEAVE TYPE WITH EXACTLY ONE TABLE AND NO RULE NEEDS NO RULE ────────────────────
  //
  // The reporter's words: "the run insists on an eligibility rule even where there is nothing to choose
  // between". Hospitalization Leave has ONE table in force on their account and no rule anywhere, and the
  // `ruleRows.length === 0 ⇒ empty` short-circuit below meant it resolved to nothing — so the screen asked
  // them to configure a rule whose only possible answer was the table they had already written.
  //
  // THE GATE IS TWO CONDITIONS, AND THE SECOND ONE IS THE SAFETY ARGUMENT:
  //   (1) exactly ONE template lineage in force for this leave type on `asOf`, and
  //   (2) NO eligibility rule in force for that leave type at all.
  //
  // (2) is not redundant and must never be dropped. A tenant with one table AND a rule that narrows it to
  // (say) Executives has deliberately excluded everybody else; "there is only one table so give it to
  // everyone" would silently reverse that exclusion. Where a rule exists, "not eligible" IS the answer and
  // this fallback stays out of the way.
  //
  // And it is deliberately NOT "pick the first when there are several". Annual Leave has SIXTEEN tables in
  // force on the reporter's account; picking one of those would be a silent mis-grant, which is worse than
  // granting nothing. Several tables genuinely need a rule, and that is the separate item 9a65f808.
  const lineagesByType = new Map<string, EntitlementTemplateRow[]>();
  for (const t of templates.values()) {
    const arr = lineagesByType.get(t.leaveTypeId);
    if (arr) arr.push(t);
    else lineagesByType.set(t.leaveTypeId, [t]);
  }
  const soleCandidates = [...lineagesByType].filter(([, rows]) => rows.length === 1).map(([id]) => id);
  const ruledTypeIds = soleCandidates.length
    ? await leaveTypeIdsWithEligibilityRulesAt(tx, p.asOf, soleCandidates)
    : new Set<string>();
  const soleTemplateByType = new Map<string, EntitlementTemplateRow>();
  for (const typeId of soleCandidates) {
    if (!ruledTypeIds.has(typeId)) soleTemplateByType.set(typeId, lineagesByType.get(typeId)![0]);
  }

  // ── 76ffdcf2 — THE DEFAULT ENTITLEMENT TABLE: WHAT AN EMPLOYEE NO SCHEME COVERS RECEIVES ───────────
  //
  // The reporter's words: "No code path silently produces zero entitlement merely because Benefit Scheme
  // is missing." Before this, a leave type with two or more tables and no MATCHING rule resolved to
  // nothing — deliberately, because picking one of several tables nobody chose would be a silent
  // mis-grant (see the sole-table note above). The gap was real all the same: 34 employees on production
  // held 2026 Annual Leave days while their profile said no table reached them.
  //
  // ⚠️ THIS DOES NOT WIDEN `soleTableApplies`, AND MUST NOT BE MADE TO. r193 fault 3's safety property is
  // that a table NOBODY CHOSE is never handed to everyone. A default is chosen — by a named human, on the
  // leave type, through `setLeaveTypeDefaultTemplate`. Where no default is set the answer is still null
  // and the caller still posts NOTHING (`noEntitlementOpinion`, core/leave-compute.ts): "never invent
  // days" is untouched, and the EA-1955 floor is NOT resurrected as a fallback (fa3f4ccb).
  //
  // ⚠️ AND IT IS THE LAST BRANCH, NEVER THE FIRST. A matching rule always wins, and so does the sole-table
  // answer; the default only speaks where nothing else did. A default that could beat a rule would let a
  // leave-type-level setting silently reverse an exclusion HR wrote deliberately.
  //
  // The lineage is resolved through the SAME `templates` map every other branch reads, so a default whose
  // table has been STOPPED (no version in force on `asOf`) simply stops applying — it never resolves
  // against some other version, which is the staleness the lineage design exists to remove. A default
  // pointing at another leave type's table is refused at write time and ignored here regardless.
  const defaultTemplateByType = new Map<string, EntitlementTemplateRow>();
  {
    const defaults = await tx
      .select({ id: leaveType.id, lineageId: leaveType.defaultEntitlementTemplateLineageId })
      .from(leaveType)
      .where(inArray(leaveType.id, typeIds));
    for (const row of defaults) {
      if (!row.lineageId) continue;
      const tpl = templates.get(row.lineageId);
      if (tpl && tpl.leaveTypeId === row.id) defaultTemplateByType.set(row.id, tpl);
    }
  }

  const ruleRows = (
    await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(
        and(
          lte(entitlementEligibilityRule.validFrom, p.asOf),
          or(isNull(entitlementEligibilityRule.validTo), gt(entitlementEligibilityRule.validTo, p.asOf)),
        ),
      )
      // r270 — DETERMINISM, not precedence. `beatsEligibility` ranks these, and for a pair that ties on
      // all three of its terms it returns false both ways, so the comparator leaves them in input order
      // and the winner was whatever the heap happened to yield — a different answer run to run, for the
      // same data. Ordering here does not decide anything the comparator decides; it only makes the
      // undecided case repeatable, which is the least a screen that now explains the choice can stand on.
      .orderBy(entitlementEligibilityRule.createdAt, entitlementEligibilityRule.id)
  )
    .map(toRuleRow)
    // A rule pointing at a lineage with no version in force on `asOf` is not a match — it is a rule whose
    // table had not been written yet (or had been closed) at that date. Silently resolving it against some
    // OTHER version would be the staleness the lineage design exists to remove.
    .filter((r) => templates.has(r.templateLineageId));
  // r193: `&& soleTemplateByType.size === 0` — a tenant with tables but no rules used to short-circuit to
  // "nothing configured" HERE, which is the whole of fault 3. It still short-circuits when there is also
  // nothing unambiguous to apply, so the back-compat guarantee in this function's header is untouched.
  if (ruleRows.length === 0 && soleTemplateByType.size === 0 && defaultTemplateByType.size === 0) {
    return emptyWith(hasTemplatesFor);
  }

  // employmentId → the rules that match it, unranked. One query per rule, narrowed to the batch.
  const matchedByEmp = new Map<string, EligibilityRuleRow[]>();
  for (const rule of ruleRows) {
    const hits = await resolveOrgCriteriaTargets(tx, {
      criteria: rule.criteria,
      asOf: p.asOf,
      employmentIds: empIds,
    });
    for (const id of hits) {
      const arr = matchedByEmp.get(id);
      if (arr) arr.push(rule);
      else matchedByEmp.set(id, [rule]);
    }
  }
  if (matchedByEmp.size === 0 && soleTemplateByType.size === 0 && defaultTemplateByType.size === 0) {
    return emptyWith(hasTemplatesFor);
  }

  // Ranked once per (employment, leave type) and memoised — the grant loops ask for the same pair at
  // several service lengths (the anniversary re-resolution in projectExpectedEntitlement asks twice for
  // the same employee), and ranking is pure.
  const winners = new Map<string, ResolvedEntitlement | null>();
  const winnerFor = (employmentId: string, leaveTypeId: string): ResolvedEntitlement | null => {
    const key = `${employmentId}|${leaveTypeId}`;
    if (winners.has(key)) return winners.get(key)!;
    const candidates = (matchedByEmp.get(employmentId) ?? []).filter(
      (r) => templates.get(r.templateLineageId)?.leaveTypeId === leaveTypeId,
    );
    let out: ResolvedEntitlement | null = null;
    if (candidates.length > 0) {
      const ranked = candidates
        .slice()
        .sort((a, b) => (beatsEligibility(a, b) ? -1 : beatsEligibility(b, a) ? 1 : 0));
      const winner = ranked[0];
      const template = templates.get(winner.templateLineageId)!;
      // r270 — READ OFF THE PAIR THE SORT ALREADY PRODUCED. `ranked[1]` is the runner-up by construction;
      // asking `winReasonFor` about it re-runs the same three comparisons `beatsEligibility` just made,
      // so the reason on screen and the rule in the ledger cannot disagree.
      const winReason = winReasonFor(winner, ranked[1]);
      out = {
        ruleName: winner.name,
        ruleLineageId: winner.lineageId,
        templateName: template.name,
        templateLineageId: template.lineageId,
        serviceBands: template.serviceBands,
        specificity: orgCriteriaSpecificity(winner.criteria),
        // Everything else that matched, so a screen can show WHY this one won rather than asserting it.
        alsoMatched: ranked
          .slice(1)
          .map((r) => ({ ruleName: r.name, specificity: orgCriteriaSpecificity(r.criteria) })),
        winReason,
        viaSoleTemplate: false,
        viaDefaultTemplate: false,
      };
    }
    // r193 FAULT 3: no rule decided this pair. If the leave type has exactly one table in force and no
    // rule in force at all (see the gate above), that table IS the answer — there is nothing else it
    // could be. A type with several tables, or with any rule, still resolves to null here.
    if (out === null) {
      const sole = soleTemplateByType.get(leaveTypeId);
      if (sole) {
        out = {
          ruleName: null,
          ruleLineageId: null,
          templateName: sole.name,
          templateLineageId: sole.lineageId,
          serviceBands: sole.serviceBands,
          specificity: 0,
          alsoMatched: [],
          winReason: null,
          viaSoleTemplate: true,
          viaDefaultTemplate: false,
        };
      }
    }
    // 76ffdcf2 — LAST: no scheme matched and no unambiguous sole table, so the leave type's DEFAULT table
    // answers, if HR named one. `specificity: 0` because a default narrows by nothing — it is the answer
    // for everybody the earlier branches left without one.
    if (out === null) {
      const fallback = defaultTemplateByType.get(leaveTypeId);
      if (fallback) {
        out = {
          ruleName: null,
          ruleLineageId: null,
          templateName: fallback.name,
          templateLineageId: fallback.lineageId,
          serviceBands: fallback.serviceBands,
          specificity: 0,
          alsoMatched: [],
          winReason: null,
          viaSoleTemplate: false,
          viaDefaultTemplate: true,
        };
      }
    }
    winners.set(key, out);
    return out;
  };

  return {
    winnerFor,
    hasTemplatesFor,
    bandFor: (employmentId, leaveTypeId, serviceYears) => {
      const won = winnerFor(employmentId, leaveTypeId);
      if (!won) return null;
      // `bandFor` from core/leave-compute is the SAME defensive resolver leave_policy and the benefit
      // schemes go through: a malformed table resolves to null (⇒ fall through to scheme/policy) rather
      // than throwing inside an overnight sweep.
      return bandFor({ serviceBands: won.serviceBands } as AccrualConfig, serviceYears);
    },
    isEmpty: false,
  };
}

/**
 * 6e9a126e RELEASE TWO — WHICH LEAVE TYPES CARRY AN ENTITLEMENT TEMPLATE IN FORCE ON `asOf`.
 *
 * `openLeaveYear` decides WHICH TYPES a year-open grants by asking "did an administrator configure
 * entitlement days for this type" (items 783bf55a / baea8e5b), and until this release the answer was
 * "a live leave_policy version, or a scheme entitlement row". A type configured ONLY through the new layer
 * would have been skipped entirely — HR would write a table, watch it save, and never see a day of it
 * reach anybody. That is the exact defect those two items were raised for; this is its third limb.
 *
 * ⚠️ r193 — THIS IS A POINT-IN-TIME READER AND `openLeaveYear` NO LONGER USES IT. Asking it at 1 January
 * for a whole leave year is the primary blocker r193 fixed: a table written in August is not in force on
 * 1 January and the year-open granted nobody anything. Use `templateStartsWithinWindow` above whenever the
 * question spans a PERIOD. This one is correct only where `asOf` is genuinely the single instant the
 * caller resolves at — which is `accrueEarnedLeave`, its remaining caller, running at today's date.
 */
export async function leaveTypeIdsWithTemplatesAt(tx: Tx, asOf: string): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ id: entitlementTemplate.leaveTypeId })
    .from(entitlementTemplate)
    .where(
      and(
        lte(entitlementTemplate.validFrom, asOf),
        or(isNull(entitlementTemplate.validTo), gt(entitlementTemplate.validTo, asOf)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * r193 FAULT 1 — WHEN, INSIDE A WINDOW, EACH LEAVE TYPE'S ENTITLEMENT TABLE STARTS APPLYING.
 *
 * ⚠️ THIS IS THE FIX FOR ONE OF THE TWO BLOCKERS, and it is worth stating plainly because the symptom
 * looked like something else entirely. `leaveTypeIdsWithTemplatesAt` below asks "which tables were in
 * force ON this one date", and `openLeaveYear` asked it at 1 JANUARY. On the reporting account 46 of the
 * 47 tables in force carry `valid_from >= 2026-08-01`, because that is the day HR built them — so on
 * 1 January 2026 the answer was a SINGLE leave type (Hospitalization, whose one table is dated
 * 2026-01-01), and the eight custom types configured in August were never visited by a year-open at all.
 *
 * MEASURED, NOT ASSUMED, AND IT CORRECTS THE ROUND'S OWN PLAN: that plan said all 47 carried
 * `valid_from >= 2026-08-01` and that the set therefore came back EMPTY. It did not — one table predates
 * the year, and the three statutory standing codes are in the sweep's type list whatever this reader says
 * (see `openLeaveYear`'s own comment). The net symptom the reporter saw was still "nothing generated",
 * but for the standing types the cause was the eligibility short-circuit below, not this date.
 *
 * So the question changes from a point to a WINDOW: which types have a table in force at ANY point in the
 * leave year, and FROM WHEN. The value is `max(windowStart, earliest validFrom in force during the
 * window)` — the date that table actually starts applying, clamped to the window:
 *
 *   table valid from 2020-01-01, still open   →  2026-01-01   (in force all year; nothing changes)
 *   table valid from 2026-08-01, still open   →  2026-08-01   (grants from August, not retroactively)
 *   table valid to   2026-01-01               →  absent       (half-open [from, to) — gone before the year)
 *
 * THE CLAMP IS THE POINT AND IT IS NOT "resolve at today". A leave year opened in December must not
 * silently grant a table that only started in November as though it had been in force since January.
 * Pro-rating from that date is the configured earning method's job, not a new rule invented here.
 *
 * Absent from the map ⇒ no table in force at any point in the window, which is the same "not configured"
 * answer the point-in-time reader gave and is still what `openLeaveYear` filters on.
 */
export async function templateStartsWithinWindow(
  tx: Tx,
  p: { windowStart: string; windowEnd: string; leaveTypeIds?: string[] },
): Promise<Map<string, string>> {
  const typeIds = [...new Set((p.leaveTypeIds ?? []).filter(Boolean))];
  const rows = await tx
    .select({ leaveTypeId: entitlementTemplate.leaveTypeId, validFrom: entitlementTemplate.validFrom })
    .from(entitlementTemplate)
    .where(
      and(
        typeIds.length ? inArray(entitlementTemplate.leaveTypeId, typeIds) : undefined,
        // The version's window [validFrom, validTo) must OVERLAP [windowStart, windowEnd]. Same half-open
        // comparison `activeTemplatesAt` uses, so "in force" means one thing in this file.
        lte(entitlementTemplate.validFrom, p.windowEnd),
        or(isNull(entitlementTemplate.validTo), gt(entitlementTemplate.validTo, p.windowStart)),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    const start = r.validFrom > p.windowStart ? r.validFrom : p.windowStart;
    const prev = out.get(r.leaveTypeId);
    if (prev === undefined || start < prev) out.set(r.leaveTypeId, start);
  }
  return out;
}

/**
 * r193 FAULT 3's SAFETY CONDITION — which of these leave types have an eligibility rule in force on `asOf`.
 *
 * Joined rule → template on the lineage rather than reading a denormalised leave type off the rule: a
 * rule's leave type IS its template's, and a copy of it is a copy that can disagree (the same argument
 * `countEligibilityRulesForLeaveType` makes). EVERY version of the lineage is joined, not just the one in
 * force, because a lineage's leave type never changes and the question here is only "does HR have an
 * opinion about who gets what for this type" — a rule pointing at a lineage whose current version is
 * closed is still HR having stated an opinion, and the sole-table fallback must stay out of its way.
 */
async function leaveTypeIdsWithEligibilityRulesAt(
  tx: Tx,
  asOf: string,
  leaveTypeIds: string[],
): Promise<Set<string>> {
  if (leaveTypeIds.length === 0) return new Set<string>();
  const rows = await tx
    .selectDistinct({ id: entitlementTemplate.leaveTypeId })
    .from(entitlementEligibilityRule)
    .innerJoin(
      entitlementTemplate,
      eq(entitlementTemplate.lineageId, entitlementEligibilityRule.templateLineageId),
    )
    .where(
      and(
        inArray(entitlementTemplate.leaveTypeId, leaveTypeIds),
        lte(entitlementEligibilityRule.validFrom, asOf),
        or(isNull(entitlementEligibilityRule.validTo), gt(entitlementEligibilityRule.validTo, asOf)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * 6e9a126e RELEASE TWO — THE EARLIEST LEAVE YEAR `expireCarriedLeave` MAY SWEEP ON THE TEMPLATE SIDE.
 *
 * That sweep's back-compat boundary is "the year of the earliest `validFrom` among configurations that
 * carry a carry-expiry", and it returns early when there are NO leave_policy rows at all. Both limbs are
 * policy-only today, so a tenant configured purely through templates would silently stop having its carry
 * expiry swept — safe in direction (nothing is forfeited) and wrong in fact. Returns null when no template
 * version for these types exists, which keeps the boundary exactly where it was for every tenant that has
 * not migrated.
 *
 * Deliberately NOT filtered on whether the band carries an expiry: the sweep's own `typeCarriesExpiry`
 * branch decides that from the leave TYPE (post-9816a5ad, that is where carry expiry lives), and the
 * per-band arm is applied there against the resolved band. Filtering here as well would need a second copy
 * of that precedence.
 */
export async function earliestTemplateYear(tx: Tx, leaveTypeIds: string[]): Promise<number | null> {
  const typeIds = [...new Set(leaveTypeIds.filter(Boolean))];
  if (typeIds.length === 0) return null;
  const [row] = await tx
    .select({ earliest: sql<string | null>`min(${entitlementTemplate.validFrom})::text` })
    .from(entitlementTemplate)
    .where(inArray(entitlementTemplate.leaveTypeId, typeIds));
  return row?.earliest ? Number(row.earliest.slice(0, 4)) : null;
}

/**
 * The `(years) => days | null` hook shape the projection kernel and the granting engines take.
 *
 * Deliberately the SAME contract as `buildSchemeEntitlementResolver`'s output (ae5b84d5) so release two
 * re-points the engines by swapping which resolver fills the slot, not by changing the composition. null
 * means "this layer has no entitlement for this type" — which is what `noEntitlementOpinion` reads, and it
 * is emphatically NOT the same as 0 days.
 */
export function templateDaysForYears(resolved: ResolvedEntitlement | null): (years: number) => number | null {
  if (!resolved) return () => null;
  return (years: number) => {
    // `bandFor` is the SAME defensive resolver leave_policy and the benefit schemes go through, so a
    // malformed table stored by some future path resolves to null (fall through) rather than throwing
    // inside an overnight sweep.
    const band = bandFor({ serviceBands: resolved.serviceBands } as AccrualConfig, years);
    return band ? band.days : null;
  };
}

/** How many entitlement templates exist for a leave type — the count `deleteLeaveType`'s in-use guard needs
 *  once `leave_policy` is gone. Counts EVERY version, including closed ones: a superseded table is still a
 *  record of configuration that referenced the type. */
export async function countTemplatesForLeaveType(tx: Tx, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(entitlementTemplate)
    .where(eq(entitlementTemplate.leaveTypeId, leaveTypeId));
  return Number(row?.n ?? 0);
}

/** How many eligibility rules point at a template of this leave type. Joined rather than denormalised: a
 *  rule's leave type IS its template's, and a copy of it is a copy that can disagree. */
export async function countEligibilityRulesForLeaveType(tx: Tx, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${entitlementEligibilityRule.id})::int` })
    .from(entitlementEligibilityRule)
    .innerJoin(
      entitlementTemplate,
      eq(entitlementTemplate.lineageId, entitlementEligibilityRule.templateLineageId),
    )
    .where(eq(entitlementTemplate.leaveTypeId, leaveTypeId));
  return Number(row?.n ?? 0);
}

/**
 * 76ffdcf2 — NAME (or clear) THE DEFAULT ENTITLEMENT TABLE for a leave type.
 *
 * This is the ONE write behind the reporter's request that nobody fall through. An employee whom no
 * benefit scheme covers receives the table named here instead of receiving nothing; where nothing is
 * named, resolution is exactly what it was before this item existed.
 *
 * ⚠️ THE LINEAGE MUST BE THIS LEAVE TYPE'S OWN, and that is checked here rather than by a constraint: a
 * lineage is not a row (see the schema note on `default_entitlement_template_lineage_id`), so there is no
 * FK to lean on, and a default pointing at another type's table would resolve to nothing and read on
 * screen as "not eligible" rather than as the configuration error it is. The picker is restricted to the
 * type's own in-force tables for the same reason; this is the backstop a hand-crafted post meets.
 *
 * ⚠️ IT DOES NOT REPROJECT. Saving a default MOVES BALANCES for everyone the schemes do not reach, and the
 * recalc must run in its OWN transaction against the COMMITTED configuration — the same ordering
 * `setLeaveTypeRules` obeys, and for the same reason: called inside this write, every employee would
 * reproject against the configuration this save just replaced. The caller runs
 * `reprojectEntitlementForLeaveTypeCohort` after this returns, and a test asserts that ordering.
 *
 * Returns the lineage that is now stored (null when cleared), so a caller need not re-read to report it.
 */
export async function setLeaveTypeDefaultTemplate(
  ctx: SessionContext,
  p: { leaveTypeId: string; templateLineageId: string | null },
): Promise<{ leaveTypeId: string; defaultTemplateLineageId: string | null }> {
  const lineageId = (p.templateLineageId ?? '').trim() || null;
  return withTenant(ctx, async (tx) => {
    const [type] = await tx
      .select({ id: leaveType.id, current: leaveType.defaultEntitlementTemplateLineageId })
      .from(leaveType)
      .where(and(eq(leaveType.tenantId, ctx.tenantId), eq(leaveType.id, p.leaveTypeId)))
      .limit(1);
    if (!type) throw new Error('That leave type does not exist.');
    if (lineageId) {
      await assertTemplateLineageExists(tx, lineageId);
      const [owned] = await tx
        .select({ id: entitlementTemplate.id })
        .from(entitlementTemplate)
        .where(
          and(eq(entitlementTemplate.lineageId, lineageId), eq(entitlementTemplate.leaveTypeId, p.leaveTypeId)),
        )
        .limit(1);
      if (!owned) throw new Error('That entitlement table belongs to a different leave type.');
    }
    await tx
      .update(leaveType)
      .set({ defaultEntitlementTemplateLineageId: lineageId })
      .where(and(eq(leaveType.tenantId, ctx.tenantId), eq(leaveType.id, p.leaveTypeId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave_type',
      aggregateId: p.leaveTypeId,
      eventType: 'leave-type.default-entitlement-table.set',
      payload: { leaveTypeId: p.leaveTypeId, before: type.current ?? null, after: lineageId },
      actor: actorOf(ctx),
    });
    return { leaveTypeId: p.leaveTypeId, defaultTemplateLineageId: lineageId };
  });
}

/**
 * 9e2a89e9 — EVERY EMPLOYEE NO ENTITLEMENT TABLE REACHES, as one list an administrator can open.
 *
 * The reporter asked to be told when a grade change lands on nobody's table. Today that is silent: the
 * reproject loop's "NO OPINION IS NOT ZERO" skip (core/leave.ts) leaves the employee alone, correctly,
 * and says nothing to anybody. One profile at a time is not a workable way to find them — on production
 * 47 of 74 active employments have no job grade recorded at all, so this is a list, not an exception.
 *
 * ⚠️ NO SECOND MATCHER. The answer comes from `buildTemplateEntitlementResolver`, the ONE batched matcher
 * every engine reads, asked once for every active employment × every leave type that has a table in force.
 * This file's header calls a private "who does this apply to" matcher "the defect wearing the fix's
 * clothes"; a reader that disagreed with the engine would be worse than no reader, because it would send
 * an administrator to fix configuration that is already correct.
 *
 * ⚠️ LEAVE TYPES WITH NO TABLE AT ALL ARE EXCLUDED, deliberately. Nobody was ever meant to receive days
 * there, so listing them would bury the types that are genuinely half-configured under a permanent wall
 * of rows — the shape that gets a warning ignored within a day (see lib/leave-config-health.ts's note on
 * archived types).
 *
 * COST: one query for the employments, one for the leave types, then the resolver's own bounded set (one
 * membership query per eligibility rule in force, narrowed to this batch). It does NOT grow with the
 * employee count. Called from ONE screen — the unfiltered Entitlement tables page — never from the
 * per-leave-type panels, which are composed 24 at a time.
 */
export type UnreachedEmployment = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  /** Null when no job grade is recorded — which is the commonest reason and is reported as its own fact. */
  gradeId: string | null;
  gradeName: string | null;
  /** The leave types that HAVE a table in force and still resolve nothing for this employee, by name. */
  leaveTypeNames: string[];
};

export async function listEmploymentsWithoutEntitlementTable(
  ctx: SessionContext,
  p: { asOf: string; limit?: number },
): Promise<{ rows: UnreachedEmployment[]; total: number; withoutJobGrade: number; activeTotal: number }> {
  const limit = p.limit ?? 50;
  return withTenant(ctx, async (tx) => {
    const empty = { rows: [], total: 0, withoutJobGrade: 0, activeTotal: 0 };
    const employments = await tx
      .select({
        id: employment.id,
        employeeCode: employment.employeeCode,
        gradeId: employment.gradeId,
        gradeName: jobGrade.name,
        fullName: person.fullName,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
      .where(and(isNull(employment.terminatedOn), lte(employment.hiredOn, p.asOf)))
      // Any asserted array from a query needs an ORDER BY (CLAUDE.md §8) — the cap below makes this
      // load-bearing: without it "the first 50" would be a different 50 on every render.
      .orderBy(asc(person.fullName), asc(employment.id));
    if (employments.length === 0) return empty;

    const typeIds = [...(await leaveTypeIdsWithTemplatesAt(tx, p.asOf))];
    if (typeIds.length === 0) {
      return { rows: [], total: 0, withoutJobGrade: 0, activeTotal: employments.length };
    }
    const typeNames = new Map(
      (await tx.select({ id: leaveType.id, name: leaveType.name }).from(leaveType)).map((t) => [t.id, t.name]),
    );

    const resolver = await buildTemplateEntitlementResolver(tx, {
      employmentIds: employments.map((e) => e.id),
      leaveTypeIds: typeIds,
      asOf: p.asOf,
    });

    const rows: UnreachedEmployment[] = [];
    for (const e of employments) {
      const missing = typeIds.filter((typeId) => resolver.winnerFor(e.id, typeId) == null);
      if (missing.length === 0) continue;
      rows.push({
        employmentId: e.id,
        employeeName: e.fullName,
        employeeCode: e.employeeCode ?? null,
        gradeId: e.gradeId ?? null,
        gradeName: e.gradeName ?? null,
        leaveTypeNames: missing.map((id) => typeNames.get(id) ?? '').filter(Boolean),
      });
    }
    return {
      // The CAP is applied after counting, so the screen can say "50 of 68" rather than implying 50 is all.
      rows: rows.slice(0, limit),
      total: rows.length,
      withoutJobGrade: rows.filter((r) => r.gradeId == null).length,
      activeTotal: employments.length,
    };
  });
}

// ── internals ────────────────────────────────────────────────────────────────────────────────────────

/** The template version in force on `asOf` for each lineage of these leave types, keyed by lineage. */
async function activeTemplatesAt(
  tx: Tx,
  asOf: string,
  leaveTypeIds: string[],
): Promise<Map<string, EntitlementTemplateRow>> {
  const rows = await tx
    .select()
    .from(entitlementTemplate)
    .where(
      and(
        inArray(entitlementTemplate.leaveTypeId, leaveTypeIds),
        lte(entitlementTemplate.validFrom, asOf),
        or(isNull(entitlementTemplate.validTo), gt(entitlementTemplate.validTo, asOf)),
      ),
    );
  // At most one open version per lineage is a DB invariant (entitlement_template_open_uq), and the dated
  // window is half-open, so this map can never lose a row to a collision. Built defensively anyway: the
  // last-writer-wins on a duplicate would be non-deterministic, and silent non-determinism in entitlement
  // resolution is the class of defect this whole item is about.
  const out = new Map<string, EntitlementTemplateRow>();
  for (const r of rows.map(toTemplateRow)) {
    const prev = out.get(r.lineageId);
    if (!prev || r.validFrom > prev.validFrom) out.set(r.lineageId, r);
  }
  return out;
}

async function assertTemplateLineageExists(tx: Tx, lineageId: string): Promise<void> {
  const [row] = await tx
    .select({ id: entitlementTemplate.id })
    .from(entitlementTemplate)
    .where(eq(entitlementTemplate.lineageId, lineageId))
    .limit(1);
  // There is no FK on template_lineage_id (a lineage is not a row — see the schema note), so the reference
  // is checked here. Without this, a rule can point at nothing and simply never resolve, which reads on
  // screen as "this employee is not eligible" rather than as the configuration error it is.
  if (!row) throw new Error('That entitlement table does not exist.');
}

type TemplateSelect = typeof entitlementTemplate.$inferSelect;
type RuleSelect = typeof entitlementEligibilityRule.$inferSelect;

const toTemplateRow = (r: TemplateSelect): EntitlementTemplateRow => ({
  id: r.id,
  lineageId: r.lineageId,
  leaveTypeId: r.leaveTypeId,
  name: r.name,
  serviceBands: (r.serviceBands ?? []) as ServiceBand[],
  validFrom: r.validFrom,
  validTo: r.validTo,
  createdAt: r.createdAt,
});

const toRuleRow = (r: RuleSelect): EligibilityRuleRow => ({
  id: r.id,
  lineageId: r.lineageId,
  name: r.name,
  templateLineageId: r.templateLineageId,
  criteria: (r.criteria ?? {}) as OrgCriteria,
  validFrom: r.validFrom,
  validTo: r.validTo,
  createdAt: r.createdAt,
});

export type { ServiceBand };
