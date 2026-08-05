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
 * ── WHAT THIS RELEASE DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────
 * NOTHING HERE IS READ BY ANY GRANTING ENGINE YET, and nothing old is removed. openLeaveYear, the hire
 * grant, accrueEarnedLeave and projectExpectedEntitlement still compose `scheme ?? policy` exactly as they
 * did; benefit_scheme, scheme_leave_entitlement, employment.benefit_scheme_id and leave_policy are all
 * untouched. Release two re-points those engines through the single shared composition so that resolution
 * becomes `template ?? scheme ?? policy`; release three archives, clears and drops.
 *
 * There are also no EDITOR SCREENS in this release, on purpose. An editor that writes configuration no
 * engine reads is worse than no editor: HR would type a table, see nothing change, and reasonably
 * conclude the feature is broken. The editors land in release two, in the same change as the engine reads
 * that give them meaning — the staging 9816a5ad step 1 and 7c834696 stage 1 both used. What ships now is
 * the storage, its versioning writer, and the resolver those screens and `93249794` will consume.
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
 */
import { and, asc, eq, isNull, lte, or, gt, sql } from 'drizzle-orm';

import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { entitlementEligibilityRule, entitlementTemplate } from '../db/schema';
import { bandFor, validateServiceBands, type AccrualConfig, type ServiceBand } from './leave-compute';
import {
  orgCriteriaSpecificity,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from './org-criteria';

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

/** What actually decided an employee's days, and why — the shape a screen needs to say "this rule won". */
export type ResolvedEntitlement = {
  ruleName: string;
  ruleLineageId: string;
  templateName: string;
  templateLineageId: string;
  serviceBands: ServiceBand[];
  /** How many criteria axes the winning rule narrowed by. Shown so "most specific wins" is auditable. */
  specificity: number;
  /** Every rule that ALSO matched, most-specific first. A screen shows this so the win is never a guess. */
  alsoMatched: { ruleName: string; specificity: number }[];
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
 * Edit a named table GOING FORWARD: close the running version at `validFrom` and insert a successor.
 *
 * NOT an in-place UPDATE, and this is the whole reason both tables are dated. Three readers resolve
 * entitlement at a PAST date — the Carry Forward report at each employee's own cycle open, the year sweep
 * in expireCarriedLeave, and the /me + admin balance breakdown. Overwriting the row would make every one
 * of them report a closed year against today's figures, which contradicts the request's own "maintaining
 * all existing calculation capabilities". Identical shape to `createLeavePolicy`'s supersede loop.
 *
 * The LEAVE TYPE is deliberately not editable: an eligibility rule that pointed at "the Executive ANNUAL
 * table" would silently start handing out SICK days. Retype it as a new table instead.
 */
export async function updateEntitlementTemplate(
  ctx: SessionContext,
  p: { lineageId: string; name?: string; serviceBands?: ServiceBand[]; validFrom: string },
): Promise<EntitlementTemplateRow> {
  if (p.serviceBands !== undefined) validateServiceBands(p.serviceBands);
  const name = p.name !== undefined ? cleanName(p.name) : undefined;
  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select()
      .from(entitlementTemplate)
      .where(and(eq(entitlementTemplate.lineageId, p.lineageId), isNull(entitlementTemplate.validTo)))
      .limit(1);
    if (!open) throw new Error('That entitlement table has no running version to edit.');
    // Editing a version that has not started yet is an EDIT of that version, not a supersession — a
    // successor starting on or before its predecessor is a window that was never in force (and the DB
    // CHECK would refuse it anyway). Say so plainly rather than let the constraint speak.
    if (open.validFrom >= p.validFrom) {
      throw new Error(
        'A version starting on or after that date already exists for this table — edit that version instead.',
      );
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

/** Every template version in force on `asOf` (default: every version, newest window first). */
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
      .orderBy(asc(entitlementTemplate.name), asc(entitlementTemplate.validFrom));
    return rows.map(toTemplateRow);
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

/** Edit a rule GOING FORWARD — close the running version, insert a successor. See `updateEntitlementTemplate`. */
export async function updateEligibilityRule(
  ctx: SessionContext,
  p: { lineageId: string; name?: string; templateLineageId?: string; criteria?: OrgCriteria; validFrom: string },
): Promise<EligibilityRuleRow> {
  const name = p.name !== undefined ? cleanName(p.name) : undefined;
  return withTenant(ctx, async (tx) => {
    if (p.templateLineageId !== undefined) await assertTemplateLineageExists(tx, p.templateLineageId);
    const [open] = await tx
      .select()
      .from(entitlementEligibilityRule)
      .where(
        and(eq(entitlementEligibilityRule.lineageId, p.lineageId), isNull(entitlementEligibilityRule.validTo)),
      )
      .limit(1);
    if (!open) throw new Error('That eligibility rule has no running version to edit.');
    if (open.validFrom >= p.validFrom) {
      throw new Error(
        'A version starting on or after that date already exists for this rule — edit that version instead.',
      );
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
 * NOT WIRED INTO ANY GRANTING ENGINE IN THIS RELEASE. It is the function release two plugs into the one
 * shared composition, and the one `93249794` (Generate Entitlement) adopts for its "who does this apply
 * to" step instead of building a second criteria engine.
 */
export async function resolveEntitlementForEmployment(
  tx: Tx,
  p: { employmentId: string; leaveTypeId: string; asOf: string },
): Promise<ResolvedEntitlement | null> {
  const templates = await activeTemplatesAt(tx, p.asOf, p.leaveTypeId);
  if (templates.size === 0) return null;

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
  )
    .map(toRuleRow)
    .filter((r) => templates.has(r.templateLineageId));
  if (ruleRows.length === 0) return null;

  // One membership query per candidate rule, each restricted to this single employment. The alternative —
  // resolving every rule's full target set and testing membership — is the same answer at a whole-tenant
  // scan apiece, and the number of rules is the number of populations HR describes (tens), not a data
  // volume.
  const matched: EligibilityRuleRow[] = [];
  for (const rule of ruleRows) {
    const hit = await resolveOrgCriteriaTargets(tx, {
      criteria: rule.criteria,
      asOf: p.asOf,
      employmentIds: [p.employmentId],
    });
    if (hit.length > 0) matched.push(rule);
  }
  if (matched.length === 0) return null;

  const ranked = matched.slice().sort((a, b) => (beatsEligibility(a, b) ? -1 : beatsEligibility(b, a) ? 1 : 0));
  const winner = ranked[0];
  const template = templates.get(winner.templateLineageId)!;
  return {
    ruleName: winner.name,
    ruleLineageId: winner.lineageId,
    templateName: template.name,
    templateLineageId: template.lineageId,
    serviceBands: template.serviceBands,
    specificity: orgCriteriaSpecificity(winner.criteria),
    // Everything else that matched, so the screen can show WHY this one won rather than asserting it.
    alsoMatched: ranked
      .slice(1)
      .map((r) => ({ ruleName: r.name, specificity: orgCriteriaSpecificity(r.criteria) })),
  };
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

// ── internals ────────────────────────────────────────────────────────────────────────────────────────

/** The template version in force on `asOf` for each lineage of one leave type, keyed by lineage. */
async function activeTemplatesAt(
  tx: Tx,
  asOf: string,
  leaveTypeId: string,
): Promise<Map<string, EntitlementTemplateRow>> {
  const rows = await tx
    .select()
    .from(entitlementTemplate)
    .where(
      and(
        eq(entitlementTemplate.leaveTypeId, leaveTypeId),
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
