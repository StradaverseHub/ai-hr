/**
 * "WHO DOES THIS APPLY TO" — ONE resolver, for every caller that needs a set of employments.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────────────
 * The set resolver was written for bulk leave adjustments (491c499f) and lived inside
 * `core/leave-adjustment.ts` as `resolveAdjustmentTargets`. The Notice Board (6e122302) needs exactly the
 * same question answered — company / department / employment type plus the eight Organisation-Assignment
 * axes, resolved AS AT a date — and copying it would have produced two implementations of the single most
 * consequential predicate in the product: who a bulk action reaches. Feedback item 6e9a126e exists because
 * of duplicate-maintenance defects of precisely this shape, and the approved plan for the Notice Board says
 * so in as many words: "Generalise the criteria resolver out of the leave-adjustment module rather than
 * copying it".
 *
 * So the BODY moved here, unchanged, and `core/leave-adjustment.ts` keeps `resolveAdjustmentTargets` /
 * `countAdjustmentTargets` as thin delegates. That is deliberate rather than lazy: the adjustment module's
 * existing callers, its error text and `test/leave-adjustment-batch.test.ts` are untouched, so the leave
 * behaviour is provably byte-identical while the notice path gets the same engine rather than a cousin.
 *
 * 18103ba4 WIDENED THE VOCABULARY HERE RATHER THAN ON THE LEAVE SCREEN, for the same reason. The Leave
 * Adjustments step flow asks for ~20 more narrowing options; adding them to the adjustment module would have
 * re-forked the resolver the Notice Board round had just finished unforking. Every axis below is therefore
 * available to BOTH screens — the Notice Board simply does not post the new field names yet, and an axis
 * nobody posts is an empty axis, which means NO RESTRICTION. That is what makes this change provably
 * invisible to the Notice Board: see `test/org-criteria-axes.test.ts`, which pins a fixed criteria set
 * resolving to the same employments through the notice path before and after.
 *
 * ── THE SEMANTICS, RESTATED (they are load-bearing and were copied from `isLeaveEligible`) ─────────────
 *   • OR within a field  — `companyIds: [A, B]` matches an employment in A or in B.
 *   • AND across fields  — company AND department AND grade… every named axis must match.
 *   • An EMPTY field means NO RESTRICTION on that axis.
 *
 * ⚠️ THEREFORE AN EMPTY CRITERIA OBJECT MATCHES EVERY ACTIVE EMPLOYMENT. That is genuinely what "no
 * restrictions" means, and it is also how somebody sends a notice to the entire group by accident. The
 * resolver does NOT second-guess an explicit request — every caller is responsible for showing the resolved
 * count and making the user confirm it. `countOrgCriteriaTargets` is that count.
 *
 * ── EVERY AXIS IS EVALUATED AS AT `asOf`. THIS IS THE WHOLE POINT ─────────────────────────────────────
 * Department and employment type always were, because they live on the effective-dated `assignment` row.
 * The four axes 18103ba4 adds from that same table (business unit, position, cost centre, location) go
 * through the SAME dated window, and the two DERIVED axes (employment status, confirmation status) and the
 * years-of-service band are computed against `asOf` too. A criterion read "as of now" while its neighbours
 * read "as of the effective date" produces a target set nobody can reproduce — and reproducibility is the
 * entire reason a bulk adjustment is worth being able to reverse.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────────────
 * JOB TITLE, EMPLOYEE GROUP and EMPLOYEE CLASS. 18103ba4's reporter asked for all three; the schema holds
 * none of them, anywhere. They are not "not wired up" — there is no column, no catalogue and no import
 * field behind any of them, so a picker for them could only ever match nobody or everybody. Inventing
 * columns inside a UI item is how a field arrives with no owner, no import path and no meaning; they need
 * their own request against the employee record. (`position` is NOT job title: it is the effective-dated
 * `assignment.position_id` pointing at the company's position master, and it is implemented below.)
 *
 * Gender was previously listed here as deliberately excluded, on the grounds that selecting a bulk action's
 * audience by a protected characteristic must be asked for explicitly rather than inherited by accident.
 * 18103ba4's reporter asked for it explicitly, by name, alongside nationality, religion and race — so it is
 * implemented, as an axis an administrator has to go and pick. Marital status was NOT asked for and stays
 * out. The original note is kept because its REASON still governs: these four are read from `person`, they
 * are PDPA s.40 sensitive demographics, and nothing here may quietly start defaulting them on.
 */
import { and, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { withTenant, type SessionContext } from '../db/client';
import { assignment, employment, person } from '../db/schema';
import { EMPLOYMENT_STATUSES } from './employment-status';
import { employmentStatusSql, onProbationSql } from './employment-status-sql';
import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from './leave-org-criteria';

/**
 * The four axes 18103ba4 adds that live on the EFFECTIVE-DATED `assignment` row, exactly where department
 * and employment type already do. `key` is the criteria field name; `column` is the Drizzle field. They are
 * folded into the SAME as-at-`asOf` exists() subquery as department/employmentType — one dated window, not
 * five.
 */
export const ORG_DATED_ASSIGNMENT_CRITERIA = [
  { key: 'businessUnitIds', column: 'businessUnitId' },
  { key: 'positionIds', column: 'positionId' },
  { key: 'costCenterIds', column: 'costCenterId' },
  { key: 'locationIds', column: 'locationId' },
] as const satisfies readonly { key: string; column: keyof typeof assignment.$inferSelect }[];

/** Axes that are a plain (undated) column on `employment`. Job Grade is the only one 18103ba4 adds. */
export const ORG_EMPLOYMENT_COLUMN_CRITERIA = [{ key: 'gradeIds', column: 'gradeId' }] as const satisfies readonly {
  key: string;
  column: keyof typeof employment.$inferSelect;
}[];

/**
 * Axes that live on `person`, matched through an exists() rather than a join so the outer query keeps its
 * shape (and its ORDER BY employment.id determinism). PDPA s.40 sensitive demographics — see the header.
 */
export const ORG_PERSON_CRITERIA = [
  { key: 'genders', column: 'gender' },
  { key: 'nationalities', column: 'nationality' },
  { key: 'religions', column: 'religion' },
  { key: 'races', column: 'race' },
] as const satisfies readonly { key: string; column: keyof typeof person.$inferSelect }[];

/**
 * Confirmation Status — a DERIVED rule, not a stored field, and exhaustive: an employment is either within
 * its probation as at `asOf` or it is not. `probation` is the status ladder's rule 5 verbatim
 * (`onProbationSql`), so this axis and the Employee Status badge can never contradict each other; an
 * employment with NO confirmation date recorded at all reads as `confirmed`, which is what
 * `deriveEmploymentStatus` already does with it.
 *
 * This ONE axis answers both of the reporter's field names — "Confirmation Status" and "Probation Status"
 * are the same predicate under two labels, and minting two controls for one rule is how they start
 * disagreeing.
 */
export const CONFIRMATION_STATUSES = ['confirmed', 'probation'] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/**
 * The criteria vocabulary. Three typed axes (`company` / `department` / `employment type`), the eight
 * profile-option Organisation Assignment axes from `ORG_ASSIGNMENT_CRITERIA` (whose keys are ALSO the
 * `employment` column names — see core/leave-org-criteria.ts for why that identity holds), and the axes
 * 18103ba4 added above.
 *
 * The last four are RANGES, not lists, because "hired between" and "3–5 years of service" are bands and a
 * multi-select cannot express a band. They are read with `get`, not `getAll`.
 */
export type OrgCriteria = {
  companyIds?: string[];
  departmentIds?: string[];
  employmentTypes?: string[];
  businessUnitIds?: string[];
  positionIds?: string[];
  costCenterIds?: string[];
  locationIds?: string[];
  gradeIds?: string[];
  genders?: string[];
  nationalities?: string[];
  religions?: string[];
  races?: string[];
  /** Employee Status as at `asOf` — the derived buckets from core/employment-status.ts. */
  employmentStatuses?: string[];
  /** 'confirmed' | 'probation', as at `asOf`. */
  confirmationStatuses?: string[];
  /** Hire-date band (inclusive, ISO yyyy-mm-dd). A stored date, so it is not `asOf`-dependent. */
  hiredFrom?: string;
  hiredTo?: string;
  /** Completed years of service AS AT `asOf`, inclusive band. */
  minYearsOfService?: number;
  maxYearsOfService?: number;
} & Partial<Record<OrgAssignmentCriterionKey, string[]>>;

const nonEmpty = (v: string[] | undefined): string[] => (Array.isArray(v) ? v.filter((x) => !!x) : []);

/**
 * Every MULTI-VALUE criteria field name, in posting order — the one list a form and an action agree on.
 * Adding a name here is what makes it readable by `orgCriteriaFromFields` and countable by
 * `isUnrestrictedOrgCriteria`; the resolver still has to be taught what to DO with it below.
 */
export const ORG_CRITERIA_FIELDS: readonly string[] = [
  'companyIds',
  'departmentIds',
  'employmentTypes',
  ...ORG_ASSIGNMENT_CRITERIA.map((c) => c.key),
  ...ORG_DATED_ASSIGNMENT_CRITERIA.map((c) => c.key),
  ...ORG_EMPLOYMENT_COLUMN_CRITERIA.map((c) => c.key),
  ...ORG_PERSON_CRITERIA.map((c) => c.key),
  'employmentStatuses',
  'confirmationStatuses',
];

/** The SCALAR (range) criteria field names. Read with `get`, and just as capable of restricting a set. */
export const ORG_CRITERIA_DATE_FIELDS = ['hiredFrom', 'hiredTo'] as const;
export const ORG_CRITERIA_NUMBER_FIELDS = ['minYearsOfService', 'maxYearsOfService'] as const;
export const ORG_CRITERIA_RANGE_FIELDS: readonly string[] = [
  ...ORG_CRITERIA_DATE_FIELDS,
  ...ORG_CRITERIA_NUMBER_FIELDS,
];

/**
 * Read a criteria object out of a posted form, given a `getAll`-shaped accessor (and, for the range fields,
 * an optional `get`-shaped one).
 *
 * Pure and DB-free on purpose: it takes the accessors rather than a `FormData` so it can be unit-tested
 * without a request, and so both the Leave Adjustments action and the Notice Board action read the SAME
 * field names. Two hand-rolled readers is how the two screens' criteria quietly stop meaning the same
 * thing.
 *
 * `get` is OPTIONAL so the Notice Board's existing one-argument call keeps compiling and keeps meaning
 * exactly what it did: no `get` ⇒ no range fields ⇒ no restriction from them.
 */
export function orgCriteriaFromFields(
  getAll: (name: string) => string[],
  get?: (name: string) => string | null | undefined,
): OrgCriteria {
  const out: OrgCriteria = {};
  for (const field of ORG_CRITERIA_FIELDS) {
    const vals = nonEmpty(getAll(field));
    if (vals.length) (out as Record<string, string[]>)[field] = vals;
  }
  if (!get) return out;
  for (const field of ORG_CRITERIA_DATE_FIELDS) {
    const raw = (get(field) ?? '').trim();
    // A half-typed date box posts something like '0002-01-01'; only a well-formed ISO date restricts.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) (out as Record<string, string>)[field] = raw;
  }
  for (const field of ORG_CRITERIA_NUMBER_FIELDS) {
    const raw = (get(field) ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    // Negative service is not a band, it is a typo — ignore rather than silently match nobody.
    if (Number.isFinite(n) && n >= 0) (out as Record<string, number>)[field] = Math.floor(n);
  }
  return out;
}

/**
 * 6e9a126e — HOW SPECIFIC IS THIS CRITERIA SET? Higher = narrower.
 *
 * The entitlement eligibility layer needs "where two rules could both apply, the more specific one wins,
 * and the screen tells you which one won so it is never a guess" (the approved plan's words). That needs a
 * total order over criteria objects, and it belongs HERE rather than in the entitlement module: it is a
 * property of the criteria vocabulary, it has to move whenever an axis is added, and `93249794` will want
 * the same ranking when it adopts this layer.
 *
 * The count is of RESTRICTED AXES, matching `core/leave-approval-policy.ts`'s `specificity` exactly (which
 * counts non-null scoping dimensions). Each range PAIR counts once — "hired between 2020 and 2024" is one
 * narrowing decision, not two — for the same reason `dayRangeWidth` treats min/max as a single dimension.
 *
 * DELIBERATELY NOT WEIGHTED, and deliberately blind to how many VALUES an axis lists. "Company = A" and
 * "Company = A, B, C, D" both score 1. Weighting axes would be an opinion about which of Department and
 * Grade is "more specific" that nobody has expressed and that could not be explained on screen; counting
 * list length would make a rule quietly change rank when someone adds a company to it. Equal scores are a
 * real tie and are broken by the caller with a rule the operator can read.
 */
export function orgCriteriaSpecificity(criteria: OrgCriteria | null | undefined): number {
  const c = (criteria ?? {}) as Record<string, unknown>;
  let n = 0;
  // The same emptiness test `isUnrestrictedOrgCriteria` applies, so "specificity 0" and "unrestricted" can
  // never disagree — an empty string is an unfilled box, not a narrowing.
  const set = (f: string) => c[f] != null && c[f] !== '';
  for (const f of ORG_CRITERIA_FIELDS) if (nonEmpty(c[f] as string[] | undefined).length > 0) n++;
  if (ORG_CRITERIA_DATE_FIELDS.some(set)) n++;
  if (ORG_CRITERIA_NUMBER_FIELDS.some(set)) n++;
  return n;
}

/** True when no axis is restricted — i.e. this criteria object means EVERYONE. Callers must warn on it. */
export function isUnrestrictedOrgCriteria(criteria: OrgCriteria | null | undefined): boolean {
  const c = (criteria ?? {}) as Record<string, unknown>;
  const noLists = ORG_CRITERIA_FIELDS.every((f) => nonEmpty(c[f] as string[] | undefined).length === 0);
  // The range fields count. A criteria set that says only "hired since 2024" is emphatically NOT everyone,
  // and a screen that greeted it with "this will apply to EVERY employee" would be lying to the operator.
  const noRanges = ORG_CRITERIA_RANGE_FIELDS.every((f) => c[f] == null || c[f] === '');
  return noLists && noRanges;
}

/**
 * Completed YEARS of service from the hire date to `asOf`, in SQL.
 *
 * `extract(year from age(…))` counts whole completed years by the same day-of-month rule as
 * `monthsBetween` in core/leave.ts (the TypeScript service-length helper the leave eligibility gates use),
 * so `extract(year from age(asOf, hired_on)) === floor(monthsBetween(hiredOn, asOf) / 12)` for every date
 * pair. That equivalence is why this is not a second definition of service length; it is the same one,
 * expressed where the filter has to run. `test/org-criteria-axes.test.ts` pins it against the boundary
 * cases (the day before an anniversary, and the anniversary itself).
 */
function yearsOfServiceSql(asOf: string): SQL<number> {
  return sql<number>`extract(year from age(${asOf}::date, ${employment.hiredOn}))`;
}

/** `expr in (…)` for a computed expression — drizzle's `inArray` needs a column, and these are not. */
function sqlIn(expr: SQL<unknown>, values: string[]): SQL<boolean> {
  return sql<boolean>`${expr} in (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

/**
 * THE SET RESOLVER. Which employments match `criteria`, as at `asOf` (an ISO `YYYY-MM-DD` date)?
 *
 * Terminated employments are excluded as of `asOf`, and so are employments not yet hired by then: someone
 * who had already left, or had not yet started, is not a target.
 *
 * ⚠️ DEPARTMENT, EMPLOYMENT TYPE, BUSINESS UNIT, POSITION, COST CENTRE AND LOCATION ARE NOT ON `employment`
 * — they live on `assignment`, which is EFFECTIVE-DATED (validFrom / validTo, null = current). So they are
 * matched against the assignment in force ON `asOf`, not today's. An action backdated to before somebody
 * transferred must select the people who were in that department THEN; using the current row would quietly
 * act on a different set of people from the one the administrator described.
 *
 * Returns employment ids ordered by id, so a resolution is deterministic and two runs are comparable.
 */
export async function resolveOrgCriteriaTargets(
  tx: Tx,
  p: {
    criteria: OrgCriteria;
    asOf: string;
    /**
     * 6e9a126e — an OPTIONAL restriction to a known set of employments, applied ON TOP of the criteria.
     *
     * The entitlement eligibility layer asks the INVERSE of the bulk-action question: not "who does this
     * rule reach" but "which of this employee's rules match, as at this date". Answering that by resolving
     * every rule's whole target set and testing membership is correct but scans the tenant once per rule.
     * With this, the same predicate runs against ONE employment and returns [] or [id].
     *
     * It is a RESTRICTION, never a widening: an empty / absent array means NO RESTRICTION, which is this
     * module's semantics for every other axis and is what keeps the existing Leave Adjustments and Notice
     * Board callers byte-identical. Deliberately NOT part of `OrgCriteria`: it is not a criterion an
     * administrator picks, it is the caller narrowing the search space, and putting it in the stored
     * object would let a saved rule pin itself to a hardcoded list of people.
     */
    employmentIds?: string[];
  },
): Promise<string[]> {
  const c = (p.criteria ?? {}) as OrgCriteria & Record<string, string[] | undefined>;
  const conds = [
    // Active as of the date — hired by then, and not already gone.
    sql`${employment.hiredOn} <= ${p.asOf}`,
    or(isNull(employment.terminatedOn), gte(employment.terminatedOn, p.asOf)),
  ];

  const scopeIds = nonEmpty(p.employmentIds);
  if (scopeIds.length) conds.push(inArray(employment.id, scopeIds));

  const companyIds = nonEmpty(c.companyIds);
  if (companyIds.length) conds.push(inArray(employment.companyId, companyIds));

  // ── The effective-dated assignment window: department + employment type (491c499f) and the four axes
  //    18103ba4 added from the same row. ONE exists(), so an employee must satisfy all of them on the SAME
  //    assignment — which is the truthful reading of "was in Finance, at HQ, on a Manager position".
  const departmentIds = nonEmpty(c.departmentIds);
  const employmentTypes = nonEmpty(c.employmentTypes);
  const datedPicked = ORG_DATED_ASSIGNMENT_CRITERIA.map((d) => ({ d, vals: nonEmpty(c[d.key]) })).filter(
    (x) => x.vals.length > 0,
  );
  if (departmentIds.length || employmentTypes.length || datedPicked.length) {
    const asOfAssignment = [
      sql`${assignment.employmentId} = ${employment.id}`,
      sql`${assignment.validFrom} <= ${p.asOf}`,
      or(isNull(assignment.validTo), gte(assignment.validTo, p.asOf)),
    ];
    if (departmentIds.length) asOfAssignment.push(inArray(assignment.departmentId, departmentIds));
    if (employmentTypes.length) asOfAssignment.push(inArray(assignment.employmentType, employmentTypes as never[]));
    for (const { d, vals } of datedPicked) asOfAssignment.push(inArray(assignment[d.column], vals));
    conds.push(sql`exists (select 1 from ${assignment} where ${and(...asOfAssignment)})`);
  }

  // The eight org-assignment axes are text columns on employment; the key IS the column name (see
  // core/leave-org-criteria.ts, which exists so clients and services agree on that without a DB import).
  for (const crit of ORG_ASSIGNMENT_CRITERIA) {
    const allowed = nonEmpty(c[crit.key]);
    if (allowed.length) conds.push(inArray(employment[crit.key], allowed));
  }

  // Undated employment columns — Job Grade. Not effective-dated in this schema, so there is nothing to
  // resolve as-of; it is today's grade whatever date the action carries, and that is a schema fact rather
  // than a choice made here.
  for (const crit of ORG_EMPLOYMENT_COLUMN_CRITERIA) {
    const allowed = nonEmpty(c[crit.key]);
    if (allowed.length) conds.push(inArray(employment[crit.column], allowed));
  }

  // Person demographics — one exists(), so the outer shape and its ordering are untouched.
  const personPicked = ORG_PERSON_CRITERIA.map((pc) => ({ pc, vals: nonEmpty(c[pc.key]) })).filter(
    (x) => x.vals.length > 0,
  );
  if (personPicked.length) {
    const personConds = [sql`${person.id} = ${employment.personId}`];
    for (const { pc, vals } of personPicked) personConds.push(inArray(person[pc.column], vals));
    conds.push(sql`exists (select 1 from ${person} where ${and(...personConds)})`);
  }

  // ── DERIVED AXES, evaluated AS AT asOf ─────────────────────────────────────────────────────────────
  // Employee Status: the shared SQL twin of deriveEmploymentStatus, fed `asOf` rather than today, so the
  // bucket a criteria set selects on is the bucket the employee was in on the effective date.
  const statuses = nonEmpty(c.employmentStatuses).filter((s) =>
    (EMPLOYMENT_STATUSES as readonly string[]).includes(s),
  );
  if (statuses.length) conds.push(sqlIn(employmentStatusSql(p.asOf), statuses));

  // Confirmation Status: exhaustive, so picking both is the same as picking neither. Expressed as an OR of
  // the two predicates rather than short-circuited, because the whole point is that the SQL says what the
  // operator picked.
  const confirmations = nonEmpty(c.confirmationStatuses).filter((s) =>
    (CONFIRMATION_STATUSES as readonly string[]).includes(s),
  );
  if (confirmations.length && confirmations.length < CONFIRMATION_STATUSES.length) {
    const onProbation = onProbationSql(p.asOf);
    conds.push(confirmations.includes('probation') ? onProbation : sql<boolean>`not ${onProbation}`);
  }

  // ── RANGES ─────────────────────────────────────────────────────────────────────────────────────────
  if (c.hiredFrom) conds.push(sql`${employment.hiredOn} >= ${c.hiredFrom}::date`);
  if (c.hiredTo) conds.push(sql`${employment.hiredOn} <= ${c.hiredTo}::date`);
  const minYears = (p.criteria ?? {}).minYearsOfService;
  const maxYears = (p.criteria ?? {}).maxYearsOfService;
  if (typeof minYears === 'number' && Number.isFinite(minYears)) {
    conds.push(sql`${yearsOfServiceSql(p.asOf)} >= ${minYears}`);
  }
  if (typeof maxYears === 'number' && Number.isFinite(maxYears)) {
    conds.push(sql`${yearsOfServiceSql(p.asOf)} <= ${maxYears}`);
  }

  const rows = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(...conds))
    .orderBy(employment.id);
  return rows.map((r) => r.id);
}

/**
 * How many employments a set of criteria resolves to — the number a screen MUST show before it lets anyone
 * press the button. `resolveOrgCriteriaTargets` deliberately does not second-guess an empty criteria object,
 * so this is the thing that stops "no restrictions" becoming an accidental whole-organisation broadcast.
 */
export async function countOrgCriteriaTargets(
  ctx: SessionContext,
  p: { criteria: OrgCriteria; asOf: string },
): Promise<number> {
  return withTenant(ctx, async (tx) => (await resolveOrgCriteriaTargets(tx, p)).length);
}
